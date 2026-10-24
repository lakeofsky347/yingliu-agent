/**
 * yingliu — headless CLI for agents and scripts. Non-interactive, `--json` output, stable exit codes.
 * Reuses the same application services as the desktop app (createApplication + route()).
 * Docs: docs/CLI.md
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApplication } from '../app/application.ts';
import { detectEnvironment } from '../host/renderer.ts';
import type { SecretStore } from '../app/contracts.ts';
import { MODEL_PROTOCOLS, MODEL_ROLES, ROLE_OUTPUT, ROLE_PROTOCOLS, type Modality, type ModelProtocol, type ModelRole } from '../models/contracts.ts';
import { MOCK_BASE_URL, mockFetch, installMockNetworkGuard } from './mock.ts';
import { acquireOwner, BusyError } from './lock.ts';

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, NOT_FOUND: 3, NEEDS_APPROVAL: 4, BUDGET: 5, ENVIRONMENT: 6, RUN_FAILED: 7, TIMEOUT: 8, BUSY: 9 } as const;
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
  private async map(): Promise<Record<string, string>> { try { return JSON.parse(await readFile(this.file, 'utf8')); } catch { return {}; } }
  async bind(ref: string, envName: string) { if (!/^[A-Z_][A-Z0-9_]{0,100}$/.test(envName)) throw new CliError('USAGE', '--api-key-env 必须是环境变量名（大写字母、数字、下划线）'); const m = await this.map(); m[ref] = envName; await mkdir(dirname(this.file), { recursive: true }); await writeFile(this.file, JSON.stringify(m, null, 2)); }
  async get(ref: string) { const name = (await this.map())[ref]; return name ? process.env[name] || undefined : undefined; }
  async set(): Promise<void> { throw new Error('CLI 不保存 API Key；请用 --api-key-env 指定环境变量名'); }
  async delete(ref: string) { const m = await this.map(); delete m[ref]; await writeFile(this.file, JSON.stringify(m, null, 2)).catch(() => {}); }
  async envName(ref: string) { return (await this.map())[ref]; }
}

export const dataDirectory = () => resolve(process.env.YINGLIU_DATA_DIR || join(homedir(), '.local', 'share', 'yingliu-agent-cli'));
const TERMINAL = new Set(['complete', 'failed', 'cancelled', 'budget_exceeded']), STOPPED = new Set(['awaiting_approval', 'paused']);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type App = Awaited<ReturnType<typeof createApplication>>;
interface Ctx { app: App; secrets: EnvSecrets; flags: Flags; mock: boolean }
async function call<T = any>(ctx: Ctx, endpoint: string, payload: unknown = {}): Promise<T> {
  const r = await ctx.app.route(endpoint, payload);
  if (!r.ok) { const m = r.error.message; throw new CliError(/未找到|不存在|not found/i.test(m) ? 'NOT_FOUND' : 'ERROR', m); }
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
/** C04: the command's result is the run merged with the project task it started (e.g. export_mp4). A failed/cancelled task makes
 *  the command fail (RUN_FAILED, exit 7) even when the run itself completed; a completed export returns its output path. */
