/**
 * yingliu — headless CLI for agents and scripts. Non-interactive, `--json` output, stable exit codes.
 * Reuses the same application services as the desktop app (createApplication + route()).
 * Docs: docs/CLI.md
 */
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApplication } from '../app/application.ts';
import { detectEnvironment } from '../host/renderer.ts';
import type { SecretStore } from '../app/contracts.ts';
import { MODEL_PROTOCOLS, MODEL_ROLES, ROLE_OUTPUT, ROLE_PROTOCOLS, type Modality, type ModelProtocol, type ModelRole } from '../models/contracts.ts';
import { MOCK_BASE_URL, mockFetch, installMockNetworkGuard } from './mock.ts';
import { acquireOwnerLease, BusyError, LockConfigError, type OwnerLease } from './lock.ts';
import { installCliLifecycle, CliInterruptedError, type CliLifecycle } from './lifecycle.ts';

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, NOT_FOUND: 3, NEEDS_APPROVAL: 4, BUDGET: 5, ENVIRONMENT: 6, RUN_FAILED: 7, TIMEOUT: 8, BUSY: 9, CONFIG: 10, STARTUP: 11 } as const;
export class CliError extends Error { details?: Record<string, unknown>; constructor(public code: keyof typeof EXIT, message: string) { super(message); } }

type Flags = Record<string, string | boolean>;
export function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [], flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string?]; if (v !== undefined) flags[k] = v; else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') && !BOOL.has(k)) flags[k] = argv[++i]!; else flags[k] = true; }
    else positional.push(a);
  }
  return { positional, flags };
}
const BOOL = new Set(['json', 'mock', 'no-wait', 'allow-paid', 'trace', 'force', 'help', 'include-archived', 'run', 'yes']);
/** C01: commands that only read. They open the profile with recovery disabled, so they never settle, resume or rewrite state. */
export function isReadOnly(pos: string[], f: Flags): boolean {
  const [g, s] = pos;
  return (g === 'project' && (s === 'list' || s === 'get')) || (g === 'agent' && s === 'status') || ((g === 'story' || g === 'ledger') && s === 'show') || (g === 'qc' && s === 'show' && f.run !== true) || (g === 'models' && s === 'list');
}
const str = (f: Flags, k: string, required = false): string | undefined => { const v = f[k]; if (typeof v === 'string' && v) return v; if (required) throw new CliError('USAGE', `缺少参数 --${k}`); return undefined; };
const num = (f: Flags, k: string): number | undefined => { const v = str(f, k); if (v === undefined) return undefined; const n = Number(v); if (!Number.isFinite(n)) throw new CliError('USAGE', `--${k} 必须是数字`); return n; };

