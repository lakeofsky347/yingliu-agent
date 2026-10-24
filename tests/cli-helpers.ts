import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli/main.ts';

export async function cli(args: string[]) { let out = '', err = ''; const code = await runCli([...args, '--json'], { out: s => { out += s; }, err: s => { err += s; } }); const lines = out.trim() ? out.trim().split('\n') : []; return { code, json: lines.length ? JSON.parse(lines.at(-1)!) : undefined, lines, out, err }; }
/** Run `body` with a fresh YINGLIU_DATA_DIR/YINGLIU_PROJECTS and restore the environment afterwards. */
export async function withCliEnv<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'yingliu-cli-review-'));
  const saved = { data: process.env.YINGLIU_DATA_DIR, projects: process.env.YINGLIU_PROJECTS };
  process.env.YINGLIU_DATA_DIR = join(dir, 'data'); process.env.YINGLIU_PROJECTS = join(dir, 'projects');
  try { return await body(dir); } finally {
    if (saved.data === undefined) delete process.env.YINGLIU_DATA_DIR; else process.env.YINGLIU_DATA_DIR = saved.data;
    if (saved.projects === undefined) delete process.env.YINGLIU_PROJECTS; else process.env.YINGLIU_PROJECTS = saved.projects;
    await rm(dir, { recursive: true, force: true });
  }
}
