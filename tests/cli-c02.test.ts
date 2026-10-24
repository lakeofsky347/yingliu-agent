import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import { mockFetch, MOCK_BASE_URL } from '../src/cli/mock.ts';
import { startMediaGateway } from './media-gateway.ts';
import { cli, withCliEnv } from './cli-helpers.ts';

test('C02: mockFetch rejects every non-mock URL without touching the network', async () => {
  const seen: string[] = []; const spy = (async (input: string | URL | Request) => { seen.push(String(input)); return new Response('{}'); }) as typeof fetch;
  const f = mockFetch(spy);
  await assert.rejects(f('http://127.0.0.1:9/v1/media/jobs', { method: 'POST' }), /模拟模式/);
  await assert.rejects(f(new URL('https://api.example.com/v1/audio/speech')), /模拟模式/);
  assert.equal((await f(MOCK_BASE_URL + '/models')).ok, true);
  assert.deepEqual(seen, []);
});

test('C02: --mock never contacts real providers on any channel (existing non-mock pending media task, global fetch spy)', () => withCliEnv(async () => {
  const gateway = await startMediaGateway({ queued: true });
  const realFetch = globalThis.fetch; const leaked: string[] = [];
  try {
    // seed: a real (non-mock) video task accepted by the provider and still running
    const app = await createApplication({ dataDirectory: process.env.YINGLIU_DATA_DIR!, projectsDirectory: process.env.YINGLIU_PROJECTS!, credentials: new MemorySecrets() });
    const call = async (e: string, p: unknown = {}) => { const r = await app.route(e, p); if (!r.ok) throw new Error(e + ': ' + r.error.message); return r.value as any; };
    const conn = await call('models.connection.save', { name: 'video', protocol: 'video-gateway', baseUrl: gateway.url, auth: 'none' });
    const model = await call('models.model.save', { connectionId: conn.id, model: 'video-test', inputModalities: ['text'], outputModalities: ['video'] });
    await call('models.role.bind', { role: 'video', modelId: model.id });
    const created = await call('create', { blank: true, title: 'real' });
    await call('media.generate', { projectId: created.project.id, expectedRevision: created.project.revision, operation: 'text-to-video', prompt: 'x' });
    for (let i = 0; i < 100 && !gateway.requests.some((r: { method: string }) => r.method === 'POST'); i++) await new Promise(r => setTimeout(r, 20));
    await app.dispose();
    const before = gateway.requests.length; assert.ok(before > 0, 'seeded task reached the provider');
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => { const u = String(input instanceof Request ? input.url : input); if (!u.includes('mock.yingliu.invalid')) leaked.push(u); return realFetch(input as string, init); }) as typeof fetch;
    const p = await cli(['project', 'create', '--title', 'm', '--mock']); assert.equal(p.code, 0, p.out);
    const run = await cli(['agent', 'run', '--project', p.json.data.id, '--goal', 'g', '--mock', '--max-review-rounds', '0']); assert.ok([0, 4].includes(run.code), run.out);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(gateway.requests.length, before, 'no request to the real provider: ' + JSON.stringify(gateway.requests.slice(before)));
    assert.deepEqual(leaked, []);
  } finally { globalThis.fetch = realFetch; await gateway.close(); }
}));
