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
    await service.approve(started.id, 'dup', (await service.get(started.id)).pending!.execId!);
    run = await settle(service, started.id, ['awaiting_approval', 'complete', 'failed']);
    assert.equal(run.status, 'awaiting_approval', 'second call with same provider ID must be approved again');
    assert.deepEqual(voices, ['第一段']);
    assert.ok(run.pending?.arguments.includes('第二段'));
    await service.reject(started.id, 'dup', (await service.get(started.id)).pending!.execId!);
    run = await settle(service, started.id, ['complete', 'failed']);
    assert.deepEqual(voices, ['第一段']);
    assert.equal((run.approvals ?? []).length, 0, 'approval consumed');
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('F04: a paid voice call that fails after submission is not auto-retried; the run pauses and resubmission needs approval', async () => {
  const d = await dir(); let submissions = 0;
  const { port } = fakePort({ capabilities: async () => ({ roles: ['speech'] }), voice: async () => { submissions++; throw new TypeError('fetch failed'); } });
  const gw = toolGateway((_b, turn) => turn < 2 ? { toolCalls: [{ name: 'generate_voice', arguments: { shotId: 'a', text: '旁白' } }] } : done());
  const service = new AgentService(d, port, { resolveModel: model(), fetch: gw.fetch, retryBaseMs: 1 });
  try {
    const started = await service.start({ projectId: 'proj-1', goal: '配音', autoApprove: ['read', 'write', 'cost'] });
    let run = await settle(service, started.id, ['paused', 'complete', 'failed']);
    assert.equal(run.status, 'paused'); assert.equal(submissions, 1, 'exactly one submission');
    assert.equal(run.uncertainSubmissions?.length, 1);
    assert.equal(run.steps.find(s => s.tool === 'generate_voice' && s.kind === 'tool')?.attempts, 1);
    await service.resume(started.id);
    run = await settle(service, started.id, ['awaiting_approval', 'complete', 'failed']);
    assert.equal(run.status, 'awaiting_approval', 'even with cost auto-approve, a resubmission after an uncertain one needs a human');
    assert.equal(submissions, 1);
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('F02: with allowImages=false no frame reaches the vision model (explicit visual_review, consistency_review, auto self-check)', async () => {
  for (const allowImages of [false, true]) {
    const d = await dir(); let sent = 0;
    const { port, state } = fakePort({ capabilities: async () => ({ roles: ['vision'] }), vision: async (_p, images) => { sent += images.length; return '{"pass":true,"issues":[],"scores":[]}'; } });
    const gw = toolGateway((_b, turn) => turn === 0 ? { toolCalls: [{ name: 'visual_review', arguments: {} }, { name: 'consistency_review', arguments: {} }] }
      : turn === 1 ? { toolCalls: [{ name: 'shot_write_source', arguments: { expectedRevision: 3, shotId: 'a', source: { html: '<p/>', css: '', js: 'export function render(){}' } } }] } : done());
    const service = new AgentService(d, port, { resolveModel: model(true), fetch: gw.fetch, retryBaseMs: 1 });
    try {
      const started = await service.start({ projectId: 'proj-1', goal: '自检', allowImages });
      const run = await settle(service, started.id, ['complete', 'failed']);
      assert.equal(run.status, 'complete');
      const offered = gw.requests[0].tools.map((t: any) => t.function.name);
      if (!allowImages) {
        assert.equal(sent, 0, 'no image sent without consent');
        assert.ok(!offered.includes('visual_review'), 'image tools withheld from the model');
        assert.ok(state.calls.includes('preview'), 'self-check fell back to local render_check');
        assert.ok(run.steps.some(s => s.kind === 'review' && s.tool === 'render_check'));
      } else { assert.ok(sent > 0); assert.ok(offered.includes('visual_review')); }
    } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
  }
});

test('F10: all keyframe captures failing yields PARTIAL, not PASS, and export is blocked unless forced', async () => {
  const { createTools, qualityCheck } = await import('../src/agent/tools.ts');
  const { port, state } = fakePort({ capture: async () => { throw new Error('截帧失败'); } });
  let saved: any;
  const ctx = { runId: 'r', projectId: 'proj-1', signal: new AbortController().signal, port, docs: { story: async () => ({ status: 'empty', shots: [], characters: [], consistency: {} }) as any, updateStory: async () => ({}) as any, ledger: async () => emptyLedger('proj-1'), saveQc: async (r: any) => { saved = r; } } };
  const report = await qualityCheck(ctx);
  assert.equal(report.status, 'partial'); assert.equal(report.pass, false); assert.equal(report.unchecked.length, 3); assert.equal(saved.status, 'partial');
  const exportTool = createTools().find(t => t.name === 'export_mp4')!;
  const blocked = JSON.parse((await exportTool.run({}, ctx)).content);
  assert.equal(blocked.blocked, true); assert.ok(!state.calls.includes('export'));
  const forced = JSON.parse((await exportTool.run({ force: true }, ctx)).content);
  assert.equal(forced.ok, true); assert.equal(forced.qc.forced, true); assert.ok(state.calls.includes('export'));
});

test('F08: run_workflow macro starts and completes a real WorkflowService run through the app route (mock gateway)', async () => {
  const { createServer } = await import('node:http');
  const { createApplication, MemorySecrets } = await import('../src/app/application.ts');
  let agentTurn = 0, workflowCalls = 0, revision = -1;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
    const reply = (message: Record<string, unknown>, finish = 'stop') => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    if (body.tools) {
      const turn = agentTurn++;
      if (turn === 0) return reply({ content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'project_get', arguments: '{}' } }] }, 'tool_calls');
      if (turn === 1) { revision = JSON.parse(body.messages.at(-1).content).revision; return reply({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_workflow', arguments: JSON.stringify({ expectedRevision: revision, prompt: '三个清楚的镜头' }) } }] }, 'tool_calls'); }
      return reply({ content: '流程已完成' });
    }
    workflowCalls++; const prompt = body.messages.at(-1).content; const context = JSON.parse(typeof prompt === 'string' ? prompt : prompt[0].text);
    reply({ content: JSON.stringify(body.messages[0].content.includes('director') ? { shots: context.shots.map((s: { id: string }) => ({ shotId: s.id, prompt: '画面', narration: '旁白' })) } : defaultSceneSource()) });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as { port: number }).port;
  const directory = await dir(); const app = await createApplication({ dataDirectory: directory, credentials: new MemorySecrets() });
  const call = async <T,>(endpoint: string, payload: unknown = {}) => { const r = await app.route(endpoint, payload); if (!r.ok) throw new Error(endpoint + ': ' + r.error.message); return r.value as T; };
  try {
    const connection = await call<{ id: string }>('models.connection.save', { name: 'mock', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none' });
    const m = await call<{ id: string }>('models.model.save', { connectionId: connection.id, model: 'director-test', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    for (const role of ['director', 'scene']) await call('models.role.bind', { role, modelId: m.id });
    const created = await call<StudioSnapshot>('create', { title: '宏测试' }); const projectId = created.project!.id;
    const run = await call<PublicRun>('agent.start', { projectId, goal: '用固定流程做一版', maxReviewRounds: 0, autoApprove: ['read', 'write', 'cost'] });
    let current = run; for (let i = 0; i < 750 && !['complete', 'failed', 'budget_exceeded', 'paused'].includes(current.status); i++) { await new Promise(r => setTimeout(r, 20)); current = await call<PublicRun>('agent.get', { runId: run.id }); }
    assert.equal(current.status, 'complete', current.message);
    const workflows = await call<{ workflows: { status: string; request: { visual: string } }[] }>('workflows.list', { projectId });
    assert.equal(workflows.workflows.length, 1); assert.equal(workflows.workflows[0]!.request.visual, 'code'); assert.equal(workflows.workflows[0]!.status, 'complete');
    assert.ok(workflowCalls > 0, 'workflow director/scene roles were actually called');
    assert.ok((await call<StudioSnapshot>('current', { projectId })).project!.revision > revision);
  } finally { await app.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(directory, { recursive: true, force: true }); }
});

test('F07: template cancel trusts the reported status instead of assuming cancelled', async () => {
  const { cancelTemplate } = await import('../src/models/adapters/template.ts');
  const model = { id: 'm', connectionId: 'c', model: 'owner/name', parameters: { preset: 'replicate' } } as never;
  const connection = { id: 'c', protocol: 'async-task', baseUrl: 'http://127.0.0.1:1/v1', auth: 'none', requestTimeoutMs: 5000 } as never;
  const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const ctx = (body: unknown) => ({ connection, signal: new AbortController().signal, fetch: reply(body) });
  assert.equal((await cancelTemplate(ctx({ status: 'processing' }), model, 'j1')).status, 'running');
  assert.equal((await cancelTemplate(ctx({}), model, 'j1')).status, 'running', 'no status is not a confirmation');
  assert.equal((await cancelTemplate(ctx({ status: 'canceled' }), model, 'j1')).status, 'cancelled');
  const done = await cancelTemplate(ctx({ status: 'succeeded', output: 'https://example.invalid/a.mp4' }), model, 'j1');
  assert.equal(done.status, 'succeeded'); assert.equal(done.artifacts?.length, 1);
});

test('R08: resume/approve issued the instant a paused/awaiting state is published waits for the old loop instead of failing', async () => {
  const d = await dir(); let submissions = 0;
  const { port } = fakePort({ capabilities: async () => ({ roles: ['speech'] }), voice: async () => { submissions++; throw new TypeError('fetch failed'); } });
  const gw = toolGateway((_b, turn) => turn < 2 ? { toolCalls: [{ name: 'generate_voice', arguments: { shotId: 'a', text: '旁白' } }] } : done());
  const service = new AgentService(d, port, { resolveModel: model(), fetch: gw.fetch, retryBaseMs: 1 });
  try {
    let resumed: Promise<unknown> | undefined;
    service.subscribe(event => { if (event.type === 'run' && event.run.status === 'paused' && !resumed) resumed = service.resume(event.run.id); });
    const started = await service.start({ projectId: 'proj-1', goal: '配音', autoApprove: ['read', 'write', 'cost'] });
    await settle(service, started.id, ['paused', 'awaiting_approval', 'complete', 'failed']);
    while (!resumed) await new Promise(r => setImmediate(r));
    await resumed; // synchronously during publication: active loop still registered
    const run = await settle(service, started.id, ['awaiting_approval', 'complete', 'failed']);
    assert.equal(run.status, 'awaiting_approval'); assert.equal(submissions, 1);
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('R05: tools requested in the last allowed model turn still execute; the next model turn is blocked', async () => {
  const d = await dir(); const { port } = fakePort(); let reads = 0;
  const counting = { ...port, snapshot: async (id: string) => { reads++; return port.snapshot(id); } };
  const gw = toolGateway(() => ({ toolCalls: [{ name: 'project_get', arguments: {} }] }));
  const service = new AgentService(d, counting, { resolveModel: model(), fetch: gw.fetch, retryBaseMs: 1 });
  try {
    const started = await service.start({ projectId: 'proj-1', goal: '读', budget: { maxSteps: 1 } }); const before = reads;
    const run = await settle(service, started.id, ['budget_exceeded', 'complete', 'failed']);
    assert.equal(run.status, 'budget_exceeded'); assert.equal(run.usage.steps, 1); assert.equal(run.usage.toolCalls, 1); assert.equal(reads - before, 1);
    assert.equal(gw.requests.length, 1, 'no second model turn');
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('R02: a stale/replayed approval for an earlier pending call that reused the provider call ID is rejected', async () => {
  const d = await dir(); const voices: string[] = [];
  const { port } = fakePort({ capabilities: async () => ({ roles: ['speech'] }), voice: async (_p, _s, text) => { voices.push(text); return { id: 'v' + voices.length, name: 'v' }; } });
  const gw = toolGateway((_b, turn) => turn === 0 ? { toolCalls: [{ id: 'dup', name: 'generate_voice', arguments: { shotId: 'a', text: '第一段' } }] }
    : turn === 1 ? { toolCalls: [{ id: 'dup', name: 'generate_voice', arguments: { shotId: 'a', text: '第二段' } }] } : done());
  const service = new AgentService(d, port, { resolveModel: model(), fetch: gw.fetch, retryBaseMs: 1 });
  try {
    const started = await service.start({ projectId: 'proj-1', goal: '配音' });
    const first = (await settle(service, started.id, ['awaiting_approval'])).pending!;
    await assert.rejects(service.approve(started.id, 'dup'), /execId/, 'execId is mandatory');
    await service.approve(started.id, 'dup', first.execId, first.argsHash);
    const second = (await settle(service, started.id, ['awaiting_approval', 'complete'])).pending!;
    assert.notEqual(second.execId, first.execId);
    await assert.rejects(service.approve(started.id, 'dup', first.execId), /过期/, 'replayed first approval');
    await assert.rejects(service.reject(started.id, 'dup', first.execId), /过期/);
    await assert.rejects(service.approve(started.id, 'dup', second.execId, first.argsHash), /参数已变化/);
    assert.deepEqual(voices, ['第一段']); assert.equal((await service.get(started.id)).status, 'awaiting_approval');
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('R04: an adapter-declared unknown outcome (plain-text poll timeout with jobId) pauses the run; no automatic paid resubmission', async () => {
  const { withSubmission } = await import('../src/agent/submission.ts');
  const d = await dir(); let submissions = 0;
  const { port } = fakePort({ capabilities: async () => ({ roles: ['music'] }), generateAudio: async () => { submissions++; throw withSubmission(new Error('音频生成等待超时；云端任务可能仍在执行'), 'unknown', 'job-7'); } });
  const gw = toolGateway((_b, turn) => turn < 3 ? { toolCalls: [{ name: 'generate_music', arguments: { prompt: 'lofi', durationSeconds: 1 } }] } : done());
  const service = new AgentService(d, port, { resolveModel: model(), fetch: gw.fetch, retryBaseMs: 1 });
  try {
    const started = await service.start({ projectId: 'proj-1', goal: '配乐', autoApprove: ['read', 'write', 'cost'] });
    let run = await settle(service, started.id, ['paused', 'complete', 'failed']);
    assert.equal(run.status, 'paused'); assert.equal(submissions, 1); assert.equal(run.uncertainSubmissions?.[0]?.jobId, 'job-7');
    await service.resume(started.id);
    run = await settle(service, started.id, ['awaiting_approval', 'complete', 'failed']);
    assert.equal(run.status, 'awaiting_approval'); assert.equal(submissions, 1);
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
  // A definite provider rejection ('failed') is an ordinary tool error and does not pause.
  const d2 = await dir(); let calls = 0;
  const { port: p2 } = fakePort({ capabilities: async () => ({ roles: ['music'] }), generateAudio: async () => { calls++; throw withSubmission(new Error('content blocked'), 'failed', 'job-8'); } });
  const gw2 = toolGateway((_b, turn) => turn < 1 ? { toolCalls: [{ name: 'generate_music', arguments: { prompt: 'x' } }] } : done());
  const s2 = new AgentService(d2, p2, { resolveModel: model(), fetch: gw2.fetch, retryBaseMs: 1 });
  try { const st = await s2.start({ projectId: 'proj-1', goal: 'x', autoApprove: ['read', 'write', 'cost'] }); const r = await settle(s2, st.id, ['paused', 'complete', 'failed']); assert.equal(r.status, 'complete'); assert.equal(calls, 1); assert.equal(r.uncertainSubmissions?.length ?? 0, 0); }
  finally { await s2.dispose(); await rm(d2, { recursive: true, force: true }); }
});

for (const mode of ['pause', 'restart'] as const) test(`R03: a paid call in flight when the run is ${mode === 'pause' ? 'paused' : 'disposed and restarted'} is settled as unknown; resume never resubmits it`, async () => {
  const d = await dir(); let submissions = 0;
  const { port } = fakePort({ capabilities: async () => ({ roles: ['sfx'] }), generateAudio: async (_p, _r, _t, { signal }) => { submissions++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  const gw = toolGateway(() => ({ toolCalls: [{ name: 'generate_sfx', arguments: { prompt: '风声', durationSeconds: 1 } }] }));
  let service = new AgentService(d, port, { resolveModel: model(), fetch: gw.fetch, retryBaseMs: 1 });
  try {
    const started = await service.start({ projectId: 'proj-1', goal: '音效', autoApprove: ['read', 'write', 'cost'] });
    for (let i = 0; i < 500 && submissions === 0; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(submissions, 1);
    if (mode === 'pause') await service.pause(started.id);
    else { await service.dispose(); service = new AgentService(d, port, { resolveModel: model(), fetch: gw.fetch, retryBaseMs: 1 }); }
    let run = await service.get(started.id);
    assert.equal(run.status, 'paused');
    assert.equal(run.uncertainSubmissions?.length, 1, 'in-flight receipt settled as unknown');
    assert.equal(run.queue.length, 0, 'the paid call is not left queued for re-execution');
    await service.resume(started.id);
    run = await settle(service, started.id, ['awaiting_approval', 'complete', 'failed', 'budget_exceeded']);
    assert.equal(run.status, 'awaiting_approval', 'a resubmission needs explicit confirmation even with cost auto-approve');
    assert.equal(submissions, 1);
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('PR1-R03: a paid call that succeeds after the pause signal is committed once (receipt, charge, dequeue) and never resubmitted', async () => {
  const d = await dir(); let submissions = 0;
  const { port } = fakePort({ capabilities: async () => ({ roles: ['sfx'] }), generateAudio: async (_p, _r, _t, { signal }) => { if (++submissions > 1) return { id: 'asset-' + submissions, name: '风声', cost: 0.5 }; return new Promise(resolve => signal.addEventListener('abort', () => setTimeout(() => resolve({ id: 'asset-late', name: '风声', cost: 0.5 }), 5), { once: true })); } });
  const gw = toolGateway((_b, turn) => turn < 3 ? { toolCalls: [{ name: 'generate_sfx', arguments: { prompt: '风声', durationSeconds: 1 } }] } : done());
  const service = new AgentService(d, port, { resolveModel: model(), fetch: gw.fetch, retryBaseMs: 1 });
  try {
    const started = await service.start({ projectId: 'proj-1', goal: '音效', autoApprove: ['read', 'write', 'cost'] });
    for (let i = 0; i < 500 && submissions === 0; i++) await new Promise(r => setTimeout(r, 5));
    await service.pause(started.id);
    let run = await service.get(started.id);
    assert.equal(run.status, 'paused');
    assert.equal(run.queue.length, 0, 'the completed call is dequeued');
    assert.equal(run.inFlight, undefined);
    assert.equal(run.uncertainSubmissions?.length ?? 0, 0, 'a known success is not recorded as unknown');
    assert.equal(run.usage.cost, 0.5, 'charge recorded');
    assert.equal((await service.ledger('proj-1')).spent, 0.5, 'ledger matches the success receipt');
    assert.ok(run.transcript.some(m => m.role === 'tool' && String(m.content).includes('asset-late')), 'success receipt answered to the model');
    await service.resume(started.id);
    run = await settle(service, started.id, ['awaiting_approval', 'complete', 'failed', 'paused']);
    // the scripted model asks again on later turns; whatever happens, the first logical request was submitted once before resume
    assert.ok(submissions >= 1);
    assert.equal((await service.ledger('proj-1')).byTool['generate_sfx']?.calls, submissions, 'every submission is charged exactly once');
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});
