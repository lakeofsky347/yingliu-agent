import { createHash, randomUUID } from 'node:crypto';
import type { AgentContent, AgentEvent, AgentMessage, AgentPort, AgentRun, AgentStartInput, AgentTool, PublicRun, RunStep, ToolCall, ToolResult, ToolRisk, ToolSuccessReceipt } from './contracts.ts';
import { chatTurn, looksLikeNoToolSupport, type ChatConfig } from './model-client.ts';
import { backoff, budgetFrom, chargeModel, chargeTool, classify, emptyUsage, needsApproval, overBudget, tokenCost } from './budget.ts';
import { bound, capabilityPrompt, compressMessages, summarizeProject, systemPrompt } from './context.ts';
import { RunStore } from './run-store.ts';
import { activeTools, createTools } from './tools.ts';
import type { AgentDocs, Capabilities, ToolContext } from './contracts.ts';
import { join } from 'node:path';
import { submissionOf } from './submission.ts';
import { emptyLedger, emptyStory, normalizeCharacter, normalizeStyle, ProjectDocs, storyBrief, anchorPrompt, type Ledger, type QcReport, type Story } from './story.ts';
import { qualityCheck } from './tools.ts';

export interface ResolvedAgentModel { config: ChatConfig; parameters: Record<string, unknown>; connectionId?: string; vision: boolean }
export interface AgentServiceOptions {
  resolveModel(): Promise<ResolvedAgentModel>;
  fetch?: typeof fetch; tools?: AgentTool[]; redact?: (text: string) => Promise<string>;
  contextChars?: number; pollMs?: number;
  /** C01: false opens the store read-only (no settling of in-flight receipts, no status rewrite). Default true. */
  recover?: boolean; dataDirectory?: string; retryBaseMs?: number; maxRetries?: number; maxReviewRounds?: number;
}
const TERMINAL = new Set(['complete', 'failed', 'cancelled', 'budget_exceeded']);
const DEFAULT_AUTO: ToolRisk[] = ['read', 'write'];
const now = () => new Date().toISOString();
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
/** PR1-R06: Story import contract shared by validation and import.
 *  Required (absent or mistyped -> reject): version; character id/name/features/referenceAssetIds; shot id/summary/durationSeconds/characters
 *  (each referencing a defined character). Defaultable fields of older documents (status, title, logline, targetSeconds, style.*,
 *  consistency, character description, shot shotType/camera/dialogue/continueFromPrevious) are migrated to their empty values.
 *  The migrated document is exercised by every consumer (storyBrief, anchorPrompt) before it is accepted. Returns null when invalid. */
export function migrateStory(v: Record<string, unknown>): Story | null {
  const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const str = (x: unknown): x is string => typeof x === 'string';
  const opt = (x: unknown, fallback: string) => x === undefined ? fallback : str(x) ? x : null;
  const strs = (x: unknown): x is string[] => Array.isArray(x) && x.every(str);
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (!Number.isSafeInteger(v.version)) return null;
  if (v.status !== undefined && v.status !== 'empty' && v.status !== 'approved') return null;
  if (v.characters !== undefined && !Array.isArray(v.characters) || v.shots !== undefined && !Array.isArray(v.shots)) return null;
  if (v.style !== undefined && !obj(v.style)) return null;
  const st = (v.style ?? {}) as Record<string, unknown>;
  const style = { look: opt(st.look, ''), palette: opt(st.palette, ''), typography: opt(st.typography, ''), motion: opt(st.motion, ''), negative: opt(st.negative, '') };
  if (Object.values(style).some(x => x === null)) return null;
  const characters: Story['characters'] = [];
  for (const c of (v.characters ?? []) as unknown[]) {
    if (!obj(c) || !str(c.id) || !c.id || !str(c.name) || !strs(c.features) || !strs(c.referenceAssetIds)) return null;
    const description = opt(c.description, ''); if (description === null || c.voice !== undefined && !str(c.voice)) return null;
    characters.push({ id: c.id, name: c.name, description, features: c.features, referenceAssetIds: c.referenceAssetIds, ...(str(c.voice) ? { voice: c.voice } : {}) });
  }
  const known = new Set(characters.map(c => c.id)); const shots: Story['shots'] = [];
  for (const sh of (v.shots ?? []) as unknown[]) {
    if (!obj(sh) || !str(sh.id) || !sh.id || !str(sh.summary) || !num(sh.durationSeconds) || !strs(sh.characters) || sh.characters.some(id => !known.has(id))) return null;
    const shotType = opt(sh.shotType, ''), camera = opt(sh.camera, ''), dialogue = opt(sh.dialogue, '');
    if (shotType === null || camera === null || dialogue === null || sh.shotId !== undefined && !str(sh.shotId) || sh.continueFromPrevious !== undefined && typeof sh.continueFromPrevious !== 'boolean') return null;
    shots.push({ id: sh.id, ...(str(sh.shotId) ? { shotId: sh.shotId } : {}), summary: sh.summary, shotType, camera, durationSeconds: sh.durationSeconds, dialogue, characters: sh.characters, continueFromPrevious: sh.continueFromPrevious === true });
  }
  if (v.consistency !== undefined && !(obj(v.consistency) && Object.values(v.consistency).every(c => obj(c) && num(c.score)))) return null;
  const title = opt(v.title, ''), logline = opt(v.logline, '');
  if (title === null || logline === null || v.targetSeconds !== undefined && !num(v.targetSeconds) || v.approvedAt !== undefined && !str(v.approvedAt) || v.updatedAt !== undefined && !str(v.updatedAt)) return null;
  const story: Story = { version: v.version as number, projectId: str(v.projectId) ? v.projectId : '', status: v.status === 'approved' ? 'approved' : 'empty', title, logline, targetSeconds: (v.targetSeconds as number | undefined) ?? 0,
    style: style as Story['style'], characters, shots, ...(str(v.approvedAt) ? { approvedAt: v.approvedAt } : {}), updatedAt: str(v.updatedAt) ? v.updatedAt : new Date(0).toISOString(), consistency: (v.consistency ?? {}) as Story['consistency'] };
  try { storyBrief({ ...story, status: 'approved' }); anchorPrompt(story, characters.map(c => c.id)); } catch { return null; }
  return story;
}
/** Approval binding: run + tool + canonical arguments. */
export function argsHash(runId: string, tool: string, args: Record<string, unknown>): string { return createHash('sha256').update(runId + '\0' + tool + '\0' + canonical(args)).digest('hex'); }
function sleep(ms: number, signal: AbortSignal) { return new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms); const stop = () => { clearTimeout(timer); reject(signal.reason); }; signal.addEventListener('abort', stop, { once: true }); }); }

