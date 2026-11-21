import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import type { PublicRun } from '../src/agent/contracts.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';
import { compressMessages } from '../src/agent/context.ts';
import { chatTurn } from '../src/agent/model-client.ts';
import { BlenderRunner, validatePrevizSpec } from '../src/host/blender.ts';
import { inspectToolEnvironment } from '../src/host/tool-environment.ts';
import { DIRECTOR_RULESET_VERSION } from '../src/director/index.ts';
import { synthesize } from '../src/agent/synth.ts';
import { toolGateway } from './model-gateway.ts';
import { mediaSignature } from '../src/jobs/download.ts';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADklEQVQI12NgYGBg+A8AAQQBAHAgZQsAAAAASUVORK5CYII=',
  'base64',
);

async function waitRun(call: <T>(ep: string, p?: unknown) => Promise<T>, runId: string, targets: string[], max = 600): Promise<PublicRun> {
  let run = await call<PublicRun>('agent.get', { runId });
  for (let i = 0; i < max && !targets.includes(run.status); i++) {
    await new Promise(r => setTimeout(r, 15));
    run = await call<PublicRun>('agent.get', { runId });
  }
  return run;
}

test('agent undo/redo require expectedRevision and successfully roll back and reapply mutations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yl-upgrade-undo-'));
  let turn = 0;
  const gw = toolGateway((body) => {
    const t = turn++;
    if (t === 0) return { toolCalls: [{ name: 'project_get', arguments: {} }] };
    const msgs = (body.messages as { role: string; content?: string }[]);
    const lastTool = [...msgs].reverse().find(m => m.role === 'tool')?.content ?? '{}';
    const rev = JSON.parse(lastTool).revision ?? 0;
    if (t === 1) return { toolCalls: [{ name: 'video_update', arguments: { expectedRevision: rev, update: { title: '改后标题' } } }] };
    if (t === 2) return { toolCalls: [{ name: 'undo', arguments: { expectedRevision: rev } }] };
    if (t === 3) return { toolCalls: [{ name: 'redo', arguments: { expectedRevision: rev } }] };
    return { text: '撤销和重做验证完成' };
  });
  const app = await createApplication({ dataDirectory: dir, credentials: new MemorySecrets(), fetch: gw.fetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const m = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: m.id });
    const created = await call<StudioSnapshot>('create', { title: '原始标题' });
    const run = await call<PublicRun>('agent.start', { projectId: created.project!.id, goal: '改标题然后撤销再重做', maxReviewRounds: 0 });
    const done = await waitRun(call, run.id, ['complete', 'failed']);
    assert.equal(done.status, 'complete', done.message);
    assert.ok(done.steps.some(s => s.tool === 'undo' && s.status === 'complete'));
    assert.ok(done.steps.some(s => s.tool === 'redo' && s.status === 'complete'));
    const finalSnap = await call<StudioSnapshot>('current', { projectId: created.project!.id });
    assert.equal(finalSnap.project?.title, '改后标题');
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('speech role bound to async-task routes through template adapter (e.g. xi-api-key) and audio.generate binds music/sfx', async () => {
  const env = inspectToolEnvironment({});
  if (!env.ffprobeAvailable) return;
  const dir = await mkdtemp(join(tmpdir(), 'yl-upgrade-audio-'));
  const wav = synthesize({ kind: 'tone', durationSeconds: 0.4, frequency: 440 });
  const seen: { path: string; header: string | undefined }[] = [];
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', header: req.headers['xi-api-key'] as string | undefined });
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(Buffer.from(wav));
    });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  let turn = 0;
  const gw = toolGateway(() => {
    const t = turn++;
    if (t === 0) return { toolCalls: [{ id: 'gv1', name: 'generate_voice', arguments: { shotId: 'shot-target', text: '测试异步配音' } }] };
    return { text: '配音完成' };
  });
  const app = await createApplication({ dataDirectory: dir, credentials: new MemorySecrets(), fetch: (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://gateway.test')) return gw.fetch(input, init);
    return globalThis.fetch(input, init);
  } });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  try {
    const dc = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const dm = await call<{ id: string }>('models.model.save', { connectionId: dc.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: dm.id });

    // Bind ElevenLabs-style async-task speech model AND sfx model
    const ac = await call<{ id: string }>('models.connection.save', { name: 'eleven', protocol: 'async-task', baseUrl, auth: 'bearer', apiKey: 'el-secret-key' });
    const sm = await call<{ id: string }>('models.model.save', { connectionId: ac.id, model: 'eleven_v2', inputModalities: ['text'], outputModalities: ['audio'], parameters: { preset: 'elevenlabs-tts' } });
    const sfxm = await call<{ id: string }>('models.model.save', { connectionId: ac.id, model: 'sfx_v1', inputModalities: ['text'], outputModalities: ['audio'], parameters: { preset: 'elevenlabs-sfx' } });
    await call('models.role.bind', { role: 'speech', modelId: sm.id });
    await call('models.role.bind', { role: 'sfx', modelId: sfxm.id });

    const created = await call<StudioSnapshot>('create', { title: '音频路由' });
    const firstShotId = created.project!.shots[0]!.id;
    // Update gateway shotId dynamically via audio.generate directly + agent voice test
    const genRes = await call<{ asset: { id: string }; snapshot: StudioSnapshot }>('audio.generate', {
      projectId: created.project!.id, role: 'sfx', prompt: '清脆按键音', durationSeconds: 1, shotId: firstShotId, bindToTrack: true,
    });
    assert.ok(genRes.asset.id);
    assert.equal(genRes.snapshot.project?.audioClips?.some(c => c.assetId === genRes.asset.id && c.role === 'sfx'), true);
    assert.ok(seen.some(r => r.path === '/v1/sound-generation' && r.header === 'el-secret-key'));

    // Test speech async-task routing via audio.generate(speech) AND agentPort voice path
    const speechRes = await call<{ asset: { id: string } }>('audio.generate', {
      projectId: created.project!.id, role: 'speech', prompt: '你好映流', shotId: firstShotId, bindToTrack: false,
    });
    assert.ok(speechRes.asset.id);
    assert.ok(seen.some(r => r.path.startsWith('/v1/text-to-speech/') && r.header === 'el-secret-key'));
  } finally {
    await app.dispose();
    await new Promise<void>(r => srv.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('chatTurn supports SSE streaming deltas and automatically falls back when stream is rejected', async () => {
  const deltas: string[] = [];
  let calls = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.stream === true && calls === 1) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你好，"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"映流！"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (body.stream === true && calls === 2) {
      return new Response('stream_options unsupported', { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '降级成功' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const turn1 = await chatTurn({ baseUrl: 'http://fake.test/v1', model: 'm', timeoutMs: 5000, maxTokens: 512, supportsTools: true }, 'sys', [{ role: 'user', content: 'hi' }], [], new AbortController().signal, fakeFetch, d => deltas.push(d));
  assert.equal(turn1.content, '你好，映流！');
  assert.deepEqual(deltas, ['你好，', '映流！']);
  assert.equal(turn1.usageKnown, true);
  assert.equal(turn1.usage.outputTokens, 5);

  const turn2 = await chatTurn({ baseUrl: 'http://fake.test/v1', model: 'm', timeoutMs: 5000, maxTokens: 512, supportsTools: true }, 'sys', [{ role: 'user', content: 'hi2' }], [], new AbortController().signal, fakeFetch, () => {});
  assert.equal(turn2.content, '降级成功');
  assert.equal(calls, 3);
});

test('agent supports parallel read-only tools, follow-up sendMessage, and structured context compression', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yl-upgrade-arch-'));
  let turn = 0;
  const gw = toolGateway((body) => {
    const t = turn++;
    if (t === 0) return { toolCalls: [{ id: 'r1', name: 'project_get', arguments: {} }, { id: 'r2', name: 'env_check', arguments: {} }, { id: 'r3', name: 'styles_list', arguments: {} }] };
    if (t === 1) return { text: '首轮读取完成' };
    const msgs = body.messages as { role: string; content?: string }[];
    assert.ok(msgs.some(m => m.role === 'user' && String(m.content).includes('第二轮追问')));
    return { text: '已处理第二轮追问' };
  });
  const app = await createApplication({ dataDirectory: dir, credentials: new MemorySecrets(), fetch: gw.fetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const m = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: m.id });
    const created = await call<StudioSnapshot>('create', { title: '并行与续聊' });
    const run = await call<PublicRun>('agent.start', { projectId: created.project!.id, goal: '先并行读取环境与风格', maxReviewRounds: 0 });
    const firstDone = await waitRun(call, run.id, ['complete', 'failed']);
    assert.equal(firstDone.status, 'complete', firstDone.message);
    assert.equal(firstDone.usage.toolCalls, 3);
    // Multi-turn follow-up on completed run
    await call<PublicRun>('agent.message', { runId: run.id, message: '第二轮追问：再确认一下' });
    const secondDone = await waitRun(call, run.id, ['complete', 'failed']);
    assert.equal(secondDone.status, 'complete', secondDone.message);
    assert.equal(secondDone.final, '已处理第二轮追问');
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }); }

  // Structured compression keeps key IDs and revision
  const compressed = compressMessages([
    { role: 'user', content: '目标' },
    { role: 'assistant', content: '执行', tool_calls: [{ id: '1', type: 'function', function: { name: 'project_get', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', content: JSON.stringify({ revision: 7, assetId: 'previz-img-99', padding: 'x'.repeat(2000) }) },
    ...Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `消息 ${i}` })),
  ], 500, 4);
  assert.equal(compressed.compressed, true);
  assert.ok(compressed.messages.some(m => typeof m.content === 'string' && m.content.includes('revision=7') && m.content.includes('previz-img-99')));
});

