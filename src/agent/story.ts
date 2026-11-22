import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import type { VideoProject } from '../shared/types.ts';
import type { AcceptanceCondition, AudioStrategy, ContinuityEntry, DialogueEvent, DirectorDocument, DirectorLocation, DirectorPlan, DirectorProp, FilmKind, PerformanceBeat, ShotEvent, StoryBeat, WorldLayout } from '../director/contracts.ts';
import { DIRECTOR_RULESET_VERSION, validateDirectorPlan } from '../director/index.ts';
import { directorPlanHash } from '../director/document.ts';
import { writeDurableFile } from './durable-file.ts';

export interface StoryStyle { look: string; palette: string; typography: string; motion: string; negative: string }
export interface StoryCharacter { id: string; name: string; description: string; objective?: string; baselineEmotion?: string; features: string[]; referenceAssetIds: string[]; voice?: string }
export type StoryLocation = DirectorLocation;
export type StoryProp = DirectorProp;
export interface StoryPreviz {
  status: 'none' | 'rendered' | 'approved' | 'skipped';
  imageAssetId?: string;
  depthAssetId?: string;
  videoAssetId?: string;
  styledKeyframeAssetId?: string;
  styledTailAssetId?: string;
  note?: string;
  updatedAt?: string;
}
export interface StoryShot {
  id: string; shotId?: string; summary: string; shotType: string; camera: string; durationSeconds: number;
  dialogue: string; characters: string[]; continueFromPrevious: boolean; previz?: StoryPreviz;
  locationId?: string; propIds?: string[]; audioStrategy?: AudioStrategy;
  performance?: PerformanceBeat[]; dialogueEvents?: DialogueEvent[]; shotEvents?: ShotEvent[]; acceptance?: AcceptanceCondition[];
}
export interface ConsistencyScore { shotId: string; score: number; notes: string; at: string }
export interface Story {
  version: number; projectId: string; status: 'empty' | 'approved';
  filmKind?: FilmKind; title: string; logline: string; targetSeconds: number;
  style: StoryStyle; characters: StoryCharacter[];
  locations?: StoryLocation[]; props?: StoryProp[];
  storyBeats?: StoryBeat[]; worldLayouts?: WorldLayout[]; continuityLog?: ContinuityEntry[];
  shots: StoryShot[]; approvedAt?: string; updatedAt: string;
  consistency: Record<string, ConsistencyScore>;
}
export interface Ledger { version: number; projectId: string; maxCost: number | null; currency: string; spent: number; unknownCostCalls: number; byTool: Record<string, { calls: number; cost: number }>; settledExecutions?: Record<string, true>; updatedAt: string }

const SAFE = /^[a-zA-Z0-9_-]{1,120}$/;
const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const list = (value: unknown, max: number, each: number) => Array.isArray(value) ? value.map(item => text(item, each)).filter(Boolean).slice(0, max) : [];
const id = (value: unknown, fallback: string) => { const v = text(value, 60).replace(/[^a-zA-Z0-9_-]/g, ''); return v || fallback; };

