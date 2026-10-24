import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeRunResult, EXIT } from '../src/cli/main.ts';
import { VideoRenderer } from '../src/host/renderer.ts';
import { defaultSceneSource } from '../src/core/index.ts';
import { cli, withCliEnv } from './cli-helpers.ts';

const view = { id: 'run', projectId: 'project', status: 'complete' } as Parameters<typeof mergeRunResult>[0];
const failed = { id: 'failed-export', kind: 'export', status: 'failed', error: 'encoder failed' };
const preview = { id: 'preview', kind: 'preview', status: 'complete' };
const output = { id: 'new-output', path: '/fixture/new.mp4' };
const success = { id: 'good-export', kind: 'export', status: 'complete', outputId: output.id };

test('R2-06: failed export survives later successful preview and unrelated project output', () => {
  const result = mergeRunResult(view, [failed, preview], [output]);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.error.task.id, failed.id); assert.equal(result.error.tasks.length, 2); }
});

test('R2-06: output is selected by the export task ID after preview, not the last project output', () => {
  const result = mergeRunResult(view, [success, preview], [output, { id: 'unrelated', path: '/fixture/unrelated.mp4' }]);
  assert.equal(result.ok, true);
  if (result.ok) { assert.deepEqual(result.data.output, output); assert.equal(result.data.task?.id, success.id); }
  const missing = mergeRunResult(view, [success, preview], [{ id: 'unrelated', path: '/fixture/unrelated.mp4' }]);
  assert.equal(missing.ok, false, 'a completed task cannot borrow another export output');
});

test('R2-06: only an explicit successful retry with an output supersedes a failed export chain', () => {
  assert.equal(mergeRunResult(view, [failed, success], [output]).ok, false, 'an independent export is not a retry');
  const second = { id: 'failed-retry', kind: 'export', status: 'cancelled', retryOf: failed.id };
  const retried = { ...success, retryOf: second.id };
  assert.equal(mergeRunResult(view, [failed, second, retried], []).ok, false, 'missing output cannot supersede a failure');
  const result = mergeRunResult(view, [failed, second, retried, preview], [output]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.tasks[0]?.supersededBy, retried.id); assert.equal(result.data.tasks[1]?.supersededBy, retried.id);
    assert.deepEqual(result.data.output, output);
  }
});

// Integration uses real application/services and task journals. Only rendering and the model transport are synthetic.
const original = { preview: VideoRenderer.prototype.preview, assetBaseUrl: VideoRenderer.prototype.assetBaseUrl, audioPreview: VideoRenderer.prototype.audioPreview, check: VideoRenderer.prototype.check, capture: VideoRenderer.prototype.capture, export: VideoRenderer.prototype.export };
before(() => {
  VideoRenderer.prototype.preview = async () => 'http://127.0.0.1:1/index.html';
  VideoRenderer.prototype.assetBaseUrl = async () => 'http://127.0.0.1:1/';
  VideoRenderer.prototype.audioPreview = async () => null;
  VideoRenderer.prototype.check = async () => ({ ok: true, errors: [], frames: [] });
  VideoRenderer.prototype.capture = async () => { throw new Error('fixture: capture deliberately unavailable; export uses force=true'); };
});
after(() => Object.assign(VideoRenderer.prototype, original));

