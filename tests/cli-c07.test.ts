import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT } from '../src/cli/main.ts';
import { cli, withCliEnv } from './cli-helpers.ts';

test('C07: a startup failure (data directory cannot be created) emits exactly one ok:false JSON line with a stable code', () => withCliEnv(async dir => {
  await mkdir(dir, { recursive: true }); const blocker = join(dir, 'file'); await writeFile(blocker, 'x');
  process.env.YINGLIU_DATA_DIR = join(blocker, 'data');
  for (const args of [['project', 'list'], ['project', 'create', '--title', 't', '--mock'], ['agent', 'run', '--project', 'p', '--goal', 'g']]) {
    const r = await cli(args);
    assert.equal(r.lines.length, 1, args.join(' ') + ' => ' + r.out); assert.equal(r.json.ok, false); assert.equal(r.json.error.code, 'STARTUP'); assert.equal(r.code, EXIT.STARTUP);
    assert.match(r.json.error.message, /数据目录|启动/);
  }
}));

test('C07: an application initialisation failure is also a single STARTUP line', () => withCliEnv(async () => {
  const data = process.env.YINGLIU_DATA_DIR!; await mkdir(join(data, 'agent-runs'), { recursive: true });
  await mkdir(join(data, 'workflows'), { recursive: true }); await writeFile(join(data, 'workflows', 'w1.json'), '{broken');
  await writeFile(join(data, 'model-registry.json'), '{broken'); // registry state unreadable
  const r = await cli(['project', 'list']);
  assert.equal(r.lines.length, 1, r.out); assert.equal(r.json.ok, false); assert.equal(r.json.error.code, 'STARTUP'); assert.equal(r.code, EXIT.STARTUP);
}));
