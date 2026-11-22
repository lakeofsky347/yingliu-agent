import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import type { PublicRun } from '../src/agent/contracts.ts';
import { synthesize, type SynthKind } from '../src/agent/synth.ts';
import { alignToVoice, createTools } from '../src/agent/tools.ts';
import { DIRECTOR_RULESET_VERSION } from '../src/director/index.ts';
import { readDirectorDocument } from '../src/director/document.ts';
import { BlenderRunner, validatePrevizSpec } from '../src/host/blender.ts';
import { buildContactSheetPng, decodePngRgba, encodeRgbaPng } from '../src/host/contact-sheet.ts';
import { inspectToolEnvironment } from '../src/host/tool-environment.ts';
import { mediaSignature } from '../src/jobs/download.ts';
import { deconstructReferenceVideo } from '../src/media/deconstruct.ts';
import { deriveSubtitles, formatAss, formatEdl, formatFcpxml, formatOtio, formatSrt } from '../src/media/delivery.ts';
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

const SAMPLE_PNG = solidPng(32, 18, 42, 92, 168);
const DEPTH_PNG = solidPng(32, 18, 128, 128, 128);

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
  assert.equal(run.status, 'awaiting_approval', `预期等待批准，实际状态=${run.status} (${run.message})`);
  assert.ok(run.pending);
  await call('agent.approve', {
    runId: run.id,
    callId: run.pending.callId,
    execId: run.pending.execId,
    argsHash: run.pending.argsHash,
  });
}

test('v2 toolset exposes 59 full-spectrum tools and deterministic contact-sheet / Foley / delivery primitives', () => {
  const all = createTools();
  assert.equal(all.length, 59);
  for (const required of [
    'bible_get', 'bible_save_plan', 'request_production_policy', 'analyze_reference_video',
    'location_upsert', 'prop_upsert', 'continuity_log_upsert', 'shots_mutate', 'shot_patch',
    'delegate_scene_code', 'delegate_crew', 'stylize_keyframe', 'batch_generate_media',
    'apply_lip_sync', 'audio_mix_master', 'audio_analyze', 'shot_take_manage',
    'post_overlay_subtitle', 'reframe_project', 'temporal_video_review', 'export_delivery_bundle',
  ]) {
    assert.ok(all.some(t => t.name === required), `应包含工具 ${required}`);
  }

  // Verify 6 new procedural Foley synths produce valid WAV bytes
  const newKinds: SynthKind[] = ['rain', 'heartbeat', 'footstep', 'riser', 'sub_drop', 'ambience_hum'];
  for (const kind of newKinds) {
    const wav = synthesize({ kind, durationSeconds: 0.35, frequency: 120, endFrequency: 640 });
    assert.equal(Buffer.from(wav.subarray(0, 4)).toString('ascii'), 'RIFF');
    assert.ok(wav.byteLength > 8000, `${kind} WAV 长度应有效`);
  }

  // Verify 5-frame PNG contact sheet builder
  const frames = [
    solidPng(64, 36, 30, 50, 80),
    solidPng(64, 36, 50, 80, 120),
    solidPng(64, 36, 80, 110, 150),
    solidPng(64, 36, 120, 140, 180),
    solidPng(64, 36, 160, 180, 210),
  ];
  const sheet = buildContactSheetPng(frames, { columns: 3, tileWidth: 96 });
  assert.ok(sheet);
  assert.equal(mediaSignature(sheet.bytes), 'image/png');
  const decoded = decodePngRgba(sheet.bytes);
  assert.ok(decoded);
  assert.equal(decoded.width, sheet.width);
  assert.equal(decoded.height, sheet.height);
});

