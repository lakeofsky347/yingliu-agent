import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import type { AgentRun, PublicRun } from '../src/agent/contracts.ts';
import type { Story } from '../src/agent/story.ts';
import { DIRECTOR_RULESET_VERSION } from '../src/director/index.ts';
import { readDirectorDocument } from '../src/director/document.ts';
import { encodeRgbaPng } from '../src/host/contact-sheet.ts';
import { inspectToolEnvironment } from '../src/host/tool-environment.ts';
import type { MediaTask } from '../src/jobs/contracts.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';
import { toolGateway } from './model-gateway.ts';

function solidPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height * 4; i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
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
  assert.equal(run.status, 'awaiting_approval', `预期 awaiting_approval，实际=${run.status} (${run.message})`);
  assert.ok(run.pending);
  await call('agent.approve', {
    runId: run.id,
    callId: run.pending.callId,
    execId: run.pending.execId,
    argsHash: run.pending.argsHash,
  });
}

test('Round3 #10 & #08: Queued pending video re-checks production policy before remote POST, and dedicated lip-sync template blocks text-to-video preflight', async () => {
  const env = inspectToolEnvironment({});
  assert.equal(env.ffmpegAvailable, true, '本机需具备 FFmpeg');
  const dir = await mkdtemp(join(tmpdir(), 'yl-r3-queue-policy-'));
  const sampleMp4 = join(dir, 'sample.mp4');
  execFileSync(env.ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sampleMp4], { stdio: 'ignore' });
  const mp4Bytes = await readFile(sampleMp4);

  let remoteVideoSubmits = 0;
  let replicateLipSyncSubmits = 0;
  const gate: { onFirstStarted?: () => void; releaseFirst?: () => void } = {};
  const firstStarted = new Promise<void>(r => { gate.onFirstStarted = r; });

  const customFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://vid-q.test')) {
      if (init?.method === 'POST' && url.endsWith('/media/jobs')) {
        remoteVideoSubmits++;
        if (remoteVideoSubmits === 1) {
          gate.onFirstStarted?.();
          await new Promise<void>(r => { gate.releaseFirst = r; });
        }
        return new Response(JSON.stringify({
          jobId: `qjob-${remoteVideoSubmits}`,
          status: 'succeeded',
          artifacts: [{ url: 'http://cdn.test/out.mp4', mimeType: 'video/mp4' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        jobId: 'qjob-1',
        status: 'succeeded',
        artifacts: [{ url: 'http://cdn.test/out.mp4', mimeType: 'video/mp4' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('http://replicate-ls.test')) {
      if (init?.method === 'POST') replicateLipSyncSubmits++;
      return new Response(JSON.stringify({ id: 'rep-1', status: 'succeeded', output: 'http://cdn.test/out.mp4' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'http://cdn.test/out.mp4') {
      return new Response(mp4Bytes, { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const app = await createApplication({
    dataDirectory: dir,
    projectsDirectory: join(dir, 'projects'),
    credentials: new MemorySecrets(),
    fetch: customFetch,
  });
  const call = async <T,>(ep: string, p: unknown = {}) => {
    const r = await app.route(ep, p);
    if (!r.ok) throw new Error(ep + ': ' + r.error.message);
    return r.value as T;
  };

  try {
    // concurrency: 1 so task 1 enters HTTP POST while task 2 stays in phase === 'pending'
    const cVid = await call<{ id: string }>('models.connection.save', {
      name: 'vid-serial',
      protocol: 'video-gateway',
      baseUrl: 'http://vid-q.test/v1',
      auth: 'none',
      concurrency: 1,
    });
    const mVid = await call<{ id: string }>('models.model.save', {
      connectionId: cVid.id,
      model: 'vid-v1',
      inputModalities: ['text', 'image'],
      outputModalities: ['video'],
      parameters: {},
    });
    await call('models.role.bind', { role: 'video', modelId: mVid.id });

    const created = await call<StudioSnapshot>('create', { title: '排队视频切模式复检', productionMode: 'model_video' });
    const pid = created.project!.id;
    const shot1 = created.project!.shots[0]!.id;
    const shot2 = created.project!.shots[1]!.id;
    await call('production.set', { projectId: pid, expectedRevision: 0, mode: 'model_video', allowGeneratedImages: true, allowImportedVideo: true });
    const snapMv = await call<StudioSnapshot>('current', { projectId: pid });

    const t1 = await call<MediaTask>('media.generate', {
      projectId: pid,
      shotId: shot1,
      expectedRevision: snapMv.project!.revision,
      operation: 'text-to-video',
      prompt: '已在途的第一条视频请求',
    });
    await firstStarted;

    const t2 = await call<MediaTask>('media.generate', {
      projectId: pid,
      shotId: shot2,
      expectedRevision: snapMv.project!.revision,
      operation: 'text-to-video',
      prompt: '尚未发出的排队第二条视频请求',
    });
    assert.equal(t2.phase, 'pending', '受并发上限排队时第二条应处于 pending');
    assert.equal(remoteVideoSubmits, 1);

    // Switch project to code_animation BEFORE t2 leaves pending!
    const curBeforeSwitch = await call<StudioSnapshot>('current', { projectId: pid });
    await call('production.set', {
      projectId: pid,
      expectedRevision: curBeforeSwitch.project!.revision,
      mode: 'code_animation',
      allowGeneratedImages: true,
      allowImportedVideo: false,
    });

    // Release t1 -> t1 finishes downloading to ready, while t2 MUST fail locally with 0 extra HTTP POSTs!
    gate.releaseFirst?.();
    for (let i = 0; i < 100; i++) {
      const s1 = await call<MediaTask>('media.get', { taskId: t1.id });
      const s2 = await call<MediaTask>('media.get', { taskId: t2.id });
      if (s1.phase === 'ready' && s2.phase === 'failed') break;
      await new Promise(r => setTimeout(r, 20));
    }

    const finalT1 = await call<MediaTask>('media.get', { taskId: t1.id });
    const finalT2 = await call<MediaTask>('media.get', { taskId: t2.id });
    assert.equal(finalT1.phase, 'ready', '已提交在途的第一条任务可正常回收落盘（但不可被采用）');
    assert.equal(finalT2.phase, 'failed', '尚未发出的排队视频任务必须在发送前被策略拦截');
    assert.match(finalT2.error ?? '', /制作策略|代码动画|视频/, `预期制作策略拦截，实际=${finalT2.error}`);
    assert.equal(remoteVideoSubmits, 1, '模拟远端收到的视频 POST 请求数必须保持为 1，严禁发出第 2 条');

    // #08 Reverse gate: Dedicated replicate-lipsync preset MUST reject text-to-video preflight with 0 remote POSTs!
    await call('production.set', {
      projectId: pid,
      expectedRevision: (await call<StudioSnapshot>('current', { projectId: pid })).project!.revision,
      mode: 'model_video',
      allowGeneratedImages: true,
      allowImportedVideo: true,
    });
    const cRep = await call<{ id: string }>('models.connection.save', {
      name: 'rep-ls-only',
      protocol: 'async-task',
      baseUrl: 'http://replicate-ls.test',
      auth: 'none',
    });
    const mRep = await call<{ id: string }>('models.model.save', {
      connectionId: cRep.id,
      model: 'sync/lipsync-2',
      inputModalities: ['text'],
      outputModalities: ['video'],
      parameters: { preset: 'replicate-lipsync' },
    });
    await call('models.role.bind', { role: 'video', modelId: mRep.id });

    const snapForLs = await call<StudioSnapshot>('current', { projectId: pid });
    const badTtvOnLipSync = await app.route('media.generate', {
      projectId: pid,
      shotId: shot1,
      expectedRevision: snapForLs.project!.revision,
      operation: 'text-to-video',
      prompt: '误把专用口型模板用于普通文生视频',
    });
    assert.equal(badTtvOnLipSync.ok, false, '专用口型同步模板不得接收普通 text-to-video 请求');
    assert.equal(badTtvOnLipSync.error?.code, 'UNSUPPORTED_MEDIA_CAPABILITY');
    assert.equal(replicateLipSyncSubmits, 0, '专用口型同步模板被误用时远端 POST 数必须为 0');
  } finally {
    gate.releaseFirst?.();
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Round3 #03, #11, #04/#09 & Scope Guard: Inner Foley crash-window idempotency, same-tool 7th call skip callId, cancelled render_check honesty + core check-fix-recheck loop, and video/audio clip scope guard', async () => {
  const env = inspectToolEnvironment({});
  assert.equal(env.ffmpegAvailable, true);
  const dir = await mkdtemp(join(tmpdir(), 'yl-r3-subagent-'));
  const sampleMp4 = join(dir, 'clip.mp4');
  execFileSync(env.ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sampleMp4], { stdio: 'ignore' });
  const mp4Bytes = await readFile(sampleMp4);

  type SubMode = 'clip_scope' | 'same_tool_7th' | 'qc_cancel' | 'coder_fix_loop' | 'sfx_idempotent';
  let mode: SubMode = 'clip_scope';
  let subTurn = 0;
  let directorTurn = 0;
  let shot1 = '';
  let shot2 = '';
  let shot2VideoClipId = '';
  let shot2AudioClipId = '';
  const capturedReceipts: Record<string, unknown>[] = [];
  const subToolResponses: string[] = [];

  const gw = toolGateway((body) => {
    const msgs = body.messages as { role: string; content?: string }[];
    const sys = String(msgs[0]?.content ?? '');
    const isSub = sys.includes('你正在作为子代理协助总导演');

    if (isSub) {
      const st = subTurn++;
      if (mode === 'clip_scope') {
        if (st === 0) return { toolCalls: [{ id: 'cs-pg', name: 'project_get', arguments: {} }] };
        if (st === 1) {
          const rev = JSON.parse([...msgs].reverse().find(m => m.role === 'tool')!.content!).revision;
          return {
            toolCalls: [
              { id: 'bad-vclip', name: 'video_clip_extract', arguments: { expectedRevision: rev, clipId: shot2VideoClipId } },
              { id: 'bad-aclip', name: 'audio_edit', arguments: { expectedRevision: rev, action: 'remove', request: { id: shot2AudioClipId } } },
            ],
          };
        }
        for (const m of msgs.filter(x => x.role === 'tool')) subToolResponses.push(String(m.content ?? ''));
        return { text: '越界剪辑与音频移除已被拦截' };
      }

      if (mode === 'same_tool_7th') {
        if (st === 0) return { toolCalls: [{ id: 'st7-pg0', name: 'project_get', arguments: {} }] };
        if (st === 1) {
          const rev = JSON.parse([...msgs].reverse().find(m => m.role === 'tool')!.content!).revision;
          // Call #1 patches shot1; calls #2-#6 are 5 reads; call #7 is ALSO shot_patch but targeting shot2!
          return {
            toolCalls: [
              { id: 'call-1-shot1', name: 'shot_patch', arguments: { expectedRevision: rev, patches: [{ shotId: shot1, title: '第一镜合法改名' }] } },
              { id: 'call-2', name: 'project_get', arguments: {} },
              { id: 'call-3', name: 'bible_get', arguments: {} },
              { id: 'call-4', name: 'story_get', arguments: {} },
              { id: 'call-5', name: 'env_check', arguments: {} },
              { id: 'call-6', name: 'skill_read', arguments: { topic: 'scene-structure' } },
              { id: 'call-7-shot2', name: 'shot_patch', arguments: { expectedRevision: rev + 1, patches: [{ shotId: shot2, title: '第二镜第7项不应生效' }] } },
            ],
          };
        }
        return { text: '未重试第7项直接结束' };
      }

      if (mode === 'qc_cancel') {
        if (st === 0) return { toolCalls: [{ id: 'qc-rc-cancel', name: 'render_check', arguments: {} }] };
        return { text: '预览被取消，如实结束' };
      }

      if (mode === 'coder_fix_loop') {
        if (st === 0) return { toolCalls: [{ id: 'cf-rc1', name: 'render_check', arguments: {} }] };
        if (st === 1) return { toolCalls: [{ id: 'cf-pg', name: 'project_get', arguments: {} }] };
        if (st === 2) {
          const rev = JSON.parse([...msgs].reverse().find(m => m.role === 'tool')!.content!).revision;
          return {
            toolCalls: [{
              id: 'cf-write',
              name: 'shot_write_source',
              arguments: {
                expectedRevision: rev,
                shotId: shot1,
                source: {
                  html: '<div id="fixed">修复后通过校验</div>',
                  css: '#fixed { color: #fff; font-size: 36px; }',
                  js: 'export function render() {}',
                },
              },
            }],
          };
        }
        if (st === 3) return { toolCalls: [{ id: 'cf-rc2', name: 'render_check', arguments: {} }] };
        return { text: '首次取消后已修复并通过第二次渲染校验' };
      }

      if (mode === 'sfx_idempotent') {
        if (st === 0) {
          return {
            toolCalls: [{
              id: 'sfx-inner-1',
              name: 'synthesize_sfx',
              arguments: { name: '幂等雨声底噪', kind: 'rain', durationSeconds: 0.8, volume: 0.4, shotId: shot1, bindToTrack: true },
            }],
          };
        }
        return { text: '已完成雨声拟音合成并入轨' };
      }
    }

    const dt = directorTurn++;
    if (dt === 0) {
      if (mode === 'clip_scope') {
        return { toolCalls: [{ id: 'd-cs', name: 'delegate_crew', arguments: { department: 'sound_director', task: '测试镜2音视频片段范围保护', shotIds: [shot1] } }] };
      }
      if (mode === 'same_tool_7th') {
        return { toolCalls: [{ id: 'd-st7', name: 'delegate_crew', arguments: { department: 'cinematographer', task: '同工具第7项不同镜头测试' } }] };
      }
      if (mode === 'qc_cancel') {
        return { toolCalls: [{ id: 'd-qcc', name: 'delegate_crew', arguments: { department: 'post_editor_qc', task: '执行渲染校验' } }] };
      }
      if (mode === 'coder_fix_loop') {
        return { toolCalls: [{ id: 'd-cfl', name: 'delegate_crew', arguments: { department: 'scene_coder', task: '修复并复检第一镜', shotIds: [shot1] } }] };
      }
      return { toolCalls: [{ id: 'd-sfx', name: 'delegate_crew', arguments: { department: 'sound_director', task: '合成一段雨声', shotIds: [shot1] } }] };
    }
    const lastTool = [...msgs].reverse().find(m => m.role === 'tool');
    if (lastTool?.content) capturedReceipts.push(JSON.parse(lastTool.content));
    return { text: `完成 (${mode})` };
  });

  const app = await createApplication({
    dataDirectory: dir,
    projectsDirectory: join(dir, 'projects'),
    credentials: new MemorySecrets(),
    fetch: gw.fetch,
  });
  const call = async <T,>(ep: string, p: unknown = {}) => {
    const r = await app.route(ep, p);
    if (!r.ok) throw new Error(ep + ': ' + r.error.message);
    return r.value as T;
  };

  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const m = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: m.id });

    // 1) Source Observation: video_clip_extract & audio_edit remove on shot2 MUST be blocked when sound_director is scoped to [shot1]!
    let snap = await call<StudioSnapshot>('create', { title: '剪辑与音轨范围门禁测试', productionMode: 'hybrid' });
    const pid = snap.project!.id;
    shot1 = snap.project!.shots[0]!.id;
    shot2 = snap.project!.shots[1]!.id;
    const origShot2Title = snap.project!.shots[1]!.title;
    await call('production.set', {
      projectId: pid,
      expectedRevision: 0,
      mode: 'hybrid',
      allowGeneratedImages: true,
      allowImportedVideo: true,
      shotIds: [shot1, shot2],
      operations: ['code', 'video'],
    });
    snap = await call<StudioSnapshot>('current', { projectId: pid });
    snap = await call<StudioSnapshot>('import', {
      projectId: pid,
      expectedRevision: snap.project!.revision,
      name: '镜2实拍素材.mp4',
      mime: 'video/mp4',
      dataBase64: `data:video/mp4;base64,${mp4Bytes.toString('base64')}`,
    });
    const vidAsset = snap.project!.assets.find(a => a.kind === 'video')!;
    snap = await call<StudioSnapshot>('video.clip.save', {
      projectId: pid,
      expectedRevision: snap.project!.revision,
      clip: { shotId: shot2, assetId: vidAsset.id, audio: 'keep' },
    });
    shot2VideoClipId = snap.project!.videoClips![0]!.id;

    // Seed an audio clip on shot2 via synthesize_sfx first
    const sfxTool = app.agent.toolList.find(t => t.name === 'synthesize_sfx')!;
    const directCtx = (app.agent as unknown as { context: (r: string, p: string, s: AbortSignal) => any }).context('seed-sfx', pid, new AbortController().signal);
    await sfxTool.run({ name: '镜2受保护音效', kind: 'tone', durationSeconds: 0.5, shotId: shot2, bindToTrack: true }, directCtx);
    snap = await call<StudioSnapshot>('current', { projectId: pid });
    shot2AudioClipId = (snap.project!.audioClips ?? []).find(c => c.shotId === shot2)!.id;

    mode = 'clip_scope'; subTurn = 0; directorTurn = 0; subToolResponses.length = 0;
    const rScope = await call<PublicRun>('agent.start', { projectId: pid, goal: '测试镜2音视频范围隔离', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const dScope = await waitRun(call, rScope.id, ['complete', 'failed']);
    assert.equal(dScope.status, 'complete');
    assert.ok(subToolResponses.some(t => t.includes('越界拦截') && t.includes(shot2)), `应拦截越界 video_clip_extract / audio_edit 调用，实际=${JSON.stringify(subToolResponses)}`);
    const afterScope = await call<StudioSnapshot>('current', { projectId: pid });
    assert.equal(afterScope.project!.videoClips?.[0]?.audio, 'keep', '镜2视频片段原声模式不得被篡改');
    assert.ok((afterScope.project!.audioClips ?? []).some(c => c.id === shot2AudioClipId), '镜2音频片段不得被移除');

    // 2) #11: Same-tool different-target 7th call skip -> shot1 updated, shot2 untouched, receipt status === 'partial', ok === false, call-7-shot2 id preserved!
    mode = 'same_tool_7th'; subTurn = 0; directorTurn = 0; capturedReceipts.length = 0;
    const r7 = await call<PublicRun>('agent.start', { projectId: pid, goal: '同工具第7项不同目标跳过测试', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const d7 = await waitRun(call, r7.id, ['complete', 'failed']);
    assert.equal(d7.status, 'complete');
    const after7 = await call<StudioSnapshot>('current', { projectId: pid });
    assert.equal(after7.project!.shots[0]!.title, '第一镜合法改名');
    assert.equal(after7.project!.shots[1]!.title, origShot2Title, '第7项越限的镜2改名不得执行');
    assert.equal(capturedReceipts.length, 1);
    assert.equal(capturedReceipts[0]!.ok, false, '第7项被单轮上限跳过后严禁由第1项同名工具误消去跳过记录');
    assert.equal(capturedReceipts[0]!.status, 'partial');
    const skipped7 = capturedReceipts[0]!.skippedTools as { id?: string; tool: string; kind: string }[];
    assert.equal(skipped7.length, 1);
    assert.equal(skipped7[0]!.id, 'call-7-shot2', '父级 skippedTools 必须保留被跳过调用的原始 callId');
    assert.equal(skipped7[0]!.tool, 'shot_patch');
    assert.equal(skipped7[0]!.kind, 'turn_limit');

    // 3) #04/#09: Cancelled render_check inside post_editor_qc reports ok: false, status: 'cancelled';
    //    AND core business workflow in scene_coder (1st render_check cancelled -> code_write -> 2nd render_check passes) reports ok: true, status: 'complete'!
    const origPortRoute = (app.agent as unknown as { port: { route: (ep: string, p: Record<string, unknown>) => Promise<any> } }).port.route;
    let cancelPreviewCount = 0;
    (app.agent as unknown as { port: { route: (ep: string, p: Record<string, unknown>) => Promise<any> } }).port.route = async (ep, p) => {
      if (ep === 'preview' && cancelPreviewCount > 0) {
        cancelPreviewCount--;
        const res = await origPortRoute(ep, p);
        await app.route('cancel', { projectId: pid });
        return res;
      }
      return origPortRoute(ep, p);
    };
    try {
      cancelPreviewCount = 1;
      mode = 'qc_cancel'; subTurn = 0; directorTurn = 0; capturedReceipts.length = 0;
      const rQcCancel = await call<PublicRun>('agent.start', { projectId: pid, goal: '预览取消质检回执测试', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
      const dQcCancel = await waitRun(call, rQcCancel.id, ['complete', 'failed']);
      assert.equal(dQcCancel.status, 'complete');
      assert.equal(capturedReceipts[0]!.ok, false, '被取消的 render_check 不得在子代理回执中标成 complete/ok:true');
      assert.equal(capturedReceipts[0]!.status, 'cancelled');
      const qcSkipped = capturedReceipts[0]!.skippedTools as { id?: string; tool: string; status?: string }[];
      assert.equal(qcSkipped[0]!.id, 'qc-rc-cancel');
      assert.equal(qcSkipped[0]!.tool, 'render_check');
      assert.equal(qcSkipped[0]!.status, 'cancelled');

      // Core business preservation: 1st render_check cancelled -> code_write -> 2nd render_check succeeds!
      cancelPreviewCount = 1;
      mode = 'coder_fix_loop'; subTurn = 0; directorTurn = 0; capturedReceipts.length = 0;
      const rCoderOk = await call<PublicRun>('agent.start', { projectId: pid, goal: '首次取消后修复并复检通过', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
      const dCoderOk = await waitRun(call, rCoderOk.id, ['complete', 'failed']);
      assert.equal(dCoderOk.status, 'complete');
      assert.equal(capturedReceipts[0]!.ok, true, `后续 render_check 复检通过后核心编码闭环必须正常汇报 ok:true，实际=${JSON.stringify(capturedReceipts[0])}`);
      assert.equal(capturedReceipts[0]!.status, 'complete');
    } finally {
      (app.agent as unknown as { port: { route: (ep: string, p: Record<string, unknown>) => Promise<any> } }).port.route = origPortRoute;
    }

    // 4) #03: Inner synthesize_sfx crash-window recovery TWICE -> single WAV asset (exact same assetId), single clip, and usage.toolCalls === 2 (never 3)!
    const sfxDir = join(dir, 'sfx-crash');
    const appSfx = await createApplication({
      dataDirectory: sfxDir,
      projectsDirectory: join(sfxDir, 'projects'),
      credentials: new MemorySecrets(),
      fetch: gw.fetch,
    });
    const callSfx = async <T,>(ep: string, p: unknown = {}) => {
      const r = await appSfx.route(ep, p);
      if (!r.ok) throw new Error(ep + ': ' + r.error.message);
      return r.value as T;
    };
    let sfxPid = '';
    let sfxRunId = '';
    let preDequeueSnapshot: AgentRun | null = null;
    let firstAssetId = '';
    try {
      const cs = await callSfx<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
      const ms = await callSfx<{ id: string }>('models.model.save', { connectionId: cs.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
      await callSfx('models.role.bind', { role: 'director', modelId: ms.id });
      const sfxProj = await callSfx<StudioSnapshot>('create', { title: '拟音崩溃重放幂等测试' });
      sfxPid = sfxProj.project!.id;
      shot1 = sfxProj.project!.shots[0]!.id;

      // Capture the exact run checkpoint while pendingCalls[0] STILL holds synthesize_sfx!
      const rawStore = (appSfx.agent as unknown as { store: { save: (r: AgentRun) => Promise<void> } }).store;
      const origSave = rawStore.save.bind(rawStore);
      rawStore.save = async (r: AgentRun) => {
        await origSave(r);
        const ck = Object.values(r.subagentCheckpoints ?? {})[0];
        if (!preDequeueSnapshot && ck?.pendingCalls?.[0]?.name === 'synthesize_sfx') {
          preDequeueSnapshot = structuredClone(r);
        }
      };

      mode = 'sfx_idempotent'; subTurn = 0; directorTurn = 0; capturedReceipts.length = 0;
      const rSfx = await callSfx<PublicRun>('agent.start', { projectId: sfxPid, goal: '合成雨声幂等测试', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
      sfxRunId = rSfx.id;
      const dSfx = await waitRun(callSfx, sfxRunId, ['complete', 'failed']);
      assert.equal(dSfx.status, 'complete');
      assert.equal(dSfx.usage.toolCalls, 2, '初次完成应为 1 次父级委派 + 1 次子级拟音 = 2 次工具调用');
      assert.ok(preDequeueSnapshot, '应捕获到 pendingCalls[0] 仍为 synthesize_sfx 的落盘检查点');
      const curAfter1 = await callSfx<StudioSnapshot>('current', { projectId: sfxPid });
      const audioAssets1 = curAfter1.project!.assets.filter(a => a.kind === 'audio');
      assert.equal(audioAssets1.length, 1);
      firstAssetId = audioAssets1[0]!.id;
    } finally {
      await appSfx.dispose();
    }

    // Simulate crash AFTER WAV asset & clip were committed to project, while run JSON on disk still has synthesize_sfx at pendingCalls[0]!
    // Recover TWICE to prove both StudioService import(requestId) and toolCalls accounting are 100% idempotent!
    for (let round = 1; round <= 2; round++) {
      await writeFile(join(sfxDir, 'agent-runs', `${sfxRunId}.json`), JSON.stringify(preDequeueSnapshot, null, 2));
      await rm(join(sfxDir, 'agent-runs', 'tool-success'), { recursive: true, force: true });
      subTurn = 1;
      directorTurn = 1;
      const appRec = await createApplication({
        dataDirectory: sfxDir,
        projectsDirectory: join(sfxDir, 'projects'),
        credentials: new MemorySecrets(),
        fetch: gw.fetch,
      });
      const callRec = async <T,>(ep: string, p: unknown = {}) => {
        const r = await appRec.route(ep, p);
        if (!r.ok) throw new Error(ep + ': ' + r.error.message);
        return r.value as T;
      };
      try {
        const paused = await callRec<PublicRun>('agent.get', { runId: sfxRunId });
        assert.equal(paused.status, 'paused');
        await callRec('agent.resume', { runId: sfxRunId });
        const done = await waitRun(callRec, sfxRunId, ['complete', 'failed']);
        assert.equal(done.status, 'complete', `第 ${round} 次恢复应成功完成`);
        assert.equal(done.usage.toolCalls, 2, `第 ${round} 次恢复后 usage.toolCalls 必须恒为 2（不得膨胀为 3）`);
        const snapRec = await callRec<StudioSnapshot>('current', { projectId: sfxPid });
        const audioAssets = snapRec.project!.assets.filter(a => a.kind === 'audio');
        assert.equal(audioAssets.length, 1, `第 ${round} 次恢复后工程内仍只能有 1 份音频素材`);
        assert.equal(audioAssets[0]!.id, firstAssetId, '重放必须复用完全相同的稳定 assetId');
        assert.equal((snapRec.project!.audioClips ?? []).length, 1, '重放不得重复绑定第 2 条音轨片段');
      } finally {
        await appRec.dispose();
      }
    }
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Round3 #06: Full-receipt 2-item batch crash recovery never inflates unknownCostCalls to 3 or failedCount to 3', async () => {
  const env = inspectToolEnvironment({});
  assert.equal(env.ffmpegAvailable, true);
  const dir = await mkdtemp(join(tmpdir(), 'yl-r3-full-batch-'));
  const sampleMp4 = join(dir, 'sample.mp4');
  execFileSync(env.ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=1.0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sampleMp4], { stdio: 'ignore' });
  const mp4Bytes = await readFile(sampleMp4);

  let failRemotePoll = false;
  let shot1 = '';
  let shot2 = '';
  const batchReceiptsOut: Record<string, unknown>[] = [];

  const gw = toolGateway((body) => {
    const msgs = body.messages as { role: string; content?: string }[];
    const tools = msgs.filter(m => m.role === 'tool');
    if (!tools.length) {
      return {
        toolCalls: [{
          id: 'b-full2',
          name: 'batch_generate_media',
          arguments: {
            expectedRevision: 1,
            autoApply: false,
            items: [
              { kind: 'video', shotId: shot1, prompt: '批次首项已落盘' },
              { kind: 'video', shotId: shot2, prompt: '批次次项已落盘' },
            ],
          },
        }],
      };
    }
    batchReceiptsOut.push(JSON.parse(tools.at(-1)!.content!));
    return { text: '已汇总两项批次结果' };
  });

  let jobSeq = 0;
  const customFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://gateway.test')) return gw.fetch(input, init);
    if (url.startsWith('http://vid-batch.test')) {
      if (init?.method === 'POST' && url.endsWith('/media/jobs')) {
        const id = `jb-${++jobSeq}`;
        return new Response(JSON.stringify({ jobId: id, status: 'running' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const id = url.split('/').pop()!;
      if (failRemotePoll) {
        return new Response(JSON.stringify({ jobId: id, status: 'failed', error: { message: '远端渲染失败' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        jobId: id,
        status: 'succeeded',
        usage: { cost: 0.05, currency: 'CNY' },
        artifacts: [{ url: 'http://cdn.test/out.mp4', mimeType: 'video/mp4' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'http://cdn.test/out.mp4') {
      return new Response(mp4Bytes, { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    throw new Error('Unexpected URL: ' + url);
  };

  let fullReceiptsSnapshot: AgentRun | null = null;
  let runId = '';
  const app = await createApplication({
    dataDirectory: dir,
    projectsDirectory: join(dir, 'projects'),
    credentials: new MemorySecrets(),
    fetch: customFetch,
  });
  const call = async <T,>(ep: string, p: unknown = {}) => {
    const r = await app.route(ep, p);
    if (!r.ok) throw new Error(ep + ': ' + r.error.message);
    return r.value as T;
  };

  try {
    const cChat = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const mDir = await call<{ id: string }>('models.model.save', { connectionId: cChat.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: { pricePerMInput: 0, pricePerMOutput: 0, priceCurrency: 'CNY' } });
    await call('models.role.bind', { role: 'director', modelId: mDir.id });

    const cVid = await call<{ id: string }>('models.connection.save', { name: 'vid', protocol: 'video-gateway', baseUrl: 'http://vid-batch.test/v1', auth: 'none' });
    const mVid = await call<{ id: string }>('models.model.save', { connectionId: cVid.id, model: 'vid-v1', inputModalities: ['text'], outputModalities: ['video'], parameters: {} });
    await call('models.role.bind', { role: 'video', modelId: mVid.id });

    const created = await call<StudioSnapshot>('create', { title: '满额子回执崩溃核销', productionMode: 'model_video' });
    const pid = created.project!.id;
    shot1 = created.project!.shots[0]!.id;
    shot2 = created.project!.shots[1]!.id;
    await call('production.set', { projectId: pid, expectedRevision: 0, mode: 'model_video', allowGeneratedImages: true, allowImportedVideo: true });

    // Capture the exact disk snapshot right when BOTH item 0 and item 1 receipts are saved while inFlight is still set!
    const rawStore = (app.agent as unknown as { store: { save: (r: AgentRun) => Promise<void> } }).store;
    const origSave = rawStore.save.bind(rawStore);
    rawStore.save = async (r: AgentRun) => {
      await origSave(r);
      const savedItems = Object.keys(r.batchReceipts?.['b-full2'] ?? {});
      if (!fullReceiptsSnapshot && r.inFlight && savedItems.length === 2) {
        fullReceiptsSnapshot = structuredClone(r);
      }
    };

    const started = await call<PublicRun>('agent.start', { projectId: pid, goal: '双项落盘后崩溃恢复', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    runId = started.id;
    const pending = await waitRun(call, runId, ['awaiting_approval', 'failed']);
    await approvePending(call, pending);
    await waitRun(call, runId, ['complete', 'failed']);
    assert.ok(fullReceiptsSnapshot, '必须捕获到两项 batchReceipts 均已落盘且 inFlight 尚未结清的瞬间');
    const capturedFull = fullReceiptsSnapshot as AgentRun;
    assert.equal(capturedFull.usage.unknownCostCalls, 2);
  } finally {
    await app.dispose();
  }

  // Case A: Recover from fullReceiptsSnapshot (without ToolSuccessReceipt) when both tasks settle with known cost 0.05 each!
  await writeFile(join(dir, 'agent-runs', `${runId}.json`), JSON.stringify(fullReceiptsSnapshot, null, 2));
  await rm(join(dir, 'agent-runs', 'tool-success'), { recursive: true, force: true });
  batchReceiptsOut.length = 0;

  const appRecOk = await createApplication({
    dataDirectory: dir,
    projectsDirectory: join(dir, 'projects'),
    credentials: new MemorySecrets(),
    fetch: customFetch,
  });
  const callRecOk = async <T,>(ep: string, p: unknown = {}) => {
    const r = await appRecOk.route(ep, p);
    if (!r.ok) throw new Error(ep + ': ' + r.error.message);
    return r.value as T;
  };
  try {
    const paused = await callRecOk<PublicRun>('agent.get', { runId });
    assert.equal(paused.status, 'paused');
    assert.equal(paused.usage.unknownCostCalls, 2, '两项子回执齐全时恢复不得虚增第 3 笔未知费用');
    assert.equal(paused.uncertainSubmissions, undefined, '两项 taskId 均已知时不得产生 uncertainSubmissions');

    await callRecOk('agent.resume', { runId });
    const done = await waitRun(callRecOk, runId, ['complete', 'failed']);
    assert.equal(done.status, 'complete');
    assert.equal(done.usage.unknownCostCalls, 0, '两项已知费用结清后 unknownCostCalls 必须归零');
    assert.ok(Math.abs(done.usage.cost - 0.1) < 1e-6, `总费用应为 0.10，实际=${done.usage.cost}`);
    assert.equal(batchReceiptsOut.length, 1);
    assert.equal((batchReceiptsOut[0]!.results as unknown[]).length, 2);
    assert.equal(batchReceiptsOut[0]!.succeededCount, 2);
    assert.equal(batchReceiptsOut[0]!.failedCount, 0);
    assert.equal(batchReceiptsOut[0]!.uncertainCount ?? 0, 0);
  } finally {
    await appRecOk.dispose();
  }

  // Case B: Reset the two media tasks on disk to running & failRemotePoll=true -> verify failedCount === 2 (NEVER 3)!
  const snapFullB = fullReceiptsSnapshot as unknown as AgentRun;
  const knownIds = Object.values(snapFullB.batchReceipts!['b-full2']!);
  for (const tid of knownIds) {
    const tPath = join(dir, 'media-tasks', `${tid}.json`);
    const rawTask = JSON.parse(await readFile(tPath, 'utf8')) as MediaTask;
    rawTask.phase = 'running';
    rawTask.observation = 'active';
    rawTask.resumeOnStart = true;
    rawTask.files = [];
    delete rawTask.applied;
    delete rawTask.error;
    await writeFile(tPath, JSON.stringify(rawTask, null, 2));
  }
  await writeFile(join(dir, 'agent-runs', `${runId}.json`), JSON.stringify(fullReceiptsSnapshot, null, 2));
  await rm(join(dir, 'agent-runs', 'tool-success'), { recursive: true, force: true });
  failRemotePoll = true;
  batchReceiptsOut.length = 0;

  const appRecFail = await createApplication({
    dataDirectory: dir,
    projectsDirectory: join(dir, 'projects'),
    credentials: new MemorySecrets(),
    fetch: customFetch,
  });
  const callRecFail = async <T,>(ep: string, p: unknown = {}) => {
    const r = await appRecFail.route(ep, p);
    if (!r.ok) throw new Error(ep + ': ' + r.error.message);
    return r.value as T;
  };
  try {
    await callRecFail('agent.resume', { runId });
    const doneFail = await waitRun(callRecFail, runId, ['complete', 'failed']);
    assert.equal(doneFail.status, 'complete');
    assert.equal(batchReceiptsOut.length, 1);
    assert.equal(batchReceiptsOut[0]!.failedCount, 2, '两项全部远端失败时 failedCount 必须为 2，绝不能为 3');
    assert.equal(batchReceiptsOut[0]!.uncertainCount ?? 0, 0);
  } finally {
    await appRecFail.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Round3 #09, #05, #13, #14a & #14b: Neighboring shot error attribution, diverged Draft B previz isolation, 6+1 identity image preservation, 100-asset cursor pagination, and 24-character bible/story subagent JSON validity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yl-r3-bible-scale-'));

  let sceneModelCalls = 0;
  let subTurn = 0;
  let directorTurn = 0;
  let runPhase: 'approve_previz_a' | 'sub_24chars' = 'approve_previz_a';
  let previzShotId = '';
  let previzImgA = '';
  const subCapturedJsons: string[] = [];

  const gw = toolGateway((body) => {
    const msgs = body.messages as { role: string; content?: string }[];
    const sys = String(msgs[0]?.content ?? '');

    if (sys.includes('专精动态图形与场景代码工程师')) {
      sceneModelCalls++;
      return {
        text: JSON.stringify({
          html: '<div id="healthy-shot1">第一镜正常标题卡</div>',
          css: '#healthy-shot1 { color: #fff; font-size: 40px; }',
          js: 'export function render() {}',
        }),
      };
    }

    if (sys.includes('你正在作为子代理协助总导演')) {
      const st = subTurn++;
      if (st === 0) {
        return {
          toolCalls: [
            { id: 'c24-story', name: 'story_get', arguments: {} },
            { id: 'c24-bible', name: 'bible_get', arguments: {} },
          ],
        };
      }
      for (const tm of msgs.filter(m => m.role === 'tool')) {
        subCapturedJsons.push(String(tm.content ?? ''));
      }
      return { text: '已成功解析 24 角色圣经与分镜 JSON' };
    }

    if (runPhase === 'approve_previz_a') {
      const hasTool = msgs.some(m => m.role === 'tool');
      if (!hasTool) {
        return {
          toolCalls: [{
            id: 'sub-previz-a',
            name: 'submit_previz_review',
            arguments: {
              summary: '提交获批计划 A 的特写预演审阅',
              shots: [{ shotId: previzShotId, imageAssetId: previzImgA, cameraNote: '计划A 85mm 特写确认' }],
            },
          }],
        };
      }
      return { text: '计划 A 预演已获批' };
    }

    if (directorTurn++ === 0) {
      return { toolCalls: [{ id: 'dir-c24', name: 'delegate_crew', arguments: { department: 'cinematographer', task: '读取 24 角色故事与圣经' } }] };
    }
    return { text: '24 角色委派读取验证通过' };
  });

  const app = await createApplication({
    dataDirectory: dir,
    projectsDirectory: join(dir, 'projects'),
    credentials: new MemorySecrets(),
    fetch: gw.fetch,
  });
  const call = async <T,>(ep: string, p: unknown = {}) => {
    const r = await app.route(ep, p);
    if (!r.ok) throw new Error(ep + ': ' + r.error.message);
    return r.value as T;
  };

  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const m = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: m.id });
    await call('models.role.bind', { role: 'scene', modelId: m.id });

    // 1) #09: Pre-broken shot2 while delegate_scene_code edits healthy shot1 -> sceneModelCalls === 1, revision === 2 (NOT 4), and error cites shot2!
    const p09 = await call<StudioSnapshot>('create', { title: '邻镜报错归因测试' });
    const pid09 = p09.project!.id;
    const s1_09 = p09.project!.shots[0]!.id;
    const s2_09 = p09.project!.shots[1]!.id;
    const brokenSave = await call<StudioSnapshot>('saveSource', {
      projectId: pid09,
      shotId: s2_09,
      expectedRevision: 0,
      source: { html: '<div>坏镜2</div>', css: '', js: 'export function render() { throw new Error("第二镜历史遗留报错"); }' },
    });
    assert.equal(brokenSave.project!.revision, 1);
    for (let i = 0; i < 1500; i++) {
      const st = await call<StudioSnapshot>('current', { projectId: pid09 });
      if (st.task?.status !== 'running') break;
      await new Promise(r => setTimeout(r, 20));
    }

    sceneModelCalls = 0;
    const delegateSceneTool = app.agent.toolList.find(t => t.name === 'delegate_scene_code')!;
    const ctx09 = (app.agent as unknown as { context: (r: string, p: string, s: AbortSignal) => any }).context('r09-nb', pid09, new AbortController().signal);
    await assert.rejects(
      () => delegateSceneTool.run({ expectedRevision: 1, shotId: s1_09, instruction: '编写第一镜健康标题卡' }, ctx09),
      (err: Error) => err.message.includes(s2_09) && err.message.includes('第二镜历史遗留报错'),
      '报错信息必须明确指出是相邻第二镜报错而非归咎第一镜',
    );
    assert.equal(sceneModelCalls, 1, '相邻镜头报错时不得盲目二次重写健康的第一镜代码');
    const after09 = await call<StudioSnapshot>('current', { projectId: pid09 });
    assert.equal(after09.project!.revision, 2, '工程版本应仅推进 1 次（1 -> 2），不得连写两次变为 4');

    // 2) #05 & #13: Diverged Draft B wide-shot previz isolation on real agent.approve + 6 auxiliary refs + 7th independent identity image preservation!
    let p5 = await call<StudioSnapshot>('create', { title: '草稿改镜预演隔离与7图保留' });
    const pid5 = p5.project!.id;
    const sh1 = p5.project!.shots[0]!.id;
    const sh2 = p5.project!.shots[1]!.id;
    previzShotId = sh1;

    const auxIds: string[] = [];
    for (let i = 1; i <= 6; i++) {
      p5 = await call<StudioSnapshot>('import', {
        projectId: pid5,
        expectedRevision: p5.project!.revision,
        name: `辅助设定图_${i}.png`,
        mime: 'image/png',
        dataBase64: `data:image/png;base64,${solidPng(32, 32, 20 * i, 90, 140).toString('base64')}`,
      });
      auxIds.push(p5.project!.assets.at(-1)!.id);
    }
    p5 = await call<StudioSnapshot>('import', {
      projectId: pid5,
      expectedRevision: p5.project!.revision,
      name: '第7张独立主身份绑定图.png',
      mime: 'image/png',
      dataBase64: `data:image/png;base64,${solidPng(32, 32, 240, 180, 60).toString('base64')}`,
    });
    const id7 = p5.project!.assets.at(-1)!.id;

    p5 = await call<StudioSnapshot>('import', {
      projectId: pid5,
      expectedRevision: p5.project!.revision,
      name: '计划A特写预演图.png',
      mime: 'image/png',
      dataBase64: `data:image/png;base64,${solidPng(32, 32, 110, 110, 190).toString('base64')}`,
    });
    previzImgA = p5.project!.assets.at(-1)!.id;

    p5 = await call<StudioSnapshot>('import', {
      projectId: pid5,
      expectedRevision: p5.project!.revision,
      name: '草稿B山谷远景预演图.png',
      mime: 'image/png',
      dataBase64: `data:image/png;base64,${solidPng(32, 32, 60, 170, 90).toString('base64')}`,
    });
    const previzImgB = p5.project!.assets.at(-1)!.id;

    const planA = {
      version: 1 as const,
      ruleSetVersion: DIRECTOR_RULESET_VERSION,
      filmKind: 'suspense_short' as const,
      title: '获批计划 A',
      logline: '获批计划 A 梗概',
      style: { look: '冷调胶片', palette: '深蓝', typography: '衬线', motion: '稳重', negative: '卡通' },
      characters: [
        { id: 'hero', name: '林探长', identity: '冷峻探长', features: ['风衣'], referenceAssetIds: auxIds },
      ],
      storyBeats: [{ id: 'b1', function: '开场', change: '凝视', shotIds: [sh1, sh2] }],
      worldLayouts: [],
      // 7th independent image bound in identityMap while referenceAssetIds already has 6 items!
      identityMap: [{ characterId: 'hero', assetId: id7 }],
      shots: [
        {
          shotId: sh1,
          title: 'A版第一镜特写',
          visualPrompt: '主角林探长面部特写，雨滴滑落帽檐',
          durationSeconds: 3,
          narration: '',
          characterIds: ['hero'],
          audioStrategy: 'silent' as const,
          performance: [],
          dialogue: [],
          events: [],
          references: [],
          acceptance: [],
        },
        {
          shotId: sh2,
          title: '第二镜背影',
          visualPrompt: '林探长转身走入暗巷',
          durationSeconds: 3,
          narration: '',
          characterIds: ['hero'],
          audioStrategy: 'silent' as const,
          performance: [],
          dialogue: [],
          events: [],
          references: [],
          acceptance: [],
        },
      ],
    };

    const savedA = await call<{ document: { version: number; hash: string } }>('director.document.save', { projectId: pid5, expectedVersion: 0, plan: planA });
    await call('director.document.approve', { projectId: pid5, expectedVersion: savedA.document.version, expectedHash: savedA.document.hash });

    // #13 Verification: Run location_upsert when character has 6 referenceAssetIds + 7th independent identityMap asset!
    const ctx5 = (app.agent as unknown as { context: (r: string, p: string, s: AbortSignal) => any }).context('r13-7img', pid5, new AbortController().signal);
    const locTool = app.agent.toolList.find(t => t.name === 'location_upsert')!;
    const locRes = JSON.parse((await locTool.run({ id: 'alley', name: '雨夜暗巷', description: '青石板积水与霓虹倒影' }, ctx5)).content);
    assert.equal(locRes.ok, true);

    const snapAfter13 = await call<StudioSnapshot>('current', { projectId: pid5 });
    const docAfter13 = readDirectorDocument(snapAfter13.project!)!;
    assert.ok(docAfter13.version > savedA.document.version, 'DirectorDocument 版本必须成功递增，不得因 7 图超限而静默失败');
    assert.ok(docAfter13.plan.locations?.some(l => l.id === 'alley'), '新场景 alley 必须成功写入 DirectorDocument');
    assert.deepEqual(docAfter13.plan.characters[0]!.referenceAssetIds, auxIds, '6 张辅助参考图必须完整保留');
    assert.equal(docAfter13.plan.identityMap.find(m => m.characterId === 'hero')?.assetId, id7, '第 7 张独立主身份图必须继续保留在 identityMap');

    // #05 Verification: User saves unapproved Draft B changing sh1 to valley wide-shot with its own rendered previz!
    const planB = structuredClone(docAfter13.plan);
    planB.title = '工作台改镜草稿 B';
    planB.shots[0]!.visualPrompt = '远景俯瞰整座云雾山谷与盘山公路';
    planB.shots[0]!.previz = {
      imageAssetId: previzImgB,
      note: '草稿B山谷大远景构图备注',
      updatedAt: '2026-11-23T08:00:00.000Z',
      status: 'rendered',
    };
    await call('director.document.save', { projectId: pid5, expectedVersion: docAfter13.version, plan: planB });

    // Trigger real agent.start -> submit_previz_review (risk: 'plan') -> agent.approve!
    runPhase = 'approve_previz_a';
    const rPreviz = await call<PublicRun>('agent.start', { projectId: pid5, goal: '审批计划A第一镜特写预演', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const pPreviz = await waitRun(call, rPreviz.id, ['awaiting_approval', 'failed']);
    assert.equal(pPreviz.pending?.tool, 'submit_previz_review');
    await approvePending(call, pPreviz);
    const dPreviz = await waitRun(call, rPreviz.id, ['complete', 'failed']);
    assert.equal(dPreviz.status, 'complete');

    const storyAfterPreviz = await call<Story>('story.get', { projectId: pid5 });
    assert.equal(storyAfterPreviz.shots[0]!.previz?.imageAssetId, previzImgA, '获批计划 A 的 Story 预演图应更新为 imgA');
    assert.equal(storyAfterPreviz.shots[0]!.previz?.status, 'approved');

    const snapDraftBAfter = await call<StudioSnapshot>('current', { projectId: pid5 });
    const docDraftBAfter = readDirectorDocument(snapDraftBAfter.project!)!;
    assert.equal(docDraftBAfter.status, 'draft');
    assert.equal(docDraftBAfter.plan.shots[0]!.visualPrompt, '远景俯瞰整座云雾山谷与盘山公路');
    assert.equal(docDraftBAfter.plan.shots[0]!.previz?.imageAssetId, previzImgB, '已改写为山谷远景的草稿 B 不得被计划 A 的特写预演图覆盖');
    assert.equal(docDraftBAfter.plan.shots[0]!.previz?.note, '草稿B山谷大远景构图备注');
    assert.equal(docDraftBAfter.plan.shots[0]!.previz?.status, 'rendered', '草稿 B 自有的 rendered 状态不得被误标为 approved');

    // 3) #14a: 0-shot + 100-asset default pagination AND 1-shot (referencing asset-100) full 100-asset cursor traversal without duplicates/omissions!
    const p14 = await call<StudioSnapshot>('create', { title: '百素材确定性游标与24角色分页', blank: true });
    const pid14 = p14.project!.id;
    const p14Root = p14.recent.find(r => r.id === pid14)!.path;
    const assetsDir = join(p14Root, 'assets');
    await mkdir(assetsDir, { recursive: true });
    const png32 = solidPng(32, 32, 70, 110, 150);

    const seeded100 = structuredClone(p14.project!);
    assert.equal(seeded100.shots.length, 0, '初始为空白 0 镜工程');
    for (let i = 1; i <= 100; i++) {
      const fn = `asset-${i}.png`;
      await writeFile(join(assetsDir, fn), png32);
      seeded100.assets.push({
        id: `asset-${i}`,
        kind: 'image',
        name: `美术参考_${i}.png`,
        path: `assets/${fn}`,
        mime: 'image/png',
        width: 32,
        height: 32,
        description: `第 ${i} 号高精度场景与服装道具设定参考图说明文本，用于验证百素材游标确定性分页与字符预算控制`,
        provenance: { origin: 'user_import', usage: 'reference_only' },
      });
    }
    await call('save', { projectId: pid14, expectedRevision: p14.project!.revision, project: seeded100, deferPreview: true });

    const ctx14 = (app.agent as unknown as { context: (r: string, p: string, s: AbortSignal) => any }).context('r14-cursor', pid14, new AbortController().signal);
    const projectGetTool = app.agent.toolList.find(t => t.name === 'project_get')!;

    // 0-shot + 100-asset default read MUST return >0 assets and advance nextAssetOffset > 0!
    const zeroShotPage0 = JSON.parse((await projectGetTool.run({}, ctx14)).content);
    assert.equal(zeroShotPage0.totalShots, 0);
    assert.ok(zeroShotPage0.assets.length > 0, '0 镜 100 素材工程默认读取不得返回 0 条素材');
    assert.equal(zeroShotPage0.assetsPagination.nextAssetOffset, zeroShotPage0.assets.length);

    // Add 1 shot referencing asset-100 so old referencedIds-first sorting would have caused cursor omission/duplication!
    const shotsMutateTool = app.agent.toolList.find(t => t.name === 'shots_mutate')!;
    const curBeforeAdd1 = await call<StudioSnapshot>('current', { projectId: pid14 });
    await shotsMutateTool.run({
      expectedRevision: curBeforeAdd1.project!.revision,
      addShots: [{ title: '引用第100号素材的首镜', durationSeconds: 3, intent: '画面参考 asset-100 的空间构图' }],
    }, ctx14);
    const curWith1Shot = await call<StudioSnapshot>('current', { projectId: pid14 });
    await call('saveSource', {
      projectId: pid14,
      shotId: curWith1Shot.project!.shots[0]!.id,
      expectedRevision: curWith1Shot.project!.revision,
      source: { html: '<img data-ref="asset-100" src="assets/asset-100.png" />', css: '', js: 'export function render() {}' },
    });

    const collectedAssetIds: string[] = [];
    let cursor: number | undefined = 0;
    let guardPages = 0;
    while (cursor !== undefined) {
      assert.ok(guardPages++ < 15, '游标分页不得死循环');
      const raw = await projectGetTool.run({ assetOffset: cursor }, ctx14);
      assert.ok(raw.content.length <= 12_000);
      const page = JSON.parse(raw.content);
      for (const a of page.assets as { id: string }[]) collectedAssetIds.push(a.id);
      if (!page.assetsPagination.hasMore) {
        assert.equal(page.assetsPagination.nextAssetOffset, undefined, '末页 hasMore=false 时不应继续给出 nextAssetOffset');
        cursor = undefined;
      } else {
        assert.ok(page.assetsPagination.nextAssetOffset > cursor, 'nextAssetOffset 必须严格单调递增');
        cursor = page.assetsPagination.nextAssetOffset;
      }
    }
    assert.equal(collectedAssetIds.length, 100, '游标翻页收集总数必须恰好为 100');
    assert.equal(new Set(collectedAssetIds).size, 100, '100 项素材 ID 必须 100% 唯一、零遗漏零重复');

    // 4) #14b: 24 richly described characters + 1 shot -> story_get & bible_get delegated to cinematographer both <= 12,000 chars and valid JSON!
    const planStoryTool = app.agent.toolList.find(t => t.name === 'plan_story')!;
    const planShotsTool = app.agent.toolList.find(t => t.name === 'plan_shots')!;
    const chars24 = Array.from({ length: 24 }, (_, idx) => ({
      id: `char_${idx + 1}`,
      name: `群像角色_${idx + 1}`,
      description: `这是第 ${idx + 1} 位核心群像人物的详尽身世背景、性格弧光、年代服饰细节、面部特征与人物关系小传描述文本，`.repeat(9),
      objective: `在第 ${idx + 1} 条叙事支线中守护关键秘密并推动冲突升级，保持前后场次表演细节与台词潜台词高度统一`,
      features: [`标志性风衣配饰_${idx + 1}`, `独特冷暖光影轮廓_${idx + 1}`, `随身怀表道具_${idx + 1}`, `眼神克制微表情_${idx + 1}`],
      voice: 'alloy',
    }));
    const locs12 = Array.from({ length: 12 }, (_, idx) => ({
      id: `loc_${idx + 1}`,
      name: `群像场景_${idx + 1}`,
      setting: 'INT',
      timeOfDay: 'NIGHT',
      description: `第 ${idx + 1} 处室内建筑陈设、景深走廊层次、桌面器物材质与潮湿窗格反光细节说明，`.repeat(5),
      lightingMood: `低色温钨丝壁灯与窗外冷青霓虹形成强烈明暗交界对比_${idx + 1}`,
    }));
    await planStoryTool.run({
      title: '二十四角色群像长卷',
      logline: '验证 24 个长描述角色与 12 处场景在单镜工程下的 story_get 与 bible_get 自适应分页不截断',
      style: { look: '群像电影质感', palette: '冷青琥珀对比', typography: '衬线体', motion: '沉稳调度', negative: '变形闪烁' },
      characters: chars24,
      locations: locs12,
    }, ctx14);
    await planShotsTool.run({
      shots: [{
        id: 's1',
        shotId: curWith1Shot.project!.shots[0]!.id,
        summary: '24 位角色群像晚宴开场全景调度',
        shotType: '大远景',
        camera: '24mm 缓慢横移',
        durationSeconds: 3,
        characters: ['char_1', 'char_2'],
        locationId: 'loc_1',
      }],
    }, ctx14);

    runPhase = 'sub_24chars';
    subTurn = 0;
    directorTurn = 0;
    subCapturedJsons.length = 0;
    const r24 = await call<PublicRun>('agent.start', { projectId: pid14, goal: '委派摄影部门读取24角色圣经与故事', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const d24 = await waitRun(call, r24.id, ['complete', 'failed']);
    assert.equal(d24.status, 'complete', d24.message);
    assert.equal(subCapturedJsons.length, 2, '摄影子代理应收到 story_get 与 bible_get 两份工具输出');
    for (const rawJson of subCapturedJsons) {
      assert.ok(rawJson.length <= 12_000, `工具返回长度不得超过 12000 字符上限，实际=${rawJson.length}`);
      const parsed = JSON.parse(rawJson);
      assert.ok(parsed, '子代理收到的 story_get / bible_get JSON 必须完整可解析、零截断');
    }

    // Verify characterOffset cursor traverses all 24 characters cleanly!
    const storyGetTool = app.agent.toolList.find(t => t.name === 'story_get')!;
    const seenChars: string[] = [];
    let charCursor: number | undefined = 0;
    while (charCursor !== undefined) {
      const res = await storyGetTool.run({ characterOffset: charCursor }, ctx14);
      assert.ok(res.content.length <= 12_000);
      const p = JSON.parse(res.content);
      for (const ch of p.characters as { id: string }[]) seenChars.push(ch.id);
      charCursor = p.charactersPagination?.hasMore ? p.charactersPagination.nextOffset : undefined;
    }
    assert.equal(seenChars.length, 24);
    assert.equal(new Set(seenChars).size, 24, '通过 characterOffset 游标应无损遍历全部 24 名角色');
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
