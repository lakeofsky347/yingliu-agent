import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MediaTaskService } from '../src/jobs/media-tasks.ts';
import type { MediaTask, MediaProjectPort, MediaRegistryPort } from '../src/jobs/contracts.ts';
import type { ProviderConnection, ModelDefinition } from '../src/models/contracts.ts';
import { pngFixture } from './media-gateway.ts';

test('R2-07: frozen persisted pending/applying/queued tasks remain byte-identical when new mock tasks schedule', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-media-frozen-'));
  const taskDirectory = join(directory, 'media-tasks'); await mkdir(taskDirectory);
  const connection: ProviderConnection = { id: 'old-real-connection', name: 'persisted provider', protocol: 'video-gateway', baseUrl: 'https://old-provider.invalid', auth: 'none', credentialRef: 'old-ref', enabled: true, revision: 1, requestTimeoutMs: 5000, concurrency: 1 };
  const model: ModelDefinition = { id: 'old-model', connectionId: connection.id, model: 'old-model', name: 'old', enabled: true, inputModalities: ['text'], outputModalities: ['video'], parameters: {} };
  const snapshots = new Map<string, Buffer>();
  const oldTasks: MediaTask[] = [];
  for (const phase of ['pending', 'applying', 'queued'] as const) {
    const id = 'frozen-' + phase;
    const task: MediaTask = { version: 1, id, clientRequestId: 'request-' + id, projectId: 'film', startRevision: 7, operation: 'text-to-video', prompt: id, imageAssetIds: [], inputHashes: [], connection, model, parameters: {}, phase, observation: 'active', progress: 0, message: 'preserve this original message', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', files: [], resumeOnStart: true, ...(phase === 'queued' ? { remoteJobId: 'already-accepted', remoteStatus: 'queued' as const } : {}) };
    oldTasks.push(task);
    const json = join(taskDirectory, id + '.json');
    // Nonstandard whitespace catches a rewrite even when a parsed task looks unchanged.
    await writeFile(json, JSON.stringify(task, null, 4) + '\n\n'); snapshots.set(json, await readFile(json));
    await mkdir(join(taskDirectory, id)); const log = join(taskDirectory, id, 'existing.log');
    await writeFile(log, 'original persisted task log\n' + id + '\n'); snapshots.set(log, await readFile(log));
  }
  const calls: { url: string; method: string }[] = [], credentialReads: string[] = [];
  let validations = 0, adoptions = 0;
  const mockConnection: ProviderConnection = { ...connection, id: 'new-mock', name: 'mock', protocol: 'images', baseUrl: 'http://mock.yingliu.invalid/v1', credentialRef: 'mock-ref' };
  const mockModel: ModelDefinition = { ...model, id: 'new-mock-model', connectionId: mockConnection.id, outputModalities: ['image'] };
  const registry: MediaRegistryPort = {
    async resolve() { return { connection: mockConnection, model: mockModel }; },
    async credential(value) { const id = typeof value === 'string' ? value : value.id; credentialReads.push(id); assert.equal(id, 'new-mock', 'frozen provider credentials must never be touched'); return undefined; },
  };
  const projects: MediaProjectPort = {
    async inspect() { return { revision: 7, shotIds: [] }; },
    async readImage() { throw new Error('fixture has no image inputs'); },
    async validateArtifact(path) { validations++; assert.deepEqual(await readFile(path), pngFixture); return { width: 1, height: 1 }; },
    async applyResult() { adoptions++; throw new Error('frozen task must not reach project adoption'); },
  };
  const mockFetch = (async (input, init) => {
    const url = String(input); calls.push({ url, method: init?.method ?? 'GET' });
    assert.equal(url, 'http://mock.yingliu.invalid/v1/images/generations', 'only the newly created mock image may be submitted');
    return new Response(JSON.stringify({ data: [{ b64_json: pngFixture.toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const service = new MediaTaskService(directory, registry, projects, { resumeExistingTasks: false, fetch: mockFetch, pollIntervalMs: 1, maxConcurrent: 1 });
  async function unchanged() {
    for (const [path, bytes] of snapshots) assert.deepEqual(await readFile(path), bytes, path + ' was modified');
    for (const task of oldTasks) { const current = await service.get(task.id); assert.equal(current.phase, task.phase); assert.equal(current.observation, 'active'); assert.equal(current.updatedAt, task.updatedAt); }
  }
  try {
    await service.initialize(); await service.recover(); await unchanged();
    for (const task of oldTasks) {
      for (const mutate of [() => service.retry(task.id), () => service.pause(task.id), () => service.cancel(task.id), () => service.apply(task.id, 7)]) {
        await assert.rejects(mutate, (error: unknown) => (error as { code?: string }).code === 'TASK_FROZEN');
        await unchanged();
      }
    }
    // Both registration and completion re-enter schedule(); maxConcurrent=1 makes accidental frozen work observable.
    for (const suffix of ['first', 'second']) {
      const fresh = await service.generate({ projectId: 'film', expectedRevision: 7, operation: 'text-to-image', prompt: 'new mock ' + suffix });
      for (let count = 0; ; count++) {
        const task = await service.get(fresh.id);
        if (task.phase === 'ready') break;
        assert.ok(count < 200, 'new mock task did not become ready: ' + task.message);
        await new Promise(r => setTimeout(r, 5));
      }
      await unchanged();
    }
    assert.equal(calls.length, 2); assert.equal(validations, 2); assert.equal(adoptions, 0); assert.ok(credentialReads.length > 0);
    await service.dispose(); await unchanged();
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});
