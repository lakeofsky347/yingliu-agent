import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { acquireOwner, BusyError, LOCK_NAME } from '../src/cli/lock.ts';
import { installCliLifecycle } from '../src/cli/lifecycle.ts';

const fixture = join(import.meta.dirname, 'fixtures', 'cli-owner-child.ts');
function child(mode: string, dir: string, events: string, ms = 30) {
  const process = spawn(globalThis.process.execPath, ['--import', 'tsx', fixture, mode, dir, events, String(ms)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', errors = '';
  process.stdout!.on('data', bytes => output += bytes.toString()); process.stderr!.on('data', bytes => errors += bytes.toString());
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => process.once('close', (code, signal) => resolve({ code, signal })));
  const ready = async (): Promise<{ ownedPid?: number }> => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const line = output.split('\n').find(line => line.includes('"event":"ready"'));
      if (line) return JSON.parse(line);
      if (process.exitCode !== null || process.signalCode !== null) throw new Error('fixture exited: ' + errors);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('fixture timeout: ' + errors);
  };
  return { process, closed, ready, errors: () => errors };
}
async function stop(process: ChildProcess) { if (process.exitCode !== null || process.signalCode !== null) return; const ended = once(process, 'close'); process.kill('SIGKILL'); await ended; }
async function temporary() { const dir = await mkdtemp(join(tmpdir(), 'yingliu-owner-')); return { dir, events: join(dir, 'events.jsonl'), async close() { await rm(dir, { recursive: true, force: true }); } }; }

test('R2-02: real subprocesses never overlap the same profile critical section', { timeout: 20000 }, async () => {
  const f = await temporary(); const children: ReturnType<typeof child>[] = [];
  try {
    for (let i = 0; i < 8; i++) children.push(child('critical', join(f.dir, 'profile'), f.events, 45));
    for (const c of children) { const status = await c.closed; assert.equal(status.code, 0, c.errors()); }
    const events = (await readFile(f.events, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    let active = 0;
    for (const event of events) { active += event.event === 'enter' ? 1 : -1; assert.ok(active === 0 || active === 1, 'overlap: ' + JSON.stringify(events)); }
    assert.equal(active, 0); assert.equal(events.length, 16);
  } finally { await Promise.all(children.map(c => stop(c.process))); await f.close(); }
});

test('R2-04: empty/corrupt legacy metadata is irrelevant, and killed ownership is immediately recoverable', { timeout: 15000 }, async () => {
  const f = await temporary(); let holder: ReturnType<typeof child> | undefined;
  try {
    const dir = join(f.dir, 'profile'); await mkdir(dir); const file = join(dir, LOCK_NAME);
    for (const metadata of ['', '{"pid":']) {
      await writeFile(file, metadata);
      holder = child('hold', dir, f.events); await holder.ready();
      await assert.rejects(acquireOwner([dir], 'contender', 0), error => error instanceof BusyError && error.owner?.pid === holder!.process.pid);
      await stop(holder.process); holder = undefined;
      const release = await acquireOwner([dir], 'after-crash', 1000); await Promise.all([release(), release()]);
      assert.equal(await readFile(file, 'utf8'), metadata, 'metadata is never deleted to take over');
    }
  } finally { if (holder) await stop(holder.process); await f.close(); }
});

test('R2-02: directory aliases share ownership and aborted waiters cannot release the owner', async () => {
  const f = await temporary(); let release: (() => Promise<void>) | undefined;
  try {
    const actual = join(f.dir, 'actual'), alias = join(f.dir, 'alias'); await mkdir(actual);
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    release = await acquireOwner([actual, alias], 'alias-owner', 1000);
    const abort = new AbortController(); const waiting = acquireOwner([alias], 'waiter', 10000, { signal: abort.signal });
    setTimeout(() => abort.abort(new Error('cancel waiter')), 30);
    await assert.rejects(waiting, /cancel waiter/);
    await assert.rejects(acquireOwner([actual], 'still-busy', 0), BusyError);
    await release(); release = undefined;
    const next = await acquireOwner([alias], 'next', 500); await next();
  } finally { await release?.(); await f.close(); }
});

test('R2-05: a signal drains the owned child before releasing the profile (real SIGTERM on POSIX)', { timeout: 15000 }, async () => {
  const f = await temporary(); let holder: ReturnType<typeof child> | undefined, ownedPid: number | undefined;
  try {
    const dir = join(f.dir, 'profile'); holder = child('lifecycle', dir, f.events); ownedPid = (await holder.ready()).ownedPid;
    if (process.platform === 'win32') holder.process.send!({ interrupt: true }); else holder.process.kill('SIGTERM');
    const until = Date.now() + 5000;
    while (Date.now() < until) { if ((await readFile(f.events, 'utf8').catch(() => '')).includes('dispose-start')) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    await assert.rejects(acquireOwner([dir], 'during-dispose', 0), BusyError);
    const exited = await holder.closed; assert.equal(exited.code, 143, holder.errors());
    const order = (await readFile(f.events, 'utf8')).trim().split('\n').map(line => JSON.parse(line).event);
    assert.deepEqual(order, ['dispose-start', 'dispose-end', 'release']);
    if (ownedPid) assert.throws(() => process.kill(ownedPid!, 0), 'owned child must be gone');
    const next = await acquireOwner([dir], 'after-shutdown', 1000); await next();
  } finally {
    if (holder) await stop(holder.process);
    if (ownedPid) { try { process.kill(ownedPid, 'SIGKILL'); } catch { /* already reaped */ } }
    await f.close();
  }
});

test('R2-05: cleanup is idempotent, keeps handlers while draining, and removes them even on cleanup error', async () => {
  const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
  const lifecycle = installCliLifecycle(), order: string[] = [];
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm + 1);
  const dispose = async () => { order.push('dispose'); await new Promise(resolve => setTimeout(resolve, 5)); throw new Error('synthetic cleanup error'); };
  const release = async () => { order.push('release'); };
  const first = lifecycle.shutdown(dispose, release), second = lifecycle.shutdown(dispose, release);
  assert.equal(first, second); await assert.rejects(first, /synthetic cleanup error/);
  assert.deepEqual(order, ['dispose', 'release']);
  assert.equal(process.listenerCount('SIGINT'), beforeInt); assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
});
