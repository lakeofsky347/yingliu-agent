import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import type { AgentRun, PublicRun } from '../src/agent/contracts.ts';
import type { Story } from '../src/agent/story.ts';
import { AgentPanel } from '../src/client/AgentPanel.tsx';
import type { StudioController } from '../src/client/controller.ts';
import { DIRECTOR_RULESET_VERSION } from '../src/director/index.ts';
import { readDirectorDocument } from '../src/director/document.ts';
import { encodeRgbaPng } from '../src/host/contact-sheet.ts';
import { inspectToolEnvironment } from '../src/host/tool-environment.ts';
import type { MediaTask } from '../src/jobs/contracts.ts';
import { synthesize } from '../src/agent/synth.ts';
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
  assert.equal(run.status, 'awaiting_approval', `预期 awaiting_approval，实际=${run.status} (${run.message})`);
  assert.ok(run.pending);
  await call('agent.approve', {
    runId: run.id,
    callId: run.pending.callId,
    execId: run.pending.execId,
    argsHash: run.pending.argsHash,
  });
}

test('Recheck #01, #02, #03, #04, #11: Scoped subtitle preservation, strict outer+inner toolCall ceiling, crash-safe subagent completion receipt, precondition skipped status, and overflow skipped reporting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yl-recheck-crew-'));
  let mode: 'subtitle_scope' | 'tool_ceiling' | 'crash_window' | 'precondition_skip' | 'overflow_skip' = 'subtitle_scope';
  let subTurn = 0;
  let directorTurn = 0;
  let shot1 = '';
  let shot2 = '';
  let capturedReceipts: Record<string, unknown>[] = [];

  const gw = toolGateway((body) => {
    const msgs = body.messages as { role: string; content?: string; tool_call_id?: string }[];
    const sys = String(msgs[0]?.content ?? '');
    const isSub = sys.includes('你正在作为子代理协助总导演');

    if (isSub) {
      const st = subTurn++;
      if (mode === 'subtitle_scope') {
        if (st === 0) return { toolCalls: [{ id: 's-pg', name: 'project_get', arguments: {} }] };
        if (st === 1) {
          const rev = JSON.parse([...msgs].reverse().find(m => m.role === 'tool')!.content!).revision;
          // Scoped to [shot1]: submitting empty setSubtitles: [] must clear ONLY shot1 subtitles while keeping shot2's subtitle intact!
          return {
            toolCalls: [
              { id: 's-clear1', name: 'post_overlay_subtitle', arguments: { expectedRevision: rev, setSubtitles: [] } },
            ],
          };
        }
        return { text: '已清空第一镜字幕' };
      }

      if (mode === 'tool_ceiling') {
        // Attempt 6 read calls when maxToolCalls=6 (1 outer delegate_crew + max 5 inner calls = 6)
        return {
          toolCalls: [
            { id: `r1-${st}`, name: 'project_get', arguments: {} },
            { id: `r2-${st}`, name: 'bible_get', arguments: {} },
            { id: `r3-${st}`, name: 'story_get', arguments: {} },
            { id: `r4-${st}`, name: 'skill_read', arguments: { topic: 'scene-structure' } },
            { id: `r5-${st}`, name: 'skill_read', arguments: { topic: 'layout-safe-area' } },
            { id: `r6-${st}`, name: 'skill_read', arguments: { topic: 'consistency' } },
          ],
        };
      }

      if (mode === 'crash_window') {
        if (st === 0) return { toolCalls: [{ id: 'cw-pg', name: 'project_get', arguments: {} }] };
        if (st === 1) {
          const rev = JSON.parse([...msgs].reverse().find(m => m.role === 'tool')!.content!).revision;
          return {
            toolCalls: [
              { id: 'cw-add', name: 'shots_mutate', arguments: { expectedRevision: rev, addShots: [{ title: '崩溃恢复唯一新镜', durationSeconds: 2 }] } },
            ],
          };
        }
        return { text: '已追加第四镜' };
      }

      if (mode === 'precondition_skip') {
        if (st === 0) return { toolCalls: [{ id: 'ps-cr', name: 'consistency_review', arguments: {} }] };
        return { text: '圣经未批准，一致性审查已跳过' };
      }

      if (mode === 'overflow_skip') {
        if (st === 0) {
          return {
            toolCalls: [
              { id: 'ov1', name: 'project_get', arguments: {} },
              { id: 'ov2', name: 'bible_get', arguments: {} },
              { id: 'ov3', name: 'story_get', arguments: {} },
              { id: 'ov4', name: 'env_check', arguments: {} },
              { id: 'ov5', name: 'skill_read', arguments: { topic: 'scene-structure' } },
              { id: 'ov6', name: 'skill_read', arguments: { topic: 'consistency' } },
              // 7th call is a write that exceeds the 6-per-turn cap; if sub-agent finishes on next turn without retrying, parent receipt must NOT say complete!
              { id: 'ov7', name: 'continuity_log_upsert', arguments: { shotId: shot1, notes: '第7项被跳过的场记写入' } },
            ],
          };
        }
        return { text: '前6项读取完成，本轮收尾' };
      }
    }

    const dt = directorTurn++;
    if (dt === 0) {
      if (mode === 'subtitle_scope') {
        return { toolCalls: [{ id: 'd-sub', name: 'delegate_crew', arguments: { department: 'post_editor_qc', task: '清空第一镜字幕', shotIds: [shot1] } }] };
      }
      if (mode === 'tool_ceiling') {
        return { toolCalls: [{ id: 'd-ceil', name: 'delegate_crew', arguments: { department: 'post_editor_qc', task: '读取检查' } }] };
      }
      if (mode === 'crash_window') {
        return { toolCalls: [{ id: 'd-cw', name: 'delegate_crew', arguments: { department: 'screenwriter', task: '追加一镜' } }] };
      }
      if (mode === 'precondition_skip') {
        return { toolCalls: [{ id: 'd-skip', name: 'delegate_crew', arguments: { department: 'post_editor_qc', task: '执行视觉一致性审查' } }] };
      }
      return { toolCalls: [{ id: 'd-ov', name: 'delegate_crew', arguments: { department: 'cinematographer', task: '读取6项并写第7项场记' } }] };
    }
    const lastTool = [...msgs].reverse().find(m => m.role === 'tool');
    if (lastTool?.content) capturedReceipts.push(JSON.parse(lastTool.content));
    return { text: `总导演已收到回执 (${mode})` };
  });

  const app = await createApplication({ dataDirectory: dir, projectsDirectory: join(dir, 'projects'), credentials: new MemorySecrets(), fetch: gw.fetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const m = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    const vm = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'vision-v1', inputModalities: ['text', 'image'], outputModalities: ['text'], parameters: { enableVision: true } });
    await call('models.role.bind', { role: 'director', modelId: m.id });
    await call('models.role.bind', { role: 'vision', modelId: vm.id });

    const created = await call<StudioSnapshot>('create', { title: '复审剧组边界验证' });
    const pid = created.project!.id;
    shot1 = created.project!.shots[0]!.id;
    shot2 = created.project!.shots[1]!.id;
    const origShot2Source = await call('source', { projectId: pid, shotId: shot2 });

    // Seed subtitles on both shot1 and shot2
    const seededProject = structuredClone(created.project!);
    seededProject.subtitles = [
      { id: 'sub-s1', shotId: shot1, startSeconds: 0, endSeconds: 1.5, text: '第一镜旧字幕' },
      { id: 'sub-s2', shotId: shot2, startSeconds: 2, endSeconds: 3.5, text: '第二镜唯一受保护字幕' },
    ];
    await call('save', { projectId: pid, expectedRevision: created.project!.revision, project: seededProject, deferPreview: true });

    // #01: Department scoped to [shot1] submits setSubtitles: [] -> shot1 subtitle cleared, shot2 subtitle & source preserved!
    mode = 'subtitle_scope'; subTurn = 0; directorTurn = 0; capturedReceipts = [];
    const r1 = await call<PublicRun>('agent.start', { projectId: pid, goal: '清空镜1字幕', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const d1 = await waitRun(call, r1.id, ['complete', 'failed']);
    assert.equal(d1.status, 'complete', d1.message);
    const afterSubSnap = await call<StudioSnapshot>('current', { projectId: pid });
    assert.deepEqual(
      afterSubSnap.project!.subtitles,
      [{ id: 'sub-s2', shotId: shot2, startSeconds: 2, endSeconds: 3.5, text: '第二镜唯一受保护字幕' }],
      '受限部门清空第一镜字幕后，第二镜原有字幕必须完整保留',
    );
    const afterShot2Source = await call('source', { projectId: pid, shotId: shot2 });
    assert.deepEqual(afterShot2Source, origShot2Source, '第二镜源码必须保持原样');

    // #02: maxToolCalls: 6 -> 1 outer delegate_crew + 5 inner reads = 6 exact ceiling (NEVER 7!)
    mode = 'tool_ceiling'; subTurn = 0; directorTurn = 0;
    const r2 = await call<PublicRun>('agent.start', { projectId: pid, goal: '工具上限6测试', autoApprove: ['read', 'write'], budget: { maxToolCalls: 6 }, maxReviewRounds: 0 });
    const d2 = await waitRun(call, r2.id, ['budget_exceeded', 'complete', 'failed']);
    assert.equal(d2.status, 'budget_exceeded');
    assert.equal(d2.usage.toolCalls, 6, `公开工具调用计数不得超过 maxToolCalls=6，实际=${d2.usage.toolCalls}`);

    // #04: Unapproved Bible -> consistency_review actively returns { skipped: true } -> parent receipt must report status: 'skipped', ok: false, executedTools: []
    mode = 'precondition_skip'; subTurn = 0; directorTurn = 0; capturedReceipts = [];
    const r4 = await call<PublicRun>('agent.start', { projectId: pid, goal: '未批圣经审查测试', autoApprove: ['read', 'write'], allowImages: true, maxReviewRounds: 0 });
    let d4 = await waitRun(call, r4.id, ['paused', 'complete', 'failed']);
    if (d4.status === 'paused' && d4.visionConsentRequired) {
      await call('agent.resume', { runId: r4.id, visionConsentId: d4.visionConsentRequired.id });
      d4 = await waitRun(call, r4.id, ['complete', 'failed']);
    }
    assert.equal(d4.status, 'complete', d4.message);
    assert.equal(capturedReceipts.length, 1);
    assert.equal(capturedReceipts[0]!.ok, false);
    assert.equal(capturedReceipts[0]!.status, 'skipped');
    assert.deepEqual(capturedReceipts[0]!.executedTools, []);
    assert.equal((capturedReceipts[0]!.skippedTools as { tool: string }[])[0]!.tool, 'consistency_review');

    // #11: 6 reads + 7th write skipped by per-turn limit, then stop -> parent receipt must report status: 'partial', ok: false, listing skipped 7th write
    mode = 'overflow_skip'; subTurn = 0; directorTurn = 0; capturedReceipts = [];
    const r11 = await call<PublicRun>('agent.start', { projectId: pid, goal: '单轮第7项跳过回执测试', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const d11 = await waitRun(call, r11.id, ['complete', 'failed']);
    assert.equal(d11.status, 'complete', d11.message);
    assert.equal(capturedReceipts.length, 1);
    assert.equal(capturedReceipts[0]!.ok, false);
    assert.equal(capturedReceipts[0]!.status, 'partial');
    assert.equal((capturedReceipts[0]!.executedTools as string[]).length, 6);
    const skipped11 = capturedReceipts[0]!.skippedTools as { tool: string; kind: string }[];
    assert.equal(skipped11.length, 1);
    assert.equal(skipped11[0]!.tool, 'continuity_log_upsert');
    assert.equal(skipped11[0]!.kind, 'turn_limit');

    // #03: Capture exact disk state right when subagent finishes (completedResult persisted) BEFORE parent queue shifts, then recover & resume!
    const crashDir = join(dir, 'crash-recover');
    const appCrash = await createApplication({ dataDirectory: crashDir, projectsDirectory: join(crashDir, 'projects'), credentials: new MemorySecrets(), fetch: gw.fetch });
    const callCrash = async <T,>(ep: string, p: unknown = {}) => { const r = await appCrash.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
    let midFinishSnapshot: AgentRun | null = null;
    let crProjId = '';
    let rCwId = '';
    try {
      const rawStore = (appCrash.agent as unknown as { store: { save: (r: AgentRun) => Promise<void> } }).store;
      const origSave = rawStore.save.bind(rawStore);
      rawStore.save = async (r: AgentRun) => {
        await origSave(r);
        const ckValues = Object.values(r.subagentCheckpoints ?? {});
        if (!midFinishSnapshot && r.queue[0]?.name === 'delegate_crew' && ckValues.some(ck => Boolean(ck.completedResult))) {
          midFinishSnapshot = structuredClone(r);
        }
      };

      const cC = await callCrash<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
      const mC = await callCrash<{ id: string }>('models.model.save', { connectionId: cC.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
      await callCrash('models.role.bind', { role: 'director', modelId: mC.id });
      const crProj = await callCrash<StudioSnapshot>('create', { title: '崩溃恢复4镜测试' });
      crProjId = crProj.project!.id;
      assert.equal(crProj.project!.shots.length, 3);

      mode = 'crash_window'; subTurn = 0; directorTurn = 0; capturedReceipts = [];
      const rCw = await callCrash<PublicRun>('agent.start', { projectId: crProjId, goal: '追加一镜崩溃恢复', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
      rCwId = rCw.id;
      const dCw = await waitRun(callCrash, rCwId, ['complete', 'failed']);
      assert.equal(dCw.status, 'complete');
      assert.ok(midFinishSnapshot, '必须捕获到子代理已完成、父队列尚未出队的落盘瞬间');
      assert.equal((await callCrash<StudioSnapshot>('current', { projectId: crProjId })).project!.shots.length, 4);
    } finally {
      await appCrash.dispose();
    }

    // Overwrite disk run JSON with the captured mid-finish snapshot (simulating process kill before settleToolSuccess) and restart!
    await writeFile(join(crashDir, 'agent-runs', `${rCwId}.json`), JSON.stringify(midFinishSnapshot, null, 2));
    const appRestart = await createApplication({ dataDirectory: crashDir, projectsDirectory: join(crashDir, 'projects'), credentials: new MemorySecrets(), fetch: gw.fetch });
    const callRestart = async <T,>(ep: string, p: unknown = {}) => { const r = await appRestart.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
    try {
      const pausedRun = await callRestart<PublicRun>('agent.get', { runId: rCwId });
      assert.equal(pausedRun.status, 'paused');
      await callRestart('agent.resume', { runId: rCwId });
      const doneRestart = await waitRun(callRestart, rCwId, ['complete', 'failed']);
      assert.equal(doneRestart.status, 'complete', doneRestart.message);
      const snapAfterRestart = await callRestart<StudioSnapshot>('current', { projectId: crProjId });
      assert.equal(snapAfterRestart.project!.shots.length, 4, '重启恢复后工程仍须保持 4 镜，严禁重复写入变为 5 镜');
    } finally {
      await appRestart.dispose();
    }
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Recheck #12: Deterministic sendMessage delivered during run.complete trace write never finishes with stale reply or strands message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yl-recheck-complete-race-'));
  const gw = toolGateway((body) => {
    const msgs = body.messages as { role: string; content?: string }[];
    if (msgs.some(m => typeof m.content === 'string' && m.content.includes('【终态写盘瞬间纠偏】'))) {
      return { text: '已采纳终态纠偏的新答复' };
    }
    return { text: '即将被纠偏替代的旧答复' };
  });

  const app = await createApplication({ dataDirectory: dir, projectsDirectory: join(dir, 'projects'), credentials: new MemorySecrets(), fetch: gw.fetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const m = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: m.id });
    const created = await call<StudioSnapshot>('create', { title: '终态竞态验证' });

    let injectedDuringCompleteTrace = false;
    let ackStatus = '';
    const rawStore = (app.agent as unknown as { store: { trace: (id: string, entry: Record<string, unknown>) => Promise<void> } }).store;
    const origTrace = rawStore.trace.bind(rawStore);
    rawStore.trace = async (id: string, entry: Record<string, unknown>) => {
      await origTrace(id, entry);
      if (entry.event === 'run.complete' && !injectedDuringCompleteTrace) {
        injectedDuringCompleteTrace = true;
        const ack = await app.agent.sendMessage(id, '【终态写盘瞬间纠偏】请追加确认');
        ackStatus = ack.message;
      }
    };

    const started = await call<PublicRun>('agent.start', { projectId: created.project!.id, goal: '测试终态写盘竞态', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const done = await waitRun(call, started.id, ['complete', 'failed']);
    assert.equal(injectedDuringCompleteTrace, true);
    assert.match(ackStatus, /已收到补充指令|继续处理新指令/);
    assert.equal(done.status, 'complete');
    assert.equal(done.final, '已采纳终态纠偏的新答复', '运行必须以采纳纠偏后的新答复结束，不得停留于旧答复');
    assert.equal(done.pendingUserMessages, undefined, '待处理消息队列必须已排空');
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Recheck #06, #07, #08, #10: Media 404 pause propagation, dual autoApply conflict honesty, mid-batch crash accounting, lip-sync capability gate, multi-asset consent UI, and mode-switch enforcement', async () => {
  const env = inspectToolEnvironment({});
  assert.equal(env.ffmpegAvailable, true, '本机需具备 FFmpeg');
  const dir = await mkdtemp(join(tmpdir(), 'yl-recheck-media-'));
  const sampleMp4 = join(dir, 'sample.mp4');
  execFileSync(env.ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sampleMp4], { stdio: 'ignore' });
  const mp4Bytes = await (await import('node:fs/promises')).readFile(sampleMp4);
  const wavBytes = Buffer.from(synthesize({ kind: 'rain', durationSeconds: 1.0, volume: 0.5 }));

  let artifact404 = false;
  let klingVideoSubmits = 0;
  let lipsyncPresetSubmits = 0;
  let gatewayVideoSubmits = 0;
  let blockSecondBatchSubmit = false;
  let batchItemCount = 0;
  const singleReceipts: Record<string, unknown>[] = [];
  const batchReceiptsCaptured: Record<string, unknown>[] = [];
  let phase: 'dl404' | 'apply_conflict' | 'crash_batch' | 'lipsync_consent' = 'dl404';
  let shot1 = '';
  let shot2 = '';

  const gw = toolGateway((body) => {
    const msgs = body.messages as { role: string; content?: string }[];
    const toolMsgs = msgs.filter(m => m.role === 'tool');
    if (phase === 'dl404') {
      if (!toolMsgs.length) {
        return { toolCalls: [{ id: 'g-404', name: 'generate_video', arguments: { expectedRevision: 1, shotId: shot1, prompt: '下载404测试' } }] };
      }
      singleReceipts.push(JSON.parse(toolMsgs.at(-1)!.content!));
      return { text: '已感知下载暂停并交回处理' };
    }
    if (phase === 'apply_conflict') {
      if (!toolMsgs.length) {
        return {
          toolCalls: [{
            id: 'b-conflict',
            name: 'batch_generate_media',
            arguments: {
              expectedRevision: 1,
              autoApply: true,
              items: [
                { kind: 'video', shotId: shot1, prompt: '冲突测试A' },
                { kind: 'video', shotId: shot2, prompt: '冲突测试B' },
              ],
            },
          }],
        };
      }
      batchReceiptsCaptured.push(JSON.parse(toolMsgs.at(-1)!.content!));
      return { text: '已识别自动采用冲突' };
    }
    if (phase === 'crash_batch') {
      if (!toolMsgs.length) {
        return {
          toolCalls: [{
            id: 'b-crash',
            name: 'batch_generate_media',
            arguments: {
              expectedRevision: 2,
              autoApply: false,
              items: [
                { kind: 'video', shotId: shot1, prompt: '崩溃批次已知首项' },
                { kind: 'video', shotId: shot2, prompt: '崩溃批次在途次项' },
              ],
            },
          }],
        };
      }
      batchReceiptsCaptured.push(JSON.parse(toolMsgs.at(-1)!.content!));
      return { text: '崩溃恢复后已汇总首项与不确定次项' };
    }
    return { text: '完成' };
  });

  const hooks: { releaseSecond?: () => void; onSecondInFlight?: () => void } = {};

  const customFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://gateway.test')) return gw.fetch(input, init);
    if (url.startsWith('http://kling-tpl.test')) {
      klingVideoSubmits++;
      return new Response(JSON.stringify({ data: { task_id: 'kl-1', task_status: 'succeed', task_result: { videos: [{ url: 'http://cdn.test/out.mp4' }] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('http://replicate-ls.test')) {
      if (init?.method === 'POST') {
        lipsyncPresetSubmits++;
        const parsed = JSON.parse(String(init.body ?? '{}')) as { input?: { video?: string; audio?: string } };
        assert.match(String(parsed.input?.video ?? ''), /^data:video\/mp4;base64,/);
        assert.match(String(parsed.input?.audio ?? ''), /^data:audio\/wav;base64,/);
        return new Response(JSON.stringify({ id: 'rep-ls-1', status: 'succeeded', output: 'http://cdn.test/out.mp4' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: 'rep-ls-1', status: 'succeeded', output: 'http://cdn.test/out.mp4' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'http://cdn.test/out.mp4') {
      if (artifact404) return new Response('Not Found', { status: 404 });
      return new Response(mp4Bytes, { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    if (url.startsWith('http://vid-gw.test')) {
      if (init?.method === 'POST' && url.endsWith('/media/jobs')) {
        gatewayVideoSubmits++;
        batchItemCount++;
        if (blockSecondBatchSubmit && batchItemCount === 2) {
          hooks.onSecondInFlight?.();
          await new Promise<void>(r => { hooks.releaseSecond = r; });
        }
        const jobId = `job-${gatewayVideoSubmits}`;
        return new Response(JSON.stringify({ jobId, status: 'succeeded', artifacts: [{ url: 'http://cdn.test/out.mp4', mimeType: 'video/mp4' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const id = url.split('/').pop()!;
      return new Response(JSON.stringify({ jobId: id, status: 'succeeded', artifacts: [{ url: 'http://cdn.test/out.mp4', mimeType: 'video/mp4' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const app = await createApplication({ dataDirectory: dir, projectsDirectory: join(dir, 'projects'), credentials: new MemorySecrets(), fetch: customFetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  try {
    const cChat = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const mDir = await call<{ id: string }>('models.model.save', { connectionId: cChat.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: { pricePerMInput: 0, pricePerMOutput: 0, priceCurrency: 'CNY' } });
    await call('models.role.bind', { role: 'director', modelId: mDir.id });

    const cVid = await call<{ id: string }>('models.connection.save', { name: 'vid', protocol: 'video-gateway', baseUrl: 'http://vid-gw.test/v1', auth: 'none' });
    const mVid = await call<{ id: string }>('models.model.save', { connectionId: cVid.id, model: 'vid-v1', inputModalities: ['text', 'image'], outputModalities: ['video'], parameters: {} });
    await call('models.role.bind', { role: 'video', modelId: mVid.id });

    // Create Schema v3 model_video project
    const created = await call<StudioSnapshot>('create', { title: '媒体与策略复审', productionMode: 'model_video' });
    const pid = created.project!.id;
    shot1 = created.project!.shots[0]!.id;
    shot2 = created.project!.shots[1]!.id;
    await call('production.set', { projectId: pid, expectedRevision: 0, mode: 'model_video', allowGeneratedImages: true, allowImportedVideo: true });

    // #06a: Artifact download returns HTTP 404 -> media task pauses observation -> parent run immediately exits waiting_task and reports state: 'paused'
    phase = 'dl404';
    artifact404 = true;
    singleReceipts.length = 0;
    const r404 = await call<PublicRun>('agent.start', { projectId: pid, goal: '测试404暂停回传', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const p404 = await waitRun(call, r404.id, ['awaiting_approval', 'failed']);
    await approvePending(call, p404);
    const done404 = await waitRun(call, r404.id, ['complete', 'failed'], 400);
    assert.equal(done404.status, 'complete', '下载 404 后父运行不得卡在 waiting_task，须及时交回总导演收尾');
    assert.equal(singleReceipts.length, 1);
    assert.equal(singleReceipts[0]!.ok, false);
    assert.equal(singleReceipts[0]!.state, 'paused');
    assert.equal(singleReceipts[0]!.mediaPhase, 'downloading');
    artifact404 = false;

    // #06b: Dual autoApply failure must report ok: false, succeededCount: 0, failedCount: 2, state: 'apply_failed'
    phase = 'apply_conflict';
    batchReceiptsCaptured.length = 0;
    const origRoute = (app.agent as unknown as { port: { route: (ep: string, p: Record<string, unknown>) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> } }).port.route;
    let forceApplyConflict = true;
    (app.agent as unknown as { port: { route: (ep: string, p: Record<string, unknown>) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> } }).port.route = async (ep, p) => {
      if (ep === 'media.apply' && forceApplyConflict) {
        return { ok: false, error: { code: 'REVISION_CONFLICT', message: '模拟并发版本冲突导致自动采用失败' } };
      }
      return origRoute(ep, p);
    };
    const rConf = await call<PublicRun>('agent.start', { projectId: pid, goal: '测试双项采用冲突回执', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const pConf = await waitRun(call, rConf.id, ['awaiting_approval', 'failed']);
    await approvePending(call, pConf);
    const doneConf = await waitRun(call, rConf.id, ['complete', 'failed']);
    forceApplyConflict = false;
    assert.equal(doneConf.status, 'complete');
    assert.equal(batchReceiptsCaptured.length, 1);
    const conflictReceipt = batchReceiptsCaptured[0]!;
    assert.equal(conflictReceipt.ok, false, '双项自动采用均冲突时严禁报告 ok:true');
    assert.equal(conflictReceipt.succeededCount, 0);
    assert.equal(conflictReceipt.failedCount, 2);
    assert.equal(conflictReceipt.readyUnappliedCount, 2);
    for (const item of conflictReceipt.results as { state: string }[]) {
      assert.equal(item.state, 'apply_failed');
    }

    // #10: Old ready tasks exist right now! Switch project mode from model_video -> code_animation:
    // 1) Historical tasks remain viewable in media.list
    // 2) Applying an old ready video task is blocked (shot stays code, task stays ready)
    // 3) Submitting a new video task is blocked BEFORE sending any remote HTTP request!
    const tasksBeforeSwitch = await call<{ tasks: MediaTask[] }>('media.list', { projectId: pid });
    const readyVideoTask = tasksBeforeSwitch.tasks.find(t => t.phase === 'ready');
    assert.ok(readyVideoTask, '应有已就绪的历史视频生成任务');

    const curBeforeSwitch = await call<StudioSnapshot>('current', { projectId: pid });
    await call('production.set', { projectId: pid, expectedRevision: curBeforeSwitch.project!.revision, mode: 'code_animation', allowGeneratedImages: true, allowImportedVideo: false });
    const curCodeSnap = await call<StudioSnapshot>('current', { projectId: pid });
    assert.equal(curCodeSnap.project!.productionPolicy?.mode, 'code_animation');
    assert.equal(curCodeSnap.project!.shots[0]!.visual?.kind, 'code');

    const tasksAfterSwitch = await call<{ tasks: MediaTask[] }>('media.list', { projectId: pid });
    assert.ok(tasksAfterSwitch.tasks.some(t => t.id === readyVideoTask!.id), '切换纯代码模式后历史任务素材仍可查看');

    const applyOldRes = await app.route('media.apply', { projectId: pid, taskId: readyVideoTask!.id, expectedRevision: curCodeSnap.project!.revision });
    assert.equal(applyOldRes.ok, false, '纯代码模式下旧就绪视频任务不得重新激活视频镜头');
    assert.equal(applyOldRes.error?.code, 'PRODUCTION_POLICY_VIOLATION');
    const afterBlockedApply = await call<StudioSnapshot>('current', { projectId: pid });
    assert.equal(afterBlockedApply.project!.shots[0]!.visual?.kind, 'code');

    const submitsBeforeBlockedGen = gatewayVideoSubmits;
    const blockedGenRes = await app.route('media.generate', {
      projectId: pid,
      shotId: shot1,
      expectedRevision: afterBlockedApply.project!.revision,
      operation: 'text-to-video',
      prompt: '纯代码模式下不应发出的计费视频请求',
    });
    assert.equal(blockedGenRes.ok, false, '纯代码工程的新视频请求必须在发送前被拦截');
    assert.equal(blockedGenRes.error?.code, 'PRODUCTION_POLICY_VIOLATION');
    assert.equal(gatewayVideoSubmits, submitsBeforeBlockedGen, '被模式拦截的视频请求在模拟端收件数须为 0');

    // Switch back to model_video to verify #08 (lip-sync template gate) & #07 (multi-asset consent UI) & #06c (mid-batch crash)
    await call('production.set', { projectId: pid, expectedRevision: afterBlockedApply.project!.revision, mode: 'model_video', allowGeneratedImages: true, allowImportedVideo: true });
    let snapMv = await call<StudioSnapshot>('current', { projectId: pid });
    snapMv = await call<StudioSnapshot>('import', {
      projectId: pid,
      expectedRevision: snapMv.project!.revision,
      name: '主角实拍源视频.mp4',
      mime: 'video/mp4',
      dataBase64: `data:video/mp4;base64,${mp4Bytes.toString('base64')}`,
    });
    const vidAssetId = snapMv.project!.assets.find(a => a.kind === 'video')!.id;
    snapMv = await call<StudioSnapshot>('import', {
      projectId: pid,
      expectedRevision: snapMv.project!.revision,
      name: '角色台词配音.wav',
      mime: 'audio/wav',
      dataBase64: `data:audio/wav;base64,${wavBytes.toString('base64')}`,
    });
    const audAssetId = snapMv.project!.assets.find(a => a.kind === 'audio')!.id;

    // #08: Ordinary kling-video async-task template must reject lip-sync BEFORE remote hit (klingVideoSubmits === 0), while replicate-lipsync receives both inputs!
    const cKling = await call<{ id: string }>('models.connection.save', { name: 'kling-tpl', protocol: 'async-task', baseUrl: 'http://kling-tpl.test', auth: 'none' });
    const mKling = await call<{ id: string }>('models.model.save', { connectionId: cKling.id, model: 'kling-v1', inputModalities: ['text'], outputModalities: ['video'], parameters: { preset: 'kling-video' } });
    await call('models.role.bind', { role: 'video', modelId: mKling.id });

    const klingLipRes = await app.route('media.generate', {
      projectId: pid,
      shotId: shot1,
      expectedRevision: snapMv.project!.revision,
      operation: 'lip-sync-video',
      prompt: '口型测试',
      videoAssetId: vidAssetId,
      audioAssetId: audAssetId,
      allowImageUpload: true,
    });
    assert.equal(klingLipRes.ok, false, '缺少视频与配音输入的普通视频模板必须在调用前拒绝口型同步');
    assert.equal(klingLipRes.error?.code, 'UNSUPPORTED_MEDIA_CAPABILITY');
    assert.equal(klingVideoSubmits, 0, '不兼容模板的模拟端收件数必须为 0');

    const cRepLs = await call<{ id: string }>('models.connection.save', { name: 'rep-ls', protocol: 'async-task', baseUrl: 'http://replicate-ls.test', auth: 'none' });
    const mRepLs = await call<{ id: string }>('models.model.save', { connectionId: cRepLs.id, model: 'sync/lipsync-2', inputModalities: ['text'], outputModalities: ['video'], parameters: { preset: 'replicate-lipsync' } });
    await call('models.role.bind', { role: 'video', modelId: mRepLs.id });
    const okLipTask = await call<MediaTask>('media.generate', {
      projectId: pid,
      shotId: shot1,
      expectedRevision: snapMv.project!.revision,
      operation: 'lip-sync-video',
      prompt: '专用口型模板测试',
      videoAssetId: vidAssetId,
      audioAssetId: audAssetId,
      allowImageUpload: true,
    });
    for (let i = 0; i < 60; i++) {
      const t = await call<MediaTask>('media.get', { taskId: okLipTask.id });
      if (t.phase === 'ready') break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(lipsyncPresetSubmits, 1, '专用口型同步模板应正常发送包含两份输入的请求');

    // #07: Trigger apply_lip_sync upload consent challenge and verify BOTH assets + types + destination render in AgentPanel!
    let lipConsentTurn = 0;
    let uiVidId = '';
    let uiAudId = '';
    let uiRev = 0;
    const lipGw = toolGateway(() => {
      if (lipConsentTurn++ === 0) {
        return {
          toolCalls: [{
            id: 'ls-ui',
            name: 'apply_lip_sync',
            arguments: { expectedRevision: uiRev, shotId: shot1, videoAssetId: uiVidId, audioAssetId: uiAudId },
          }],
        };
      }
      return { text: '完成' };
    });
    const appUi = await createApplication({ dataDirectory: join(dir, 'ui-consent'), projectsDirectory: join(dir, 'ui-consent', 'projects'), credentials: new MemorySecrets(), fetch: (u, init) => (String(u).startsWith('http://gateway.test') ? lipGw.fetch(u, init) : customFetch(u, init)) });
    const callUi = async <T,>(ep: string, p: unknown = {}) => { const r = await appUi.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
    try {
      const cu1 = await callUi<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
      const mu1 = await callUi<{ id: string }>('models.model.save', { connectionId: cu1.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
      await callUi('models.role.bind', { role: 'director', modelId: mu1.id });
      const cu2 = await callUi<{ id: string }>('models.connection.save', { name: 'rep-ls', protocol: 'async-task', baseUrl: 'http://replicate-ls.test', auth: 'none' });
      const mu2 = await callUi<{ id: string }>('models.model.save', { connectionId: cu2.id, model: 'sync/lipsync-2', inputModalities: ['text'], outputModalities: ['video'], parameters: { preset: 'replicate-lipsync' } });
      await callUi('models.role.bind', { role: 'video', modelId: mu2.id });

      let uiSnap = await callUi<StudioSnapshot>('create', { title: 'UI多素材授权展示', productionMode: 'model_video' });
      uiSnap = await callUi<StudioSnapshot>('import', { projectId: uiSnap.project!.id, expectedRevision: uiSnap.project!.revision, name: '主角实拍源视频.mp4', mime: 'video/mp4', dataBase64: `data:video/mp4;base64,${mp4Bytes.toString('base64')}` });
      const vId = uiSnap.project!.assets.find(a => a.kind === 'video')!.id;
      uiSnap = await callUi<StudioSnapshot>('import', { projectId: uiSnap.project!.id, expectedRevision: uiSnap.project!.revision, name: '角色台词配音.wav', mime: 'audio/wav', dataBase64: `data:audio/wav;base64,${wavBytes.toString('base64')}` });
      const aId = uiSnap.project!.assets.find(a => a.kind === 'audio')!.id;
      shot1 = uiSnap.project!.shots[0]!.id;
      uiVidId = vId;
      uiAudId = aId;
      uiRev = uiSnap.project!.revision;
      snapMv = uiSnap;

      const runLs = await callUi<PublicRun>('agent.start', { projectId: uiSnap.project!.id, goal: '测试口型双素材提示', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
      const pausedLs = await waitRun(callUi, runLs.id, ['paused', 'failed']);
      assert.equal(pausedLs.status, 'paused');
      assert.deepEqual(pausedLs.visionConsentRequired?.assetIds, [vId, aId]);

      const mockController = {
        subscribe: () => () => {},
        getSnapshot: () => ({ pending: false }),
        api: { call: async () => ({ roles: [] }) },
        mediaCommand: async () => ({}),
        load: async () => {},
      } as unknown as StudioController;
      const html = renderToStaticMarkup(React.createElement(AgentPanel, {
        controller: mockController,
        project: uiSnap.project!,
        externalRuns: [pausedLs],
        externalLive: true,
        hideStory: true,
      }));
      assert.match(html, /视频「主角实拍源视频\.mp4」/);
      assert.match(html, /配音「角色台词配音\.wav」/);
      assert.match(html, /sync\/lipsync-2（http:\/\/replicate-ls\.test）/);
    } finally {
      await appUi.dispose();
    }

    // #06c: Mid-batch snapshot while item 0 accepted & item 1 in-flight -> unknownCostCalls === 1 immediately, and restart tracks known item 0 without resubmitting item 1!
    const batchCrashDir = join(dir, 'batch-crash');
    const appBc = await createApplication({ dataDirectory: batchCrashDir, projectsDirectory: join(batchCrashDir, 'projects'), credentials: new MemorySecrets(), fetch: customFetch });
    const callBc = async <T,>(ep: string, p: unknown = {}) => { const r = await appBc.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
    let rBcId = '';
    let midRunDisk: AgentRun | null = null;
    let knownItem0TaskId = '';
    try {
      const cb1 = await callBc<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
      const mb1 = await callBc<{ id: string }>('models.model.save', { connectionId: cb1.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: { pricePerMInput: 0, pricePerMOutput: 0, priceCurrency: 'CNY' } });
      await callBc('models.role.bind', { role: 'director', modelId: mb1.id });
      const cb2 = await callBc<{ id: string }>('models.connection.save', { name: 'vid', protocol: 'video-gateway', baseUrl: 'http://vid-gw.test/v1', auth: 'none' });
      const mb2 = await callBc<{ id: string }>('models.model.save', { connectionId: cb2.id, model: 'vid-v1', inputModalities: ['text'], outputModalities: ['video'], parameters: {} });
      await callBc('models.role.bind', { role: 'video', modelId: mb2.id });

      let bcSnap = await callBc<StudioSnapshot>('create', { title: '批次中断记账与首项跟踪', productionMode: 'model_video' });
      await callBc('production.set', { projectId: bcSnap.project!.id, expectedRevision: 0, mode: 'model_video', allowGeneratedImages: true, allowImportedVideo: true });
      bcSnap = await callBc<StudioSnapshot>('current', { projectId: bcSnap.project!.id });
      await callBc('rename', { projectId: bcSnap.project!.id, expectedRevision: bcSnap.project!.revision, title: '批次中断记账v2' });
      bcSnap = await callBc<StudioSnapshot>('current', { projectId: bcSnap.project!.id });
      shot1 = bcSnap.project!.shots[0]!.id;
      shot2 = bcSnap.project!.shots[1]!.id;

      phase = 'crash_batch';
      batchItemCount = 0;
      blockSecondBatchSubmit = false;
      batchReceiptsCaptured.length = 0;
      const secondInFlightPromise = new Promise<void>(r => { hooks.onSecondInFlight = r; });

      // Deterministically pause right when batch_generate_media dispatches item 1 (after item 0 receipt is persisted to disk!)
      const origMediaGen = appBc.media.generate.bind(appBc.media);
      let bcGenCalls = 0;
      appBc.media.generate = async (req) => {
        bcGenCalls++;
        if (bcGenCalls === 2) {
          hooks.onSecondInFlight?.();
          await new Promise<void>(r => { hooks.releaseSecond = r; });
        }
        return origMediaGen(req);
      };

      const rBc = await callBc<PublicRun>('agent.start', { projectId: bcSnap.project!.id, goal: '测试批次中途崩溃', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
      rBcId = rBc.id;
      const pBc = await waitRun(callBc, rBcId, ['awaiting_approval', 'failed']);
      await approvePending(callBc, pBc);
      await secondInFlightPromise;

      // Inspect mid-batch persisted state BEFORE item 1 returns!
      midRunDisk = JSON.parse(await (await import('node:fs/promises')).readFile(join(batchCrashDir, 'agent-runs', `${rBcId}.json`), 'utf8')) as AgentRun;
      assert.equal(midRunDisk.usage.unknownCostCalls, 1, '首项受理落盘时未知费用计数必须已记为 1（不为 0）');
      assert.ok(midRunDisk.inFlight, '整批仍在 inFlight');
      knownItem0TaskId = Object.values(midRunDisk.batchReceipts?.['b-crash'] ?? {})[0]!;
      assert.ok(knownItem0TaskId, '首项 taskId 必须已落盘');
      assert.equal(Object.keys(midRunDisk.batchReceipts?.['b-crash'] ?? {}).length, 1, '次项尚未受理落盘');

      hooks.releaseSecond?.();
      await waitRun(callBc, rBcId, ['complete', 'failed']);
    } finally {
      hooks.releaseSecond?.();
      await appBc.dispose();
    }

    // Restore exact mid-batch disk record (keeping item 0 media task on disk, removing item 1 task & toolSuccess receipt) and restart!
    await writeFile(join(batchCrashDir, 'agent-runs', `${rBcId}.json`), JSON.stringify(midRunDisk, null, 2));
    await rm(join(batchCrashDir, 'agent-runs', 'tool-success'), { recursive: true, force: true });
    batchReceiptsCaptured.length = 0;
    const submitsBeforeRestart = gatewayVideoSubmits;

    const appBcRestart = await createApplication({ dataDirectory: batchCrashDir, projectsDirectory: join(batchCrashDir, 'projects'), credentials: new MemorySecrets(), fetch: customFetch });
    const callBcRestart = async <T,>(ep: string, p: unknown = {}) => { const r = await appBcRestart.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
    try {
      const recoveredBc = await callBcRestart<PublicRun>('agent.get', { runId: rBcId });
      assert.equal(recoveredBc.status, 'paused');
      assert.equal(recoveredBc.uncertainSubmissions?.length, 1, '次项在途中断应登记为不确定请求');
      assert.equal(recoveredBc.waitingBatch?.ids[0], knownItem0TaskId, '已知首项必须继续由父运行 waitingBatch 跟踪');
      assert.equal(recoveredBc.usage.unknownCostCalls, 2, '已知首项 + 不确定次项合计 2 笔未知费用');

      await callBcRestart('agent.resume', { runId: rBcId });
      const finishedBc = await waitRun(callBcRestart, rBcId, ['complete', 'failed']);
      assert.equal(finishedBc.status, 'complete');
      assert.equal(gatewayVideoSubmits, submitsBeforeRestart, '重启恢复绝不重新提交不确定次项');
      assert.equal(batchReceiptsCaptured.length, 1);
      const restartedBatchReceipt = batchReceiptsCaptured[0]!;
      assert.equal(restartedBatchReceipt.submissionUncertain, true);
      assert.equal((restartedBatchReceipt.results as { taskId: string }[])[0]!.taskId, knownItem0TaskId);
    } finally {
      await appBcRestart.dispose();
    }
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Recheck #09, #05, #13, #14: Preview cancel gate, Workbench Draft B field-level preservation, video motion reference & 2nd identity image round-trip, and 120-shot + 60-asset subagent JSON validity', async () => {
  const env = inspectToolEnvironment({});
  assert.equal(env.ffmpegAvailable, true);
  const dir = await mkdtemp(join(tmpdir(), 'yl-recheck-plan-scale-'));
  const sampleMp4 = join(dir, 'motion-ref.mp4');
  execFileSync(env.ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sampleMp4], { stdio: 'ignore' });
  const mp4Bytes = await (await import('node:fs/promises')).readFile(sampleMp4);

  let subagentReceivedProjectJson = '';
  let subTurn = 0;
  let directorTurn = 0;
  let lastShot120Id = '';

  const gw = toolGateway((body) => {
    const msgs = body.messages as { role: string; content?: string }[];
    const sys = String(msgs[0]?.content ?? '');
    if (sys.includes('专精动态图形与场景代码工程师')) {
      return {
        text: JSON.stringify({
          html: '<div id="box">预览取消验证</div>',
          css: '#box { color: #fff; font-size: 42px; }',
          js: 'export function render(ctx) { const el = ctx.root.querySelector("#box"); el.style.opacity = "1"; }',
        }),
      };
    }
    if (sys.includes('你正在作为子代理协助总导演')) {
      if (subTurn++ === 0) {
        return { toolCalls: [{ id: 'sub-p120', name: 'project_get', arguments: { shotOffset: 118, shotLimit: 2 } }] };
      }
      subagentReceivedProjectJson = [...msgs].reverse().find(m => m.role === 'tool')?.content ?? '';
      return { text: '部门已成功解析末镜 JSON' };
    }
    if (directorTurn++ === 0) {
      return { toolCalls: [{ id: 'dir-del-120', name: 'delegate_crew', arguments: { department: 'cinematographer', task: '分页读取最后两镜' } }] };
    }
    return { text: '120 镜部门委派读取验证通过' };
  });

  const app = await createApplication({ dataDirectory: dir, projectsDirectory: join(dir, 'projects'), credentials: new MemorySecrets(), fetch: gw.fetch });
  const call = async <T,>(ep: string, p: unknown = {}) => { const r = await app.route(ep, p); if (!r.ok) throw new Error(ep + ': ' + r.error.message); return r.value as T; };
  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const m = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: m.id });
    await call('models.role.bind', { role: 'scene', modelId: m.id });

    // 1) #09: Cancel host preview during generateSceneCode -> task recorded as cancelled, tool MUST NOT report "已通过渲染校验"!
    const p09 = await call<StudioSnapshot>('create', { title: '预览取消诚实性测试' });
    const pid09 = p09.project!.id;
    const s09 = p09.project!.shots[0]!.id;
    const origBackendCall = app.backend.call.bind(app.backend);
    let cancelTriggered = false;
    app.backend.call = async <T = StudioSnapshot>(ep: string, payload?: unknown): Promise<T> => {
      const snap = await origBackendCall<T>(ep, payload);
      if (ep === 'saveSource' && !cancelTriggered) {
        cancelTriggered = true;
        await app.route('cancel', { projectId: pid09 });
      }
      return snap;
    };
    const delegateSceneTool = app.agent.toolList.find(t => t.name === 'delegate_scene_code')!;
    try {
      await assert.rejects(
        () => delegateSceneTool.run({ expectedRevision: p09.project!.revision, shotId: s09, instruction: '生成标题卡' }, (app.agent as unknown as { context: (r: string, p: string, s: AbortSignal) => any }).context('r09', pid09, new AbortController().signal)),
        /预览渲染校验已被取消/,
      );
    } finally {
      app.backend.call = origBackendCall;
    }
    const recordedTasks = await call<{ tasks: { status: string; kind: string }[] }>('tasks', { projectId: pid09 });
    assert.ok(recordedTasks.tasks.some(t => t.kind === 'preview' && t.status === 'cancelled'), '宿主任务日志应记录 preview 为 cancelled');

    // 2) #05 & #13: Approved Plan A + Workbench Draft B preservation + Video motion reference + 2nd character reference identityMap binding
    let p5 = await call<StudioSnapshot>('create', { title: '草稿交接与参考无损验证' });
    const pid5 = p5.project!.id;
    const shA = p5.project!.shots[0]!.id;
    const shB = p5.project!.shots[1]!.id;

    // Import 2 character images + 1 previz image + 1 motion reference video
    p5 = await call<StudioSnapshot>('import', { projectId: pid5, expectedRevision: p5.project!.revision, name: '定妆图1.png', mime: 'image/png', dataBase64: `data:image/png;base64,${solidPng(64, 64, 200, 80, 80).toString('base64')}` });
    const img1 = p5.project!.assets.at(-1)!.id;
    p5 = await call<StudioSnapshot>('import', { projectId: pid5, expectedRevision: p5.project!.revision, name: '定妆图2_锁定身份.png', mime: 'image/png', dataBase64: `data:image/png;base64,${solidPng(64, 64, 80, 180, 220).toString('base64')}` });
    const img2 = p5.project!.assets.at(-1)!.id;
    p5 = await call<StudioSnapshot>('import', { projectId: pid5, expectedRevision: p5.project!.revision, name: '白模预演帧.png', mime: 'image/png', dataBase64: `data:image/png;base64,${solidPng(64, 64, 150, 150, 150).toString('base64')}` });
    const previzImg = p5.project!.assets.at(-1)!.id;
    p5 = await call<StudioSnapshot>('import', { projectId: pid5, expectedRevision: p5.project!.revision, name: '运镜节奏参考.mp4', mime: 'video/mp4', dataBase64: `data:video/mp4;base64,${mp4Bytes.toString('base64')}` });
    const motionVid = p5.project!.assets.at(-1)!.id;

    const planA = {
      version: 1 as const,
      ruleSetVersion: DIRECTOR_RULESET_VERSION,
      filmKind: 'suspense_short' as const,
      title: '获批计划 A',
      logline: '获批梗概 A',
      style: { look: '冷峻胶片', palette: '青黑', typography: '衬线', motion: '缓推', negative: '卡通' },
      characters: [
        { id: 'hero', name: '林探长', identity: '获批A的冷峻探长身份', features: ['黑色风衣'], referenceAssetIds: [img1, img2] },
      ],
      storyBeats: [{ id: 'b1', function: '开场', change: '发现线索', shotIds: [shA, shB] }],
      worldLayouts: [],
      // Explicitly bind the SECOND reference image (img2) as identity!
      identityMap: [{ characterId: 'hero', assetId: img2 }],
      shots: [
        {
          shotId: shA,
          title: '首镜',
          visualPrompt: '林探长步入走廊',
          durationSeconds: 3,
          narration: '',
          characterIds: ['hero'],
          audioStrategy: 'silent' as const,
          performance: [],
          dialogue: [],
          events: [],
          // Video motion reference on shot A!
          references: [{ assetId: motionVid, purpose: 'motion' as const, usage: 'reference_only' as const }],
          acceptance: [],
        },
        {
          shotId: shB,
          title: '次镜',
          visualPrompt: '林探长驻足回望',
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

    // Verify #13 first (on approved doc before Draft B): trigger location_upsert -> Story rebuilds DirectorDocument -> video motion reference & img2 identityMap MUST both survive!
    const ctx5 = (app.agent as unknown as { context: (r: string, p: string, s: AbortSignal) => any }).context('r5', pid5, new AbortController().signal);
    const locTool = app.agent.toolList.find(t => t.name === 'location_upsert')!;
    await locTool.run({ id: 'corridor', name: '旧公寓长廊', description: '剥落墙皮与壁灯' }, ctx5);

    const snapAfter13 = await call<StudioSnapshot>('current', { projectId: pid5 });
    const docAfter13 = readDirectorDocument(snapAfter13.project!);
    assert.ok(docAfter13);
    assert.equal(docAfter13.status, 'approved');
    assert.ok(
      docAfter13.plan.shots[0]!.references.some(r => r.assetId === motionVid && r.purpose === 'motion'),
      'Story 回写 DirectorDocument 时必须保留合法的视频运动参考（motionVid）',
    );
    assert.equal(
      docAfter13.plan.identityMap.find(m => m.characterId === 'hero')?.assetId,
      img2,
      '同一角色有两张参考图且明确选第二张时，回写后身份绑定仍须为第二张（img2）',
    );

    // Verify .yingliu archive export/import also preserves identityAssetId = img2 & video motion reference!
    const archivePath = join(dir, 'recheck13.yingliu');
    await call('app.exportProject', { projectId: pid5, path: archivePath });
    const importedSnap = await call<StudioSnapshot>('app.importProject', { path: archivePath });
    const importedStory = await call<Story>('story.get', { projectId: importedSnap.project!.id });
    assert.equal(importedStory.characters[0]!.identityAssetId, img2);
    assert.ok(importedStory.shots[0]!.references?.some(r => r.assetId === motionVid && r.purpose === 'motion'));

    // Now test #05: User saves unapproved Draft B in Workbench modifying hero.identity & title!
    const planB = structuredClone(docAfter13.plan);
    planB.title = '工作台未批准草稿 B';
    planB.characters[0]!.identity = '草稿B用户手工修改的新角色身份';
    await call('director.document.save', { projectId: pid5, expectedVersion: docAfter13.version, plan: planB });

    // Art department adds another location AND director approves single-shot previz ONLY for shA!
    await locTool.run({ id: 'rooftop', name: '雨夜天台', description: '霓虹灯牌水洼' }, ctx5);
    const previzReviewTool = app.agent.toolList.find(t => t.name === 'submit_previz_review')!;
    await previzReviewTool.run({
      summary: '仅批准第一镜白模预演',
      shots: [{ shotId: shA, imageAssetId: previzImg, cameraNote: '35mm 跟拍确认' }],
    }, ctx5);

    const storyAStillActive = await call<Story>('story.get', { projectId: pid5 });
    assert.equal(storyAStillActive.status, 'approved', '获批 A 仍须保持可执行状态');
    assert.equal(storyAStillActive.characters[0]!.description, '获批A的冷峻探长身份');
    assert.equal(storyAStillActive.shots[0]!.previz?.status, 'approved');

    const snapDraftB = await call<StudioSnapshot>('current', { projectId: pid5 });
    const docDraftB = readDirectorDocument(snapDraftB.project!);
    assert.ok(docDraftB);
    assert.equal(docDraftB.status, 'draft', '批准单镜预演或新增场景不得把工作台草稿 B 篡改为 approved');
    assert.equal(docDraftB.plan.title, '工作台未批准草稿 B');
    assert.equal(docDraftB.plan.characters[0]!.identity, '草稿B用户手工修改的新角色身份', '草稿 B 的角色编辑必须完整保留可取回');
    assert.ok(docDraftB.plan.locations?.some(l => l.id === 'rooftop'), '增量新增的场景应合并进草稿');
    assert.equal(docDraftB.plan.shots[0]!.previz?.status, 'approved', '获批预演的镜头一应更新预演状态');
    assert.equal(docDraftB.plan.shots[1]!.previz, undefined, '未涉及的镜头二不得被改写');

    // 3) #14: 120 shots + 60 assets -> sub-agent project_get AND 120-shot bible_get / story_get all return 100% valid un-truncated JSON!
    const p14 = await call<StudioSnapshot>('create', { title: '百镜六十素材部门分页测试', blank: true });
    const pid14 = p14.project!.id;
    const ctx14 = (app.agent as unknown as { context: (r: string, p: string, s: AbortSignal) => any }).context('r14', pid14, new AbortController().signal);
    const shotsMutate = app.agent.toolList.find(t => t.name === 'shots_mutate')!;
    let cur14 = await call<StudioSnapshot>('current', { projectId: pid14 });

    const add120 = Array.from({ length: 120 }, (_, idx) => ({
      title: `长片第 ${idx + 1} 镜 · 复杂场面调度与运镜备注`,
      durationSeconds: 2.5,
      intent: `第 ${idx + 1} 镜叙事意图与视觉情绪推进说明`,
    }));
    await shotsMutate.run({ expectedRevision: cur14.project!.revision, addShots: add120 }, ctx14);
    cur14 = await call<StudioSnapshot>('current', { projectId: pid14 });
    assert.equal(cur14.project!.shots.length, 120);
    lastShot120Id = cur14.project!.shotOrder[119]!;

    // Inject 60 image assets with verbose descriptions into the 120-shot project!
    const pngBuf = solidPng(32, 32, 90, 120, 160);
    const p14Root = cur14.recent.find(r => r.id === pid14)!.path;
    const assetsDir = join(p14Root, 'assets');
    await mkdir(assetsDir, { recursive: true });
    const projWith60Assets = structuredClone(cur14.project!);
    for (let i = 0; i < 60; i++) {
      const rel = `assets/bulk-ref-${i + 1}.png`;
      await writeFile(join(assetsDir, `bulk-ref-${i + 1}.png`), pngBuf);
      projWith60Assets.assets.push({
        id: `asset-bulk-${i + 1}`,
        kind: 'image',
        name: `大型美术设定参考图_${i + 1}.png`,
        path: rel,
        mime: 'image/png',
        width: 32,
        height: 32,
        description: `这是第 ${i + 1} 张高清场景与道具美术设定图，包含大量空间透视、色彩冷暖对比、材质纹理与服装细节描述文本用于压力测试`,
        provenance: { origin: 'user_import', usage: 'reference_only' },
      });
    }
    await call('save', { projectId: pid14, expectedRevision: cur14.project!.revision, project: projWith60Assets, deferPreview: true });

    // Check 1-shot read with 60 assets directly: must be <= 12,000 chars and valid JSON!
    const projectGetTool = app.agent.toolList.find(t => t.name === 'project_get')!;
    const oneShot60Assets = await projectGetTool.run({ shotOffset: 0, shotLimit: 1 }, ctx14);
    assert.ok(oneShot60Assets.content.length <= 12_000, `60 素材单镜读取不得超过 12000 字符，实际=${oneShot60Assets.content.length}`);
    const parsed60 = JSON.parse(oneShot60Assets.content);
    assert.equal(parsed60.totalAssets, 60);
    assert.equal(parsed60.shotOrder.length, 120);
    assert.equal(parsed60.shotOrder[119], lastShot120Id);

    // Delegate project_get of the final shots to cinematographer sub-agent -> verify next model turn receives valid JSON (NOT truncated at 4000 chars!)
    subTurn = 0;
    directorTurn = 0;
    subagentReceivedProjectJson = '';
    const r14 = await call<PublicRun>('agent.start', { projectId: pid14, goal: '委派摄影部门读取百镜末尾', autoApprove: ['read', 'write'], maxReviewRounds: 0 });
    const d14 = await waitRun(call, r14.id, ['complete', 'failed']);
    assert.equal(d14.status, 'complete', d14.message);
    assert.ok(subagentReceivedProjectJson.length > 0);
    const subParsed = JSON.parse(subagentReceivedProjectJson);
    assert.equal(subParsed.shotOrder[119], lastShot120Id, '部门子代理收到的 JSON 必须完整可解析且保留末镜稳定 ID');
    assert.ok(subParsed.shots.some((s: { id: string }) => s.id === lastShot120Id));

    // Also verify 120-shot bible_get and story_get pagination & JSON validity!
    const planStoryTool = app.agent.toolList.find(t => t.name === 'plan_story')!;
    const planShotsTool = app.agent.toolList.find(t => t.name === 'plan_shots')!;
    await planStoryTool.run({
      title: '百镜长片圣经',
      logline: '测试 120 镜 bible_get 与 story_get 分页不截断',
      style: { look: '写实电影', palette: '冷青', typography: '黑体', motion: '稳健推轨', negative: '无' },
      characters: [{ id: 'lead', name: '主角', description: '长片主角', features: ['风衣'] }],
    }, ctx14);
    await planShotsTool.run({
      shots: cur14.project!.shotOrder.map((sid, idx) => ({
        id: `bs-${idx + 1}`,
        shotId: sid,
        summary: `第 ${idx + 1} 镜详细画面调度、人物动作、光影层次与镜头运动说明文本`,
        shotType: '中景',
        camera: '50mm 缓推',
        durationSeconds: 2.5,
        dialogue: `第 ${idx + 1} 镜角色台词对白内容`,
        characters: ['lead'],
      })),
    }, ctx14);

    const bibleGetTool = app.agent.toolList.find(t => t.name === 'bible_get')!;
    const storyGetTool = app.agent.toolList.find(t => t.name === 'story_get')!;
    const bibleResDefault = await bibleGetTool.run({}, ctx14);
    assert.ok(bibleResDefault.content.length <= 12_000);
    const bibleParsed0 = JSON.parse(bibleResDefault.content);
    assert.equal(bibleParsed0.story.pagination.totalShots, 120);
    assert.equal(bibleParsed0.story.shotOrder[119], lastShot120Id);

    const storyResTail = await storyGetTool.run({ shotOffset: 115, shotLimit: 5 }, ctx14);
    assert.ok(storyResTail.content.length <= 12_000);
    const storyParsedTail = JSON.parse(storyResTail.content);
    assert.equal(storyParsedTail.shots.length, 5);
    assert.equal(storyParsedTail.shots[4].shotId, lastShot120Id);
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
