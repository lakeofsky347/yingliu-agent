import { defaultSceneSource } from '../core/index.ts';

/** Local mock director for `--mock`: answers OpenAI-style chat completions for MOCK_BASE_URL only; never touches the network.
 *  Script: project_get → video_update (one shot) → export_mp4 → final text. Stateless: decided from the conversation. */
export const MOCK_HOST = 'mock.yingliu.invalid';
export const MOCK_BASE_URL = `http://${MOCK_HOST}/v1`;
type Msg = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: { id: string; function: { name: string } }[] };
export function mockDirector(body: { messages?: Msg[] }): { tool?: string; args?: unknown; text?: string } {
  const messages = body.messages ?? [], last = messages.at(-1);
  const toolName = (id?: string) => messages.flatMap(m => m.tool_calls ?? []).find(c => c.id === id)?.function.name;
  if (!messages.some(m => m.role === 'tool')) return { tool: 'project_get', args: {} };
  if (last?.role !== 'tool') return { text: '模拟导演：本轮已完成。' };
  const name = toolName(last.tool_call_id), content = String(last.content ?? '');
  if (name === 'project_get') {
    let revision = 0; try { revision = JSON.parse(content).revision ?? 0; } catch { /* keep 0 */ }
    const goal = String(messages.find(m => m.role === 'user')?.content ?? '').slice(0, 40);
    return { tool: 'video_update', args: { expectedRevision: revision, update: { title: '模拟成片', storyboard: { shots: [{ title: '开场', intent: goal || '介绍', composition: '居中', action: '淡入', durationSeconds: 2, params: { text: '映流 CLI 模拟' } }] }, sourcesByIndex: [defaultSceneSource()] }, structural: true, label: 'CLI 模拟初稿' } };
  }
  if (name === 'video_update') return { tool: 'export_mp4', args: {} };
  return { text: '模拟导演：已完成（' + (name ?? 'unknown') + '）。' };
}
export function mockFetch(real: typeof fetch = globalThis.fetch): typeof fetch {
  let n = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== MOCK_HOST) return real(input as string, init);
    if (!url.pathname.endsWith('/chat/completions')) return new Response(JSON.stringify({ data: [{ id: 'mock-director' }] }), { headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(String(init?.body ?? '{}')); const r = mockDirector(body); n++;
    const message = r.tool ? { role: 'assistant', content: null, tool_calls: [{ id: `mock_${n}`, type: 'function', function: { name: r.tool, arguments: JSON.stringify(r.args) } }] } : { role: 'assistant', content: r.text };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: r.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
