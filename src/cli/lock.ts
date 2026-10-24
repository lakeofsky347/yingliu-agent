import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** C01: single data owner per profile. Every CLI command that opens the application holds an exclusive, cross-process
 *  owner lock on the data directory and the projects directory for its whole lifetime. Another process waits up to
 *  `timeoutMs` and then fails with an explicit BUSY error naming the owner. A lock left by a dead process on this host
 *  is reclaimed. (Chosen over a resident service: no daemon to manage; long `agent run` commands simply own the profile.) */
export const LOCK_NAME = '.yingliu-owner.lock';
export interface LockOwner { pid: number; host: string; startedAt: string; command: string }
export class BusyError extends Error { constructor(public owner: LockOwner | undefined, public path: string) { super(`数据目录正被另一个 yingliu 进程占用（${owner ? `pid ${owner.pid}，命令 ${owner.command}，开始于 ${owner.startedAt}` : '未知进程'}）：${path}；请等待其结束，或用 --lock-timeout <秒> 延长等待`); } }

function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }
async function readOwner(file: string): Promise<LockOwner | undefined> { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; } }

async function acquireOne(dir: string, owner: LockOwner, deadline: number): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true }); const file = join(dir, LOCK_NAME);
  for (;;) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(owner)); } finally { await handle.close(); }
      return async () => { const current = await readOwner(file); if (current?.pid === owner.pid && current.startedAt === owner.startedAt) await unlink(file).catch(() => {}); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await readOwner(file);
      // stale: same host, process gone (a half-written lock older than a moment is also stale)
      if (current && current.host === owner.host && !alive(current.pid)) { await unlink(file).catch(() => {}); continue; }
      if (Date.now() >= deadline) throw new BusyError(current, dir);
      await new Promise(r => setTimeout(r, 50 + Math.random() * 50));
    }
  }
}
const held = new Set<() => Promise<void>>();
let hooked = false;
export async function acquireOwner(dirs: string[], command: string, timeoutMs: number): Promise<() => Promise<void>> {
  const owner: LockOwner = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() + '#' + Math.random().toString(36).slice(2), command };
  const deadline = Date.now() + Math.max(0, timeoutMs), releases: (() => Promise<void>)[] = [];
  try { for (const dir of [...new Set(dirs)].sort()) releases.push(await acquireOne(dir, owner, deadline)); }
  catch (error) { for (const r of releases.reverse()) await r(); throw error; }
  const release = async () => { held.delete(release); for (const r of releases.reverse()) await r(); };
  held.add(release);
  if (!hooked) { hooked = true; for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void Promise.all([...held].map(r => r())).finally(() => process.exit(130)); }); }
  return release;
}
