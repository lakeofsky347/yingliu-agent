import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, EXIT } from '../src/cli/main.ts';
import { LockConfigError, lockPortFor } from '../src/cli/lock.ts';

test('invalid YINGLIU_LOCK_PORT is a CONFIG error (exit 10), not STARTUP', async () => {
  assert.throws(() => lockPortFor('a', { YINGLIU_LOCK_PORT: 'abc' }), LockConfigError);
  const dir = await mkdtemp(join(tmpdir(), 'yingliu-lockcfg-'));
  const saved = { d: process.env.YINGLIU_DATA_DIR, p: process.env.YINGLIU_PROJECTS, l: process.env.YINGLIU_LOCK_PORT };
  try {
    process.env.YINGLIU_DATA_DIR = join(dir, 'data'); process.env.YINGLIU_PROJECTS = join(dir, 'projects');
    for (const bad of ['abc', '80', '70000']) {
      process.env.YINGLIU_LOCK_PORT = bad; let out = '';
      const code = await runCli(['project', 'list', '--json'], { out: s => { out += s; }, err: () => {} });
      assert.equal(code, EXIT.CONFIG, bad + ' ' + out);
      const json = JSON.parse(out.trim()); assert.equal(json.ok, false); assert.equal(json.error.code, 'CONFIG');
    }
  } finally {
    for (const [k, v] of [['YINGLIU_DATA_DIR', saved.d], ['YINGLIU_PROJECTS', saved.p], ['YINGLIU_LOCK_PORT', saved.l]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  }
});
