import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT } from '../src/cli/main.ts';
import { cli, withCliEnv } from './cli-helpers.ts';

test('C06: a corrupt cli-key-env.json fails loudly and its bytes are preserved; only ENOENT means empty', () => withCliEnv(async () => {
  const data = process.env.YINGLIU_DATA_DIR!; await mkdir(data, { recursive: true });
  const file = join(data, 'cli-key-env.json');
  assert.equal((await cli(['models', 'list'])).code, 0, 'missing file = empty map');
  const corrupt = '{"yingliu.models.a.api-key": "KEEP_ME", oops';
  await writeFile(file, corrupt);
  process.env.C06_KEY = 'sk-test';
  try {
    const add = await cli(['models', 'add', '--name', 'x', '--base-url', 'http://example.invalid/v1', '--model', 'm', '--api-key-env', 'C06_KEY']);
    assert.equal(add.code, EXIT.CONFIG, add.out); assert.equal(add.json.error.code, 'CONFIG'); assert.match(add.json.error.message, /cli-key-env\.json/);
    assert.equal(await readFile(file, 'utf8'), corrupt, 'corrupt bytes preserved');
    const list = await cli(['models', 'list']); assert.equal(list.code, EXIT.CONFIG, list.out);
    assert.equal(await readFile(file, 'utf8'), corrupt);
    // permission error is also a failure, not an empty map (skipped when running as root, where chmod does not restrict)
    if (process.getuid?.() !== 0 && process.platform !== 'win32') {
      await writeFile(file, '{}'); await chmod(file, 0o000);
      try { assert.equal((await cli(['models', 'list'])).code, EXIT.CONFIG); } finally { await chmod(file, 0o600); }
    }
    // writes are atomic: no temp leftovers, valid JSON after a successful bind
    await writeFile(file, '{}');
    const ok = await cli(['models', 'add', '--name', 'y', '--base-url', 'http://example.invalid/v1', '--model', 'm', '--api-key-env', 'C06_KEY']); assert.equal(ok.code, 0, ok.out);
    assert.equal(Object.values(JSON.parse(await readFile(file, 'utf8'))).includes('C06_KEY'), true);
    assert.deepEqual((await readdir(data)).filter(n => n.startsWith('cli-key-env.json.')), []);
  } finally { delete process.env.C06_KEY; }
}));
