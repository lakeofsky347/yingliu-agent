/** Real subprocess fixture for CLI owner/lifecycle tests. All children and files belong to the test. */
import { appendFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { acquireOwner } from '../../src/cli/lock.ts';
import { installCliLifecycle } from '../../src/cli/lifecycle.ts';

const [mode, directory, eventFile, holdText] = process.argv.slice(2) as [string, string, string, string];
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const log = (event: string) => appendFile(eventFile, JSON.stringify({ event, pid: process.pid, at: Date.now() }) + '\n');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
if (mode === 'lifecycle') {
  const lifecycle = installCliLifecycle();
  const release = await acquireOwner([directory], 'lifecycle-fixture', 5000, { signal: lifecycle.signal });
  const owned = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const ownedExit = new Promise<void>(resolve => owned.once('close', () => resolve()));
  process.on('message', value => { if ((value as { interrupt?: boolean })?.interrupt) process.emit('SIGTERM'); });
  emit({ event: 'ready', pid: process.pid, ownedPid: owned.pid });
  try {
    await new Promise<void>(resolve => lifecycle.signal.addEventListener('abort', () => resolve(), { once: true }));
  } finally {
    await lifecycle.shutdown(async () => {
      await log('dispose-start'); owned.kill('SIGTERM'); await ownedExit;
      // Keep the owner held long enough for the parent to check cleanup ordering.
      await sleep(250); await log('dispose-end');
    }, async () => { await log('release'); await release(); });
    process.exitCode = lifecycle.exitCode ?? 0;
    process.disconnect?.();
  }
} else {
  const release = await acquireOwner([directory], mode, 10000);
  const guard = join(directory, 'test-critical-section');
  let entered = false;
  try {
    if (mode === 'critical') { const handle = await open(guard, 'wx'); await handle.close(); entered = true; await log('enter'); }
    emit({ event: 'ready', pid: process.pid });
    if (mode === 'hold') await new Promise(() => {});
    else await sleep(Number(holdText) || 30);
    if (entered) { await log('leave'); await unlink(guard); entered = false; }
  } finally { if (entered) await unlink(guard).catch(() => {}); await release(); }
}
