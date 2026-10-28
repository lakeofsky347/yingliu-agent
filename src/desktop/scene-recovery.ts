/** Browser-owned frame/process metadata only; never accept renderer-supplied PIDs. */
export type SceneFrame = { url: string; pid: number };
export type SceneProcess = { pid: number; type: string; creationTime: number };
export type OwnedSceneProcess = { pid: number; creationTime: number; origin: string };

const validPid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 0;
const validTime = (time: number): boolean => Number.isFinite(time) && time > 0;

function sceneOrigin(value: string): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    // The preview server always has an explicit loopback port. Do not widen this
    // allowlist to arbitrary localhost pages, credentials, or other schemes.
    if (url.protocol !== 'http:' || url.hostname !== 'localhost' || url.pathname !== '/index.html') return;
    if (url.username.length > 0) return;
    if (url.password.length > 0) return;
    if (!url.port || Number(url.port) < 1) return;
    return url.origin;
  } catch { return; }
}

/** Select only app-owned scene renderers isolated from every protected top-level renderer.
 * `frames` must contain all descendants of the requesting editor's main frame.
 * A PID hosting any other frame or more than one preview origin is rejected.
 * The caller must re-select immediately before termination and match the original
 * PID + creationTime + origin, so a recycled process is never treated as the scene.
 */
export function ownedSceneProcesses(
  editorPid: number,
  frames: readonly SceneFrame[],
  metrics: readonly SceneProcess[],
  protectedPids: readonly number[],
): OwnedSceneProcess[] {
  if (!validPid(editorPid)) return [];
  const protectedSet = new Set([editorPid, ...protectedPids]);
  const groups = new Map<number, { origins: Set<string>; invalid: boolean }>();
  for (const frame of frames) {
    if (!validPid(frame.pid)) continue;
    let group = groups.get(frame.pid);
    if (!group) { group = { origins: new Set(), invalid: false }; groups.set(frame.pid, group); }
    const origin = sceneOrigin(frame.url);
    if (origin) group.origins.add(origin); else group.invalid = true;
  }
  const byPid = new Map<number, SceneProcess[]>();
  for (const metric of metrics) {
    const values = byPid.get(metric.pid) ?? [];
    values.push(metric); byPid.set(metric.pid, values);
  }
  const selected: OwnedSceneProcess[] = [];
  for (const [pid, group] of groups) {
    if (protectedSet.has(pid) || group.invalid || group.origins.size !== 1) continue;
    const values = byPid.get(pid);
    // Ambiguous/duplicate process records cannot establish unique ownership.
    if (values?.length !== 1) continue;
    const metric = values[0];
    if (metric.type !== 'Tab' || !validTime(metric.creationTime)) continue;
    selected.push({ pid, creationTime: metric.creationTime, origin: group.origins.values().next().value! });
  }
  return selected.sort((a, b) => a.pid - b.pid);
}

/** Revalidate identity after any asynchronous recovery attempt, before acting on a PID. */
export function sameSceneProcess(previous: OwnedSceneProcess, current: OwnedSceneProcess): boolean {
  return validPid(previous.pid) && validPid(current.pid) && validTime(previous.creationTime) && validTime(current.creationTime) &&
    sceneOrigin(previous.origin + '/index.html') === previous.origin && sceneOrigin(current.origin + '/index.html') === current.origin &&
    previous.pid === current.pid && previous.creationTime === current.creationTime && previous.origin === current.origin;
}
