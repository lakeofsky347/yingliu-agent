import { fetch } from '../host/http.ts';
import { randomUUID } from 'node:crypto';
import type { AgentMessage, AgentTool, ModelTurn, ToolCall } from './contracts.ts';
import { chatCompletionParameters, chatCompletionSupportsTools } from '../models/provider-defaults.ts';

export interface ChatConfig {
  baseUrl: string; model: string; key?: string; timeoutMs: number; temperature?: number; maxTokens: number;
  /** false → fall back to the plan-JSON protocol used by the existing director. */
  supportsTools: boolean;
  /** Default true when onDelta callback is supplied; automatically falls back to non-streaming if unsupported. */
  stream?: boolean;
}
export class ModelHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) { super(message); }
}
function obj(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function redactKey(text: string, key?: string): string { return key ? text.split(key).join('[redacted]') : text; }

export function toolSchemas(tools: AgentTool[]) {
  return tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

/** Plan-JSON fallback: one JSON object per turn, same shape as the existing director protocol. */
export function planJsonSystem(tools: AgentTool[]): string {
  return '当前模型不支持原生函数调用。每轮只输出一个 JSON 对象，不要输出其他文字：{"message":"给用户的说明","done":true|false,"actions":[{"tool":"工具名","arguments":{...}}]}。done=true 且 actions 为空表示任务结束。可用工具：\n'
    + tools.map(tool => `- ${tool.name}（${tool.risk}）：${tool.description} 参数：${JSON.stringify(tool.parameters)}`).join('\n');
}
function flattenForPlan(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') out.push({ role: 'user', content: `工具结果[${message.tool_call_id}]：${message.content}` });
    else if (message.role === 'assistant') {
      const calls = message.tool_calls?.map(call => ({ tool: call.function.name, arguments: safeJson(call.function.arguments) })) ?? [];
      out.push({ role: 'assistant', content: JSON.stringify({ message: message.content ?? '', done: false, actions: calls }) });
    } else out.push(message);
  }
  return out;
}
function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return {}; } }
export function parsePlanJson(text: string): { content: string; toolCalls: ToolCall[]; done: boolean } {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { content: text.trim(), toolCalls: [], done: true };
  let plan: Record<string, unknown>;
  try { plan = obj(JSON.parse(text.slice(start, end + 1))); } catch { return { content: text.trim(), toolCalls: [], done: true }; }
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const toolCalls = actions.map(raw => { const action = obj(raw); return { id: 'plan-' + randomUUID(), name: String(action.tool ?? ''), arguments: JSON.stringify(action.arguments ?? {}) }; }).filter(call => call.name);
  return { content: typeof plan.message === 'string' ? plan.message : '', toolCalls, done: plan.done === true || !toolCalls.length };
}

async function readSseTurn(
  response: Response,
  mode: 'tools' | 'plan-json',
  key: string | undefined,
  onDelta?: (text: string) => void,
): Promise<ModelTurn> {
  if (!response.body) throw new Error('流式响应为空');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reason = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let usageKnown = false;
  const toolAccum = new Map<number, { id: string; name: string; arguments: string }>();
  const validTokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

  const handleData = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '[DONE]') return;
    let parsed: Record<string, unknown>;
    try { parsed = obj(JSON.parse(trimmed)); } catch { return; }
    const usage = obj(parsed.usage);
    if (validTokens(usage.prompt_tokens) && validTokens(usage.completion_tokens)) {
      promptTokens = usage.prompt_tokens;
      completionTokens = usage.completion_tokens;
      usageKnown = true;
    }
    const choice = obj(Array.isArray(parsed.choices) ? parsed.choices[0] : undefined);
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) reason = choice.finish_reason;
    const delta = obj(choice.delta);
    if (typeof delta.content === 'string' && delta.content) {
      const safe = redactKey(delta.content, key);
      content += safe;
      onDelta?.(safe);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const rawCall of delta.tool_calls) {
        const entry = obj(rawCall);
        const idx = typeof entry.index === 'number' && Number.isSafeInteger(entry.index) ? entry.index : toolAccum.size;
        const current = toolAccum.get(idx) ?? { id: '', name: '', arguments: '' };
        if (typeof entry.id === 'string' && entry.id) current.id = entry.id;
        const fn = obj(entry.function);
        if (typeof fn.name === 'string' && fn.name) current.name += fn.name;
        if (typeof fn.arguments === 'string' && fn.arguments) current.arguments += fn.arguments;
        toolAccum.set(idx, current);
      }
    }
  };

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) handleData(line.slice(5));
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith('data:')) handleData(line.slice(5));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const tokens = { inputTokens: promptTokens, outputTokens: completionTokens };
  if (mode === 'plan-json') {
    const parsed = parsePlanJson(content);
    return { content: parsed.content, toolCalls: parsed.toolCalls, finish: reason === 'length' ? 'length' : parsed.toolCalls.length ? 'tool_calls' : 'stop', usage: tokens, usageKnown, mode };
  }
  const toolCalls: ToolCall[] = [...toolAccum.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({ id: call.id || 'call-' + randomUUID(), name: call.name, arguments: call.arguments || '{}' }))
    .filter(call => call.name);
  return { content, toolCalls, finish: toolCalls.length ? 'tool_calls' : reason === 'length' ? 'length' : reason === 'stop' || !reason ? 'stop' : 'other', usage: tokens, usageKnown, mode };
}

