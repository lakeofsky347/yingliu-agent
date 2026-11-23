import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { createProject, defaultProductionPolicy, defaultSceneSource } from '../src/core/index.ts';
import { AgentService, type ResolvedAgentModel } from '../src/agent/service.ts';
import type { AgentPort, Capabilities, PublicRun } from '../src/agent/contracts.ts';
import type { StudioSnapshot, VideoProject } from '../src/shared/types.ts';
import { activeTools, alignToVoice, createTools } from '../src/agent/tools.ts';
import { anchorPrompt, dataChecks, emptyStory, frameIssue, normalizeShots, pngLuma, type Story } from '../src/agent/story.ts';
import { needsApproval, budgetFrom, emptyUsage } from '../src/agent/budget.ts';
import { approveDirectorDocument, readDirectorDocument, saveDirectorDocument } from '../src/director/document.ts';
import { DIRECTOR_RULESET_VERSION } from '../src/director/index.ts';
import type { DirectorPlan } from '../src/director/contracts.ts';
import { SKILLS } from '../src/agent/skills.ts';
import { toolGateway } from './model-gateway.ts';

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, body: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb)); return Buffer.concat([len, tb, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows: number[] = []; for (let y = 0; y < height; y++) { rows.push(y % 2 ? 2 : 1); let prev: number[] = [0, 0, 0]; for (let x = 0; x < width; x++) { const p = pixel(x, y); if (y % 2) { rows.push(...p); } else { rows.push(...p.map((v, i) => (v - prev[i] + 256) & 255)); prev = p; } } }
  // Odd rows use the Up filter: raw value minus row above.
  const raw = Buffer.from(rows); const stride = width * 3 + 1;
  for (let y = 1; y < height; y += 2) for (let x = 1; x < stride; x++) { const above = pixel(Math.floor((x - 1) / 3), y - 1)[(x - 1) % 3]; raw[y * stride + x] = (raw[y * stride + x] - above + 256) & 255; }
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const black = png(16, 12, () => [0, 0, 0]);
const busy = png(16, 12, (x, y) => [(x * 16) & 255, (y * 20) & 255, 128]);

function makeProject(): VideoProject {
  const base = createProject('故事测试');
  return { ...base, id: 'p', revision: 3, targetDuration: 4, target: { ...base.target, width: 1920, height: 1080, fps: { num: 30, den: 1 }, audioMode: 'mixed' },
    assets: [{ id: 'v1', kind: 'audio', name: '配音', description: '', duration: 3.2 }, { id: 'img', kind: 'image', name: '主角参考', description: '' }],
    shots: [{ id: 'a', title: 'A', intent: '', composition: '', action: '', durationFrames: 60, assetIds: [], referenceIds: [], params: { subtitle: '' } }, { id: 'b', title: 'B', intent: '', composition: '', action: '', durationFrames: 60, assetIds: [], referenceIds: [], params: { subtitle: '这是一段非常非常长的字幕'.repeat(12) } }],
    shotOrder: ['a', 'b'], audioClips: [{ id: 'k1', assetId: 'v1', role: 'voice', shotId: 'a', startSeconds: 0.5, trimStart: 0, volume: 1, fadeIn: 0, fadeOut: 0 }] } as unknown as VideoProject;
}

function port(caps: Capabilities, frame: Uint8Array = busy) {
  const project = makeProject(); const calls: { endpoint: string; payload: Record<string, unknown> }[] = []; const imports: string[] = [];
  const value: AgentPort = {
    snapshot: async () => ({ project, root: null, task: null, environment: {} } as unknown as StudioSnapshot),
    readSource: async () => defaultSceneSource(), saveSource: async () => ({ project } as unknown as StudioSnapshot),
    commit: async (_id, _rev, next) => { Object.assign(project, next, { revision: project.revision + 1 }); return { project } as unknown as StudioSnapshot; },
    route: async (endpoint, payload) => { calls.push({ endpoint, payload }); return { ok: true, value: endpoint === 'media.generate' ? { id: 't1' } : { id: 't1', phase: 'ready' } }; },
    capture: async (_p, f) => ({ bytes: frame, mime: 'image/png', frame: f, shotId: f < 60 ? 'a' : 'b' }),
    capabilities: async () => caps,
    importImage: async (_p, name) => { imports.push(name); return { id: 'tail', name }; },
    generateAudio: async () => ({ id: 'm', name: 'music', cost: 0.2 }),
    vision: async prompt => /一致性/.test(prompt) ? '{"scores":[{"shotId":"a","score":92,"notes":""},{"shotId":"b","score":40,"notes":"围巾颜色变了"}]}' : '{"pass":true,"issues":[]}',
  };
  return { port: value, calls, imports, project };
}
const model = async (): Promise<ResolvedAgentModel> => ({ parameters: {}, config: { baseUrl: 'http://gateway.test/v1', model: 'deepseek-chat', timeoutMs: 5000, maxTokens: 1000, supportsTools: true } });
async function settle(service: AgentService, id: string, until: PublicRun['status'][]) { for (let i = 0; i < 500; i++) { const run = await service.get(id); if (until.includes(run.status)) return run; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout ' + (await service.get(id)).status); }
const plan = { title: '雪夜', logline: '小狐狸在雪夜找回围巾', targetSeconds: 4, style: { look: '水彩绘本', palette: '靛蓝与暖橙', motion: '缓慢推镜', negative: '写实照片' }, characters: [{ id: 'fox', name: '小狐狸', description: '橙色小狐狸', features: ['红色围巾', '白色尾尖'] }] };
const shots = { shots: [{ id: 's1', shotId: 'a', summary: '雪地远景', shotType: '远景', camera: '推', durationSeconds: 2, dialogue: '雪下了一夜', characters: ['fox'] }, { id: 's2', shotId: 'b', summary: '近景找围巾', shotType: '近景', camera: '固定', durationSeconds: 2, characters: ['fox'], continueFromPrevious: true }] };

test('story helpers: validation, anchors, PNG luminance, data checks, voice alignment, skills, plan approval policy', () => {
  assert.throws(() => normalizeShots([], []), /非空/);
  assert.throws(() => normalizeShots([{ summary: 'x', durationSeconds: 2, characters: ['ghost'] }], []), /未知角色/);
  assert.throws(() => normalizeShots([{ summary: 'x', durationSeconds: 0 }], []), /durationSeconds/);
  const story: Story = { ...emptyStory('p'), status: 'approved', title: 't', style: { look: '水彩', palette: '蓝', typography: '', motion: '', negative: '照片' }, characters: [{ id: 'fox', name: '小狐狸', description: '橙色', features: ['红围巾'], referenceAssetIds: [] }] };
  const anchor = anchorPrompt(story, ['fox']); assert.match(anchor, /水彩/); assert.match(anchor, /小狐狸.*红围巾/); assert.match(anchor, /避免：照片/);
  assert.equal(anchorPrompt(null), '');
  const dark = pngLuma(black)!, lively = pngLuma(busy)!; assert.ok(dark.mean < 1 && dark.std < 1, JSON.stringify(dark)); assert.ok(lively.std > 10, JSON.stringify(lively));
  assert.equal(frameIssue('a', dark)?.severity, 'high'); assert.equal(frameIssue('a', lively), null); assert.equal(pngLuma(new Uint8Array([1, 2, 3])), null);
  const project = makeProject();
  const issues = dataChecks(project, { ...story, consistency: { b: { shotId: 'b', score: 30, notes: '围巾', at: '' } } });
  assert.ok(issues.some(i => i.check === 'subtitle' && i.shotId === 'b' && /行/.test(i.message)));
  assert.ok(issues.some(i => i.check === 'subtitle' && i.shotId === 'a' && /align_to_voice/.test(i.message)), JSON.stringify(issues));
  assert.ok(issues.some(i => i.check === 'consistency' && i.severity === 'high'));
  const silent = { ...makeProject(), audioClips: [] } as VideoProject; assert.ok(dataChecks(silent, null).some(i => i.check === 'silence'));
  const changes = alignToVoice(project, 0.4, null); assert.deepEqual(changes, [{ shotId: 'a', fromSeconds: 2, toSeconds: 3.6 }]); assert.equal(project.shots[0].durationFrames, 108); assert.equal(project.audioClips![0].startSeconds, 0);
  assert.ok(Object.keys(SKILLS).length >= 6 && Object.values(SKILLS).every(s => s.body.length > 80));
  const budget = budgetFrom({}), usage = emptyUsage('CNY');
  assert.match(needsApproval('plan', ['read', 'write'], budget, usage, 0)!, /创作计划/); assert.equal(needsApproval('plan', ['read', 'write', 'plan'], budget, usage, 0), null);
  assert.match(needsApproval('cost', ['read', 'cost'], budget, usage, null, { maxCost: 1, spent: 0.5, unknownCostCalls: 0, currency: 'CNY' })!, /项目费用上限/);
  assert.match(needsApproval('cost', ['read', 'cost'], budget, usage, 0.8, { maxCost: 1, spent: 0.5, unknownCostCalls: 0, currency: 'CNY' })!, /项目上限/);
  const names = activeTools(createTools(), { roles: [] }).map(t => t.name);
  for (const t of ['plan_story', 'plan_shots', 'story_get', 'character_upsert', 'quality_check', 'align_to_voice', 'skill_read']) assert.ok(names.includes(t), t);
  assert.ok(!names.includes('consistency_review') && !names.includes('frame_handoff'));
});

test('plan approval: rejected plans are not saved; approved plan is injected into prompts and generation gets consistency anchors', async () => {
  const d = await mkdtemp(join(tmpdir(), 'agent-story-')); const { port: p, calls } = port({ roles: ['image', 'video'] });
  const gw = toolGateway((body, turn) => {
    const system = body.messages[0].content as string;
    if (turn === 0) { assert.match(system, /还没有已批准的创作计划/); return { toolCalls: [{ id: 'p1', name: 'plan_story', arguments: plan }] }; }
    if (turn === 1) { assert.ok(body.messages.some((m: any) => m.role === 'tool' && /rejected/.test(m.content))); return { toolCalls: [{ id: 'p2', name: 'plan_story', arguments: plan }] }; }
    if (turn === 2) return { toolCalls: [{ id: 'p3', name: 'plan_shots', arguments: shots }] };
    if (turn === 3) { assert.match(system, /已批准的创作计划/); assert.match(system, /雪夜/); return { toolCalls: [{ id: 'g1', name: 'generate_image', arguments: { expectedRevision: 3, prompt: '雪地中的小狐狸', characterIds: ['fox'], shotId: 'a' } }] }; }
    return { text: '完成' };
  });
  const service = new AgentService(d, p, { resolveModel: model, fetch: gw.fetch, maxReviewRounds: 0, pollMs: 5 });
  try {
    const s = await service.start({ projectId: 'p', goal: '做一个雪夜小狐狸短片', autoApprove: ['read', 'write', 'cost'] });
    let run = await settle(service, s.id, ['awaiting_approval', 'failed', 'complete']);
    assert.equal(run.pending?.tool, 'plan_story'); assert.equal(run.pending?.risk, 'plan'); assert.match(run.pending!.reason, /创作计划/);
    await service.reject(s.id, 'p1', (await service.get(s.id)).pending!.execId!, '风格再想想'); assert.equal((await service.story('p')).status, 'empty');
    run = await settle(service, s.id, ['awaiting_approval', 'failed', 'complete']); assert.equal(run.pending?.callId, 'p2'); await service.approve(s.id, 'p2', (await service.get(s.id)).pending!.execId!);
    run = await settle(service, s.id, ['awaiting_approval', 'failed', 'complete']); assert.equal(run.pending?.callId, 'p3'); await service.approve(s.id, 'p3', (await service.get(s.id)).pending!.execId!);
    run = await settle(service, s.id, ['complete', 'failed', 'awaiting_approval']); assert.equal(run.status, 'complete', run.message);
    const story = await service.story('p'); assert.equal(story.status, 'approved'); assert.equal(story.shots.length, 2); assert.equal(story.shots[1].continueFromPrevious, true);
    const gen = calls.find(c => c.endpoint === 'media.generate')!; assert.match(String(gen.payload.prompt), /雪地中的小狐狸\n【一致性锚点】画风：水彩绘本/); assert.match(String(gen.payload.prompt), /红色围巾/);
    await assert.rejects(service.saveStory('p', { characters: [] }, story.version), /仍在使用/);
    const saved = await service.saveStory('p', { characters: [{ ...story.characters[0], referenceAssetIds: ['img'] }] }, story.version); assert.deepEqual(saved.characters[0].referenceAssetIds, ['img']);
    await assert.rejects(service.saveStory('p', { title: 'x' }, story.version), /版本已变化/);
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('consistency review scores shots and only proposes regeneration; frame handoff feeds the next shot', async () => {
  const d = await mkdtemp(join(tmpdir(), 'agent-story-')); const { port: p, calls, imports } = port({ roles: ['video', 'vision'] });
  const gw = toolGateway((_b, turn) => turn === 0 ? { toolCalls: [{ name: 'consistency_review', arguments: {} }] } : turn === 1 ? { toolCalls: [{ name: 'frame_handoff', arguments: { shotId: 'b' } }] } : turn === 2 ? { toolCalls: [{ id: 'v1', name: 'generate_video', arguments: { expectedRevision: 3, prompt: '继续', imageAssetId: 'tail', characterIds: ['fox'] } }] } : { text: 'ok' });
  const service = new AgentService(d, p, { resolveModel: model, fetch: gw.fetch, maxReviewRounds: 0, pollMs: 5 });
  try {
    await service.docs('p').updateStory(s => ({ ...s, ...plan, style: { ...plan.style, typography: '' }, characters: [{ ...plan.characters[0], referenceAssetIds: [] }], status: 'approved', shots: normalizeShots(shots.shots, [{ id: 'fox', name: '', description: '', features: [], referenceAssetIds: [] }]) }));
    const s = await service.start({ projectId: 'p', goal: '检查一致性', allowImages: true });
    const run = await settle(service, s.id, ['awaiting_approval', 'failed', 'complete']);
    assert.equal(run.status, 'awaiting_approval'); assert.equal(run.pending?.tool, 'generate_video');
    const story = await service.story('p'); assert.equal(story.consistency.b.score, 40); assert.equal(story.consistency.a.score, 92);
    const review = run.transcript.find(m => m.role === 'tool' && /proposals/.test(m.content))!; assert.match(review.content, /建议重生/); assert.doesNotMatch(review.content, /"shotId":"a","action"/);
    assert.ok(!calls.some(c => c.endpoint === 'media.generate'), 'no spend before approval');
    assert.deepEqual(imports, ['尾帧承接 · a→b']);
    await service.approve(s.id, 'v1', (await service.get(s.id)).pending!.execId!); await settle(service, s.id, ['complete', 'failed']);
    const gen = calls.find(c => c.endpoint === 'media.generate')!; assert.equal(gen.payload.operation, 'image-to-video'); assert.deepEqual(gen.payload.imageAssetIds, ['tail']);
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('project budget persists across runs and stops spending; export is blocked by QC on black frames', async () => {
  const d = await mkdtemp(join(tmpdir(), 'agent-story-')); const { port: p, calls } = port({ roles: ['music'] }, black);
  let script: 'music' | 'export' = 'music';
  const gw = toolGateway((_b, turn) => script === 'music' ? (turn === 0 ? { toolCalls: [{ id: 'm1', name: 'generate_music', arguments: { prompt: '钢琴' } }] } : { text: 'ok' }) : (turn === 0 ? { toolCalls: [{ id: 'e1', name: 'export_mp4', arguments: {} }] } : { text: '导出被质检拦截' }));
  const service = new AgentService(d, p, { resolveModel: model, fetch: gw.fetch, maxReviewRounds: 0 });
  try {
    await service.setProjectBudget('p', 0.3);
    const s = await service.start({ projectId: 'p', goal: '配乐', autoApprove: ['read', 'write', 'cost'] });
    let run = await settle(service, s.id, ['awaiting_approval', 'failed', 'complete']); assert.equal(run.status, 'awaiting_approval'); assert.match(run.pending!.reason, /项目费用上限/);
    await service.approve(s.id, 'm1', (await service.get(s.id)).pending!.execId!); run = await settle(service, s.id, ['complete', 'failed']); assert.equal(run.status, 'complete');
    let ledger = await service.ledger('p'); assert.equal(ledger.spent, 0.2); assert.deepEqual(ledger.byTool.generate_music, { calls: 1, cost: 0.2 });
    await service.setProjectBudget('p', 0.2);
    gw.reset?.();
    const s2 = await service.start({ projectId: 'p', goal: '再来一段' }); run = await settle(service, s2.id, ['budget_exceeded', 'complete', 'failed', 'awaiting_approval']); assert.equal(run.status, 'budget_exceeded'); assert.match(run.message, /项目累计花费/);
    await service.setProjectBudget('p', null); ledger = await service.ledger('p'); assert.equal(ledger.maxCost, null); assert.equal(ledger.spent, 0.2);
    script = 'export'; gw.reset?.();
    const s3 = await service.start({ projectId: 'p', goal: '导出', autoApprove: ['read', 'write', 'export'] }); run = await settle(service, s3.id, ['complete', 'failed', 'awaiting_approval']);
    assert.equal(run.status, 'complete', run.message); assert.ok(!calls.some(c => c.endpoint === 'export'));
    assert.ok(run.transcript.some(m => m.role === 'tool' && /blocked/.test(m.content) && /全黑/.test(m.content)));
    const qc = await service.lastQc('p'); assert.equal(qc?.pass, false); assert.ok(qc!.issues.some(i => i.check === 'black'));
    const fresh = await service.runQc('p'); assert.equal(fresh.pass, false);
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('app endpoints: story / ledger / budget / qc round-trip and image import for frame handoff', async () => {
  const { createApplication, MemorySecrets } = await import('../src/app/application.ts');
  const directory = await mkdtemp(join(tmpdir(), 'agent-story-app-'));
  const app = await createApplication({ dataDirectory: directory, credentials: new MemorySecrets() });
  const call = async <T,>(endpoint: string, payload: unknown = {}) => { const r = await app.route(endpoint, payload); if (!r.ok) throw new Error(endpoint + ': ' + r.error.message); return r.value as T; };
  try {
    const created = await call<StudioSnapshot>('create', { blank: true, title: '计划' }); const projectId = created.project!.id;
    const story = await call<Story>('story.get', { projectId }); assert.equal(story.status, 'empty');
    const saved = await call<Story>('story.save', { projectId, expectedVersion: story.version, story: { title: '雪夜', characters: [{ id: 'fox', name: '小狐狸', features: ['红围巾'] }] } });
    assert.equal(saved.version, 1); assert.equal(saved.characters[0].name, '小狐狸');
    const ledger = await call<{ maxCost: number | null; spent: number }>('agent.budget.set', { projectId, maxCost: 5 }); assert.equal(ledger.maxCost, 5);
    assert.equal((await call<{ maxCost: number | null }>('agent.ledger', { projectId })).maxCost, 5);
    assert.equal((await call<{ report: unknown }>('agent.qc.last', { projectId })).report, null);
    const r = await app.route('story.save', { projectId, expectedVersion: 0, story: {} }); assert.equal(r.ok, false);
  } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('previz approvals follow the reviewed shot across a draft, workbench approval and process restart', async t => {
  for (const scenario of ['activeChanged', 'depthDraft', 'cameraDraft', 'unrelatedApproved', 'legacy', 'conflict']) {
    await t.test(scenario, async () => {
      const d = await mkdtemp(join(tmpdir(), 'agent-previz-'));
      const { port: testPort, project } = port({ roles: [] });
      const gw = toolGateway((_body, turn) => turn === 0 ? { toolCalls: [{ id: 'review', name: 'submit_previz_review',
        arguments: { summary: '审核第一镜', shots: [{ shotId: 'a', imageAssetId: 'img' }] } }] } : { text: '已收到工具回执' });
      const serviceOptions = { resolveModel: model, fetch: gw.fetch, maxReviewRounds: 0 };
      let service = new AgentService(d, testPort, serviceOptions);
      try {
        const planA: DirectorPlan = {
          version: 1, ruleSetVersion: DIRECTOR_RULESET_VERSION, filmKind: 'general', characters: [], storyBeats: [], worldLayouts: [], identityMap: [],
          shots: ['a', 'b'].map(id => ({ shotId: id, title: '手写导演标题' + id, visualPrompt: '手部特写', camera: '固定', durationSeconds: 2, audioStrategy: 'silent', narration: '',
            performance: [], dialogue: [], events: [], acceptance: [], references: [], previz: { status: 'rendered', imageAssetId: 'img', depthAssetId: 'depthA' } })),
        };
        const draftA = saveDirectorDocument(project, planA, { expectedVersion: 0 });
        project.extensions.directorDocument = draftA;
        const activeA = approveDirectorDocument(project, { expectedVersion: draftA.version, expectedHash: draftA.hash });
        project.extensions.directorDocument = activeA;
        await service.syncFromDirectorPlan('p', activeA.plan, true, activeA);

        const planB = structuredClone(planA);
        if (scenario === 'activeChanged') delete planB.shots[0].previz;
        if (scenario === 'depthDraft') planB.shots[0].previz!.depthAssetId = 'depthB';
        if (scenario === 'cameraDraft') planB.shots[0].camera = '俯拍';
        planB.shots[1].visualPrompt = '修改另一镜';
        const draftB = saveDirectorDocument(project, planB, { expectedVersion: activeA.version });
        project.extensions.directorDocument = draftB;
        const started = await service.start({ projectId: 'p', goal: '审核第一镜预演' });
        const pending = (await settle(service, started.id, ['awaiting_approval', 'failed'])).pending!;
        assert.equal(pending.tool, 'submit_previz_review');
        await service.dispose();
        if (scenario === 'legacy') {
          const file = join(d, started.id + '.json');
          const checkpoint = JSON.parse(await readFile(file, 'utf8'));
          assert.ok(checkpoint.queue[0].previzReview);
          delete checkpoint.queue[0].previzReview;
          await writeFile(file, JSON.stringify(checkpoint));
        }
        service = new AgentService(d, testPort, serviceOptions);
        if (scenario === 'activeChanged' || scenario === 'unrelatedApproved') {
          const activeB = approveDirectorDocument(project, { expectedVersion: draftB.version, expectedHash: draftB.hash });
          project.extensions.directorDocument = activeB;
          await service.syncFromDirectorPlan('p', activeB.plan, true, activeB);
        }
        if (scenario === 'conflict') testPort.commit = async () => { throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' }); };
        await service.approve(started.id, pending.callId, pending.execId, pending.argsHash);
        const final = await settle(service, started.id, ['complete', 'failed']);
        assert.equal(final.status, 'complete', final.message);
        const active = (await service.story('p')).shots[0], doc = readDirectorDocument(project)!;
        assert.equal(doc.plan.shots[0].title, '手写导演标题a');
        assert.deepEqual(doc.plan.shots[1], draftB.plan.shots[1]);
        if (scenario === 'activeChanged' || scenario === 'legacy' || scenario === 'conflict') {
          assert.ok(final.transcript.some(m => m.role === 'tool' && /重新提交预演审阅单|版本已变化/.test(m.content)));
          assert.equal(active.previz?.status, scenario === 'activeChanged' ? undefined : 'rendered');
          assert.deepEqual(doc.plan.shots[0].previz, draftB.plan.shots[0].previz);
        } else {
          assert.equal(active.previz?.status, 'approved');
          assert.equal(doc.plan.shots[0].previz?.status, scenario === 'unrelatedApproved' ? 'approved' : 'rendered');
          assert.equal(doc.plan.shots[0].previz?.depthAssetId, scenario === 'depthDraft' ? 'depthB' : 'depthA');
          assert.equal(doc.plan.shots[0].camera, scenario === 'cameraDraft' ? '俯拍' : '固定');
        }
      } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
    });
  }
});

test('cinematographer receives valid story and bible pages for every layout and location', async () => {
  const d = await mkdtemp(join(tmpdir(), 'agent-section-pages-'));
  const { port: testPort, project } = port({ roles: [] });
  const shotIds = Array.from({ length: 100 }, (_, i) => 'shot-00000000-0000-0000-0000-' + String(i).padStart(12, '0'));
  project.shots = shotIds.map(id => ({ ...project.shots[0], id }));
  project.shotOrder = shotIds;
  project.productionPolicy = { ...defaultProductionPolicy('hybrid'), baseMode: 'code_animation', hybridGrants: [{
    id: 'grant', projectId: project.id, shotIds, operations: ['video'], confirmedAt: new Date(0).toISOString(),
  }] };
  const locations = Array.from({ length: 20 }, (_, i) => ({ id: 'loc' + i, name: '房间' + i, description: '长廊与镜头站位'.repeat(100) }));
  const worldLayouts = Array.from({ length: 12 }, (_, i) => ({ id: 'lay' + i, description: '立面' + i,
    anchors: Array.from({ length: 24 }, (_, j) => ({ id: '演员站位' + j, position: [i, j, 0] as [number, number, number] })) }));
  const characters = Array.from({ length: 24 }, (_, i) => ({ id: 'c' + i, name: '演员' + i, description: '身世背景'.repeat(120), features: [], referenceAssetIds: [] }));
  const parts = new Map<string, string[]>(), seen = new Set<string>();
  const lengths: number[] = [];
  let parentTurn = 0, crewTurn = 0;
  const names = ['story_get', 'bible_get'];
  const gw = toolGateway(body => {
    if (!body.messages[0].content.includes('你正在作为子代理协助总导演')) return parentTurn++ === 0
      ? { toolCalls: [{ name: 'delegate_crew', arguments: { department: 'cinematographer', task: '清点布局与场景母版' } }] }
      : { text: '结束' };
    if (crewTurn++ === 0) return { toolCalls: names.map(name => ({ id: name, name, arguments: {} })) };
    const next = [];
    for (const msg of body.messages.filter((m: { role: string }) => m.role === 'tool')) {
      const id = String(msg.tool_call_id);
      if (seen.has(id)) continue;
      seen.add(id);
      lengths.push(msg.content.length);
      const data = JSON.parse(msg.content), page = data.story ?? data;
      const name = id.split('-')[0];
      if (name === 'bible_get') assert.deepEqual(data.productionPolicy.hybridGrants[0].shotIds, shotIds);
      if (id === name) {
        assert.equal(page.sectionTotals.worldLayouts, 12);
        for (const section of ['locations', 'worldLayouts']) next.push({ id: name + '-' + section + '-0', name, arguments: { section } });
      } else {
        const { section, nextOffset } = page.sectionPagination;
        const key = name + '-' + section;
        parts.set(key, [...parts.get(key) ?? [], ...page[section].map((row: { id: string }) => row.id)]);
        if (nextOffset !== undefined) next.push({ id: key + '-' + nextOffset, name, arguments: { section, offset: nextOffset } });
      }
    }
    return next.length ? { toolCalls: next } : { text: '清点完成' };
  });
  const service = new AgentService(d, testPort, { resolveModel: model, fetch: gw.fetch, maxReviewRounds: 0 });
  try {
    await service.docs('p').updateStory(s => ({ ...s, locations, worldLayouts, characters, shots: normalizeShots([{ summary: '全景', durationSeconds: 2 }], characters) }));
    const r = await service.start({ projectId: 'p', goal: '委派摄影读取圣经' });
    assert.equal((await settle(service, r.id, ['complete', 'failed'])).status, 'complete');
    for (const name of names) {
      assert.deepEqual(parts.get(name + '-locations'), locations.map(row => row.id));
      assert.deepEqual(parts.get(name + '-worldLayouts'), worldLayouts.map(row => row.id));
    }
    assert.ok(lengths.every(n => n <= 12_000));
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});