async function scenario(firstFails: boolean, retry: boolean) {
  return withCliEnv(async () => {
    const created = await cli(['project', 'create', '--title', 'task association fixture']);
    assert.equal(created.code, EXIT.OK, created.out); const { id: projectId, root } = created.json.data;
    let exportCalls = 0;
    VideoRenderer.prototype.export = async (root, project) => {
      exportCalls++; if (firstFails && exportCalls === 1) throw new Error('fixture: encoder failed');
      const id = randomUUID(), path = join(root, 'exports', id, 'video.mp4');
      await mkdir(join(root, 'exports', id), { recursive: true }); await writeFile(path, 'synthetic output, not a real MP4');
      return { id, path, createdAt: new Date().toISOString(), revision: project.revision, width: project.target.width, height: project.target.height, frameCount: 1, duration: 1 };
    };
    let turn = 0; const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)); const last = body.messages.at(-1); let name: string | undefined, args: unknown;
      if (turn === 0) { name = 'project_get'; args = {}; }
      else if (turn === 1) {
        const revision = JSON.parse(last.content).revision;
        name = 'video_update'; args = { expectedRevision: revision, update: { storyboard: { shots: [{ title: 'fixture', intent: 'fixture', composition: 'center', action: 'still', durationSeconds: 1, params: { text: 'fixture' } }] }, sourcesByIndex: [defaultSceneSource()] }, structural: true };
      } else if (turn === 2) { name = 'export_mp4'; args = { force: true }; }
      else if (turn === 3 || retry && turn === 4) {
        const taskId = JSON.parse(last.content).taskId;
        const journal = join(root, '.studio', 'tasks', taskId + '.json');
        for (let n = 0; ; n++) {
          const task = JSON.parse(await readFile(journal, 'utf8'));
          if (task.status !== 'running') break;
          if (n > 100) throw new Error('fixture task did not finish');
          await new Promise(r => setTimeout(r, 5));
        }
        name = retry && turn === 3 ? 'export_mp4' : 'render_check';
        args = name === 'export_mp4' ? { force: true, retryTaskId: taskId } : {};
      }
      turn++;
      const message = name ? { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-' + turn, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'fixture complete' };
      return new Response(JSON.stringify({ choices: [{ message, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const model = await cli(['models', 'add', '--name', 'fixture', '--base-url', 'http://local-fixture.invalid/v1', '--model', 'fixture']);
      assert.equal(model.code, EXIT.OK, model.out);
      const run = await cli(['agent', 'run', '--project', projectId, '--goal', 'synthetic task association', '--auto-approve', 'read,write,export', '--allow-paid', '--max-cost', '1', '--max-review-rounds', '0']);
      const current = await cli(['project', 'get', projectId]);
      const journal = await Promise.all((await readdir(join(root, '.studio', 'tasks'))).filter(file => file.endsWith('.json')).map(async file => JSON.parse(await readFile(join(root, '.studio', 'tasks', file), 'utf8'))));
      const runId = run.json.data?.id ?? run.json.error?.run?.id;
      const persisted = JSON.parse(await readFile(join(process.env.YINGLIU_DATA_DIR!, 'agent-runs', runId + '.json'), 'utf8'));
      return { run, project: current.json.data.project, journal, persisted, exportCalls };
    } finally { globalThis.fetch = previousFetch; }
  });
}

test('R2-06 integration: a failed export followed by a successful preview remains RUN_FAILED', async () => {
  const result = await scenario(true, false);
  assert.equal(result.run.code, EXIT.RUN_FAILED, result.run.out); assert.equal(result.run.json.ok, false);
  assert.equal(result.run.json.error.task.kind, 'export'); assert.equal(result.run.json.error.tasks.at(-1).kind, 'preview');
  assert.equal(result.project.outputs.length, 0); assert.equal(result.persisted.taskRefs.length, 2);
});

test('R2-06 integration: successful export remains linked to its output after preview', async () => {
  const result = await scenario(false, false);
  assert.equal(result.run.code, EXIT.OK, result.run.out);
  const task = result.journal.find(task => task.kind === 'export');
  assert.equal(result.run.json.data.output.id, task.outputId); assert.equal(result.run.json.data.output.path, result.project.outputs[0].path);
  assert.equal(result.run.json.data.task.id, task.id); assert.equal(result.run.json.data.tasks.at(-1).kind, 'preview');
});

test('R2-06 integration: explicit successful retry supersedes its failed export before preview', async () => {
  const result = await scenario(true, true);
  assert.equal(result.run.code, EXIT.OK, result.run.out); assert.equal(result.exportCalls, 2);
  const failed = result.run.json.data.tasks.find((task: { status: string }) => task.status === 'failed');
  const retried = result.run.json.data.tasks.find((task: { retryOf?: string }) => task.retryOf === failed.id);
  assert.equal(failed.supersededBy, retried.id); assert.equal(retried.status, 'complete');
  assert.equal(result.run.json.data.output.id, retried.outputId); assert.equal(result.persisted.taskRefs.length, 3);
});