export function emptyStory(projectId: string): Story {
  return { version: 0, projectId, status: 'empty', title: '', logline: '', targetSeconds: 0, style: { look: '', palette: '', typography: '', motion: '', negative: '' }, characters: [], shots: [], updatedAt: new Date(0).toISOString(), consistency: {} };
}
export function normalizeStyle(value: unknown): StoryStyle { const v = (value ?? {}) as Record<string, unknown>; return { look: text(v.look, 400), palette: text(v.palette, 200), typography: text(v.typography, 200), motion: text(v.motion, 300), negative: text(v.negative, 300) }; }
export function normalizeCharacter(value: unknown, index: number): StoryCharacter {
  const v = (value ?? {}) as Record<string, unknown>; const name = text(v.name, 40); if (!name) throw new Error(`角色 ${index + 1} 缺少 name`);
  return {
    id: id(v.id, 'c' + (index + 1)), name, description: text(v.description ?? v.identity, 600),
    ...(text(v.objective, 200) ? { objective: text(v.objective, 200) } : {}),
    ...(text(v.baselineEmotion, 120) ? { baselineEmotion: text(v.baselineEmotion, 120) } : {}),
    features: list(v.features, 12, 80), referenceAssetIds: list(v.referenceAssetIds, 6, 80),
    ...(text(v.voice, 80) ? { voice: text(v.voice, 80) } : {}),
  };
}
export function normalizeLocation(value: unknown, index: number): StoryLocation {
  const v = (value ?? {}) as Record<string, unknown>; const name = text(v.name, 60); if (!name) throw new Error(`场景 ${index + 1} 缺少 name`);
  const setting = ['INT', 'EXT', 'INT/EXT'].includes(String(v.setting)) ? String(v.setting) as StoryLocation['setting'] : undefined;
  const timeOfDay = ['DAY', 'NIGHT', 'DAWN', 'DUSK'].includes(String(v.timeOfDay)) ? String(v.timeOfDay) as StoryLocation['timeOfDay'] : undefined;
  return {
    id: id(v.id, 'loc' + (index + 1)), name, description: text(v.description, 800) || name,
    ...(setting ? { setting } : {}), ...(timeOfDay ? { timeOfDay } : {}),
    ...(text(v.lightingMood, 240) ? { lightingMood: text(v.lightingMood, 240) } : {}),
    referenceAssetIds: list(v.referenceAssetIds, 6, 80),
    ...(text(v.worldLayoutId, 60) ? { worldLayoutId: text(v.worldLayoutId, 60) } : {}),
  };
}
export function normalizeProp(value: unknown, index: number): StoryProp {
  const v = (value ?? {}) as Record<string, unknown>; const name = text(v.name, 60); if (!name) throw new Error(`道具 ${index + 1} 缺少 name`);
  return {
    id: id(v.id, 'prop' + (index + 1)), name, description: text(v.description, 600) || name,
    ...(text(v.ownerCharacterId, 60) ? { ownerCharacterId: text(v.ownerCharacterId, 60) } : {}),
    referenceAssetIds: list(v.referenceAssetIds, 6, 80),
  };
}
export function normalizeShots(value: unknown, characters: StoryCharacter[], locations: StoryLocation[] = [], props: StoryProp[] = []): StoryShot[] {
  if (!Array.isArray(value) || !value.length) throw new Error('shots 必须是非空数组');
  if (value.length > 120) throw new Error('分镜最多 120 个');
  const known = new Set(characters.map(c => c.id)); const knownLocs = new Set(locations.map(l => l.id)); const knownProps = new Set(props.map(p => p.id)); const seen = new Set<string>();
  return value.map((raw, index) => {
    const v = (raw ?? {}) as Record<string, unknown>; const summary = text(v.summary ?? v.visualPrompt, 800); if (!summary) throw new Error(`分镜 ${index + 1} 缺少 summary`);
    let shotId = id(v.id, 's' + (index + 1)); while (seen.has(shotId)) shotId += '_'; seen.add(shotId);
    const duration = Number(v.durationSeconds); if (!Number.isFinite(duration) || duration <= 0 || duration > 120) throw new Error(`分镜 ${index + 1} 的 durationSeconds 须在 0–120 秒`);
    const chars = list(v.characters ?? v.characterIds, 8, 60); const unknown = chars.filter(c => !known.has(c)); if (unknown.length) throw new Error(`分镜 ${index + 1} 引用了未知角色：${unknown.join(', ')}（先用 plan_story 或 character_upsert 定义）`);
    const locationId = text(v.locationId, 60); if (locationId && knownLocs.size && !knownLocs.has(locationId)) throw new Error(`分镜 ${index + 1} 引用了未知场景：${locationId}`);
    const propIds = list(v.propIds, 8, 60); const unknownProps = propIds.filter(p => knownProps.size && !knownProps.has(p)); if (unknownProps.length) throw new Error(`分镜 ${index + 1} 引用了未知道具：${unknownProps.join(', ')}`);
    const audioStrategy = ['native', 'external', 'silent'].includes(String(v.audioStrategy)) ? String(v.audioStrategy) as AudioStrategy : undefined;
    return {
      id: shotId, ...(text(v.shotId, 80) ? { shotId: text(v.shotId, 80) } : {}), summary, shotType: text(v.shotType, 40), camera: text(v.camera, 120),
      durationSeconds: Math.round(duration * 100) / 100, dialogue: text(v.dialogue ?? v.narration, 600), characters: chars, continueFromPrevious: v.continueFromPrevious === true,
      ...(locationId ? { locationId } : {}), ...(propIds.length ? { propIds } : {}), ...(audioStrategy ? { audioStrategy } : {}),
      ...(Array.isArray(v.performance) ? { performance: v.performance as PerformanceBeat[] } : {}),
      ...(Array.isArray(v.dialogueEvents) ? { dialogueEvents: v.dialogueEvents as DialogueEvent[] } : {}),
      ...(Array.isArray(v.shotEvents) ? { shotEvents: v.shotEvents as ShotEvent[] } : {}),
      ...(Array.isArray(v.acceptance) ? { acceptance: v.acceptance as AcceptanceCondition[] } : {}),
    };
  });
}

