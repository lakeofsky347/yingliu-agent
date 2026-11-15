import type { AdapterContext, AdapterInput } from './media.ts';
import type { RemoteJob } from '../../jobs/contracts.ts';
import type { ModelProtocol } from '../contracts.ts';

const PATHS: Record<string, { submit: string; poll: (id: string) => string; cancel: (id: string) => string }> = {
  'gemini-image': { submit: '/models/{model}:generateContent', poll: id => '/operations/' + id, cancel: id => '/operations/' + id + ':cancel' },
  'openai-videos': { submit: '/videos', poll: id => '/videos/' + id, cancel: id => '/videos/' + id + '/cancel' },
  'kling-video': { submit: '/v1/videos/text2video', poll: id => '/v1/videos/' + id, cancel: id => '/v1/videos/' + id + '/cancel' },
  'minimax-video': { submit: '/v1/video_generation', poll: id => '/v1/query/video_generation?task_id=' + id, cancel: id => '/v1/video_generation/' + id + '/cancel' },
  'volc-video': { submit: '/contents/generations/tasks', poll: id => '/contents/generations/tasks/' + id, cancel: id => '/contents/generations/tasks/' + id + '/cancel' },
  'dashscope-video': { submit: '/services/aigc/video-generation/video-synthesis', poll: id => '/tasks/' + id, cancel: id => '/tasks/' + id + '/cancel' },
  'gemini-video': { submit: '/models/{model}:predictLongRunning', poll: id => '/' + id.replace(/^\//, ''), cancel: id => '/' + id.replace(/^\//, '') + ':cancel' },
};

function paths(protocol: ModelProtocol) {
  const found = PATHS[protocol];
  if (!found) throw new Error('不是官方媒体协议');
  return found;
}

async function call(context: AdapterContext, path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (context.connection.auth === 'bearer' && !context.key) throw Object.assign(new Error('媒体服务凭据不可用，请配置或解锁后重试'), { code: 'NEEDS_CREDENTIALS' });
  const url = context.connection.baseUrl.replace(/\/+$/, '') + path.replace('{model}', encodeURIComponent('model'));
  const response = await (context.fetch ?? fetch)(url, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(context.connection.auth === 'bearer' ? { Authorization: 'Bearer ' + context.key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(context.connection.requestTimeoutMs)]),
  });
  if (!response.ok) throw Object.assign(new Error('官方媒体接口请求失败（HTTP ' + response.status + '）'), { httpStatus: response.status });
  const value = await response.json() as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('官方媒体接口返回无效对象');
  return value as Record<string, unknown>;
}

function jobFrom(data: Record<string, unknown>, fallbackId: string): RemoteJob {
  const id = String(data.id ?? data.jobId ?? data.task_id ?? data.name ?? fallbackId);
  const raw = String(data.status ?? 'queued');
  const status = raw === 'succeeded' || raw === 'completed' || raw === 'success' ? 'succeeded' : raw === 'failed' ? 'failed' : raw === 'cancelled' || raw === 'canceled' ? 'cancelled' : raw === 'running' ? 'running' : 'queued';
  const url = typeof data.url === 'string' ? data.url : undefined;
  return { jobId: id, status, ...(status === 'succeeded' && url ? { artifacts: [{ url, mimeType: 'video/mp4' }] } : {}) };
}

export async function officialSubmit(context: AdapterContext, input: AdapterInput): Promise<RemoteJob> {
  const route = paths(context.connection.protocol);
  const data = await call(context, route.submit.replace('{model}', encodeURIComponent(input.model.model)), { model: input.model.model, prompt: input.prompt, parameters: input.parameters });
  return jobFrom(data, input.clientRequestId);
}
export async function officialPoll(context: AdapterContext, jobId: string): Promise<RemoteJob> {
  return jobFrom(await call(context, paths(context.connection.protocol).poll(jobId)), jobId);
}
export async function officialCancel(context: AdapterContext, jobId: string): Promise<RemoteJob> {
  return jobFrom(await call(context, paths(context.connection.protocol).cancel(jobId), {}), jobId);
}