export function mergeRunResult(view: ReturnType<typeof runView>, task: { kind: string; status: string; message?: string; error?: string } | undefined, output?: { id?: string; path?: string }) {
  const taskView = task ? { kind: task.kind, status: task.status, message: task.message, error: task.error } : undefined;
  if (task && (task.status === 'failed' || task.status === 'cancelled')) {
    return { ok: false as const, error: { code: 'RUN_FAILED' as const, message: `运行关联的${task.kind === 'export' ? '导出' : ''}任务${task.status === 'failed' ? '失败' : '已取消'}：${task.error || task.message || task.status}`, run: view, task: taskView } };
  }
  return { ok: true as const, data: { ...view, ...(taskView ? { task: taskView } : {}), ...(task?.kind === 'export' && task.status === 'complete' && output?.path ? { output: { id: output.id, path: output.path } } : {}) } };
}
async function finishRun(ctx: Ctx, run: any, since: string) {
  const done = await waitRun(ctx, run.id);
  // Tools such as export_mp4 start a project task and return; keep the process alive until it settles so it is not killed on exit.
  const { task, snap } = await waitIdle(ctx, done.projectId);
  const own = task && task.startedAt >= since ? task : undefined; // only a task started during this command belongs to this run
  const merged = mergeRunResult(runView(done), own, snap?.project?.outputs?.at(-1));
  if (!merged.ok) throw Object.assign(new CliError('RUN_FAILED', merged.error.message), { details: { run: merged.error.run, task: merged.error.task } });
  return { data: merged.data, exit: runExit(done.status) };
}
async function waitIdle(ctx: Ctx, projectId: string) {
  const until = Date.now() + (num(ctx.flags, 'timeout') ?? 600) * 1000;
  while (true) {
    const snap = await call(ctx, 'current', { projectId }), task = snap.task;
    if (!task || task.status !== 'running') return { task: task ?? undefined, snap };
    if (Date.now() > until) throw new CliError('TIMEOUT', '等待工程任务超时：' + task.kind);
    await sleep(200);
  }
}
async function waitTask(ctx: Ctx, projectId: string, kind: string) {
  const until = Date.now() + (num(ctx.flags, 'timeout') ?? 600) * 1000;
  while (true) {
    const snap = await call(ctx, 'current', { projectId }); const task = snap.task;
    if (task && task.kind === kind && task.status !== 'running') return { snap, task };
    if (Date.now() > until) throw new CliError('TIMEOUT', '等待任务超时');
    await sleep(200);
  }
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
      await call(ctx, 'export', { projectId });
      const { snap, task } = await waitTask(ctx, projectId, 'export');
      if (task.status !== 'complete') throw new CliError('RUN_FAILED', task.error || task.message || '导出失败');
      const output = snap.project.outputs.at(-1); let path = output?.path;
      const out = str(f, 'out'); if (out && path) { const { copyFile } = await import('node:fs/promises'); await mkdir(dirname(resolve(out)), { recursive: true }); await copyFile(path, resolve(out)); path = resolve(out); }
      return { data: { projectId, path, output } };
    }
    case 'models': switch (sub) {
      case 'list': {
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
  const dir = dataDirectory(); await mkdir(dir, { recursive: true });
  const secrets = new EnvSecrets(join(dir, 'cli-key-env.json')), mock = flags.mock === true;
  let app: App | undefined, release: (() => Promise<void>) | undefined; const unguard = mock ? installMockNetworkGuard() : undefined;
  try {
    const projects = process.env.YINGLIU_PROJECTS ? resolve(process.env.YINGLIU_PROJECTS) : join(dir, 'projects'), readOnly = isReadOnly(positional, flags);
    const lockSeconds = flags['lock-timeout'] === undefined ? 30 : Number(flags['lock-timeout']); if (!Number.isFinite(lockSeconds) || lockSeconds < 0) throw new CliError('USAGE', '--lock-timeout 必须是非负数字');
    try { release = await acquireOwner([dir, projects], positional.slice(0, 2).join(' '), lockSeconds * 1000); } catch (e) { if (e instanceof BusyError) throw new CliError('BUSY', e.message); throw e; }
    app = await createApplication({ dataDirectory: dir, projectsDirectory: projects, credentials: secrets, ...(mock ? { fetch: mockFetch(), resumeRemoteTasks: false } : {}), ...(readOnly ? { recover: false } : {}) });
    const ctx: Ctx = { app, secrets, flags, mock };
    if (mock && !readOnly) await ensureMockModels(ctx);
    const r = await dispatch(ctx, positional);
    return emit(true, r.data, r.exit ?? EXIT.OK);
  } catch (error) {
    const e = error instanceof CliError ? error : new CliError('ERROR', error instanceof Error ? error.message : String(error));
    return emit(false, { code: e.code, message: e.message, ...(e.details ?? {}) }, EXIT[e.code]);
  } finally { await app?.dispose().catch(() => {}); await release?.(); unguard?.(); }
}