/** Text anchors injected into every generation prompt so style, characters, locations and props stay consistent across shots. */
export function anchorPrompt(story: Story | null, characterIds: string[] = [], extra: { locationId?: string; propIds?: string[]; shotId?: string } = {}): string {
  if (!story) return '';
  const parts: string[] = [];
  const s = story.style; const style = [s.look && '画风：' + s.look, s.palette && '配色：' + s.palette, s.motion && '运动：' + s.motion].filter(Boolean).join('；');
  if (style) parts.push(style);
  const plannedShot = extra.shotId ? story.shots.find(sh => sh.shotId === extra.shotId || sh.id === extra.shotId) : undefined;
  const effectiveChars = characterIds.length ? characterIds : plannedShot?.characters ?? [];
  for (const cid of effectiveChars) { const c = story.characters.find(x => x.id === cid || x.name === cid); if (c) parts.push(`角色「${c.name}」：${[c.description, ...c.features].filter(Boolean).join('，')}`); }
  const locId = extra.locationId || plannedShot?.locationId;
  if (locId) {
    const loc = (story.locations ?? []).find(l => l.id === locId || l.name === locId);
    if (loc) parts.push(`场景「${loc.name}」${loc.setting ? `(${loc.setting}${loc.timeOfDay ? '·' + loc.timeOfDay : ''})` : ''}：${[loc.description, loc.lightingMood && '布光：' + loc.lightingMood].filter(Boolean).join('，')}`);
  }
  const propIds = extra.propIds?.length ? extra.propIds : plannedShot?.propIds ?? [];
  for (const pid of propIds) {
    const prop = (story.props ?? []).find(p => p.id === pid || p.name === pid);
    if (prop) parts.push(`关键道具「${prop.name}」：${prop.description}`);
  }
  if (s.negative) parts.push('避免：' + s.negative);
  return parts.length ? '\n【一致性锚点】' + parts.join('。') : '';
}
export function storyBrief(story: Story | null): string {
  if (!story || story.status !== 'approved') return '';
  const shots = story.shots.map((s, i) => {
    const pv = s.previz;
    const previzTag = pv && pv.status !== 'none'
      ? ` [预演:${pv.status}${pv.imageAssetId ? ' frame=' + pv.imageAssetId : ''}${pv.depthAssetId ? ' depth=' + pv.depthAssetId : ''}${pv.styledKeyframeAssetId ? ' styled=' + pv.styledKeyframeAssetId : ''}${pv.videoAssetId ? ' video=' + pv.videoAssetId : ''}]`
      : '';
    const locTag = s.locationId ? ` @${s.locationId}` : '';
    return `${i + 1}. [${s.id}${s.shotId ? '→' + s.shotId : ''}]${locTag} ${s.shotType} ${s.camera} ${s.durationSeconds}s ${s.summary}${s.characters.length ? '（角色 ' + s.characters.join(',') + '）' : ''}${s.propIds?.length ? '（道具 ' + s.propIds.join(',') + '）' : ''}${s.continueFromPrevious ? '（承接上一镜）' : ''}${previzTag}`;
  }).join('\n');
  const locLine = story.locations?.length ? `\n场景库：${story.locations.map(l => `${l.id}=${l.name}（${l.description.slice(0, 60)}）`).join('；')}` : '';
  const propLine = story.props?.length ? `\n道具库：${story.props.map(p => `${p.id}=${p.name}（${p.description.slice(0, 40)}）`).join('；')}` : '';
  const layoutLine = story.worldLayouts?.length ? `\n三维世界布局：${story.worldLayouts.map(w => `${w.id}（${w.anchors.length}锚点）`).join('、')}` : '';
  return `已批准的创作计划（制片圣经与分镜，按此执行，偏离前先用 plan_shots / bible_save_plan 更新）：\n《${story.title}》${story.filmKind ? `[${story.filmKind}] ` : ''}${story.logline}\n风格：${JSON.stringify(story.style)}\n角色：${story.characters.map(c => `${c.id}=${c.name}${c.voice ? '[音色:' + c.voice + ']' : ''}（${c.features.join('，')}）`).join('；') || '无'}${locLine}${propLine}${layoutLine}\n分镜：\n${shots}`.slice(0, 8500);
}