/** Keys are never stored by the CLI: connections map their credentialRef to an environment variable NAME. */
class EnvSecrets implements SecretStore {
  constructor(private file: string) {}
  /** C06: only a missing file means "no bindings". Corrupt JSON or I/O/permission errors fail with CONFIG and leave the bytes untouched. */
  private async map(): Promise<Record<string, string>> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new CliError('CONFIG', `无法读取 ${this.file}：${(e as Error).message}`); }
    let value: unknown; try { value = JSON.parse(text); } catch (e) { throw new CliError('CONFIG', `${this.file} 已损坏（不是合法 JSON），已保留原文件，请手工修复或移走后重试：${(e as Error).message}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every(v => typeof v === 'string')) throw new CliError('CONFIG', `${this.file} 格式无效（应为 { 凭据引用: 环境变量名 }），已保留原文件`);
    return value as Record<string, string>;
  }
  /** Atomic write: temp file in the same directory, then rename. */
  private async write(m: Record<string, string>) {
    await mkdir(dirname(this.file), { recursive: true }); const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try { await writeFile(tmp, JSON.stringify(m, null, 2), { mode: 0o600 }); await rename(tmp, this.file); } catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw new CliError('CONFIG', `无法写入 ${this.file}：${(e as Error).message}`); }
  }
  async check() { await this.map(); }
  async bind(ref: string, envName: string) { if (!/^[A-Z_][A-Z0-9_]{0,100}$/.test(envName)) throw new CliError('USAGE', '--api-key-env 必须是环境变量名（大写字母、数字、下划线）'); const m = await this.map(); m[ref] = envName; await this.write(m); }
  async get(ref: string) { const name = (await this.map())[ref]; return name ? process.env[name] || undefined : undefined; }
  async set(): Promise<void> { throw new Error('CLI 不保存 API Key；请用 --api-key-env 指定环境变量名'); }
  async delete(ref: string) { const m = await this.map(); if (!(ref in m)) return; delete m[ref]; await this.write(m); }
  async envName(ref: string) { return (await this.map())[ref]; }
}

export const dataDirectory = () => resolve(process.env.YINGLIU_DATA_DIR || join(homedir(), '.local', 'share', 'yingliu-agent-cli'));
const TERMINAL = new Set(['complete', 'failed', 'cancelled', 'budget_exceeded']), STOPPED = new Set(['awaiting_approval', 'paused']);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type App = Awaited<ReturnType<typeof createApplication>>;
interface Ctx { app: App; secrets: EnvSecrets; flags: Flags; mock: boolean; lifecycle: CliLifecycle }
async function call<T = any>(ctx: Ctx, endpoint: string, payload: unknown = {}): Promise<T> {
  ctx.lifecycle.throwIfInterrupted();
  const r = await ctx.app.route(endpoint, payload);
  ctx.lifecycle.throwIfInterrupted();
  if (!r.ok) { const m = r.error.message; throw new CliError(r.error.code === 'BUSY' ? 'BUSY' : /未找到|不存在|not found/i.test(m) ? 'NOT_FOUND' : 'ERROR', m); }
  return r.value as T;
}
async function ensureMockModels(ctx: Ctx) {
  const list = await call<{ connections: { id: string }[]; models: { id: string }[]; roles: { role: string; modelId: string }[] }>(ctx, 'models.list');
  if (!list.connections.some(c => c.id === 'cli-mock')) await call(ctx, 'models.connection.save', { id: 'cli-mock', name: 'CLI 模拟网关（本地）', protocol: 'chat-completions', baseUrl: MOCK_BASE_URL, auth: 'none' });
  if (!list.models.some(m => m.id === 'cli-mock-director')) await call(ctx, 'models.model.save', { id: 'cli-mock-director', connectionId: 'cli-mock', model: 'mock-director', name: '模拟导演', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
  if (list.roles.find(r => r.role === 'director')?.modelId !== 'cli-mock-director') await call(ctx, 'models.role.bind', { role: 'director', modelId: 'cli-mock-director' });
}
/** Trim a run to what an agent needs; the full run is available with --trace. */
function runView(run: any) {
  const pending = run.pending ? { callId: run.pending.callId, execId: run.pending.execId, argsHash: run.pending.argsHash, tool: run.pending.tool, risk: run.pending.risk, arguments: run.pending.arguments, reason: run.pending.reason, estimate: run.pending.estimate } : undefined;
  return { id: run.id, projectId: run.projectId, status: run.status, message: run.message, goal: run.goal, usage: run.usage, budget: run.budget, pending, uncertainSubmissions: run.uncertainSubmissions ?? [], final: run.final, error: run.error, steps: (run.steps ?? []).length };
}
function runExit(status: string): number { return status === 'complete' ? EXIT.OK : STOPPED.has(status) ? EXIT.NEEDS_APPROVAL : status === 'budget_exceeded' ? EXIT.BUDGET : EXIT.RUN_FAILED; }
async function waitRun(ctx: Ctx, runId: string) {
  const timeout = (num(ctx.flags, 'timeout') ?? 600) * 1000, until = Date.now() + timeout;
  let run = await call(ctx, 'agent.get', { runId });
  while (!TERMINAL.has(run.status) && !STOPPED.has(run.status)) {
    if (Date.now() > until) { await call(ctx, 'agent.pause', { runId }).catch(() => {}); throw new CliError('TIMEOUT', `等待超时（${timeout / 1000}s），运行已暂停，可用 agent resume 继续`); }
    await sleep(150); run = await call(ctx, 'agent.get', { runId });
  }
  return run;
}
interface RunTaskResult { id: string; kind: string; status: string; message?: string; error?: string; retryOf?: string; outputId?: string }
interface RunOutput { id: string; path: string }
/** R2-06: only durable task IDs returned by this run's tools belong to the run. A preview cannot hide an earlier failed export.
 * A successful explicit retry can supersede failed ancestors, but only when its own output ID resolves to a project output. */
export function mergeRunResult(view: ReturnType<typeof runView>, tasks: RunTaskResult[], outputs: RunOutput[] = []) {
  const outputFor = (task: RunTaskResult) => task.kind === 'export' && task.status === 'complete' && task.outputId ? outputs.find(output => output.id === task.outputId && output.path) : undefined;
  const superseded = new Map<string, string>(), byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    if (!outputFor(task)) continue;
    const seen = new Set([task.id]); let parentId = task.retryOf;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId); const parent = byId.get(parentId);
      if (!parent || parent.kind !== 'export' || !['failed', 'cancelled'].includes(parent.status)) break;
      superseded.set(parent.id, task.id); parentId = parent.retryOf;
    }
  }
  const taskViews = tasks.map(task => ({ ...task, ...(superseded.has(task.id) ? { supersededBy: superseded.get(task.id)! } : {}) }));
  const failed = taskViews.find(task => !superseded.has(task.id) && (['failed', 'cancelled'].includes(task.status) || task.kind === 'export' && task.status === 'complete' && !outputFor(task)));
  if (failed) {
    const reason = failed.error || (failed.status === 'complete' ? '任务完成但未找到对应成片（outputId）' : failed.message || failed.status);
    return { ok: false as const, error: { code: 'RUN_FAILED' as const, message: `运行关联的${failed.kind === 'export' ? '导出' : ''}任务失败：${reason}`, run: view, task: failed, tasks: taskViews } };
  }
  const task = taskViews.filter(task => task.kind === 'export').at(-1) ?? taskViews.at(-1);
  const completed = [...tasks].reverse().find(task => !!outputFor(task)), output = completed && outputFor(completed);
  return { ok: true as const, data: { ...view, tasks: taskViews, ...(task ? { task } : {}), ...(output ? { output: { id: output.id, path: output.path } } : {}) } };
}
async function finishRun(ctx: Ctx, run: any, _since: string) {
  const done = await waitRun(ctx, run.id);
  const { tasks, snap } = await waitRunTasks(ctx, done.projectId, done.taskRefs ?? []);
  const merged = mergeRunResult(runView(done), tasks, snap.project?.outputs ?? []);
  if (!merged.ok) throw Object.assign(new CliError('RUN_FAILED', merged.error.message), { details: { run: merged.error.run, task: merged.error.task, tasks: merged.error.tasks } });
  return { data: merged.data, exit: runExit(done.status) };
}
async function waitRunTasks(ctx: Ctx, projectId: string, refs: { id: string; kind: string }[]) {
  const until = Date.now() + (num(ctx.flags, 'timeout') ?? 600) * 1000;
  const unique = [...new Map(refs.map(ref => [ref.id, ref])).values()];
  while (true) {
    const snap = await call(ctx, 'current', { projectId });
    const records = unique.length ? (await call<{ tasks: RunTaskResult[] }>(ctx, 'tasks', { projectId })).tasks : [];
    const tasks: RunTaskResult[] = unique.map(ref => {
      const found = snap.task?.id === ref.id ? snap.task : records.find(task => task.id === ref.id);
      return found ? { id: found.id, kind: found.kind, status: found.status, message: found.message, error: found.error, retryOf: found.retryOf, outputId: found.outputId } : { id: ref.id, kind: ref.kind, status: 'failed', error: '未找到运行关联的任务记录' };
    });
    if (tasks.every(task => task.status !== 'running')) return { tasks, snap };
    if (Date.now() > until) throw new CliError('TIMEOUT', '等待运行关联任务超时：' + tasks.filter(task => task.status === 'running').map(task => task.id).join(', '));
    await sleep(200);
  }
}
export async function waitTask(ctx: Ctx, projectId: string, kind: string, taskId: string | undefined) {
  // Direct render/export callers pin the submitted task. Without its ID we cannot tell it from an older task, so fail closed.
  const id = taskId;
  if (!id) throw new CliError('RUN_FAILED', '提交后没有返回任务 ID；不会改用工程当前任务，请用 yingliu 任务记录核对');
  const { snap, tasks } = await waitRunTasks(ctx, projectId, [{ id, kind }]);
  return { snap, task: tasks[0]! };
}

export const HELP = `yingliu — 映流智能体 headless CLI（详见 docs/CLI.md）
全局：--json  --mock  --timeout <秒>  --lock-timeout <秒，默认 30>   数据目录：YINGLIU_DATA_DIR，工程目录：YINGLIU_PROJECTS
  doctor
  project create --title <t> [--topic <t>] | list [--include-archived] | get <id> | export-zip <id> --out <file> | import <file>
  agent run --project <id> --goal <g> [--auto-approve read,write,plan] [--allow-paid --max-cost <n> [--auto-approve ...,cost,export]] [--max-steps n] [--max-review-rounds n]
  agent status <runId> [--trace] | resume <runId> | approve <runId> --call <callId> --exec <execId> [--args-hash h] | reject <runId> --call <callId> --exec <execId> [--reason r]
  story show <projectId> | qc show <projectId> [--run] | ledger show <projectId>
  render <projectId> | export mp4 <projectId> [--out <file>]
  models list | models add --name <n> --base-url <url> --model <m> [--protocol chat-completions|images|video-gateway|speech|async-task] [--role <按协议默认>|none] [--output-modality text|image|video|audio] [--api-key-env ENV_NAME]`;

async function dispatch(ctx: Ctx, pos: string[]): Promise<{ data: unknown; exit?: number }> {
  const [group, sub, arg] = pos, f = ctx.flags;
  switch (group) {
    case 'project': switch (sub) {
      case 'create': { const s = await call(ctx, 'create', { blank: true, title: str(f, 'title', true), ...(str(f, 'topic') ? { topic: str(f, 'topic') } : {}) }); return { data: { id: s.project.id, title: s.project.title, root: s.root, revision: s.project.revision } }; }
      case 'list': return { data: (await call(ctx, 'list', { includeArchived: f['include-archived'] === true })).projects };
      case 'get': { if (!arg) throw new CliError('USAGE', '用法：project get <id>'); const s = await call(ctx, 'current', { projectId: arg }); if (!s.project || s.project.id !== arg) throw new CliError('NOT_FOUND', '未找到视频工程 ' + arg); return { data: { project: s.project, root: s.root, task: s.task } }; }
      case 'export-zip': { if (!arg) throw new CliError('USAGE', '用法：project export-zip <id> --out <file>'); const out = resolve(str(f, 'out', true)!); return { data: await call(ctx, 'app.exportProject', { projectId: arg, path: out }) }; }
      case 'import': { if (!arg) throw new CliError('USAGE', '用法：project import <file>'); const s = await call(ctx, 'app.importProject', { path: resolve(arg) }); return { data: { id: s.project.id, title: s.project.title, root: s.root } }; }
    } break;
    case 'agent': switch (sub) {
      case 'run': {
        const risks = (str(f, 'auto-approve') ?? 'read,write,plan').split(',').map(s => s.trim()).filter(Boolean);
        for (const r of risks) if (!['read', 'write', 'plan', 'cost', 'export'].includes(r)) throw new CliError('USAGE', '未知风险级别：' + r);
        const maxCost = num(f, 'max-cost');
        if (risks.some(r => r === 'cost' || r === 'export') && (f['allow-paid'] !== true || maxCost === undefined || !(maxCost > 0))) throw new CliError('USAGE', '自动批准 cost/export 需要同时提供 --allow-paid 和 --max-cost <正数>');
        const budget: Record<string, number> = {}; if (maxCost !== undefined) budget.maxCost = maxCost; const steps = num(f, 'max-steps'); if (steps !== undefined) budget.maxSteps = steps;
        const reviews = num(f, 'max-review-rounds');
        const since = new Date().toISOString();
        const run = await call(ctx, 'agent.start', { projectId: str(f, 'project', true), goal: str(f, 'goal', true), autoApprove: risks, ...(Object.keys(budget).length ? { budget } : {}), ...(reviews !== undefined ? { maxReviewRounds: reviews } : {}) });
        return finishRun(ctx, run, since);
      }
      case 'status': { if (!arg) throw new CliError('USAGE', '用法：agent status <runId>'); const run = await call(ctx, 'agent.get', { runId: arg }); const data: Record<string, unknown> = runView(run); if (f.trace) data.trace = (await call(ctx, 'agent.trace', { runId: arg })).events; return { data, exit: EXIT.OK }; }
      case 'resume': { if (!arg) throw new CliError('USAGE', '用法：agent resume <runId>'); const since = new Date().toISOString(); return finishRun(ctx, await call(ctx, 'agent.resume', { runId: arg }), since); }
      case 'approve': case 'reject': {
        if (!arg) throw new CliError('USAGE', `用法：agent ${sub} <runId> --call <callId> --exec <execId>`);
        const payload = { runId: arg, callId: str(f, 'call', true), execId: str(f, 'exec', true), ...(sub === 'approve' && str(f, 'args-hash') ? { argsHash: str(f, 'args-hash') } : {}), ...(sub === 'reject' ? { reason: str(f, 'reason') ?? '' } : {}) };
        const since = new Date().toISOString(); return finishRun(ctx, await call(ctx, 'agent.' + sub, payload), since);
      }
    } break;
    case 'story': if (sub === 'show' && arg) return { data: await call(ctx, 'story.get', { projectId: arg }) }; break;
    case 'ledger': if (sub === 'show' && arg) return { data: await call(ctx, 'agent.ledger', { projectId: arg }) }; break;
    case 'qc': if (sub === 'show' && arg) return { data: f.run ? await call(ctx, 'agent.qc', { projectId: arg }) : (await call(ctx, 'agent.qc.last', { projectId: arg })).report ?? null }; break;
    case 'render': case 'export': {
      const projectId = group === 'render' ? sub : (sub === 'mp4' ? arg : undefined);
      if (!projectId) throw new CliError('USAGE', group === 'render' ? '用法：render <projectId>' : '用法：export mp4 <projectId>');
      const env = detectEnvironment({}); if (!env.browserAvailable || !env.ffmpegAvailable) throw new CliError('ENVIRONMENT', '导出需要 Chromium 和 ffmpeg；先运行 yingliu doctor');
      const submitted = await call(ctx, 'export', { projectId });
      const { snap, task } = await waitTask(ctx, projectId, 'export', submitted.task?.id);
      if (task.status !== 'complete') throw new CliError('RUN_FAILED', task.error || task.message || '导出失败');
      const output = snap.project.outputs.find((item: RunOutput) => item.id === task.outputId);
      if (!output?.path) throw new CliError('RUN_FAILED', '导出完成但未找到该任务对应的成片（outputId）');
      let path = output.path;
      const out = str(f, 'out'); if (out && path) { const { copyFile } = await import('node:fs/promises'); await mkdir(dirname(resolve(out)), { recursive: true }); await copyFile(path, resolve(out)); path = resolve(out); }
      return { data: { projectId, path, output } };
    }
    case 'models': switch (sub) {
      case 'list': {
        await ctx.secrets.check();
        const list = await call(ctx, 'models.list');
        const connections = await Promise.all(list.connections.map(async (c: any) => { const { credentialRef, credentialStatus, ...rest } = c; void credentialStatus; return { ...rest, apiKeyEnv: await ctx.secrets.envName(credentialRef) ?? null }; }));
        return { data: { connections, models: list.models, roles: list.roles } };
      }
      case 'add': {
        // C05: precheck everything (protocol, role, modality, key env) before any write; then save and roll back on failure.
        const protocol = (str(f, 'protocol') ?? 'chat-completions') as ModelProtocol;
        if (!MODEL_PROTOCOLS.includes(protocol)) throw new CliError('USAGE', `未知协议 ${protocol}；可选：${MODEL_PROTOCOLS.join(', ')}`);
        const fixed: Partial<Record<ModelProtocol, Modality>> = { 'chat-completions': 'text', images: 'image', 'video-gateway': 'video', speech: 'audio' };
        const defaults: Partial<Record<ModelProtocol, ModelRole>> = { 'chat-completions': 'director', images: 'image', 'video-gateway': 'video', speech: 'speech' };
        const roleFlag = str(f, 'role'), role = (roleFlag ?? defaults[protocol] ?? 'none') as ModelRole | 'none';
        if (role !== 'none' && !MODEL_ROLES.includes(role)) throw new CliError('USAGE', `未知角色 ${role}；可选：${MODEL_ROLES.join(', ')}, none`);
        if (role !== 'none' && !ROLE_PROTOCOLS[role].includes(protocol)) throw new CliError('USAGE', `协议 ${protocol} 不能绑定角色 ${role}（该角色支持：${ROLE_PROTOCOLS[role].join(', ')}）`);
        const modalityFlag = str(f, 'output-modality') as Modality | undefined;
        if (modalityFlag && !['text', 'image', 'video', 'audio'].includes(modalityFlag)) throw new CliError('USAGE', '--output-modality 必须是 text、image、video 或 audio');
        const output = modalityFlag ?? (role !== 'none' ? ROLE_OUTPUT[role] : fixed[protocol]);
        if (!output) throw new CliError('USAGE', `协议 ${protocol} 需要 --role（如 music/sfx/image/video/speech）或 --output-modality 来确定模型输出`);
        if (fixed[protocol] && output !== fixed[protocol]) throw new CliError('USAGE', `协议 ${protocol} 的输出只能是 ${fixed[protocol]}`);
        if (role !== 'none' && output !== ROLE_OUTPUT[role]) throw new CliError('USAGE', `角色 ${role} 需要输出 ${ROLE_OUTPUT[role]}，与 --output-modality ${output} 冲突`);
        const envName = str(f, 'api-key-env');
        if (envName && !/^[A-Z_][A-Z0-9_]{0,100}$/.test(envName)) throw new CliError('USAGE', '--api-key-env 必须是环境变量名（大写字母、数字、下划线）');
        if (envName && !process.env[envName]) throw new CliError('USAGE', `环境变量 ${envName} 未设置`);
        await ctx.secrets.check();
        const name = str(f, 'name', true)!, baseUrl = str(f, 'base-url', true)!, modelName = str(f, 'model', true)!;
        let conn: any, model: any, bound = false;
        try {
          conn = await call(ctx, 'models.connection.save', { name, protocol, baseUrl, auth: envName ? 'bearer' : 'none' });
          if (envName) { await ctx.secrets.bind(conn.credentialRef, envName); bound = true; }
          model = await call(ctx, 'models.model.save', { connectionId: conn.id, model: modelName, inputModalities: ['text'], outputModalities: [output], parameters: {} });
          if (role !== 'none') await call(ctx, 'models.role.bind', { role, modelId: model.id });
        } catch (error) {
          if (model) await call(ctx, 'models.model.remove', { id: model.id }).catch(() => {});
          if (conn) await call(ctx, 'models.connection.remove', { id: conn.id }).catch(() => {});
          if (bound) await ctx.secrets.delete(conn.credentialRef).catch(() => {});
          throw error instanceof CliError ? error : new CliError('USAGE', '添加模型失败，已回滚：' + (error instanceof Error ? error.message : String(error)));
        }
        return { data: { connectionId: conn.id, modelId: model.id, protocol, outputModality: output, role, apiKeyEnv: envName ?? null } };
      }
    } break;
  }
  throw new CliError('USAGE', '未知命令：' + pos.join(' ') + '\n' + HELP);
}

function doctor() {
  const env = detectEnvironment({}), [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  const checks = [
    { name: 'node', ok: major > 22 || (major === 22 && minor >= 18), detail: process.versions.node, required: '>=22.18' },
    { name: 'ffmpeg', ok: env.ffmpegAvailable, detail: env.ffmpegPath ?? null },
    { name: 'ffprobe', ok: env.ffprobeAvailable, detail: env.ffprobePath ?? null },
    { name: 'chromium', ok: env.browserAvailable, detail: env.browserPath ?? null },
  ];
  return { data: { ok: checks.every(c => c.ok), checks, dataDirectory: dataDirectory(), projectsDirectory: process.env.YINGLIU_PROJECTS ? resolve(process.env.YINGLIU_PROJECTS) : null }, exit: checks.every(c => c.ok) ? EXIT.OK : EXIT.ENVIRONMENT };
}

export async function runCli(argv: string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: s => process.stdout.write(s), err: s => process.stderr.write(s) }): Promise<number> {
  const { positional, flags } = parseArgs(argv); const json = flags.json === true;
  const emit = (ok: boolean, payload: unknown, code: number) => {
    if (json) io.out(JSON.stringify(ok ? { ok: true, data: payload } : { ok: false, error: payload }) + '\n');
    else if (ok) io.out((typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)) + '\n');
    else io.err('错误：' + (payload as { message: string }).message + '\n');
    return code;
  };
  if (flags.help || !positional.length) { if (json) return emit(true, { help: HELP }, EXIT.OK); io.out(HELP + '\n'); return positional.length || flags.help ? EXIT.OK : EXIT.USAGE; }
  if (positional[0] === 'doctor') { const r = doctor(); return emit(true, r.data, r.exit); }
  // C03: the CLI process is the only owner of a run (no resident service), so a run cannot outlive it; refuse instead of abandoning it.
  if (flags['no-wait'] !== undefined) return emit(false, { code: 'USAGE', message: '不支持 --no-wait：CLI 没有常驻进程，命令退出后运行会被中断。请去掉 --no-wait 并用 --timeout <秒> 控制等待；超时后运行会暂停，可用 agent resume 继续' }, EXIT.USAGE);
  const dir = dataDirectory();
  const secrets = new EnvSecrets(join(dir, 'cli-key-env.json')), mock = flags.mock === true;
  // C07: every startup failure becomes a single ok:false line with code STARTUP (BUSY/CONFIG/USAGE keep their own codes).
  const startup = async <T,>(what: string, work: () => Promise<T>): Promise<T> => { try { return await work(); } catch (e) { if (e instanceof CliError) throw e; throw new CliError('STARTUP', `启动失败（${what}）：${e instanceof Error ? e.message : String(e)}`); } };
  const lifecycle = installCliLifecycle();
  let app: App | undefined, ownership: OwnerLease | undefined; const unguard = mock ? installMockNetworkGuard() : undefined;
  let result: { ok: boolean; payload: unknown; code: number };
  try {
    const projects = process.env.YINGLIU_PROJECTS ? resolve(process.env.YINGLIU_PROJECTS) : join(dir, 'projects'), readOnly = isReadOnly(positional, flags);
    const lockSeconds = flags['lock-timeout'] === undefined ? 30 : Number(flags['lock-timeout']); if (!Number.isFinite(lockSeconds) || lockSeconds < 0) throw new CliError('USAGE', '--lock-timeout 必须是非负数字');
    await startup('创建数据目录 ' + dir, () => mkdir(dir, { recursive: true }));
    await startup('获取数据目录锁', async () => { try { ownership = await acquireOwnerLease([dir, projects], positional.slice(0, 2).join(' '), lockSeconds * 1000, { signal: lifecycle.signal }); } catch (e) { if (e instanceof BusyError) throw new CliError('BUSY', e.message); if (e instanceof LockConfigError) throw new CliError('CONFIG', e.message); throw e; } });
    if (!readOnly || positional[0] === 'models') await secrets.check(); // C06: a broken key map fails up front with CONFIG instead of surfacing as a provider error
    app = await startup('初始化应用', () => createApplication({ dataDirectory: dir, projectsDirectory: projects, credentials: secrets, ownership, ...(mock ? { fetch: mockFetch(), resumeRemoteTasks: false } : {}), ...(readOnly ? { recover: false } : {}) }));
    lifecycle.throwIfInterrupted();
    const ctx: Ctx = { app, secrets, flags, mock, lifecycle };
    if (mock && !readOnly) await ensureMockModels(ctx);
    const r = await dispatch(ctx, positional);
    result = { ok: true, payload: r.data, code: r.exit ?? EXIT.OK };
  } catch (error) {
    const e = error instanceof CliError ? error : new CliError('ERROR', error instanceof Error ? error.message : String(error));
    result = { ok: false, payload: { code: e.code, message: e.message, ...(e.details ?? {}) }, code: EXIT[e.code] };
  } finally {
    try { await lifecycle.shutdown(async () => { await app?.dispose(); }, () => ownership?.release() ?? Promise.resolve()); }
    catch (error) { result = { ok: false, payload: { code: 'ERROR', message: '退出清理失败：' + (error instanceof Error ? error.message : String(error)) }, code: EXIT.ERROR }; }
    finally { unguard?.(); }
  }
  if (lifecycle.signal.aborted) {
    const error = lifecycle.signal.reason as CliInterruptedError;
    return emit(false, { code: 'INTERRUPTED', message: error.message, signal: error.signalName }, lifecycle.exitCode!);
  }
  return emit(result!.ok, result!.payload, result!.code);
}
