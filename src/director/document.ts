import { createHash } from 'node:crypto';
import type { VideoProject } from '../shared/types.ts';
import type { Story } from '../agent/story.ts';

/** Creative plan stored on the project. Approval never grants production or paid calls. */
export interface DirectorDocument {
  schemaVersion: 1;
  version: number;
  status: 'draft' | 'approved';
  hash: string;
  baseHash?: string;
  updatedAt: string;
  approvedAt?: string;
  plan: {
    story: Story;
    performance: [];
    worldLayouts: [];
    acceptance: [];
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'apiKey').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

export function directorHash(plan: DirectorDocument['plan']): string {
  return createHash('sha256').update(JSON.stringify(stable(plan))).digest('hex');
}

export function readDirectorDocument(project: VideoProject): DirectorDocument | undefined {
  const value = project.extensions?.directorDocument;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const doc = value as DirectorDocument;
  if (doc.schemaVersion !== 1 || !doc.plan?.story || typeof doc.hash !== 'string') return;
  return doc;
}

export function storyFromDirector(doc: DirectorDocument): Story {
  return structuredClone(doc.plan.story);
}

function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !/api[-_]?key|secret|password|authorization/i.test(key)).map(([key, item]) => [key, withoutSecrets(item)]));
  return value;
}

export function draftFromStory(current: DirectorDocument | undefined, story: Story, now = new Date().toISOString()): DirectorDocument {
  const plan = { story: withoutSecrets(structuredClone(story)) as Story, performance: [] as [], worldLayouts: [] as [], acceptance: [] as [] };
  const hash = directorHash(plan);
  return { schemaVersion: 1, version: (current?.version ?? 0) + 1, status: 'draft', hash, ...(current ? { baseHash: current.hash } : {}), updatedAt: now, plan };
}

/** An older draft cannot overwrite a document whose hash has moved on. */
export function assertDraftBase(current: DirectorDocument | undefined, incomingBase?: string): void {
  if (!current || incomingBase === undefined) return;
  if (incomingBase !== current.hash) throw Object.assign(new Error('导演草稿基于过期内容，请重新读取后再保存'), { code: 'DIRECTOR_BASE_CONFLICT' });
}

export function approveDirectorDocument(doc: DirectorDocument, expectedHash: string, now = new Date().toISOString()): DirectorDocument {
  if (expectedHash !== doc.hash) throw Object.assign(new Error('导演计划已变化，批准前后的内容必须一致'), { code: 'DIRECTOR_HASH_MISMATCH' });
  return { ...structuredClone(doc), status: 'approved', approvedAt: doc.approvedAt ?? now, hash: doc.hash };
}
