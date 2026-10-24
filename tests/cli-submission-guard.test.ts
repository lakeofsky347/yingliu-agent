import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import { installMockNetworkGuard } from '../src/cli/mock.ts';
import { toolGateway } from './model-gateway.ts';
import type { AgentPort } from '../src/agent/contracts.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';

test('R2-08: denied mock audio is preflight_failed, never reaches fetch or creates uncertain paid work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-mock-submission-'));
  const previousFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error('network spy must never be reached'); }) as typeof fetch;
  const unguard = installMockNetworkGuard();
  const gateway = toolGateway((_body, turn) => turn === 0 ? { toolCalls: [{ name: 'generate_music', arguments: { prompt: 'must stay offline' } }] } : { text: 'mock refusal handled' });
  const fetchMock: typeof fetch = (input, init) => String(input).includes('gateway.test') ? gateway.fetch(input, init) : globalThis.fetch(input, init);
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    app = await createApplication({ dataDirectory: directory, credentials: new MemorySecrets(), fetch: fetchMock });
    const call = async <T,>(endpoint: string, payload: unknown = {}): Promise<T> => { const reply = await app!.route(endpoint, payload); if (!reply.ok) throw new Error(reply.error.message); return reply.value as T; };
    const director = await call<{ id: string }>('models.connection.save', { name: 'test director', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const directorModel = await call<{ id: string }>('models.model.save', { connectionId: director.id, model: 'director', parameters: { pricePerMInput: 0, pricePerMOutput: 0 } });
    await call('models.role.bind', { role: 'director', modelId: directorModel.id });
    const music = await call<{ id: string }>('models.connection.save', { name: 'external music', protocol: 'async-task', baseUrl: 'https://provider.invalid/v1', auth: 'none' });
    const musicModel = await call<{ id: string }>('models.model.save', { connectionId: music.id, model: 'music', outputModalities: ['audio'], parameters: { preset: 'replicate' } });
    await call('models.role.bind', { role: 'music', modelId: musicModel.id });
    const project = (await call<StudioSnapshot>('create', { blank: true, title: 'mock submission boundary' })).project!;
    const port = (app.agent as unknown as { port: AgentPort }).port;
    await assert.rejects(port.generateAudio!(project.id, 'music', 'direct refusal', { signal: new AbortController().signal }), error => (error as { submission?: string }).submission === 'preflight_failed');
    const started = await app.agent.start({ projectId: project.id, goal: 'music', autoApprove: ['read', 'write', 'cost'] });
    for (let i = 0; i < 500; i++) { const run = await app.agent.get(started.id); if (['complete', 'failed', 'paused'].includes(run.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    const done = await app.agent.get(started.id);
    assert.equal(done.status, 'complete', done.error); assert.equal(done.usage.toolCalls, 1);
    assert.equal(done.uncertainSubmissions?.length ?? 0, 0); assert.equal(done.usage.unknownCostCalls, 0);
    assert.equal((await app.agent.ledger(project.id)).unknownCostCalls, 0); assert.equal(requests, 0);
  } finally { await app?.dispose(); unguard(); globalThis.fetch = previousFetch; await rm(directory, { recursive: true, force: true }); }
});
