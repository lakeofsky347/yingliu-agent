import { randomUUID } from 'node:crypto';
import type { AgentMessage, AgentRun, AgentTool, CrewDepartment, ToolContext, ToolResult } from './contracts.ts';
import { chatTurn, looksLikeNoToolSupport, type ChatConfig } from './model-client.ts';
import { bound, summarizeProject } from './context.ts';
import { storyBrief } from './story.ts';

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
    allowedTools: ['project_get', 'bible_get', 'styles_list', 'project_set_style', 'character_upsert', 'location_upsert', 'prop_upsert', 'continuity_log_upsert', 'skill_read'],
    systemRole: '你是剧组的「美术与资产设定师」。负责统一全片视觉美学、色彩体系（Palette），建立并完善角色外观特征库、固定场景母版库（Locations）、关键叙事道具库（Props）与场记连续性设定。',
  },
  cinematographer: {
    department: 'cinematographer',
    title: '3D 预演与摄影指导 (DP)',
    preferRole: 'director',
    allowedTools: ['project_get', 'bible_get', 'env_check', 'skill_read', 'blender_render_previz', 'continuity_log_upsert', 'shot_patch'],
    systemRole: '你是剧组的「3D 预演与摄影指导（DP）」。精通焦距景别（24/35/50/85mm）、景深光圈 fStop、180° 轴线规则、演员走位调度与电影布光，使用 Blender 渲染带姿态走位与 Z-Depth 深度图的预演资产。',
  },
  scene_coder: {
    department: 'scene_coder',
    title: '动态图形与场景代码师',
    preferRole: 'scene',
    allowedTools: ['project_get', 'bible_get', 'shot_read_source', 'shot_write_source', 'shot_patch', 'render_check', 'skill_read'],
    systemRole: '你是剧组的「动态图形与场景代码师」。专注编写高审美、帧确定性的 HTML/CSS/SVG/Canvas 2D 镜头源码（严禁使用非确定性定时器或外链），每次写入后必须执行 render_check 确保零报错。',
  },
  sound_director: {
    department: 'sound_director',
    title: '声音与对白表演师',
    preferRole: 'director',
    allowedTools: ['project_get', 'bible_get', 'audio_edit', 'align_to_voice', 'synthesize_sfx', 'audio_mix_master', 'audio_analyze', 'video_clip_extract', 'skill_read'],
    systemRole: '你是剧组的「声音与对白表演师」。负责音轨精修、多句对白话轮顺序排布、离线程序化拟音合成（雨声/脚步/心跳/Riser）、人声触发 BGM 自动闪避（Ducking）与 -14 LUFS 响度达标检查。',
  },
  post_editor_qc: {
    department: 'post_editor_qc',
    title: '精剪调色与多模质检师',
    preferRole: 'director',
    allowedTools: ['project_get', 'bible_get', 'shot_patch', 'video_clip_save', 'shot_take_manage', 'post_overlay_subtitle', 'reframe_project', 'render_check', 'quality_check', 'audio_analyze', 'visual_review', 'temporal_video_review', 'consistency_review', 'skill_read'],
    systemRole: '你是剧组的「精剪调色与多模质检师」。负责双镜头叠化转场、B-Roll 画中画、逐镜色温曝光匹配调色、全局时间轴字幕精修，以及执行 5 帧时序宫格视觉审片与声画导出前全量质检。',
  },
};

export interface SubagentRunOptions {
  department: CrewDepartment;
  task: string;
  scopedShotIds?: string[];
  parentRun: AgentRun;
  parentCtx: ToolContext;
  allTools: readonly AgentTool[];
  resolveSubModel: (preferRole: 'scene' | 'director') => Promise<{ config: ChatConfig; parameters: Record<string, unknown> }>;
  fetch?: typeof fetch;
  onTokenUsage: (inputTokens: number, outputTokens: number, usageKnown: boolean, parameters: Record<string, unknown>) => Promise<void>;
  maxSubSteps?: number;
}

/**
 * Execute an isolated, bounded sub-agent loop for a specialized film crew department.
 * Only exposes non-approval (read + write) tools in its department scope so paid/export gates remain strictly governed by the Showrunner.
 */
