import { randomUUID } from 'node:crypto';
import { compileDirectorPlan } from '../app/conversation.ts';
import type { ChatInput } from '../app/contracts.ts';
import { addShot, applyProductionPolicy, assertProductionComposition, defaultProductionPolicy, defaultSceneSource, deleteShot, reorderShots, updateShot, updateTarget } from '../core/index.ts';
import { normalizeStoryboard } from '../host/generator.ts';
import { buildContactSheetPng } from '../host/contact-sheet.ts';
import { readDirectorDocument, saveDirectorDocument, approveDirectorDocument } from '../director/document.ts';
import type { AgentTool, Capabilities, CrewDepartment, JsonSchema, ProjectTaskRef, ToolContext, ToolResult } from './contracts.ts';
import { bound, summarizeProject } from './context.ts';
import { synthesize, type SynthKind, type SynthSpec } from './synth.ts';
import type { AudioClip, OverlayClip, ProductionMode, Shot, ShotColorGrade, ShotTransition, StudioSnapshot, SubtitleCue, VideoProject } from '../shared/types.ts';
import {
  anchorPrompt, buildDirectorDocumentFromStory, dataChecks, frameIssue, mergeDirectorPlanIntoStory,
  normalizeCharacter, normalizeLocation, normalizeProp, normalizeShots, normalizeStyle,
  pngLuma, qcStatus, type QcIssue, type QcReport, type Story,
} from './story.ts';
import { SKILLS, skillIndex } from './skills.ts';
import { CREW_SPECS } from './subagents.ts';

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string): JsonSchema => ({ type: 'string', description });
const int = (description: string): JsonSchema => ({ type: 'integer', description });
const num = (description: string): JsonSchema => ({ type: 'number', description });
const bool = (description: string): JsonSchema => ({ type: 'boolean', description });
const json = (value: unknown) => bound(JSON.stringify(value));

const SYNTH_KINDS: readonly SynthKind[] = ['tone', 'sweep', 'chime', 'noise', 'whoosh', 'click', 'rain', 'heartbeat', 'footstep', 'riser', 'sub_drop', 'ambience_hum'];
const TRANSITIONS: readonly ShotTransition[] = ['cut', 'fade', 'dissolve', 'wipe_left', 'flash_white'];

function need(args: Record<string, unknown>, key: string): string { const value = args[key]; if (typeof value !== 'string' || !value.trim()) throw new Error(`参数 ${key} 必填`); return value; }
function revision(args: Record<string, unknown>): number { const value = args.expectedRevision; if (!Number.isSafeInteger(value)) throw new Error('参数 expectedRevision 必须是整数；先调用 project_get'); return value as number; }
async function rpc(ctx: ToolContext, endpoint: string, payload: Record<string, unknown>) {
  const result = await ctx.port.route(endpoint, { projectId: ctx.projectId, ...payload });
  if (!result.ok) throw Object.assign(new Error(result.error?.message ?? '操作失败'), { code: result.error?.code });
  return result.value;
}
function projectTask(snapshot: StudioSnapshot): ProjectTaskRef {
  const task = snapshot.task as (StudioSnapshot['task'] & { retryOf?: string });
  if (!task?.id) throw new Error('任务已提交，但没有返回任务 ID；请检查任务记录后继续');
  return { id: task.id, kind: task.kind, ...(task.retryOf ? { retryOf: task.retryOf } : {}) };
}
function agentInput(ctx: ToolContext, message: string): ChatInput { return { message, projectId: ctx.projectId, provider: 'agent', model: 'agent', intent: 'modify' }; }

/** Synchronize Story into project.extensions.directorDocument whenever possible (best-effort, non-destructive). */
async function syncBibleToProject(ctx: ToolContext, story: Story): Promise<void> {
  try {
    const snap = await ctx.port.snapshot(ctx.projectId);
    if (!snap.project || !snap.project.shots.length) return;
    let existing;
    try { existing = readDirectorDocument(snap.project); } catch { existing = undefined; }
    const doc = buildDirectorDocumentFromStory(story, snap.project, existing);
    if (!doc) return;
    const next = structuredClone(snap.project);
    next.extensions = { ...next.extensions, directorDocument: doc };
    await ctx.port.commit(ctx.projectId, snap.project.revision, next, {}, '智能体：同步制片圣经与导演计划文档');
  } catch { /* Non-fatal if user modified project concurrently */ }
}

/** Ensure approved reference image assetIds are bound on `shot.referenceIds` before calling `media.generate` so `readProjectImage` passes. */
async function ensureShotReferenceBindings(ctx: ToolContext, shotId: string | undefined, assetIds: string[], expectedRev: number): Promise<number> {
  if (!shotId || !assetIds.length) return expectedRev;
  const snap = await ctx.port.snapshot(ctx.projectId);
  const project = snap.project;
  if (!project) return expectedRev;
  if (project.revision !== expectedRev) throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' });
  const shot = project.shots.find(s => s.id === shotId);
  if (!shot) return expectedRev;
  const missing = assetIds.filter(id => project.assets.some(a => a.id === id && a.kind === 'image') && !shot.assetIds.includes(id) && !shot.referenceIds.includes(id));
  if (!missing.length) return project.revision;
  const next = structuredClone(project);
  const targetShot = next.shots.find(s => s.id === shotId)!;
  targetShot.referenceIds = [...new Set([...targetShot.referenceIds, ...missing])];
  const committed = await ctx.port.commit(ctx.projectId, project.revision, next, {}, '智能体：绑定镜头参考图');
  return committed.project?.revision ?? project.revision;
}

/** Apply a director-protocol action (video_update / video_audio) with 120-shot capacity for the agent. */
async function directorAction(ctx: ToolContext, tool: 'video_update' | 'video_audio', args: Record<string, unknown>, structural: boolean, label: string): Promise<ToolResult> {
  const snapshot = await ctx.port.snapshot(ctx.projectId);
  const creating = !snapshot.project?.shots.length;
  const message = structural ? '按智能体计划添加、删除或重排镜头' : '按智能体计划修改';
  const plan = compileDirectorPlan({ intent: creating ? 'create' : 'modify', message: label, actions: [{ tool, arguments: args }] }, snapshot, agentInput(ctx, message), creating ? 'create' : 'modify', { maxShots: 120 });
  if (!plan.candidate || !plan.mutated) return { content: '计划没有产生修改。' };
  const sources = Object.fromEntries(plan.sources.map(item => [item.shotId, item.source]));
  const next = await ctx.port.commit(ctx.projectId, snapshot.project?.revision ?? 0, plan.candidate, sources, '智能体：' + label);
  return { content: json({ ok: true, revision: next.project?.revision, project: summarizeProject(next.project) }), revision: next.project?.revision };
}

const ids = (value: unknown) => Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 8) : [];
async function anchored(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const prompt = need(args, 'prompt'); const story = await ctx.docs.story();
  const hasContext = story.status === 'approved' || story.characters.length || (story.locations?.length ?? 0) > 0 || (story.props?.length ?? 0) > 0;
  return (prompt + anchorPrompt(hasContext ? story : null, ids(args.characterIds), {
    shotId: typeof args.shotId === 'string' ? args.shotId : undefined,
    locationId: typeof args.locationId === 'string' ? args.locationId : undefined,
    propIds: ids(args.propIds),
  })).slice(0, 4000);
}
function keyframes(project: VideoProject): { frame: number; shotId: string }[] {
  let start = 0; const frames: { frame: number; shotId: string }[] = [];
  for (const id of project.shotOrder.length ? project.shotOrder : project.shots.map(s => s.id)) { const shot = project.shots.find(s => s.id === id); if (!shot) continue; frames.push({ frame: start + Math.floor(shot.durationFrames / 2), shotId: id }); start += shot.durationFrames; }
  return frames;
}
function multiSampleFrames(project: VideoProject, maxFrames = 18): { frame: number; shotId: string }[] {
  let start = 0; const points: { frame: number; shotId: string }[] = [];
  for (const id of project.shotOrder.length ? project.shotOrder : project.shots.map(s => s.id)) {
    const shot = project.shots.find(s => s.id === id); if (!shot || shot.durationFrames < 1) continue;
    for (const local of new Set([0, Math.floor((shot.durationFrames - 1) / 2), shot.durationFrames - 1])) points.push({ frame: start + local, shotId: id });
    start += shot.durationFrames;
  }
  if (points.length <= maxFrames) return points;
  return Array.from({ length: maxFrames }, (_, i) => points[Math.floor(i * (points.length - 1) / Math.max(1, maxFrames - 1))]!);
}
function visualFrames(project: VideoProject, shotIds: unknown, maxFrames = 3) {
  const wanted = Array.isArray(shotIds) ? new Set(shotIds) : null;
  const matches = keyframes(project).filter(frame => !wanted || wanted.has(frame.shotId));
  let selected = matches;
  if (matches.length > maxFrames) {
    if (maxFrames === 3) selected = [matches[0]!, matches[Math.floor(matches.length / 2)]!, matches.at(-1)!];
    else selected = Array.from({ length: maxFrames }, (_, i) => matches[Math.floor(i * (matches.length - 1) / Math.max(1, maxFrames - 1))]!);
  }
  return { selected, uncheckedShotIds: matches.filter(frame => !selected.includes(frame)).map(frame => frame.shotId) };
}

/**
 * Sequential dialogue layout & duration alignment:
 * - Single voice clip in a shot → starts at 0s, shot duration = voice + pad.
 * - Multiple voice clips in the same shot → laid out sequentially with `interLineGapSeconds` (unless intentional overlap), preventing 0s stacking!
 */
export function alignToVoice(
  project: VideoProject,
  pad: number,
  wanted: Set<string> | null,
  options: { interLineGapSeconds?: number; syncSubtitles?: boolean } = {},
): { shotId: string; fromSeconds: number; toSeconds: number }[] {
  const fps = project.target.fps.num / project.target.fps.den;
  const gap = Number.isFinite(options.interLineGapSeconds) ? Math.max(0, Math.min(3, Number(options.interLineGapSeconds))) : 0.2;
  const changes: { shotId: string; fromSeconds: number; toSeconds: number }[] = [];
  let globalShotCursorSec = 0;
  const order = project.shotOrder.length ? project.shotOrder : project.shots.map(s => s.id);
  const generatedSubtitles: SubtitleCue[] = [];

  for (const sid of order) {
    const shot = project.shots.find(s => s.id === sid);
    if (!shot) continue;
    const prevShotSec = shot.durationFrames / fps;
    if (wanted && !wanted.has(shot.id)) {
      globalShotCursorSec += prevShotSec;
      continue;
    }
    const voices = (project.audioClips ?? []).filter(c => c.role === 'voice' && c.shotId === shot.id);
    let cursor = 0;
    let validCount = 0;
    for (const clip of voices) {
      const asset = project.assets.find(a => a.id === clip.assetId);
      if (!asset?.duration) continue;
      const clipLen = Math.max(0.05, Math.min(clip.trimEnd ?? asset.duration, asset.duration) - clip.trimStart);
      if (validCount > 0) cursor = Math.round((cursor + gap) * 1000) / 1000;
      clip.startSeconds = cursor;
      if (options.syncSubtitles) {
        const text = (asset.description && !asset.description.startsWith('由 ') ? asset.description : '') || shot.narration || shot.params.subtitle || '';
        if (text.trim()) {
          generatedSubtitles.push({
            id: `sub-${clip.id}`,
            shotId: shot.id,
            ...(clip.speaker ? { speaker: clip.speaker } : {}),
            startSeconds: Math.round((globalShotCursorSec + cursor) * 1000) / 1000,
            endSeconds: Math.round((globalShotCursorSec + cursor + clipLen) * 1000) / 1000,
            text: text.trim(),
          });
        }
      }
      cursor = Math.round((cursor + clipLen) * 1000) / 1000;
      validCount++;
    }
    if (validCount > 0) {
      const frames = Math.max(1, Math.ceil((cursor + pad) * fps));
      if (frames !== shot.durationFrames) {
        changes.push({ shotId: shot.id, fromSeconds: Math.round(shot.durationFrames / fps * 100) / 100, toSeconds: Math.round(frames / fps * 100) / 100 });
        shot.durationFrames = frames;
      }
    }
    globalShotCursorSec += shot.durationFrames / fps;
  }
  if (changes.length) project.targetDuration = Math.round(project.shots.reduce((s, x) => s + x.durationFrames, 0) / fps * 100) / 100;
  if (options.syncSubtitles && generatedSubtitles.length) {
    const untouched = (project.subtitles ?? []).filter(c => !c.shotId || (wanted && !wanted.has(c.shotId)));
    project.subtitles = [...untouched, ...generatedSubtitles].sort((a, b) => a.startSeconds - b.startSeconds);
  }
  return changes;
}