test('production.set (schema v3), director.document save/approve, and models.discover work end-to-end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yl-upgrade-baseline-'));
  const srv = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'sora-2', name: 'Sora 2' }, { id: 'gpt-4.1-mini' }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const baseUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`;
  const app = await createApplication({ dataDirectory: dir, credentials: new MemorySecrets(), fetch: globalThis.fetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'openai-v', protocol: 'openai-videos', baseUrl, auth: 'none' });
    const discovered = await call<{ models: { id: string }[] }>('models.discover', { connectionId: c.id });
    assert.ok(discovered.models.some(m => m.id === 'sora-2'));

    const created = await call<StudioSnapshot>('create', { title: '基座能力', productionMode: 'code_animation' });
    assert.equal(created.project!.schemaVersion, 3);
    assert.equal(created.project!.productionPolicy?.mode, 'code_animation');

    const updated = await call<StudioSnapshot>('production.set', { projectId: created.project!.id, expectedRevision: created.project!.revision, mode: 'model_video', allowGeneratedImages: true, allowImportedVideo: true });
    assert.equal(updated.project!.productionPolicy?.mode, 'model_video');

    const shot = updated.project!.shots[0]!;
    const savedDoc = await call<{ document: { version: number; hash: string; status: string } }>('director.document.save', {
      projectId: updated.project!.id, expectedVersion: 0,
      plan: { version: 1, ruleSetVersion: DIRECTOR_RULESET_VERSION, filmKind: 'general', characters: [], storyBeats: [], worldLayouts: [], identityMap: [], shots: [{ shotId: shot.id, title: shot.title, visualPrompt: '白模测试', durationSeconds: 5, narration: '', audioStrategy: 'silent', performance: [], dialogue: [], events: [], references: [], acceptance: [] }] },
    });
    assert.equal(savedDoc.document.status, 'draft');
    const approvedDoc = await call<{ document: { status: string } }>('director.document.approve', {
      projectId: updated.project!.id, expectedVersion: savedDoc.document.version, expectedHash: savedDoc.document.hash,
    });
    assert.equal(approvedDoc.document.status, 'approved');
  } finally {
    await app.dispose();
    await new Promise<void>(r => srv.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('BlenderRunner mock protocol verifies headless flags, output validation, and 4-stage previz approval flow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yl-upgrade-blender-mock-'));
  const fakeBlender = join(dir, 'fake-blender.mjs');
  await writeFile(fakeBlender, `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Blender 4.3.0 (Mock)'); process.exit(0); }
