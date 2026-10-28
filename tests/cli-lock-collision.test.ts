import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireOwner, acquireOwnerLease, BusyError, lockPortFor } from '../src/cli/lock.ts';
import { EXIT } from '../src/cli/main.ts';
import { cli } from './cli-helpers.ts';

/** Mirror targetFor's directory identity so the fixture uses the real derived port, not a test seam. */
async function primaryPort(directory: string) {
  const canonical = await realpath(directory), info = await stat(canonical, { bigint: true });
  return lockPortFor(info.ino !== 0n ? `${info.dev}:${info.ino}` : process.platform === 'win32' ? canonical.toLowerCase() : canonical, {});
}
async function portFree(port: number) {
  const probe = createServer();
  const free = await new Promise<boolean>((resolve, reject) => {
    probe.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(true));
  });
  if (free) await new Promise<void>(resolve => probe.close(() => resolve()));
  return free;
}
/** Two real directories (different profiles) whose identities hash to the same primary lock port (birthday search). */
async function collidingPair(root: string) {
  const seen = new Map<number, string>();
  for (let index = 0; index < 4000; index++) {
    const directory = join(root, 'd' + index); await mkdir(directory);
    const port = await primaryPort(directory), other = seen.get(port);
    if (other && await portFree(port)) return { first: other, second: directory, port };
    seen.set(port, directory);
  }
  throw new Error('no colliding directory pair found');
}
const withoutOverride = async <T>(body: () => Promise<T>) => {
  const previous = process.env.YINGLIU_LOCK_PORT; delete process.env.YINGLIU_LOCK_PORT;
  try { return await body(); } finally { if (previous !== undefined) process.env.YINGLIU_LOCK_PORT = previous; }
};

test('C01c: a different profile hashing to the same lock port is not a false BUSY; the same profile still is', { timeout: 60_000 }, () => withoutOverride(async () => {
  const root = await mkdtemp(join(tmpdir(), 'yingliu-lock-collision-'));
  try {
    const { first, second } = await collidingPair(root);
    const a = await acquireOwnerLease([first], 'owner-a', 0);
    const b = await acquireOwnerLease([second], 'owner-b', 0).catch(async error => { await a.release(); throw error; });
    try {
    await assert.rejects(acquireOwner([second], 'same-as-b', 0), (error: unknown) => error instanceof BusyError && error.owner?.command === 'owner-b');
    await assert.rejects(acquireOwner([first], 'same-as-a', 0), (error: unknown) => error instanceof BusyError && error.owner?.command === 'owner-a');
    // The colliding owner of the primary port leaves; B still owns its profile from the fallback port.
    await a.release();
    await assert.rejects(acquireOwner([second], 'after-a-left', 0), (error: unknown) => error instanceof BusyError && error.owner?.command === 'owner-b');
    const again = await acquireOwner([first], 'a-again', 0); await again();
    await b.release();
    const late = await acquireOwner([second], 'b-after-release', 0); await late();
    // One lease that claims both colliding roots owns both.
    const both = await acquireOwnerLease([first, second], 'both', 0);
    await assert.rejects(acquireOwner([second], 'other', 0), BusyError); await assert.rejects(acquireOwner([first], 'other', 0), BusyError);
    await both.release();
    } finally { await a.release(); await b.release(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}));

test('C01c: racing owners of a colliding profile never overlap while the colliding owner comes and goes', { timeout: 60_000 }, () => withoutOverride(async () => {
  const root = await mkdtemp(join(tmpdir(), 'yingliu-lock-race-'));
  try {
    const { first, second } = await collidingPair(root);
    for (let round = 0; round < 4; round++) {
      let live = 0, peak = 0, wins = 0;
      const foreign = await acquireOwnerLease([first], 'foreign-' + round, 0);
      const contenders = Array.from({ length: 6 }, async (_, index) => {
        await new Promise(resolve => setTimeout(resolve, index * 7));
        const lease = await acquireOwnerLease([second], 'contender-' + index, 8000);
        live++; peak = Math.max(peak, live); wins++;
        await new Promise(resolve => setTimeout(resolve, 20)); live--; await lease.release();
      });
      setTimeout(() => { void foreign.release(); }, 15 + round * 10);
      await Promise.all(contenders); await foreign.release();
      assert.equal(peak, 1, 'two owners of one profile overlapped'); assert.equal(wins, 6);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}));

test('C01c: a legacy v1 owner or a silent listener on the primary port stays a conservative BUSY', { timeout: 30_000 }, () => withoutOverride(async () => {
  const root = await mkdtemp(join(tmpdir(), 'yingliu-lock-legacy-'));
  const directory = join(root, 'p'); await mkdir(directory);
  const port = await primaryPort(directory);
  for (const reply of ['yingliu-owner-v1 ' + JSON.stringify({ pid: 4242, host: 'h', startedAt: 'now', command: 'old-cli' }) + '\n', undefined]) {
    const legacy = createServer(socket => { if (reply) socket.end(reply); });
    await new Promise<void>((resolve, reject) => { legacy.once('error', reject); legacy.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
    try { await assert.rejects(acquireOwner([directory], 'new-cli', 0), BusyError); }
    finally { await new Promise<void>(resolve => legacy.close(() => resolve())); }
  }
  const release = await acquireOwner([directory], 'new-cli', 0); await release();
  await rm(root, { recursive: true, force: true });
}));

test('C01c: the CLI on a colliding data directory runs instead of exiting BUSY (9)', { timeout: 60_000 }, () => withoutOverride(async () => {
  const root = await mkdtemp(join(tmpdir(), 'yingliu-lock-cli-'));
  const saved = { data: process.env.YINGLIU_DATA_DIR, projects: process.env.YINGLIU_PROJECTS };
  try {
    const { first, second } = await collidingPair(root);
    const other = await acquireOwnerLease([first], 'other-profile', 0);
    try {
      process.env.YINGLIU_DATA_DIR = second; process.env.YINGLIU_PROJECTS = join(root, 'projects');
      const result = await cli(['project', 'list', '--lock-timeout', '0']);
      assert.equal(result.code, EXIT.OK, result.out);
    } finally { await other.release(); }
  } finally {
    if (saved.data === undefined) delete process.env.YINGLIU_DATA_DIR; else process.env.YINGLIU_DATA_DIR = saved.data;
    if (saved.projects === undefined) delete process.env.YINGLIU_PROJECTS; else process.env.YINGLIU_PROJECTS = saved.projects;
    await rm(root, { recursive: true, force: true });
  }
}));
