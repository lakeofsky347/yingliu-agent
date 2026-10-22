import { compileDirectorPlan } from '../app/conversation.ts';
import type { ChatInput } from '../app/contracts.ts';
import type { AgentTool, JsonSchema, ToolContext, ToolResult } from './contracts.ts';
import { bound, summarizeProject } from './context.ts';
import { synthesize, type SynthSpec } from './synth.ts';
import type { Capabilities } from './contracts.ts';

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string): JsonSchema => ({ type: 'string', description });
const int = (description: string): JsonSchema => ({ type: 'integer', description });
const json = (value: unknown) => bound(JSON.stringify(value));

function need(args: Record<string, unknown>, key: string): string { const value = args[key]; if (typeof value !== 'string' || !value.trim()) throw new Error(`参数 ${key} 必填`); return value; }
function revision(args: Record<string, unknown>): number { const value = args.expectedRevision; if (!Number.isSafeInteger(value)) throw new Error('参数 expectedRevision 必须是整数；先调用 project_get'); return value as number; }
async function rpc(ctx: ToolContext, endpoint: string, payload: Record<string, unknown>) {
  const result = await ctx.port.route(endpoint, { projectId: ctx.projectId, ...payload });
  if (!result.ok) throw Object.assign(new Error(result.error?.message ?? '操作失败'), { code: result.error?.code });
  return result.value;
}
function agentInput(ctx: ToolContext, message: string): ChatInput { return { message, projectId: ctx.projectId, provider: 'agent', model: 'agent', intent: 'modify' }; }

/** Apply a director-protocol action (video_update / video_audio) through the same validator the chat path uses. */
async function directorAction(ctx: ToolContext, tool: 'video_update' | 'video_audio', args: Record<string, unknown>, structural: boolean, label: string): Promise<ToolResult> {
  const snapshot = await ctx.port.snapshot(ctx.projectId);
  const creating = !snapshot.project?.shots.length;
  const message = structural ? '按智能体计划添加、删除或重排镜头' : '按智能体计划修改';
  const plan = compileDirectorPlan({ intent: creating ? 'create' : 'modify', message: label, actions: [{ tool, arguments: args }] }, snapshot, agentInput(ctx, message), creating ? 'create' : 'modify');
  if (!plan.candidate || !plan.mutated) return { content: '计划没有产生修改。' };
  const sources = Object.fromEntries(plan.sources.map(item => [item.shotId, item.source]));
  const next = await ctx.port.commit(ctx.projectId, snapshot.project?.revision ?? 0, plan.candidate, sources, '智能体：' + label);
  return { content: json({ ok: true, revision: next.project?.revision, project: summarizeProject(next.project) }), revision: next.project?.revision };
}