/** Build a canonical DirectorDocument from the unified Story whenever project shots match. */
export function buildDirectorDocumentFromStory(story: Story, project: VideoProject, existingDoc?: DirectorDocument): DirectorDocument | null {
  if (!story.shots.length || !project.shots.length) return null;
  const projectShotIds = new Set(project.shots.map(s => s.id));
  const imageIds = new Set(project.assets.filter(a => a.kind === 'image').map(a => a.id));
  const order = project.shotOrder.length ? project.shotOrder : project.shots.map(s => s.id);
  const mappedShots = story.shots.map((s, idx) => {
    const targetId = s.shotId && projectShotIds.has(s.shotId) ? s.shotId : order[idx];
    if (!targetId || !projectShotIds.has(targetId)) return null;
    const validChars = s.characters.filter(cid => story.characters.some(c => c.id === cid));
    const audioStrategy: AudioStrategy = s.audioStrategy ?? (s.dialogue ? 'external' : 'silent');
    const dialogue: DialogueEvent[] = s.dialogueEvents?.length ? s.dialogueEvents : (s.dialogue && validChars[0] && audioStrategy !== 'silent'
      ? [{ id: `dlg-${idx + 1}`, characterId: validChars[0], start: 0, end: Math.max(0.2, Math.min(s.durationSeconds, s.durationSeconds - 0.1)), text: s.dialogue }]
      : []);
    const refs = [
      ...(s.previz?.imageAssetId && project.assets.some(a => a.id === s.previz!.imageAssetId) ? [{ assetId: s.previz.imageAssetId, purpose: 'blocking' as const, usage: 'reference_only' as const }] : []),
      ...(s.previz?.depthAssetId && project.assets.some(a => a.id === s.previz!.depthAssetId) ? [{ assetId: s.previz.depthAssetId, purpose: 'depth' as const, usage: 'reference_only' as const }] : []),
    ];
    return {
      shotId: targetId,
      title: project.shots.find(ps => ps.id === targetId)?.title || `镜头 ${idx + 1}`,
      visualPrompt: s.summary,
      durationSeconds: s.durationSeconds,
      narration: s.dialogue || '',
      ...(s.shotType ? { shotType: s.shotType } : {}),
      ...(s.camera ? { camera: s.camera } : {}),
      ...(s.locationId && (story.locations ?? []).some(l => l.id === s.locationId) ? { locationId: s.locationId } : {}),
      ...(s.propIds?.length ? { propIds: s.propIds.filter(pid => (story.props ?? []).some(p => p.id === pid)) } : {}),
      ...(s.continueFromPrevious ? { continueFromPrevious: true } : {}),
      ...(s.previz ? { previz: structuredClone(s.previz) } : {}),
      ...(validChars.length ? { characterIds: [...new Set(validChars)] } : {}),
      audioStrategy,
      performance: (s.performance ?? []).filter(p => validChars.includes(p.characterId) && p.end <= s.durationSeconds),
      dialogue,
      events: s.shotEvents ?? [],
      references: refs,
      acceptance: s.acceptance ?? [],
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null);
  const seenShotIds = new Set<string>();
  const uniqueShots = mappedShots.filter(s => { if (seenShotIds.has(s.shotId)) return false; seenShotIds.add(s.shotId); return true; });
  if (!uniqueShots.length) return null;
  const plan: DirectorPlan = {
    version: 1,
    ruleSetVersion: DIRECTOR_RULESET_VERSION,
    filmKind: story.filmKind ?? 'general',
    ...(story.title ? { title: story.title } : {}),
    ...(story.logline ? { logline: story.logline } : {}),
    ...(story.targetSeconds > 0 ? { targetSeconds: story.targetSeconds } : {}),
    style: structuredClone(story.style),
    characters: story.characters.map(c => ({
      id: c.id, name: c.name, identity: c.description || c.features.join('，') || c.name,
      ...(c.objective ? { objective: c.objective } : {}),
      ...(c.baselineEmotion ? { baselineEmotion: c.baselineEmotion } : {}),
      features: c.features,
      referenceAssetIds: c.referenceAssetIds.filter(id => imageIds.has(id)),
      ...(c.voice ? { voice: c.voice } : {}),
    })),
    ...(story.locations?.length ? { locations: story.locations.map(l => ({ ...l, referenceAssetIds: (l.referenceAssetIds ?? []).filter(id => imageIds.has(id)) })) } : {}),
    ...(story.props?.length ? { props: story.props.map(p => ({ ...p, referenceAssetIds: (p.referenceAssetIds ?? []).filter(id => imageIds.has(id)) })) } : {}),
    storyBeats: (story.storyBeats ?? []).filter(b => b.shotIds.every(id => seenShotIds.has(id))),
    worldLayouts: story.worldLayouts ?? [],
    identityMap: story.characters
      .filter(c => c.referenceAssetIds.some(id => imageIds.has(id)))
      .map(c => ({ characterId: c.id, assetId: c.referenceAssetIds.find(id => imageIds.has(id))! })),
    ...(story.continuityLog?.length ? { continuityLog: story.continuityLog } : {}),
    shots: uniqueShots,
  };
  const checked = validateDirectorPlan(plan);
  if (!checked.ok || !checked.plan) return null;
  const now = new Date().toISOString();
  const status = story.status === 'approved' ? 'approved' : 'draft';
  return {
    schemaVersion: 1,
    version: (existingDoc?.version ?? 0) + 1,
    status,
    hash: directorPlanHash(checked.plan),
    plan: checked.plan,
    updatedAt: now,
    ...(status === 'approved' ? { approvedAt: story.approvedAt ?? now } : {}),
  };
}

/** Sync an edited/approved DirectorDocument back into the unified Story representation. */
export function mergeDirectorPlanIntoStory(plan: DirectorPlan, current: Story, approved: boolean): Story {
  const now = new Date().toISOString();
  return {
    ...current,
    filmKind: plan.filmKind,
    title: plan.title ?? (current.title || '导演计划'),
    logline: plan.logline ?? (current.logline || plan.storyBeats.map(b => b.change).join('；').slice(0, 600) || '按导演计划执行'),
    targetSeconds: plan.targetSeconds ?? plan.shots.reduce((sum, s) => sum + s.durationSeconds, 0),
    style: plan.style ? normalizeStyle(plan.style) : current.style,
    characters: plan.characters.map(c => ({
      id: c.id, name: c.name, description: c.identity,
      ...(c.objective ? { objective: c.objective } : {}),
      ...(c.baselineEmotion ? { baselineEmotion: c.baselineEmotion } : {}),
      features: c.features ?? [],
      referenceAssetIds: [...new Set([...(c.referenceAssetIds ?? []), ...plan.identityMap.filter(m => m.characterId === c.id).map(m => m.assetId)])],
      ...(c.voice ? { voice: c.voice } : {}),
    })),
    ...(plan.locations ? { locations: structuredClone(plan.locations) } : {}),
    ...(plan.props ? { props: structuredClone(plan.props) } : {}),
    storyBeats: structuredClone(plan.storyBeats),
    worldLayouts: structuredClone(plan.worldLayouts),
    ...(plan.continuityLog ? { continuityLog: structuredClone(plan.continuityLog) } : {}),
    shots: plan.shots.map((s, idx) => {
      const existing = current.shots.find(old => old.shotId === s.shotId || old.id === s.shotId);
      return {
        id: existing?.id ?? `s${idx + 1}`,
        shotId: s.shotId,
        summary: s.visualPrompt,
        shotType: s.shotType ?? existing?.shotType ?? '',
        camera: s.camera ?? s.events[0]?.camera ?? existing?.camera ?? '',
        durationSeconds: s.durationSeconds,
        dialogue: s.dialogue.map(d => d.text).join(' ') || s.narration,
        characters: [...new Set([...(s.characterIds ?? []), ...s.dialogue.map(d => d.characterId), ...s.performance.map(p => p.characterId)])],
        continueFromPrevious: s.continueFromPrevious ?? existing?.continueFromPrevious ?? false,
        ...(s.locationId ? { locationId: s.locationId } : {}),
        ...(s.propIds?.length ? { propIds: [...s.propIds] } : {}),
        audioStrategy: s.audioStrategy,
        ...(s.performance.length ? { performance: structuredClone(s.performance) } : {}),
        ...(s.dialogue.length ? { dialogueEvents: structuredClone(s.dialogue) } : {}),
        ...(s.events.length ? { shotEvents: structuredClone(s.events) } : {}),
        ...(s.acceptance.length ? { acceptance: structuredClone(s.acceptance) } : {}),
        ...(s.previz ?? existing?.previz ? { previz: structuredClone(s.previz ?? existing?.previz) } : {}),
      };
    }),
    status: approved ? 'approved' : current.status,
    ...(approved ? { approvedAt: now } : {}),
    updatedAt: now,
  };
}

/** Per-project JSON documents (story, ledger) with atomic writes and optimistic versioning. */
export class ProjectDocs<T extends { version: number }> {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly empty: (projectId: string) => T) {}
  private file(projectId: string) { if (!SAFE.test(projectId)) throw new Error('工程 ID 无效'); return join(this.directory, projectId + '.json'); }
  async get(projectId: string): Promise<T> { await this.queue.catch(() => {}); return this.read(projectId); }
  update(projectId: string, change: (current: T) => T, expectedVersion?: number): Promise<T> {
    const work = async () => {
      const current = await this.read(projectId);
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw Object.assign(new Error(`版本已变化（当前 ${current.version}），请重新读取`), { code: 'REVISION_CONFLICT' });
      const next = { ...change(structuredClone(current)), version: current.version + 1 };
      await mkdir(this.directory, { recursive: true });
      await writeDurableFile(this.file(projectId), JSON.stringify(next, null, 1));
      return next;
    };
    const next = this.queue.then(work, work); this.queue = next.catch(() => {}); return next;
  }
  /** Raw stored document, or undefined when this project has none yet (used by project backups). */
  async raw(projectId: string): Promise<T | undefined> { await this.queue.catch(() => {}); try { await readFile(this.file(projectId)); } catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined; } return this.read(projectId); }
  /** Replace the whole document (restore from backup); serialized with updates, version continues from the current file. */
  put(projectId: string, value: T): Promise<T> { return this.update(projectId, () => structuredClone(value)); }
  /** Only a missing file starts empty. Corrupt JSON or permission errors keep the original file untouched and surface an error,
   *  so a damaged ledger can never silently reset spend to zero. */
  private async read(projectId: string): Promise<T> {
    const file = this.file(projectId); let text: string;
    try { text = await readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return this.empty(projectId); throw Object.assign(new Error(`智能体资料无法读取（${basename(this.directory)}/${projectId}.json：${(error as NodeJS.ErrnoException)?.code ?? '未知错误'}）；原文件已保留，请检查权限后重试`), { code: 'AGENT_DOC_UNREADABLE' }); }
    let value: unknown; try { value = JSON.parse(text); } catch { value = undefined; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger((value as { version?: unknown }).version)) throw Object.assign(new Error(`智能体资料已损坏（${basename(this.directory)}/${projectId}.json）；原文件已保留，不会按空记录继续（避免账本被清零）。请从备份恢复或手动修复`), { code: 'AGENT_DOC_CORRUPT' });
    return value as T;
  }
}
export const emptyLedger = (projectId: string): Ledger => ({ version: 0, projectId, maxCost: null, currency: 'CNY', spent: 0, unknownCostCalls: 0, byTool: {}, updatedAt: new Date(0).toISOString() });

