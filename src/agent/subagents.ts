import { randomUUID } from 'node:crypto';
import type { AgentMessage, AgentPort, AgentRun, AgentTool, CrewDepartment, SubagentCheckpoint, ToolCall, ToolContext, ToolResult, ToolRisk } from './contracts.ts';
import { chatTurn, looksLikeNoToolSupport, type ChatConfig } from './model-client.ts';
import { bound, summarizeProject } from './context.ts';
import { storyBrief } from './story.ts';
import type { SceneSource, VideoProject } from '../shared/types.ts';

export class SubagentBudgetExceededError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'SubagentBudgetExceededError';
  }
}

export interface CrewSpec {
  department: CrewDepartment;
  title: string;
  preferRole?: 'scene' | 'director';
  allowedTools: string[];
  systemRole: string;
}

export const CREW_SPECS: Record<CrewDepartment, CrewSpec> = {
  screenwriter: {
    department: 'screenwriter',
    title: '剧作与拉片分镜师',
    preferRole: 'director',
    allowedTools: ['project_get', 'bible_get', 'story_get', 'analyze_reference_video', 'styles_list', 'skill_read', 'shots_mutate', 'shot_patch', 'continuity_log_upsert'],
    systemRole: '你是剧组的「剧作与拉片分镜师」。负责参考样片镜头拆解、幕/场/镜戏剧结构编排、景别递进与场记连续性维护，输出结构严谨的分镜修改。',
  },
  art_director: {
    department: 'art_director',
    title: '美术与资产设定师',
    preferRole: 'director',
    allowedTools: ['project_get', 'bible_get', 'story_get', 'styles_list', 'project_set_style', 'character_upsert', 'location_upsert', 'prop_upsert', 'continuity_log_upsert', 'skill_read'],
    systemRole: '你是剧组的「美术与资产设定师」。负责统一全片视觉美学、色彩体系（Palette），建立并完善角色外观特征库、固定场景母版库（Locations）、关键叙事道具库（Props）与场记连续性设定。',
  },
  cinematographer: {
    department: 'cinematographer',
    title: '3D 预演与摄影指导 (DP)',
    preferRole: 'director',
    allowedTools: ['project_get', 'bible_get', 'story_get', 'env_check', 'skill_read', 'blender_render_previz', 'continuity_log_upsert', 'shot_patch'],
    systemRole: '你是剧组的「3D 预演与摄影指导（DP）」。精通焦距景别（24/35/50/85mm）、景深光圈 fStop、180° 轴线规则、演员走位调度与电影布光，使用 Blender 渲染带姿态走位与 Z-Depth 深度图的预演资产。',
  },
  scene_coder: {
    department: 'scene_coder',
    title: '动态图形与场景代码师',
    preferRole: 'scene',
    allowedTools: ['project_get', 'bible_get', 'story_get', 'shot_read_source', 'shot_write_source', 'shot_patch', 'render_check', 'skill_read'],
    systemRole: '你是剧组的「动态图形与场景代码师」。专注编写高审美、帧确定性的 HTML/CSS/SVG/Canvas 2D 镜头源码（严禁使用非确定性定时器或外链），每次写入后必须执行 render_check 确保零报错。',
  },
  sound_director: {
    department: 'sound_director',
    title: '声音与对白表演师',
    preferRole: 'director',
    allowedTools: ['project_get', 'bible_get', 'story_get', 'audio_edit', 'align_to_voice', 'synthesize_sfx', 'audio_mix_master', 'audio_analyze', 'video_clip_extract', 'skill_read'],
    systemRole: '你是剧组的「声音与对白表演师」。负责音轨精修、多句对白话轮顺序排布、离线程序化拟音合成（雨声/脚步/心跳/Riser）、人声触发 BGM 自动闪避（Ducking）与 -14 LUFS 响度达标检查。',
  },
  post_editor_qc: {
    department: 'post_editor_qc',
    title: '精剪调色与多模质检师',
    preferRole: 'director',
    allowedTools: ['project_get', 'bible_get', 'story_get', 'shot_patch', 'video_clip_save', 'shot_take_manage', 'post_overlay_subtitle', 'reframe_project', 'render_check', 'quality_check', 'audio_analyze', 'visual_review', 'temporal_video_review', 'consistency_review', 'skill_read'],
    systemRole: '你是剧组的「精剪调色与多模质检师」。负责双镜头叠化转场、B-Roll 画中画、逐镜色温曝光匹配调色、全局时间轴字幕精修，以及执行 5 帧时序宫格视觉审片与声画导出前全量质检。',
  },
};

