import { createHash } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { hostname } from 'node:os';

/** Legacy filename: existing empty or half-written files are never ownership evidence. */
export const LOCK_NAME = '.yingliu-owner.lock';
export interface LockOwner { pid: number; host: string; startedAt: string; command: string }
export class BusyError extends Error {
  constructor(public owner: LockOwner | undefined, public path: string) {
    super(`数据目录正被另一个 yingliu 进程或本机端口占用（${owner ? `pid ${owner.pid}，命令 ${owner.command}，开始于 ${owner.startedAt}` : '未知占用者；为保护工程不会接管'}）：${path}；请等待其结束，或用 --lock-timeout <秒> 延长等待`);
  }
}

interface LockTarget { path: string; identity: string; port: number }
const HOST = '127.0.0.1', BANNER = 'yingliu-owner-v1 ';

/** Directory identity also unifies symlink/case aliases. Bigints preserve Windows file IDs. */
async function targetFor(directory: string): Promise<LockTarget> {
  await mkdir(directory, { recursive: true });
  const path = await realpath(directory), info = await stat(path, { bigint: true });
  if (!info.isDirectory()) throw new Error('工程锁目标不是目录：' + path);
  // Some filesystems do not expose a file ID. The canonical path is a conservative fallback.
  const identity = info.ino !== 0n ? `${info.dev}:${info.ino}` : (process.platform === 'win32' ? path.toLowerCase() : path);
  const hash = createHash('sha256').update('yingliu-owner-v1\0' + identity).digest();
  return { path, identity, port: 49152 + hash.readUInt32BE(0) % 16384 };
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
export async function acquireOwner(dirs: string[], command: string, timeoutMs: number, options: { signal?: AbortSignal } = {}): Promise<() => Promise<void>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('锁等待时间必须是非负有限数字');
  const signal = options.signal; signal?.throwIfAborted();
  const owner: LockOwner = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), command };
  const targets = new Map<string, LockTarget>();
  for (const directory of dirs) { const target = await targetFor(directory); targets.set(target.identity, target); }
  // If two different roots hash to one port they can safely share this command's listener; another command still cannot enter.
  const ports = new Map<number, LockTarget>();
  for (const target of [...targets.values()].sort((a, b) => a.path.localeCompare(b.path))) ports.set(target.port, target);
  const servers: Server[] = [], deadline = Date.now() + timeoutMs;
  try {
    // Port ordering is independent of aliases and directory spelling, avoiding lock-order inversions.
    for (const target of [...ports.values()].sort((a, b) => a.port - b.port)) {
      for (;;) {
        signal?.throwIfAborted();
        const server = await bind(target, owner);
        if (server) { servers.push(server); signal?.throwIfAborted(); break; }
        if (Date.now() >= deadline) throw new BusyError(await inspectOwner(target.port), target.path);
        await delay(Math.min(75, Math.max(1, deadline - Date.now())), signal);
      }
    }
  } catch (error) { await Promise.allSettled(servers.map(close)); throw error; }
  let releasing: Promise<void> | undefined;
  return () => releasing ??= (async () => { const results = await Promise.allSettled(servers.map(close)); const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason; })();
}
