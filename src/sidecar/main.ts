/**
 * P0 production sidecar entry (W1). Unlike the dev web-server it never derives paths from cwd or the source tree:
 * every root is explicit, the profile owner lock is taken before createApplication (initialize/recover), and the
 * host talks to it through a one-line JSON ready/shutdown handshake on stdio. See docs/p0/CONTRACTS.md.
 */
import { createHash } from 'node:crypto';
import { realpath, access } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { createApplication, MemorySecrets, type Application } from '../app/application.ts';
import { drainOwned, type OwnerLease } from '../app/ownership.ts';
import { startUiServer } from '../app/ui-server.ts';
import { acquireOwnerLease, BusyError, LockConfigError } from '../cli/lock.ts';
import { installMockNetworkGuard, mockFetch } from '../cli/mock.ts';

export const PROTOCOL_VERSION = 1;
export const RESOURCE_VERSION = 'p0-1';

export interface SidecarOptions { dataRoot: string; projectsRoot: string; resourceRoot: string; port: number; secrets: 'memory'; mock: boolean; lockTimeoutMs: number }

export function parseSidecarArgs(argv: string[]): SidecarOptions {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!; if (!a.startsWith('--')) throw new SidecarError('USAGE', '未知参数：' + a);
    const key = a.slice(2), next = argv[i + 1];
    if (key === 'mock') flags.set(key, true); else { if (next === undefined) throw new SidecarError('USAGE', a + ' 需要取值'); flags.set(key, next); i++; }
  }
  const path = (k: string) => { const v = flags.get(k); if (typeof v !== 'string' || !isAbsolute(v)) throw new SidecarError('USAGE', `--${k} 必须是绝对路径（生产 sidecar 不从 cwd 推导路径）`); return resolve(v); };
  const port = Number(flags.get('port') ?? 0); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new SidecarError('USAGE', '--port 必须是 0-65535');
  const secrets = flags.get('secrets') ?? 'memory'; if (secrets !== 'memory') throw new SidecarError('CONFIG', 'P0 sidecar 只支持 --secrets memory；OS keyring 代理属于 W5');
  const lock = Number(flags.get('lock-timeout-ms') ?? 0); if (!Number.isFinite(lock) || lock < 0) throw new SidecarError('USAGE', '--lock-timeout-ms 必须是非负数');
  for (const k of flags.keys()) if (!['data-root', 'projects-root', 'resource-root', 'port', 'secrets', 'mock', 'lock-timeout-ms'].includes(k)) throw new SidecarError('USAGE', '未知参数：--' + k);
  return { dataRoot: path('data-root'), projectsRoot: path('projects-root'), resourceRoot: path('resource-root'), port, secrets: 'memory', mock: flags.get('mock') === true, lockTimeoutMs: lock };
}

export class SidecarError extends Error { constructor(public code: 'USAGE' | 'CONFIG' | 'BUSY' | 'STARTUP', message: string) { super(message); } }
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');

export async function profileIdentity(dataRoot: string): Promise<string> {
  return createHash('sha256').update('yingliu-profile-v1\0' + await realpath(dataRoot)).digest('hex').slice(0, 32);
}

async function main() {
  const started = performance.now(), options = parseSidecarArgs(process.argv.slice(2));
  await access(join(options.resourceRoot, 'ui', 'index.html')).catch(() => { throw new SidecarError('STARTUP', '资源缺失：' + join(options.resourceRoot, 'ui', 'index.html')); });
  const abort = new AbortController();
  let ownership: OwnerLease | undefined, application: Application | undefined, server: Awaited<ReturnType<typeof startUiServer>> | undefined, unguard: (() => void) | undefined;
  let reason: string | undefined, releaseStop!: () => void, cleaning: Promise<void> | undefined;
  const stopped = new Promise<void>(resolve => { releaseStop = resolve; });
  const shutdown = (value: string) => { if (!reason) { reason = value; abort.abort(new Error('sidecar正在关闭')); releaseStop(); } };
  const interrupt = () => shutdown('SIGINT'), terminate = () => shutdown('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => { try { if (JSON.parse(line).type === 'shutdown') shutdown('request'); } catch { /* malformed control input grants no capability */ } });
  lines.on('close', () => { if (!cleaning) shutdown('stdin-closed'); });
  const cleanup = () => cleaning ??= (async () => {
    try { await drainOwned([() => application?.dispose(), () => server?.close()]); }
    finally {
      try { await ownership?.release(); }
      finally { unguard?.(); lines.close(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
    }
  })();
  try {
    // Borrow the entrypoint's shared lease. createApplication must never acquire the same ports a second time.
    try { ownership = await acquireOwnerLease([options.dataRoot, options.projectsRoot], 'sidecar', options.lockTimeoutMs, { signal: abort.signal }); }
    catch (error) { if (error instanceof BusyError) throw new SidecarError('BUSY', error.message); if (error instanceof LockConfigError) throw new SidecarError('CONFIG', error.message); throw error; }
    abort.signal.throwIfAborted();
    unguard = options.mock ? installMockNetworkGuard() : undefined;
    application = await createApplication({ dataDirectory: options.dataRoot, projectsDirectory: options.projectsRoot, credentials: new MemorySecrets(), ownership, ...(options.mock ? { fetch: mockFetch(), resumeRemoteTasks: false } : {}) });
    abort.signal.throwIfAborted();
    server = await startUiServer(application, join(options.resourceRoot, 'ui'), options.port, { sceneFrames: false });
    const profileId = await profileIdentity(options.dataRoot); abort.signal.throwIfAborted();
    emit({ type: 'ready', protocolVersion: PROTOCOL_VERSION, resourceVersion: RESOURCE_VERSION, profileId, pid: process.pid, port: Number(new URL(server.origin).port), origin: server.origin, token: server.token, mock: options.mock, readyMs: Math.round(performance.now() - started), runtime: (globalThis as { Bun?: { version: string } }).Bun ? 'bun ' + (globalThis as unknown as { Bun: { version: string } }).Bun.version : 'node ' + process.version });
    await stopped; await cleanup(); emit({ type: 'shutdown', ok: true, reason }); process.exit(0);
  } catch (error) {
    let failure: unknown;
    try { await cleanup(); } catch (cleanupError) { failure = cleanupError; }
    if (reason) { emit({ type: 'shutdown', ok: !failure, reason }); process.exit(failure ? 1 : 0); }
    if (failure) throw new SidecarError('STARTUP', 'sidecar清理失败：' + (failure instanceof Error ? failure.message : String(failure)));
    throw error;
  }
}

main().catch(error => {
  const code = error instanceof SidecarError ? error.code : 'STARTUP';
  emit({ type: 'error', code, message: error instanceof Error ? error.message : String(error) });
  process.exit({ USAGE: 2, BUSY: 9, CONFIG: 10, STARTUP: 11 }[code]);
});
