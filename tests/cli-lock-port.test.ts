import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireOwner, BusyError, lockPortFor, LOCK_PORT_RANGE } from '../src/cli/lock.ts';

test('C01b: derived lock ports stay outside every OS ephemeral range (Linux 32768-60999, Windows/macOS 49152-65535)', () => {
  assert.ok(LOCK_PORT_RANGE.min >= 1024 && LOCK_PORT_RANGE.max < 32768);
  for (let i = 0; i < 2000; i++) {
    const port = lockPortFor('dev:' + i, {});
    assert.ok(port >= LOCK_PORT_RANGE.min && port <= LOCK_PORT_RANGE.max, String(port));
  }
});

test('C01b: YINGLIU_LOCK_PORT overrides the derived port; invalid values are rejected', () => {
  assert.equal(lockPortFor('a', { YINGLIU_LOCK_PORT: '23456' }), 23456);
  assert.equal(lockPortFor('b', { YINGLIU_LOCK_PORT: '23456' }), 23456);
  for (const bad of ['0', '80', '70000', 'abc', '1.5']) assert.throws(() => lockPortFor('a', { YINGLIU_LOCK_PORT: bad }), /YINGLIU_LOCK_PORT/);
});

test('C01b: with YINGLIU_LOCK_PORT a foreign listener yields BUSY and a free port is acquired and released', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yingliu-lockport-'));
  const foreign = createServer(); await new Promise<void>(r => foreign.listen({ host: '127.0.0.1', port: 0 }, () => r()));
  const busyPort = (foreign.address() as { port: number }).port;
  const previous = process.env.YINGLIU_LOCK_PORT;
  try {
    process.env.YINGLIU_LOCK_PORT = String(busyPort);
    await assert.rejects(acquireOwner([dir], 't', 100), BusyError);
    await new Promise<void>(r => foreign.close(() => r()));
    const release = await acquireOwner([dir], 't', 1000); await release();
  } finally { if (previous === undefined) delete process.env.YINGLIU_LOCK_PORT; else process.env.YINGLIU_LOCK_PORT = previous; foreign.close(); await rm(dir, { recursive: true, force: true }); }
});