/** Mean luminance and spread of an 8-bit RGB/RGBA/gray PNG (no interlace). Returns null when it cannot decode. */
export function pngLuma(bytes: Uint8Array): { mean: number; std: number } | null {
  const b = Buffer.from(bytes); if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return null;
  let p = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0; const data: Buffer[] = [];
  while (p + 8 <= b.length) { const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), body = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; color = body[9]; interlace = body[12]; }
    else if (type === 'IDAT') data.push(body); else if (type === 'IEND') break; p += 12 + len; }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[color]; if (!channels || depth !== 8 || interlace || !width || !height || width * height > 40_000_000) return null;
  let raw: Buffer; try { raw = inflateSync(Buffer.concat(data)); } catch { return null; }
  const stride = width * channels; if (raw.length < (stride + 1) * height) return null;
  let prev = Buffer.alloc(stride), sum = 0, sq = 0, n = 0; const step = Math.max(1, Math.floor(width / 200));
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) { const a = x >= channels ? line[x - channels] : 0, up = prev[x], c = x >= channels ? prev[x - channels] : 0;
      const pred = filter === 1 ? a : filter === 2 ? up : filter === 3 ? (a + up) >> 1 : filter === 4 ? (() => { const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c); return pa <= pb && pa <= pc ? a : pb <= pc ? up : c; })() : 0;
      line[x] = (line[x] + pred) & 255; }
    if (y % step === 0) for (let x = 0; x < width; x += step) { const o = x * channels; const l = channels >= 3 ? 0.2126 * line[o] + 0.7152 * line[o + 1] + 0.0722 * line[o + 2] : line[o]; sum += l; sq += l * l; n++; }
    prev = line;
  }
  const mean = sum / n; return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