test('v2 Unified Production Bible breaks 12-shot ceiling (16 shots) and syncs Story <-> DirectorDocument bidirectionally', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yl-v2-bible-16shots-'));
  const sixteenPlanned = Array.from({ length: 16 }, (_, idx) => ({
    id: `s${idx + 1}`,
    summary: `第 ${idx + 1} 镜：雨夜书房侦探逐步逼近书桌线索`,
    shotType: idx % 2 === 0 ? '中景' : '特写',
    camera: idx % 3 === 0 ? '35mm 缓推' : '85mm 浅景深定机',
    durationSeconds: 3,
    dialogue: idx === 0 ? '昨晚十一点，谁动过这封信？' : '',
    locationId: 'study_room',
    propIds: ['wax_letter'],
    characters: ['detective'],
    continueFromPrevious: idx > 0,
    audioStrategy: 'external',
  }));
  const sixteenInit = Array.from({ length: 16 }, (_, idx) => ({
    title: `镜 ${idx + 1}`,
    intent: `推进悬念节拍 ${idx + 1}`,
    composition: idx % 2 === 0 ? '中景三分构图' : '桌面火漆特写',
    action: '缓慢推轨',
    durationSeconds: 3,
    narration: idx === 0 ? '昨晚十一点，谁动过这封信？' : '',
    transition: idx % 4 === 0 ? 'dissolve' : 'cut',
    text: `SHOT ${idx + 1}`,
  }));

  let turn = 0;
  const gw = toolGateway((body) => {
    const t = turn++;
    const msgs = body.messages as { role: string; content?: string }[];
    const lastTool = [...msgs].reverse().find(m => m.role === 'tool')?.content ?? '{}';
    if (t === 0) return { toolCalls: [{ id: 'g0', name: 'project_get', arguments: {} }] };
    if (t === 1) {
      const rev = JSON.parse(lastTool).revision;
      return { toolCalls: [{ id: 'p0', name: 'request_production_policy', arguments: { expectedRevision: rev, mode: 'hybrid', baseMode: 'code_animation', allowGeneratedImages: true, allowImportedVideo: true } }] };
    }
    if (t === 2) {
      const rev = JSON.parse(lastTool).revision;
      return { toolCalls: [{ id: 'm1', name: 'shots_mutate', arguments: { expectedRevision: rev, title: '雨夜十六镜迷踪', initStoryboard: sixteenInit } }] };
    }
    if (t === 3) {
      return {
        toolCalls: [{
          id: 'ps1',
          name: 'plan_story',
          arguments: {
            filmKind: 'suspense_short',
            title: '雨夜十六镜迷踪',
            logline: '侦探在雨夜古典书房通过一枚残损火漆印章揭开密室真相。',
            targetSeconds: 48,
            style: { look: '新黑色电影写实', palette: '冷青暗蓝与暖金台灯', typography: '衬线宋体', motion: '克制沉稳推轨', negative: '卡通塑料感' },
            characters: [{ id: 'detective', name: '林探长', description: '中年冷峻侦探', objective: '找出藏信人', features: ['深灰风衣', '银框眼镜'], voice: 'onyx' }],
            locations: [{ id: 'study_room', name: '古典橡木书房', setting: 'INT', timeOfDay: 'NIGHT', description: '落地雨窗、胡桃木书桌与绿色银行台灯', lightingMood: '窗外冷蓝闪电加桌面暖黄聚光' }],
            props: [{ id: 'wax_letter', name: '暗红火漆密信', description: '印有渡鸦纹章的羊皮信封', ownerCharacterId: 'detective' }],
            worldLayouts: [{ id: 'study_3d', description: '书房标准 3D 坐标锚点', anchors: [{ id: 'desk', position: [0, 0, 0.75] }, { id: 'window', position: [0, 3.2, 1.5] }] }],
          },
        }],
      };
    }
    if (t === 4) {
      return { toolCalls: [{ id: 'ps2', name: 'plan_shots', arguments: { shots: sixteenPlanned } }] };
    }
    if (t === 5) return { toolCalls: [{ id: 'bg', name: 'bible_get', arguments: {} }] };
    return { text: '十六镜制片圣经与分镜结构已完成同步' };
  });

  const app = await createApplication({ dataDirectory: dir, credentials: new MemorySecrets(), fetch: gw.fetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const m = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: m.id });
    const created = await call<StudioSnapshot>('create', { title: '初始工程' });

    const run = await call<PublicRun>('agent.start', {
      projectId: created.project!.id,
      goal: '创建 16 镜悬疑短片制片圣经与工程分镜',
      autoApprove: ['read', 'write'],
      maxReviewRounds: 0,
    });

    // Approve request_production_policy, plan_story, plan_shots
    for (const expectedTool of ['request_production_policy', 'plan_story', 'plan_shots']) {
      const paused = await waitRun(call, run.id, ['awaiting_approval', 'complete', 'failed']);
      assert.equal(paused.pending?.tool, expectedTool);
      await approvePending(call, paused);
    }

    const done = await waitRun(call, run.id, ['complete', 'failed']);
    assert.equal(done.status, 'complete', done.message);

    const finalSnap = await call<StudioSnapshot>('current', { projectId: created.project!.id });
    assert.equal(finalSnap.project?.shots.length, 16);
    assert.equal(finalSnap.project?.productionPolicy?.mode, 'hybrid');
    assert.equal(finalSnap.project?.shots[0]?.transition, 'dissolve');

    const doc = readDirectorDocument(finalSnap.project!);
    assert.ok(doc, '应自动同步生成 project.extensions.directorDocument');
    assert.equal(doc.status, 'approved');
    assert.equal(doc.plan.shots.length, 16);
    assert.equal(doc.plan.locations?.length, 1);
    assert.equal(doc.plan.props?.length, 1);
    assert.equal(doc.plan.characters[0]?.voice, 'onyx');

    // Test direct bible_save_plan -> Story reverse sync via director.document.save + approve
    const updatedPlan = structuredClone(doc.plan);
    updatedPlan.ruleSetVersion = DIRECTOR_RULESET_VERSION;
    updatedPlan.shots[0]!.visualPrompt = '更新后的首镜雨夜特写';
    const saved = await call<{ document: { version: number; hash: string } }>('director.document.save', {
      projectId: created.project!.id, expectedVersion: doc.version, plan: updatedPlan,
    });
    assert.equal(saved.document.version, doc.version + 1);
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('v2 Virtual Film Crew: delegate_crew runs isolated department sub-agent and delegate_scene_code invokes scene model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yl-v2-crew-'));
  let directorTurns = 0;
  let crewTurns = 0;
  let sceneCalls = 0;

  const gw = toolGateway((body) => {
    const model = String(body.model ?? '');
    const msgs = body.messages as { role: string; content?: string }[];
    const sys = String(msgs[0]?.content ?? '');

    // Dedicated scene code model call
    if (model === 'scene-coder-v2') {
      sceneCalls++;
      return {
        text: JSON.stringify({
          html: '<div class="stage"><h1 id="headline"></h1></div>',
          css: '.stage{width:100%;height:100%;display:grid;place-items:center;background:#0f172a;color:#f8fafc;font-family:sans-serif}',
          js: 'export function render(ctx){ const el = ctx.root.querySelector("#headline"); if (el) el.textContent = String(ctx.params.text || "SCENE V2") + " · " + Math.round(ctx.progress * 100) + "%"; }',
        }),
      };
    }

    // Sub-agent turn (art_director)
    if (sys.includes('美术与资产设定师')) {
      const ct = crewTurns++;
      const scopeMatch = /目标镜头范围：([a-zA-Z0-9_-]+)/.exec(String(msgs[1]?.content ?? ''));
      const scopedShotId = scopeMatch?.[1] ?? 'shot-1';
      if (ct === 0) {
        return {
          toolCalls: [
            { id: 'loc1', name: 'location_upsert', arguments: { id: 'neon_alley', name: '赛博霓虹雨巷', setting: 'EXT', timeOfDay: 'NIGHT', description: '潮湿石板路反射粉青霓虹招牌与蒸汽管道', lightingMood: '高反差青品双色逆光' } },
            { id: 'prop1', name: 'prop_upsert', arguments: { id: 'cyber_deck', name: '银色神经接入匣', description: '带磨损编号与蓝光指示灯的铝合金终端' } },
            { id: 'cont1', name: 'continuity_log_upsert', arguments: { shotId: scopedShotId, axis180: '人物面向画面右侧（左→右运动轴线）', wardrobeState: '透明雨衣左肩破损', lightingMatch: '主光来自左侧粉红霓虹' } },
          ],
        };
      }
      return { text: '美术设定已完成：已登记赛博霓虹雨巷、神经接入匣及第 1 镜 180° 轴线场记。' };
    }

    // Showrunner turn
    const dt = directorTurns++;
    const lastTool = [...msgs].reverse().find(m => m.role === 'tool')?.content ?? '{}';
    if (dt === 0) return { toolCalls: [{ id: 'g0', name: 'project_get', arguments: {} }] };
    if (dt === 1) {
      const firstShotId = JSON.parse(lastTool).shots[0].id;
      return {
        toolCalls: [
          { id: 'dc1', name: 'delegate_crew', arguments: { department: 'art_director', task: '建立赛博霓虹雨巷场景、神经接入匣道具与首镜轴线场记', shotIds: [firstShotId] } },
        ],
      };
    }
    if (dt === 2) {
      // Grab shotId from first tool message
      const firstToolMsg = msgs.find(m => m.role === 'tool')?.content ?? '{}';
      const firstShotId = JSON.parse(firstToolMsg).shots[0].id;
      return {
        toolCalls: [
          { id: 'sc1', name: 'delegate_scene_code', arguments: { shotId: firstShotId, instruction: '深蓝底赛博标题动态渐显并展示进度百分比' } },
        ],
      };
    }
    return { text: '美术总监子代理与场景代码专精模型已协同完成任务' };
  });

  const app = await createApplication({ dataDirectory: dir, credentials: new MemorySecrets(), fetch: gw.fetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const dm = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    const sm = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'scene-coder-v2', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: dm.id });
    await call('models.role.bind', { role: 'scene', modelId: sm.id });

    const caps = await call<{ capabilities: { director?: string; scene?: string } }>('agent.capabilities');
    assert.ok(caps.capabilities.scene?.includes('scene-coder-v2'));

    const created = await call<StudioSnapshot>('create', { title: '剧组协同测试', productionMode: 'code_animation' });
    const shotId = created.project!.shots[0]!.id;

    const run = await call<PublicRun>('agent.start', {
      projectId: created.project!.id,
      goal: '委派美术总监建立场景道具，再委派场景代码模型编写首镜动画',
      autoApprove: ['read', 'write'],
      maxReviewRounds: 0,
    });
    const done = await waitRun(call, run.id, ['complete', 'failed']);
    assert.equal(done.status, 'complete', done.message);
    assert.equal(sceneCalls, 1, '应路由到专精 scene 模型生成镜头代码');
    assert.ok(done.steps.some(s => s.tool === 'delegate_crew' && s.status === 'complete'));
    assert.ok(done.steps.some(s => s.tool === 'delegate_scene_code' && s.status === 'complete'));

    const story = await call<{ locations?: { id: string }[]; props?: { id: string }[]; continuityLog?: { shotId: string }[] }>('story.get', { projectId: created.project!.id });
    assert.equal(story.locations?.[0]?.id, 'neon_alley');
    assert.equal(story.props?.[0]?.id, 'cyber_deck');
    assert.equal(story.continuityLog?.length, 1);

    const src = await call<{ html: string; js: string }>('source', { projectId: created.project!.id, shotId });
    assert.ok(src.html.includes('headline'));
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('v2 Blender 3D previz supports articulated poses, actor motion, DOF, noir_rim lighting, and Z-Depth pass', async (t) => {
  // 1. Validate rich PrevizSpec contract
  const spec = validatePrevizSpec({
    output: 'both',
    emitDepth: true,
    width: 480,
    height: 270,
    fps: 4,
    durationSeconds: 1,
    lighting: 'noir_rim',
    camera: {
      lensMm: 50,
      fStop: 2.0,
      focusDistance: 3.8,
      rollDeg: -4,
      startPos: [0, -4.2, 1.65],
      endPos: [0.3, -3.4, 1.55],
      startTarget: [0, 0, 1.3],
      endTarget: [0.2, 0.4, 1.35],
    },
    objects: [
      { id: 'hero', kind: 'character', pose: 'walk', position: [-0.6, 0, 0], endPos: [0.2, 0.5, 0], facingDeg: 165, endFacingDeg: 190, height: 1.78, color: '#cbd5e1' },
      { id: 'rival', kind: 'character', pose: 'point', position: [0.9, 0.8, 0], facingDeg: 210, height: 1.72, color: '#e2e8f0' },
    ],
  });
  assert.equal(spec.lighting, 'noir_rim');
  assert.equal(spec.emitDepth, true);
  assert.equal(spec.camera.fStop, 2.0);
  assert.equal(spec.objects[0]?.pose, 'walk');
  assert.deepEqual(spec.objects[0]?.endPos, [0.2, 0.5, 0]);

  // 2. Real headless Blender verification if installed locally
  const env = inspectToolEnvironment({});
  if (!env.blenderAvailable || !env.ffmpegAvailable) {
    t.skip('本机未安装 Blender 或 FFmpeg，已完成协议契约校验，跳过实机渲染');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'yl-v2-blender-depth-'));
  const runner = new BlenderRunner();
  try {
    const res = await runner.renderPreviz(dir, { ...spec, output: 'image' });
    assert.equal(mediaSignature(res.keyframePng), 'image/png');
    assert.ok(res.depthPng, '应同步导出归一化 Z-Depth 空间深度图');
    assert.equal(mediaSignature(res.depthPng!), 'image/png');
    assert.ok(res.depthPng!.byteLength > 200);
  } finally {
    await runner.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('v2 Previz-to-Video Stylized Keyframe Bridge + First-Last-Frame Video + Batch Concurrent Media Pool', async () => {
  const env = inspectToolEnvironment({});
  if (!env.ffmpegAvailable || !env.ffprobeAvailable) return;
  const dir = await mkdtemp(join(tmpdir(), 'yl-v2-bridge-batch-'));

  // Synthesize a real 1.5s 320x180 MP4 locally so ffprobe inspection succeeds cleanly
  const sampleMp4Path = join(dir, 'fixture.mp4');
  execFileSync(env.ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x1e293b:s=320x180:d=1.5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sampleMp4Path,
  ], { stdio: 'ignore' });
  const sampleMp4 = await readFile(sampleMp4Path);

  // Mock Blender executable producing keyframe.png + depth.png
  const fakeBlender = join(dir, 'fake-blender-depth.mjs');
  await writeFile(fakeBlender, `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Blender 4.3.0 (Mock)'); process.exit(0); }
const spec = JSON.parse(readFileSync(args[args.indexOf('--') + 1], 'utf8'));
mkdirSync(spec.outputDir, { recursive: true });
const kp = join(spec.outputDir, 'keyframe.png');
const dp = join(spec.outputDir, 'depth.png');
writeFileSync(kp, Buffer.from('${SAMPLE_PNG.toString('base64')}', 'base64'));
writeFileSync(dp, Buffer.from('${DEPTH_PNG.toString('base64')}', 'base64'));
writeFileSync(join(spec.outputDir, 'manifest.json'), JSON.stringify({ keyframe: kp, depth: dp, framesDir: null, frameCount: 1 }));
`);
  await chmod(fakeBlender, 0o755);

  // Local protocol media server supporting /v1/images/edits, /v1/images/generations, and /v1/media/jobs
  const mediaRequests: { path: string; body?: Record<string, unknown> }[] = [];
  let mediaUrl = '';
  const mediaSrv = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', mediaUrl);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBuf = Buffer.concat(chunks);
    let parsedBody: Record<string, unknown> | undefined;
    if (req.headers['content-type']?.includes('application/json')) {
      try { parsedBody = JSON.parse(rawBuf.toString('utf8')); } catch { parsedBody = undefined; }
    }
    mediaRequests.push({ path: u.pathname, body: parsedBody });

    if (u.pathname === '/v1/images/edits' || u.pathname === '/v1/images/generations') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: SAMPLE_PNG.toString('base64') }] }));
      return;
    }
    if (u.pathname === '/v1/media/jobs' && req.method === 'POST') {
      const jobId = String(parsedBody?.clientRequestId ?? `job-${mediaRequests.length}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jobId,
        status: 'succeeded',
        artifacts: [{ url: `${mediaUrl}/artifacts/out.mp4`, mimeType: 'video/mp4' }],
      }));
      return;
    }
    if (u.pathname === '/artifacts/out.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(sampleMp4);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => mediaSrv.listen(0, '127.0.0.1', () => r()));
  mediaUrl = `http://127.0.0.1:${(mediaSrv.address() as { port: number }).port}`;

  let turn = 0;
  let shot1 = '', shot2 = '';
  let previzImg = '', previzDepth = '';
  let firstKeyframeAsset = '', tailKeyframeAsset = '';

  const gw = toolGateway((body) => {
    const t = turn++;
    const msgs = body.messages as { role: string; content?: string }[];
    const lastTool = [...msgs].reverse().find(m => m.role === 'tool')?.content ?? '{}';

    if (t === 0) return { toolCalls: [{ id: 'g0', name: 'project_get', arguments: {} }] };
    if (t === 1) {
      const p = JSON.parse(lastTool);
      return {
        toolCalls: [{
          id: 'sm', name: 'shots_mutate',
          arguments: {
            expectedRevision: p.revision,
            initStoryboard: [
              { title: '首尾帧受控镜', durationSeconds: 2 },
              { title: '并发生成镜二', durationSeconds: 2 },
            ],
          },
        }],
      };
    }
    if (t === 2) {
      const out = JSON.parse(lastTool);
      [shot1, shot2] = out.shotIds;
      return {
        toolCalls: [{
          id: 'ps', name: 'plan_story',
          arguments: {
            title: '白模重绘与首尾帧测试', logline: '测试防灰模污染桥梁与场次并发池',
            style: { look: '电影胶片', palette: '冷青暖橙', typography: '黑体', motion: '平稳', negative: '灰白3D塑料' },
            characters: [{ id: 'hero', name: '阿哲', features: ['黑色皮夹克'] }],
          },
        }],
      };
    }
    if (t === 3) {
      return {
        toolCalls: [{
          id: 'psh', name: 'plan_shots',
          arguments: {
            shots: [
              { id: 's1', shotId: shot1, summary: '阿哲转身望向霓虹窗外', durationSeconds: 2, characters: ['hero'] },
              { id: 's2', shotId: shot2, summary: '雨滴滑落玻璃特写', durationSeconds: 2, characters: [] },
            ],
          },
        }],
      };
    }
    if (t === 4) {
      return {
        toolCalls: [{
          id: 'br', name: 'blender_render_previz',
          arguments: {
            shotId: shot1, name: '镜1深度预演', output: 'image', emitDepth: true, width: 480, height: 270,
            lighting: 'noir_rim',
            camera: { lensMm: 50, fStop: 2.0, startPos: [0, -4, 1.6], startTarget: [0, 0, 1.3] },
            objects: [{ id: 'hero', kind: 'character', pose: 'stand', position: [0, 0, 0], height: 1.75, facingDeg: 180 }],
          },
        }],
      };
    }
    if (t === 5) {
      const br = JSON.parse(lastTool);
      previzImg = br.imageAssetId;
      previzDepth = br.depthAssetId;
      assert.ok(previzDepth, 'blender_render_previz 应返回 depthAssetId');
      return {
        toolCalls: [{
          id: 'sub', name: 'submit_previz_review',
          arguments: { summary: '镜1构图与深度图就绪', shots: [{ shotId: shot1, imageAssetId: previzImg, depthAssetId: previzDepth, cameraNote: '50mm 浅景深' }] },
        }],
      };
    }
    if (t === 6) return { toolCalls: [{ id: 'g1', name: 'project_get', arguments: {} }] };
    if (t === 7) {
      const rev = JSON.parse(lastTool).revision;
      return { toolCalls: [{ id: 'sk1', name: 'stylize_keyframe', arguments: { expectedRevision: rev, shotId: shot1, frameRole: 'first', prompt: '电影胶片质感，阿哲侧脸暖光' } }] };
    }
    if (t === 8) {
      const waited = JSON.parse(lastTool);
      const taskId = waited.id;
      return { toolCalls: [{ id: 'g2', name: 'project_get', arguments: {} }, { id: 'noop', name: 'task_status', arguments: { kind: 'media', id: taskId } }] };
    }
    if (t === 9) {
      const revMsg = msgs.filter(m => m.role === 'tool').at(-2)!.content!;
      const taskMsg = msgs.filter(m => m.role === 'tool').at(-1)!.content!;
      const rev = JSON.parse(revMsg).revision;
      const taskId = JSON.parse(taskMsg).id;
      return { toolCalls: [{ id: 'ma1', name: 'media_apply', arguments: { taskId, expectedRevision: rev, registerAsKeyframe: 'first' } }] };
    }
    if (t === 10) {
      const applied = JSON.parse(lastTool);
      firstKeyframeAsset = applied.assetIds[0];
      return { toolCalls: [{ id: 'sk2', name: 'stylize_keyframe', arguments: { expectedRevision: applied.revision, shotId: shot1, frameRole: 'last', prompt: '电影胶片质感，阿哲正脸凝视镜头' } }] };
    }
    if (t === 11) {
      const taskId = JSON.parse(lastTool).id;
      return { toolCalls: [{ id: 'g3', name: 'project_get', arguments: {} }, { id: 'ts2', name: 'task_status', arguments: { kind: 'media', id: taskId } }] };
    }
    if (t === 12) {
      const rev = JSON.parse(msgs.filter(m => m.role === 'tool').at(-2)!.content!).revision;
      const taskId = JSON.parse(msgs.filter(m => m.role === 'tool').at(-1)!.content!).id;
      return { toolCalls: [{ id: 'ma2', name: 'media_apply', arguments: { taskId, expectedRevision: rev, registerAsKeyframe: 'last' } }] };
    }
    if (t === 13) {
      const applied = JSON.parse(lastTool);
      tailKeyframeAsset = applied.assetIds[0];
      // Batch generate both shots concurrently: shot 1 uses first+last frame video, shot 2 uses text-to-video!
      return {
        toolCalls: [{
          id: 'batch1',
          name: 'batch_generate_media',
          arguments: {
            expectedRevision: applied.revision,
            autoApply: true,
            items: [
              { kind: 'video', shotId: shot1, prompt: '阿哲从侧脸缓慢转头正视镜头', imageAssetId: firstKeyframeAsset, tailImageAssetId: tailKeyframeAsset, durationSeconds: 2 },
              { kind: 'video', shotId: shot2, prompt: '夜景窗玻璃雨滴滑落特写', durationSeconds: 2 },
            ],
          },
        }],
      };
    }
    return { text: '白模风格化重绘首尾帧与双镜头并发视频生成并入轨全部完成' };
  });

  const app = await createApplication({
    dataDirectory: dir,
    credentials: new MemorySecrets(),
    fetch: (input, init) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (u.startsWith('http://gateway.test')) return gw.fetch(input, init);
      return globalThis.fetch(input, init);
    },
  });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };

  try {
    const dc = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const dm = await call<{ id: string }>('models.model.save', { connectionId: dc.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: dm.id });

    const ic = await call<{ id: string }>('models.connection.save', { name: 'img-gw', protocol: 'images', baseUrl: mediaUrl + '/v1', auth: 'bearer', apiKey: 'img-key' });
    const im = await call<{ id: string }>('models.model.save', { connectionId: ic.id, model: 'gpt-image-1', inputModalities: ['text', 'image'], outputModalities: ['image'], parameters: {} });
    await call('models.role.bind', { role: 'image', modelId: im.id });

    const vc = await call<{ id: string }>('models.connection.save', { name: 'vid-gw', protocol: 'video-gateway', baseUrl: mediaUrl, auth: 'bearer', apiKey: 'vid-key', concurrency: 4 });
    const vm = await call<{ id: string }>('models.model.save', { connectionId: vc.id, model: 'seedance-pro', inputModalities: ['text', 'image'], outputModalities: ['video'], parameters: {} });
    await call('models.role.bind', { role: 'video', modelId: vm.id });

    const created = await call<StudioSnapshot>('create', { title: '多模态桥梁测试', productionMode: 'model_video' });
    await call<StudioSnapshot>('production.set', {
      projectId: created.project!.id,
      expectedRevision: created.project!.revision,
      mode: 'model_video',
      allowGeneratedImages: true,
      allowImportedVideo: true,
    });
    await call('environment', { projectId: created.project!.id, blenderPath: fakeBlender });

    const run = await call<PublicRun>('agent.start', {
      projectId: created.project!.id,
      goal: '执行 3D 深度预演、首尾帧重绘与批次并发视频生成',
      autoApprove: ['read', 'write'],
      maxReviewRounds: 0,
    });

    // Approvals (handling per-call reference-image upload consent before cost approval):
    for (const expectedTool of ['plan_story', 'plan_shots', 'submit_previz_review', 'stylize_keyframe', 'stylize_keyframe', 'batch_generate_media']) {
      let paused = await waitRun(call, run.id, ['paused', 'awaiting_approval', 'complete', 'failed']);
      if (paused.status === 'paused' && paused.visionConsentRequired) {
        await call('agent.resume', { runId: run.id, visionConsentId: paused.visionConsentRequired.id });
        paused = await waitRun(call, run.id, ['awaiting_approval', 'complete', 'failed']);
      }
      assert.equal(paused.pending?.tool, expectedTool, `当前状态=${paused.status}, message=${paused.message}`);
      await approvePending(call, paused);
    }

    const done = await waitRun(call, run.id, ['complete', 'failed']);
    assert.equal(done.status, 'complete', done.message);

    // Verify image-compose hit /v1/images/edits
    assert.ok(mediaRequests.some(r => r.path === '/v1/images/edits'), 'stylize_keyframe 应通过多图合成端点 /v1/images/edits 发送深度参考图');

    // Verify first-last-frame-video sent 2 inputs with first_frame and last_frame roles!
    const flfReq = mediaRequests.find(r => r.path === '/v1/media/jobs' && r.body?.operation === 'first-last-frame-video');
    assert.ok(flfReq, '应发送 first-last-frame-video 操作');
    const inputs = flfReq.body?.inputs as { role?: string }[];
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0]?.role, 'first_frame');
    assert.equal(inputs[1]?.role, 'last_frame');

    // Verify batch_generate_media auto-applied videoClips to BOTH shot1 and shot2
    const snap = await call<StudioSnapshot>('current', { projectId: created.project!.id });
    assert.ok(snap.project?.videoClips?.some(c => c.shotId === shot1), 'shot1 应已自动绑定生成的视频片段');
    assert.ok(snap.project?.videoClips?.some(c => c.shotId === shot2), 'shot2 应已自动绑定生成的视频片段');

    const story = await call<{ shots: { shotId?: string; previz?: { styledKeyframeAssetId?: string; styledTailAssetId?: string } }[] }>('story.get', { projectId: created.project!.id });
    assert.equal(story.shots[0]?.previz?.styledKeyframeAssetId, firstKeyframeAsset);
    assert.equal(story.shots[0]?.previz?.styledTailAssetId, tailKeyframeAsset);
  } finally {
    await app.dispose();
    mediaSrv.closeAllConnections();
    await new Promise<void>(r => mediaSrv.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('v2 Multi-Character Voice Routing, Sequential Turn-Taking, Sidechain Auto-Ducking Mix, Acoustics & Video Deconstruction', async () => {
  const env = inspectToolEnvironment({});
  if (!env.ffmpegAvailable || !env.ffprobeAvailable) return;
  const dir = await mkdtemp(join(tmpdir(), 'yl-v2-sound-deconstruct-'));

  // 1. Verify reference video deconstruction (FFmpeg scdet detects abrupt cut between slate blue 1.0s and bright orange 1.0s)
  const twoSceneMp4 = join(dir, 'two-scene.mp4');
  execFileSync(env.ffmpegPath, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=0x0f172a:s=320x180:d=1.0',
    '-f', 'lavfi', '-i', 'color=c=0xf97316:s=320x180:d=1.2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', twoSceneMp4,
  ], { stdio: 'ignore' });
  const deconstructed = await deconstructReferenceVideo(twoSceneMp4, env);
  assert.ok(deconstructed.durationSeconds > 2.0);
  assert.ok(deconstructed.shotCount >= 2, `应识别至少 2 个镜头切点，实际=${deconstructed.shotCount}`);
  assert.ok(deconstructed.shots.some(s => s.startSeconds > 0.7 && s.startSeconds < 1.3), `切点应在 1.0s 附近，实际=${JSON.stringify(deconstructed.shots)}`);

  // 2. Local OpenAI-speech mock server recording requested voice IDs
  const seenVoices: { voice?: string; input?: string }[] = [];
  const lineWav = synthesize({ kind: 'tone', durationSeconds: 0.6, frequency: 320, volume: 0.5 });
  const ttsSrv = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    seenVoices.push({ voice: body.voice, input: body.input });
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(Buffer.from(lineWav));
  });
  await new Promise<void>(r => ttsSrv.listen(0, '127.0.0.1', () => r()));
  const ttsBase = `http://127.0.0.1:${(ttsSrv.address() as { port: number }).port}/v1`;

  let turn = 0;
  let shotId = '';
  const gw = toolGateway((body) => {
    const t = turn++;
    const msgs = body.messages as { role: string; content?: string }[];
    const lastTool = [...msgs].reverse().find(m => m.role === 'tool')?.content ?? '{}';
    if (t === 0) return { toolCalls: [{ id: 'g0', name: 'project_get', arguments: {} }] };
    if (t === 1) {
      const p = JSON.parse(lastTool);
      shotId = p.shots[0].id;
      return {
        toolCalls: [{
          id: 'ps', name: 'plan_story',
          arguments: {
            title: '双人对白混音测试', logline: '测试同镜多角色专属音色路由、顺序话轮与自动闪避混音',
            style: { look: '写实', palette: '暖灰', typography: '黑体', motion: '固定', negative: '杂乱' },
            characters: [
              { id: 'hero', name: '林探长', voice: 'onyx', features: ['风衣'] },
              { id: 'witness', name: '苏小姐', voice: 'nova', features: ['礼服'] },
            ],
          },
        }],
      };
    }
    if (t === 2) {
      return {
        toolCalls: [{
          id: 'gv', name: 'generate_voice',
          arguments: {
            autoBind: true,
            lines: [
              { shotId, characterId: 'hero', text: '昨晚十点你在书房看到了什么？' },
              { shotId, characterId: 'witness', text: '窗户半开着，桌上只剩那封火漆信。' },
            ],
          },
        }],
      };
    }
    if (t === 3) {
      return {
        toolCalls: [
          { id: 'sfx1', name: 'synthesize_sfx', arguments: { name: '窗外夜雨底噪', kind: 'rain', durationSeconds: 2.0, volume: 0.35, bindToTrack: true } },
        ],
      };
    }
    if (t === 4) return { toolCalls: [{ id: 'g1', name: 'project_get', arguments: {} }] };
    if (t === 5) {
      const rev = JSON.parse(lastTool).revision;
      return {
        toolCalls: [{
          id: 'mix', name: 'audio_mix_master',
          arguments: { expectedRevision: rev, autoDucking: true, duckingDb: 9, voiceReverb: 'room', targetLufs: -14 },
        }],
      };
    }
    if (t === 6) return { toolCalls: [{ id: 'aa', name: 'audio_analyze', arguments: {} }] };
    return { text: '双角色顺序对白、雨声拟音与闪避响度母带已实测完成' };
  });

  const app = await createApplication({
    dataDirectory: dir,
    credentials: new MemorySecrets(),
    fetch: (input, init) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (u.startsWith('http://gateway.test')) return gw.fetch(input, init);
      return globalThis.fetch(input, init);
    },
  });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };

  try {
    const dc = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const dm = await call<{ id: string }>('models.model.save', { connectionId: dc.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: dm.id });

    const sc = await call<{ id: string }>('models.connection.save', { name: 'tts', protocol: 'speech', baseUrl: ttsBase, auth: 'bearer', apiKey: 'tts-secret' });
    const sm = await call<{ id: string }>('models.model.save', { connectionId: sc.id, model: 'gpt-4o-mini-tts', inputModalities: ['text'], outputModalities: ['audio'], parameters: { voice: 'alloy' } });
    await call('models.role.bind', { role: 'speech', modelId: sm.id });

    const created = await call<StudioSnapshot>('create', { title: '对白与混音' });
    shotId = created.project!.shots[0]!.id;
    // Also import a background music bed so sidechain auto-ducking engages!
    const bgmWav = synthesize({ kind: 'ambience_hum', durationSeconds: 2.2, frequency: 110, volume: 0.45 });
    const bgmTmp = join(dir, 'bgm.wav');
    await writeFile(bgmTmp, bgmWav);
    const importedBgm = await call<StudioSnapshot>('import', {
      projectId: created.project!.id,
      expectedRevision: created.project!.revision,
      path: bgmTmp,
    });
    const bgmAssetId = importedBgm.project!.assets[0]!.id;
    await call('audio', {
      projectId: created.project!.id,
      expectedRevision: importedBgm.project!.revision,
      operation: 'add',
      assetId: bgmAssetId,
      role: 'music',
      startSeconds: 0,
      trimStart: 0,
      volume: 0.6,
      fadeIn: 0,
      fadeOut: 0,
    });

    const run = await call<PublicRun>('agent.start', {
      projectId: created.project!.id,
      goal: '生成林探长与苏小姐双人顺序对白并开启自动闪避与响度分析',
      autoApprove: ['read', 'write'],
      maxReviewRounds: 0,
    });

    for (const expectedTool of ['plan_story', 'generate_voice']) {
      const paused = await waitRun(call, run.id, ['awaiting_approval', 'complete', 'failed']);
      assert.equal(paused.pending?.tool, expectedTool);
      await approvePending(call, paused);
    }

    const done = await waitRun(call, run.id, ['complete', 'failed']);
    assert.equal(done.status, 'complete', done.message);

    // 1) Verify distinct character voice routing
    assert.equal(seenVoices.length, 2);
    assert.equal(seenVoices[0]?.voice, 'onyx');
    assert.equal(seenVoices[1]?.voice, 'nova');

    // 2) Verify sequential non-overlapping turn-taking in the same shot + synced subtitles
    const snap = await call<StudioSnapshot>('current', { projectId: created.project!.id });
    const voiceClips = (snap.project?.audioClips ?? []).filter(c => c.role === 'voice' && c.shotId === shotId);
    assert.equal(voiceClips.length, 2);
    assert.equal(voiceClips[0]!.startSeconds, 0);
    assert.ok(voiceClips[1]!.startSeconds >= 0.75, `第 2 句对白应排在第 1 句之后而非叠在 0s，实际=${voiceClips[1]!.startSeconds}`);
    assert.equal(voiceClips[0]!.speaker, '林探长');
    assert.equal(voiceClips[1]!.speaker, '苏小姐');
    assert.equal(snap.project?.subtitles?.length, 2);
    assert.equal(snap.project?.audioMix?.autoDucking, true);
    assert.equal(snap.project?.audioMix?.targetLufs, -14);

    // 3) Verify acoustic analysis returned real measured LUFS
    const acoustics = await call<{ integratedLufs: number | null; durationSeconds: number }>('audio.analyze', { projectId: created.project!.id });
    assert.ok(acoustics.durationSeconds > 1.2);
    assert.ok(acoustics.integratedLufs !== null && Number.isFinite(acoustics.integratedLufs), `应测出真实 LUFS，实际=${acoustics.integratedLufs}`);
  } finally {
    await app.dispose();
    ttsSrv.closeAllConnections();
    await new Promise<void>(r => ttsSrv.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('v2 Post-Production NLE (colorGrade, dissolve, Takes, PiP Overlay, Subtitles, Reframe) & Industrial Delivery Bundle (.srt/.ass/.otio/.fcpxml/.edl)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yl-v2-post-delivery-'));
  const imgA = join(dir, 'take-a.png');
  const imgB = join(dir, 'take-b.png');
  await writeFile(imgA, solidPng(64, 36, 40, 100, 200));
  await writeFile(imgB, solidPng(64, 36, 200, 120, 50));

  let turn = 0;
  let shot1 = '';
  let assetA = '', assetB = '';

  const gw = toolGateway((body) => {
    const t = turn++;
    const msgs = body.messages as { role: string; content?: string }[];
    const lastTool = [...msgs].reverse().find(m => m.role === 'tool')?.content ?? '{}';

    if (t === 0) return { toolCalls: [{ id: 'g0', name: 'project_get', arguments: {} }] };
    if (t === 1) {
      const p = JSON.parse(lastTool);
      shot1 = p.shots[0].id;
      [assetA, assetB] = p.assets.map((a: { id: string }) => a.id);
      return {
        toolCalls: [{
          id: 'sp', name: 'shot_patch',
          arguments: {
            expectedRevision: p.revision,
            patches: [{
              shotId: shot1,
              transition: 'dissolve',
              transitionFrames: 15,
              colorGrade: { exposure: 0.15, contrast: 1.18, saturation: 0.92, temperature: -20, tint: 5, vignette: 0.3 },
            }],
          },
        }],
      };
    }
    if (t === 2) {
      const rev = JSON.parse(lastTool).revision;
      return { toolCalls: [{ id: 't1', name: 'shot_take_manage', arguments: { expectedRevision: rev, action: 'record', shotId: shot1, takeId: 'take-1', assetId: assetA, score: 78, notes: '冷调备选' } }] };
    }
    if (t === 3) {
      const rev = JSON.parse(lastTool).revision;
      return { toolCalls: [{ id: 't2', name: 'shot_take_manage', arguments: { expectedRevision: rev, action: 'record', shotId: shot1, takeId: 'take-2', assetId: assetB, score: 94, notes: '暖调最佳条' } }] };
    }
    if (t === 4) {
      const rev = JSON.parse(lastTool).revision;
      return { toolCalls: [{ id: 't3', name: 'shot_take_manage', arguments: { expectedRevision: rev, action: 'select', shotId: shot1, takeId: 'take-2' } }] };
    }
    if (t === 5) {
      const rev = JSON.parse(lastTool).revision;
      return {
        toolCalls: [{
          id: 'ov', name: 'post_overlay_subtitle',
          arguments: {
            expectedRevision: rev,
            addOverlay: { shotId: shot1, assetId: assetA, x: 68, y: 8, width: 26, height: 26, opacity: 0.9, borderRadius: 12 },
            setSubtitles: [
              { id: 'sub-1', startSeconds: 0.2, endSeconds: 2.4, speaker: '林探长', text: '注意右上角监控画面的时间码。', shotId: shot1 },
            ],
          },
        }],
      };
    }
    if (t === 6) {
      const rev = JSON.parse(lastTool).revision;
      return { toolCalls: [{ id: 'rf', name: 'reframe_project', arguments: { expectedRevision: rev, aspectRatio: '9:16', fps: 24 } }] };
    }
    if (t === 7) {
      return { toolCalls: [{ id: 'exp', name: 'export_delivery_bundle', arguments: { formats: ['srt', 'ass', 'otio', 'fcpxml', 'edl'] } }] };
    }
    return { text: '后期精剪调色、竖屏重构图与五种工业交换格式交付包已全部导出' };
  });

  const projectsDir = join(dir, 'projects');
  const app = await createApplication({ dataDirectory: dir, projectsDirectory: projectsDir, credentials: new MemorySecrets(), fetch: gw.fetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };

  try {
    const dc = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const dm = await call<{ id: string }>('models.model.save', { connectionId: dc.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: dm.id });

    const created = await call<StudioSnapshot>('create', { title: '后期与交付测试' });
    const imp1 = await call<StudioSnapshot>('import', { projectId: created.project!.id, expectedRevision: created.project!.revision, path: imgA });
    await call<StudioSnapshot>('import', { projectId: created.project!.id, expectedRevision: imp1.project!.revision, path: imgB });

    const run = await call<PublicRun>('agent.start', {
      projectId: created.project!.id,
      goal: '执行调色、多候选条优选、画中画字幕、9:16 重构图并导出全套后期工程包',
      autoApprove: ['read', 'write'],
      maxReviewRounds: 0,
    });

    const paused = await waitRun(call, run.id, ['awaiting_approval', 'complete', 'failed']);
    assert.equal(paused.pending?.tool, 'export_delivery_bundle');
    await approvePending(call, paused);

    const done = await waitRun(call, run.id, ['complete', 'failed']);
    assert.equal(done.status, 'complete', done.message);

    const snap = await call<StudioSnapshot>('current', { projectId: created.project!.id });
    const p = snap.project!;
    assert.equal(p.target.width, 1080);
    assert.equal(p.target.height, 1920);
    assert.equal(p.target.fps.num, 24);
    assert.equal(p.shots[0]!.transition, 'dissolve');
    assert.equal(p.shots[0]!.colorGrade?.temperature, -20);
    assert.equal(p.shots[0]!.takes?.length, 2);
    assert.ok(p.shots[0]!.assetIds.includes(assetB), '选中的 take-2 资产应已绑定到主镜头');
    assert.equal(p.overlayClips?.length, 1);
    assert.equal(p.subtitles?.length, 1);

    // Verify all 5 delivery files on disk (relative paths inside project root)
    assert.ok(snap.root);
    const exported = await call<{ files: { format: string; relativePath: string; bytes: number }[] }>('delivery.export', { projectId: p.id });
    assert.equal(exported.files.length, 5);
    const srtText = await readFile(join(snap.root!, exported.files.find(f => f.format === 'srt')!.relativePath), 'utf8');
    const assText = await readFile(join(snap.root!, exported.files.find(f => f.format === 'ass')!.relativePath), 'utf8');
    const otioJson = JSON.parse(await readFile(join(snap.root!, exported.files.find(f => f.format === 'otio')!.relativePath), 'utf8'));
    const fcpxmlText = await readFile(join(snap.root!, exported.files.find(f => f.format === 'fcpxml')!.relativePath), 'utf8');
    const edlText = await readFile(join(snap.root!, exported.files.find(f => f.format === 'edl')!.relativePath), 'utf8');

    assert.match(srtText, /林探长：注意右上角监控画面的时间码/);
    assert.match(assText, /\[V4\+ Styles\]/);
    assert.equal(otioJson.OTIO_SCHEMA, 'Timeline.1');
    assert.match(fcpxmlText, /<fcpxml version="1\.10">/);
    assert.match(edlText, /TITLE:/);

    // Also verify pure formatters directly
    assert.equal(deriveSubtitles(p).length, 1);
    assert.ok(formatSrt(deriveSubtitles(p)).includes('00:00:00,200'));
    assert.ok(formatAss(deriveSubtitles(p), p.target).includes('PlayResX: 1080'));
    assert.ok(formatOtio(p).includes('Timeline.1'));
    assert.ok(formatFcpxml(p).includes('1080'));
    assert.ok(formatEdl(p).includes('FCM: NON-DROP FRAME'));
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