const GLOBAL_MUTATION_TOOLS = new Set(['reframe_project', 'project_set_style', 'audio_mix_master']);

function isRetryableModelError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  const msg = error instanceof Error ? error.message : String(error);
  return status === 408 || status === 429 || (typeof status === 'number' && status >= 500) || /timeout|timed out|超时|ECONN|ENOTFOUND|fetch failed|network/i.test(msg);
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Validate tool arguments against `scopedShotIds` before running any write tool in a sub-agent. */
export function assertSubagentToolScope(tool: AgentTool, args: Record<string, unknown>, scope: ReadonlySet<string>): void {
  if (tool.risk !== 'write' || !scope.size) return;
  const scopeList = [...scope].join(', ');
  const reject = (detail: string): never => {
    throw new Error(`越界拦截：本次委派仅限操作镜头 [${scopeList}]，${detail}；如需修改其他镜头或全片结构，请在回执中交由总导演处理`);
  };
  if (GLOBAL_MUTATION_TOOLS.has(tool.name)) {
    reject(`禁止调用全片全局修改工具 ${tool.name}`);
  }
  if (tool.name === 'shots_mutate') {
    if (args.initStoryboard !== undefined || args.shotOrder !== undefined || args.title !== undefined || args.topic !== undefined) {
      reject('禁止重建整片分镜、重排全片顺序或改写影片标题');
    }
    if (Array.isArray(args.deleteShotIds) && args.deleteShotIds.some(id => !scope.has(String(id)))) {
      reject('禁止删除委派范围以外的镜头');
    }
    if (Array.isArray(args.addShots)) {
      for (const raw of args.addShots as Record<string, unknown>[]) {
        if (typeof raw?.afterShotId !== 'string' || !scope.has(raw.afterShotId)) {
          reject('限定镜头范围时新增插入镜头必须指定范围内的 afterShotId');
        }
      }
    }
    return;
  }
  if (tool.name === 'shot_patch') {
    const patches = Array.isArray(args.patches) ? args.patches as Record<string, unknown>[] : [];
    for (const p of patches) {
      if (typeof p?.shotId !== 'string' || !scope.has(p.shotId)) {
        reject(`不能通过 shot_patch 修改范围外镜头 ${String(p?.shotId ?? '')}`);
      }
    }
    return;
  }
  if (['shot_write_source', 'video_clip_save', 'shot_take_manage', 'continuity_log_upsert', 'blender_render_previz'].includes(tool.name)) {
    const sid = typeof args.shotId === 'string' ? args.shotId.trim() : '';
    if (!sid || !scope.has(sid)) reject(`${tool.name} 必须指定委派范围内的 shotId（收到 ${sid || '空'}）`);
    return;
  }
  if (tool.name === 'post_overlay_subtitle') {
    if (args.addOverlay && typeof args.addOverlay === 'object') {
      const sid = String((args.addOverlay as Record<string, unknown>).shotId ?? '');
      if (!scope.has(sid)) reject(`画中画图层不能挂载到范围外镜头 ${sid}`);
    }
    if (Array.isArray(args.setSubtitles)) {
      for (const cue of args.setSubtitles as Record<string, unknown>[]) {
        const sid = typeof cue?.shotId === 'string' ? cue.shotId : '';
        if (!sid || !scope.has(sid)) reject('限定镜头范围时设置字幕必须关联范围内的 shotId');
      }
    }
    return;
  }
  if (tool.name === 'align_to_voice') {
    const ids = Array.isArray(args.shotIds) ? args.shotIds.map(String) : [];
    if (!ids.length || ids.some(id => !scope.has(id))) {
      reject('限定镜头范围时 align_to_voice 必须显式传入范围内的 shotIds');
    }
    return;
  }
  if (tool.name === 'audio_edit') {
    const req = (args.request && typeof args.request === 'object' ? args.request : {}) as Record<string, unknown>;
    if (args.action === 'add' && (typeof req.shotId !== 'string' || !scope.has(req.shotId))) {
      reject('限定镜头范围时添加音轨片段必须绑定到范围内的 shotId');
    }
    return;
  }
  if (tool.name === 'synthesize_sfx' && args.bindToTrack === true) {
    const sid = typeof args.shotId === 'string' ? args.shotId.trim() : '';
    if (!sid || !scope.has(sid)) reject('限定镜头范围时直接入轨的音效必须指定范围内的 shotId');
  }
}

