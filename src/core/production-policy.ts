import type { VideoProject } from '../shared/types.ts';

export type ProductionMode = 'unresolved' | 'code_animation' | 'model_video' | 'hybrid';
export interface ProductionPolicy {
  version: 1;
  decisionId: string;
  mode: ProductionMode;
  allowGeneratedImages: boolean;
  allowImportedVideo: boolean;
  baseMode?: 'code_animation' | 'model_video';
}

const MODES: ProductionMode[] = ['unresolved', 'code_animation', 'model_video', 'hybrid'];

export function defaultProductionPolicy(projectId: string): ProductionPolicy {
  return { version: 1, decisionId: 'pending-' + projectId, mode: 'unresolved', allowGeneratedImages: false, allowImportedVideo: false };
}

export function normalizeProductionPolicy(project: VideoProject): ProductionPolicy {
  const policy = project.productionPolicy;
  if (policy && policy.version === 1 && typeof policy.decisionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(policy.decisionId) && MODES.includes(policy.mode) && typeof policy.allowGeneratedImages === 'boolean' && typeof policy.allowImportedVideo === 'boolean') {
    if (policy.mode === 'hybrid' && policy.baseMode !== 'code_animation' && policy.baseMode !== 'model_video') return defaultProductionPolicy(project.id);
    if (policy.mode !== 'hybrid' && policy.baseMode !== undefined) return defaultProductionPolicy(project.id);
    return policy;
  }
  return defaultProductionPolicy(project.id);
}

export function productionPolicyKey(policy: ProductionPolicy | undefined): string {
  return JSON.stringify(policy ?? null);
}

export function assertCanExport(project: VideoProject): void {
  if (project.productionPolicy?.mode && project.productionPolicy.mode !== 'unresolved') return;
  throw Object.assign(new Error('请先由用户确认本工程的制作模式，再导出成片'), { code: 'PRODUCTION_POLICY_VIOLATION', submissionUncertain: false });
}

export function assertCanGenerateMedia(project: Pick<VideoProject, 'productionPolicy'>, operation: 'text-to-image' | 'text-to-video' | 'image-to-video'): void {
  const policy = project.productionPolicy;
  if (!policy || policy.mode === 'unresolved') throw Object.assign(new Error('请先由用户确认本工程的制作模式'), { code: 'PRODUCTION_POLICY_VIOLATION', submissionUncertain: false });
  if (operation === 'text-to-image' && !policy.allowGeneratedImages) throw Object.assign(new Error('本工程尚未允许生成图片素材'), { code: 'PRODUCTION_POLICY_VIOLATION', submissionUncertain: false });
  if (operation !== 'text-to-image' && policy.mode === 'code_animation') throw Object.assign(new Error('当前模式不允许视频模型生成'), { code: 'PRODUCTION_POLICY_VIOLATION', submissionUncertain: false });
}

export const PROTECTED_EXTENSIONS = ['mediaApplications', 'workflowApplications', 'workflowInitializations', 'importApplications', 'directorDocument'] as const;

export function assertOrdinaryProjectSave(current: VideoProject, next: VideoProject): void {
  if (next.productionPolicy && productionPolicyKey(next.productionPolicy) !== productionPolicyKey(current.productionPolicy)) {
    throw Object.assign(new Error('普通保存不能更改制作模式'), { code: 'PRODUCTION_POLICY_VIOLATION' });
  }
  for (const key of PROTECTED_EXTENSIONS) {
    if (next.extensions && Object.prototype.hasOwnProperty.call(next.extensions, key) && JSON.stringify(next.extensions[key] ?? null) !== JSON.stringify(current.extensions?.[key] ?? null)) {
      throw Object.assign(new Error('普通保存不能更改受保护的工程记录'), { code: 'PROTECTED_EXTENSION' });
    }
  }
}
