import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT } from '../src/cli/main.ts';
import { detectEnvironment } from '../src/host/renderer.ts';
import { cli, withCliEnv } from './cli-helpers.ts';

const env = detectEnvironment({}); const canExport = env.browserAvailable && env.ffmpegAvailable;
const paid = ['--auto-approve', 'read,write,plan,export', '--allow-paid', '--max-cost', '1', '--mock', '--max-review-rounds', '0'];

test('C04: an agent run whose export task fails exits 7 with ok:false (run result merged with its task result)', { skip: !canExport && '需要 Chromium 与 ffmpeg' }, () => withCliEnv(async () => {
  const p = await cli(['project', 'create', '--title', 'bad export', '--mock']); assert.equal(p.code, 0, p.out);
  await writeFile(join(p.json.data.root, 'exports'), 'not a directory'); // export cannot create its output directory
  const r = await cli(['agent', 'run', '--project', p.json.data.id, '--goal', 'g', ...paid]);
  assert.equal(r.code, EXIT.RUN_FAILED, r.out); assert.equal(r.json.ok, false); assert.equal(r.json.error.code, 'RUN_FAILED');
  assert.equal(r.json.error.task.kind, 'export'); assert.match(r.json.error.task.status, /failed|cancelled/); assert.ok(r.json.error.run.id);
}));

test('C04: a successful export run returns the output path', { skip: !canExport && '需要 Chromium 与 ffmpeg' }, () => withCliEnv(async () => {
  const p = await cli(['project', 'create', '--title', 'good export', '--mock']);
  const r = await cli(['agent', 'run', '--project', p.json.data.id, '--goal', 'g', ...paid]);
  assert.equal(r.code, EXIT.OK, r.out); assert.equal(r.json.data.status, 'complete'); assert.equal(r.json.data.task.status, 'complete');
  assert.ok(r.json.data.output?.path, 'output path returned'); assert.ok((await stat(r.json.data.output.path)).size > 0);
}));