/** Plan → act → observe → reflect loop over registered tools, with approval gates, budgets, durable resume and traces. */
export class AgentService {
  private runs = new Map<string, AgentRun>();
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private projectCommands = new Map<string, Promise<void>>();
  private listeners = new Set<(event: AgentEvent) => void>();
  private store: RunStore; private tools: AgentTool[]; private initialized?: Promise<void>; private stopped = false;
  private imageBuffer = new Map<string, AgentContent[]>();
  private stories: ProjectDocs<Story>; private ledgers: ProjectDocs<Ledger>; private qcs: ProjectDocs<{ version: number; report?: QcReport }>;
  constructor(directory: string, private readonly port: AgentPort, private readonly options: AgentServiceOptions) {
    this.store = new RunStore(directory, options.redact); this.tools = options.tools ?? createTools();
    const base = options.dataDirectory ?? directory;
    this.stories = new ProjectDocs(join(base, 'stories'), emptyStory); this.ledgers = new ProjectDocs(join(base, 'ledger'), emptyLedger); this.qcs = new ProjectDocs(join(base, 'qc'), () => ({ version: 0 }));
  }
  get toolList(): readonly AgentTool[] { return this.tools; }
  docs(projectId: string): AgentDocs {
    return {
      story: () => this.stories.get(projectId),
      updateStory: (change, expected) => this.stories.update(projectId, change, expected),
      ledger: () => this.ledgers.get(projectId),
      saveQc: async report => { await this.qcs.update(projectId, current => ({ ...current, report })); },
    };
  }
  story(projectId: string) { return this.stories.get(projectId); }
  /** Agent-side project data for backups: story, budget ledger and last QC report. Missing documents are omitted. */
  async exportDocs(projectId: string): Promise<Record<'story' | 'ledger' | 'qc', unknown>> {
    const [story, ledger, qc] = await Promise.all([this.stories.raw(projectId), this.ledgers.raw(projectId), this.qcs.raw(projectId)]);
    return Object.fromEntries(Object.entries({ story, ledger, qc }).filter(([, value]) => value !== undefined)) as Record<'story' | 'ledger' | 'qc', unknown>;
  }
  /** R06: structural validation of imported agent documents (types of every field the services read). Throws before anything is written. */
  validateDocs(docs: Partial<Record<'story' | 'ledger' | 'qc', unknown>>): void {
    const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const num = (v: unknown, min = 0) => typeof v === 'number' && Number.isFinite(v) && v >= min;
    const str = (v: unknown) => typeof v === 'string';
    const optStr = (v: unknown) => v === undefined || str(v);
    const strs = (v: unknown) => v === undefined || Array.isArray(v) && v.every(str);
    const checks: Record<'story' | 'ledger' | 'qc', (v: Record<string, unknown>) => boolean> = {
      story: v => migrateStory(v) !== null,
      ledger: v => (v.spent === undefined || num(v.spent)) && (v.unknownCostCalls === undefined || Number.isSafeInteger(v.unknownCostCalls) && (v.unknownCostCalls as number) >= 0)
        && (v.maxCost === undefined || v.maxCost === null || num(v.maxCost)) && optStr(v.currency)
        && (v.settledExecutions === undefined || obj(v.settledExecutions) && Object.values(v.settledExecutions).every(value => value === true))
        && (v.byTool === undefined || obj(v.byTool) && Object.values(v.byTool).every(t => obj(t) && Number.isSafeInteger(t.calls) && (t.calls as number) >= 0 && num(t.cost))),
      qc: v => v.report === undefined || obj(v.report) && typeof v.report.pass === 'boolean' && Array.isArray(v.report.issues) && v.report.issues.every(i => obj(i) && str(i.message) && str(i.check) && str(i.severity)) && strs(v.report.unchecked),
    };
    for (const [name, value] of Object.entries(docs) as ['story' | 'ledger' | 'qc', unknown][]) {
      if (value === undefined) continue;
      if (!checks[name] || !obj(value) || !Number.isSafeInteger(value.version) || !checks[name](value)) throw new Error('工程包中的智能体资料损坏：' + name);
    }
  }
  /** Restore agent data into a (new) project ID. All documents are validated first (nothing is written if any is invalid); projectId is rewritten. */
  async importDocs(projectId: string, docs: Partial<Record<'story' | 'ledger' | 'qc', unknown>>): Promise<void> {
    this.validateDocs(docs);
    if (docs.story) await this.stories.put(projectId, { ...migrateStory(docs.story as Record<string, unknown>)!, projectId });
    if (docs.ledger) await this.ledgers.put(projectId, { ...emptyLedger(projectId), ...(docs.ledger as Ledger), projectId });
    if (docs.qc) await this.qcs.put(projectId, docs.qc as { version: number; report?: QcReport });
  }
  /** User edits from the UI (style, characters, logline). Shots are changed through the agent's plan_shots or here wholesale. */
  async saveStory(projectId: string, input: Record<string, unknown>, expectedVersion: number): Promise<Story> {
    return this.stories.update(projectId, current => {
      const next = { ...current, updatedAt: now() };
      if (typeof input.title === 'string') next.title = input.title.trim().slice(0, 80);
      if (typeof input.logline === 'string') next.logline = input.logline.trim().slice(0, 1200);
      if (input.style !== undefined) next.style = normalizeStyle(input.style);
      if (Array.isArray(input.characters)) { const list = input.characters.slice(0, 20).map(normalizeCharacter); const used = new Set(next.shots.flatMap(s => s.characters)); const missing = [...used].filter(id => !list.some(c => c.id === id)); if (missing.length) throw new Error('分镜仍在使用这些角色，不能删除：' + missing.join(', ')); next.characters = list; }
      if (input.status === 'empty') { next.status = 'empty'; delete next.approvedAt; }
      return next;
    }, expectedVersion);
  }
  ledger(projectId: string) { return this.ledgers.get(projectId); }
  setProjectBudget(projectId: string, maxCost: number | null, currency?: string): Promise<Ledger> {
    if (maxCost !== null && (!Number.isFinite(maxCost) || maxCost < 0)) throw new Error('费用上限须为非负数，或留空表示不限');
    if(currency!==undefined&&!/^[A-Z]{3}$/.test(currency))throw new Error('账本币种须为三个大写字母');
    return this.ledgers.update(projectId, current => {
      if(currency!==undefined&&currency!==current.currency&&(current.spent!==0||current.unknownCostCalls>0||Object.values(current.byTool).some(entry=>entry.cost!==0)))throw new Error('已有花费或未知费用记录，不能直接更改账本币种');
      return {...current,maxCost,...(currency?{currency}:{}),updatedAt:now()};
    });
  }
  async lastQc(projectId: string) { return (await this.qcs.get(projectId)).report ?? null; }
  async runQc(projectId: string, signal = new AbortController().signal): Promise<QcReport> { return qualityCheck(this.context('qc', projectId, signal, false)); }
  /** F02 single image-send gate: without the run's consent the tool context has no vision port, so no tool can upload frames. */
  private context(runId: string, projectId: string, signal: AbortSignal, allowImages = true): ToolContext {
    const port: AgentPort = allowImages ? this.port : Object.create(this.port, { vision: { value: undefined, enumerable: true } });
    return { runId, projectId, signal, port, docs: this.docs(projectId) };
  }
  /** Tools exposed to one run: image-upload tools are withheld unless the user allowed sending frames. */
  private runTools(run: AgentRun, capabilities: Capabilities): AgentTool[] {
    const tools = activeTools(this.tools, capabilities);
    return (run as AgentRun & { allowImages?: boolean }).allowImages === true ? tools : tools.filter(tool => !(tool.requires ?? []).includes('vision'));
  }
  private async spend(projectId: string, tool: string, cost: number | null | undefined, settleUnknown = false, executionId?: string) {
    await this.ledgers.update(projectId, current => {
      if (executionId && current.settledExecutions?.[executionId]) return current;
      const entry = current.byTool[tool] ?? { calls: 0, cost: 0 };
      if (!settleUnknown) entry.calls++;
      if (typeof cost === 'number') { entry.cost += cost; current.spent += cost; if (settleUnknown) current.unknownCostCalls = Math.max(0, current.unknownCostCalls - 1); } else if (!settleUnknown) current.unknownCostCalls++;
      return { ...current, byTool: { ...current.byTool, [tool]: entry }, ...(executionId ? { settledExecutions: { ...current.settledExecutions, [executionId]: true as const } } : {}), updatedAt: now() };
    });
  }
  /** Current capability snapshot (hot: re-read before every model step). */
  async capabilities(): Promise<{ capabilities: Capabilities; tools: { name: string; risk: string; description: string }[]; selfMade: string[] }> {
    const capabilities = await this.port.capabilities?.().catch(() => ({ roles: [] })) ?? { roles: this.port.vision ? ['vision' as const] : [] };
    const tools = activeTools(this.tools, capabilities);
    return { capabilities, tools: tools.map(tool => ({ name: tool.name, risk: tool.risk, description: tool.description })), selfMade: capabilityPrompt(capabilities.roles).selfMade };
  }
  initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      for (const run of await this.store.loadAll()) {
        if (this.options.recover === false) { this.runs.set(run.id, run); continue; }
        for (const call of run.queue) call.execId ??= randomUUID();
        if (run.pending && !run.pending.execId) { const call = run.queue.find(item => item.id === run.pending!.callId); if (call) { run.pending.execId = call.execId; try { run.pending.argsHash = argsHash(run.id, call.name, JSON.parse(call.arguments || '{}')); } catch { /* re-asked on resume */ } } }
        const successes = await this.store.toolSuccesses(run.id);
        if (run.inFlight && !successes.some(receipt => receipt.execId === run.inFlight!.execId)) { this.runs.set(run.id, run); await this.settleInFlight(run); if (run.status === 'awaiting_approval') run.status = 'paused'; }
        if (run.status === 'running' || run.status === 'waiting_task') { run.status = 'paused'; run.message = '应用重启时运行被中断，可点击「继续」从断点恢复'; await this.store.save(run); }
        this.runs.set(run.id, run);
      }
    })();
  }
  subscribe(listener: (event: AgentEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: AgentEvent) { for (const listener of this.listeners) { try { listener(event); } catch { /* listener errors never break the loop */ } } }
  public(run: AgentRun): PublicRun {
    const { messages, ...rest } = structuredClone(run);
    const transcript = messages.slice(1).map(message => ({
      role: message.role,
      content: typeof message.content === 'string' ? bound(message.content, 2000) : Array.isArray(message.content) ? message.content.map(part => part.type === 'text' ? part.text : '[图片]').join('\n') : '',
      ...(message.role === 'assistant' && message.tool_calls?.length ? { tool: message.tool_calls.map(call => call.function.name).join(', ') } : {}),
    }));
    return { ...rest, transcript };
  }
  private async save(run: AgentRun) { run.updatedAt = now(); await this.store.save(run); this.emit({ type: 'run', run: this.public(run) }); }
  private async step(run: AgentRun, step: Omit<RunStep, 'index' | 'startedAt'>): Promise<RunStep> {
    const value: RunStep = { index: run.steps.length, startedAt: now(), ...step }; run.steps.push(value);
    await this.store.trace(run.id, { event: 'step.start', step: value }); this.emit({ type: 'step', runId: run.id, step: value }); return value;
  }
  private async finishStep(run: AgentRun, step: RunStep, patch: Partial<RunStep>) {
    Object.assign(step, patch, { finishedAt: now() }); step.durationMs = Date.parse(step.finishedAt!) - Date.parse(step.startedAt);
    await this.store.trace(run.id, { event: 'step.finish', step }); this.emit({ type: 'step', runId: run.id, step });
  }
  private async required(id: string) { await this.initialize(); const run = this.runs.get(id); if (!run) throw new Error('智能体运行不存在'); return run; }
  async list(projectId?: string) { await this.initialize(); return [...this.runs.values()].filter(run => !projectId || run.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(run => this.public(run)); }
  async get(id: string) { return this.public(await this.required(id)); }
  async trace(id: string) { await this.required(id); return this.store.readTrace(id); }

  /** Serialize lifecycle changes only within one project; snapshot I/O must not leave an activation race. */
  private projectCommand<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.projectCommands.get(projectId) ?? Promise.resolve()).then(() => {
      this.requireOpen(); return work();
    });
    const drained = next.then(() => {}, () => {});
    this.projectCommands.set(projectId, drained);
    void drained.then(() => { if (this.projectCommands.get(projectId) === drained) this.projectCommands.delete(projectId); });
    return next;
  }
  private requireOpen() { if (this.stopped) throw new Error('智能体服务正在关闭'); }
  private async requireProjectAvailable(projectId: string, exceptId?: string) {
    // Terminal/paused status is published just before the loop returns; drain that final save instead of reporting a false conflict.
    await Promise.all([...this.runs.values()].filter(run => run.id !== exceptId && run.projectId === projectId && (TERMINAL.has(run.status) || run.status === 'paused')).map(run => this.settled(run.id)));
    if ([...this.runs.values()].some(run => run.id !== exceptId && run.projectId === projectId && (this.active.has(run.id) || !TERMINAL.has(run.status) && run.status !== 'paused'))) throw new Error('该工程已有进行中的智能体运行，请先完成、暂停或取消');
  }

  async start(input: AgentStartInput): Promise<PublicRun> {
    await this.initialize(); this.requireOpen();
    if (typeof input.projectId !== 'string' || !input.projectId) throw new Error('缺少工程');
    const goal = String(input.goal ?? '').trim(); if (!goal || goal.length > 8000) throw new Error('目标须为 1–8000 字');
    return this.projectCommand(input.projectId, async () => {
      await this.requireProjectAvailable(input.projectId);
      const snapshot = await this.port.snapshot(input.projectId);
      this.requireOpen();
      if (!snapshot.project || snapshot.project.id !== input.projectId) throw new Error('工程不存在或未打开');
      const budget = budgetFrom(input.budget), autoApprove = (input.autoApprove ?? DEFAULT_AUTO).filter(risk => ['read', 'write', 'plan', 'cost', 'export'].includes(risk));
      if (!autoApprove.includes('read')) autoApprove.push('read');
      const run: AgentRun = {
        version: 1, id: randomUUID(), projectId: input.projectId, goal, status: 'running', message: '智能体正在规划', createdAt: now(), updatedAt: now(),
        model: {}, budget, usage: emptyUsage(budget.currency), policy: { autoApprove },
        messages: [{ role: 'user', content: `目标：${goal}\n\n当前工程摘要：${JSON.stringify(summarizeProject(snapshot.project))}` }],
        steps: [], queue: [], approvedCallIds: [], reviewRounds: 0,
      };
      (run as AgentRun & { maxReviewRounds?: number }).maxReviewRounds = Number.isSafeInteger(input.maxReviewRounds) ? Math.max(0, Math.min(5, input.maxReviewRounds!)) : this.options.maxReviewRounds ?? 2;
      (run as AgentRun & { allowImages?: boolean }).allowImages = input.allowImages === true;
      this.runs.set(run.id, run); await this.store.trace(run.id, { event: 'run.start', goal, budget, autoApprove }); await this.save(run);
      this.launch(run); return this.public(run);
    });
  }
  /** R08: a loop publishes paused/awaiting state just before it exits; callers acting on that state wait for it to finish. */
  /** R02: decisions are bound to the host execution ID (and optionally the args hash) of the pending call; a stale or replayed
   *  decision for an earlier call that reused the provider call ID is rejected instead of attaching to the current one. */
  private checkPending(pending: AgentRun['pending'], execId?: string, expectedArgsHash?: string) {
    if (!pending?.execId) return; // legacy pending records created before execution IDs
    if (typeof execId !== 'string' || !execId) throw Object.assign(new Error('审批需要提供待批准步骤的 execId'), { code: 'EXEC_ID_REQUIRED' });
    if (execId !== pending.execId) throw Object.assign(new Error('审批已过期：待批准的步骤已变化，请刷新后重新确认'), { code: 'STALE_APPROVAL' });
    if (expectedArgsHash !== undefined && expectedArgsHash !== pending.argsHash) throw Object.assign(new Error('审批已过期：参数已变化'), { code: 'STALE_APPROVAL' });
  }
  /** R03: a paid/export call that was in flight when the loop stopped (pause, cancel, dispose, crash) has an unknown outcome.
   *  Record it, answer the model's tool call as unknown and drop it from the queue so resume never re-executes it;
   *  later paid calls then require explicit approval (uncertainSubmissions). */
  private async settleInFlight(run: AgentRun): Promise<boolean> {
    const flight = run.inFlight; if (!flight) return false;
    // A known result belongs to the success journal even when bookkeeping is still failing.
    if ((await this.store.toolSuccesses(run.id)).some(receipt => receipt.execId === flight.execId)) return false;
    const entry = { execId: flight.execId, tool: flight.tool, at: now(), error: '运行中断时收费请求已发出，结果未知（可能已受理并计费）', attempts: 1 };
    (run.uncertainSubmissions ??= []).push(entry); delete run.inFlight;
    const call = run.queue.find(item => item.execId === flight.execId);
    if (call) { run.queue = run.queue.filter(item => item !== call); run.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: entry.error, submissionUncertain: true, hint: '系统没有重新提交。不要自行重复调用；等待用户确认。' }) }); }
    chargeTool(run.usage, null, 'cost');
    await this.store.trace(run.id, { event: 'submission.uncertain', reason: 'interrupted', ...entry }); await this.save(run); return true;
  }
  private async settled(id: string) { const active = this.active.get(id); if (active) await active.promise.catch(() => {}); }
  private launch(run: AgentRun) {
    if (this.stopped || this.active.has(run.id)) return;
    const controller = new AbortController();
    const promise = this.loop(run, controller.signal).catch(async error => {
      if (controller.signal.aborted) return;
      run.status = 'failed'; run.error = errorText(error); run.message = '运行失败：' + run.error; await this.store.trace(run.id, { event: 'run.failed', error: run.error }); await this.save(run);
    }).finally(() => { this.active.delete(run.id); });
    this.active.set(run.id, { controller, promise });
  }
  async approve(id: string, callId: string, execId?: string, expectedArgsHash?: string): Promise<PublicRun> {
    const run = await this.required(id);
    return this.projectCommand(run.projectId, async () => {
      if (run.status !== 'awaiting_approval' || run.pending?.callId !== callId) throw new Error('没有待批准的这一步');
      await this.settled(id); if (run.status !== 'awaiting_approval' || run.pending?.callId !== callId) throw new Error('没有待批准的这一步');
      this.requireOpen(); await this.requireProjectAvailable(run.projectId, run.id);
      this.checkPending(run.pending, execId, expectedArgsHash);
      if (run.pending.execId && run.pending.argsHash) (run.approvals ??= []).push({ execId: run.pending.execId, tool: run.pending.tool, argsHash: run.pending.argsHash });
      await this.store.trace(run.id, { event: 'approval', callId, execId: run.pending.execId, decision: 'approved', tool: run.pending.tool });
      const step = [...run.steps].reverse().find((s: RunStep) => s.kind === 'approval' && s.callId === callId); if (step) await this.finishStep(run, step, { status: 'complete', summary: '用户已批准' });
      delete run.pending; run.status = 'running'; run.message = '已批准，继续执行'; await this.save(run); this.launch(run); return this.public(run);
    });
  }
  async reject(id: string, callId: string, execId?: string, reason = ''): Promise<PublicRun> {
    const run = await this.required(id);
    return this.projectCommand(run.projectId, async () => {
      if (run.status !== 'awaiting_approval' || run.pending?.callId !== callId) throw new Error('没有待批准的这一步');
      await this.settled(id); if (run.status !== 'awaiting_approval' || run.pending?.callId !== callId) throw new Error('没有待批准的这一步');
      this.requireOpen(); await this.requireProjectAvailable(run.projectId, run.id);
      this.checkPending(run.pending, execId);
      const tool = run.pending.tool; await this.store.trace(run.id, { event: 'approval', callId, decision: 'rejected', tool, reason });
      const step = [...run.steps].reverse().find((s: RunStep) => s.kind === 'approval' && s.callId === callId); if (step) await this.finishStep(run, step, { status: 'rejected', summary: '用户拒绝' + (reason ? '：' + reason : '') });
      const pendingExec = run.pending.execId; run.queue = pendingExec ? run.queue.filter(call => call.execId !== pendingExec) : run.queue.filter(call => call.id !== callId);
      run.messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ rejected: true, reason: reason.slice(0, 500) || '用户拒绝执行此操作，请换一种方式或说明原因' }) });
      delete run.pending; run.status = 'running'; run.message = '已拒绝，智能体调整方案'; await this.save(run); this.launch(run); return this.public(run);
    });
  }
  async resume(id: string): Promise<PublicRun> {
    const run = await this.required(id);
    return this.projectCommand(run.projectId, async () => {
      if (!['paused', 'failed', 'waiting_task'].includes(run.status) || run.status === 'waiting_task' && this.active.has(id)) throw new Error('当前状态不能继续');
      await this.settled(id); if (!['paused', 'failed', 'waiting_task'].includes(run.status) || this.active.has(id)) throw new Error('当前状态不能继续');
      this.requireOpen(); await this.requireProjectAvailable(run.projectId, run.id);
      if (run.status === 'failed' && !run.queue.length) run.messages.push({ role: 'user', content: '上一步失败：' + (run.error ?? '') + '。请根据当前工程重新判断并继续。' });
      run.status = run.waiting ? 'waiting_task' : 'running'; delete run.error; run.message = '从断点继续'; await this.store.trace(run.id, { event: 'run.resume' }); await this.save(run); this.launch(run); return this.public(run);
    });
  }
  async pause(id: string): Promise<PublicRun> {
    const run = await this.required(id);
    return this.projectCommand(run.projectId, async () => {
      const active = this.active.get(id);
      active?.controller.abort(new Error('用户暂停')); await active?.promise.catch(() => {});
      await this.settleInFlight(run);
      if (!TERMINAL.has(run.status) && run.status !== 'awaiting_approval') { run.status = 'paused'; run.message = '已暂停，可继续'; await this.store.trace(run.id, { event: 'run.pause' }); await this.save(run); }
      return this.public(run);
    });
  }
  async cancel(id: string): Promise<PublicRun> {
    const run = await this.required(id);
    return this.projectCommand(run.projectId, async () => {
      const active = this.active.get(id);
      active?.controller.abort(new Error('用户取消')); await active?.promise.catch(() => {});
      // Cancelling cannot discard an already successful paid effect that still needs local settlement.
      try { for (const receipt of await this.store.toolSuccesses(run.id)) await this.settleToolSuccess(run, receipt); }
      catch (error) {
        run.status = 'failed'; run.error = errorText(error); run.message = '工具已成功，但本地结算尚未完成；回执已保留，修复后可继续结算或再次取消';
        await this.save(run); return this.public(run);
      }
      await this.settleInFlight(run);
      if (run.status === 'failed' || !TERMINAL.has(run.status)) { run.status = 'cancelled'; run.message = '已取消'; delete run.pending; run.queue = []; await this.store.trace(run.id, { event: 'run.cancel' }); await this.save(run); }
      return this.public(run);
    });
  }
  async dispose() {
    this.stopped = true;
    for (const { controller } of this.active.values()) controller.abort(new Error('应用正在关闭'));
    await Promise.allSettled([...this.projectCommands.values()]);
    await Promise.allSettled([...this.active.values()].map(item => item.promise));
  }

  private async budgetLimit(run: AgentRun, scope: 'model' | 'tool'): Promise<string | null> {
    const limit = overBudget(run.budget, run.usage, scope); if (limit) return limit;
    const ledger = await this.ledgers.get(run.projectId);
    return ledger.maxCost !== null && ledger.spent >= ledger.maxCost ? `项目累计花费 ${ledger.spent.toFixed(2)} 已达上限 ${ledger.maxCost} ${ledger.currency}` : null;
  }

  private async withRetry<T>(run: AgentRun, step: RunStep, work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const max = this.options.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try { step.attempts = attempt + 1; return await work(); }
      catch (error) {
        if (signal.aborted || classify(error) !== 'retry' || attempt >= max) throw error;
        await this.store.trace(run.id, { event: 'retry', step: step.index, attempt: attempt + 1, error: errorText(error) });
        await sleep(backoff(attempt, this.options.retryBaseMs ?? 500), signal);
      }
    }
  }

  private async loop(run: AgentRun, signal: AbortSignal): Promise<void> {
    // Complete recorded effects before credentials, changed capabilities, approvals or budgets can cause a new submission.
    for (const receipt of await this.store.toolSuccesses(run.id)) await this.settleToolSuccess(run, receipt);
    let model = await this.options.resolveModel();
    if (run.model.mode === 'plan-json') model = { ...model, config: { ...model.config, supportsTools: false } };
    run.model = { connectionId: model.connectionId, model: model.config.model, mode: model.config.supportsTools ? 'tools' : 'plan-json' };
    const meta = run as AgentRun & { maxReviewRounds?: number; allowImages?: boolean; dirty?: boolean };
    await this.settleInFlight(run);
    while (true) {
      signal.throwIfAborted();
      if (run.waiting) { await this.awaitTask(run, signal); continue; }
      if (run.queue.length) {
        // F06: budget is checked before *every* tool execution, not only before the next model turn.
        const limit = await this.budgetLimit(run, 'tool');
        if (limit) { run.status = 'budget_exceeded'; run.message = '已停止：' + limit; await this.store.trace(run.id, { event: 'budget', reason: limit, usage: run.usage, pendingCalls: run.queue.map(c => c.name) }); await this.save(run); return; }
        const call = run.queue[0];
        const outcome = await this.runCall(run, call, model, signal);
        if (outcome === 'suspend') return;
        continue;
      }
      const images = this.imageBuffer.get(run.id); if (images?.length) { run.messages.push({ role: 'user', content: [{ type: 'text', text: '上面工具截取的画面：' }, ...images] }); this.imageBuffer.delete(run.id); }
      const limit = await this.budgetLimit(run, 'model');
      if (limit) { run.status = 'budget_exceeded'; run.message = '已停止：' + limit; await this.store.trace(run.id, { event: 'budget', reason: limit, usage: run.usage }); await this.save(run); return; }
      const compressed = compressMessages(run.messages, this.options.contextChars ?? 120_000);
      if (compressed.compressed) { run.messages = compressed.messages; const s = await this.step(run, { kind: 'compress', status: 'running' }); await this.finishStep(run, s, { status: 'complete', summary: '已压缩较早的上下文' }); }
      const caps = await this.capabilities(), tools = this.runTools(run, caps.capabilities), roleText = capabilityPrompt(caps.capabilities.roles);
      const brief = storyBrief(await this.stories.get(run.projectId)), planRule = brief ? brief : '工程还没有已批准的创作计划：多镜头或有角色的目标，先用 plan_story（剧本/风格/角色）和 plan_shots（分镜表）提交计划，等用户批准后再动手；简单的单镜头修改可以直接做。写镜头源码前可用 skill_read 查阅导演技能文档。';
      const promptExtra = roleText.text + '\n' + planRule;
      const changed = JSON.stringify(run.active?.tools) !== JSON.stringify(tools.map(t => t.name));
      if (run.active && changed) { run.messages.push({ role: 'user', content: '（系统通知）可用生成能力已变化：' + roleText.text }); await this.store.trace(run.id, { event: 'capabilities', roles: caps.capabilities.roles, tools: tools.map(t => t.name) }); }
      run.active = { roles: caps.capabilities.roles, tools: tools.map(t => t.name), selfMade: roleText.selfMade };
      run.message = '模型思考中'; await this.save(run);
      const step = await this.step(run, { kind: 'model', status: 'running' });
      let turn;
      try {
        turn = await this.withRetry(run, step, async () => {
          try { return await chatTurn(model.config, systemPrompt(promptExtra), run.messages, tools, signal, this.options.fetch); }
          catch (error) {
            if (model.config.supportsTools && looksLikeNoToolSupport(error)) {
              model = { ...model, config: { ...model.config, supportsTools: false } }; run.model.mode = 'plan-json';
              await this.store.trace(run.id, { event: 'fallback', to: 'plan-json', error: errorText(error) });
              return chatTurn(model.config, systemPrompt(promptExtra), run.messages, tools, signal, this.options.fetch);
            }
            throw error;
          }
        }, signal);
      } catch (error) { if (signal.aborted) throw error; await this.finishStep(run, step, { status: 'failed', error: errorText(error) }); throw error; }
      run.usage.steps++;
      const ledger = await this.ledgers.get(run.projectId);
      const cost = turn.usageKnown && ledger.currency === run.usage.currency ? tokenCost(model.parameters, turn.usage.inputTokens, turn.usage.outputTokens, run.usage.currency) : null;
      chargeModel(run.usage, turn.usage.inputTokens, turn.usage.outputTokens, cost); await this.spend(run.projectId, 'director', cost);
      await this.store.trace(run.id, { event: 'model', mode: turn.mode, finish: turn.finish, usage: turn.usage, usageKnown:turn.usageKnown, cost, content: bound(turn.content, 4000), toolCalls: turn.toolCalls });
      run.messages.push({ role: 'assistant', content: turn.content || null, ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments } })) } : {}) });
      await this.finishStep(run, step, { status: 'complete', summary: turn.toolCalls.length ? '计划调用：' + turn.toolCalls.map(call => call.name).join(', ') : bound(turn.content, 200) });
      if (turn.toolCalls.length) { run.queue = turn.toolCalls.map(call => ({ ...call, execId: randomUUID() })); await this.save(run); continue; }
      if (turn.finish === 'length') { run.messages.push({ role: 'user', content: '上一条输出被截断，请更简短地继续。' }); continue; }
      // Reflection: verify writes visually before accepting "done".
      if (meta.dirty && run.reviewRounds < (meta.maxReviewRounds ?? 2)) {
        run.reviewRounds++; meta.dirty = false;
        const review = await this.selfCheck(run, signal);
        if (review && !review.pass) { run.messages.push({ role: 'user', content: `自检（第 ${run.reviewRounds} 轮）发现问题，请修复后再总结：\n${review.text}` }); await this.save(run); continue; }
      }
      // Trace and persist the terminal snapshot before 'complete' is observable in memory (readers may act on it immediately).
      await this.store.trace(run.id, { event: 'run.complete', usage: run.usage });
      const final = { ...run, status: 'complete' as const, final: turn.content, message: '已完成', updatedAt: now() }; await this.store.save(final);
      run.status = 'complete'; run.final = turn.content; run.message = '已完成'; run.updatedAt = final.updatedAt; this.emit({ type: 'run', run: this.public(run) }); return;
    }
  }

  private async selfCheck(run: AgentRun, signal: AbortSignal): Promise<{ pass: boolean; text: string } | null> {
    const allowImages = (run as AgentRun & { allowImages?: boolean }).allowImages === true;
    const name = allowImages && this.port.vision && (await this.capabilities()).capabilities.roles.includes('vision') ? 'visual_review' : 'render_check', tool = this.tools.find(item => item.name === name); if (!tool) return null;
    const step = await this.step(run, { kind: 'review', status: 'running', tool: name });
    try {
      const result = await tool.run({}, this.context(run.id, run.projectId, signal, allowImages));
      let pass = true;
      try { const value = JSON.parse(result.content.slice(result.content.indexOf('{'), result.content.lastIndexOf('}') + 1)); pass = value.skipped === true || value.pass === true || (name === 'render_check' && value.status === 'complete' && !value.error); } catch { pass = false; }
      await this.finishStep(run, step, { status: 'complete', summary: (pass ? '自检通过：' : '自检发现问题：') + bound(result.content, 300) });
      return { pass, text: result.content };
    } catch (error) { if (signal.aborted) throw error; await this.finishStep(run, step, { status: 'failed', error: errorText(error) }); return { pass: false, text: '自检失败：' + errorText(error) }; }
  }

  private async runCall(run: AgentRun, call: ToolCall, model: ResolvedAgentModel, signal: AbortSignal): Promise<'next' | 'suspend'> {
    const meta = run as AgentRun & { dirty?: boolean; allowImages?: boolean };
    const active = this.runTools(run, (await this.capabilities()).capabilities);
    const tool = active.find(item => item.name === call.name);
    const respond = (content: string) => { run.messages.push({ role: 'tool', tool_call_id: call.id, content }); run.queue.shift(); };
    if (!tool) { respond(JSON.stringify({ error: (this.tools.some(t => t.name === call.name) ? ((this.tools.find(t => t.name === call.name)?.requires ?? []).includes('vision') && !meta.allowImages ? '用户未允许向视觉模型发送画面，该工具已停用；请改用 render_check / quality_check：' : '该工具当前未激活（对应模型未接入）：') : '未知工具：') + call.name + '。可用：' + active.map(t => t.name).join(', ') })); await this.save(run); return 'next'; }
    if (call.arguments.length > 2_100_000) { respond(JSON.stringify({ error: '工具参数超过 2MB 上限' })); await this.save(run); return 'next'; }
    let args: Record<string, unknown>;
    try { const parsed = JSON.parse(call.arguments || '{}'); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数须为对象'); args = parsed; }
    catch (error) { respond(JSON.stringify({ error: '参数不是有效 JSON 对象：' + errorText(error) })); await this.save(run); return 'next'; }
    call.execId ??= randomUUID();
    const hash = argsHash(run.id, tool.name, args);
    const grant = (run.approvals ?? []).findIndex(item => item.execId === call.execId && item.tool === tool.name && item.argsHash === hash);
    if (grant >= 0) run.approvals!.splice(grant, 1); // single use: consumed before execution
    else {
      const estimate = tool.estimate?.(args) ?? (tool.risk === 'cost' ? null : 0);
      const uncertain = tool.risk === 'cost' && run.uncertainSubmissions?.length ? '此前有收费请求结果未知（可能已受理并扣费），再次提交需要你确认' : null;
      const reason = uncertain ?? needsApproval(tool.risk, run.policy.autoApprove, run.budget, run.usage, estimate, tool.risk === 'cost' ? await this.ledgers.get(run.projectId) : undefined);
      if (reason) {
        run.pending = { callId: call.id, execId: call.execId, argsHash: hash, tool: tool.name, risk: tool.risk, arguments: bound(call.arguments, 4000), reason, estimate };
        run.status = 'awaiting_approval'; run.message = `等待批准：${tool.name}（${reason}）`;
        await this.step(run, { kind: 'approval', status: 'pending', tool: tool.name, callId: call.id, risk: tool.risk, arguments: bound(call.arguments, 2000), summary: reason });
        await this.save(run); return 'suspend';
      }
    }
    const step = await this.step(run, { kind: 'tool', status: 'running', tool: tool.name, callId: call.id, risk: tool.risk, arguments: bound(call.arguments, 2000) });
    run.message = '执行工具：' + tool.name; await this.save(run);
    let result: ToolResult;
    // F04: paid / export tools have side effects that cannot be proven idempotent, so they are submitted exactly once.
    const sideEffect = tool.risk === 'cost' || tool.risk === 'export';
    const work = () => tool.run({ ...args, __callId: call.execId }, this.context(run.id, run.projectId, signal, meta.allowImages === true));
    if (sideEffect) { run.inFlight = { execId: call.execId!, tool: tool.name, argsHash: hash, startedAt: now() }; await this.save(run); }
    // Capabilities, approval and durable preparation can await I/O. Honor a budget changed during that preparation
    // at the last boundary before submitting work, including calls with an already consumed approval grant.
    let finalLimit: string | null;
    try { finalLimit = await this.budgetLimit(run, 'tool'); signal.throwIfAborted(); }
    catch (error) { delete run.inFlight; throw error; } // Nothing has been submitted yet.
    if (finalLimit) {
      delete run.inFlight;
      await this.finishStep(run, step, { status: 'skipped', summary: '未执行：' + finalLimit });
      run.status = 'budget_exceeded'; run.message = '已停止：' + finalLimit;
      await this.store.trace(run.id, { event: 'budget', reason: finalLimit, usage: run.usage, pendingCalls: run.queue.map(call => call.name) });
      await this.save(run); return 'suspend';
    }
    try { result = sideEffect ? await (async () => { step.attempts = 1; return work(); })() : await this.withRetry(run, step, work, signal); }
    catch (error) {
      if (signal.aborted) throw error; // R03: the in-flight receipt stays persisted and is settled by pause/restart/resume
      delete run.inFlight;
      // R04: decide on the adapter's structured submission state; only undeclared errors fall back to the transport classifier.
      const state = submissionOf(error) ?? (classify(error) === 'retry' ? 'unknown' : undefined);
      if (sideEffect && state === 'unknown') {
        const jobId = (error as { jobId?: unknown })?.jobId;
        const message = errorText(error), entry = { execId: call.execId!, tool: tool.name, at: now(), error: message.slice(0, 500), attempts: 1, ...(typeof jobId === 'string' ? { jobId } : {}) };
        (run.uncertainSubmissions ??= []).push(entry);
        await this.store.trace(run.id, { event: 'submission.uncertain', ...entry });
        await this.finishStep(run, step, { status: 'failed', error: '提交结果未知，未自动重试：' + message });
        chargeTool(run.usage, null, tool.risk);
        respond(JSON.stringify({ error: message, submissionUncertain: true, hint: '请求可能已被供应商受理并计费，系统没有自动重新提交。不要自行重复调用；等待用户确认。' }));
        run.status = 'paused'; run.message = `${tool.name} 的收费请求结果未知（可能已受理），没有自动重试。请到供应商控制台确认后再点「继续」；再次提交需要重新批准`;
        await this.save(run); return 'suspend';
      }
      const kind = classify(error), message = errorText(error);
      await this.finishStep(run, step, { status: 'failed', error: message });
      chargeTool(run.usage, 0, 'read');
      respond(JSON.stringify({ error: message, hint: kind === 'conflict' ? '工程版本已变化：先调用 project_get 获取最新 revision 再重试' : kind === 'retry' ? '临时故障，已重试多次' : '请修正参数或换一种方法' }));
      await this.save(run); return 'next';
    }
    const receipt: ToolSuccessReceipt = { execId: call.execId!, tool: tool.name, argsHash: hash, risk: tool.risk, stepIndex: step.index, at: now(), result };
    // Keep inFlight until the known outcome has its own durable journal. Any later failure only retries settlement.
    if (sideEffect) await this.store.saveToolSuccess(run.id, receipt);
    await this.settleToolSuccess(run, receipt, model);
    signal.throwIfAborted(); return 'next';
  }

  private async settleToolSuccess(run: AgentRun, receipt: ToolSuccessReceipt, model?: ResolvedAgentModel): Promise<void> {
    const key = run.id + '.' + receipt.execId;
    const call = run.queue.find(item => item.execId === receipt.execId);
    if (!call) {
      if (!(run.settledToolExecIds ?? []).includes(key)) {
        // Orphaned success: never resubmit and never block the run forever. Account the known cost once (ledger dedupes by key),
        // record it as an uncertain submission (later paid calls need explicit approval) and tell the model it was not adopted.
        const error = '工具已成功，但回执无法匹配运行队列；结果未自动采用，未重新提交（请人工核对）';
        chargeTool(run.usage, receipt.result.cost, receipt.risk); (run.settledToolExecIds ??= []).push(key);
        if (receipt.risk === 'cost') await this.spend(run.projectId, receipt.tool, receipt.result.waitFor ? null : receipt.result.cost, false, key);
        (run.uncertainSubmissions ??= []).push({ execId: receipt.execId, tool: receipt.tool, at: now(), error, attempts: 1 });
        if (run.inFlight?.execId === receipt.execId) delete run.inFlight;
        await this.store.trace(run.id, { event: 'tool.orphan_success', execId: receipt.execId, tool: receipt.tool });
        await this.save(run);
      }
      await this.store.removeToolSuccess(run.id, receipt.execId); return;
    }
    if (call.name !== receipt.tool || argsHash(run.id, call.name, JSON.parse(call.arguments || '{}')) !== receipt.argsHash) throw new Error('工具成功回执与执行参数不符；未重新提交');
    const meta = run as AgentRun & { dirty?: boolean; allowImages?: boolean };
    let result = receipt.result;
    if (!(run.settledToolExecIds ?? []).includes(key)) {
      chargeTool(run.usage, result.cost, receipt.risk); (run.settledToolExecIds ??= []).push(key);
    }
    if (receipt.risk === 'cost') await this.spend(run.projectId, receipt.tool, result.waitFor ? null : result.cost, false, key);
    if (receipt.risk === 'write') meta.dirty = true;
    if (result.images?.length) {
      if ((model?.vision ?? true) && meta.allowImages) this.imageBuffer.set(run.id, [...(this.imageBuffer.get(run.id) ?? []), ...result.images.map(image => ({ type: 'image_url' as const, image_url: { url: `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}` } }))]);
      else result = { ...result, content: result.content + '（画面已截取；当前模型或设置不允许发送图片，请用 visual_review 或 render_check 检查）' };
    }
    const step = run.steps[receipt.stepIndex]; if (step) await this.finishStep(run, step, { status: 'complete', summary: bound(result.content, 300) });
    if (result.projectTask && !run.taskRefs?.some(task => task.id === result.projectTask!.id)) (run.taskRefs ??= []).push({ ...result.projectTask, callId: call.id, execId: call.execId });
    if (result.waitFor) { run.waiting = { ...result.waitFor, callId: call.id, execId: call.execId }; run.status = 'waiting_task'; run.message = '等待生成任务完成'; }
    else run.messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
    run.queue = run.queue.filter(item => item !== call);
    if (run.inFlight?.execId === receipt.execId) delete run.inFlight;
    await this.save(run);
    await this.store.removeToolSuccess(run.id, receipt.execId);
  }

  private async awaitTask(run: AgentRun, signal: AbortSignal): Promise<void> {
    const waiting = run.waiting!; const terminal = new Set(['ready', 'complete', 'failed', 'cancelled', 'unknown', 'paused']);
    while (true) {
      signal.throwIfAborted();
      const result = await this.port.route(waiting.kind === 'media' ? 'media.get' : 'workflows.get', waiting.kind === 'media' ? { taskId: waiting.id } : { workflowId: waiting.id });
      const value = (result.value ?? {}) as Record<string, unknown>, state = String(value.phase ?? value.status ?? '');
      if (!result.ok || terminal.has(state) || (waiting.kind === 'workflow' && state !== 'running')) {
        if (waiting.kind === 'media' && value.usage && typeof (value.usage as { cost?: unknown }).cost === 'number') {
          const key = run.id + '.' + (waiting.execId ?? waiting.id) + '.settled';
          if (!run.settledToolExecIds?.includes(key)) { run.usage.cost += (value.usage as { cost: number }).cost; run.usage.unknownCostCalls = Math.max(0, run.usage.unknownCostCalls - 1); (run.settledToolExecIds ??= []).push(key); }
          await this.spend(run.projectId, 'media', (value.usage as { cost: number }).cost, true, key);
        }
        run.messages.push({ role: 'tool', tool_call_id: waiting.callId, content: bound(JSON.stringify(result.ok ? { id: waiting.id, state, message: value.message, error: value.error, hint: state === 'ready' ? '素材已就绪：调用 media_apply 采用' : undefined } : { error: result.error?.message })) });
        delete run.waiting; run.status = 'running'; run.message = '生成任务已结束'; await this.save(run); return;
      }
      await sleep(this.options.pollMs ?? 1000, signal);
    }
  }
}
