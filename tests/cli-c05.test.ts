import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT } from '../src/cli/main.ts';
import { cli, withCliEnv } from './cli-helpers.ts';

test('C05: models add derives modality and default role from the protocol (images/image, video-gateway/video, speech/speech)', () => withCliEnv(async () => {
  const cases = [['images', 'image', 'image'], ['video-gateway', 'video', 'video'], ['speech', 'audio', 'speech'], ['chat-completions', 'text', 'director']] as const;
  for (const [protocol, output, role] of cases) {
    const r = await cli(['models', 'add', '--name', protocol, '--protocol', protocol, '--base-url', 'http://example.invalid/v1', '--model', 'm-' + protocol]);
    assert.equal(r.code, 0, protocol + ' ' + r.out); assert.equal(r.json.data.role, role);
    const list = (await cli(['models', 'list'])).json.data;
    const model = list.models.find((m: { id: string }) => m.id === r.json.data.modelId); assert.deepEqual(model.outputModalities, [output], protocol);
    assert.equal(list.roles.find((b: { role: string }) => b.role === role)?.modelId, r.json.data.modelId);
  }
  // async-task requires an explicit role or output modality
  const music = await cli(['models', 'add', '--name', 'mu', '--protocol', 'async-task', '--base-url', 'http://example.invalid/v1', '--model', 'meta/musicgen', '--role', 'music']);
  assert.equal(music.code, 0, music.out);
  assert.deepEqual((await cli(['models', 'list'])).json.data.models.find((m: { id: string }) => m.id === music.json.data.modelId).outputModalities, ['audio']);
}));

test('C05: an incompatible or invalid request is rejected by precheck and leaves no residue', () => withCliEnv(async () => {
  const snapshot = async () => { const l = (await cli(['models', 'list'])).json.data; return JSON.stringify({ c: l.connections.length, m: l.models.length, r: l.roles }); };
  const keyFile = join(process.env.YINGLIU_DATA_DIR!, 'cli-key-env.json');
  process.env.C05_KEY = 'sk-test';
  try {
    const before = await snapshot();
    for (const extra of [['--protocol', 'images', '--role', 'director'], ['--protocol', 'chat-completions', '--role', 'bogus'], ['--protocol', 'async-task'], ['--protocol', 'nope'], ['--protocol', 'speech', '--output-modality', 'video']]) {
      const r = await cli(['models', 'add', '--name', 'x', '--base-url', 'http://example.invalid/v1', '--model', 'm', '--api-key-env', 'C05_KEY', ...extra]);
      assert.equal(r.code, EXIT.USAGE, extra.join(' ') + ' ' + r.out);
      assert.equal(await snapshot(), before, 'no residue after ' + extra.join(' '));
      assert.equal(await readFile(keyFile, 'utf8').catch(() => '{}').then(t => Object.keys(JSON.parse(t)).length), 0, 'no key binding residue');
    }
  } finally { delete process.env.C05_KEY; }
}));
