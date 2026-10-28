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

interface LockTarget { path: string; key: string; ports: number[] }
const HOST = '127.0.0.1', BANNER = 'yingliu-owner-v2 ', LEGACY_BANNER = 'yingliu-owner-v1 ', BANNER_PREFIX = 'yingliu-owner-';
/** Primary port plus fallbacks. A different profile on an earlier slot is skipped, never taken over. */
export const LOCK_SLOTS = 4;

/** Directory identity also unifies symlink/case aliases. Bigints preserve Windows file IDs. */
async function targetFor(directory: string, existingOnly = false, environment: NodeJS.ProcessEnv = process.env): Promise<LockTarget> {
  if (!existingOnly) await mkdir(directory, { recursive: true });
  const path = await realpath(directory), info = await stat(path, { bigint: true });
  if (!info.isDirectory()) throw new Error('工程锁目标不是目录：' + path);
  // Some filesystems do not expose a file ID. The canonical path is a conservative fallback.
  const identity = info.ino !== 0n ? `${info.dev}:${info.ino}` : (process.platform === 'win32' ? path.toLowerCase() : path);
  const ports = lockPortsFor(identity, environment);
  // With YINGLIU_LOCK_PORT every directory shares one profile-wide key, so any other holder is the same owner (BUSY).
  const key = overridePort(environment) !== undefined ? 'port:' + ports[0] : identity;
  return { path, key: createHash('sha256').update('yingliu-owner-key\0' + key).digest('hex').slice(0, 32), ports };
}

/** Outside every common ephemeral range (Linux 32768-60999, Windows/macOS/IANA 49152-65535), so outgoing connections never
 *  squat a lock port. YINGLIU_LOCK_PORT pins one port for all directories (profile-wide lock). */
export const LOCK_PORT_RANGE = { min: 21000, max: 28999 } as const;
function overridePort(env: NodeJS.ProcessEnv): number | undefined {
  const override = env.YINGLIU_LOCK_PORT;
  if (override === undefined || override === '') return undefined;
  if (!/^\d+$/.test(override) || Number(override) < 1024 || Number(override) > 65535) throw new LockConfigError('YINGLIU_LOCK_PORT 必须是 1024-65535 之间的整数');
  return Number(override);
}
function slotPort(identity: string, slot: number): number {
  const hash = createHash('sha256').update('yingliu-owner-v1\0' + identity + (slot ? '\0' + slot : '')).digest();
  return LOCK_PORT_RANGE.min + hash.readUInt32BE(0) % (LOCK_PORT_RANGE.max - LOCK_PORT_RANGE.min + 1);
}
/** Primary port (unchanged from v1, so old and new processes meet on it). */
export function lockPortFor(identity: string, env: NodeJS.ProcessEnv = process.env): number {
  return overridePort(env) ?? slotPort(identity, 0);
}
export function lockPortsFor(identity: string, env: NodeJS.ProcessEnv = process.env): number[] {
  const override = overridePort(env); if (override !== undefined) return [override];
  const ports: number[] = [];
  for (let slot = 0; ports.length < LOCK_SLOTS && slot < LOCK_SLOTS * 4; slot++) { const port = slotPort(identity, slot); if (!ports.includes(port)) ports.push(port); }
  return ports;
}

type SlotState = { state: 'acquiring' | 'owner' };
/** Binding is the authority; the banner only says WHICH profile a bound port belongs to. */
function bind(port: number, owner: LockOwner, key: string, slot: SlotState): Promise<Server | undefined> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket); socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      socket.setTimeout(500, () => socket.destroy());
      socket.end(BANNER + JSON.stringify({ ...owner, key, state: slot.state }) + '\n');
    });
    server.maxConnections = 32;
    // A diagnostic client cannot keep a release pending indefinitely.
    server.on('yingliu-release', () => { for (const socket of sockets) socket.destroy(); });
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(undefined); else reject(error);
    });
    server.listen({ host: HOST, port, exclusive: true }, () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.emit('yingliu-release');
    server.close(error => error ? reject(error) : resolve());
  });
}

/** free: nobody listens. other: provably not a yingliu owner of this key (another profile, or a service speaking something else).
 *  same: a yingliu owner of this key. unknown: silent/old-protocol/unreadable, treated conservatively as BUSY. */
