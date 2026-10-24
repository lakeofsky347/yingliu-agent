import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireOwner, BusyError } from '../src/cli/lock.ts';

const fixture = join(import.meta.dirname, 'fixtures', 'cli-signal-main-child.ts');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(events: string, event: string) {
  for (let n = 0; n < 1000; n++) {
    if ((await readFile(events, 'utf8').catch(() => '')).includes('"event":"' + event + '"')) return;
    await sleep(10);
  }
  throw new Error('event timeout: ' + event);
}
function interrupt(child: ChildProcess) { if (process.platform === 'win32') child.send!({ interrupt: true }); else child.kill('SIGTERM'); }

for (const phase of ['startup', 'dispose']) {
  test(`R2-05 main integration: SIGTERM during ${phase} keeps ownership through disposal and emits once`, { timeout: 15000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yingliu-main-signal-')), data = join(dir, 'data'), projects = join(dir, 'projects'), events = join(dir, 'events.jsonl');
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, phase, events], { env: { ...process.env, YINGLIU_DATA_DIR: data, YINGLIU_PROJECTS: projects }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '', err = '';
    child.stdout!.on('data', bytes => out += bytes); child.stderr!.on('data', bytes => err += bytes);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    try {
      await waitFor(events, phase === 'startup' ? 'startup-start' : 'dispose-start');
      interrupt(child);
      await waitFor(events, 'dispose-start');
      // Repeated signals must not bypass disposal or release the live owner's listener.
      interrupt(child);
      await assert.rejects(acquireOwner([data, projects], 'during-main-dispose', 0), error => error instanceof BusyError && error.owner?.pid === child.pid);
      assert.equal(out, '', 'result must not be emitted while dispose is pending');
      const exited = await closed;
      assert.equal(exited.code, 143, out + err); assert.equal(exited.signal, null); assert.equal(err, '');
      const lines = out.trim().split('\n'); assert.equal(lines.length, 1);
      const result = JSON.parse(lines[0]!); assert.equal(result.ok, false); assert.equal(result.error.code, 'INTERRUPTED'); assert.equal(result.error.signal, 'SIGTERM');
      const order = (await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line).event);
      assert.deepEqual(order, phase === 'startup' ? ['startup-start', 'startup-end', 'dispose-start', 'dispose-end'] : ['dispose-start', 'dispose-end']);
      const release = await acquireOwner([data, projects], 'after-main-dispose', 1000); await release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
      await rm(dir, { recursive: true, force: true });
    }
  });
}