export interface QcIssue { check: 'black' | 'silence' | 'subtitle' | 'duration' | 'consistency'; severity: 'low' | 'medium' | 'high'; shotId?: string; message: string }
/** status: pass = every check ran and nothing severe; partial = no severe issue but some checks could not run; fail = a severe issue. `pass` is true only for status pass. */
export type QcStatus = 'pass' | 'partial' | 'fail';
export interface QcReport { status?: QcStatus; pass: boolean; checkedAt: string; revision?: number; issues: QcIssue[]; unchecked: string[] }
export function qcStatus(issues: QcIssue[], unchecked: string[]): QcStatus { return issues.some(i => i.severity === 'high') ? 'fail' : unchecked.length ? 'partial' : 'pass'; }

/** Project-data checks (no rendering): silence, subtitle overflow, durations, consistency scores. */
export function dataChecks(project: VideoProject, story: Story | null, threshold = 75): QcIssue[] {
  const issues: QcIssue[] = []; const fps = project.target.fps.num / project.target.fps.den;
  const order = project.shotOrder.length ? project.shotOrder : project.shots.map(s => s.id); const shots = order.map(id => project.shots.find(s => s.id === id)).filter(Boolean) as VideoProject['shots'];
  const clips = project.audioClips ?? [];
  const total = shots.reduce((sum, s) => sum + s.durationFrames / fps, 0);
  if (project.target.audioMode === 'mixed' && !clips.length) issues.push({ check: 'silence', severity: 'medium', message: '音频模式为混音，但工程没有任何音轨（成片将是静音）' });
  for (const clip of clips) if (clip.volume <= 0) issues.push({ check: 'silence', severity: 'low', shotId: clip.shotId, message: `音频片段 ${clip.id} 音量为 0` });
  for (const clip of clips) if (!project.assets.some(a => a.id === clip.assetId)) issues.push({ check: 'silence', severity: 'high', shotId: clip.shotId, message: `音频片段 ${clip.id} 引用的素材不存在` });
  const perLine = Math.max(8, Math.floor(project.target.width / Math.max(24, project.target.height * 0.05) * 0.9));
  for (const shot of shots) {
    const seconds = shot.durationFrames / fps;
    if (seconds < 0.5) issues.push({ check: 'duration', severity: 'medium', shotId: shot.id, message: `镜头只有 ${seconds.toFixed(2)} 秒` });
    const subtitle = (shot.params as { subtitle?: string })?.subtitle ?? '';
    const lines = subtitle.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil([...line].length / perLine)), 0);
    if (subtitle && lines > 2) issues.push({ check: 'subtitle', severity: 'medium', shotId: shot.id, message: `字幕约 ${lines} 行（每行约 ${perLine} 字），可能越出安全区` });
    for (const clip of clips.filter(c => c.role === 'voice' && c.shotId === shot.id)) { const asset = project.assets.find(a => a.id === clip.assetId); const end = clip.startSeconds + (Math.min(clip.trimEnd ?? asset?.duration ?? 0, asset?.duration ?? 0) - clip.trimStart); if (asset?.duration && end > seconds + 0.05) issues.push({ check: 'subtitle', severity: 'medium', shotId: shot.id, message: `配音长 ${end.toFixed(2)}s，超出镜头时长 ${seconds.toFixed(2)}s，字幕与配音会错位；可用 align_to_voice 对齐` }); }
  }
  const target = story?.status === 'approved' && story.targetSeconds ? story.targetSeconds : story?.status === 'approved' && story.shots.length ? story.shots.reduce((s, x) => s + x.durationSeconds, 0) : project.targetDuration;
  if (target > 0 && Math.abs(total - target) / target > 0.2) issues.push({ check: 'duration', severity: 'medium', message: `总时长 ${total.toFixed(1)}s 与目标 ${target}s 相差超过 20%` });
  if (story?.status === 'approved') {
    for (const planned of story.shots) if (planned.dialogue && planned.shotId) { const shot = project.shots.find(s => s.id === planned.shotId); if (shot && !clips.some(c => c.role === 'voice' && c.shotId === shot.id) && !(shot.params as { subtitle?: string })?.subtitle && !shot.narration) issues.push({ check: 'silence', severity: 'medium', shotId: shot.id, message: '计划中有台词，但镜头既没有配音也没有字幕' }); }
    for (const score of Object.values(story.consistency)) if (score.score < threshold) issues.push({ check: 'consistency', severity: score.score < threshold - 25 ? 'high' : 'medium', shotId: score.shotId, message: `角色/风格一致性 ${score.score} 分（低于 ${threshold}）：${score.notes}` });
  }
  return issues;
}
export function frameIssue(shotId: string, luma: { mean: number; std: number } | null): QcIssue | null {
  if (!luma) return null;
  if (luma.mean < 8 && luma.std < 4) return { check: 'black', severity: 'high', shotId, message: `关键帧几乎全黑（平均亮度 ${luma.mean.toFixed(1)}）` };
  if (luma.std < 2) return { check: 'black', severity: 'medium', shotId, message: `关键帧是纯色画面（亮度 ${luma.mean.toFixed(1)}），可能内容未渲染` };
  return null;
}
