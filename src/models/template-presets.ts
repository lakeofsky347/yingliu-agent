// Shared configuration data only: safe to import from the renderer.
export interface TaskTemplate {
  submitPath: string; submitMethod: 'POST' | 'PUT'; submitBody: string;
  /** Dot path to the remote job id in the submit response. Empty → synchronous result. */
  idPath: string; pollPath: string; pollMethod: 'GET' | 'POST';
  statusPath: string; statusMap: string; resultPath: string; resultMime: string;
  errorPath: string; progressPath: string; progressScale: number; cancelPath: string; checkPath: string;
  /** json (default) or binary (submit response body is the media itself, e.g. TTS/SFX). */
  responseType: 'json' | 'binary';
  authHttpName: string; authPrefix: string; extraHttpName: string; extraHttpValue: string;
}
export const TEMPLATE_PRESETS: Record<string, { label: string; output: 'image' | 'video' | 'audio'; template: Partial<TaskTemplate> }> = {
  'dashscope-image': { label: '通义万相 文生图（DashScope 异步）', output: 'image', template: {
    submitPath: '/services/aigc/text2image/image-synthesis', submitBody: '{"model":"{{model}}","input":{"prompt":"{{prompt}}"},"parameters":{"size":"{{param.size|1024*1024}}","n":1}}',
    extraHttpName: 'X-DashScope-Async', extraHttpValue: 'enable', idPath: 'output.task_id', pollPath: '/tasks/{{id}}', statusPath: 'output.task_status', resultPath: 'output.results[].url', errorPath: 'output.message',
    statusMap: 'PENDING:queued,RUNNING:running,SUCCEEDED:succeeded,FAILED:failed,CANCELED:cancelled,UNKNOWN:failed', checkPath: '' } },
  'dashscope-video': { label: '通义万相 生视频（DashScope 异步）', output: 'video', template: {
    submitPath: '/services/aigc/video-generation/video-synthesis', submitBody: '{"model":"{{model}}","input":{"prompt":"{{prompt}}","img_url":"{{image}}"},"parameters":{"duration":"{{duration|5}}"}}',
    extraHttpName: 'X-DashScope-Async', extraHttpValue: 'enable', idPath: 'output.task_id', pollPath: '/tasks/{{id}}', statusPath: 'output.task_status', resultPath: 'output.video_url', errorPath: 'output.message',
    statusMap: 'PENDING:queued,RUNNING:running,SUCCEEDED:succeeded,FAILED:failed,CANCELED:cancelled,UNKNOWN:failed' } },
  'kling-video': { label: '可灵 生视频（text2video / image2video）', output: 'video', template: {
    submitPath: '/v1/videos/text2video', submitBody: '{"model_name":"{{model}}","prompt":"{{prompt}}","duration":"{{duration|5}}"}',
    idPath: 'data.task_id', pollPath: '/v1/videos/text2video/{{id}}', statusPath: 'data.task_status', resultPath: 'data.task_result.videos[].url', errorPath: 'data.task_status_msg',
    statusMap: 'submitted:queued,processing:running,succeed:succeeded,failed:failed' } },
  'ark-video': { label: '火山方舟 / 即梦 Seedance 生视频', output: 'video', template: {
    submitPath: '/contents/generations/tasks', submitBody: '{"model":"{{model}}","content":[{"type":"text","text":"{{prompt}}"}]}',
    idPath: 'id', pollPath: '/contents/generations/tasks/{{id}}', statusPath: 'status', resultPath: 'content.video_url', errorPath: 'error.message', cancelPath: '' } },
  'runway-video': { label: 'Runway 生视频（image_to_video）', output: 'video', template: {
    submitPath: '/v1/image_to_video', submitBody: '{"model":"{{model}}","promptText":"{{prompt}}","promptImage":"{{image}}","duration":{{duration|5}}}',
    extraHttpName: 'X-Runway-Version', extraHttpValue: '2024-11-06', idPath: 'id', pollPath: '/v1/tasks/{{id}}', statusPath: 'status', resultPath: 'output[]', errorPath: 'failure',
    statusMap: 'PENDING:queued,THROTTLED:queued,RUNNING:running,SUCCEEDED:succeeded,FAILED:failed,CANCELLED:cancelled' } },
  'replicate': { label: 'Replicate 官方模型（owner/name）', output: 'image', template: {
    submitPath: '/models/{{modelOwner}}/{{modelName}}/predictions', submitBody: '{"input":{"prompt":"{{prompt}}"}}', idPath: 'id', pollPath: '/predictions/{{id}}', statusPath: 'status', resultPath: 'output', errorPath: 'error', cancelPath: '/predictions/{{id}}/cancel' } },
  'replicate-version': { label: 'Replicate 指定版本（社区模型）', output: 'image', template: {
    submitPath: '/predictions', submitBody: '{"version":"{{model}}","input":{"prompt":"{{prompt}}"}}', idPath: 'id', pollPath: '/predictions/{{id}}', statusPath: 'status', resultPath: 'output', errorPath: 'error', cancelPath: '/predictions/{{id}}/cancel' } },
  'elevenlabs-sfx': { label: 'ElevenLabs 音效（同步二进制）', output: 'audio', template: {
    submitPath: '/v1/sound-generation', submitBody: '{"text":"{{prompt}}","duration_seconds":{{duration|3}}}', responseType: 'binary', resultMime: 'audio/mpeg', idPath: '', authHttpName: 'xi-api-key', authPrefix: '' } },
  'openai-speech': { label: 'OpenAI 兼容 TTS（/audio/speech，同步二进制）', output: 'audio', template: {
    submitPath: '/audio/speech', submitBody: '{"model":"{{model}}","input":"{{prompt}}","voice":"{{param.voice|alloy}}","response_format":"mp3"}', responseType: 'binary', resultMime: 'audio/mpeg', idPath: '' } },
  'generic-async': { label: '通用异步任务（自定义字段）', output: 'image', template: {} },
};