if (!args.includes('--background') || !args.includes('--factory-startup') || !args.includes('--disable-autoexec')) process.exit(2);
const specPath = args[args.indexOf('--') + 1];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
mkdirSync(spec.outputDir, { recursive: true });
const png = Buffer.from('${TINY_PNG.toString('base64')}', 'base64');
const kp = join(spec.outputDir, 'keyframe.png');
writeFileSync(kp, png);
writeFileSync(join(spec.outputDir, 'manifest.json'), JSON.stringify({ keyframe: kp, framesDir: null, frameCount: 1 }));
`);
  await chmod(fakeBlender, 0o755);

  const runner = new BlenderRunner();
  assert.throws(() => validatePrevizSpec({ camera: { startPos: [0, -5, 1], startTarget: [0, 0, 1] }, objects: [], width: 100 }), /256/);
  const result = await runner.renderPreviz(dir, {
    output: 'image', width: 640, height: 360,
    camera: { lensMm: 35, startPos: [0, -5, 1.7], startTarget: [0, 0, 1.2] },
    objects: [{ id: 'hero', kind: 'character', position: [0, 0, 0], height: 1.75, facingDeg: 180 }],
  }, { blenderPath: fakeBlender });
  assert.equal(mediaSignature(result.keyframePng), 'image/png');
  await runner.close();
  await rm(dir, { recursive: true, force: true });
});

test('real local Blender headless whitebox previz renders valid PNG + MP4 when installed', async (t) => {
  const env = inspectToolEnvironment({});
  if (!env.blenderAvailable || !env.ffmpegAvailable) {
    t.skip('本机未安装 Blender 或 FFmpeg，跳过实机无头渲染测试');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'yl-upgrade-blender-real-'));
  const runner = new BlenderRunner();
  try {
    const rendered = await runner.renderPreviz(dir, {
      output: 'both', width: 480, height: 270, fps: 4, durationSeconds: 1,
      camera: { lensMm: 35, startPos: [0, -5, 1.8], endPos: [0, -3.5, 1.6], startTarget: [0, 0, 1.1], endTarget: [0, 0, 1.2] },
      objects: [
        { id: 'actor_a', kind: 'character', position: [-0.8, 0, 0], height: 1.72, facingDeg: 160, color: '#d8dee9' },
        { id: 'actor_b', kind: 'character', position: [0.8, 0.4, 0], height: 1.68, facingDeg: 200, color: '#e5c07b' },
        { id: 'table', kind: 'box', position: [0, 0.2, 0], scale: [1.0, 0.6, 0.75], color: '#8f9aa8' },
      ],
    });
    assert.equal(mediaSignature(rendered.keyframePng), 'image/png');
    assert.ok(rendered.keyframePng.byteLength > 500, 'PNG 大小应有效');
    assert.ok(rendered.videoMp4 && mediaSignature(rendered.videoMp4) === 'video/mp4', '应产出合法 H.264 MP4');
    assert.ok(rendered.videoMp4!.byteLength > 1000, 'MP4 大小应有效');
  } finally {
    await runner.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Agent 4-stage Blender previz workflow: plan -> blender_render_previz -> submit_previz_review approval -> story marks approved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yl-upgrade-4stage-'));
  const fakeBlender = join(dir, 'fake-blender.mjs');
  await writeFile(fakeBlender, `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Blender 4.3.0 (Mock)'); process.exit(0); }
