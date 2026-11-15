import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Appearance only. The file never carries credentials or project data. */
export type ThemeId = 'paper' | 'darkroom';
export interface UiPreferences { version: 1; theme: ThemeId }

const THEMES = new Set<ThemeId>(['paper', 'darkroom']);
export const DEFAULT_PREFERENCES: UiPreferences = { version: 1, theme: 'paper' };

export function parsePreferences(raw: string): UiPreferences {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('外观偏好损坏');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.theme !== 'string' || !THEMES.has(record.theme as ThemeId)) throw new Error('外观偏好损坏');
  for (const key of Object.keys(record)) if (key !== 'version' && key !== 'theme') throw new Error('外观偏好含有不允许的字段');
  return { version: 1, theme: record.theme as ThemeId };
}

export class PreferencesStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  private get file() { return join(this.directory, 'ui-preferences.json'); }
  async get(): Promise<UiPreferences> {
    return this.enqueue(async () => {
      try { return parsePreferences(await readFile(this.file, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_PREFERENCES }; throw error; }
    });
  }
  async set(theme: ThemeId): Promise<UiPreferences> {
    if (!THEMES.has(theme)) throw new Error('未知外观');
    const next: UiPreferences = { version: 1, theme };
    return this.enqueue(() => this.write(next));
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
  private async write(next: UiPreferences): Promise<UiPreferences> {
    await mkdir(this.directory, { recursive: true });
    const temporary = this.file + '.tmp-' + randomUUID();
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(next) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.file);
      return next;
    } finally { await rm(temporary, { force: true }); }
  }
}

