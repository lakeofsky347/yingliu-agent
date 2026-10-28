import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { EXIT } from '../src/cli/main.ts';
import { acquireOwner, LOCK_PORT_RANGE } from '../src/cli/lock.ts';
import { cli, withCliEnv } from './cli-helpers.ts';

test('C01: parallel creates of different projects in one profile all survive (single data owner via cross-process lock)', () => withCliEnv(async () => {
  // Other test files may legitimately hold a derived root port for a long export.
  // Isolate this serialization fixture while keeping the real listener protocol.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  assert.ok(port > LOCK_PORT_RANGE.max, 'fixture port must be outside the derived lock range');
  const previous = process.env.YINGLIU_LOCK_PORT;
  process.env.YINGLIU_LOCK_PORT = String(port);
  try {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => cli(['project', 'create', '--title', 'P' + i])));
    for (const r of results) assert.equal(r.code, 0, r.out);
    const ids = new Set(results.map(r => r.json.data.id));assert.equal(ids.size, 5);
    const catalog = await cli(['project', 'list']);assert.equal(catalog.code, 0, catalog.out);
    const listed = catalog.json.data.map((p: { id: string }) => p.id);
    for (const id of ids) assert.ok(listed.includes(id), 'missing ' + id + ' in ' + listed.join(','));
  } finally { if (previous === undefined) delete process.env.YINGLIU_LOCK_PORT; else process.env.YINGLIU_LOCK_PORT = previous; }
}));

test('C01: a profile held by a live owner yields an explicit BUSY error after --lock-timeout', () => withCliEnv(async () => {
  const data = process.env.YINGLIU_DATA_DIR!; await mkdir(data, { recursive: true });
  const release = await acquireOwner([data], 'test-holder', 1000);
  try {
    const r = await cli(['project', 'list', '--lock-timeout', '0.3']);
    assert.equal(r.code, EXIT.BUSY, r.out); assert.equal(r.json.ok, false); assert.equal(r.json.error.code, 'BUSY'); assert.match(r.json.error.message, /test-holder|占用/);
  } finally { await release(); }
  // Legacy metadata is diagnostic only; even a half-written file cannot strand an owner.
  await writeFile(join(data, '.yingliu-owner.lock'), '{"pid":');
  assert.equal((await cli(['project', 'list', '--lock-timeout', '0.3'])).code, 0);
}));

test('C01: read-only commands never run recovery (an interrupted run file is left byte-identical)', () => withCliEnv(async () => {
  const created = await cli(['project', 'create', '--title', 'R', '--mock']); const projectId = created.json.data.id;
  const run = await cli(['agent', 'run', '--project', projectId, '--goal', 'g', '--mock', '--max-review-rounds', '0']); assert.equal(run.code, EXIT.NEEDS_APPROVAL, run.out);
  const file = join(process.env.YINGLIU_DATA_DIR!, 'agent-runs', run.json.data.id + '.json');
  const record = JSON.parse(await readFile(file, 'utf8')); record.status = 'running'; await writeFile(file, JSON.stringify(record));
  const before = await readFile(file, 'utf8');
  for (const args of [['agent', 'status', run.json.data.id], ['project', 'list'], ['project', 'get', projectId], ['story', 'show', projectId], ['ledger', 'show', projectId], ['qc', 'show', projectId], ['models', 'list']]) {
    const r = await cli(args); assert.equal(r.code, 0, args.join(' ') + ' ' + r.out);
  }
  assert.equal((await cli(['agent', 'status', run.json.data.id])).json.data.status, 'running', 'status reports the stored state, not a recovered one');
  assert.equal(await readFile(file, 'utf8'), before, 'read-only commands must not rewrite run state');
}));
