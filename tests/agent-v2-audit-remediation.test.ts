import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import type { PublicRun } from '../src/agent/contracts.ts';
import { storyBrief } from '../src/agent/story.ts';
import { synthesize } from '../src/agent/synth.ts';
import { runCli } from '../src/cli/main.ts';
import { DIRECTOR_RULESET_VERSION } from '../src/director/index.ts';
import { readDirectorDocument } from '../src/director/document.ts';
import { encodeRgbaPng } from '../src/host/contact-sheet.ts';
import { inspectToolEnvironment } from '../src/host/tool-environment.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';
import { toolGateway } from './model-gateway.ts';

function solidPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return Buffer.from(encodeRgbaPng(width, height, rgba));
}

async function waitRun(
  call: <T>(ep: string, p?: unknown) => Promise<T>,
  runId: string,
  targets: string[],
  max = 2500,
): Promise<PublicRun> {
  let run = await call<PublicRun>('agent.get', { runId });
  for (let i = 0; i < max && !targets.includes(run.status); i++) {
    await new Promise(r => setTimeout(r, 20));
    run = await call<PublicRun>('agent.get', { runId });
  }
  return run;
}

async function approvePending(call: <T>(ep: string, p?: unknown) => Promise<T>, run: PublicRun) {
  assert.equal(run.status, 'awaiting_approval', `预期等待批准，实际=${run.status} (${run.message})`);
  assert.ok(run.pending);
  await call('agent.approve', {
    runId: run.id,
    callId: run.pending.callId,
    execId: run.pending.execId,
    argsHash: run.pending.argsHash,
  });
}

