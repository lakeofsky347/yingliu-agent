import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRegistry } from '../src/models/registry.ts';
import { MediaTaskService } from '../src/jobs/media-tasks.ts';
import type { MediaProjectPort } from '../src/jobs/contracts.ts';
import { MemorySecrets } from '../src/app/application.ts';

test('official video protocol submits, polls and refuses extra references or unknown audio', async () => {
  const seen: { method?: string; url?: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    const body = req.url?.includes('/cancel') ? { id: 'job-1', status: 'cancelled' } : req.method === 'POST' ? { id: 'job-1', status: 'queued' } : { id: 'job-1', status: 'succeeded', url: 'https://example.invalid/out.mp4' };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', () => accept()));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-official-'));
  const registry = new ModelRegistry(directory, new MemorySecrets());
  await registry.saveConnection({ name: 'OpenAI 视频', protocol: 'openai-videos', baseUrl: 'http://127.0.0.1:' + address.port, auth: 'none' });
  const connection = (await registry.list()).connections[0]!;
  await registry.saveModel({ connectionId: connection.id, model: 'video-test', name: '视频', inputModalities: ['text', 'image'], outputModalities: ['video'], parameters: {} });
  const model = (await registry.list()).models[0]!;
  await registry.bindRole('video', model.id);
  let revision = 1;
  const port: MediaProjectPort = {
    async inspect() { return { revision, shotIds: ['shot-1'], productionMode: 'model_video', allowGeneratedImages: false }; },
    async readImage() { return { bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' }; },
    async validateArtifact() { return {}; },
    async applyResult() { revision++; return { assetIds: ['a'], revision }; },
  };
  const media = new MediaTaskService(directory, registry, port, { resumeExistingTasks: false });
  try {
    const task = await media.generate({ projectId: 'p', expectedRevision: 1, operation: 'text-to-video', prompt: '一只猫', modelId: model.id });
    assert.equal(task.connection.credentialRef, '');
    for (let i = 0; i < 50 && !seen.some(item => item.method === 'POST' && item.url === '/videos'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(seen.some(item => item.method === 'POST' && item.url === '/videos'), true);
    await assert.rejects(media.generate({ projectId: 'p', expectedRevision: 1, operation: 'text-to-video', prompt: '两张图', modelId: model.id, imageAssetIds: ['a', 'b'], allowImageUpload: true }), /参考图数量/);
    await assert.rejects(media.generate({ projectId: 'p', expectedRevision: 1, operation: 'text-to-video', prompt: '要声音', modelId: model.id, requiresAudio: true }), /原生音轨/);
  } finally { await media.dispose(); server.close(); await rm(directory, { recursive: true, force: true }); }
});
