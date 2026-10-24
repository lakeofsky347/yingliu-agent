import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import { synthesize } from '../src/agent/synth.ts';
import type { AgentPort } from '../src/agent/contracts.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';
let hasFfprobe = false; try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); hasFfprobe = true; } catch { /* media import requires ffprobe */ }

for (const status of ['succeeded', 'failed'] as const) {
  test(`R2-03: synchronous JSON ${status} is consumed without an invented polling request`, { skip: !hasFfprobe && 'ffprobe unavailable' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yingliu-sync-audio-')); const requests: { url: string; method?: string }[] = [];
    const wav = synthesize({ kind: 'tone', durationSeconds: 0.1 });
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input); requests.push({ url, method: init?.method });
      assert.equal(init?.method, 'POST', 'synchronous providers have no polling endpoint');
      return Response.json(status === 'succeeded' ? { status, output: 'data:audio/wav;base64,' + Buffer.from(wav).toString('base64') } : { status, error: 'provider rejected the request' });
    };
    const app = await createApplication({ dataDirectory: directory, credentials: new MemorySecrets(), fetch: fetchMock });
    const call = async <T,>(endpoint: string, payload: unknown = {}): Promise<T> => { const reply = await app.route(endpoint, payload); if (!reply.ok) throw new Error(reply.error.message); return reply.value as T; };
    try {
      const connection = await call<{ id: string }>('models.connection.save', { name: 'sync JSON audio', protocol: 'async-task', baseUrl: 'http://127.0.0.1:1/v1', auth: 'none' });
      const model = await call<{ id: string }>('models.model.save', { connectionId: connection.id, model: 'sync-json-audio', outputModalities: ['audio'], parameters: { preset: 'generic-async', idPath: '', submitPath: '/generate', resultPath: 'output', resultMime: 'audio/wav' } });
      await call('models.role.bind', { role: 'music', modelId: model.id });
      const project = (await call<StudioSnapshot>('create', { blank: true, title: 'sync JSON test' })).project!;
      const port = (app.agent as unknown as { port: AgentPort }).port;
      if (status === 'succeeded') {
        const asset = await port.generateAudio!(project.id, 'music', 'one request', { signal: new AbortController().signal });
        const current = await call<StudioSnapshot>('current', { projectId: project.id }); assert.ok(current.project!.assets.some(item => item.id === asset.id));
      } else await assert.rejects(port.generateAudio!(project.id, 'music', 'one request', { signal: new AbortController().signal }), error => (error as { submission?: string }).submission === 'failed');
      assert.equal(requests.length, 1); assert.equal((await readdir(join(directory, 'agent-receipts'))).length, 0);
    } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
}
