/** Regression tests for the 2026-10 external audit (F01–F10 and supplementary items). Mocks only; no paid providers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDocs, emptyLedger, type Ledger } from '../src/agent/story.ts';
import { createProject, defaultSceneSource } from '../src/core/index.ts';
import { AgentService, type ResolvedAgentModel } from '../src/agent/service.ts';
import type { AgentPort, PublicRun } from '../src/agent/contracts.ts';
import type { StudioSnapshot, VideoProject } from '../src/shared/types.ts';
import { toolGateway, type GatewayReply } from './model-gateway.ts';

function project(): VideoProject {
  const p = createProject('审计回归', '测试');
  const shots = ['a', 'b', 'c'].map(id => ({ id, title: '镜头' + id, intent: '意图', composition: '构图', action: '动作', durationFrames: 90, assetIds: [], referenceIds: [], params: {} }));
  return { ...p, id: 'proj-1', revision: 3, shots, shotOrder: ['a', 'b', 'c'] } as unknown as VideoProject;
}
function fakePort(overrides: Partial<AgentPort> = {}) {
  const state = { project: project(), calls: [] as string[], visionImages: 0, voices: [] as string[] };
  const snap = () => ({ project: structuredClone(state.project), root: '/secret', task: null, environment: { browserAvailable: true, ffmpegAvailable: true, ffprobeAvailable: true } } as unknown as StudioSnapshot);
  const port: AgentPort = {
    snapshot: async () => snap(), readSource: async () => defaultSceneSource(),
    saveSource: async () => { state.project.revision++; return snap(); },
    commit: async (_p, _r, next) => { state.project = { ...next, revision: state.project.revision + 1 }; return snap(); },
    route: async (endpoint, payload) => { state.calls.push(endpoint); if (endpoint === 'preview') return { ok: true, value: {} }; return { ok: true, value: { id: 'x', payload } }; },
    capture: async (_p, frame) => ({ bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png', frame, shotId: 'a' }),
    ...overrides,
  };
  return { port, state };
}
function model(vision = false): () => Promise<ResolvedAgentModel> {
  return async () => ({ connectionId: 'gw', parameters: {}, vision, config: { baseUrl: 'http://gateway.test/v1', model: 'm', key: 'k', timeoutMs: 5000, maxTokens: 2048, supportsTools: true } });
}
async function settle(service: AgentService, id: string, until: PublicRun['status'][], ms = 5000): Promise<PublicRun> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const run = await service.get(id); if (until.includes(run.status)) return run; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('timeout; status=' + (await service.get(id)).status);
}
const done = (text = '完成'): GatewayReply => ({ text });

async function dir() { return mkdtemp(join(tmpdir(), 'yingliu-audit-')); }

test('supplementary: corrupt ledger is preserved and surfaced, never reset to zero spend', async () => {
  const d = await dir();
  try {
    const docs = new ProjectDocs<Ledger>(join(d, 'ledger'), emptyLedger);
    assert.equal((await docs.get('proj-1')).spent, 0, 'missing file still starts empty');
    await docs.update('proj-1', l => ({ ...l, spent: 12.5, maxCost: 20 }));
    await writeFile(join(d, 'ledger', 'proj-1.json'), '{"version":3,"spent":12.5,');
    await assert.rejects(docs.get('proj-1'), /已损坏/);
    await assert.rejects(docs.update('proj-1', l => ({ ...l, spent: l.spent + 1 })), /已损坏/);
    assert.equal(await readFile(join(d, 'ledger', 'proj-1.json'), 'utf8'), '{"version":3,"spent":12.5,', 'original bytes kept');
    await mkdir(join(d, 'ledger', 'proj-2.json'));
    await assert.rejects(docs.get('proj-2'), /无法读取/);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('F06: maxToolCalls is enforced before each tool in a multi-call batch', async () => {
  const d = await dir(); const { port } = fakePort(); let reads = 0;
  const counting = { ...port, snapshot: async (id: string) => { reads++; return port.snapshot(id); } };
  const gw = toolGateway(turn => ({ toolCalls: [1, 2, 3].map(() => ({ name: 'project_get', arguments: {} })) }));
  const service = new AgentService(d, counting, { resolveModel: model(), fetch: gw.fetch, retryBaseMs: 1 });
  try {
    const started = await service.start({ projectId: 'proj-1', goal: '读', budget: { maxToolCalls: 1 } }); const before = reads;
    const run = await settle(service, started.id, ['budget_exceeded', 'complete', 'failed']);
    assert.equal(run.status, 'budget_exceeded'); assert.equal(run.usage.toolCalls, 1); assert.equal(reads - before, 1);
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('F03: a reused provider call ID with different arguments needs a fresh approval; approvals are single-use', async () => {
  const d = await dir(); const voices: string[] = [];
  const { port } = fakePort({ capabilities: async () => ({ roles: ['speech'] }), voice: async (_p, _s, text) => { voices.push(text); return { id: 'v' + voices.length, name: 'v' }; } });
  const gw = toolGateway((_b, turn) => turn === 0 ? { toolCalls: [{ id: 'dup', name: 'generate_voice', arguments: { shotId: 'a', text: '第一段' } }] }
    : turn === 1 ? { toolCalls: [{ id: 'dup', name: 'generate_voice', arguments: { shotId: 'a', text: '第二段' } }] } : done());
  const service = new AgentService(d, port, { resolveModel: model(), fetch: gw.fetch, retryBaseMs: 1 });
  try {
    const started = await service.start({ projectId: 'proj-1', goal: '配音' });
    let run = await settle(service, started.id, ['awaiting_approval']);
    await service.approve(started.id, 'dup');
    run = await settle(service, started.id, ['awaiting_approval', 'complete', 'failed']);
    assert.equal(run.status, 'awaiting_approval', 'second call with same provider ID must be approved again');
    assert.deepEqual(voices, ['第一段']);
    assert.ok(run.pending?.arguments.includes('第二段'));
    await service.reject(started.id, 'dup');
    run = await settle(service, started.id, ['complete', 'failed']);
    assert.deepEqual(voices, ['第一段']);
    assert.equal((run.approvals ?? []).length, 0, 'approval consumed');
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});
