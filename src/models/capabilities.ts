import { OFFICIAL_MEDIA_PROTOCOLS, type ModelProtocol, type ResolvedModel } from './contracts.ts';
import type { MediaOperation, MediaRequest } from '../jobs/contracts.ts';

export class MediaCapabilityError extends Error {
  readonly code = 'UNSUPPORTED_MEDIA_CAPABILITY';
  readonly submissionUncertain = false;
  constructor(message: string) { super(message); this.name = 'MediaCapabilityError'; }
}

const VIDEO = new Set<ModelProtocol>(['openai-videos', 'kling-video', 'minimax-video', 'volc-video', 'dashscope-video', 'gemini-video']);

export function assertOfficialCapability(resolved: ResolvedModel, input: Pick<MediaRequest, 'operation' | 'imageAssetIds' | 'parameters'> & { requiresAudio?: boolean }): void {
  const protocol = resolved.connection.protocol;
  if (!OFFICIAL_MEDIA_PROTOCOLS.includes(protocol)) return;
  const image = protocol === 'gemini-image';
  const operations: MediaOperation[] = image ? ['text-to-image'] : ['text-to-video', 'image-to-video'];
  if (!operations.includes(input.operation)) throw new MediaCapabilityError('该官方协议不支持此生成操作');
  const maxRefs = image || !VIDEO.has(protocol) ? 0 : 1;
  const refs = input.imageAssetIds?.length ?? 0;
  if (refs > maxRefs) throw new MediaCapabilityError('参考图数量超过该协议预检上限');
  const wantsAudio = input.requiresAudio === true || input.parameters?.requiresAudio === true;
  if (wantsAudio) throw new MediaCapabilityError('该协议没有已确认的原生音轨，不能把未知当成有声音');
}