export async function runCrewSubagent(opts: SubagentRunOptions): Promise<ToolResult> {
  const spec = CREW_SPECS[opts.department];
  if (!spec) throw new Error('未知的剧组部门：' + String(opts.department));
  const allowed = new Set(spec.allowedTools);
  const subTools = opts.allTools.filter(tool =>
    allowed.has(tool.name)
    && (tool.risk === 'read' || tool.risk === 'write')
    && opts.parentRun.policy.autoApprove.includes(tool.risk),
  );

  const [snapshot, story] = await Promise.all([
    opts.parentCtx.port.snapshot(opts.parentCtx.projectId),
    opts.parentCtx.docs.story(),
  ]);
  const model = await opts.resolveSubModel(spec.preferRole ?? 'director');
  const system = [
    spec.systemRole,
    '你正在作为子代理协助总导演执行专项任务，完成后输出简明中文工作回执（包含修改了哪些镜头/音轨、最新 revision 及遗留建议）。',
    '所有写入工具必须携带最新 expectedRevision；若需收费生成或人类审批操作，不要自行猜测，直接在回执中向总导演提交明确的参数建议。',
    storyBrief(story),
  ].filter(Boolean).join('\n\n');

  const scopeHint = opts.scopedShotIds?.length ? `\n目标镜头范围：${opts.scopedShotIds.join(', ')}` : '';
  const messages: AgentMessage[] = [{
    role: 'user',
    content: `总导演委派任务：${opts.task}${scopeHint}\n\n当前工程摘要：${JSON.stringify(summarizeProject(snapshot.project))}`,
  }];

  const maxSteps = Math.max(1, Math.min(8, opts.maxSubSteps ?? 6));
  let latestRevision = snapshot.project?.revision;
  const executedTools: string[] = [];

  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    opts.parentCtx.signal.throwIfAborted();
    let turn;
    try {
      turn = await chatTurn(model.config, system, messages, subTools, opts.parentCtx.signal, opts.fetch);
    } catch (error) {
      if (model.config.supportsTools && looksLikeNoToolSupport(error)) {
        turn = await chatTurn({ ...model.config, supportsTools: false }, system, messages, subTools, opts.parentCtx.signal, opts.fetch);
      } else throw error;
    }
    await opts.onTokenUsage(turn.usage.inputTokens, turn.usage.outputTokens, turn.usageKnown, model.parameters);
    messages.push({
      role: 'assistant',
      content: turn.content || null,
      ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) } : {}),
    });
    if (!turn.toolCalls.length) {
      return {
        content: JSON.stringify({
          ok: true,
          department: spec.department,
          title: spec.title,
          stepsUsed: stepIdx + 1,
          executedTools,
          revision: latestRevision,
          report: bound(turn.content || '专项任务已完成', 3000),
        }),
        revision: latestRevision,
      };
    }

    for (const call of turn.toolCalls.slice(0, 6)) {
      opts.parentCtx.signal.throwIfAborted();
      const tool = subTools.find(t => t.name === call.name);
      if (!tool) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `部门子代理不可调用 ${call.name}，请在回执中交由总导演发起` }) });
        continue;
      }
      try {
        const parsed = JSON.parse(call.arguments || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数须为 JSON 对象');
        const res = await tool.run({ ...parsed, __callId: randomUUID() }, opts.parentCtx);
        executedTools.push(tool.name);
        if (res.revision !== undefined) latestRevision = res.revision;
        messages.push({ role: 'tool', tool_call_id: call.id, content: bound(res.content, 4000) });
      } catch (error) {
        if (opts.parentCtx.signal.aborted) throw error;
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) });
      }
    }
  }

  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  return {
    content: JSON.stringify({
      ok: true,
      department: spec.department,
      title: spec.title,
      stepsUsed: maxSteps,
      executedTools,
      revision: latestRevision,
      report: bound(typeof lastAssistant?.content === 'string' ? lastAssistant.content : '已达子代理局部步数上限，已完成阶段修改', 3000),
    }),
    revision: latestRevision,
  };
}
