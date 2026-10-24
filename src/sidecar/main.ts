/**
 * P0 production sidecar entry (W1). Unlike the dev web-server it never derives paths from cwd or the source tree:
 * every root is explicit, the profile owner lock is taken before createApplication (initialize/recover), and the
 * host talks to it through a one-line JSON ready/shutdown handshake on stdio. See docs/p0/CONTRACTS.md.
 */
import { createHash } from 'node:crypto';
import { realpath, mkdir, access } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { createApplication, MemorySecrets } from '../app/application.ts';
import { startUiServer } from '../app/ui-server.ts';
import { acquireOwner, BusyError } from '../cli/lock.ts';
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
  const started = performance.now();
  const options = parseSidecarArgs(process.argv.slice(2));
  await access(join(options.resourceRoot, 'ui', 'index.html')).catch(() => { throw new SidecarError('STARTUP', '资源缺失：' + join(options.resourceRoot, 'ui', 'index.html')); });
  await mkdir(options.dataRoot, { recursive: true }); await mkdir(options.projectsRoot, { recursive: true });
  // Owner lock BEFORE createApplication: initialize/recover must never run as a second writer.
  let release: () => Promise<void>;
  try { release = await acquireOwner([options.dataRoot, options.projectsRoot], 'sidecar', options.lockTimeoutMs); }
  catch (e) { if (e instanceof BusyError) throw new SidecarError('BUSY', e.message); if (e instanceof Error && /YINGLIU_LOCK_PORT/.test(e.message)) throw new SidecarError('CONFIG', e.message); throw e; }
  const unguard = options.mock ? installMockNetworkGuard() : undefined;
  const application = await createApplication({ dataDirectory: options.dataRoot, projectsDirectory: options.projectsRoot, credentials: new MemorySecrets(), ...(options.mock ? { fetch: mockFetch(), resumeRemoteTasks: false } : {}) });
  const server = await startUiServer(application, join(options.resourceRoot, 'ui'), options.port, { sceneFrames: false });
  let closing: Promise<void> | undefined;
  const shutdown = (reason: string) => closing ??= (async () => {
    let ok = true; try { await application.dispose(); } catch { ok = false; }
    try { await server.close(); } catch { ok = false; }
    try { await release(); } catch { ok = false; }
    unguard?.(); emit({ type: 'shutdown', ok, reason }); process.exit(ok ? 0 : 1);
  })();
  process.on('SIGINT', () => void shutdown('SIGINT')); process.on('SIGTERM', () => void shutdown('SIGTERM'));
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => { try { if (JSON.parse(line).type === 'shutdown') void shutdown('request'); } catch { /* ignore malformed control lines */ } });
  lines.on('close', () => void shutdown('stdin-closed')); // host died or closed the pipe
  emit({ type: 'ready', protocolVersion: PROTOCOL_VERSION, resourceVersion: RESOURCE_VERSION, profileId: await profileIdentity(options.dataRoot), pid: process.pid, port: Number(new URL(server.origin).port), origin: server.origin, token: server.token, mock: options.mock, readyMs: Math.round(performance.now() - started), runtime: (globalThis as { Bun?: { version: string } }).Bun ? 'bun ' + (globalThis as unknown as { Bun: { version: string } }).Bun.version : 'node ' + process.version });
}

main().catch(error => {
  const code = error instanceof SidecarError ? error.code : 'STARTUP';
  emit({ type: 'error', code, message: error instanceof Error ? error.message : String(error) });
  process.exit({ USAGE: 2, BUSY: 9, CONFIG: 10, STARTUP: 11 }[code]);
});
