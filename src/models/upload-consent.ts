import { createHash, randomUUID } from 'node:crypto';
import type { ResolvedModel } from './contracts.ts';
import { resolveTemplate } from './adapters/template.ts';

export type UploadPurpose = 'review' | 'video-reference';
export interface UploadDestination { fingerprint:string; origin:string; model:string }
export interface UploadConsentChallenge { id:string; purpose:UploadPurpose; origin:string; model:string; assetId?:string }
export type AuthorizeUpload = (destination:UploadDestination)=>void;

export function uploadDestination({connection,model}:ResolvedModel):UploadDestination {
  const template=connection.protocol==='async-task'?resolveTemplate(model.parameters):undefined;
  const fingerprint=createHash('sha256').update(JSON.stringify([connection.id,model.id,connection.protocol,connection.auth,
    connection.baseUrl,model.model,template?.submitPath,template?.submitMethod,template?.submitBody,model.parameters.version])).digest('hex');
  return {fingerprint,origin:new URL(connection.baseUrl).origin,model:model.model};
}

export class UploadConsentRequired extends Error {
  constructor(readonly purpose:UploadPurpose,readonly destination:UploadDestination) {
    super('请确认将'+(purpose==='review'?'关键帧':'参考图片')+'发送至 '+destination.origin+'（'+destination.model+'）');
  }
}

export function consentChallenge(purpose:UploadPurpose,destination:UploadDestination):UploadConsentChallenge {
  return {id:randomUUID(),purpose,origin:destination.origin,model:destination.model};
}