/** Wrap ToolContext so host-level commits & source writes also enforce non-scoped shot immutability. */
function buildScopedToolContext(baseCtx: ToolContext, scope: ReadonlySet<string>): ToolContext {
  if (!scope.size) return baseCtx;
  const assertUnscopedUnchanged = (before: VideoProject, after: VideoProject, sources: Record<string, SceneSource>) => {
    for (const oldShot of before.shots) {
      if (scope.has(oldShot.id)) continue;
      if (Object.hasOwn(sources, oldShot.id)) {
        throw new Error(`越界拦截：禁止修改范围外镜头 ${oldShot.id} 的源码`);
      }
      const nextShot = after.shots.find(s => s.id === oldShot.id);
      if (!nextShot) throw new Error(`越界拦截：禁止删除范围外镜头 ${oldShot.id}`);
      if (JSON.stringify(oldShot) !== JSON.stringify(nextShot)) {
        throw new Error(`越界拦截：范围外镜头 ${oldShot.id} 的属性被改动`);
      }
      const oldVClips = (before.videoClips ?? []).filter(c => c.shotId === oldShot.id);
      const newVClips = (after.videoClips ?? []).filter(c => c.shotId === oldShot.id);
      if (JSON.stringify(oldVClips) !== JSON.stringify(newVClips)) {
        throw new Error(`越界拦截：范围外镜头 ${oldShot.id} 的视频片段被改动`);
      }
      const oldAClips = (before.audioClips ?? []).filter(c => c.shotId === oldShot.id);
      const newAClips = (after.audioClips ?? []).filter(c => c.shotId === oldShot.id);
      if (JSON.stringify(oldAClips) !== JSON.stringify(newAClips)) {
        throw new Error(`越界拦截：范围外镜头 ${oldShot.id} 的音频片段被改动`);
      }
      const oldOClips = (before.overlayClips ?? []).filter(c => c.shotId === oldShot.id);
      const newOClips = (after.overlayClips ?? []).filter(c => c.shotId === oldShot.id);
      if (JSON.stringify(oldOClips) !== JSON.stringify(newOClips)) {
        throw new Error(`越界拦截：范围外镜头 ${oldShot.id} 的画中画图层被改动`);
      }
    }
    const oldUnscopedSubs = (before.subtitles ?? []).filter(c => !c.shotId || !scope.has(c.shotId));
    const newUnscopedSubs = (after.subtitles ?? []).filter(c => !c.shotId || !scope.has(c.shotId));
    if (JSON.stringify(oldUnscopedSubs) !== JSON.stringify(newUnscopedSubs)) {
      throw new Error('越界拦截：禁止修改或清空范围外镜头的字幕');
    }
    const oldGlobalAClips = (before.audioClips ?? []).filter(c => !c.shotId);
    const newGlobalAClips = (after.audioClips ?? []).filter(c => !c.shotId);
    if (JSON.stringify(oldGlobalAClips) !== JSON.stringify(newGlobalAClips)) {
      throw new Error('越界拦截：限定镜头范围时禁止修改全局背景音轨');
    }
  };

  const scopedPort: AgentPort = Object.create(baseCtx.port, {
    saveSource: {
      enumerable: true,
      value: async (projectId: string, shotId: string, expectedRevision: number, source: SceneSource) => {
        if (!scope.has(shotId)) throw new Error(`越界拦截：禁止修改范围外镜头 ${shotId} 的源码`);
        return baseCtx.port.saveSource(projectId, shotId, expectedRevision, source);
      },
    },
    commit: {
      enumerable: true,
      value: async (projectId: string, expectedRevision: number, project: VideoProject, sources: Record<string, SceneSource>, label: string) => {
        const snap = await baseCtx.port.snapshot(projectId);
        // Allow metadata-only syncs (like extensions.directorDocument) as long as non-scoped shots are untouched
        if (snap.project) assertUnscopedUnchanged(snap.project, project, sources);
        return baseCtx.port.commit(projectId, expectedRevision, project, sources, label);
      },
    },
    route: {
      enumerable: true,
      value: async (endpoint: string, payload: Record<string, unknown>) => {
        if (endpoint === 'video.clip.save') {
          const clip = (payload.clip && typeof payload.clip === 'object' ? payload.clip : {}) as Record<string, unknown>;
          if (typeof clip.shotId !== 'string' || !scope.has(clip.shotId)) {
            return { ok: false, error: { code: 'SCOPE_VIOLATION', message: `越界拦截：禁止修改范围外镜头 ${String(clip.shotId ?? '')} 的视频片段` } };
          }
        }
        return baseCtx.port.route(endpoint, payload);
      },
    },
  });
  return { ...baseCtx, port: scopedPort, scopedShotIds: scope };
}

