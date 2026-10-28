import { createHash } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { hostname } from 'node:os';

/** Legacy filename: existing empty or half-written files are never ownership evidence. */
export const LOCK_NAME = '.yingliu-owner.lock';
export interface LockOwner { pid: number; host: string; startedAt: string; command: string }
export class BusyError extends Error {
  readonly code = 'BUSY';
  constructor(public owner: LockOwner | undefined, public path: string) {
    super(`数据目录正被另一个 yingliu 进程或本机端口占用（${owner ? `pid ${owner.pid}，命令 ${owner.command}，开始于 ${owner.startedAt}` : '未知占用者；为保护工程不会接管'}）：${path}；请等待其结束，或用 --lock-timeout <秒> 延长等待`);
  }
}

/** Invalid lock configuration (e.g. YINGLIU_LOCK_PORT); the CLI maps it to CONFIG (exit 10). */
export class LockConfigError extends Error { readonly code = 'CONFIG'; }

export interface OwnerLease {
  /** Dynamic project claims fail immediately by default, avoiding waits while other directory locks are held. */
  claim(directories: string[], timeoutMs?: number, options?: { existingOnly?: boolean }): Promise<void>;
  release(): Promise<void>;
}

interface LockTarget { path: string; identity: string; port: number }
const HOST = '127.0.0.1', BANNER = 'yingliu-owner-v1 ';

/** Directory identity also unifies symlink/case aliases. Bigints preserve Windows file IDs. */
async function targetFor(directory: string, existingOnly = false, environment: NodeJS.ProcessEnv = process.env): Promise<LockTarget> {
  if (!existingOnly) await mkdir(directory, { recursive: true });
  const path = await realpath(directory), info = await stat(path, { bigint: true });
  if (!info.isDirectory()) throw new Error('工程锁目标不是目录：' + path);
  // Some filesystems do not expose a file ID. The canonical path is a conservative fallback.
  const identity = info.ino !== 0n ? `${info.dev}:${info.ino}` : (process.platform === 'win32' ? path.toLowerCase() : path);
  return { path, identity, port: lockPortFor(identity, environment) };
}

/** Outside every common ephemeral range (Linux 32768-60999, Windows/macOS/IANA 49152-65535), so outgoing connections never
 *  squat a lock port. YINGLIU_LOCK_PORT pins one port for all directories (profile-wide lock) when the derived one collides. */
export const LOCK_PORT_RANGE = { min: 21000, max: 28999 } as const;
export function lockPortFor(identity: string, env: NodeJS.ProcessEnv = process.env): number {
  const override = env.YINGLIU_LOCK_PORT;
  if (override !== undefined && override !== '') {
    if (!/^\d+$/.test(override) || Number(override) < 1024 || Number(override) > 65535) throw new LockConfigError('YINGLIU_LOCK_PORT 必须是 1024-65535 之间的整数');
    return Number(override);
  }
  const hash = createHash('sha256').update('yingliu-owner-v1\0' + identity).digest();
  return LOCK_PORT_RANGE.min + hash.readUInt32BE(0) % (LOCK_PORT_RANGE.max - LOCK_PORT_RANGE.min + 1);
}

/** Binding is the authority, not the diagnostic banner or any file. Hash collisions remain BUSY. */
function bind(target: LockTarget, owner: LockOwner): Promise<Server | undefined> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket); socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      socket.setTimeout(200, () => socket.destroy());
      socket.end(BANNER + JSON.stringify(owner) + '\n');
    });
    server.maxConnections = 8;
    // A diagnostic client cannot keep a release pending indefinitely.
    server.on('yingliu-release', () => { for (const socket of sockets) socket.destroy(); });
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(undefined); else reject(error);
    });
    server.listen({ host: HOST, port: target.port, exclusive: true }, () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.emit('yingliu-release');
    server.close(error => error ? reject(error) : resolve());
  });
}