/** Unified pre-export quality check: Schema v3 production composition + DirectorDocument integrity + multi-frame pixel luma + optional acoustic loudness check. */
export async function qualityCheck(ctx: ToolContext): Promise<QcReport> {
  const project = (await ctx.port.snapshot(ctx.projectId)).project; if (!project) throw new Error('没有打开的工程');
  const story: Story = await ctx.docs.story();
  const issues: QcIssue[] = dataChecks(project, story);
  const unchecked: string[] = [];

  // 1. Align with Schema v3 ProductionPolicy & DirectorDocument validation
  if (project.schemaVersion === 3) {
    try { assertProductionComposition(project, { forExport: true }); }
    catch (error) { issues.push({ check: 'consistency', severity: 'high', message: '制作策略校验未通过：' + (error instanceof Error ? error.message : String(error)) }); }
  }
  try {
    const doc = readDirectorDocument(project);
    if (doc?.status === 'approved') {
      for (const s of doc.plan.shots) {
        if (!project.shots.some(ps => ps.id === s.shotId)) issues.push({ check: 'consistency', severity: 'high', shotId: s.shotId, message: `已批准导演计划引用的镜头 ${s.shotId} 已不存在` });
      }
    }
  } catch (error) {
    issues.push({ check: 'consistency', severity: 'high', message: error instanceof Error ? error.message : String(error) });
  }

  // 2. Sample frames across shots (start/mid/end up to 18 frames when multi-shot, or per-shot keyframes)
  const samples = project.shots.length <= 4 ? keyframes(project) : multiSampleFrames(project, 18);
  const reportedBlackShots = new Set<string>();
  for (const f of samples) {
    ctx.signal.throwIfAborted();
    try {
      const shot = await ctx.port.capture(ctx.projectId, f.frame, ctx.signal);
      const luma = shot.mime === 'image/png' ? pngLuma(shot.bytes) : null;
      if (!luma) { unchecked.push(`${f.shotId}@${f.frame}：画面格式无法分析`); continue; }
      const issue = frameIssue(f.shotId, luma);
      if (issue && !reportedBlackShots.has(`${f.shotId}:${issue.severity}`)) {
        reportedBlackShots.add(`${f.shotId}:${issue.severity}`);
        issues.push(issue);
      }
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      unchecked.push(`${f.shotId}@${f.frame}：截帧失败（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  // 3. Acoustic waveform & loudness check when FFmpeg audio analysis route is available and mixed audio exists
  if (project.target.audioMode === 'mixed' && ((project.audioClips?.length ?? 0) > 0 || (project.videoClips ?? []).some(c => c.audio === 'keep'))) {
    try {
      const res = await ctx.port.route('audio.analyze', { projectId: ctx.projectId });
      if (res.ok && res.value && typeof res.value === 'object') {
        const ac = res.value as { clippingRisk?: boolean; tooQuiet?: boolean; truePeakDbtp?: number | null; integratedLufs?: number | null };
        if (ac.clippingRisk) issues.push({ check: 'silence', severity: 'medium', message: `混音峰值过高（${ac.truePeakDbtp} dBFS），存在爆音削波风险；建议调 audio_mix_master 开启响度限制` });
        if (ac.tooQuiet) issues.push({ check: 'silence', severity: 'medium', message: `混音整体响度过低（${ac.integratedLufs} LUFS），建议调高音量或启用 targetLufs: -14` });
      }
    } catch { /* Host mock environments without audio.analyze remain unaffected */ }
  }

  const status = qcStatus(issues, unchecked);
  const report: QcReport = { status, pass: status === 'pass', checkedAt: new Date().toISOString(), revision: project.revision, issues, unchecked };
  await ctx.docs.saveQc(report);
  return report;
}

export function createTools(): AgentTool[] {
  const tools: AgentTool[] = [
    // ==================== 1. 感知、环境与拉片拆解 ====================
    { name: 'project_get', risk: 'read', description: '读取当前工程完整摘要：版本号、镜头（含转场/调色/参数/候选条）、素材（含时长/分辨率）、视频片段、音轨明细（含 clipId）、画中画、字幕与制作策略。修改前必调。', parameters: object({}),
      async run(_args, ctx) { const snapshot = await ctx.port.snapshot(ctx.projectId); return { content: json({ ...summarizeProject(snapshot.project), task: snapshot.task ? { kind: snapshot.task.kind, status: snapshot.task.status, message: snapshot.task.message } : null }), revision: snapshot.project?.revision }; } },
    { name: 'bible_get', risk: 'read', description: '读取统一制片圣经（剧本梗概、视觉风格、角色库、固定场景母版库 Locations、道具库 Props、三维世界布局、戏剧节拍、场记连续性与分镜表）。', parameters: object({}),
      async run(_args, ctx) {
        const [story, snap] = await Promise.all([ctx.docs.story(), ctx.port.snapshot(ctx.projectId)]);
        let directorDoc = null;
        if (snap.project) { try { directorDoc = readDirectorDocument(snap.project) ?? null; } catch { directorDoc = null; } }
        return { content: json({ story, directorDocument: directorDoc ? { version: directorDoc.version, status: directorDoc.status, hash: directorDoc.hash } : null, productionPolicy: snap.project?.productionPolicy ?? null }) };
      } },
    { name: 'story_get', risk: 'read', description: '读取创作计划与制片圣经摘要（剧本、风格、角色库、场景库、道具库、分镜表、一致性分数）。', parameters: object({}),
      async run(_args, ctx) { return { content: json(await ctx.docs.story()) }; } },
    { name: 'shot_read_source', risk: 'read', description: '读取一个镜头的 HTML/CSS/JS 源码。', parameters: object({ shotId: str('镜头 ID') }, ['shotId']),
      async run(args, ctx) { return { content: json(await ctx.port.readSource(ctx.projectId, need(args, 'shotId'))) }; } },
    { name: 'env_check', risk: 'read', description: '检查本机 Chrome/FFmpeg/ffprobe/Blender 是否可用（渲染、声学质检、导出与 3D 白模预演所需）。', parameters: object({}),
      async run(_args, ctx) { const { environment } = await ctx.port.snapshot(ctx.projectId); const e = environment as unknown as Record<string, unknown>; return { content: json({ browserAvailable: e.browserAvailable, ffmpegAvailable: e.ffmpegAvailable, ffprobeAvailable: e.ffprobeAvailable, blenderAvailable: Boolean(e.blenderAvailable) }) }; } },
    { name: 'task_status', risk: 'read', description: '查询媒体生成任务或协作流程的状态。', parameters: object({ kind: { type: 'string', enum: ['media', 'workflow'] }, id: str('任务 ID') }, ['kind', 'id']),
      async run(args, ctx) { const value = await rpc(ctx, args.kind === 'workflow' ? 'workflows.get' : 'media.get', args.kind === 'workflow' ? { workflowId: need(args, 'id') } : { taskId: need(args, 'id') }); return { content: json(value) }; } },
    { name: 'styles_list', risk: 'read', description: '列出用户保存的视频风格库。', parameters: object({}),
      async run(_args, ctx) { const result = await rpc(ctx, 'styles.list', {}); return { content: json(result) }; } },
    { name: 'skill_read', risk: 'read', description: '读取导演与剧组专业工艺技能文档（按主题）：' + skillIndex() + '。', parameters: object({ topic: { type: 'string', enum: Object.keys(SKILLS) } }, ['topic']),
      async run(args) { const skill = SKILLS[String(args.topic)]; if (!skill) throw new Error('未知主题；可选：' + Object.keys(SKILLS).join(', ')); return { content: `# ${skill.title}\n${skill.body}` }; } },
    { name: 'analyze_reference_video', risk: 'read', description: '视觉拉片拆解：使用 FFmpeg scdet 与 ffprobe 自动识别工程内参考视频素材的镜头切点、单镜时长分布、平均镜长（ASL）与剪辑节奏类型。',
      parameters: object({ assetId: str('已导入工程的视频素材 ID'), threshold: num('可选：切镜检测灵敏度阈值 4–40，默认 12') }, ['assetId']),
      async run(args, ctx) { const value = await rpc(ctx, 'media.deconstruct', { assetId: need(args, 'assetId'), ...(args.threshold !== undefined ? { threshold: Number(args.threshold) } : {}) }); return { content: json(value) }; } },

    // ==================== 2. 制片圣经、策略与分镜规划（Plan & Bible） ====================
    { name: 'request_production_policy', risk: 'plan', description: '向用户申请设定或更新本工程的 Schema v3 制作策略（code_animation 纯代码动效 / model_video 模型视频 / hybrid 混合授权，以及是否允许生图和导入视频）。需用户批准。',
      parameters: object({
        expectedRevision: int('当前工程版本'),
        mode: { type: 'string', enum: ['code_animation', 'model_video', 'hybrid'], description: '主制作模式' },
        baseMode: { type: 'string', enum: ['code_animation', 'model_video'], description: 'hybrid 模式下的默认基础方式' },
        allowGeneratedImages: bool('是否允许生成图片素材'),
        allowImportedVideo: bool('是否允许使用导入视频'),
        hybridShotIds: { type: 'array', items: { type: 'string' }, description: 'hybrid 模式下特批跨模式操作的镜头 ID 列表' },
      }, ['expectedRevision', 'mode']),
      async run(args, ctx) {
        const snap = await ctx.port.snapshot(ctx.projectId); if (!snap.project) throw new Error('没有打开的工程');
        const expected = revision(args); if (expected !== snap.project.revision) throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' });
        const mode = need(args, 'mode') as ProductionMode;
        const base = defaultProductionPolicy(mode);
        const policy = {
          ...base,
          allowGeneratedImages: args.allowGeneratedImages !== false,
          allowImportedVideo: args.allowImportedVideo !== false,
          ...(mode === 'hybrid' ? { baseMode: (args.baseMode === 'model_video' ? 'model_video' : 'code_animation') as 'code_animation' | 'model_video' } : {}),
          ...(mode === 'hybrid' && Array.isArray(args.hybridShotIds) && args.hybridShotIds.length ? {
            hybridGrants: [{ id: randomUUID(), projectId: snap.project.id, shotIds: args.hybridShotIds.map(String), operations: ['code', 'video'] as ('code' | 'video')[], confirmedAt: new Date().toISOString() }],
          } : {}),
        };
        const applied = applyProductionPolicy(snap.project, policy);
        applied.revision = snap.project.revision;
        const committed = await ctx.port.commit(ctx.projectId, expected, applied, {}, '智能体：经用户批准更新制作策略');
        return { content: json({ ok: true, revision: committed.project?.revision, productionPolicy: committed.project?.productionPolicy }), revision: committed.project?.revision };
      } },
    { name: 'plan_story', risk: 'plan', description: '提交（或更新）制片圣经的剧作与设定层：片型、标题、梗概、目标时长、美术风格、角色库、场景母版库（locations）、关键道具库（props）与三维世界布局（worldLayouts）。默认需用户审批。',
      parameters: object({
        filmKind: { type: 'string', enum: ['general', 'suspense_short', 'product', 'explainer', 'lyrical'], description: '可选：影片类型' },
        title: str('标题'), logline: str('一句话梗概与戏剧核心'), targetSeconds: num('目标总时长（秒）'),
        style: object({ look: str('画风'), palette: str('配色'), typography: str('字体'), motion: str('运动风格'), negative: str('避免的元素') }),
        characters: { type: 'array', items: object({ id: str('角色 ID，如 hero'), name: str('名字'), description: str('身份与性格描述'), objective: str('可选：角色动机'), features: { type: 'array', items: { type: 'string' } }, voice: str('专属音色 ID，如 alloy / nova / echo') }, ['name']) },
        locations: { type: 'array', description: '可选：固定场景母版库', items: object({ id: str('场景 ID'), name: str('场景名称'), setting: { type: 'string', enum: ['INT', 'EXT', 'INT/EXT'] }, timeOfDay: { type: 'string', enum: ['DAY', 'NIGHT', 'DAWN', 'DUSK'] }, description: str('空间陈设与建筑细节'), lightingMood: str('光影色温基调') }, ['name']) },
        props: { type: 'array', description: '可选：关键叙事道具库', items: object({ id: str('道具 ID'), name: str('道具名称'), description: str('外观材质细节'), ownerCharacterId: str('可选：持有角色 ID') }, ['name']) },
        worldLayouts: { type: 'array', description: '可选：三维世界坐标锚点布局', items: object({ id: str('布局 ID'), description: str('空间关系描述'), anchors: { type: 'array', items: object({ id: str('锚点 ID'), position: { type: 'array', items: { type: 'number' } } }, ['id', 'position']) } }, ['id', 'description', 'anchors']) },
      }, ['title', 'logline', 'style']),
      async run(args, ctx) {
        const title = need(args, 'title').slice(0, 80), logline = need(args, 'logline').slice(0, 1200), style = normalizeStyle(args.style);
        const incoming = Array.isArray(args.characters) ? args.characters.slice(0, 30).map(normalizeCharacter) : [];
        const incomingLocs = Array.isArray(args.locations) ? args.locations.slice(0, 30).map(normalizeLocation) : undefined;
        const incomingProps = Array.isArray(args.props) ? args.props.slice(0, 40).map(normalizeProp) : undefined;
        const target = Number(args.targetSeconds);
        const filmKind = ['general', 'suspense_short', 'product', 'explainer', 'lyrical'].includes(String(args.filmKind)) ? String(args.filmKind) as Story['filmKind'] : undefined;
        const story = await ctx.docs.updateStory(current => {
          const characters = incoming.map(c => { const old = current.characters.find(o => o.id === c.id); return old ? { ...c, referenceAssetIds: c.referenceAssetIds.length ? c.referenceAssetIds : old.referenceAssetIds } : c; });
          const kept = current.characters.filter(c => !characters.some(n => n.id === c.id) && current.shots.some(s => s.characters.includes(c.id)));
          const locations = incomingLocs ? incomingLocs.map(l => { const old = (current.locations ?? []).find(o => o.id === l.id); return old ? { ...l, referenceAssetIds: l.referenceAssetIds?.length ? l.referenceAssetIds : old.referenceAssetIds } : l; }) : current.locations;
          const props = incomingProps ? incomingProps.map(p => { const old = (current.props ?? []).find(o => o.id === p.id); return old ? { ...p, referenceAssetIds: p.referenceAssetIds?.length ? p.referenceAssetIds : old.referenceAssetIds } : p; }) : current.props;
          return {
            ...current,
            ...(filmKind ? { filmKind } : {}),
            title, logline,
            targetSeconds: Number.isFinite(target) && target > 0 ? Math.min(target, 3600) : current.targetSeconds,
            style,
            characters: [...characters, ...kept],
            ...(locations ? { locations } : {}),
            ...(props ? { props } : {}),
            ...(Array.isArray(args.worldLayouts) ? { worldLayouts: args.worldLayouts as Story['worldLayouts'] } : {}),
            status: 'approved',
            approvedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        });
        await syncBibleToProject(ctx, story);
        return { content: json({ ok: true, version: story.version, characters: story.characters.map(c => c.id), locations: (story.locations ?? []).map(l => l.id), props: (story.props ?? []).map(p => p.id), next: story.shots.length ? '如需调整分镜，用 plan_shots' : '下一步用 plan_shots 提交分镜表（支持 1–120 镜）' }) };
      } },
    { name: 'plan_shots', risk: 'plan', description: '提交（整体替换）分镜表（支持 1–120 镜）：每镜摘要、景别、运镜、时长、台词、所属场景 locationId、出场角色、道具 propIds、是否承接上一镜尾帧、声音策略与表演节拍。需用户审批并自动同步至导演计划文档。',
      parameters: object({
        storyBeats: { type: 'array', description: '可选：戏剧节拍列表', items: object({ id: str('节拍 ID'), function: str('叙事功能'), change: str('信息或局面变化'), shotIds: { type: 'array', items: { type: 'string' } } }, ['id', 'function', 'change', 'shotIds']) },
        shots: { type: 'array', items: object({
          id: str('分镜 ID'), shotId: str('对应工程镜头 ID（已有时）'), summary: str('画面与情节'), shotType: str('景别：远/全/中/近/特写'),
          camera: str('运镜与焦距'), durationSeconds: num('时长秒数'), dialogue: str('台词/旁白'),
          locationId: str('可选：所属场景母版 ID'), propIds: { type: 'array', items: { type: 'string' } },
          characters: { type: 'array', items: { type: 'string' } }, continueFromPrevious: bool('是否承接上一镜尾帧'),
          audioStrategy: { type: 'string', enum: ['native', 'external', 'silent'] },
        }, ['summary', 'durationSeconds']) },
      }, ['shots']),
      async run(args, ctx) {
        const story = await ctx.docs.updateStory(current => {
          if (!current.title) throw new Error('先用 plan_story 提交剧本与风格');
          const shots = normalizeShots(args.shots, current.characters, current.locations ?? [], current.props ?? []);
          return {
            ...current,
            shots,
            ...(Array.isArray(args.storyBeats) ? { storyBeats: args.storyBeats as Story['storyBeats'] } : {}),
            consistency: Object.fromEntries(Object.entries(current.consistency).filter(([k]) => shots.some(s => (s.shotId ?? s.id) === k))),
            status: 'approved',
            approvedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        });
        await syncBibleToProject(ctx, story);
        return { content: json({ ok: true, version: story.version, shots: story.shots.length, totalSeconds: story.shots.reduce((s, x) => s + x.durationSeconds, 0) }) };
      } },
    { name: 'bible_save_plan', risk: 'plan', description: '直接保存并批准完整专业版 DirectorPlan（含逐拍表演 PerformanceBeat、精确对白/抢话事件 DialogueEvent、三维世界锚点 WorldLayout、屏幕坐标事件 ShotEvent 与验收条件），双向同步制片圣经。',
      parameters: object({ expectedRevision: int('当前工程版本'), plan: { type: 'object', description: '符合 DirectorPlan v1 规范的完整计划对象' } }, ['expectedRevision', 'plan']),
      async run(args, ctx) {
        const snap = await ctx.port.snapshot(ctx.projectId); if (!snap.project) throw new Error('没有打开的工程');
        const expected = revision(args); if (expected !== snap.project.revision) throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' });
        let curDoc; try { curDoc = readDirectorDocument(snap.project); } catch { curDoc = undefined; }
        const draft = saveDirectorDocument(snap.project, args.plan, { expectedVersion: curDoc?.version ?? 0 });
        const withDraft = structuredClone(snap.project);
        withDraft.extensions = { ...withDraft.extensions, directorDocument: draft };
        const approved = approveDirectorDocument(withDraft, { expectedVersion: draft.version, expectedHash: draft.hash });
        withDraft.extensions = { ...withDraft.extensions, directorDocument: approved };
        const committed = await ctx.port.commit(ctx.projectId, expected, withDraft, {}, '智能体：批准完整专业导演计划文档');
        await ctx.docs.updateStory(current => mergeDirectorPlanIntoStory(approved.plan, current, true));
        return { content: json({ ok: true, revision: committed.project?.revision, documentVersion: approved.version, hash: approved.hash, shots: approved.plan.shots.length }), revision: committed.project?.revision };
      } },

    // ==================== 3. 美术资产库与场记管理（Characters / Locations / Props / Continuity） ====================
    { name: 'character_upsert', risk: 'write', description: '新增或更新角色库中的一个角色（身份动机、可见特征、定妆参考图素材 ID、专属音色 voice）。参考图须是工程内图片素材。',
      parameters: object({ id: str('角色 ID'), name: str('名字'), description: str('描述'), objective: str('可选：戏剧目标'), features: { type: 'array', items: { type: 'string' } }, referenceAssetIds: { type: 'array', items: { type: 'string' } }, voice: str('音色 ID，如 alloy / nova / shimmer / echo') }, ['id', 'name']),
      async run(args, ctx) {
        const snapshot = await ctx.port.snapshot(ctx.projectId); const character = normalizeCharacter(args, 0);
        const bad = character.referenceAssetIds.filter(id => !snapshot.project?.assets.some(a => a.id === id && a.kind === 'image')); if (bad.length) throw new Error('参考图不是工程中的图片素材：' + bad.join(', '));
        const story = await ctx.docs.updateStory(current => ({ ...current, characters: [...current.characters.filter(c => c.id !== character.id), character], updatedAt: new Date().toISOString() }));
        await syncBibleToProject(ctx, story);
        return { content: json({ ok: true, version: story.version, character }) };
      } },
    { name: 'location_upsert', risk: 'write', description: '新增或更新固定场景母版库（Location：内/外景、昼夜、环境建筑陈设、光影基调、空镜母版参考图 ID 与世界布局 ID），保障同场戏背景一致。',
      parameters: object({
        id: str('场景 ID，如 study_room'), name: str('场景名称'),
        setting: { type: 'string', enum: ['INT', 'EXT', 'INT/EXT'] }, timeOfDay: { type: 'string', enum: ['DAY', 'NIGHT', 'DAWN', 'DUSK'] },
        description: str('建筑空间、陈设与材质细节'), lightingMood: str('主辅光方向与色温氛围'),
        referenceAssetIds: { type: 'array', items: { type: 'string' }, description: '工程内场景空镜参考图 ID' },
        worldLayoutId: str('可选：关联的 worldLayouts ID'),
      }, ['id', 'name', 'description']),
      async run(args, ctx) {
        const snapshot = await ctx.port.snapshot(ctx.projectId); const loc = normalizeLocation(args, 0);
        const bad = (loc.referenceAssetIds ?? []).filter(id => !snapshot.project?.assets.some(a => a.id === id && a.kind === 'image')); if (bad.length) throw new Error('场景参考图不是工程中的图片素材：' + bad.join(', '));
        const story = await ctx.docs.updateStory(current => ({ ...current, locations: [...(current.locations ?? []).filter(l => l.id !== loc.id), loc], updatedAt: new Date().toISOString() }));
        await syncBibleToProject(ctx, story);
        return { content: json({ ok: true, version: story.version, location: loc }) };
      } },
    { name: 'prop_upsert', risk: 'write', description: '新增或更新关键叙事道具库（Prop：名称、外观细节、所属角色与参考图素材 ID），保障特写与远景道具一致。',
      parameters: object({ id: str('道具 ID'), name: str('道具名称'), description: str('外观尺寸与材质细节'), ownerCharacterId: str('可选：所属角色 ID'), referenceAssetIds: { type: 'array', items: { type: 'string' } } }, ['id', 'name', 'description']),
      async run(args, ctx) {
        const snapshot = await ctx.port.snapshot(ctx.projectId); const prop = normalizeProp(args, 0);
        const bad = (prop.referenceAssetIds ?? []).filter(id => !snapshot.project?.assets.some(a => a.id === id && a.kind === 'image')); if (bad.length) throw new Error('道具参考图不是工程中的图片素材：' + bad.join(', '));
        const story = await ctx.docs.updateStory(current => ({ ...current, props: [...(current.props ?? []).filter(p => p.id !== prop.id), prop], updatedAt: new Date().toISOString() }));
        await syncBibleToProject(ctx, story);
        return { content: json({ ok: true, version: story.version, prop }) };
      } },
    { name: 'continuity_log_upsert', risk: 'write', description: '记录或更新场记连续性日志（180° 轴线方向、人物服装道具状态、前后镜光影衔接备注）。',
      parameters: object({ shotId: str('镜头 ID'), axis180: str('180° 轴线与人物朝向备注'), wardrobeState: str('服装与持握道具状态'), lightingMatch: str('光影色温衔接说明'), notes: str('其他重拍或场记说明') }, ['shotId']),
      async run(args, ctx) {
        const entry = {
          shotId: need(args, 'shotId'),
          ...(typeof args.axis180 === 'string' ? { axis180: args.axis180.slice(0, 300) } : {}),
          ...(typeof args.wardrobeState === 'string' ? { wardrobeState: args.wardrobeState.slice(0, 300) } : {}),
          ...(typeof args.lightingMatch === 'string' ? { lightingMatch: args.lightingMatch.slice(0, 300) } : {}),
          ...(typeof args.notes === 'string' ? { notes: args.notes.slice(0, 400) } : {}),
          updatedAt: new Date().toISOString(),
        };
        const story = await ctx.docs.updateStory(current => ({ ...current, continuityLog: [...(current.continuityLog ?? []).filter(e => e.shotId !== entry.shotId), entry], updatedAt: entry.updatedAt }));
        return { content: json({ ok: true, version: story.version, entry }) };
      } },
    { name: 'project_set_style', risk: 'write', description: '从风格库选择风格 ID 应用到当前工程（传空字符串清除）。', parameters: object({ expectedRevision: int('当前工程版本'), styleId: str('风格库中的风格 ID') }, ['expectedRevision', 'styleId']),
      async run(args, ctx) {
        const current = await ctx.port.snapshot(ctx.projectId); if (!current.project) throw new Error('没有打开的工程');
        const expected = revision(args); if (expected !== current.project.revision) throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' });
        const styleId = String(args.styleId ?? '').trim();
        const next = structuredClone(current.project);
        if (!styleId) delete next.videoStyle;
        else {
          const { styles } = await rpc(ctx, 'styles.list', {}) as { styles?: StudioSnapshot['styles'] };
          const found = (styles ?? []).find(item => item.id === styleId);
          if (!found) throw new Error('未找到指定风格 ID：' + styleId);
          next.videoStyle = structuredClone(found);
        }
        const committed = await ctx.port.commit(ctx.projectId, expected, next, {}, '智能体：更新工程视频风格');
        return { content: json({ ok: true, revision: committed.project?.revision, videoStyle: committed.project?.videoStyle?.name ?? null }), revision: committed.project?.revision };
      } },

    // ==================== 4. 显式分镜结构、调色转场与场景源码编辑 ====================
    { name: 'shots_mutate', risk: 'write', description: '显式类型的分镜结构编排工具（支持 1–120 镜）：批量建镜替换空/默认分镜（initStoryboard）、追加/插入新镜头（addShots）、删除镜头（deleteShotIds）或重排顺序（shotOrder）。',
      parameters: object({
        expectedRevision: int('当前工程版本'),
        title: str('可选：更新影片标题'), topic: str('可选：更新主题'),
        initStoryboard: { type: 'array', description: '可选：用完整分镜列表初始化工程（1–120 镜）', items: object({
          title: str('镜头标题'), intent: str('叙事意图'), composition: str('构图景别'), action: str('画面动作与运镜'),
          durationSeconds: num('时长秒数'), narration: str('可选：台词/旁白'),
          transition: { type: 'string', enum: [...TRANSITIONS] },
          text: str('可选：画面主标题文字'), subtitle: str('可选：字幕文字'),
        }, ['title', 'durationSeconds']) },
        addShots: { type: 'array', description: '可选：新增插入的镜头列表', items: object({
          afterShotId: str('可选：插在此镜头之后；省略则追加到末尾'),
          title: str('镜头标题'), intent: str('叙事意图'), composition: str('构图'), action: str('动作'),
          durationSeconds: num('时长秒数'), narration: str('可选：旁白'),
          transition: { type: 'string', enum: [...TRANSITIONS] },
          text: str('可选：主标题'), subtitle: str('可选：字幕'),
        }, ['title', 'durationSeconds']) },
        deleteShotIds: { type: 'array', items: { type: 'string' }, description: '可选：要删除的镜头 ID' },
        shotOrder: { type: 'array', items: { type: 'string' }, description: '可选：新的完整镜头播放顺序 ID 数组' },
      }, ['expectedRevision']),
      async run(args, ctx) {
        const snap = await ctx.port.snapshot(ctx.projectId); if (!snap.project) throw new Error('没有打开的工程');
        const expected = revision(args); if (expected !== snap.project.revision) throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' });
        let next = structuredClone(snap.project);
        const sources: Record<string, import('../shared/types.ts').SceneSource> = {};
        if (typeof args.title === 'string' && args.title.trim()) next.title = args.title.trim();
        if (typeof args.topic === 'string') next.topic = args.topic;

        if (Array.isArray(args.initStoryboard) && args.initStoryboard.length) {
          if (args.initStoryboard.length > 120) throw new Error('分镜最多支持 120 个镜头');
          const rawShots = args.initStoryboard as Record<string, unknown>[];
          const normalized = normalizeStoryboard({
            shots: rawShots.map(item => ({
              title: String(item.title ?? '镜头'),
              intent: String(item.intent ?? ''),
              composition: String(item.composition ?? ''),
              action: String(item.action ?? ''),
              durationSeconds: Number(item.durationSeconds ?? 5),
              transition: TRANSITIONS.includes(item.transition as ShotTransition) ? item.transition : 'cut',
              params: { ...(typeof item.text === 'string' ? { text: item.text } : {}), ...(typeof item.subtitle === 'string' ? { subtitle: item.subtitle } : {}) },
            })),
          }, next);
          normalized.forEach((shot, idx) => {
            const raw = rawShots[idx]!;
            if (TRANSITIONS.includes(raw.transition as ShotTransition)) shot.transition = raw.transition as ShotTransition;
            if (typeof raw.narration === 'string') shot.narration = raw.narration;
            next.graph.positions[shot.id] = [420 + idx * 340, 160];
            sources[shot.id] = defaultSceneSource();
          });
          next.shots = normalized;
          next.shotOrder = normalized.map(s => s.id);
          next.targetDuration = Math.round(rawShots.reduce((sum, s) => sum + Math.max(0.5, Number(s.durationSeconds ?? 5)), 0) * 100) / 100;
          delete next.extensions.graphEdges;
        }

        for (const raw of (Array.isArray(args.addShots) ? args.addShots as Record<string, unknown>[] : [])) {
          const sec = Math.max(0.5, Math.min(600, Number(raw.durationSeconds ?? 5)));
          const built = normalizeStoryboard({ shots: [{ title: String(raw.title ?? '新增镜头'), intent: String(raw.intent ?? ''), composition: String(raw.composition ?? ''), action: String(raw.action ?? ''), durationSeconds: sec, params: { ...(typeof raw.text === 'string' ? { text: raw.text } : {}), ...(typeof raw.subtitle === 'string' ? { subtitle: raw.subtitle } : {}) } }] }, { ...next, targetDuration: sec })[0]!;
          if (TRANSITIONS.includes(raw.transition as ShotTransition)) built.transition = raw.transition as ShotTransition;
          if (typeof raw.narration === 'string') built.narration = raw.narration;
          next = addShot(next, built, typeof raw.afterShotId === 'string' && raw.afterShotId ? raw.afterShotId : undefined);
          sources[built.id] = defaultSceneSource();
        }

        for (const delId of (Array.isArray(args.deleteShotIds) ? args.deleteShotIds.map(String) : [])) {
          next = deleteShot(next, delId);
          delete sources[delId];
        }

        if (Array.isArray(args.shotOrder) && args.shotOrder.length) {
          next = reorderShots(next, args.shotOrder.map(String));
        }

        if (!next.shots.length || next.shots.length > 120) throw new Error('提交后镜头数须在 1–120 之间');
        if (next.schemaVersion === 3 && next.productionPolicy) {
          const revKeep = next.revision;
          next = applyProductionPolicy(next, next.productionPolicy);
          next.revision = revKeep;
        }
        next.graph.positions['film-output'] = [420 + next.shots.length * 340, 160];
        const committed = await ctx.port.commit(ctx.projectId, expected, next, sources, '智能体：编排分镜结构');
        return { content: json({ ok: true, revision: committed.project?.revision, shotIds: committed.project?.shotOrder }), revision: committed.project?.revision };
      } },
    { name: 'shot_patch', risk: 'write', description: '批量修改一个或多个镜头的属性、时长、高级转场（cut / fade / dissolve 双镜叠化 / wipe_left 擦除 / flash_white 闪白）、逐镜头调色（colorGrade：曝光/对比度/饱和度/色温/色调/暗角）、排版参数与资产绑定。',
      parameters: object({
        expectedRevision: int('当前工程版本'),
        patches: { type: 'array', items: object({
          shotId: str('镜头 ID'),
          title: str('可选：镜头标题'), intent: str('可选：意图'), composition: str('可选：构图'), action: str('可选：动作'), narration: str('可选：台词旁白'),
          durationSeconds: num('可选：时长秒数'),
          transition: { type: 'string', enum: [...TRANSITIONS], description: '可选：切入转场类型（dissolve 为真实双镜头叠化）' },
          transitionFrames: int('可选：转场持续帧数'),
          colorGrade: object({
            exposure: num('曝光 -2 至 2，默认 0'), contrast: num('对比度 0.2 至 3，默认 1'),
            saturation: num('饱和度 0 至 3，默认 1'), temperature: num('色温 -100(冷蓝) 至 100(暖黄)，默认 0'),
            tint: num('色调 -100 至 100，默认 0'), vignette: num('暗角强度 0 至 1，默认 0'),
          }),
          assetIds: { type: 'array', items: { type: 'string' } },
          referenceIds: { type: 'array', items: { type: 'string' } },
          params: { type: 'object', description: '可选：部分更新 params（如 text/subtitle/background/foreground/accent/fontSize/motion）' },
        }, ['shotId']) },
      }, ['expectedRevision', 'patches']),
      async run(args, ctx) {
        const snap = await ctx.port.snapshot(ctx.projectId); if (!snap.project) throw new Error('没有打开的工程');
        const expected = revision(args); if (expected !== snap.project.revision) throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' });
        const patches = Array.isArray(args.patches) ? args.patches as Record<string, unknown>[] : [];
        if (!patches.length) throw new Error('patches 不能为空');
        let next = structuredClone(snap.project);
        const fps = next.target.fps.num / next.target.fps.den;
        for (const item of patches) {
          const sid = need(item, 'shotId');
          const cur = next.shots.find(s => s.id === sid);
          if (!cur) throw new Error('找不到镜头：' + sid);
          const patch: Partial<Shot> = {};
          for (const k of ['title', 'intent', 'composition', 'action', 'narration'] as const) if (typeof item[k] === 'string') patch[k] = item[k] as string;
          if (typeof item.durationSeconds === 'number' && item.durationSeconds > 0) patch.durationFrames = Math.max(1, Math.round(item.durationSeconds * fps));
          if (TRANSITIONS.includes(item.transition as ShotTransition)) patch.transition = item.transition as ShotTransition;
          if (Number.isInteger(item.transitionFrames)) patch.transitionFrames = Number(item.transitionFrames);
          if (item.colorGrade && typeof item.colorGrade === 'object') patch.colorGrade = { ...(cur.colorGrade ?? {}), ...(item.colorGrade as ShotColorGrade) };
          if (Array.isArray(item.assetIds)) patch.assetIds = item.assetIds.map(String);
          if (Array.isArray(item.referenceIds)) patch.referenceIds = item.referenceIds.map(String);
          if (item.params && typeof item.params === 'object' && !Array.isArray(item.params)) patch.params = { ...cur.params, ...(item.params as Shot['params']) };
          next = updateShot(next, sid, patch);
        }
        const committed = await ctx.port.commit(ctx.projectId, expected, next, {}, '智能体：更新镜头属性与调色转场');
        return { content: json({ ok: true, revision: committed.project?.revision, updatedCount: patches.length }), revision: committed.project?.revision };
      } },
    { name: 'video_update', risk: 'write', description: '兼容导演协议的通用分镜更新（支持 1–120 镜）：修改标题/时长/规格、增删重排镜头、替换源码。优先推荐使用类型更清晰的 shots_mutate 与 shot_patch。',
      parameters: object({ expectedRevision: int('当前工程版本'), update: { type: 'object', description: '导演协议 update 对象' }, structural: bool('是否增删或重排镜头'), label: str('本次修改的简短说明') }, ['expectedRevision', 'update']),
      async run(args, ctx) { revision(args); const { structural, label, ...rest } = args; return directorAction(ctx, 'video_update', rest, structural === true, typeof label === 'string' ? label : '修改分镜'); } },
    { name: 'shot_write_source', risk: 'write', description: '保存一个镜头的完整源码 {html,css,js}；保存后会执行场景检查。', parameters: object({ expectedRevision: int('当前工程版本'), shotId: str('镜头 ID'), source: object({ html: str('HTML'), css: str('CSS'), js: str('ES 模块，导出 render(ctx)') }, ['html', 'css', 'js']) }, ['expectedRevision', 'shotId', 'source']),
      async run(args, ctx) {
        const source = args.source as { html: string; css: string; js: string };
        if (!source || [source.html, source.css, source.js].some(part => typeof part !== 'string')) throw new Error('source 须包含 html/css/js 字符串');
        if (source.html.length + source.css.length + source.js.length > 2_000_000) throw new Error('单镜头源码超过 2MB 上限');
        const next = await ctx.port.saveSource(ctx.projectId, need(args, 'shotId'), revision(args), source);
        return { content: json({ ok: true, revision: next.project?.revision }), revision: next.project?.revision };
      } },
    { name: 'delegate_scene_code', risk: 'write', description: '委派专精「场景代码模型（scene 角色）」为指定镜头编写或精修确定性 HTML/CSS/Canvas 动效源码，并自动完成渲染校验与报错自修复，节省总导演上下文。',
      parameters: object({ shotId: str('目标镜头 ID'), instruction: str('本镜头的视觉构图、动态节奏、配色与字幕排版要求') }, ['shotId', 'instruction']),
      async run(args, ctx) {
        if (!ctx.port.generateSceneCode) throw new Error('当前环境未配置场景代码委派接口，请使用 shot_write_source');
        const res = await ctx.port.generateSceneCode(ctx.projectId, need(args, 'shotId'), need(args, 'instruction'), ctx.signal);
        return { content: json({ ok: true, ...res }), revision: res.revision };
      } },
    { name: 'delegate_crew', risk: 'write', description: '向虚拟影视剧组的六大专业子智能体委派专项任务（隔离局部上下文，自动推进多步只读分析与工程精修）：screenwriter(剧作拉片) / art_director(美术设定) / cinematographer(3D摄影预演) / scene_coder(动态图形代码) / sound_director(声音混音) / post_editor_qc(精剪调色与质检)。',
      parameters: object({
        department: { type: 'string', enum: Object.keys(CREW_SPECS), description: '目标剧组部门' },
        task: str('明确的专项任务指令与验收标准'),
        shotIds: { type: 'array', items: { type: 'string' }, description: '可选：限定处理的镜头 ID 范围' },
      }, ['department', 'task']),
      async run(args, ctx) {
        if (!ctx.delegateCrew) throw new Error('当前运行上下文未启用子代理委派');
        return ctx.delegateCrew(need(args, 'department') as CrewDepartment, need(args, 'task'), Array.isArray(args.shotIds) ? args.shotIds.map(String) : undefined);
      } },

    // ==================== 5. Blender 3D 预演（关节姿态 + 走位 + 景深 + Z-Depth） ====================
    { name: 'blender_render_previz', risk: 'write', requires: ['blender'], description: '使用本机 Blender 搭建确定性 3D 预演场景（支持人物关节姿态 pose、走位轨迹 position→endPos、焦距与景深 fStop、5 种电影布光），无头渲染白模关键帧 PNG、Z-Depth 空间深度图与动态预演 MP4。审阅后推荐经 stylize_keyframe 转为正式画风首尾帧。',
      parameters: object({
        shotId: str('可选：关联的工程镜头 ID 或分镜 ID'), name: str('预演名称，如 镜头1·雨夜书房对峙'),
        output: { type: 'string', enum: ['image', 'video', 'both'], description: '产出类型：image / video / both(默认)' },
        emitDepth: bool('是否同步输出归一化 Z-Depth 空间深度图（默认 true）'),
        bindPreviewClip: bool('若生成了预演 MP4 且非 Schema v3，是否临时挂入预览（默认 false）'),
        width: int('画面宽度，默认 960'), height: int('画面高度，默认 540'), fps: int('预演帧率，默认 12'), durationSeconds: num('预演时长秒数，默认 3'),
        lighting: { type: 'string', enum: ['three_point', 'daylight', 'noir_rim', 'neon_night', 'golden_hour'], description: '电影布光预设' },
        background: str('背景色 #RRGGBB'),
        camera: object({
          lensMm: num('焦距 mm（24 广角 / 35 标准 / 50 中近 / 85 特写）'),
          fStop: num('可选：光圈景深 f-stop，如 1.8 / 2.8 / 5.6'), focusDistance: num('可选：对焦距离（米）'),
          rollDeg: num('可选：荷兰倾斜角（度）'),
          startPos: { type: 'array', items: { type: 'number' }, description: '起点机位 [x,y,z]' },
          endPos: { type: 'array', items: { type: 'number' }, description: '终点机位 [x,y,z]（推拉摇移）' },
          startTarget: { type: 'array', items: { type: 'number' }, description: '起点注视点 [x,y,z]' },
          endTarget: { type: 'array', items: { type: 'number' }, description: '终点注视点 [x,y,z]' },
        }, ['startPos', 'startTarget']),
        objects: { type: 'array', description: '3D 场景物体与演员清单', items: object({
          id: str('物体/角色 ID'), kind: { type: 'string', enum: ['character', 'box', 'cylinder', 'sphere', 'plane'] },
          position: { type: 'array', items: { type: 'number' }, description: '起始坐标 [x,y,z]' },
          endPos: { type: 'array', items: { type: 'number' }, description: '可选：角色/物体终点走位坐标 [x,y,z]' },
          scale: { type: 'array', items: { type: 'number' } },
          height: num('角色身高（米），默认 1.72'), facingDeg: num('起始朝向角（0°朝+Y，180°面向-Y相机）'), endFacingDeg: num('可选：结束朝向角'),
          pose: { type: 'string', enum: ['stand', 'walk', 'run', 'sit', 'point', 'crouch'], description: '角色关节姿态' },
          color: str('#RRGGBB'),
        }, ['id', 'kind', 'position']) },
        note: str('本镜头的构图、景别、走位与 180° 轴线说明'),
      }, ['camera', 'objects']),
      async run(args, ctx) {
        if (!ctx.port.renderPreviz) throw new Error('当前环境未接入 Blender 白模预演执行器');
        const spec: import('../host/blender.ts').PrevizSceneSpec = {
          output: (args.output === 'image' || args.output === 'video' || args.output === 'both' ? args.output : 'both'),
          ...(args.emitDepth !== undefined ? { emitDepth: Boolean(args.emitDepth) } : {}),
          ...(args.width !== undefined ? { width: Number(args.width) } : {}),
          ...(args.height !== undefined ? { height: Number(args.height) } : {}),
          ...(args.fps !== undefined ? { fps: Number(args.fps) } : {}),
          ...(args.durationSeconds !== undefined ? { durationSeconds: Number(args.durationSeconds) } : {}),
          ...(typeof args.lighting === 'string' ? { lighting: args.lighting as import('../host/blender.ts').PrevizLighting } : {}),
          ...(typeof args.background === 'string' && args.background ? { background: args.background } : {}),
          camera: args.camera as import('../host/blender.ts').PrevizCameraSpec,
          objects: args.objects as import('../host/blender.ts').PrevizObjectSpec[],
        };
        const shotId = typeof args.shotId === 'string' && args.shotId.trim() ? args.shotId.trim() : undefined;
        const rendered = await ctx.port.renderPreviz(ctx.projectId, spec, { shotId, name: typeof args.name === 'string' ? args.name : undefined, bindPreviewClip: args.bindPreviewClip === true, signal: ctx.signal });
        if (shotId) {
          await ctx.docs.updateStory(current => {
            const matched = current.shots.some(s => s.id === shotId || s.shotId === shotId);
            if (!matched) return current;
            return {
              ...current,
              updatedAt: new Date().toISOString(),
              shots: current.shots.map(s => (s.id === shotId || s.shotId === shotId) ? {
                ...s,
                previz: {
                  status: 'rendered',
                  imageAssetId: rendered.imageAssetId,
                  ...(rendered.depthAssetId ? { depthAssetId: rendered.depthAssetId } : {}),
                  ...(rendered.videoAssetId ? { videoAssetId: rendered.videoAssetId } : {}),
                  ...(typeof args.note === 'string' ? { note: args.note.slice(0, 400) } : {}),
                  updatedAt: new Date().toISOString(),
                },
              } : s),
            };
          });
        }
        return {
          content: json({ ok: true, ...rendered, hint: '3D 预演与深度图已导入工程；完成全部预演后请调用 submit_previz_review 提交给用户审阅' }),
          revision: rendered.revision,
        };
      } },
    { name: 'submit_previz_review', risk: 'plan', description: '提交 Blender 3D 白模预演审阅单（强制等待用户批准）。批准后对应分镜标记为预演通过，可调用 stylize_keyframe 合成正式画风首尾帧，再交由生视频或镜头源码完成呈现。',
      parameters: object({
        summary: str('本次白模预演的镜头构图、演员走位与运镜摘要'),
        shots: { type: 'array', items: object({
          shotId: str('分镜 ID 或工程镜头 ID'), imageAssetId: str('白模关键帧资产 ID'), depthAssetId: str('可选：Z-Depth 深度图资产 ID'), videoAssetId: str('可选：白模预演视频资产 ID'), cameraNote: str('机位与走位说明'),
        }, ['shotId', 'imageAssetId']) },
      }, ['summary', 'shots']),
      async run(args, ctx) {
        const items = Array.isArray(args.shots) ? args.shots as Record<string, unknown>[] : [];
        if (!items.length) throw new Error('shots 不能为空');
        const approvedIds: string[] = [];
        const story = await ctx.docs.updateStory(current => {
          const at = new Date().toISOString();
          const shots = current.shots.map(s => {
            const hit = items.find(item => item.shotId === s.id || item.shotId === s.shotId);
            if (!hit) return s;
            approvedIds.push(s.shotId ?? s.id);
            return {
              ...s,
              previz: {
                status: 'approved' as const,
                imageAssetId: typeof hit.imageAssetId === 'string' ? hit.imageAssetId : s.previz?.imageAssetId,
                ...(typeof hit.depthAssetId === 'string' && hit.depthAssetId ? { depthAssetId: hit.depthAssetId } : s.previz?.depthAssetId ? { depthAssetId: s.previz.depthAssetId } : {}),
                ...(typeof hit.videoAssetId === 'string' && hit.videoAssetId ? { videoAssetId: hit.videoAssetId } : s.previz?.videoAssetId ? { videoAssetId: s.previz.videoAssetId } : {}),
                ...(typeof hit.cameraNote === 'string' ? { note: hit.cameraNote.slice(0, 400) } : s.previz?.note ? { note: s.previz.note } : {}),
                updatedAt: at,
              },
            };
          });
          return { ...current, shots, updatedAt: at };
        });
        await syncBibleToProject(ctx, story);
        return { content: json({ ok: true, approvedShots: approvedIds.length ? approvedIds : items.map(i => String(i.shotId)), summary: need(args, 'summary'), next: '白模预演已获批准！若已接入生图模型，推荐先调 stylize_keyframe 生成正式美术风格首帧，再调 generate_video / batch_generate_media 实际呈现。' }) };
      } },

    // ==================== 6. 多模态生成、关键帧桥梁、批次并发与口型驱动 ====================
    { name: 'generate_image', risk: 'cost', requires: ['image'], description: '用图片模型生成定妆照、场景空镜母版或镜头素材（产生费用，需用户批准）。传 characterIds/locationId/propIds 自动拼接一致性锚点。完成后用 media_apply 采用。',
      parameters: object({
        expectedRevision: int('当前工程版本'), prompt: str('画面描述'), shotId: str('可选：关联镜头 ID'),
        characterIds: { type: 'array', items: { type: 'string' } }, locationId: str('可选：场景母版 ID'), propIds: { type: 'array', items: { type: 'string' } },
        size: str('可选：尺寸，如 1024x1024 / 1536x1024'), quality: str('可选：质量'), style: str('可选：风格'), n: int('可选：生成张数 1–4'),
      }, ['expectedRevision', 'prompt']),
      estimate: () => null,
      async run(args, ctx) {
        const parameters: Record<string, string | number | boolean> = {};
        for (const key of ['size', 'quality', 'style'] as const) if (typeof args[key] === 'string' && args[key]) parameters[key] = args[key] as string;
        if (Number.isSafeInteger(args.n)) parameters.n = Number(args.n);
        const task = await rpc(ctx, 'media.generate', { expectedRevision: revision(args), operation: 'text-to-image', prompt: await anchored(ctx, args), ...(args.shotId ? { shotId: args.shotId } : {}), ...(Object.keys(parameters).length ? { parameters } : {}), clientRequestId: `${ctx.runId}.${String(args.__callId ?? '')}` }) as { id: string };
        return { content: json({ taskId: task.id }), waitFor: { kind: 'media', id: task.id } };
      } },
    { name: 'stylize_keyframe', risk: 'cost', requires: ['image'], description: '【白模→成片防污染桥梁】将已批准的 Blender 空间构图/Z-Depth 深度图与角色定妆参考图、场景母版图融合重绘（image-compose；若当前生图模型不支持多图输入则自动回退强锚点文生图），产出正式美术风格的镜头首帧或尾帧（需用户批准）。',
      parameters: object({
        expectedRevision: int('当前工程版本'), shotId: str('目标镜头 ID'), prompt: str('目标画面的光影质感、表情细节与美术渲染描述（勿保留白模质感）'),
        frameRole: { type: 'string', enum: ['first', 'last'], description: '生成首帧(first，默认)或尾帧(last)' },
        layoutAssetId: str('可选：Blender 深度图 depthAssetId 或白模构图帧 imageAssetId（省略时自动从已批准预演读取）'),
        characterIds: { type: 'array', items: { type: 'string' } }, locationId: str('可选：场景母版 ID'), propIds: { type: 'array', items: { type: 'string' } },
        size: str('可选：尺寸'),
      }, ['expectedRevision', 'shotId', 'prompt']),
      estimate: () => null,
      async referenceImages(args, ctx) {
        const story = await ctx.docs.story();
        const shotId = need(args, 'shotId');
        const planned = story.shots.find(s => s.shotId === shotId || s.id === shotId);
        const refs: string[] = [];
        const layout = typeof args.layoutAssetId === 'string' && args.layoutAssetId
          ? args.layoutAssetId
          : (planned?.previz?.depthAssetId ?? planned?.previz?.imageAssetId);
        if (layout) refs.push(layout);
        const charIds = ids(args.characterIds).length ? ids(args.characterIds) : planned?.characters ?? [];
        for (const cid of charIds) {
          const c = story.characters.find(x => x.id === cid || x.name === cid);
          if (c?.referenceAssetIds[0] && refs.length < 4) refs.push(c.referenceAssetIds[0]);
        }
        const locId = typeof args.locationId === 'string' && args.locationId ? args.locationId : planned?.locationId;
        if (locId && refs.length < 4) {
          const loc = (story.locations ?? []).find(l => l.id === locId);
          if (loc?.referenceAssetIds?.[0]) refs.push(loc.referenceAssetIds[0]);
        }
        return { assetIds: [...new Set(refs)].slice(0, 4), role: 'image' };
      },
      async run(args, ctx) {
        const shotId = need(args, 'shotId');
        const role = args.frameRole === 'last' ? 'last' : 'first';
        const refIds = ctx.videoReference?.assetIds ?? (ctx.videoReference?.assetId ? [ctx.videoReference.assetId] : []);
        const fullPrompt = `【构图与角色真实化重绘】严格遵循参考图的空间机位、景深透视与人物外貌特征，渲染为正式电影画面（严禁保留灰白 3D 白模材质）：${await anchored(ctx, args)}`.slice(0, 4000);
        let rev = await ensureShotReferenceBindings(ctx, shotId, refIds, revision(args));
        const parameters: Record<string, string | number | boolean> = {};
        if (typeof args.size === 'string' && args.size) parameters.size = args.size;
        let task: { id: string };
        try {
          if (refIds.length && ctx.videoReference && ctx.port.generateImageReference) {
            task = await ctx.port.generateImageReference({
              projectId: ctx.projectId, shotId, expectedRevision: rev, operation: 'image-compose',
              prompt: fullPrompt, imageAssetIds: refIds, allowImageUpload: true,
              ...(Object.keys(parameters).length ? { parameters } : {}),
              clientRequestId: `${ctx.runId}.${String(args.__callId ?? '')}`,
            }, ctx.videoReference.authorizeUpload);
          } else {
            task = await rpc(ctx, 'media.generate', {
              expectedRevision: rev, shotId, operation: 'text-to-image', prompt: fullPrompt,
              ...(Object.keys(parameters).length ? { parameters } : {}),
              clientRequestId: `${ctx.runId}.${String(args.__callId ?? '')}`,
            }) as { id: string };
          }
        } catch (error) {
          // Graceful fallback when current image provider only supports text-to-image
          if (/不支持.*image-compose|不支持图片输入|没有 \{\{image\}\}/.test(error instanceof Error ? error.message : '')) {
            const snap = await ctx.port.snapshot(ctx.projectId);
            rev = snap.project?.revision ?? rev;
            task = await rpc(ctx, 'media.generate', {
              expectedRevision: rev, shotId, operation: 'text-to-image', prompt: fullPrompt,
              ...(Object.keys(parameters).length ? { parameters } : {}),
              clientRequestId: `${ctx.runId}.${String(args.__callId ?? '')}.t2i`,
            }) as { id: string };
          } else throw error;
        }
        return { content: json({ taskId: task.id, shotId, frameRole: role, hint: '关键帧生成后请调用 media_apply 采用，再传入 generate_video' }), waitFor: { kind: 'media', id: task.id } };
      } },
    { name: 'generate_video', risk: 'cost', requires: ['video'], description: '用视频模型生成镜头动态片段（需用户批准）。支持单首帧（imageAssetId）、首尾帧受控（同时传 imageAssetId + tailImageAssetId 自动启用 first-last-frame-video）及多角色场景锚点。优先读取正式重绘首帧 styledKeyframeAssetId，避免灰白预演模型直接污染视频材质。',
      parameters: object({
        expectedRevision: int('当前工程版本'), prompt: str('画面与运动描述'), shotId: str('可选：关联镜头 ID'),
        imageAssetId: str('可选：首帧图片素材 ID'), tailImageAssetId: str('可选：尾帧图片素材 ID（传入时激活首尾帧受控生成）'),
        previzAssetId: str('可选：显式指定的预演参考帧 ID'), allowRawPreviz: bool('若未重绘正式首帧，是否允许直接将灰模预演图作为首帧（默认 false）'),
        characterIds: { type: 'array', items: { type: 'string' } }, locationId: str('可选：场景母版 ID'), propIds: { type: 'array', items: { type: 'string' } },
        useReference: bool('未指定首帧时是否自动选取角色/场景参考图'),
        durationSeconds: num('可选：目标时长（秒）'), aspectRatio: str('可选：画幅比例，如 16:9 / 9:16'),
        width: int('可选：画面宽度'), height: int('可选：画面高度'), seed: int('可选：随机种子'), negativePrompt: str('可选：负向提示词'),
      }, ['expectedRevision', 'prompt']),
      estimate: () => null,
      async referenceImages(args, ctx) {
        const list: string[] = [];
        const story = await ctx.docs.story();
        const planned = typeof args.shotId === 'string' && args.shotId ? story.shots.find(s => s.shotId === args.shotId || s.id === args.shotId) : undefined;
        const first = typeof args.imageAssetId === 'string' && args.imageAssetId
          ? args.imageAssetId
          : typeof args.previzAssetId === 'string' && args.previzAssetId
            ? args.previzAssetId
            : planned?.previz?.styledKeyframeAssetId
              ? planned.previz.styledKeyframeAssetId
              : (args.allowRawPreviz === true && planned?.previz?.status === 'approved' && planned.previz.imageAssetId)
                ? planned.previz.imageAssetId
                : '';
        if (first) list.push(first);
        else if (args.useReference === true) {
          const charIds = ids(args.characterIds).length ? ids(args.characterIds) : planned?.characters ?? [];
          for (const cid of charIds) {
            const c = story.characters.find(x => x.id === cid || x.name === cid);
            if (c?.referenceAssetIds[0] && list.length < 1) list.push(c.referenceAssetIds[0]);
          }
        }
        const tail = typeof args.tailImageAssetId === 'string' && args.tailImageAssetId ? args.tailImageAssetId : planned?.previz?.styledTailAssetId ?? '';
        if (tail && list.length === 1 && tail !== list[0]) list.push(tail);
        return { assetIds: list, role: 'video' };
      },
      async run(args, ctx) {
        const refIds = ctx.videoReference?.assetIds ?? (ctx.videoReference?.assetId ? [ctx.videoReference.assetId] : []);
        const shotId = typeof args.shotId === 'string' && args.shotId ? args.shotId : undefined;
        const rev = await ensureShotReferenceBindings(ctx, shotId, refIds, revision(args));
        const parameters: Record<string, string | number | boolean> = {};
        if (typeof args.durationSeconds === 'number' && Number.isFinite(args.durationSeconds)) parameters.durationSeconds = args.durationSeconds;
        for (const key of ['width', 'height', 'seed'] as const) if (Number.isSafeInteger(args[key])) parameters[key] = Number(args[key]);
        for (const key of ['aspectRatio', 'negativePrompt'] as const) if (typeof args[key] === 'string' && args[key]) parameters[key] = args[key] as string;
        const operation = refIds.length >= 2 ? 'first-last-frame-video' as const : refIds.length === 1 ? 'image-to-video' as const : 'text-to-video' as const;
        const request = {
          projectId: ctx.projectId, expectedRevision: rev, operation, prompt: await anchored(ctx, args),
          ...(shotId ? { shotId } : {}),
          ...(refIds.length ? { imageAssetIds: refIds, allowImageUpload: true, ...(operation === 'first-last-frame-video' ? { referenceRoles: ['first_frame', 'last_frame'] } : {}) } : {}),
          ...(Object.keys(parameters).length ? { parameters } : {}),
          clientRequestId: `${ctx.runId}.${String(args.__callId ?? '')}`,
        };
        const task = ctx.videoReference && ctx.port.generateVideoReference ? await ctx.port.generateVideoReference(request, ctx.videoReference.authorizeUpload) : await rpc(ctx, 'media.generate', request) as { id: string };
        return { content: json({ taskId: task.id, operation, firstFrame: refIds[0] || undefined, lastFrame: refIds[1] || undefined }), waitFor: { kind: 'media', id: task.id } };
      } },
    { name: 'batch_generate_media', risk: 'cost', description: '【场次级成批审批与多路并发生成】一次性提交多个镜头（最多 8 项）的生图或生视频任务：用户只需审批 1 次即可并行启动全部生成并在完成后自动汇总（支持 autoApply=true 自动采用入轨），大幅减少逐镜弹窗打断。',
      parameters: object({
        expectedRevision: int('当前工程版本'),
        autoApply: bool('生成就绪后是否自动按顺序采用绑定到对应镜头（默认 true）'),
        items: { type: 'array', description: '待并发生成的镜头任务列表（1–8 项）', items: object({
          kind: { type: 'string', enum: ['image', 'video'], description: '生成类型：image 或 video' },
          shotId: str('关联镜头 ID'), prompt: str('画面与运动提示词'),
          imageAssetId: str('可选：首帧图片素材 ID'), tailImageAssetId: str('可选：尾帧图片素材 ID'),
          characterIds: { type: 'array', items: { type: 'string' } }, locationId: str('可选：场景母版 ID'),
          durationSeconds: num('可选：视频时长秒数'), aspectRatio: str('可选：画幅比例'), size: str('可选：图片尺寸'),
        }, ['kind', 'shotId', 'prompt']) },
      }, ['expectedRevision', 'items']),
      estimate: () => null,
      async referenceImages(args, _ctx) {
        const items = Array.isArray(args.items) ? args.items as Record<string, unknown>[] : [];
        const refs: string[] = [];
        let hasVideoRef = false;
        for (const it of items) {
          for (const k of ['imageAssetId', 'tailImageAssetId'] as const) {
            if (typeof it[k] === 'string' && it[k]) { refs.push(it[k] as string); if (it.kind === 'video') hasVideoRef = true; }
          }
        }
        return { assetIds: [...new Set(refs)], role: hasVideoRef ? 'video' : 'image' };
      },
      async run(args, ctx) {
        const items = Array.isArray(args.items) ? (args.items as Record<string, unknown>[]).slice(0, 8) : [];
        if (!items.length) throw new Error('items 不能为空');
        const allRefs = items.flatMap(it => [it.imageAssetId, it.tailImageAssetId].filter((x): x is string => typeof x === 'string' && Boolean(x)));
        let rev = revision(args);
        for (const it of items) {
          const itemRefs = [it.imageAssetId, it.tailImageAssetId].filter((x): x is string => typeof x === 'string' && Boolean(x));
          if (itemRefs.length) rev = await ensureShotReferenceBindings(ctx, need(it, 'shotId'), itemRefs, rev);
        }
        const taskIds: string[] = [];
        const autoApplyShots: Record<string, string> = {};
        for (const [idx, it] of items.entries()) {
          const kind = it.kind === 'image' ? 'image' : 'video';
          const shotId = need(it, 'shotId');
          const prompt = await anchored(ctx, it);
          const itemRefs = [it.imageAssetId, it.tailImageAssetId].filter((x): x is string => typeof x === 'string' && Boolean(x));
          const parameters: Record<string, string | number | boolean> = {};
          if (kind === 'image' && typeof it.size === 'string' && it.size) parameters.size = it.size;
          if (kind === 'video') {
            if (typeof it.durationSeconds === 'number' && Number.isFinite(it.durationSeconds)) parameters.durationSeconds = it.durationSeconds;
            if (typeof it.aspectRatio === 'string' && it.aspectRatio) parameters.aspectRatio = it.aspectRatio;
          }
          const operation = kind === 'image'
            ? (itemRefs.length ? 'image-compose' as const : 'text-to-image' as const)
            : (itemRefs.length >= 2 ? 'first-last-frame-video' as const : itemRefs.length === 1 ? 'image-to-video' as const : 'text-to-video' as const);
          const req = {
            projectId: ctx.projectId, expectedRevision: rev, shotId, operation, prompt,
            ...(itemRefs.length ? { imageAssetIds: itemRefs, allowImageUpload: true, ...(operation === 'first-last-frame-video' ? { referenceRoles: ['first_frame', 'last_frame'] } : {}) } : {}),
            ...(Object.keys(parameters).length ? { parameters } : {}),
            clientRequestId: `${ctx.runId}.${String(args.__callId ?? '')}.${idx}`,
          };
          const created = itemRefs.length && allRefs.length && ctx.videoReference
            ? (kind === 'video' && ctx.port.generateVideoReference ? await ctx.port.generateVideoReference(req, ctx.videoReference.authorizeUpload) : ctx.port.generateImageReference ? await ctx.port.generateImageReference(req, ctx.videoReference.authorizeUpload) : await rpc(ctx, 'media.generate', req) as { id: string })
            : await rpc(ctx, 'media.generate', req) as { id: string };
          taskIds.push(created.id);
          if (args.autoApply !== false) autoApplyShots[created.id] = shotId;
        }
        return {
          content: json({ batchCount: taskIds.length, taskIds }),
          waitForBatch: { kind: 'media', ids: taskIds, ...(args.autoApply !== false ? { autoApplyShots } : {}) },
        };
      } },
    { name: 'apply_lip_sync', risk: 'cost', requires: ['video'], description: '人物对白口型同步（Lip-Sync）：输入镜头已有视频素材与角色配音音频素材，调用口型驱动模型（video-gateway 或 replicate-lipsync 异步模板）生成口型匹配的新视频片段（需用户批准）。',
      parameters: object({
        expectedRevision: int('当前工程版本'), shotId: str('目标镜头 ID'),
        videoAssetId: str('源镜头视频素材 ID'), audioAssetId: str('对白配音音频素材 ID'),
        prompt: str('可选：说话神态与面部微表情补充说明'),
      }, ['expectedRevision', 'shotId', 'videoAssetId', 'audioAssetId']),
      estimate: () => null,
      async run(args, ctx) {
        const rev = revision(args);
        const shotId = need(args, 'shotId'), videoAssetId = need(args, 'videoAssetId'), audioAssetId = need(args, 'audioAssetId');
        const snap = await ctx.port.snapshot(ctx.projectId);
        if (!snap.project) throw new Error('没有打开的工程');
        if (!snap.project.assets.some(a => a.id === videoAssetId && a.kind === 'video')) throw new Error('未找到指定的视频素材：' + videoAssetId);
        if (!snap.project.assets.some(a => a.id === audioAssetId && a.kind === 'audio')) throw new Error('未找到指定的配音素材：' + audioAssetId);
        const [videoData, audioData] = await Promise.all([
          rpc(ctx, 'media.assetDataUrl', { assetId: videoAssetId }) as Promise<{ dataUrl: string }>,
          rpc(ctx, 'media.assetDataUrl', { assetId: audioAssetId }) as Promise<{ dataUrl: string }>,
        ]);
        const task = await rpc(ctx, 'media.generate', {
          expectedRevision: rev, shotId, operation: 'lip-sync-video',
          prompt: typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt.trim() : '人物自然说话口型同步，保持面部身份与光影稳定',
          parameters: { videoDataUrl: videoData.dataUrl, audioDataUrl: audioData.dataUrl },
          clientRequestId: `${ctx.runId}.${String(args.__callId ?? '')}`,
        }) as { id: string };
        return { content: json({ taskId: task.id, shotId, operation: 'lip-sync-video', hint: '口型同步视频就绪后请用 media_apply 采用' }), waitFor: { kind: 'media', id: task.id } };
      } },
    { name: 'media_apply', risk: 'write', description: '把已就绪的生成素材采用到工程（若关联了预演镜头且生成的是关键帧图片，可传 registerAsKeyframe="first"|"last" 登记为正式首帧或尾帧）。',
      parameters: object({
        taskId: str('媒体任务 ID'), expectedRevision: int('当前工程版本'),
        registerAsKeyframe: { type: 'string', enum: ['first', 'last'], description: '可选：将该生图结果同时登记为对应镜头的正式风格首帧或尾帧' },
      }, ['taskId', 'expectedRevision']),
      async run(args, ctx) {
        const value = await rpc(ctx, 'media.apply', { taskId: need(args, 'taskId'), expectedRevision: revision(args) }) as { shotId?: string; assetIds?: string[]; revision?: number; applied?: { assetIds?: string[]; revision?: number } };
        const assetIds = value.applied?.assetIds ?? value.assetIds;
        const rev = value.applied?.revision ?? value.revision;
        if ((args.registerAsKeyframe === 'first' || args.registerAsKeyframe === 'last') && assetIds?.[0]) {
          const targetShotId = value.shotId ?? (await rpc(ctx, 'media.get', { taskId: need(args, 'taskId') }) as { shotId?: string })?.shotId;
          if (targetShotId) {
            const keyAssetId = assetIds[0];
            await ctx.docs.updateStory(current => ({
              ...current,
              updatedAt: new Date().toISOString(),
              shots: current.shots.map(s => (s.shotId === targetShotId || s.id === targetShotId) ? {
                ...s,
                previz: {
                  status: s.previz?.status ?? 'approved',
                  ...s.previz,
                  ...(args.registerAsKeyframe === 'last' ? { styledTailAssetId: keyAssetId } : { styledKeyframeAssetId: keyAssetId }),
                  updatedAt: new Date().toISOString(),
                },
              } : s),
            }));
          }
        }
        return { content: json({ ...value, ...(assetIds ? { assetIds } : {}), ...(rev !== undefined ? { revision: rev } : {}) }), revision: rev };
      } },
    { name: 'frame_handoff', risk: 'write', requires: ['video'], description: '尾帧承接：截取上一个镜头的最后一帧，导入为图片素材，返回 assetId，用作下一镜 generate_video 的 imageAssetId（首帧）。', parameters: object({ shotId: str('要承接的（后一个）镜头 ID') }, ['shotId']),
      async run(args, ctx) {
        if (!ctx.port.importImage) throw new Error('当前环境不能导入图片');
        const project = (await ctx.port.snapshot(ctx.projectId)).project; if (!project) throw new Error('没有打开的工程');
        const order = project.shotOrder.length ? project.shotOrder : project.shots.map(s => s.id); const index = order.indexOf(need(args, 'shotId'));
        if (index < 0) throw new Error('镜头不存在'); if (index === 0) throw new Error('第一个镜头没有上一镜可承接');
        let end = 0; for (let i = 0; i < index; i++) end += project.shots.find(s => s.id === order[i])!.durationFrames;
        const frame = await ctx.port.capture(ctx.projectId, end - 1, ctx.signal);
        const asset = await ctx.port.importImage(ctx.projectId, `尾帧承接 · ${order[index - 1]}→${order[index]}`, frame.bytes, frame.mime);
        return { content: json({ ok: true, assetId: asset.id, fromShot: order[index - 1], frame: end - 1, hint: '把 assetId 作为 generate_video 的 imageAssetId' }) };
      } },

    // ==================== 7. 分角色声音表演、拟音合成与专业闪避混音 ====================
    { name: 'generate_voice', risk: 'cost', requires: ['speech'], description: '为镜头生成分角色对白/旁白配音并登记为工程素材（产生费用，需用户批准）。支持按 characterId 自动匹配角色库中的专属音色 voice，或直接指定 voice 与语速 speed；传入 autoBind=true 时自动按顺序挂入镜头音轨。',
      parameters: object({
        expectedRevision: int('当前工程版本'), shotId: str('单条时的镜头 ID'), text: str('单条时的台词/旁白文字'),
        characterId: str('可选：说话角色 ID（自动读取角色专属 voice）'), voice: str('可选：显式指定音色 ID，如 alloy / nova / echo / onyx / shimmer'),
        speed: num('可选：语速倍率 0.5–2.0，默认 1.0'), autoBind: bool('是否自动挂入对应镜头音轨（默认 false）'),
        lines: { type: 'array', items: object({
          shotId: str('镜头 ID'), text: str('台词文字'),
          characterId: str('可选：说话角色 ID'), voice: str('可选：显式音色 ID'), speed: num('可选：语速'),
        }, ['shotId', 'text']) },
      }),
      estimate: () => null,
      async run(args, ctx) {
        if (!ctx.port.voice) throw new Error('未配置配音');
        const story = await ctx.docs.story();
        const rawLines = Array.isArray(args.lines) && args.lines.length
          ? (args.lines as Record<string, unknown>[]).slice(0, 80)
          : [{ shotId: args.shotId, text: args.text, characterId: args.characterId, voice: args.voice, speed: args.speed }];
        const lines = rawLines.map(line => {
          const cid = typeof line.characterId === 'string' && line.characterId.trim() ? line.characterId.trim() : undefined;
          const charObj = cid ? story.characters.find(c => c.id === cid || c.name === cid) : undefined;
          const voice = typeof line.voice === 'string' && line.voice.trim() ? line.voice.trim() : charObj?.voice;
          const speed = typeof line.speed === 'number' && Number.isFinite(line.speed) ? line.speed : undefined;
          return { shotId: need(line, 'shotId'), text: need(line, 'text'), characterId: charObj?.id ?? cid, speaker: charObj?.name ?? cid, voice, speed };
        });
        const expected = Number.isSafeInteger(args.expectedRevision) ? args.expectedRevision as number : undefined;
        const results = [];
        for (const [index, line] of lines.entries()) {
          const asset = await ctx.port.voice(ctx.projectId, line.shotId, line.text, ctx.signal, {
            ...(index === 0 && expected !== undefined ? { expectedRevision: expected } : {}),
            ...(line.voice ? { voice: line.voice } : {}),
            ...(line.speed !== undefined ? { speed: line.speed } : {}),
            ...(line.speaker ? { speaker: line.speaker } : {}),
            requestId: `${ctx.runId}.${String(args.__callId ?? '')}.${index}`,
          });
          results.push({ shotId: line.shotId, assetId: asset.id, name: asset.name, speaker: line.speaker, voice: line.voice, characterId: line.characterId, revision: asset.revision });
        }
        let finalRev = results.at(-1)!.revision;
        if (args.autoBind === true) {
          const snap = await ctx.port.snapshot(ctx.projectId);
          if (snap.project) {
            const next = structuredClone(snap.project);
            for (const r of results) {
              const clip: AudioClip = {
                id: randomUUID(), assetId: r.assetId, role: 'voice', shotId: r.shotId,
                startSeconds: 0, trimStart: 0, volume: 1, fadeIn: 0, fadeOut: 0,
                ...(r.characterId ? { characterId: r.characterId } : {}),
                ...(r.speaker ? { speaker: r.speaker } : {}),
              };
              next.audioClips = [...(next.audioClips ?? []), clip];
            }
            next.target.audioMode = 'mixed';
            alignToVoice(next, 0.35, new Set(results.map(r => r.shotId)), { syncSubtitles: true });
            const committed = await ctx.port.commit(ctx.projectId, snap.project.revision, next, {}, '智能体：自动挂载分角色配音与顺序话轮');
            finalRev = committed.project?.revision;
          }
        }
        const last = results.at(-1)!;
        return {
          content: json({ ok: true, ...(results.length === 1 ? { assetId: last.assetId, name: last.name } : { voices: results }), autoBound: args.autoBind === true, revision: finalRev, hint: args.autoBind === true ? '配音已按顺序挂入音轨并同步字幕' : '素材已登记进工程；用 audio_edit 加入音轨并用 align_to_voice 顺序对齐' }),
          revision: finalRev,
        };
      } },
    { name: 'align_to_voice', risk: 'write', description: '配音与多句话轮顺序对齐：自动将每个镜头内的单句或多句配音按先后顺序串联排布（保留句间停顿 interLineGapSeconds，不叠音），调整镜头时长贴合总对白时长，并可选同步生成精确时间轴字幕轨（syncSubtitles）。',
      parameters: object({
        expectedRevision: int('当前工程版本'),
        paddingSeconds: num('镜头末尾余量，默认 0.4 秒'),
        interLineGapSeconds: num('同镜头多句对白之间的停顿间隔，默认 0.2 秒'),
        syncSubtitles: bool('是否同时将对白时间轴写入工程全局字幕轨'),
        shotIds: { type: 'array', items: { type: 'string' } },
      }, ['expectedRevision']),
      async run(args, ctx) {
        const project = structuredClone((await ctx.port.snapshot(ctx.projectId)).project); if (!project) throw new Error('没有打开的工程');
        const expected = revision(args); if (expected !== project.revision) throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' });
        const pad = Number.isFinite(Number(args.paddingSeconds)) ? Math.max(0, Math.min(5, Number(args.paddingSeconds))) : 0.4;
        const wanted = Array.isArray(args.shotIds) ? new Set(args.shotIds.map(String)) : null;
        const changes = alignToVoice(project, pad, wanted, {
          interLineGapSeconds: args.interLineGapSeconds !== undefined ? Number(args.interLineGapSeconds) : 0.2,
          syncSubtitles: args.syncSubtitles === true,
        });
        if (!changes.length && args.syncSubtitles !== true) return { content: json({ ok: true, changed: 0, message: '没有需要对齐的配音（镜头需有带时长的配音片段）' }) };
        const next = await ctx.port.commit(ctx.projectId, expected, project, {}, '智能体：对白话轮对齐');
        return { content: json({ ok: true, revision: next.project?.revision, changes, subtitlesSynced: args.syncSubtitles === true }), revision: next.project?.revision };
      } },
    { name: 'generate_music', risk: 'cost', requires: ['music'], description: '用已接入的音乐模型生成背景配乐并导入为素材（产生费用，需用户批准）。之后用 audio_edit 放入音轨并调 audio_mix_master 开启自动闪避。',
      parameters: object({ prompt: str('风格、情绪、配器、BPM 节奏'), durationSeconds: num('时长（秒）') }, ['prompt']),
      estimate: () => null,
      async run(args, ctx) { if (!ctx.port.generateAudio) throw new Error('未配置音乐生成'); const asset = await ctx.port.generateAudio(ctx.projectId, 'music', need(args, 'prompt'), { durationSeconds: Number(args.durationSeconds) || undefined, signal: ctx.signal }); return { content: json({ ok: true, assetId: asset.id, name: asset.name, hint: '用 audio_edit 把它加入音轨，并用 audio_mix_master 开启 autoDucking' }), cost: asset.cost ?? null }; } },
    { name: 'generate_sfx', risk: 'cost', requires: ['sfx'], description: '用已接入的音效模型生成音效并导入为素材（产生费用，需用户批准）。',
      parameters: object({ prompt: str('音效描述'), durationSeconds: num('时长（秒）') }, ['prompt']),
      estimate: () => null,
      async run(args, ctx) { if (!ctx.port.generateAudio) throw new Error('未配置音效生成'); const asset = await ctx.port.generateAudio(ctx.projectId, 'sfx', need(args, 'prompt'), { durationSeconds: Number(args.durationSeconds) || undefined, signal: ctx.signal }); return { content: json({ ok: true, assetId: asset.id, name: asset.name, hint: '用 audio_edit 把它加入音轨' }), cost: asset.cost ?? null }; } },
    { name: 'synthesize_sfx', risk: 'write', fallbackFor: ['sfx'], description: '未接入外部音效模型时，在本地确定性合成电影拟音与氛围音（支持 12 种：tone提示音 / sweep扫频 / chime钟声 / noise冲击 / whoosh转场风声 / click快门点击 / rain雨声环境 / heartbeat悬疑心跳 / footstep脚步声 / riser情绪抬升 / sub_drop重低音震击 / ambience_hum空间底噪），免费。',
      parameters: object({
        name: str('素材名称'), kind: { type: 'string', enum: [...SYNTH_KINDS] }, durationSeconds: num('时长 0.05–30 秒'),
        frequency: num('基频 Hz'), endFrequency: num('扫频/Riser 截止频率 Hz'), volume: num('音量 0–1'),
        shotId: str('可选：直接绑定到的镜头 ID'), startSeconds: num('可选：音轨起点秒数'), bindToTrack: bool('是否直接挂入音轨'),
      }, ['kind', 'durationSeconds']),
      async run(args, ctx) {
        if (!ctx.port.importAudio) throw new Error('当前环境不能导入音频');
        const kind = String(args.kind) as SynthKind; if (!SYNTH_KINDS.includes(kind)) throw new Error('kind 无效');
        const bytes = synthesize({ ...(args as unknown as SynthSpec), kind });
        const asset = await ctx.port.importAudio(ctx.projectId, typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 60) : '合成拟音 · ' + kind, bytes, 'audio/wav');
        let boundToTrack = false;
        if (args.bindToTrack === true || (typeof args.shotId === 'string' && args.shotId.trim())) {
          const latest = await ctx.port.snapshot(ctx.projectId);
          if (latest.project) {
            await rpc(ctx, 'audio', { expectedRevision: latest.project.revision, operation: 'add', assetId: asset.id, role: 'sfx', ...(typeof args.shotId === 'string' && args.shotId.trim() ? { shotId: args.shotId.trim() } : {}), startSeconds: Number(args.startSeconds ?? 0), trimStart: 0, volume: Number.isFinite(Number(args.volume)) ? Number(args.volume) : 0.7, fadeIn: 0, fadeOut: 0 });
            boundToTrack = true;
          }
        }
        return { content: json({ ok: true, assetId: asset.id, name: asset.name, bytes: bytes.length, boundToTrack, hint: boundToTrack ? '已导入并挂入音轨' : '用 audio_edit 把它加入音轨' }) };
      } },
    { name: 'audio_edit', risk: 'write', description: '编辑音轨（添加/更新/移除旁白、音乐、音效片段，设置位置、裁剪、音量、淡入淡出、循环与角色标注；clipId 可通过 project_get 的 audioClips 查看）。',
      parameters: object({
        action: { type: 'string', enum: ['add', 'remove', 'update'], description: '音轨操作：add / update / remove' },
        request: { type: 'object', description: 'add 传 assetId/role(voice|music|sfx)/shotId?/startSeconds?/trimStart?/trimEnd?/volume?/fadeIn?/fadeOut?/loop?/characterId?/speaker?；update 传 clipId 与 patch；remove 传 clipId' },
      }, ['action']),
      async run(args, ctx) { return directorAction(ctx, 'video_audio', args, false, '编辑音轨'); } },
    { name: 'audio_mix_master', risk: 'write', description: '配置专业电影混音母带总线：开启人声触发背景音乐自动闪避（Sidechain Auto-Ducking）、人声空间混响（室内/大厅/电话滤波）与 EBU R128 流媒体响度标准化（默认 -14 LUFS）。',
      parameters: object({
        expectedRevision: int('当前工程版本'),
        autoDucking: bool('对白出现时是否自动平滑压低背景音乐（推荐 true）'),
        duckingDb: num('人声出现时 BGM 压低幅度 dB（0–30，默认 8）'),
        targetLufs: num('目标综合响度 LUFS（-36 至 -8，短视频/Web 标准为 -14，广播为 -23）'),
        voiceReverb: { type: 'string', enum: ['none', 'room', 'hall', 'phone'], description: '人声空间声场效果' },
      }, ['expectedRevision']),
      async run(args, ctx) {
        const snap = await ctx.port.snapshot(ctx.projectId); if (!snap.project) throw new Error('没有打开的工程');
        const expected = revision(args); if (expected !== snap.project.revision) throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' });
        const next = structuredClone(snap.project);
        next.audioMix = {
          ...(next.audioMix ?? {}),
          ...(args.autoDucking !== undefined ? { autoDucking: Boolean(args.autoDucking) } : {}),
          ...(args.duckingDb !== undefined ? { duckingDb: Number(args.duckingDb) } : {}),
          ...(args.targetLufs !== undefined ? { targetLufs: Number(args.targetLufs) } : {}),
          ...(typeof args.voiceReverb === 'string' ? { voiceReverb: args.voiceReverb as 'none' | 'room' | 'hall' | 'phone' } : {}),
        };
        const committed = await ctx.port.commit(ctx.projectId, expected, next, {}, '智能体：配置专业闪避与响度混音母带');
        return { content: json({ ok: true, revision: committed.project?.revision, audioMix: committed.project?.audioMix }), revision: committed.project?.revision };
      } },
    { name: 'audio_analyze', risk: 'read', description: '声学波形实测分析：通过 FFmpeg ebur128 与 silencedetect 测量工程总混音（或指定音视频资产）的真实综合响度（LUFS）、真峰值（dBFS）、爆音削波风险及静音区间。',
      parameters: object({ assetId: str('可选：指定单个音视频资产 ID；省略则测量整片最终混音母带') }),
      async run(args, ctx) { const value = await rpc(ctx, 'audio.analyze', typeof args.assetId === 'string' && args.assetId ? { assetId: args.assetId } : {}); return { content: json(value) }; } },

    // ==================== 8. 非线性后期精剪（视频片段、多候选 Takes、B-Roll 画中画、全局字幕、智能重构图） ====================
    { name: 'video_clip_save', risk: 'write', description: '给镜头绑定或调整主视频片段（裁剪区间、0.25–4x 倍速、适配模式、原声开关）。',
      parameters: object({
        expectedRevision: int('当前工程版本'), shotId: str('镜头 ID'), assetId: str('视频资产 ID'),
        trimStart: num('源视频裁入秒数，默认 0'), trimEnd: num('可选：源视频裁出秒数'),
        speed: num('播放倍速，默认 1'), fit: { type: 'string', enum: ['cover', 'contain'] },
        audio: { type: 'string', enum: ['mute', 'keep'] },
      }, ['expectedRevision', 'shotId', 'assetId']),
      async run(args, ctx) {
        const snapshot = await rpc(ctx, 'video.clip.save', { expectedRevision: revision(args), clip: { shotId: need(args, 'shotId'), assetId: need(args, 'assetId'), ...(args.trimStart !== undefined ? { trimStart: Number(args.trimStart) } : {}), ...(args.trimEnd !== undefined ? { trimEnd: Number(args.trimEnd) } : {}), ...(args.speed !== undefined ? { speed: Number(args.speed) } : {}), ...(args.fit ? { fit: args.fit } : {}), ...(args.audio ? { audio: args.audio } : {}) } }) as StudioSnapshot;
        return { content: json({ ok: true, revision: snapshot.project?.revision, videoClips: snapshot.project?.videoClips }), revision: snapshot.project?.revision };
      } },
    { name: 'video_clip_remove', risk: 'write', description: '移除镜头上绑定的主视频片段。', parameters: object({ expectedRevision: int('当前工程版本'), clipId: str('视频片段 ID') }, ['expectedRevision', 'clipId']),
      async run(args, ctx) { const snapshot = await rpc(ctx, 'video.clip.remove', { expectedRevision: revision(args), clipId: need(args, 'clipId') }) as StudioSnapshot; return { content: json({ ok: true, revision: snapshot.project?.revision }), revision: snapshot.project?.revision }; } },
    { name: 'video_clip_extract', risk: 'write', description: '从镜头视频片段提取原声为独立音频素材并挂入音轨（同时静音原视频）。', parameters: object({ expectedRevision: int('当前工程版本'), clipId: str('视频片段 ID') }, ['expectedRevision', 'clipId']),
      async run(args, ctx) { const snapshot = await rpc(ctx, 'video.clip.extract', { expectedRevision: revision(args), clipId: need(args, 'clipId') }) as StudioSnapshot; return { content: json({ ok: true, revision: snapshot.project?.revision, audioClips: snapshot.project?.audioClips }), revision: snapshot.project?.revision }; } },
    { name: 'shot_take_manage', risk: 'write', description: '单镜头多候选抽卡条（Takes）管理：登记备选视频/图片候选条（record）、标注审片打分，或无损切换某个候选条作为当前激活主画面（select）。',
      parameters: object({
        expectedRevision: int('当前工程版本'),
        action: { type: 'string', enum: ['record', 'select', 'remove'] },
        shotId: str('镜头 ID'),
        takeId: str('select / remove 时指定的候选条 ID'),
        assetId: str('record 时的视频或图片资产 ID'),
        score: num('可选：审片评分 0–100'), notes: str('可选：优缺点备注'),
      }, ['expectedRevision', 'action', 'shotId']),
      async run(args, ctx) {
        const snap = await ctx.port.snapshot(ctx.projectId); if (!snap.project) throw new Error('没有打开的工程');
        const expected = revision(args); if (expected !== snap.project.revision) throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' });
        const next = structuredClone(snap.project);
        const shot = next.shots.find(s => s.id === need(args, 'shotId')); if (!shot) throw new Error('镜头不存在');
        shot.takes ??= [];
        if (args.action === 'record') {
          const aid = need(args, 'assetId');
          const asset = next.assets.find(a => a.id === aid && (a.kind === 'video' || a.kind === 'image'));
          if (!asset) throw new Error('候选资产必须是工程内的图片或视频');
          const take = { id: typeof args.takeId === 'string' && args.takeId ? args.takeId : `take-${shot.takes.length + 1}-${randomUUID().slice(0, 6)}`, assetId: aid, kind: asset.kind as 'video' | 'image', ...(typeof args.score === 'number' ? { score: args.score } : {}), ...(typeof args.notes === 'string' ? { notes: args.notes.slice(0, 300) } : {}), createdAt: new Date().toISOString() };
          shot.takes = [...shot.takes.filter(t => t.id !== take.id), take];
        } else if (args.action === 'select') {
          const take = shot.takes.find(t => t.id === need(args, 'takeId'));
          if (!take) throw new Error('候选条不存在');
          if (take.kind === 'video') {
            const asset = next.assets.find(a => a.id === take.assetId);
            next.videoClips = [...(next.videoClips ?? []).filter(c => c.shotId !== shot.id), { id: randomUUID(), shotId: shot.id, assetId: take.assetId, trimStart: 0, trimEnd: asset?.duration, speed: 1, fit: 'cover', audio: 'mute' }];
          } else {
            if (!shot.assetIds.includes(take.assetId)) shot.assetIds.push(take.assetId);
          }
        } else if (args.action === 'remove') {
          shot.takes = shot.takes.filter(t => t.id !== need(args, 'takeId'));
        }
        const committed = await ctx.port.commit(ctx.projectId, expected, next, {}, '智能体：管理镜头多候选条 Takes');
        return { content: json({ ok: true, revision: committed.project?.revision, takes: committed.project?.shots.find(s => s.id === shot.id)?.takes }), revision: committed.project?.revision };
      } },
    { name: 'post_overlay_subtitle', risk: 'write', description: '管理 B-Roll 画中画前景叠加层（overlayClips：贴图/副机位画中画）与全局精确时间轴字幕轨（subtitles）。',
      parameters: object({
        expectedRevision: int('当前工程版本'),
        setSubtitles: { type: 'array', description: '可选：设置整条时间轴字幕轨', items: object({
          id: str('可选：字幕 ID'), startSeconds: num('起始秒数'), endSeconds: num('结束秒数'),
          text: str('字幕文本'), speaker: str('可选：说话人姓名'), shotId: str('可选：关联镜头 ID'),
        }, ['startSeconds', 'endSeconds', 'text']) },
        addOverlay: object({
          shotId: str('目标镜头 ID'), assetId: str('前景图片或视频素材 ID'),
          x: num('左上角 X 百分比 0–100'), y: num('左上角 Y 百分比 0–100'),
          width: num('宽度百分比 1–100'), height: num('高度百分比 1–100'),
          opacity: num('不透明度 0–1，默认 1'), startSeconds: num('镜头内起始秒数，默认 0'),
          durationSeconds: num('可选：持续秒数'), borderRadius: num('可选：圆角像素'),
        }, ['shotId', 'assetId', 'x', 'y', 'width', 'height']),
        removeOverlayId: str('可选：要移除的画中画图层 ID'),
      }, ['expectedRevision']),
      async run(args, ctx) {
        const snap = await ctx.port.snapshot(ctx.projectId); if (!snap.project) throw new Error('没有打开的工程');
        const expected = revision(args); if (expected !== snap.project.revision) throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' });
        const next = structuredClone(snap.project);
        if (Array.isArray(args.setSubtitles)) {
          next.subtitles = (args.setSubtitles as Record<string, unknown>[]).map((c, idx) => ({
            id: typeof c.id === 'string' && c.id ? c.id : `sub-${idx + 1}`,
            startSeconds: Number(c.startSeconds),
            endSeconds: Number(c.endSeconds),
            text: need(c, 'text').trim(),
            ...(typeof c.speaker === 'string' && c.speaker ? { speaker: c.speaker } : {}),
            ...(typeof c.shotId === 'string' && c.shotId ? { shotId: c.shotId } : {}),
          }));
        }
        if (args.addOverlay && typeof args.addOverlay === 'object') {
          const ov = args.addOverlay as Record<string, unknown>;
          const asset = next.assets.find(a => a.id === need(ov, 'assetId') && (a.kind === 'image' || a.kind === 'video'));
          if (!asset) throw new Error('画中画素材须为工程内已有的图片或视频');
          const entry: OverlayClip = {
            id: `ov-${randomUUID().slice(0, 8)}`,
            shotId: need(ov, 'shotId'),
            assetId: asset.id,
            kind: asset.kind as 'image' | 'video',
            x: Number(ov.x), y: Number(ov.y), width: Number(ov.width), height: Number(ov.height),
            opacity: ov.opacity !== undefined ? Number(ov.opacity) : 1,
            startSeconds: ov.startSeconds !== undefined ? Number(ov.startSeconds) : 0,
            ...(ov.durationSeconds !== undefined ? { durationSeconds: Number(ov.durationSeconds) } : {}),
            ...(ov.borderRadius !== undefined ? { borderRadius: Number(ov.borderRadius) } : {}),
          };
          next.overlayClips = [...(next.overlayClips ?? []), entry];
        }
        if (typeof args.removeOverlayId === 'string' && args.removeOverlayId) {
          next.overlayClips = (next.overlayClips ?? []).filter(o => o.id !== args.removeOverlayId);
        }
        const committed = await ctx.port.commit(ctx.projectId, expected, next, {}, '智能体：编辑画中画叠加层与时间轴字幕');
        return { content: json({ ok: true, revision: committed.project?.revision, subtitlesCount: committed.project?.subtitles?.length ?? 0, overlayCount: committed.project?.overlayClips?.length ?? 0 }), revision: committed.project?.revision };
      } },
    { name: 'reframe_project', risk: 'write', description: '多平台画幅智能重构图：一键将工程转换至 16:9(1920x1080 横屏)、9:16(1080x1920 竖屏短视频)、1:1(1080x1080) 或 21:9(2560x1080 宽银幕电影)，自动缩放安全区字号与视频裁切适配。',
      parameters: object({
        expectedRevision: int('当前工程版本'),
        aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1', '21:9', '4:3'], description: '目标画幅比例' },
        fps: int('可选：同步切换帧率，如 24(电影感) / 30 / 60'),
      }, ['expectedRevision', 'aspectRatio']),
      async run(args, ctx) {
        const snap = await ctx.port.snapshot(ctx.projectId); if (!snap.project) throw new Error('没有打开的工程');
        const expected = revision(args); if (expected !== snap.project.revision) throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' });
        const presets: Record<string, [number, number]> = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '21:9': [2560, 1080], '4:3': [1440, 1080] };
        const dims = presets[need(args, 'aspectRatio')]; if (!dims) throw new Error('不支持的画幅比例');
        const oldMin = Math.min(snap.project.target.width, snap.project.target.height);
        const newMin = Math.min(dims[0], dims[1]);
        const scale = newMin / Math.max(1, oldMin);
        let next = updateTarget(snap.project, {
          width: dims[0], height: dims[1],
          ...(Number.isSafeInteger(args.fps) && Number(args.fps) > 0 ? { fps: { num: Number(args.fps), den: 1 } } : {}),
        });
        for (const shot of next.shots) {
          shot.params.fontSize = Math.max(24, Math.round(shot.params.fontSize * scale));
        }
        const committed = await ctx.port.commit(ctx.projectId, expected, next, {}, `智能体：画幅智能重构图为 ${args.aspectRatio}`);
        return { content: json({ ok: true, revision: committed.project?.revision, target: committed.project?.target }), revision: committed.project?.revision };
      } },
    { name: 'asset_remove', risk: 'write', description: '从工程移除不再使用的素材（同时解除引用）。', parameters: object({ expectedRevision: int('当前工程版本'), assetId: str('素材 ID') }, ['expectedRevision', 'assetId']),
      async run(args, ctx) {
        const current = await ctx.port.snapshot(ctx.projectId); if (!current.project) throw new Error('没有打开的工程');
        const expected = revision(args); if (expected !== current.project.revision) throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' });
        const assetId = need(args, 'assetId');
        if (!current.project.assets.some(item => item.id === assetId)) throw new Error('素材不存在：' + assetId);
        const next = structuredClone(current.project);
        next.assets = next.assets.filter(item => item.id !== assetId);
        delete next.graph.positions[assetId];
        for (const shot of next.shots) { shot.assetIds = shot.assetIds.filter(id => id !== assetId); shot.referenceIds = shot.referenceIds.filter(id => id !== assetId); if (shot.takes) shot.takes = shot.takes.filter(t => t.assetId !== assetId); }
        next.audioClips = next.audioClips?.filter(clip => clip.assetId !== assetId);
        next.videoClips = next.videoClips?.filter(clip => clip.assetId !== assetId);
        next.overlayClips = next.overlayClips?.filter(clip => clip.assetId !== assetId);
        const committed = await ctx.port.commit(ctx.projectId, expected, next, {}, '智能体：移除素材');
        return { content: json({ ok: true, revision: committed.project?.revision }), revision: committed.project?.revision };
      } },
    { name: 'undo', risk: 'write', description: '撤销上一次工程修改（需带当前 expectedRevision）。', parameters: object({ expectedRevision: int('当前工程版本') }, ['expectedRevision']),
      async run(args, ctx) { await rpc(ctx, 'undo', { expectedRevision: revision(args) }); const snapshot = await ctx.port.snapshot(ctx.projectId); return { content: json({ ok: true, revision: snapshot.project?.revision }), revision: snapshot.project?.revision }; } },
    { name: 'redo', risk: 'write', description: '重做上一次已撤销的工程修改（需带当前 expectedRevision）。', parameters: object({ expectedRevision: int('当前工程版本') }, ['expectedRevision']),
      async run(args, ctx) { await rpc(ctx, 'redo', { expectedRevision: revision(args) }); const snapshot = await ctx.port.snapshot(ctx.projectId); return { content: json({ ok: true, revision: snapshot.project?.revision }), revision: snapshot.project?.revision }; } },

    // ==================== 9. 静帧/时序动态视觉审片、一致性与全量质检 ====================
    { name: 'render_check', risk: 'read', description: '刷新预览并检查资源与关键帧，返回渲染错误。', parameters: object({}),
      async run(_args, ctx) {
        const task = projectTask(await rpc(ctx, 'preview', {}) as StudioSnapshot);
        for (let i = 0; i < 240; i++) { ctx.signal.throwIfAborted(); const s = await ctx.port.snapshot(ctx.projectId); if (s.task?.id === task.id && s.task.status !== 'running') return { content: json({ taskId: task.id, status: s.task.status, message: s.task.message, error: s.task.error }), projectTask: task }; await new Promise(r => setTimeout(r, 250)); }
        return { content: json({ taskId: task.id, status: 'timeout', message: '预览检查超过 60 秒' }), projectTask: task };
      } },
    { name: 'capture_frame', risk: 'read', requires: ['vision'], description: '截取指定帧，返回视觉模型对画面的文字描述。', parameters: object({ frame: int('帧序号，从 0 开始') }, ['frame']),
      async run(args, ctx) {
        const frame = Number(args.frame); if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('frame 无效');
        if (!ctx.port.vision) return { content: json({ skipped: true, reason: '当前运行未启用视觉模型' }) };
        const shot = await ctx.port.capture(ctx.projectId, frame, ctx.signal);
        const observation = await ctx.port.vision('描述这张关键帧的构图、可见文字与画面问题。', [{ mime: shot.mime, bytes: shot.bytes }], ctx.signal);
        return { content: json({ frame: shot.frame, shotId: shot.shotId, observation: bound(observation, 3000) }) };
      } },
    { name: 'visual_review', risk: 'read', requires: ['vision'], description: '截取最多三个镜头的关键帧并请视觉模型检查文字、构图和画面问题，返回结构化问题清单。', parameters: object({ shotIds: { type: 'array', items: { type: 'string' } } }),
      async run(args, ctx) {
        const snapshot = await ctx.port.snapshot(ctx.projectId), project = snapshot.project; if (!project) throw new Error('没有打开的工程');
        if (!ctx.port.vision) return { content: json({ skipped: true, reason: '未配置视觉检查模型（vision 角色）；请改用 render_check' }) };
        const { selected: frames, uncheckedShotIds } = visualFrames(project, args.shotIds);
        if (!frames.length) return { content: json({ skipped: true, reason: '没有可检查的镜头' }) };
        const images = [] as { mime: string; bytes: Uint8Array }[];
        for (const item of frames) { const shot = await ctx.port.capture(ctx.projectId, item.frame, ctx.signal); images.push({ mime: shot.mime, bytes: shot.bytes }); }
        const checkedShotIds = frames.map(frame => frame.shotId);
        const answer = await ctx.port.vision('逐张检查视频关键帧（顺序对应镜头 ' + checkedShotIds.join(', ') + '）。只输出 JSON：{"pass":true|false,"issues":[{"shotId":"","problem":"","severity":"low|medium|high","suggestion":""}]}。检查文字溢出/遮挡、空白画面、对比度、元素越界、与镜头意图不符。', images, ctx.signal);
        try {
          const result = JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1));
          return { content: json({ ...result, checkedShotIds, uncheckedShotIds }) };
        } catch {
          return { content: json({ pass: false, error: '视觉模型没有返回可解析的检查结果', checkedShotIds, uncheckedShotIds, raw: bound(answer, 800) }) };
        }
      } },
    { name: 'temporal_video_review', risk: 'read', requires: ['vision'], description: '【时序动态与轴线连续性审片】对指定镜头按 0%/25%/50%/75%/100% 连续抽取 5 帧（若同时传 nextShotId 则加抽切镜交界帧检查 180° 轴线与色彩跳变），拼合为带时序进度条的宫格联系表 PNG 交由视觉模型检查运动变形、闪烁、运镜方向错误与越轴问题。',
      parameters: object({ shotId: str('要动态审看的镜头 ID'), nextShotId: str('可选：紧邻的下一镜头 ID，用于联合检查切镜连续性与 180° 轴线') }, ['shotId']),
      async run(args, ctx) {
        if (!ctx.port.vision) return { content: json({ skipped: true, reason: '未启用视觉检查模型' }) };
        const project = (await ctx.port.snapshot(ctx.projectId)).project; if (!project) throw new Error('没有打开的工程');
        const order = project.shotOrder.length ? project.shotOrder : project.shots.map(s => s.id);
        const targetId = need(args, 'shotId');
        let start = 0, targetStart = -1, targetDur = 0, nextStart = -1;
        for (const sid of order) {
          const s = project.shots.find(x => x.id === sid); if (!s) continue;
          if (sid === targetId) { targetStart = start; targetDur = s.durationFrames; }
          if (typeof args.nextShotId === 'string' && sid === args.nextShotId) nextStart = start;
          start += s.durationFrames;
        }
        if (targetStart < 0 || targetDur < 1) throw new Error('未找到目标镜头：' + targetId);
        const ratios = [0, 0.25, 0.5, 0.75, 1];
        const frameNums = [...new Set(ratios.map(r => targetStart + Math.min(targetDur - 1, Math.round((targetDur - 1) * r))))];
        if (nextStart >= 0) frameNums.push(nextStart + 1);
        const rawBytes: Uint8Array[] = [];
        for (const fn of frameNums) {
          const cap = await ctx.port.capture(ctx.projectId, fn, ctx.signal);
          rawBytes.push(cap.bytes);
        }
        const sheet = buildContactSheetPng(rawBytes, { columns: 3 });
        const payloadImages = sheet ? [{ mime: 'image/png', bytes: sheet.bytes }] : rawBytes.slice(0, 3).map(bytes => ({ mime: 'image/png', bytes }));
        const story = await ctx.docs.story();
        const planned = story.shots.find(s => s.shotId === targetId || s.id === targetId);
        const prompt = `这张时序宫格图按从左到右、从上到下顺序展示了镜头 ${targetId} 的 ${frameNums.length} 个连续采样帧（顶部蓝色进度条代表时间推进${nextStart >= 0 ? `，最后一格为切入下一镜 ${args.nextShotId} 的首帧` : ''}）。预期运镜与动作：${planned ? `${planned.camera} · ${planned.summary}` : '自然流畅'}。请检查：1) 主体在运动中是否变形崩坏或闪烁；2) 运镜推拉摇移方向是否符合预期；3) 切镜是否越轴或色温剧烈跳变。只输出 JSON：{"pass":true|false,"motionScore":0-100,"issues":[{"problem":"","severity":"low|medium|high","suggestion":""}]}`;
        const answer = await ctx.port.vision(prompt, payloadImages, ctx.signal);
        try {
          const parsed = JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1));
          return { content: json({ shotId: targetId, sampledFrames: frameNums, contactSheet: Boolean(sheet), ...parsed }) };
        } catch {
          return { content: json({ shotId: targetId, sampledFrames: frameNums, pass: false, raw: bound(answer, 800) }) };
        }
      } },
    { name: 'consistency_review', risk: 'read', requires: ['vision'], description: '截取最多六个镜头的关键帧，让视觉模型对照制片圣经中的风格、角色、场景与道具特征打 0–100 分，结果写入计划。',
      parameters: object({ shotIds: { type: 'array', items: { type: 'string' } }, threshold: num('及格阈值，默认 75') }),
      async run(args, ctx) {
        if (!ctx.port.vision) return { content: json({ skipped: true, reason: '未接入视觉检查模型' }) };
        const story = await ctx.docs.story(); if (story.status !== 'approved') return { content: json({ skipped: true, reason: '还没有已批准的制片圣经；先 plan_story / plan_shots' }) };
        const project = (await ctx.port.snapshot(ctx.projectId)).project; if (!project) throw new Error('没有打开的工程');
        const threshold = Number.isFinite(Number(args.threshold)) ? Math.max(1, Math.min(100, Number(args.threshold))) : 75;
        const { selected: frames, uncheckedShotIds } = visualFrames(project, args.shotIds, 6);
        if (!frames.length) return { content: json({ skipped: true, reason: '没有可检查的镜头' }) };
        const images = []; for (const f of frames) { const shot = await ctx.port.capture(ctx.projectId, f.frame, ctx.signal); images.push({ mime: shot.mime, bytes: shot.bytes }); }
        const expect = frames.map(f => {
          const planned = story.shots.find(s => s.shotId === f.shotId || s.id === f.shotId);
          const loc = planned?.locationId ? (story.locations ?? []).find(l => l.id === planned.locationId)?.name : undefined;
          return `${f.shotId}：${planned ? planned.summary + (loc ? `；场景=${loc}` : '') + '；角色=' + (planned.characters.map(id => story.characters.find(c => c.id === id)?.name ?? id).join('、') || '无') : '（计划外镜头）'}`;
        }).join('\n');
        const answer = await ctx.port.vision(`对照制片圣经检查每张关键帧的角色、场景、道具与美术风格一致性（图片顺序同下列镜头）。\n风格：${JSON.stringify(story.style)}\n角色特征：${story.characters.map(c => `${c.name}=${[c.description, ...c.features].join('，')}`).join('；') || '无'}\n场景母版：${(story.locations ?? []).map(l => `${l.name}=${l.description}`).join('；') || '无'}\n镜头：\n${expect}\n只输出 JSON：{"scores":[{"shotId":"","score":0-100,"notes":"不一致之处"}]}`, images, ctx.signal);
        let scores: { shotId: string; score: number; notes: string }[] = [];
        try { const v = JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1)); scores = (Array.isArray(v.scores) ? v.scores : []).filter((x: { shotId?: unknown }) => frames.some(f => f.shotId === x.shotId)).map((x: { shotId: string; score: unknown; notes?: unknown }) => ({ shotId: x.shotId, score: Math.max(0, Math.min(100, Math.round(Number(x.score) || 0))), notes: String(x.notes ?? '').slice(0, 300) })); }
        catch { return { content: json({ error: '视觉模型没有返回可解析的分数', raw: bound(answer, 800) }) }; }
        const at = new Date().toISOString();
        await ctx.docs.updateStory(current => ({ ...current, consistency: { ...current.consistency, ...Object.fromEntries(scores.map(s => [s.shotId, { ...s, at }])) } }));
        const low = scores.filter(s => s.score < threshold);
        return { content: json({ threshold, scores, uncheckedShotIds, proposals: low.map(s => ({ shotId: s.shotId, action: '建议重生或调色对齐', how: '可用 stylize_keyframe + generate_video 重生（需用户批准），或用 shot_patch 调整 colorGrade 色彩匹配', notes: s.notes })) }) };
      } },
    { name: 'quality_check', risk: 'read', description: '导出前全量声画质检：Schema v3 制作策略校验、导演计划完整性、多采样点黑帧/纯色帧检测、声学响度/削波实测、静音与字幕越界检查。', parameters: object({}),
      async run(_args, ctx) { return { content: json(await qualityCheck(ctx)) }; } },

    // ==================== 10. 协作宏与工业成片/交换格式交付 ====================
    { name: 'run_workflow', risk: 'cost', description: '宏工具：一次运行工作台的固定协作流程（导演→画面→配音），需要用户批准。',
      parameters: object({ expectedRevision: int('当前工程版本'), prompt: str('制作要求'), visual: { type: 'string', enum: ['code', 'image', 'video'], description: '画面类型' }, narration: bool('是否配音（需已接入配音）') }, ['expectedRevision', 'prompt']),
      estimate: () => null,
      async run(args, ctx) {
        const roles = (await ctx.port.capabilities?.().catch(() => null))?.roles ?? [];
        const visual = args.visual === undefined ? (roles.includes('video') ? 'video' : roles.includes('image') ? 'image' : 'code') : String(args.visual);
        if (!['code', 'image', 'video'].includes(visual)) throw new Error('visual 须为 code / image / video');
        if (visual !== 'code' && !roles.includes(visual as 'image' | 'video')) throw new Error(`未接入${visual === 'image' ? '图片' : '视频'}生成模型，不能用 visual=${visual}；改用 code`);
        const narration = args.narration === true; if (narration && !roles.includes('speech')) throw new Error('未接入配音，不能 narration=true');
        const record = await rpc(ctx, 'workflows.run', { expectedRevision: revision(args), prompt: need(args, 'prompt'), visual, narration, review: false, allowImageUpload: false }) as { id: string };
        return { content: json({ workflowId: record.id, visual, narration }), waitFor: { kind: 'workflow', id: record.id } };
      } },
    { name: 'export_mp4', risk: 'export', description: '导出当前版本为 MP4 成片（需要用户批准）。导出前自动执行全量声画质检；有严重问题时阻断导出，确需导出传 force=true。',
      parameters: object({ force: bool('质检未通过时是否强制导出'), retryTaskId: str('明确重试的失败/取消导出任务 ID') }),
      async run(args, ctx) {
        const report = await qualityCheck(ctx);
        if (!report.pass && args.force !== true) return { content: json({ ok: false, blocked: true, status: report.status, message: report.status === 'partial' ? '导出前质检未完成：部分关键帧没有检查（见 unchecked），不能视为通过。修复后重试，或确认后用 force=true 强制导出' : '导出前质检未通过，先修复下列问题（或确认后用 force=true 强制导出）', issues: report.issues, unchecked: report.unchecked }) };
        let snapshot: StudioSnapshot;
        if (args.retryTaskId !== undefined) {
          const taskId = need(args, 'retryTaskId');
          const { tasks } = await rpc(ctx, 'tasks', {}) as { tasks: { id: string; kind: string; status: string; retryable: boolean }[] };
          const previous = tasks.find(task => task.id === taskId);
          if (!previous || previous.kind !== 'export' || !['failed', 'cancelled'].includes(previous.status) || !previous.retryable) throw new Error('retryTaskId 必须是本工程可重试的失败或取消导出任务');
          const current = await ctx.port.snapshot(ctx.projectId);
          snapshot = await rpc(ctx, 'retry', { taskId, expectedRevision: current.project?.revision }) as StudioSnapshot;
        } else snapshot = await rpc(ctx, 'export', {}) as StudioSnapshot;
        const task = projectTask(snapshot);
        return { content: json({ ok: true, taskId: task.id, ...(task.retryOf ? { retryOf: task.retryOf } : {}), message: '已开始导出 MP4 成片，可在「任务记录」查看进度', qc: { status: report.status, pass: report.pass, issues: report.issues.length, unchecked: report.unchecked.length, forced: !report.pass } }), projectTask: task };
      } },
    { name: 'export_delivery_bundle', risk: 'export', description: '导出工业级影视后期交付包（需用户批准）：在工程 exports 目录下生成标准外挂字幕（.srt / .ass）与专业剪辑交换时间轴（OpenTimelineIO .otio / Final Cut Pro .fcpxml / CMX3600 .edl），供达芬奇、Premiere、Final Cut 或剪映无缝精修。',
      parameters: object({
        formats: { type: 'array', items: { type: 'string', enum: ['srt', 'ass', 'otio', 'fcpxml', 'edl'] }, description: '要导出的交付格式列表（默认全部导出）' },
      }),
      async run(args, ctx) {
        const value = await rpc(ctx, 'delivery.export', { ...(Array.isArray(args.formats) && args.formats.length ? { formats: args.formats } : {}) });
        return { content: json({ ok: true, ...(value as Record<string, unknown>) }) };
      } },
  ];
  return tools;
}

/** Select the tools exposed to the model for the currently bound generation roles. */
export function activeTools(all: AgentTool[], capabilities: Capabilities): AgentTool[] {
  const roles = new Set(capabilities.roles);
  return all.filter(tool => (tool.requires ?? []).every(role => roles.has(role)) && !(tool.fallbackFor ?? []).some(role => roles.has(role)))
    .filter(tool => tool.name !== 'media_apply' || roles.has('image') || roles.has('video'))
    .filter(tool => tool.name !== 'batch_generate_media' || roles.has('image') || roles.has('video'));
}