type Peer = { kind: 'free' } | { kind: 'other' } | { kind: 'same'; owner: LockOwner; state: 'acquiring' | 'owner' } | { kind: 'unknown'; owner?: LockOwner };
function validOwner(value: Record<string, unknown>): LockOwner | undefined {
  return Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.host === 'string' && typeof value.startedAt === 'string' && typeof value.command === 'string'
    ? { pid: value.pid as number, host: value.host, startedAt: value.startedAt, command: value.command } : undefined;
}
function inspectPeer(port: number, key: string, primary: boolean): Promise<Peer> {
  return new Promise(resolve => {
    let bytes = '', settled = false;
    const socket = createConnection({ host: HOST, port });
    const finish = (peer: Peer) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(peer); };
    const timer = setTimeout(() => finish({ kind: 'unknown' }), 400);
    socket.on('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED' ? { kind: 'free' } : { kind: 'unknown' }));
    socket.on('end', () => finish({ kind: 'unknown' }));
    socket.on('data', chunk => {
      bytes += chunk.toString();
      // Anything that is not (a prefix of) our banner cannot be a yingliu owner.
      if (!bytes.startsWith(BANNER_PREFIX) && !BANNER_PREFIX.startsWith(bytes)) return finish({ kind: 'other' });
      if (bytes.length > 4096) return finish({ kind: 'unknown' });
      if (!bytes.includes('\n')) return;
      try {
        const line = bytes.split('\n')[0]!;
        // A v1 process only ever binds its own primary port, so on a fallback slot it is necessarily another profile.
        if (line.startsWith(LEGACY_BANNER)) return finish(primary ? { kind: 'unknown', owner: validOwner(JSON.parse(line.slice(LEGACY_BANNER.length))) } : { kind: 'other' });
        if (!line.startsWith(BANNER)) return finish({ kind: 'unknown' });
        const value = JSON.parse(line.slice(BANNER.length)), owner = validOwner(value);
        if (!owner || typeof value.key !== 'string' || (value.state !== 'acquiring' && value.state !== 'owner')) return finish({ kind: 'unknown', owner });
        finish(value.key === key ? { kind: 'same', owner, state: value.state } : { kind: 'other' });
      } catch { finish({ kind: 'unknown' }); }
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
 * One attempt to own target.key. Invariant: an owner holds slot i while every earlier slot is held by another profile and no
 * later slot holds this key. Each contender binds BEFORE it checks, so of two racing contenders at least one sees the other:
 * the later-slot contender yields to an earlier-slot one; an earlier-slot contender waits for a later one still deciding.
 */
async function attempt(target: LockTarget, owner: LockOwner, signal?: AbortSignal): Promise<{ server: Server } | { owner?: LockOwner; retry?: boolean }> {
  const { ports, key } = target;
  for (let index = 0; index < ports.length; index++) {
    signal?.throwIfAborted();
    const slot: SlotState = { state: 'acquiring' };
    const server = await bind(ports[index]!, owner, key, slot);
    if (!server) {
      const peer = await inspectPeer(ports[index]!, key, index === 0);
      if (peer.kind === 'other') continue;
      if (peer.kind === 'free') return { retry: true };
      return { owner: peer.owner };
    }
    const yieldWith = async (result: { owner?: LockOwner; retry?: boolean }) => { await close(server); return result; };
    for (let earlier = 0; earlier < index; earlier++) {
      const peer = await inspectPeer(ports[earlier]!, key, earlier === 0);
      if (peer.kind === 'free') return yieldWith({ retry: true });
      if (peer.kind !== 'other') return yieldWith({ owner: peer.kind === 'same' || peer.kind === 'unknown' ? peer.owner : undefined });
    }
    for (let later = index + 1; later < ports.length; later++) {
      const settleBy = Date.now() + 3000;
      for (;;) {
        const peer = await inspectPeer(ports[later]!, key, false);
        if (peer.kind === 'free' || peer.kind === 'other') break;
        // A later-slot contender decides from earlier slots only, so it settles promptly; never wait on an established owner.
        // Silent holders get the same grace period before the conservative BUSY.
        if (((peer.kind === 'same' && peer.state === 'acquiring') || peer.kind === 'unknown') && Date.now() < settleBy) { await delay(20, signal).catch(async error => { await close(server); throw error; }); continue; }
        return yieldWith({ owner: peer.owner });
      }
    }
    slot.state = 'owner';
    return { server };
  }
  return {}; // Every slot is held by other profiles: conservative BUSY, never a takeover.
}

/**
 * Same-host, cross-process exclusion with an OS-owned TCP listener. Process death releases it even if no JS cleanup runs.
 * We never read/check/unlink a lock file to take over. A port held by another profile (v2 banner with a different key) or a
 * non-yingliu service that speaks first is skipped for the next slot; silent or v1 holders stay a conservative BUSY.
 * The signal cancels acquisition only; callers must drain their application before releasing an acquired owner.
 */
export async function acquireOwnerLease(dirs: string[], command: string, timeoutMs: number, options: { signal?: AbortSignal } = {}): Promise<OwnerLease> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('锁等待时间必须是非负有限数字');
  const signal = options.signal; signal?.throwIfAborted();
  const owner: LockOwner = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), command };
  // Capture the configured protocol for the lifetime of this lease, including any explicit port override.
  const lockEnvironment = { ...process.env };
  lockPortFor('configuration-check', lockEnvironment);
  const servers = new Map<string, Server>(); let queue: Promise<void> = Promise.resolve(), closing = false, releasing: Promise<void> | undefined;
  const lease: OwnerLease = {
    claim(directories, waitMs = 0, claimOptions = {}) {
      if (!Number.isFinite(waitMs) || waitMs < 0) return Promise.reject(new RangeError('锁等待时间必须是非负有限数字'));
      if (closing) return Promise.reject(new Error('应用所有权已释放或正在释放'));
      const next = queue.then(async () => {
        if (closing) throw new Error('应用所有权已释放或正在释放');
        signal?.throwIfAborted();
        const targets = new Map<string, LockTarget>();
        for (const directory of directories) {
          const target = await targetFor(directory, claimOptions.existingOnly, lockEnvironment);
          if (!servers.has(target.key)) targets.set(target.key, target);
        }
        const acquired = new Map<string, Server>(), deadline = Date.now() + waitMs;
        try {
          for (const target of [...targets.values()].sort((a, b) => a.ports[0]! - b.ports[0]! || a.key.localeCompare(b.key))) {
            for (let retries = 0; ;) {
              signal?.throwIfAborted();
              const result = await attempt(target, owner, signal);
              if ('server' in result) { acquired.set(target.key, result.server); signal?.throwIfAborted(); break; }
              if (result.retry && retries++ < 20) continue; // A holder left between bind and inspect.
              if (Date.now() >= deadline) throw new BusyError(result.owner, target.path);
              await delay(Math.min(75, Math.max(1, deadline - Date.now())), signal);
            }
          }
          for (const [key, server] of acquired) servers.set(key, server);
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