export interface SubagentRunOptions {
  department: CrewDepartment;
  task: string;
  scopedShotIds?: string[];
  parentRun: AgentRun;
  parentCtx: ToolContext;
  allTools: readonly AgentTool[];
  resolveSubModel: (preferRole: 'scene' | 'director') => Promise<{ config: ChatConfig; parameters: Record<string, unknown> }>;
  fetch?: typeof fetch;
  checkBudget: (next: 'model' | 'tool') => Promise<string | null>;
  onModelTurn: (inputTokens: number, outputTokens: number, usageKnown: boolean, parameters: Record<string, unknown>) => Promise<void>;
  onToolCall: (risk: ToolRisk) => Promise<void>;
  checkpoint?: SubagentCheckpoint;
  saveCheckpoint?: (checkpoint: SubagentCheckpoint) => Promise<void>;
  clearCheckpoint?: () => Promise<void>;
  trace?: (entry: Record<string, unknown>) => Promise<void>;
  retryDelayMs?: number;
  maxSubSteps?: number;
}

/**
 * Execute an isolated, bounded, budget-governed, scope-sandboxed, step-checkpointed sub-agent loop.
 */
export async function runCrewSubagent(opts: SubagentRunOptions): Promise<ToolResult> {
  const spec = CREW_SPECS[opts.department];
  if (!spec) throw new Error('未知的剧组部门：' + String(opts.department));
  if (opts.checkpoint?.completedResult) {
    return structuredClone(opts.checkpoint.completedResult);
  }

  const allowed = new Set(spec.allowedTools);
  const subTools = opts.allTools.filter(tool =>
    allowed.has(tool.name)
    && (tool.risk === 'read' || tool.risk === 'write')
    && opts.parentRun.policy.autoApprove.includes(tool.risk),
  );

  const scope = new Set((opts.scopedShotIds ?? []).map(s => s.trim()).filter(Boolean));
  const scopedCtx = buildScopedToolContext(opts.parentCtx, scope);

  const [snapshot, story] = await Promise.all([
    opts.parentCtx.port.snapshot(opts.parentCtx.projectId),
    opts.parentCtx.docs.story(),
  ]);
  const model = await opts.resolveSubModel(spec.preferRole ?? 'director');
  const system = [
    spec.systemRole,
    '你正在作为子代理协助总导演执行专项任务，完成后输出简明中文工作回执（包含修改了哪些镜头/音轨、最新 revision 及遗留建议）。',
    '所有写入工具必须携带最新 expectedRevision；若需收费生成或人类审批操作，不要自行猜测，直接在回执中向总导演提交明确的参数建议。',
    scope.size ? `【严格镜头边界】你只能读取或修改这些镜头：[${[...scope].join(', ')}]，严禁触碰工程内其他镜头。` : '',
    storyBrief(story),
  ].filter(Boolean).join('\n\n');

  const maxSteps = Math.max(1, Math.min(8, opts.maxSubSteps ?? 6));
  const maxToolsPerTurn = 6;

  // Restore durable checkpoint when resuming after a mid-delegation 503 / interruption!
  const state: SubagentCheckpoint = opts.checkpoint
    ? structuredClone(opts.checkpoint)
    : {
        department: opts.department,
        messages: [{
          role: 'user',
          content: `总导演委派任务：${opts.task}${scope.size ? `\n目标镜头范围：${[...scope].join(', ')}` : ''}\n\n当前工程摘要：${JSON.stringify(summarizeProject(snapshot.project, { maxChars: 10_000 }))}`,
        }],
        stepIdx: 0,
        pendingCalls: [],
        executedTools: [],
        failedTools: [],
        skippedTools: [],
        latestRevision: snapshot.project?.revision,
      };
  state.skippedTools ??= [];

  const persistCheckpoint = async () => {
    await opts.saveCheckpoint?.(structuredClone(state));
  };

  const executePendingQueue = async () => {
    while (state.pendingCalls.length) {
      opts.parentCtx.signal.throwIfAborted();
      const call = state.pendingCalls[0]!;
      const tool = subTools.find(t => t.name === call.name);
      if (!tool) {
        const err = `部门子代理不可调用 ${call.name}，请在回执中交由总导演发起`;
        state.failedTools.push({ tool: call.name, error: err });
        state.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: err }) });
        state.pendingCalls.shift();
        await persistCheckpoint();
        continue;
      }
      const toolBudgetErr = await opts.checkBudget('tool');
      if (toolBudgetErr) throw new SubagentBudgetExceededError(toolBudgetErr);

      try {
        const parsed = JSON.parse(call.arguments || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数须为 JSON 对象');
        assertSubagentToolScope(tool, parsed as Record<string, unknown>, scope);
        const res = await tool.run({ ...(parsed as Record<string, unknown>), __callId: call.execId ?? randomUUID() }, scopedCtx);
        await opts.onToolCall(tool.risk);
        let skipReason: string | null = null;
        try {
          const outObj = JSON.parse(res.content);
          if (outObj && typeof outObj === 'object' && !Array.isArray(outObj) && (outObj as { skipped?: unknown }).skipped === true) {
            skipReason = String((outObj as { reason?: unknown; error?: unknown }).reason ?? (outObj as { error?: unknown }).error ?? '前置条件未满足而跳过');
          }
        } catch { /* non-JSON output such as skill_read markdown */ }
        if (skipReason !== null) {
          state.skippedTools!.push({ id: call.id, tool: tool.name, reason: skipReason, kind: 'precondition' });
          await opts.trace?.({ event: 'subagent.tool', department: spec.department, tool: tool.name, status: 'skipped', reason: bound(skipReason, 300) });
        } else {
          state.executedTools.push(tool.name);
          const overflowIdx = state.skippedTools!.findIndex(s => s.kind === 'turn_limit' && s.tool === tool.name);
          if (overflowIdx >= 0) state.skippedTools!.splice(overflowIdx, 1);
          await opts.trace?.({ event: 'subagent.tool', department: spec.department, tool: tool.name, status: 'complete', revision: res.revision });
        }
        if (res.revision !== undefined) state.latestRevision = res.revision;
        state.messages.push({ role: 'tool', tool_call_id: call.id, content: bound(res.content, 12_000) });
      } catch (error) {
        if (opts.parentCtx.signal.aborted || error instanceof SubagentBudgetExceededError) throw error;
        await opts.onToolCall('read');
        const errMsg = error instanceof Error ? error.message : String(error);
        state.failedTools.push({ tool: tool.name, error: errMsg });
        state.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: errMsg }) });
        await opts.trace?.({ event: 'subagent.tool', department: spec.department, tool: tool.name, status: 'failed', error: bound(errMsg, 300) });
      }
      state.pendingCalls.shift();
      await persistCheckpoint();
    }
  };

  // Drain any unexecuted tool calls saved in a resumed checkpoint before requesting the next model turn
  if (state.pendingCalls.length) {
    await executePendingQueue();
  }

  while (state.stepIdx < maxSteps) {
    opts.parentCtx.signal.throwIfAborted();
    const modelBudgetErr = await opts.checkBudget('model');
    if (modelBudgetErr) throw new SubagentBudgetExceededError(modelBudgetErr);

    let turn;
    let attempt = 0;
    const baseDelay = opts.retryDelayMs ?? 300;
    while (true) {
      attempt++;
      try {
        try {
          turn = await chatTurn(model.config, system, state.messages, subTools, opts.parentCtx.signal, opts.fetch);
        } catch (error) {
          if (model.config.supportsTools && looksLikeNoToolSupport(error)) {
            turn = await chatTurn({ ...model.config, supportsTools: false }, system, state.messages, subTools, opts.parentCtx.signal, opts.fetch);
          } else throw error;
        }
        break;
      } catch (error) {
        if (opts.parentCtx.signal.aborted || attempt >= 3 || !isRetryableModelError(error)) throw error;
        await sleepAbortable(baseDelay * (2 ** (attempt - 1)), opts.parentCtx.signal);
      }
    }

    state.stepIdx += 1;
    await opts.onModelTurn(turn.usage.inputTokens, turn.usage.outputTokens, turn.usageKnown, model.parameters);

    state.messages.push({
      role: 'assistant',
      content: turn.content || null,
      ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) } : {}),
    });

    if (!turn.toolCalls.length) {
      const finalSnap = await opts.parentCtx.port.snapshot(opts.parentCtx.projectId).catch(() => null);
      const finalRev = finalSnap?.project?.revision ?? state.latestRevision;
      const skippedList = state.skippedTools ?? [];
      const status = state.failedTools.length === 0 && skippedList.length === 0
        ? 'complete'
        : state.executedTools.length > 0
          ? 'partial'
          : state.failedTools.length > 0
            ? 'failed'
            : 'skipped';
      const finalResult: ToolResult = {
        content: JSON.stringify({
          ok: status === 'complete',
          status,
          department: spec.department,
          title: spec.title,
          stepsUsed: state.stepIdx,
          executedTools: state.executedTools,
          ...(state.failedTools.length ? { failedTools: state.failedTools } : {}),
          ...(skippedList.length ? { skippedTools: skippedList } : {}),
          revision: finalRev,
          report: bound(turn.content || (status === 'complete' ? '专项任务已完成' : status === 'skipped' ? '前置条件未满足，操作已跳过' : '专项任务存在未执行或失败操作'), 3000),
        }),
        revision: finalRev,
      };
      // Keep durable completedResult in checkpoint until parent settleToolSuccess atomically dequeues the parent call!
      state.completedResult = finalResult;
      await persistCheckpoint();
      await opts.trace?.({ event: 'subagent.finish', department: spec.department, status, stepsUsed: state.stepIdx, executedTools: state.executedTools, failedCount: state.failedTools.length, skippedCount: skippedList.length, revision: finalRev });
      return finalResult;
    }

    // Preserve strict 1-to-1 tool_call_id pairing even if the model emitted >6 tool calls in one turn!
    const executable = turn.toolCalls.slice(0, maxToolsPerTurn).map(c => ({ ...c, execId: randomUUID() }));
    const overflow = turn.toolCalls.slice(maxToolsPerTurn);
    state.pendingCalls = executable;
    for (const skipped of overflow) {
      const reason = `单轮最多执行 ${maxToolsPerTurn} 个工具调用，请下一轮继续调用该操作`;
      state.skippedTools!.push({ id: skipped.id, tool: skipped.name, reason, kind: 'turn_limit' });
      state.messages.push({
        role: 'tool',
        tool_call_id: skipped.id,
        content: JSON.stringify({ skipped: true, error: reason }),
      });
    }
    await persistCheckpoint();
    await executePendingQueue();
  }

  // Exhausted maxSteps without reaching a clean stop turn
  const finalSnap = await opts.parentCtx.port.snapshot(opts.parentCtx.projectId).catch(() => null);
  const finalRev = finalSnap?.project?.revision ?? state.latestRevision;
  const skippedList = state.skippedTools ?? [];
  const status = state.executedTools.length > 0 ? 'step_limit_partial' : state.failedTools.length > 0 ? 'failed' : skippedList.length > 0 ? 'skipped' : 'failed';
  const lastAssistant = [...state.messages].reverse().find(m => m.role === 'assistant');
  const exhaustedResult: ToolResult = {
    content: JSON.stringify({
      ok: false,
      status,
      exhausted: true,
      department: spec.department,
      title: spec.title,
      stepsUsed: maxSteps,
      executedTools: state.executedTools,
      ...(state.failedTools.length ? { failedTools: state.failedTools } : {}),
      ...(skippedList.length ? { skippedTools: skippedList } : {}),
      revision: finalRev,
      report: bound(typeof lastAssistant?.content === 'string' && lastAssistant.content ? lastAssistant.content : (status === 'failed' ? '子代理多轮调用均未成功完成写入' : '已达子代理局部步数上限，仅完成阶段性操作'), 3000),
    }),
    revision: finalRev,
  };
  state.completedResult = exhaustedResult;
  await persistCheckpoint();
  await opts.trace?.({ event: 'subagent.finish', department: spec.department, status, exhausted: true, stepsUsed: maxSteps, executedTools: state.executedTools, failedCount: state.failedTools.length, skippedCount: skippedList.length, revision: finalRev });
  return exhaustedResult;
}