/** Best-effort diagnostics only: malformed/foreign services can never grant ownership. */
function inspectOwner(port: number): Promise<LockOwner | undefined> {
  return new Promise(resolve => {
    let bytes = '', settled = false;
    const socket = createConnection({ host: HOST, port });
    const finish = (owner?: LockOwner) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(owner); };
    const timer = setTimeout(() => finish(), 120);
    socket.on('error', () => finish()); socket.on('end', () => finish());
    socket.on('data', chunk => {
      bytes += chunk.toString(); if (bytes.length > 2048) return finish();
      if (!bytes.includes('\n')) return;
      try {
        if (!bytes.startsWith(BANNER)) return finish();
        const value = JSON.parse(bytes.slice(BANNER.length).split('\n')[0]!);
        if (Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.host === 'string' && typeof value.startedAt === 'string' && typeof value.command === 'string') finish(value);
        else finish();
      } catch { finish(); }
    });
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Same-host, cross-process exclusion with an OS-owned TCP listener. Process death releases it even if no JS cleanup runs.
 * We never read/check/unlink a lock file to take over. Port collisions with other profiles/services fail conservatively.
 * The signal cancels acquisition only; callers must drain their application before releasing an acquired owner.
 */
export async function acquireOwnerLease(dirs: string[], command: string, timeoutMs: number, options: { signal?: AbortSignal } = {}): Promise<OwnerLease> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('锁等待时间必须是非负有限数字');
  const signal = options.signal; signal?.throwIfAborted();
  const owner: LockOwner = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), command };
  // Capture the configured protocol for the lifetime of this lease, including any explicit port override.
  const lockEnvironment = { ...process.env };
  lockPortFor('configuration-check', lockEnvironment);
  const servers = new Map<number, Server>(); let queue: Promise<void> = Promise.resolve(), closing = false, releasing: Promise<void> | undefined;
  const lease: OwnerLease = {
    claim(directories, waitMs = 0, claimOptions = {}) {
      if (!Number.isFinite(waitMs) || waitMs < 0) return Promise.reject(new RangeError('锁等待时间必须是非负有限数字'));
      if (closing) return Promise.reject(new Error('应用所有权已释放或正在释放'));
      const next = queue.then(async () => {
        if (closing) throw new Error('应用所有权已释放或正在释放');
        signal?.throwIfAborted();
        const targets = new Map<number, LockTarget>();
        for (const directory of directories) {
          const target = await targetFor(directory, claimOptions.existingOnly, lockEnvironment);
          if (!servers.has(target.port)) targets.set(target.port, target);
        }
        const acquired = new Map<number, Server>(), deadline = Date.now() + waitMs;
        try {
          for (const target of [...targets.values()].sort((a, b) => a.port - b.port)) {
            for (;;) {
              signal?.throwIfAborted();
              const server = await bind(target, owner);
              if (server) { acquired.set(target.port, server); signal?.throwIfAborted(); break; }
              if (Date.now() >= deadline) throw new BusyError(await inspectOwner(target.port), target.path);
              await delay(Math.min(75, Math.max(1, deadline - Date.now())), signal);
            }
          }
          for (const [port, server] of acquired) servers.set(port, server);
        } catch (error) { await Promise.allSettled([...acquired.values()].map(close)); throw error; }
      });
      queue = next.catch(() => {}); return next;
    },
    release() {
      if (releasing) return releasing;
      closing = true;
      return releasing = (async () => {
        await queue;
        const results = await Promise.allSettled([...servers.values()].map(close)); servers.clear();
        const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
      })();
    },
  };
  try { await lease.claim(dirs, timeoutMs); return lease; }
  catch (error) { await lease.release(); throw error; }
}

/** Compatibility entry point: old CLI callers participate in exactly the same listener protocol. */
export async function acquireOwner(dirs: string[], command: string, timeoutMs: number, options: { signal?: AbortSignal } = {}): Promise<() => Promise<void>> {
  const lease = await acquireOwnerLease(dirs, command, timeoutMs, options);
  return () => lease.release();
}
