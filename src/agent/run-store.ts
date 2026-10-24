import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRun, ToolSuccessReceipt } from './contracts.ts';
import { writeDurableFile } from './durable-file.ts';

const SAFE = /^[a-zA-Z0-9-]{1,80}$/;
/** Durable agent runs: atomic JSON snapshot per run + append-only JSONL trace. Writes are serialized. */
export class RunStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, private readonly redact: (text: string) => Promise<string> = async text => text) {}
  private path(id: string, suffix: string) { if (!SAFE.test(id)) throw new Error('运行 ID 无效'); return join(this.directory, id + suffix); }
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.queue.then(work, work); this.queue = next.catch(() => {}); return next; }
  save(run: AgentRun): Promise<void> {
    const copy = JSON.stringify(run, null, 1);
    return this.serial(async () => {
      await mkdir(this.directory, { recursive: true });
      await writeDurableFile(this.path(run.id, '.json'), await this.redact(copy));
    });
  }
  private resultsDirectory(runId: string) { return this.path(runId, '.results'); }
  /** Independent journal: a failed run snapshot/trace cannot erase a successful side effect. */
  saveToolSuccess(runId: string, receipt: ToolSuccessReceipt): Promise<void> {
    if (!SAFE.test(receipt.execId)) throw new Error('执行 ID 无效');
    const copy = JSON.stringify({ ...receipt, result: { ...receipt.result, ...(receipt.result.images ? { images: receipt.result.images.map(image => ({ mime: image.mime, base64: Buffer.from(image.bytes).toString('base64') })) } : {}) } });
    return this.serial(async () => {
      const directory = this.resultsDirectory(runId); await mkdir(directory, { recursive: true });
      await writeDurableFile(join(directory, receipt.execId + '.json'), await this.redact(copy));
    });
  }
  async toolSuccesses(runId: string): Promise<ToolSuccessReceipt[]> {
    await this.queue.catch(() => {});
    const directory = this.resultsDirectory(runId); let names: string[];
    try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
      const value = JSON.parse(await readFile(join(directory, name), 'utf8'));
      if (!value || !SAFE.test(value.execId) || name !== value.execId + '.json' || typeof value.tool !== 'string' || typeof value.argsHash !== 'string' || !['read', 'write', 'plan', 'cost', 'export'].includes(value.risk) || !Number.isSafeInteger(value.stepIndex) || typeof value.result?.content !== 'string') throw new Error('工具成功回执损坏；已停止，未重新提交');
      if (value.result.images) {
        if (!Array.isArray(value.result.images) || value.result.images.some((image: { mime?: unknown; base64?: unknown }) => typeof image.mime !== 'string' || typeof image.base64 !== 'string')) throw new Error('工具成功回执中的画面损坏；未重新提交');
        value.result.images = value.result.images.map((image: { mime: string; base64: string }) => ({ mime: image.mime, bytes: new Uint8Array(Buffer.from(image.base64, 'base64')) }));
      }
      return value as ToolSuccessReceipt;
    }));
  }
  removeToolSuccess(runId: string, execId: string): Promise<void> {
    if (!SAFE.test(execId)) throw new Error('执行 ID 无效');
    return this.serial(() => rm(join(this.resultsDirectory(runId), execId + '.json'), { force: true }));
  }
  trace(runId: string, event: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    return this.serial(async () => { await mkdir(this.directory, { recursive: true }); await appendFile(this.path(runId, '.trace.jsonl'), (await this.redact(line)).slice(0, 64_000) + '\n'); });
  }
  async readTrace(runId: string): Promise<Record<string, unknown>[]> {
    await this.queue;
    try { return (await readFile(this.path(runId, '.trace.jsonl'), 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
    catch { return []; }
  }
  async loadAll(): Promise<AgentRun[]> {
    await mkdir(this.directory, { recursive: true });
    const runs: AgentRun[] = [];
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.json')) continue;
      try { const run = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as AgentRun; if (run.version === 1 && SAFE.test(run.id) && name === run.id + '.json') runs.push(run); } catch { /* skip corrupt */ }
    }
    return runs;
  }
}