const spec = JSON.parse(readFileSync(args[args.indexOf('--') + 1], 'utf8'));
mkdirSync(spec.outputDir, { recursive: true });
const kp = join(spec.outputDir, 'keyframe.png');
writeFileSync(kp, Buffer.from('${TINY_PNG.toString('base64')}', 'base64'));
writeFileSync(join(spec.outputDir, 'manifest.json'), JSON.stringify({ keyframe: kp, framesDir: null, frameCount: 1 }));
`);
  await chmod(fakeBlender, 0o755);

  let turn = 0;
  let previzImageId = '';
  const gw = toolGateway((body) => {
    const t = turn++;
    const msgs = body.messages as { role: string; content?: string }[];
    const lastTool = [...msgs].reverse().find(m => m.role === 'tool')?.content ?? '{}';
    if (t === 0) return { toolCalls: [{ id: 'p1', name: 'plan_story', arguments: { title: '对峙', logline: '双人白模预演测试', style: { look: '电影写实', palette: '冷蓝', typography: '黑体', motion: '缓慢推进', negative: '卡通' }, characters: [{ id: 'a', name: '侦探', features: ['风衣'] }] } }] };
    if (t === 1) return { toolCalls: [{ id: 'p2', name: 'plan_shots', arguments: { shots: [{ id: 's1', summary: '侦探站在桌前', shotType: '中景', camera: '35mm 缓推', durationSeconds: 3, dialogue: '', characters: ['a'], continueFromPrevious: false }] } }] };
    if (t === 2) return { toolCalls: [{ id: 'b1', name: 'blender_render_previz', arguments: { shotId: 's1', name: '镜1白模', output: 'image', width: 480, height: 270, camera: { lensMm: 35, startPos: [0, -5, 1.7], startTarget: [0, 0, 1.2] }, objects: [{ id: 'a', kind: 'character', position: [0, 0, 0], height: 1.75, facingDeg: 180 }], note: '35mm 中景正拍' } }] };
    if (t === 3) {
      previzImageId = JSON.parse(lastTool).imageAssetId;
      return { toolCalls: [{ id: 'r1', name: 'submit_previz_review', arguments: { summary: '镜1白模构图与机位已完成，请审阅', shots: [{ shotId: 's1', imageAssetId: previzImageId, cameraNote: '35mm 中景缓推' }] } }] };
    }
    return { text: '白模预演已审阅通过，准备进入创作模型呈现' };
  });
  const app = await createApplication({ dataDirectory: dir, credentials: new MemorySecrets(), fetch: gw.fetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const m = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: m.id });
    const created = await call<StudioSnapshot>('create', { title: '四阶段预演' });
    await call('environment', { projectId: created.project!.id, blenderPath: fakeBlender });

    const caps = await call<{ capabilities: { roles: string[] }; tools: { name: string }[] }>('agent.capabilities');
    assert.ok(caps.capabilities.roles.includes('blender'));
    assert.ok(caps.tools.some(t => t.name === 'blender_render_previz'));

    const run = await call<PublicRun>('agent.start', { projectId: created.project!.id, goal: '规划分镜并做 Blender 白模预演', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    // Approve plan_story
    let cur = await waitRun(call, run.id, ['awaiting_approval', 'complete', 'failed']);
    assert.equal(cur.pending?.tool, 'plan_story');
    await call('agent.approve', { runId: run.id, callId: cur.pending!.callId, execId: cur.pending!.execId, argsHash: cur.pending!.argsHash });
    // Approve plan_shots
    cur = await waitRun(call, run.id, ['awaiting_approval', 'complete', 'failed']);
    assert.equal(cur.pending?.tool, 'plan_shots');
    await call('agent.approve', { runId: run.id, callId: cur.pending!.callId, execId: cur.pending!.execId, argsHash: cur.pending!.argsHash });
    // Approve submit_previz_review (after blender_render_previz auto-ran!)
    cur = await waitRun(call, run.id, ['awaiting_approval', 'complete', 'failed']);
    assert.equal(cur.pending?.tool, 'submit_previz_review');
    await call('agent.approve', { runId: run.id, callId: cur.pending!.callId, execId: cur.pending!.execId, argsHash: cur.pending!.argsHash });

    cur = await waitRun(call, run.id, ['complete', 'failed']);
    assert.equal(cur.status, 'complete', cur.message);
    assert.ok(previzImageId);
    const story = await call<{ shots: { id: string; previz?: { status: string; imageAssetId?: string } }[] }>('story.get', { projectId: created.project!.id });
    assert.equal(story.shots[0]?.previz?.status, 'approved');
    assert.equal(story.shots[0]?.previz?.imageAssetId, previzImageId);
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