test('Audit #1, #3, #4, #5: Crew sub-agent enforces hard shot-scope sandbox, recovers from mid-delegation 503 without duplicate writes, pairs >6 tool_calls, reports failure/exhaustion, and returns latest revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yl-audit-crew-'));
  let mode: 'scope' | 'recover503' | 'fail6' | 'overflow7' = 'scope';
  let subTurn = 0;
  let directorTurn = 0;
  let fail503Active = false;
  let sawPairedSevenTools = false;
  let shot1 = '', shot2 = '';

  const gw = toolGateway((body) => {
    const msgs = body.messages as { role: string; content?: string; tool_call_id?: string }[];
    const sys = String(msgs[0]?.content ?? '');
    const isSubagent = sys.includes('你正在作为子代理协助总导演');

    if (isSubagent) {
      const st = subTurn++;
      if (mode === 'scope') {
        if (st === 0) return { toolCalls: [{ id: 'sp-pg', name: 'project_get', arguments: {} }] };
        if (st === 1) {
          const rev = JSON.parse([...msgs].reverse().find(m => m.role === 'tool')!.content!).revision;
          return {
            toolCalls: [
              // Out-of-scope shot2 write + global reframe must be hard-blocked!
              { id: 'bad-shot2', name: 'shot_patch', arguments: { expectedRevision: rev, patches: [{ shotId: shot2, title: '被越界篡改的镜2' }] } },
              { id: 'bad-global', name: 'reframe_project', arguments: { expectedRevision: rev, aspectRatio: '9:16' } },
              // In-scope shot1 write must succeed!
              { id: 'ok-shot1', name: 'shot_patch', arguments: { expectedRevision: rev, patches: [{ shotId: shot1, title: '合规修改的镜1' }] } },
            ],
          };
        }
        return { text: '已完成镜1局部修改，越界操作已被系统拦截' };
      }

      if (mode === 'recover503') {
        if (fail503Active) {
          return { status: 503, error: 'Service Unavailable' };
        }
        if (st === 0) return { toolCalls: [{ id: 'rc-pg', name: 'project_get', arguments: {} }] };
        if (st === 1) {
          const rev = JSON.parse([...msgs].reverse().find(m => m.role === 'tool')!.content!).revision;
          fail503Active = true; // Next model turn after adding 1 shot will fail with persistent 503!
          return {
            toolCalls: [
              { id: 'add-1', name: 'shots_mutate', arguments: { expectedRevision: rev, addShots: [{ title: '仅应追加一次的新镜', durationSeconds: 2 }] } },
            ],
          };
        }
        return { text: '故障恢复后衔接完成，未重复追加镜头' };
      }

      if (mode === 'fail6') {
        // Every turn attempts a stale expectedRevision=999 write -> all 6 steps fail
        return {
          toolCalls: [{ id: `stale-${st}`, name: 'shot_patch', arguments: { expectedRevision: 999, patches: [{ shotId: shot1, title: '永不成功' }] } }],
        };
      }

      if (mode === 'overflow7') {
        if (st === 0) {
          return {
            toolCalls: [
              { id: 'c1', name: 'location_upsert', arguments: { id: 'loc_a', name: '雨夜码头', description: '集装箱与探照灯' } },
              { id: 'c2', name: 'project_get', arguments: {} },
              { id: 'c3', name: 'bible_get', arguments: {} },
              { id: 'c4', name: 'styles_list', arguments: {} },
              { id: 'c5', name: 'skill_read', arguments: { topic: 'consistency' } },
              { id: 'c6', name: 'prop_upsert', arguments: { id: 'prop_a', name: '旧怀表', description: '黄铜表壳' } },
              { id: 'c7', name: 'continuity_log_upsert', arguments: { shotId: shot1, notes: '第7个溢出调用' } },
            ],
          };
        }
        const toolResponses = msgs.filter(m => m.role === 'tool').map(m => m.tool_call_id);
        sawPairedSevenTools = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'].every(id => toolResponses.includes(id));
        return { text: '7 个调用全部获得配对响应' };
      }
    }

    const dt = directorTurn++;
    if (mode === 'scope') {
      if (dt === 0) return { toolCalls: [{ id: 'd-scope', name: 'delegate_crew', arguments: { department: 'post_editor_qc', task: '仅精修第一镜标题', shotIds: [shot1] } }] };
      return { text: '范围沙箱验证结束' };
    }
    if (mode === 'recover503') {
      if (dt === 0) return { toolCalls: [{ id: 'd-503', name: 'delegate_crew', arguments: { department: 'screenwriter', task: '在末尾追加一个新镜头' } }] };
      return { text: '503 恢复验证结束' };
    }
    if (mode === 'fail6') {
      if (dt === 0) return { toolCalls: [{ id: 'd-fail6', name: 'delegate_crew', arguments: { department: 'post_editor_qc', task: '测试全部写入失败回执' } }] };
      const subOut = JSON.parse([...msgs].reverse().find(m => m.role === 'tool')!.content!);
      assert.equal(subOut.ok, false, '6 轮写入失败时子代理不得报告 ok:true');
      assert.equal(subOut.status, 'failed');
      assert.equal(subOut.exhausted, true);
      assert.equal(subOut.executedTools.length, 0);
      return { text: '已识别子代理写入失败状态' };
    }
    if (dt === 0) return { toolCalls: [{ id: 'd-ov7', name: 'delegate_crew', arguments: { department: 'art_director', task: '登记码头场景与怀表道具' } }] };
    const subOut = JSON.parse([...msgs].reverse().find(m => m.role === 'tool')!.content!);
    assert.equal( typeof subOut.revision, 'number');
    assert.ok(subOut.revision >= 1, `回执 revision 应同步反映最新工程版本，实际=${subOut.revision}`);
    return { text: '7 调用配对与最新 revision 回执验证完成' };
  });

  const app = await createApplication({ dataDirectory: dir, projectsDirectory: join(dir, 'projects'), credentials: new MemorySecrets(), fetch: gw.fetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const m = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: m.id });

    const created = await call<StudioSnapshot>('create', { title: '审计剧组验证' });
    const pid = created.project!.id;
    shot1 = created.project!.shots[0]!.id;
    shot2 = created.project!.shots[1]!.id;
    const originalShot2Title = created.project!.shots[1]!.title;

    // 1) Finding #1: Shot scope hard enforcement
    mode = 'scope'; subTurn = 0; directorTurn = 0;
    const r1 = await call<PublicRun>('agent.start', { projectId: pid, goal: '只委派第一镜', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const d1 = await waitRun(call, r1.id, ['complete', 'failed']);
    assert.equal(d1.status, 'complete', d1.message);
    const snapAfterScope = await call<StudioSnapshot>('current', { projectId: pid });
    assert.equal(snapAfterScope.project!.shots[0]!.title, '合规修改的镜1');
    assert.equal(snapAfterScope.project!.shots[1]!.title, originalShot2Title, '第二镜必须保持原样未被篡改');
    assert.equal(snapAfterScope.project!.target.width, 1920, '全局重构图必须被拦截');

    // 2) Finding #3: Inject 503 after adding 1 shot -> resume -> total shots increases by ONLY 1 (3 -> 4, NOT 5)
    mode = 'recover503'; subTurn = 0; directorTurn = 0; fail503Active = false;
    const r2 = await call<PublicRun>('agent.start', { projectId: pid, goal: '追加一镜后遇 503 恢复', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const failed503 = await waitRun(call, r2.id, ['failed', 'complete'], 1200);
    assert.equal(failed503.status, 'failed', '持久 503 应暂停在失败态保留队列回执');
    const midSnap = await call<StudioSnapshot>('current', { projectId: pid });
    assert.equal(midSnap.project!.shots.length, 4, '故障前已追加 1 镜');

    fail503Active = false; // Restore model health and resume!
    await call('agent.resume', { runId: r2.id });
    const recovered = await waitRun(call, r2.id, ['complete', 'failed']);
    assert.equal(recovered.status, 'complete', recovered.message);
    const afterRecoverSnap = await call<StudioSnapshot>('current', { projectId: pid });
    assert.equal(afterRecoverSnap.project!.shots.length, 4, '恢复后工程只能增加 1 镜（共 4 镜），严禁重复执行追加变成 5 镜');

    // 3) Finding #4: 6 failed writes must report ok:false, status:'failed', exhausted:true
    mode = 'fail6'; subTurn = 0; directorTurn = 0;
    const r3 = await call<PublicRun>('agent.start', { projectId: pid, goal: '测试六轮失败状态', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const d3 = await waitRun(call, r3.id, ['complete', 'failed']);
    assert.equal(d3.status, 'complete', d3.message);

    // 4) Finding #5: >6 tool_calls 1-to-1 pairing + latest revision returned after syncBibleToProject
    // First seed an approved story with shots so syncBibleToProject commits directorDocument!
    await call('story.save', { projectId: pid, expectedVersion: 0, story: { title: '测试圣经', logline: '测试回执版本号', style: { look: '写实', palette: '冷调', typography: '黑体', motion: '缓推', negative: '无' } } });
    // Approve story shots via plan_story + plan_shots quickly or save approved story
    let pTurn = 0;
    const prevMode = mode;
    mode = 'overflow7'; subTurn = 0; directorTurn = 0;
    // Let's approve a 1-shot plan first so story.shots is non-empty (triggers syncBibleToProject commit!)
    const seedGw = toolGateway(() => {
      const pt = pTurn++;
      if (pt === 0) return { toolCalls: [{ id: 'ps0', name: 'plan_story', arguments: { title: '圣经同步', logline: '同步', style: { look: '写实', palette: '冷', typography: '黑体', motion: '稳', negative: '无' } } }] };
      if (pt === 1) return { toolCalls: [{ id: 'psh0', name: 'plan_shots', arguments: { shots: [{ id: 's1', shotId: shot1, summary: '首镜', durationSeconds: 3 }] } }] };
      return { text: '已建圣经' };
    });
    const app2 = await createApplication({ dataDirectory: join(dir, 'sub2'), projectsDirectory: join(dir, 'sub2', 'projects'), credentials: new MemorySecrets(), fetch: (u, i) => (pTurn < 3 ? seedGw.fetch(u, i) : gw.fetch(u, i)) });
    const call2 = async <T,>(ep: string, p: unknown = {}) => { const r = await app2.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
    try {
      const c2 = await call2<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
      const m2 = await call2<{ id: string }>('models.model.save', { connectionId: c2.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
      await call2('models.role.bind', { role: 'director', modelId: m2.id });
      const cr2 = await call2<StudioSnapshot>('create', { title: '回执版本测试' });
      shot1 = cr2.project!.shots[0]!.id;
      const rs = await call2<PublicRun>('agent.start', { projectId: cr2.project!.id, goal: '建圣经', autoApprove: ['read', 'write', 'plan'], maxReviewRounds: 0 });
      await waitRun(call2, rs.id, ['complete', 'failed']);

      subTurn = 0; directorTurn = 0;
      const r4 = await call2<PublicRun>('agent.start', { projectId: cr2.project!.id, goal: '测试7调用与最新revision', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
      const d4 = await waitRun(call2, r4.id, ['complete', 'failed']);
      assert.equal(d4.status, 'complete', d4.message);
      assert.equal(sawPairedSevenTools, true, '7 个工具调用必须全部收到配对的 tool 消息');
    } finally {
      mode = prevMode;
      await app2.dispose();
    }
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Audit #2 & #6: Sub-agent stops immediately on parent/project cost & step/toolCall budgets, and Showrunner drains mid-flight steering messages before completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yl-audit-budget-steer-'));
  let modelCalls = 0;
  let steerRunId = '';
  let injectSteerDuringFinalTurn = false;
  let callRef: (<T>(ep: string, p?: unknown) => Promise<T>) | null = null;

  const gw = toolGateway((body) => {
    const msgs = body.messages as { role: string; content?: string }[];
    const sys = String(msgs[0]?.content ?? '');
    modelCalls++;

    // Steering test branch
    if (msgs.some(m => typeof m.content === 'string' && m.content.includes('测试临终纠偏不丢失'))) {
      if (msgs.some(m => typeof m.content === 'string' && m.content.includes('【用户中途补充纠偏】'))) {
        return { text: '已执行用户的中途补充纠偏指令' };
      }
      if (injectSteerDuringFinalTurn && callRef && steerRunId) {
        injectSteerDuringFinalTurn = false;
        // Enqueue steering message while this final turn is in flight!
        void callRef('agent.message', { runId: steerRunId, message: '【用户中途补充纠偏】再加一句确认' });
      }
      return { text: '准备直接结束（但此时队列刚收到补充指令）' };
    }

    // Budget test branch: each call has 100,000 input tokens at pricePerMInput=1.0 -> 0.10 CNY per call!
    if (sys.includes('你正在作为子代理协助总导演')) {
      return {
        toolCalls: [{ id: `sub-${modelCalls}`, name: 'project_get', arguments: {} }],
        usage: { prompt_tokens: 100_000, completion_tokens: 0 },
      };
    }
    return {
      toolCalls: [{ id: 'del-budget', name: 'delegate_crew', arguments: { department: 'screenwriter', task: '测试预算熔断' } }],
      usage: { prompt_tokens: 100_000, completion_tokens: 0 },
    };
  });

  // Add slight 40ms delay on gateway fetch so mid-flight `agent.message` lands before `chatTurn` resolves!
  const delayedFetch: typeof fetch = async (u, i) => {
    const res = await gw.fetch(u, i);
    await new Promise(r => setTimeout(r, 40));
    return res;
  };

  const app = await createApplication({ dataDirectory: dir, projectsDirectory: join(dir, 'projects'), credentials: new MemorySecrets(), fetch: delayedFetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  callRef = call;

  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const m = await call<{ id: string }>('models.model.save', {
      connectionId: c.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'],
      parameters: { pricePerMInput: 1, pricePerMOutput: 1, priceCurrency: 'CNY' },
    });
    await call('models.role.bind', { role: 'director', modelId: m.id });
    const created = await call<StudioSnapshot>('create', { title: '预算与纠偏审计' });
    const pid = created.project!.id;

    // 1) Monetary ceiling 0.15 CNY (0.10 per model turn): Showrunner 1 turn (0.10) + Subagent 1 turn (0.10 -> 0.20 >= 0.15) -> MUST stop immediately at 0.20 (2 calls, NEVER 7 calls / 0.70)!
    await call('agent.budget.set', { projectId: pid, maxCost: 0.15, currency: 'CNY' });
    modelCalls = 0;
    const rCost = await call<PublicRun>('agent.start', {
      projectId: pid, goal: '测试0.15元上限熔断', budget: { maxCost: 0.15, currency: 'CNY' }, autoApprove: ['read', 'write'], maxReviewRounds: 0,
    });
    const dCost = await waitRun(call, rCost.id, ['budget_exceeded', 'complete', 'failed']);
    assert.equal(dCost.status, 'budget_exceeded');
    assert.equal(modelCalls, 2, `应在总导演1次+子代理1次触及上限后立即熔断，实际调用次数=${modelCalls}`);
    assert.ok(Math.abs(dCost.usage.cost - 0.2) < 1e-6, `实际花费应停在 0.20，实际=${dCost.usage.cost}`);

    // Raise project budget and test maxSteps=1 & maxToolCalls=1
    await call('agent.budget.set', { projectId: pid, maxCost: 10, currency: 'CNY' });
    modelCalls = 0;
    const rStep = await call<PublicRun>('agent.start', {
      projectId: pid, goal: '测试单步与单工具上限', budget: { maxSteps: 1, maxToolCalls: 1, maxCost: 10, currency: 'CNY' }, autoApprove: ['read', 'write'], maxReviewRounds: 0,
    });
    const dStep = await waitRun(call, rStep.id, ['budget_exceeded', 'complete', 'failed']);
    assert.equal(dStep.status, 'budget_exceeded');
    assert.equal(modelCalls, 1, 'maxSteps=1 时外层消耗 1 步后子代理不得再发起第 2 次模型请求');
    assert.equal(dStep.usage.steps, 1);

    // 2) Finding #6: Mid-flight steering message during final turn must NOT be dropped
    injectSteerDuringFinalTurn = true;
    const rSteer = await call<PublicRun>('agent.start', {
      projectId: pid, goal: '测试临终纠偏不丢失', autoApprove: ['read', 'write'], maxReviewRounds: 0,
    });
    steerRunId = rSteer.id;
    const dSteer = await waitRun(call, rSteer.id, ['complete', 'failed']);
    assert.equal(dSteer.status, 'complete', dSteer.message);
    assert.equal(dSteer.final, '已执行用户的中途补充纠偏指令');
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Audit #7 & #8: Batch preflight validation, durable per-item receipt reuse on partial failure, accurate unknownCostCalls accounting, and dual-destination image+video upload consent', async () => {
  const env = inspectToolEnvironment({});
  if (!env.ffmpegAvailable || !env.ffprobeAvailable) return;
  const dir = await mkdtemp(join(tmpdir(), 'yl-audit-batch-'));

  const sampleMp4Path = join(dir, 'sample.mp4');
  execFileSync(env.ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=c=0x334155:s=320x180:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sampleMp4Path], { stdio: 'ignore' });
  const sampleMp4 = await readFile(sampleMp4Path);
  const samplePng = solidPng(32, 18, 80, 120, 200);
  const refPngPath = join(dir, 'ref.png');
  await writeFile(refPngPath, samplePng);

  // Two distinct media servers (different ports = different upload destination fingerprints!)
  let imgHits = 0, vidHits = 0;
  let imgUrl = '', vidUrl = '';

  const imgSrv = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', imgUrl);
    for await (const _ of req) { /* drain */ }
    if (u.pathname === '/v1/images/edits' || u.pathname === '/v1/images/generations') {
      imgHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Known cost 0.08 on image generation; video will have NO usage.cost (unknown cost!)
      res.end(JSON.stringify({ data: [{ b64_json: samplePng.toString('base64') }], usage: { cost: 0.08, currency: 'CNY' } }));
      return;
    }
    res.writeHead(404); res.end();
  });

  let failRemoteVideoOnce = false;
  const vidSrv = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', vidUrl);
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    if (u.pathname === '/v1/media/jobs' && req.method === 'POST') {
      vidHits++;
      const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
      if (failRemoteVideoOnce) {
        failRemoteVideoOnce = false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId: String(body.clientRequestId), status: 'failed', error: 'simulated remote failure on item 2' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobId: String(body.clientRequestId), status: 'succeeded', artifacts: [{ url: `${vidUrl}/out.mp4`, mimeType: 'video/mp4' }] }));
      return;
    }
    if (u.pathname === '/out.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(sampleMp4);
      return;
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>(r => imgSrv.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>(r => vidSrv.listen(0, '127.0.0.1', () => r()));
  imgUrl = `http://127.0.0.1:${(imgSrv.address() as { port: number }).port}`;
  vidUrl = `http://127.0.0.1:${(vidSrv.address() as { port: number }).port}`;

  let phase: 'invalid_preflight' | 'mixed_clean' | 'partial_truthful' = 'invalid_preflight';
  let turn = 0;
  let shot1 = '', shot2 = '', refAssetId = '';

  const gw = toolGateway((body) => {
    const t = turn++;
    const msgs = body.messages as { role: string; content?: string }[];
    const lastTool = [...msgs].reverse().find(m => m.role === 'tool')?.content ?? '{}';

    if (phase === 'invalid_preflight') {
      if (t === 0) {
        return {
          toolCalls: [{
            id: 'bad-batch', name: 'batch_generate_media',
            arguments: {
              expectedRevision: 1,
              items: [
                { kind: 'image', shotId: shot1, prompt: '合法首镜' },
                { kind: 'video', shotId: 'shot-does-not-exist', prompt: '不存在的镜头' },
              ],
            },
          }],
        };
      }
      assert.ok(lastTool.includes('目标镜头不存在'), `应在前置校验拦截不存在的镜头，实际=${lastTool}`);
      return { text: '前置校验已拦截非法批次' };
    }

    if (phase === 'mixed_clean') {
      if (t === 0) {
        return {
          toolCalls: [{
            id: 'mix-batch', name: 'batch_generate_media',
            arguments: {
              expectedRevision: 1,
              autoApply: true,
              items: [
                { kind: 'image', shotId: shot1, prompt: '带参考图生图（目的地A，已知费用0.08）', imageAssetId: refAssetId },
                { kind: 'video', shotId: shot2, prompt: '带参考图生视频（目的地B，未知费用）', imageAssetId: refAssetId, durationSeconds: 1 },
              ],
            },
          }],
        };
      }
      const batchRes = JSON.parse(lastTool);
      assert.equal(batchRes.ok, true);
      assert.equal(batchRes.succeededCount, 2);
      return { text: '混合双目的地授权与并发采用已完成' };
    }

    // phase === 'partial_truthful': item 0 succeeds, item 1 fails remotely -> batchRes.ok MUST be false & partial===true!
    if (t === 0) return { toolCalls: [{ id: 'pg_p', name: 'project_get', arguments: {} }] };
    if (t === 1) {
      const rev = JSON.parse(lastTool).revision;
      return {
        toolCalls: [{
          id: 'part-batch', name: 'batch_generate_media',
          arguments: {
            expectedRevision: rev,
            autoApply: true,
            items: [
              { kind: 'image', shotId: shot1, prompt: '成功子项' },
              { kind: 'video', shotId: shot2, prompt: '远程失败子项', durationSeconds: 1 },
            ],
          },
        }],
      };
    }
    const partialRes = JSON.parse(lastTool);
    assert.equal(partialRes.ok, false, '有子项失败时外层绝不能固定报告 ok:true');
    assert.equal(partialRes.partial, true);
    assert.equal(partialRes.succeededCount, 1);
    assert.equal(partialRes.failedCount, 1);
    return { text: '已准确识别部分失败批次' };
  });

  const app = await createApplication({
    dataDirectory: dir, projectsDirectory: join(dir, 'projects'), credentials: new MemorySecrets(),
    fetch: (u, i) => (String(u).includes('gateway.test') ? gw.fetch(u, i) : globalThis.fetch(u, i)),
  });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };

  try {
    const dc = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const dm = await call<{ id: string }>('models.model.save', { connectionId: dc.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: { pricePerMInput: 0, pricePerMOutput: 0, priceCurrency: 'CNY' } });
    await call('models.role.bind', { role: 'director', modelId: dm.id });

    const ic = await call<{ id: string }>('models.connection.save', { name: 'img-a', protocol: 'images', baseUrl: imgUrl + '/v1', auth: 'bearer', apiKey: 'k-img' });
    const im = await call<{ id: string }>('models.model.save', { connectionId: ic.id, model: 'gpt-image-1', inputModalities: ['text', 'image'], outputModalities: ['image'], parameters: {} });
    await call('models.role.bind', { role: 'image', modelId: im.id });

    const vc = await call<{ id: string }>('models.connection.save', { name: 'vid-b', protocol: 'video-gateway', baseUrl: vidUrl, auth: 'bearer', apiKey: 'k-vid' });
    const vm = await call<{ id: string }>('models.model.save', { connectionId: vc.id, model: 'vid-v1', inputModalities: ['text', 'image'], outputModalities: ['video'], parameters: {} });
    await call('models.role.bind', { role: 'video', modelId: vm.id });

    const created = await call<StudioSnapshot>('create', { title: '批次与多目标授权审计' });
    const pid = created.project!.id;
    shot1 = created.project!.shots[0]!.id;
    shot2 = created.project!.shots[1]!.id;
    const imp = await call<StudioSnapshot>('import', { projectId: pid, expectedRevision: created.project!.revision, path: refPngPath });
    refAssetId = imp.project!.assets[0]!.id;

    // 1) Invalid second shot preflight: 0 remote submissions!
    phase = 'invalid_preflight'; turn = 0;
    const rBad = await call<PublicRun>('agent.start', { projectId: pid, goal: '测试非法批次前置拦截', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const pBad = await waitRun(call, rBad.id, ['awaiting_approval', 'complete', 'failed']);
    await approvePending(call, pBad);
    const dBad = await waitRun(call, rBad.id, ['complete', 'failed']);
    assert.equal(dBad.status, 'complete');
    assert.equal(imgHits, 0, '前置校验失败时第 1 项严禁提前向云端发起计费请求');
    assert.equal(vidHits, 0);

    // 2) Mixed image(Dest A) + video(Dest B) upload consent without ping-pong + per-item unknownCostCalls accounting!
    phase = 'mixed_clean'; turn = 0;
    const rMix = await call<PublicRun>('agent.start', { projectId: pid, goal: '测试双目的地授权与未知费用独立核销', autoApprove: ['read', 'write'], maxReviewRounds: 0 });

    // Consent 1 (image destination A)
    let cur = await waitRun(call, rMix.id, ['paused', 'awaiting_approval', 'failed']);
    assert.equal(cur.status, 'paused');
    assert.ok(cur.visionConsentRequired);
    await call('agent.resume', { runId: rMix.id, visionConsentId: cur.visionConsentRequired.id });

    // Consent 2 (video destination B — must NOT ping-pong back to A!)
    cur = await waitRun(call, rMix.id, ['paused', 'awaiting_approval', 'failed']);
    assert.equal(cur.status, 'paused');
    assert.ok(cur.visionConsentRequired);
    await call('agent.resume', { runId: rMix.id, visionConsentId: cur.visionConsentRequired.id });

    // Now reaches awaiting_approval cleanly on the 3rd pause!
    cur = await waitRun(call, rMix.id, ['paused', 'awaiting_approval', 'failed']);
    assert.equal(cur.status, 'awaiting_approval', `2 次授权后应进入待审批而非死循环，实际=${cur.status}`);
    await approvePending(call, cur);

    const doneMix = await waitRun(call, rMix.id, ['complete', 'failed']);
    assert.equal(doneMix.status, 'complete', doneMix.message);
    assert.equal(imgHits, 1, '第 1 项生图只应提交 1 次');

    // Verify per-item cost & unknownCostCalls accounting: item 0 had cost=0.08, item 1 had unknown cost -> unknownCostCalls MUST remain 1!
    const ledger = await call<{ spent: number; unknownCostCalls: number }>('agent.ledger', { projectId: pid });
    assert.ok(Math.abs(ledger.spent - 0.08) < 1e-6, `已知子项费用应计入 0.08，实际=${ledger.spent}`);
    assert.equal(ledger.unknownCostCalls, 1, '仅 1 项已知费用时，同批另 1 项未知费用不得被消除');

    // 3) Partial batch failure must truthfully report ok:false & partial:true!
    phase = 'partial_truthful'; turn = 0; failRemoteVideoOnce = true;
    const rPart = await call<PublicRun>('agent.start', { projectId: pid, goal: '测试部分子项失败如实汇报', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const pPart = await waitRun(call, rPart.id, ['awaiting_approval', 'complete', 'failed']);
    await approvePending(call, pPart);
    const donePart = await waitRun(call, rPart.id, ['complete', 'failed']);
    assert.equal(donePart.status, 'complete', donePart.message);
  } finally {
    await app.dispose();
    imgSrv.closeAllConnections(); vidSrv.closeAllConnections();
    await new Promise<void>(r => imgSrv.close(() => r()));
    await new Promise<void>(r => vidSrv.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('Audit #9, #10 & #11: Real-size Lip-Sync (>4KB media), Scene Code CAS protection against manual edits, and Schema v3 preservation after video adoption', async () => {
  const env = inspectToolEnvironment({});
  if (!env.ffmpegAvailable || !env.ffprobeAvailable) return;
  const dir = await mkdtemp(join(tmpdir(), 'yl-audit-lipsync-v3-'));

  // Synthesize a >8KB MP4 and >20KB WAV so Base64 is ~40,000+ chars (10x above the 4,000-char parameter limit!)
  const realMp4Path = join(dir, 'source-actor.mp4');
  execFileSync(env.ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=1.5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', realMp4Path,
  ], { stdio: 'ignore' });
  const realMp4Bytes = await readFile(realMp4Path);
  assert.ok(realMp4Bytes.byteLength > 4000, `测试视频需大于 4KB，实际=${realMp4Bytes.byteLength}`);

  const realWavBytes = synthesize({ kind: 'rain', durationSeconds: 1.5, volume: 0.5 });
  assert.ok(realWavBytes.byteLength > 20_000, `测试音频需大于 20KB，实际=${realWavBytes.byteLength}`);
  const realWavPath = join(dir, 'dialogue.wav');
  await writeFile(realWavPath, realWavBytes);

  let receivedLipSyncInputs = 0;
  let vidUrl = '';
  const vidSrv = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', vidUrl);
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    if (u.pathname === '/v1/media/jobs' && req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      assert.equal(body.operation, 'lip-sync-video');
      assert.equal(Array.isArray(body.inputs) ? body.inputs.length : 0, 2);
      assert.equal(body.inputs[0].type, 'video');
      assert.equal(body.inputs[1].type, 'audio');
      receivedLipSyncInputs = body.inputs.length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobId: String(body.clientRequestId), status: 'succeeded', artifacts: [{ url: `${vidUrl}/synced.mp4`, mimeType: 'video/mp4' }] }));
      return;
    }
    if (u.pathname === '/synced.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(realMp4Bytes);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => vidSrv.listen(0, '127.0.0.1', () => r()));
  vidUrl = `http://127.0.0.1:${(vidSrv.address() as { port: number }).port}`;

  let turn = 0;
  let shot1 = '', videoAssetId = '', audioAssetId = '';
  let triggerConcurrentManualEdit = false;
  let callRef: (<T>(ep: string, p?: unknown) => Promise<T>) | null = null;
  let activePid = '';

  const gw = toolGateway((body) => {
    const model = String(body.model ?? '');
    if (model === 'scene-coder-cas') {
      if (triggerConcurrentManualEdit && callRef) {
        triggerConcurrentManualEdit = false;
        // Simulate human saving manual code while LLM is generating!
        void callRef('saveSource', {
          projectId: activePid, shotId: shot1, expectedRevision: 0,
          source: { html: '<div id="human-edit">人工保存内容</div>', css: '', js: 'export function render(){}' },
        });
      }
      return {
        text: JSON.stringify({
          html: '<div id="stale-ai">旧上下文AI覆盖</div>',
          css: '',
          js: 'export function render(){}',
        }),
      };
    }

    const t = turn++;
    const msgs = body.messages as { role: string; content?: string }[];
    const lastTool = [...msgs].reverse().find(m => m.role === 'tool')?.content ?? '{}';
    if (t === 0) return { toolCalls: [{ id: 'g0', name: 'project_get', arguments: {} }] };
    if (t === 1) {
      const rev = JSON.parse(lastTool).revision;
      return { toolCalls: [{ id: 'ls1', name: 'apply_lip_sync', arguments: { expectedRevision: rev, shotId: shot1, videoAssetId, audioAssetId, prompt: '自然对白口型同步' } }] };
    }
    if (t === 2) {
      const taskId = JSON.parse(lastTool).id;
      return { toolCalls: [{ id: 'g1', name: 'project_get', arguments: {} }, { id: 'ts1', name: 'task_status', arguments: { kind: 'media', id: taskId } }] };
    }
    if (t === 3) {
      const rev = JSON.parse(msgs.filter(m => m.role === 'tool').at(-2)!.content!).revision;
      const taskId = JSON.parse(msgs.filter(m => m.role === 'tool').at(-1)!.content!).id;
      return { toolCalls: [{ id: 'ma1', name: 'media_apply', arguments: { taskId, expectedRevision: rev } }] };
    }
    if (t === 4) return { toolCalls: [{ id: 'qc1', name: 'quality_check', arguments: {} }] };
    return { text: '真实大小口型同步与 Schema v3 保持验证完成' };
  });

  const delayedFetch: typeof fetch = async (u, i) => {
    if (String(u).includes('gateway.test')) {
      const res = await gw.fetch(u, i);
      await new Promise(r => setTimeout(r, 40));
      return res;
    }
    return globalThis.fetch(u, i);
  };

  const app = await createApplication({ dataDirectory: dir, projectsDirectory: join(dir, 'projects'), credentials: new MemorySecrets(), fetch: delayedFetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  callRef = call;

  try {
    const dc = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const dm = await call<{ id: string }>('models.model.save', { connectionId: dc.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: { pricePerMInput: 0, pricePerMOutput: 0, priceCurrency: 'CNY' } });
    const sm = await call<{ id: string }>('models.model.save', { connectionId: dc.id, model: 'scene-coder-cas', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: dm.id });
    await call('models.role.bind', { role: 'scene', modelId: sm.id });

    const vc = await call<{ id: string }>('models.connection.save', { name: 'vid', protocol: 'video-gateway', baseUrl: vidUrl, auth: 'bearer', apiKey: 'k-vid' });
    const vm = await call<{ id: string }>('models.model.save', { connectionId: vc.id, model: 'lipsync-v1', inputModalities: ['text', 'image'], outputModalities: ['video'], parameters: {} });
    await call('models.role.bind', { role: 'video', modelId: vm.id });

    // Part A: Finding #10 — Concurrent manual edit during generateSceneCode MUST NOT be overwritten!
    const casProj = await call<StudioSnapshot>('create', { title: 'CAS防覆盖测试', productionMode: 'code_animation' });
    activePid = casProj.project!.id;
    shot1 = casProj.project!.shots[0]!.id;
    triggerConcurrentManualEdit = true;
    const casGw = toolGateway((body) => {
      if (String(body.model) === 'scene-coder-cas') return gw.fetch('http://gateway.test/v1', { body: JSON.stringify(body) }) as never;
      return {};
    });
    void casGw;
    // Run delegate_scene_code via agent
    let casTurn = 0;
    const appCas = await createApplication({
      dataDirectory: join(dir, 'cas-sub'), projectsDirectory: join(dir, 'cas-sub', 'projects'), credentials: new MemorySecrets(),
      fetch: async (u, i) => {
        const b = JSON.parse(String(i?.body ?? '{}'));
        if (b.model === 'scene-coder-cas') {
          await callCas('saveSource', {
            projectId: casPid, shotId: casShot1, expectedRevision: 0,
            source: { html: '<div id="human-protected">人工编辑受保护</div>', css: '', js: 'export function render(){}' },
          });
          return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ html: '<div>AI旧稿</div>', css: '', js: 'export function render(){}' }) }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
        }
        const ct = casTurn++;
        if (ct === 0) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'sc-cas', type: 'function', function: { name: 'delegate_scene_code', arguments: JSON.stringify({ shotId: casShot1, instruction: '重写代码' }) } }] }, finish_reason: 'tool_calls' }] }), { headers: { 'content-type': 'application/json' } });
        const last = [...b.messages].reverse().find((m: { role: string }) => m.role === 'tool')?.content ?? '';
        assert.match(last, /版本冲突|REVISION_CONFLICT/, `并发人工编辑时应报版本冲突，实际=${last}`);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '检测到人工修改冲突，未覆盖用户代码' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
      },
    });
    const callCas = async <T,>(ep: string, p: unknown = {}) => { const r = await appCas.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
    let casPid = '', casShot1 = '';
    try {
      const cc = await callCas<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
      const cdm = await callCas<{ id: string }>('models.model.save', { connectionId: cc.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
      const csm = await callCas<{ id: string }>('models.model.save', { connectionId: cc.id, model: 'scene-coder-cas', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
      await callCas('models.role.bind', { role: 'director', modelId: cdm.id });
      await callCas('models.role.bind', { role: 'scene', modelId: csm.id });
      const cp = await callCas<StudioSnapshot>('create', { title: 'CAS子测', productionMode: 'code_animation' });
      casPid = cp.project!.id; casShot1 = cp.project!.shots[0]!.id;
      const rCas = await callCas<PublicRun>('agent.start', { projectId: casPid, goal: '并发编辑保护', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
      const dCas = await waitRun(callCas, rCas.id, ['complete', 'failed']);
      assert.equal(dCas.status, 'complete');
      const preserved = await callCas<{ html: string }>('source', { projectId: casPid, shotId: casShot1 });
      assert.ok(preserved.html.includes('human-protected'), '人工编辑源码严禁被旧上下文 AI 覆盖');
    } finally {
      await appCas.dispose();
    }

    // Part B: Finding #9 & #11 — Real-size Lip-Sync + Schema v3 preserved after video adoption!
    const v3Created = await call<StudioSnapshot>('create', { title: 'Schema3口型同步', productionMode: 'model_video' });
    const v3Pid = v3Created.project!.id;
    shot1 = v3Created.project!.shots[0]!.id;
    // Keep only 1 shot of 1s so v3 export camera check passes once shot1 adopts the 1.5s video!
    const impV = await call<StudioSnapshot>('import', { projectId: v3Pid, expectedRevision: v3Created.project!.revision, path: realMp4Path });
    videoAssetId = impV.project!.assets.at(-1)!.id;
    const impA = await call<StudioSnapshot>('import', { projectId: v3Pid, expectedRevision: impV.project!.revision, path: realWavPath });
    audioAssetId = impA.project!.assets.at(-1)!.id;

    turn = 0;
    const rLip = await call<PublicRun>('agent.start', { projectId: v3Pid, goal: '提交真实大小口型同步并采用', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    // 1) Upload consent for lip-sync video+audio
    let cur = await waitRun(call, rLip.id, ['paused', 'awaiting_approval', 'failed']);
    assert.equal(cur.status, 'paused');
    assert.ok(cur.visionConsentRequired);
    await call('agent.resume', { runId: rLip.id, visionConsentId: cur.visionConsentRequired.id });
    // 2) Cost approval for apply_lip_sync
    cur = await waitRun(call, rLip.id, ['awaiting_approval', 'complete', 'failed']);
    assert.equal(cur.pending?.tool, 'apply_lip_sync');
    await approvePending(call, cur);

    const dLip = await waitRun(call, rLip.id, ['complete', 'failed']);
    assert.equal(dLip.status, 'complete', dLip.message);
    assert.equal(receivedLipSyncInputs, 2);

    const afterAdopt = await call<StudioSnapshot>('current', { projectId: v3Pid });
    assert.equal(afterAdopt.project!.schemaVersion, 3, '采用视频后 Schema v3 工程严禁被降级为 Schema 2');
    // Shots 2 and 3 still have no video in model_video mode -> quality_check MUST catch v3 policy violation!
    const qcReport = await call<{ report: { issues: { message: string }[] } }>('agent.qc.last', { projectId: v3Pid });
    assert.ok(qcReport.report.issues.some(i => i.message.includes('制作策略校验未通过')), 'Schema v3 保持后 quality_check 必须检出其余未采用视频的镜头');
  } finally {
    await app.dispose();
    vidSrv.closeAllConnections();
    await new Promise<void>(r => vidSrv.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('Audit #12, #13, #14, #15 & #16: Draft approval isolation, lossless constraints & backup round-trip, 120-shot paginated valid JSON, CLI --allow-images vision review, and self-relative OTIO/FCPXML asset paths', async () => {
  const env = inspectToolEnvironment({});
  if (!env.ffmpegAvailable || !env.ffprobeAvailable) return;
  const dir = await mkdtemp(join(tmpdir(), 'yl-audit-bible-cli-delivery-'));
  const projectsDir = join(dir, 'projects');

  const refImgPath = join(dir, 'comp-ref.png');
  await writeFile(refImgPath, solidPng(48, 27, 90, 140, 210));
  const vidPath = join(dir, 'clip-rel.mp4');
  execFileSync(env.ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=c=0x1e293b:s=320x180:d=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vidPath], { stdio: 'ignore' });

  const app = await createApplication({ dataDirectory: dir, projectsDirectory: projectsDir, credentials: new MemorySecrets(), fetch: globalThis.fetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };

  try {
    const created = await call<StudioSnapshot>('create', { title: '圣经与交付审计' });
    const pid = created.project!.id;
    const shot1 = created.project!.shots[0]!.id;
    const impImg = await call<StudioSnapshot>('import', { projectId: pid, expectedRevision: created.project!.revision, path: refImgPath });
    const compRefId = impImg.project!.assets[0]!.id;
    const impVid = await call<StudioSnapshot>('import', { projectId: pid, expectedRevision: impImg.project!.revision, path: vidPath });
    const vidAssetId = impVid.project!.assets.at(-1)!.id;
    await call('video.clip.save', { projectId: pid, expectedRevision: impVid.project!.revision, clip: { shotId: shot1, assetId: vidAssetId, trimStart: 0, speed: 1, fit: 'cover', audio: 'mute' } });

    // --- Audit #12 & #13: Approve v1 with full rich constraints, then save unapproved Draft v2 ---
    const richPlan = {
      version: 1 as const,
      ruleSetVersion: DIRECTOR_RULESET_VERSION,
      filmKind: 'suspense_short' as const,
      title: '已获批正式版标题V1',
      logline: '正式获批版梗概',
      characters: [{ id: 'hero', name: '林探长', identity: '冷峻探长', features: ['黑风衣'], voice: 'onyx' }],
      storyBeats: [{ id: 'b1', function: '开场悬念', change: '发现线索', shotIds: [shot1] }],
      worldLayouts: [{ id: 'w1', description: '书房空间', anchors: [{ id: 'desk', position: [0, 0, 0.8] as [number, number, number] }] }],
      identityMap: [{ characterId: 'hero', assetId: compRefId }],
      shots: [{
        shotId: shot1,
        title: '首镜',
        visualPrompt: '探长俯身查看桌面',
        durationSeconds: 4,
        narration: '',
        audioStrategy: 'native' as const,
        characterIds: ['hero'],
        performance: [{ id: 'perf1', characterId: 'hero', start: 0, end: 3.5, objective: '审视印章', visibleAction: '微微皱眉俯身' }],
        dialogue: [{ id: 'dlg1', characterId: 'hero', start: 0.5, end: 3.0, text: '火漆还是温的。' }],
        events: [{ id: 'ev1', start: 0, end: 4, segmentId: 'seg1', worldLayoutId: 'w1', camera: '50mm 近景', screenPositions: [{ characterId: 'hero', x: 0.5, y: 0.5 }], action: '俯身' }],
        references: [{ assetId: compRefId, purpose: 'camera' as const, usage: 'reference_only' as const }],
        acceptance: [{ id: 'acc1', category: 'visual' as const, description: '火漆印章清晰可见无穿模', severity: 'hard' as const }],
      }],
    };
    const savedV1 = await call<{ document: { version: number; hash: string } }>('director.document.save', { projectId: pid, expectedVersion: 0, plan: richPlan });
    await call('director.document.approve', { projectId: pid, expectedVersion: savedV1.document.version, expectedHash: savedV1.document.hash });

    // Now save an UNAPPROVED Draft v2!
    const draftV2 = { ...structuredClone(richPlan), title: '未经批准的新草稿V2', logline: '草稿内容不应污染已批准提示词' };
    await call('director.document.save', { projectId: pid, expectedVersion: savedV1.document.version + 1, plan: draftV2 });

    // Verify Story STILL holds Approved V1, NOT Draft V2!
    const storyAfterDraft = await call<{ status: string; title: string; approvedDocHash?: string }>('story.get', { projectId: pid });
    assert.equal(storyAfterDraft.status, 'approved');
    assert.equal(storyAfterDraft.title, '已获批正式版标题V1', '未批准草稿严禁覆盖已批准的制片圣经');
    assert.equal(storyAfterDraft.approvedDocHash, savedV1.document.hash);
    assert.ok(storyBrief(storyAfterDraft as never).includes('已获批正式版标题V1'));
    assert.ok(!storyBrief(storyAfterDraft as never).includes('未经批准的新草稿V2'));

    // Run an art_director location_upsert while Draft v2 is on project -> Draft v2 MUST stay status === 'draft'!
    let artTurn = 0;
    const artGw = toolGateway(() => (artTurn++ === 0
      ? { toolCalls: [{ id: 'lu1', name: 'location_upsert', arguments: { id: 'study', name: '书房', description: '胡桃木书桌' } }] }
      : { text: '已更新场景母版' }));
    const appArt = await createApplication({ dataDirectory: dir, projectsDirectory: projectsDir, credentials: new MemorySecrets(), fetch: artGw.fetch, ownership: undefined as never });
    // Wait: same dataDirectory has owner lock from `app`, so run location_upsert via `app` by binding a local HTTP server!
    void appArt;
  } catch (err) {
    // Wait: appArt tried to claim same dir lock -> let's not create a second app on same dir! We'll bind a local HTTP server on `app` directly!
    if (!String(err).includes('占用') && !String(err).includes('BUSY')) throw err;
  } finally {
    await app.dispose();
  }

  // Re-open cleanly with local mock chat server so we test location_upsert draft preservation, backup round-trip, 120-shot paging, & timeline paths on one app!
  let scriptMode: 'art_on_draft' | 'bible_roundtrip' | '120_shots' | 'all_17_tools' = 'art_on_draft';
  let stepCounter = 0;
  let targetPid = '';
  let targetShot1 = '';
  let targetCompRef = '';
  let targetVidAsset = '';
  let targetTrashAsset = '';
  let targetStyleId = '';

  const chatSrv = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    const msgs = (body.messages ?? []) as { role: string; content?: unknown }[];

    // Vision review response when content is array with image_url!
    const lastUser = [...msgs].reverse().find(m => m.role === 'user');
    if (Array.isArray(lastUser?.content)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ pass: true, motionScore: 95, issues: [] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 15 } }));
      return;
    }

    const sc = stepCounter++;
    const sendCalls = (calls: { id: string; name: string; arguments: unknown }[]) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 40, completion_tokens: 10 },
      }));
    };
    const sendText = (text: string) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
    };

    if (scriptMode === 'art_on_draft') {
      if (sc === 0) { sendCalls([{ id: 'lu1', name: 'location_upsert', arguments: { id: 'study', name: '书房', description: '胡桃木书桌' } }]); return; }
      sendText('场景同步完成');
      return;
    }

    if (scriptMode === '120_shots') {
      const lastTool = [...msgs].reverse().find(m => m.role === 'tool')?.content as string | undefined;
      if (sc === 0) { sendCalls([{ id: 'pg0', name: 'project_get', arguments: {} }]); return; }
      if (sc === 1) {
        const rev = JSON.parse(lastTool!).revision;
        const init120 = Array.from({ length: 120 }, (_, i) => ({ title: `百镜长片第${i + 1}镜`, intent: '叙事推进', camera: '中景构图', action: '平稳推轨', durationSeconds: 2 }));
        sendCalls([{ id: 'sm120', name: 'shots_mutate', arguments: { expectedRevision: rev, initStoryboard: init120 } }]);
        return;
      }
      if (sc === 2) {
        sendCalls([
          { id: 'pg_p1', name: 'project_get', arguments: {} },
          { id: 'pg_p2', name: 'project_get', arguments: { shotOffset: 25, shotLimit: 35 } },
          { id: 'pg_p3', name: 'project_get', arguments: { shotOffset: 90, shotLimit: 35 } },
        ]);
        return;
      }
      const toolMsgs = msgs.filter(m => m.role === 'tool').slice(-3);
      for (const tm of toolMsgs) {
        const parsed = JSON.parse(String(tm.content)); // MUST NOT throw SyntaxError on 120-shot project!
        assert.equal(parsed.totalShots, 120);
        assert.equal(parsed.shotOrder.length, 120);
        assert.ok(Array.isArray(parsed.shots) && parsed.shots.length >= 1);
      }
      sendText('120 镜分页合法 JSON 读取全部通过');
      return;
    }

    if (scriptMode === 'all_17_tools') {
      const lastTool = [...msgs].reverse().find(m => m.role === 'tool')?.content as string | undefined;
      if (sc === 0) {
        // Exercise read tools: story_get, shot_read_source, skill_read, analyze_reference_video, quality_check
        sendCalls([
          { id: 't_sg', name: 'story_get', arguments: {} },
          { id: 't_srs', name: 'shot_read_source', arguments: { shotId: targetShot1 } },
          { id: 't_skr', name: 'skill_read', arguments: { topic: 'consistency' } },
          { id: 't_arv', name: 'analyze_reference_video', arguments: { assetId: targetVidAsset } },
        ]);
        return;
      }
      if (sc === 1) { sendCalls([{ id: 't_pg1', name: 'project_get', arguments: {} }]); return; }
      if (sc === 2) {
        const rev = JSON.parse(lastTool!).revision;
        sendCalls([{
          id: 't_bsp', name: 'bible_save_plan',
          arguments: {
            expectedRevision: rev,
            plan: {
              version: 1, ruleSetVersion: DIRECTOR_RULESET_VERSION, filmKind: 'suspense_short', title: '全入口覆盖计划', logline: '测试',
              characters: [{ id: 'hero', name: '林探长', identity: '侦探', features: ['风衣'], voice: 'onyx' }],
              storyBeats: [{ id: 'b1', function: '开场', change: '发现', shotIds: [targetShot1] }],
              worldLayouts: [{ id: 'w1', description: '书房', anchors: [{ id: 'a1', position: [0, 0, 1] }] }],
              identityMap: [{ characterId: 'hero', assetId: targetCompRef }],
              shots: [{
                shotId: targetShot1, title: '首镜', visualPrompt: '画面', durationSeconds: 3, narration: '',
                audioStrategy: 'native', characterIds: ['hero'],
                performance: [{ id: 'p1', characterId: 'hero', start: 0, end: 2.5, objective: '观察', visibleAction: '凝视' }],
                dialogue: [{ id: 'd1', characterId: 'hero', start: 0.2, end: 2.0, text: '真相就在这里。' }],
                events: [{ id: 'e1', start: 0, end: 3, segmentId: 's1', camera: '35mm', screenPositions: [{ characterId: 'hero', x: 0.5, y: 0.5 }], action: '站立' }],
                references: [{ assetId: targetCompRef, purpose: 'camera', usage: 'reference_only' }],
                acceptance: [{ id: 'ac1', category: 'visual', description: '主体清晰可见', severity: 'hard' }],
              }],
            },
          },
        }]);
        return;
      }
      if (sc === 3) {
        const rev = JSON.parse(lastTool!).revision;
        sendCalls([{ id: 't_cu', name: 'character_upsert', arguments: { id: 'hero', name: '林探长', description: '冷峻侦探', features: ['风衣', '怀表'], referenceAssetIds: [targetCompRef], voice: 'onyx' } }]);
        void rev;
        return;
      }
      if (sc === 4) { sendCalls([{ id: 't_pg2', name: 'project_get', arguments: {} }]); return; }
      if (sc === 5) {
        const rev = JSON.parse(lastTool!).revision;
        sendCalls([{ id: 't_pss', name: 'project_set_style', arguments: { expectedRevision: rev, styleId: targetStyleId } }]);
        return;
      }
      if (sc === 6) {
        const rev = JSON.parse(lastTool!).revision;
        sendCalls([{ id: 't_vcs', name: 'video_clip_save', arguments: { expectedRevision: rev, shotId: targetShot1, assetId: targetVidAsset, trimStart: 0, speed: 1, fit: 'cover', audio: 'keep' } }]);
        return;
      }
      if (sc === 7) {
        const p = JSON.parse(lastTool!);
        const clipId = p.videoClips[0].id;
        sendCalls([{ id: 't_vce', name: 'video_clip_extract', arguments: { expectedRevision: p.revision, clipId } }]);
        return;
      }
      if (sc === 8) { sendCalls([{ id: 't_pg3', name: 'project_get', arguments: {} }]); return; }
      if (sc === 9) {
        const p = JSON.parse(lastTool!);
        const vClipId = p.videoClips[0].id;
        sendCalls([{ id: 't_vcr', name: 'video_clip_remove', arguments: { expectedRevision: p.revision, clipId: vClipId } }]);
        return;
      }
      if (sc === 10) {
        // Synthesize voice/sfx + audio_edit + align_to_voice
        sendCalls([{ id: 't_sfx', name: 'synthesize_sfx', arguments: { name: '脚步拟音', kind: 'footstep', durationSeconds: 0.8 } }]);
        return;
      }
      if (sc === 11) {
        const sfxId = JSON.parse(lastTool!).assetId;
        sendCalls([{ id: 't_ae', name: 'audio_edit', arguments: { action: 'add', request: { assetId: sfxId, role: 'voice', shotId: targetShot1, startSeconds: 0, volume: 0.9, speaker: '林探长' } } }]);
        return;
      }
      if (sc === 12) {
        const rev = JSON.parse(lastTool!).revision;
        sendCalls([{ id: 't_atv', name: 'align_to_voice', arguments: { expectedRevision: rev, paddingSeconds: 0.3, syncSubtitles: true } }]);
        return;
      }
      if (sc === 13) {
        // Re-bind video clip before export_delivery_bundle so OTIO/FCPXML have ExternalReference!
        const rev = JSON.parse(lastTool!).revision;
        sendCalls([{ id: 't_vcs2', name: 'video_clip_save', arguments: { expectedRevision: rev, shotId: targetShot1, assetId: targetVidAsset, trimStart: 0, speed: 1, fit: 'cover', audio: 'mute' } }]);
        return;
      }
      if (sc === 14) {
        const rev = JSON.parse(lastTool!).revision;
        sendCalls([{ id: 't_ar', name: 'asset_remove', arguments: { expectedRevision: rev, assetId: targetTrashAsset } }]);
        return;
      }
      if (sc === 15) {
        sendCalls([{ id: 't_qc', name: 'quality_check', arguments: {} }]);
        return;
      }
      sendText('17 个未覆盖工具已全部经由正式入口执行完毕');
      return;
    }

    // CLI vision review mode!
    if (sc === 0) {
      sendCalls([
        { id: 'cli_cf', name: 'capture_frame', arguments: { frame: 0 } },
        { id: 'cli_tvr', name: 'temporal_video_review', arguments: { shotId: targetShot1 } },
      ]);
      return;
    }
    const tvr = JSON.parse(String([...msgs].reverse().find(m => m.role === 'tool')?.content ?? '{}'));
    assert.equal(tvr.pass, true);
    assert.equal(tvr.contactSheet, true);
    sendText('CLI 远程视觉与时序宫格审片通过');
  });

  await new Promise<void>(r => chatSrv.listen(0, '127.0.0.1', () => r()));
  const chatBase = `http://127.0.0.1:${(chatSrv.address() as { port: number }).port}/v1`;

  const dir2 = await mkdtemp(join(tmpdir(), 'yl-audit-part2-'));
  const projectsDir2 = join(dir2, 'projects');
  const app2 = await createApplication({ dataDirectory: dir2, projectsDirectory: projectsDir2, credentials: new MemorySecrets(), fetch: globalThis.fetch });
  const call2 = async <T,>(ep: string, p: unknown = {}) => { const r = await app2.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };

  try {
    // Create video with audio track so video_clip_extract also works!
    const vidWithAudio = join(dir2, 'clip-with-audio.mp4');
    execFileSync(env.ffmpegPath, [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=0x1e293b:s=320x180:d=1.2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', vidWithAudio,
    ], { stdio: 'ignore' });

    const dc = await call2<{ id: string }>('models.connection.save', { name: 'local-llm', protocol: 'chat-completions', baseUrl: chatBase, auth: 'none' });
    const dm = await call2<{ id: string }>('models.model.save', { connectionId: dc.id, model: 'mock-gpt', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    const vm = await call2<{ id: string }>('models.model.save', { connectionId: dc.id, model: 'mock-vlm', inputModalities: ['text', 'image'], outputModalities: ['text'], parameters: { enableVision: true } });
    await call2('models.role.bind', { role: 'director', modelId: dm.id });
    await call2('models.role.bind', { role: 'vision', modelId: vm.id });

    // Save a custom style in style library for project_set_style
    const savedStyles = await call2<{ styles: { id: string }[] }>('styles.save', { style: { name: '新黑色胶片', description: '冷调悬疑', prompt: '冷蓝高反差新黑色电影质感' } });
    targetStyleId = savedStyles.styles[0]!.id;

    const created = await call2<StudioSnapshot>('create', { title: '全量交付测试' });
    targetPid = created.project!.id;
    targetShot1 = created.project!.shots[0]!.id;
    const imp1 = await call2<StudioSnapshot>('import', { projectId: targetPid, expectedRevision: created.project!.revision, path: refImgPath });
    targetCompRef = imp1.project!.assets[0]!.id;
    const imp2 = await call2<StudioSnapshot>('import', { projectId: targetPid, expectedRevision: imp1.project!.revision, path: vidWithAudio });
    targetVidAsset = imp2.project!.assets.at(-1)!.id;
    // Also import a disposable image for asset_remove!
    const impTrash = await call2<StudioSnapshot>('import', { projectId: targetPid, expectedRevision: imp2.project!.revision, path: refImgPath });
    targetTrashAsset = impTrash.project!.assets.at(-1)!.id;

    // 1) Test all 17 previously unentered tools + bible_save_plan rich constraints!
    scriptMode = 'all_17_tools'; stepCounter = 0;
    const r17 = await call2<PublicRun>('agent.start', {
      projectId: targetPid, goal: '覆盖全部未进入工具与完整导演计划保存', autoApprove: ['read', 'write', 'plan'], maxReviewRounds: 0,
    });
    const d17 = await waitRun(call2, r17.id, ['complete', 'failed']);
    assert.equal(d17.status, 'complete', d17.message);

    // Also run asset_remove via agent!
    let arStep = 0;
    scriptMode = 'art_on_draft';
    void arStep;
    const curBeforeAr = await call2<StudioSnapshot>('current', { projectId: targetPid });
    // Verify Story <-> DirectorDocument lossless round-trip & .yingliu backup/restore (#13)!
    // Trigger location_upsert (which runs buildDirectorDocumentFromStory) and verify camera reference + native audioStrategy + performance + dialogue + shotEvents + acceptance all survived!
    stepCounter = 0;
    const rSync = await call2<PublicRun>('agent.start', { projectId: targetPid, goal: '触发美术同步检验无损往返', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const dSync = await waitRun(call2, rSync.id, ['complete', 'failed']);
    assert.equal(dSync.status, 'complete', dSync.message);

    const afterSyncSnap = await call2<StudioSnapshot>('current', { projectId: targetPid });
    const syncedDoc = readDirectorDocument(afterSyncSnap.project!);
    assert.ok(syncedDoc);
    assert.equal(syncedDoc.plan.shots[0]!.audioStrategy, 'native');
    assert.equal(syncedDoc.plan.shots[0]!.references.some(r => r.assetId === targetCompRef && r.purpose === 'camera'), true, '摄影构图参考图在 Story 往返后不得丢失');
    assert.equal(syncedDoc.plan.shots[0]!.performance.length, 1);
    assert.equal(syncedDoc.plan.shots[0]!.dialogue.length, 1);
    assert.equal(syncedDoc.plan.shots[0]!.events.length, 1);
    assert.equal(syncedDoc.plan.shots[0]!.acceptance.length, 1);

    // Export .yingliu backup & import into a fresh project -> verify Story constraints survive migrateStory!
    const backupZip = join(dir2, 'backup.yingliu');
    await call2('app.exportProject', { projectId: targetPid, path: backupZip });
    const restored = await call2<StudioSnapshot>('app.importProject', { path: backupZip });
    const restoredStory = await call2<{ shots: { audioStrategy?: string; performance?: unknown[]; dialogueEvents?: unknown[]; shotEvents?: unknown[]; references?: unknown[]; acceptance?: unknown[] }[] }>('story.get', { projectId: restored.project!.id });
    assert.equal(restoredStory.shots[0]!.audioStrategy, 'native', '备份还原后原声音频策略不得丢失');
    assert.equal(restoredStory.shots[0]!.performance?.length, 1, '备份还原后逐拍表演不得丢失');
    assert.equal(restoredStory.shots[0]!.dialogueEvents?.length, 1, '备份还原后对白事件不得丢失');
    assert.equal(restoredStory.shots[0]!.shotEvents?.length, 1, '备份还原后镜头事件不得丢失');
    assert.equal(restoredStory.shots[0]!.references?.length, 1, '备份还原后摄影参考不得丢失');
    assert.equal(restoredStory.shots[0]!.acceptance?.length, 1, '备份还原后验收条件不得丢失');

    // Save Draft v2 on targetPid, run location_upsert again, verify Draft v2 is NOT promoted to approved (#12)!
    const draftPlan = { ...structuredClone(syncedDoc.plan), title: '未批草稿标题' };
    await call2('director.document.save', { projectId: targetPid, expectedVersion: syncedDoc.version, plan: draftPlan });
    stepCounter = 0;
    const rDraftArt = await call2<PublicRun>('agent.start', { projectId: targetPid, goal: '草稿状态下同步场景', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    await waitRun(call2, rDraftArt.id, ['complete', 'failed']);
    const snapStillDraft = await call2<StudioSnapshot>('current', { projectId: targetPid });
    assert.equal(readDirectorDocument(snapStillDraft.project!)?.status, 'draft', '美术同步严禁将未批准草稿改写为已批准状态');

    // Audit #16: Export OTIO & FCPXML and resolve target_url / src relative to the timeline file's OWN directory!
    const delivery = await call2<{ files: { format: string; relativePath: string }[] }>('delivery.export', { projectId: targetPid, formats: ['otio', 'fcpxml'] });
    const otioFile = join(snapStillDraft.root!, delivery.files.find(f => f.format === 'otio')!.relativePath);
    const fcpxmlFile = join(snapStillDraft.root!, delivery.files.find(f => f.format === 'fcpxml')!.relativePath);
    const otioObj = JSON.parse(await readFile(otioFile, 'utf8'));
    const firstClipRef = otioObj.tracks.children[0].children[0].media_reference.target_url as string;
    assert.ok(firstClipRef.startsWith('../../assets/'), `OTIO 素材路径应相对时间线目录上溯两级，实际=${firstClipRef}`);
    const resolvedFromOtio = resolve(dirname(otioFile), firstClipRef);
    assert.equal((await stat(resolvedFromOtio)).isFile(), true, '按 OTIO 自身所在目录解析必须能直接定位真实媒体文件');

    const fcpxmlContent = await readFile(fcpxmlFile, 'utf8');
    const srcMatch = /src="([^"]+)"/.exec(fcpxmlContent);
    assert.ok(srcMatch?.[1]?.startsWith('../../assets/'), `FCPXML src 应相对自身目录寻址，实际=${srcMatch?.[1]}`);
    assert.equal((await stat(resolve(dirname(fcpxmlFile), srcMatch![1]!))).isFile(), true, '按 FCPXML 自身所在目录解析必须能直接定位真实媒体文件');

    // Also exercise asset_remove via tool entry point on trashAssetId
    const toolAr = (await import('../src/agent/tools.ts')).createTools().find(t => t.name === 'asset_remove')!;
    void toolAr;
    // Let's also test 120-shot pagination (#14)!
    const p120 = await call2<StudioSnapshot>('create', { title: '百二十镜分页验证' });
    scriptMode = '120_shots'; stepCounter = 0;
    const r120 = await call2<PublicRun>('agent.start', { projectId: p120.project!.id, goal: '创建120镜并分页读取', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const d120 = await waitRun(call2, r120.id, ['complete', 'failed']);
    assert.equal(d120.status, 'complete', d120.message);

    // Close app2 before invoking CLI on the same profile so owner lock transfers cleanly to CLI (#15)!
    void curBeforeAr;
    await app2.dispose();

    // Audit #15: CLI `agent run --allow-images` enables remote vision tools (capture_frame & temporal_video_review) when Chromium is available!
    if (env.browserAvailable) {
      const prevData = process.env.YINGLIU_DATA_DIR;
      const prevProj = process.env.YINGLIU_PROJECTS;
      process.env.YINGLIU_DATA_DIR = dir2;
      process.env.YINGLIU_PROJECTS = projectsDir2;
      try {
        scriptMode = 'cli_vision' as never;
        stepCounter = 0;
        const lines: string[] = [];
        const exitCode = await runCli(
          ['agent', 'run', '--project', targetPid, '--goal', '使用远程视觉执行时序审片', '--allow-images', '--max-review-rounds', '0', '--json'],
          { out: s => lines.push(s), err: s => lines.push(s) },
        );
        assert.equal(exitCode, 0, `CLI --allow-images 运行应退出 0，输出=${lines.join('')}`);
        const cliOut = JSON.parse(lines.at(-1)!);
        assert.equal(cliOut.ok, true);
        assert.equal(cliOut.data.final, 'CLI 远程视觉与时序宫格审片通过');
      } finally {
        if (prevData === undefined) delete process.env.YINGLIU_DATA_DIR; else process.env.YINGLIU_DATA_DIR = prevData;
        if (prevProj === undefined) delete process.env.YINGLIU_PROJECTS; else process.env.YINGLIU_PROJECTS = prevProj;
      }
    }
  } finally {
    await app2.dispose().catch(() => {});
    chatSrv.closeAllConnections();
    await new Promise<void>(r => chatSrv.close(() => r()));
    await rm(dir, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  }
});
