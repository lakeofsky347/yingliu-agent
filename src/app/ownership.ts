import { join, resolve } from 'node:path';
import { acquireOwnerLease } from '../cli/lock.ts';
export type { OwnerLease } from '../cli/lock.ts';

export function applicationDirectories(options: { dataDirectory: string; projectsDirectory?: string }) {
  const dataDirectory = resolve(options.dataDirectory);
  const projectsDirectory = resolve(options.projectsDirectory ?? process.env.YINGLIU_PROJECTS ?? join(dataDirectory, 'projects'));
  return { dataDirectory, projectsDirectory };
}
export async function acquireApplicationOwner(options: { dataDirectory: string; projectsDirectory?: string }, command: string, timeoutMs = 0, signal?: AbortSignal) {
  const directories = applicationDirectories(options);
  return acquireOwnerLease([directories.dataDirectory, directories.projectsDirectory], command, timeoutMs, { signal });
}
/** Attempt every owned cleanup in dependency order before the caller releases its lease. */
export async function drainOwned(cleanups: (() => Promise<unknown> | undefined)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) try { await cleanup(); } catch (error) { failures.push(error); }
  if (failures.length) throw failures[0];
}