export async function chatTurn(
  config: ChatConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentTool[],
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  onDelta?: (text: string) => void,
): Promise<ModelTurn> {
  const mode = config.supportsTools && chatCompletionSupportsTools(config.baseUrl, config.model) ? 'tools' : 'plan-json';
  // Old saved runs can still contain image blocks. Director requests only use their text.
  const textMessages = messages.map(message => Array.isArray(message.content)
    ? { ...message, content: message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') }
    : message);

  const send = async (streaming: boolean): Promise<Response> => {
    const body: Record<string, unknown> = {
      model: config.model, ...chatCompletionParameters(config.baseUrl, config.model, config.maxTokens, config.temperature, mode === 'tools'), stream: streaming,
      ...(streaming ? { stream_options: { include_usage: true } } : {}),
      messages: [{ role: 'system', content: mode === 'tools' ? system : system + '\n\n' + planJsonSystem(tools) }, ...(mode === 'tools' ? textMessages : flattenForPlan(textMessages))],
    };
    if (mode === 'tools' && tools.length) { body.tools = toolSchemas(tools); body.tool_choice = 'auto'; }
    return fetchImpl(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
      headers: { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) }, body: JSON.stringify(body),
    });
  };

  const wantStream = Boolean(onDelta) && config.stream !== false;
  let response = await send(wantStream);
  if (wantStream && !response.ok && [400, 422].includes(response.status)) {
    const preview = (await response.text().catch(() => '')).slice(0, 400);
    if (/stream/i.test(preview)) response = await send(false);
    else throw new ModelHttpError(`模型请求失败（HTTP ${response.status}）：${redactKey(preview, config.key)}`, response.status, false);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new ModelHttpError('模型接口返回重定向，请直接配置最终 API 地址', response.status, false);
  }
  if (!response.ok) {
    const text = redactKey((await response.text().catch(() => '')).slice(0, 400), config.key);
    throw new ModelHttpError(`模型请求失败（HTTP ${response.status}）：${text}`, response.status, response.status === 429 || response.status >= 500);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return readSseTurn(response, mode, config.key, onDelta);
  }
  const data = obj(await response.json()), choice = obj(Array.isArray(data.choices) ? data.choices[0] : undefined), message = obj(choice.message), usage = obj(data.usage);
  const validTokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const usageKnown = validTokens(usage.prompt_tokens) && validTokens(usage.completion_tokens);
  const tokens = { inputTokens: validTokens(usage.prompt_tokens) ? usage.prompt_tokens : 0, outputTokens: validTokens(usage.completion_tokens) ? usage.completion_tokens : 0 };
  const content = redactKey(typeof message.content === 'string' ? message.content : '', config.key);
  const reason = String(choice.finish_reason ?? '');
  if (mode === 'plan-json') {
    const parsed = parsePlanJson(content);
    return { content: parsed.content, toolCalls: parsed.toolCalls, finish: reason === 'length' ? 'length' : parsed.toolCalls.length ? 'tool_calls' : 'stop', usage: tokens, usageKnown, mode };
  }
  const toolCalls: ToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(raw => {
    const call = obj(raw), fn = obj(call.function);
    return { id: typeof call.id === 'string' && call.id ? call.id : 'call-' + randomUUID(), name: String(fn.name ?? ''), arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) };
  }).filter(call => call.name);
  return { content, toolCalls, finish: toolCalls.length ? 'tool_calls' : reason === 'length' ? 'length' : reason === 'stop' || !reason ? 'stop' : 'other', usage: tokens, usageKnown, mode };
}

/** Providers that reject the `tools` field answer 400/422 mentioning tools/function. */
export function looksLikeNoToolSupport(error: unknown): boolean {
  return error instanceof ModelHttpError && [400, 404, 422].includes(error.status) && /tool|function/i.test(error.message);
}
