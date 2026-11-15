import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { artifactUsesConnectionAuth, downloadArtifact } from '../src/jobs/download.ts';
import { MediaTaskService } from '../src/jobs/media-tasks.ts';
import { ModelRegistry } from '../src/models/registry.ts';
import type { MediaProjectPort } from '../src/jobs/contracts.ts';
import { MemorySecrets } from '../src/app/application.ts';

const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);

test('artifact credentials stay on the connection origin and path prefix', () => {
  assert.equal(artifactUsesConnectionAuth('https://ailxp.top/v1/videos/job-1/content', 'https://ailxp.top/v1'), true);
  assert.equal(artifactUsesConnectionAuth('https://cdn.example/v1/videos/job-1/content', 'https://ailxp.top/v1'), false);
  assert.equal(artifactUsesConnectionAuth('https://ailxp.top/videos/job-1/content', 'https://ailxp.top/v1'), false);
  assert.equal(artifactUsesConnectionAuth('https://ailxp.top/v1evil/videos/job-1/content', 'https://ailxp.top/v1'), false);
});

test('download sends the bearer token only before a redirect leaves the connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-download-'));
  const seen: { url: string; authorization?: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, authorization: headers.get('authorization') ?? undefined });
    if (url.endsWith('/content')) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/file.mp4' } });
    return new Response(video, { status: 200, headers: { 'content-type': 'video/mp4' } });
  };
  try {
    const file = await downloadArtifact({ url: 'https://ailxp.top/v1/videos/job-1/content', mimeType: 'video/mp4' }, directory, 0, { signal: new AbortController().signal, fetch: fetchImpl, maxBytes: 1024 * 1024, expected: 'video', credential: { baseUrl: 'https://ailxp.top/v1', token: 'fixture-video-key' } });
    assert.equal(file.bytes, video.length);
    assert.equal(seen[0]?.authorization, 'Bearer fixture-video-key');
    assert.equal(seen[1]?.url, 'https://cdn.example/file.mp4');
    assert.equal(seen[1]?.authorization, undefined);
    await assert.rejects(downloadArtifact({ url: 'https://cdn.example/file.mp4', mimeType: 'video/mp4' }, directory, 1, { signal: new AbortController().signal, fetch: async () => { throw new Error('download failed fixture-video-key'); }, maxBytes: 1024, expected: 'video', credential: { baseUrl: 'https://ailxp.top/v1', token: 'fixture-video-key' } }), (error: Error) => !error.message.includes('fixture-video-key') && /download failed/.test(error.message));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('retrying a succeeded openai video only downloads the content url again', async () => {
  const requests: { method?: string; url?: string; authorization?: string }[] = [];
  let downloads = 0;
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    if (req.url === '/v1/videos/job-1/content') {
      downloads++;
      if (req.headers.authorization !== 'Bearer fixture-video-key') { res.writeHead(401); res.end('no'); return; }
      if (downloads === 1) { res.writeHead(503); res.end('later'); return; }
      res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(video); return;
    }
    const body = { id: 'job-1', status: 'succeeded', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/videos/job-1/content` };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', () => accept()));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-content-retry-'));
  const registry = new ModelRegistry(directory, new MemorySecrets());
  await registry.saveConnection({ name: 'ailxp', protocol: 'openai-videos', baseUrl: 'http://127.0.0.1:' + address.port + '/v1', auth: 'bearer', apiKey: 'fixture-video-key' });
  const connection = (await registry.list()).connections[0]!;
  const model = await registry.saveModel({ connectionId: connection.id, model: 'seedance-2-0', name: 'seedance', inputModalities: ['text', 'image'], outputModalities: ['video'], parameters: {} });
  await registry.bindRole('video', model.id);
  const port: MediaProjectPort = {
    async inspect() { return { revision: 1, shotIds: ['shot-1'], productionMode: 'model_video', allowGeneratedImages: false }; },
    async readImage() { return { bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' }; },
    async validateArtifact() { return { mime: 'video/mp4' }; },
    async applyResult() { return { assetIds: ['a'], revision: 2 }; },
  };
  const media = new MediaTaskService(directory, registry, port, { resumeExistingTasks: false, pollIntervalMs: 20 });
  try {
    const started = await media.generate({ projectId: 'p', expectedRevision: 1, operation: 'text-to-video', prompt: '海边', modelId: model.id });
    let paused = started;
    for (let i = 0; i < 50 && !(paused.observation === 'paused' && paused.remoteStatus === 'succeeded'); i++) { await new Promise(resolve => setTimeout(resolve, 20)); paused = await media.get(started.id); }
    assert.equal(paused.remoteStatus, 'succeeded');
    assert.match(paused.message, /重试获取/);
    const journal = await readFile(join(directory, 'media-tasks', started.id + '.json'), 'utf8');
    assert.equal(journal.includes('fixture-video-key'), false);
    const postsBefore = requests.filter(item => item.method === 'POST').length;
    await media.retry(started.id);
    let ready = paused;
    for (let i = 0; i < 50 && ready.phase !== 'ready'; i++) { await new Promise(resolve => setTimeout(resolve, 20)); ready = await media.get(started.id); }
    assert.equal(ready.phase, 'ready');
    assert.equal(requests.filter(item => item.method === 'POST').length, postsBefore);
    assert.equal(downloads, 2);
    assert.ok(requests.filter(item => item.url === '/v1/videos/job-1/content').every(item => item.authorization === 'Bearer fixture-video-key'));
  } finally { await media.dispose(); server.close(); await rm(directory, { recursive: true, force: true }); }
});
