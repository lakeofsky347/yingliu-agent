import type { ModelProtocol, ModelRole, Modality } from './contracts.ts';
import { MODEL_PROTOCOLS, ROLE_PROTOCOLS } from './contracts.ts';

export type MediaKind = 'text' | 'image' | 'video' | 'speech' | 'custom';

export interface ProtocolInfo {
  id: ModelProtocol;
  kind: MediaKind;
  label: string;
  vendor: string;
  summary: string;
  baseUrl: string;
  modelDiscovery?: 'openai' | 'gemini' | 'volc' | 'dashscope';
}

/** Official request shapes live in official.ts; async-task uses template.ts for custom providers. */
export const PROTOCOL_CATALOG: readonly ProtocolInfo[] = [
  {id:'chat-completions', kind:'text', label:'Chat Completions', vendor:'OpenAI 兼容', summary:'文本与视觉理解。沿用 OpenAI Chat Completions JSON / SSE。', baseUrl:'https://api.openai.com/v1', modelDiscovery:'openai'},
  {id:'images', kind:'image', label:'OpenAI Images', vendor:'OpenAI 兼容', summary:'文生图。POST /images/generations，返回 url 或 b64_json。', baseUrl:'https://api.openai.com/v1', modelDiscovery:'openai'},
  {id:'gemini-image', kind:'image', label:'Gemini 图像', vendor:'Google', summary:'文生图。POST /models/{model}:generateContent，responseModalities 含 IMAGE。', baseUrl:'https://generativelanguage.googleapis.com/v1beta', modelDiscovery:'gemini'},
  {id:'video-gateway', kind:'video', label:'映流媒体网关 v1', vendor:'映流', summary:'标准视频任务协议：POST /v1/media/jobs。', baseUrl:''},
  {id:'openai-videos', kind:'video', label:'OpenAI Videos', vendor:'OpenAI', summary:'文生视频 / 参考图生视频。POST /videos，完成后从 /videos/{id}/content 下载。', baseUrl:'https://api.openai.com/v1', modelDiscovery:'openai'},
  {id:'kling-video', kind:'video', label:'可灵 Kling', vendor:'快手可灵', summary:'POST /v1/videos/text2video 或 image2video。密钥填 Bearer Token，或 accessKey:secretKey。', baseUrl:'https://api.klingai.com'},
  {id:'minimax-video', kind:'video', label:'MiniMax 视频', vendor:'MiniMax', summary:'POST /v1/video_generation，再用 /v1/query/video_generation 查询。', baseUrl:'https://api.minimaxi.com'},
  {id:'volc-video', kind:'video', label:'火山方舟 Seedance', vendor:'火山引擎', summary:'POST /contents/generations/tasks。Base URL 含 /api/v3。', baseUrl:'https://ark.cn-beijing.volces.com/api/v3', modelDiscovery:'volc'},
  {id:'dashscope-video', kind:'video', label:'百炼万相', vendor:'阿里云', summary:'异步 video-synthesis。国际站把域名换成 dashscope-intl.aliyuncs.com。', baseUrl:'https://dashscope.aliyuncs.com/api/v1', modelDiscovery:'dashscope'},
  {id:'gemini-video', kind:'video', label:'Gemini Veo', vendor:'Google', summary:'POST /models/{model}:predictLongRunning，再查询返回的 operation。', baseUrl:'https://generativelanguage.googleapis.com/v1beta', modelDiscovery:'gemini'},
  {id:'speech', kind:'speech', label:'OpenAI Speech', vendor:'OpenAI 兼容', summary:'配音。POST /audio/speech。', baseUrl:'https://api.openai.com/v1', modelDiscovery:'openai'},
  {id:'async-task', kind:'custom', label:'通用模板 / 异步任务', vendor:'自定义服务', summary:'可配置 JSON 模板：兼容音乐、音效、自定义 TTS 及任意第三方异步生成接口。', baseUrl:''},
];

const byId = new Map(PROTOCOL_CATALOG.map(item => [item.id, item]));

export function protocolInfo(id: ModelProtocol): ProtocolInfo {
  const info = byId.get(id);
  if (!info) throw new Error('未知模型协议');
  return info;
}
export function protocolKind(id: ModelProtocol): MediaKind { return protocolInfo(id).kind; }
export function protocolsOf(kind: MediaKind): ProtocolInfo[] { return PROTOCOL_CATALOG.filter(item => item.kind === kind); }
export function roleKind(role: ModelRole): MediaKind {
  if (role === 'image') return 'image';
  if (role === 'video') return 'video';
  if (role === 'speech') return 'speech';
  if (role === 'music' || role === 'sfx') return 'custom';
  return 'text';
}
export function protocolMatchesRole(protocol: ModelProtocol, role: ModelRole): boolean {
  return ROLE_PROTOCOLS[role].includes(protocol);
}
export function protocolOutput(protocol: ModelProtocol): Modality {
  const kind = protocolKind(protocol);
  return kind === 'image' ? 'image' : kind === 'video' ? 'video' : kind === 'speech' ? 'audio' : 'text';
}
export function catalogCoversProtocols(): boolean {
  const ids = PROTOCOL_CATALOG.map(item => item.id).sort();
  return ids.length === MODEL_PROTOCOLS.length && ids.every((id, index) => id === [...MODEL_PROTOCOLS].sort()[index]);
}
