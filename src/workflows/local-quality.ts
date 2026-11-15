import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { VideoProject } from '../shared/types.ts';

export interface LocalQualityReport {
  version: 1;
  decision: 'pass' | 'fail' | 'needs-review';
  checks: { severity: 'hard' | 'advisory'; status: 'pass' | 'fail' | 'unchecked'; message: string }[];
  scope: { requestedFrames: { shotId: string; frame: number }[]; unsampledShots: string[] };
}

/** At most 12 sample points. The report names shots that were not sampled. */
export function localQualityFrames(project: VideoProject, max = 12): { shotId: string; frame: number }[] {
  if (!Number.isSafeInteger(max) || max < 1 || max > 36) throw new Error('质检抽样数量须为 1–36');
  const points: { shotId: string; frame: number }[] = [];
  let start = 0;
  for (const id of project.shotOrder) {
    const shot = project.shots.find(item => item.id === id);
    if (!shot || !Number.isSafeInteger(shot.durationFrames) || shot.durationFrames < 1) continue;
    for (const local of new Set([0, Math.floor((shot.durationFrames - 1) / 2), shot.durationFrames - 1])) points.push({ shotId: id, frame: start + local });
    start += shot.durationFrames;
  }
  if (points.length <= max) return points;
  return Array.from({ length: max }, (_, index) => points[Math.floor(index * (points.length - 1) / Math.max(1, max - 1))]!);
}

export async function localExportQuality(root: string, project: VideoProject): Promise<LocalQualityReport> {
  const checks: LocalQualityReport['checks'] = [];
  for (const asset of project.assets) {
    if (!asset.path) continue;
    try { await access(join(root, asset.path)); checks.push({ severity: 'hard', status: 'pass', message: '素材文件存在：' + asset.id }); }
    catch { checks.push({ severity: 'hard', status: 'fail', message: '缺少素材文件：' + asset.path }); }
  }
  if (!project.shots.length) checks.push({ severity: 'hard', status: 'fail', message: '工程没有镜头，不能导出成片' });
  const requested = localQualityFrames(project);
  const sampled = new Set(requested.map(point => point.shotId));
  const unsampled = project.shotOrder.filter(id => !sampled.has(id));
  const decision = checks.some(check => check.severity === 'hard' && check.status === 'fail') ? 'fail' : unsampled.length ? 'needs-review' : 'pass';
  return { version: 1, decision, checks, scope: { requestedFrames: requested, unsampledShots: unsampled } };
}