export function createTools(): AgentTool[] {
  const tools: AgentTool[] = [
    { name: 'project_get', risk: 'read', description: '读取当前工程摘要：版本号、镜头、素材、输出规格。修改前先调用。', parameters: object({}),
      async run(_args, ctx) { const snapshot = await ctx.port.snapshot(ctx.projectId); return { content: json({ ...summarizeProject(snapshot.project), task: snapshot.task ? { kind: snapshot.task.kind, status: snapshot.task.status, message: snapshot.task.message } : null }), revision: snapshot.project?.revision }; } },
    { name: 'shot_read_source', risk: 'read', description: '读取一个镜头的 HTML/CSS/JS 源码。', parameters: object({ shotId: str('镜头 ID') }, ['shotId']),
      async run(args, ctx) { return { content: json(await ctx.port.readSource(ctx.projectId, need(args, 'shotId'))) }; } },
    { name: 'env_check', risk: 'read', description: '检查本机 Chrome/FFmpeg/ffprobe 是否可用（渲染和导出所需）。', parameters: object({}),
      async run(_args, ctx) { const { environment } = await ctx.port.snapshot(ctx.projectId); const e = environment as unknown as Record<string, unknown>; return { content: json({ browserAvailable: e.browserAvailable, ffmpegAvailable: e.ffmpegAvailable, ffprobeAvailable: e.ffprobeAvailable }) }; } },
    { name: 'task_status', risk: 'read', description: '查询媒体生成任务或协作流程的状态。', parameters: object({ kind: { type: 'string', enum: ['media', 'workflow'] }, id: str('任务 ID') }, ['kind', 'id']),
      async run(args, ctx) { const value = await rpc(ctx, args.kind === 'workflow' ? 'workflows.get' : 'media.get', args.kind === 'workflow' ? { workflowId: need(args, 'id') } : { taskId: need(args, 'id') }); return { content: json(value) }; } },
    { name: 'video_update', risk: 'write', description: '修改分镜：标题/主题/时长/输出规格、镜头参数（shotPatches）、添加/删除/重排镜头、替换镜头源码（sourcesByIndex 或 sources）。参数与导演协议 video_update 相同，必须带 expectedRevision。',
      parameters: object({ expectedRevision: int('当前工程版本'), update: { type: 'object', description: '导演协议 update 对象' }, structural: { type: 'boolean', description: '是否增删或重排镜头' }, label: str('本次修改的简短说明') }, ['expectedRevision', 'update']),
      async run(args, ctx) { revision(args); const { structural, label, ...rest } = args; return directorAction(ctx, 'video_update', rest, structural === true, typeof label === 'string' ? label : '修改分镜'); } },
    { name: 'shot_write_source', risk: 'write', description: '保存一个镜头的完整源码 {html,css,js}；保存后会执行场景检查。', parameters: object({ expectedRevision: int('当前工程版本'), shotId: str('镜头 ID'), source: object({ html: str('HTML'), css: str('CSS'), js: str('ES 模块，导出 render(ctx)') }, ['html', 'css', 'js']) }, ['expectedRevision', 'shotId', 'source']),
      async run(args, ctx) {
        const source = args.source as { html: string; css: string; js: string };
        if (!source || [source.html, source.css, source.js].some(part => typeof part !== 'string')) throw new Error('source 须包含 html/css/js 字符串');
        if (source.html.length + source.css.length + source.js.length > 2_000_000) throw new Error('单镜头源码超过 2MB 上限');
        const next = await ctx.port.saveSource(ctx.projectId, need(args, 'shotId'), revision(args), source);
        return { content: json({ ok: true, revision: next.project?.revision }), revision: next.project?.revision };
      } },
    { name: 'audio_edit', risk: 'write', description: '编辑音轨（导演协议 video_audio：添加/移除旁白、音乐、音效，增益与位置）。', parameters: object({ action: str('add/remove/update'), request: { type: 'object' } }, ['action']),
      async run(args, ctx) { return directorAction(ctx, 'video_audio', args, false, '编辑音轨'); } },
    { name: 'undo', risk: 'write', description: '撤销上一次工程修改。', parameters: object({}),
      async run(_args, ctx) { await rpc(ctx, 'undo', {}); const snapshot = await ctx.port.snapshot(ctx.projectId); return { content: json({ ok: true, revision: snapshot.project?.revision }), revision: snapshot.project?.revision }; } },
    { name: 'render_check', risk: 'read', description: '刷新预览并检查资源与关键帧，返回渲染错误。', parameters: object({}),
      async run(_args, ctx) {
        await rpc(ctx, 'preview', {});
        for (let i = 0; i < 240; i++) { ctx.signal.throwIfAborted(); const s = await ctx.port.snapshot(ctx.projectId); if (!s.task || s.task.kind !== 'preview' || s.task.status !== 'running') return { content: json({ status: s.task?.status ?? 'complete', message: s.task?.message, error: s.task?.error }) }; await new Promise(r => setTimeout(r, 250)); }
        return { content: json({ status: 'timeout', message: '预览检查超过 60 秒' }) };
      } },
    { name: 'capture_frame', risk: 'read', description: '截取指定帧的画面，用于你自己查看（需要视觉模型）。', parameters: object({ frame: int('帧序号，从 0 开始') }, ['frame']),
      async run(args, ctx) { const frame = Number(args.frame); if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('frame 无效'); const shot = await ctx.port.capture(ctx.projectId, frame, ctx.signal); return { content: json({ frame: shot.frame, shotId: shot.shotId }), images: [{ mime: shot.mime, bytes: shot.bytes }] }; } },
    { name: 'visual_review', risk: 'read', requires: ['vision'], description: '截取每个镜头的关键帧，交给视觉检查模型，返回结构化问题列表（镜头、帧、问题、严重度、建议）。修改后用它自检。', parameters: object({ shotIds: { type: 'array', items: { type: 'string' } } }),
      async run(args, ctx) {
        const snapshot = await ctx.port.snapshot(ctx.projectId), project = snapshot.project; if (!project) throw new Error('没有打开的工程');
        if (!ctx.port.vision) return { content: json({ skipped: true, reason: '未配置视觉检查模型（vision 角色）；请改用 render_check' }) };
        const wanted = Array.isArray(args.shotIds) ? new Set(args.shotIds.map(String)) : null;
        let start = 0; const frames: { frame: number; shotId: string }[] = [];
        for (const id of project.shotOrder.length ? project.shotOrder : project.shots.map(s => s.id)) { const shot = project.shots.find(s => s.id === id)!; if (!wanted || wanted.has(id)) frames.push({ frame: start + Math.floor(shot.durationFrames / 2), shotId: id }); start += shot.durationFrames; }
        const images = [] as { mime: string; bytes: Uint8Array }[];
        for (const item of frames.slice(0, 6)) { const shot = await ctx.port.capture(ctx.projectId, item.frame, ctx.signal); images.push({ mime: shot.mime, bytes: shot.bytes }); }
        const answer = await ctx.port.vision('逐张检查视频关键帧（顺序对应镜头 ' + frames.slice(0, 6).map(f => f.shotId).join(', ') + '）。只输出 JSON：{"pass":true|false,"issues":[{"shotId":"","problem":"","severity":"low|medium|high","suggestion":""}]}。检查文字溢出/遮挡、空白画面、对比度、元素越界、与镜头意图不符。', images, ctx.signal);
        return { content: bound(answer, 4000) };
      } },
    { name: 'generate_image', risk: 'cost', requires: ['image'], description: '用图片模型生成素材（产生费用，需要用户批准）。完成后用 media_apply 采用。', parameters: object({ expectedRevision: int('当前工程版本'), prompt: str('画面描述'), shotId: str('关联镜头') }, ['expectedRevision', 'prompt']),
      estimate: () => null,
      async run(args, ctx) { const task = await rpc(ctx, 'media.generate', { expectedRevision: revision(args), operation: 'text-to-image', prompt: need(args, 'prompt'), ...(args.shotId ? { shotId: args.shotId } : {}), clientRequestId: `${ctx.runId}.${String(args.__callId ?? '')}` }) as { id: string }; return { content: json({ taskId: task.id }), waitFor: { kind: 'media', id: task.id } }; } },
    { name: 'generate_video', risk: 'cost', requires: ['video'], description: '用视频模型生成片段（产生费用，需要用户批准）。', parameters: object({ expectedRevision: int('当前工程版本'), prompt: str('画面与运动描述'), shotId: str('关联镜头'), imageAssetId: str('可选：首帧图片素材 ID') }, ['expectedRevision', 'prompt']),
      estimate: () => null,
      async run(args, ctx) { const task = await rpc(ctx, 'media.generate', { expectedRevision: revision(args), operation: args.imageAssetId ? 'image-to-video' : 'text-to-video', prompt: need(args, 'prompt'), ...(args.shotId ? { shotId: args.shotId } : {}), ...(args.imageAssetId ? { imageAssetIds: [args.imageAssetId], allowImageUpload: true } : {}), clientRequestId: `${ctx.runId}.${String(args.__callId ?? '')}` }) as { id: string }; return { content: json({ taskId: task.id }), waitFor: { kind: 'media', id: task.id } }; } },
    { name: 'media_apply', risk: 'write', description: '把已就绪的生成素材采用到工程。', parameters: object({ taskId: str('媒体任务 ID'), expectedRevision: int('当前工程版本') }, ['taskId', 'expectedRevision']),
      async run(args, ctx) { const value = await rpc(ctx, 'media.apply', { taskId: need(args, 'taskId'), expectedRevision: revision(args) }); return { content: json(value) }; } },
    { name: 'generate_voice', risk: 'cost', requires: ['speech'], description: '为镜头生成配音（产生费用，需要用户批准）。', parameters: object({ shotId: str('镜头 ID'), text: str('旁白文字') }, ['shotId', 'text']),
      estimate: () => null,
      async run(args, ctx) { if (!ctx.port.voice) throw new Error('未配置配音'); const asset = await ctx.port.voice(ctx.projectId, need(args, 'shotId'), need(args, 'text'), ctx.signal); return { content: json({ ok: true, assetId: asset.id, name: asset.name }) }; } },
    { name: 'generate_music', risk: 'cost', requires: ['music'], description: '用已接入的音乐模型生成背景音乐并导入为素材（产生费用，需要用户批准）。之后用 audio_edit 放到音轨。', parameters: object({ prompt: str('风格、情绪、乐器、节奏'), durationSeconds: { type: 'number', description: '时长（秒）' } }, ['prompt']),
      estimate: () => null,
      async run(args, ctx) { if (!ctx.port.generateAudio) throw new Error('未配置音乐生成'); const asset = await ctx.port.generateAudio(ctx.projectId, 'music', need(args, 'prompt'), { durationSeconds: Number(args.durationSeconds) || undefined, signal: ctx.signal }); return { content: json({ ok: true, assetId: asset.id, name: asset.name, hint: '用 audio_edit 把它加入音轨' }), cost: asset.cost ?? null }; } },
    { name: 'generate_sfx', risk: 'cost', requires: ['sfx'], description: '用已接入的音效模型生成音效并导入为素材（产生费用，需要用户批准）。', parameters: object({ prompt: str('音效描述'), durationSeconds: { type: 'number', description: '时长（秒）' } }, ['prompt']),
      estimate: () => null,
      async run(args, ctx) { if (!ctx.port.generateAudio) throw new Error('未配置音效生成'); const asset = await ctx.port.generateAudio(ctx.projectId, 'sfx', need(args, 'prompt'), { durationSeconds: Number(args.durationSeconds) || undefined, signal: ctx.signal }); return { content: json({ ok: true, assetId: asset.id, name: asset.name, hint: '用 audio_edit 把它加入音轨' }), cost: asset.cost ?? null }; } },
    { name: 'synthesize_sfx', risk: 'write', fallbackFor: ['sfx'], description: '未接入音效模型时，在本地合成简单音效（提示音、扫频、风声、点击、钟声、噪声冲击）并导入为音频素材，免费。之后用 audio_edit 放到音轨。',
      parameters: object({ name: str('素材名称'), kind: { type: 'string', enum: ['tone', 'sweep', 'chime', 'noise', 'whoosh', 'click'] }, durationSeconds: { type: 'number' }, frequency: { type: 'number' }, endFrequency: { type: 'number' }, volume: { type: 'number' } }, ['kind', 'durationSeconds']),
      async run(args, ctx) {
        if (!ctx.port.importAudio) throw new Error('当前环境不能导入音频');
        const kind = String(args.kind); if (!['tone', 'sweep', 'chime', 'noise', 'whoosh', 'click'].includes(kind)) throw new Error('kind 无效');
        const bytes = synthesize({ ...(args as unknown as SynthSpec), kind: kind as SynthSpec['kind'] });
        const asset = await ctx.port.importAudio(ctx.projectId, typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 60) : '合成音效 · ' + kind, bytes, 'audio/wav');
        return { content: json({ ok: true, assetId: asset.id, name: asset.name, bytes: bytes.length, hint: '用 audio_edit 把它加入音轨' }) };
      } },
    { name: 'run_workflow', risk: 'cost', description: '启动固定协作流程（导演→画面→配音→视觉检查），可能调用生成模型（需要用户批准）。', parameters: object({ expectedRevision: int('当前工程版本'), prompt: str('制作要求') }, ['expectedRevision', 'prompt']),
      estimate: () => null,
      async run(args, ctx) { const record = await rpc(ctx, 'workflows.run', { expectedRevision: revision(args), prompt: need(args, 'prompt') }) as { id: string }; return { content: json({ workflowId: record.id }), waitFor: { kind: 'workflow', id: record.id } }; } },
    { name: 'export_mp4', risk: 'export', description: '导出当前版本为 MP4（需要用户批准）。', parameters: object({}),
      async run(_args, ctx) { await rpc(ctx, 'export', {}); return { content: json({ ok: true, message: '已开始导出，可在「任务记录」查看进度' }) }; } },
  ];
  return tools;
}

/** Select the tools exposed to the model for the currently bound generation roles. */
export function activeTools(all: AgentTool[], capabilities: Capabilities): AgentTool[] {
  const roles = new Set(capabilities.roles);
  return all.filter(tool => (tool.requires ?? []).every(role => roles.has(role)) && !(tool.fallbackFor ?? []).some(role => roles.has(role)))
    .filter(tool => tool.name !== 'media_apply' || roles.has('image') || roles.has('video'));
}
