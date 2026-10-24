/** Exercise the real runCli entry point with a delayed local startup/dispose boundary. */
import { appendFile } from 'node:fs/promises';
import { AppBackend } from '../../src/app/backend.ts';
import { runCli } from '../../src/cli/main.ts';

const [phase, events] = process.argv.slice(2) as [string, string];
const log = (event: string) => appendFile(events, JSON.stringify({ event, at: Date.now() }) + '\n');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const call = AppBackend.prototype.call, dispose = AppBackend.prototype.dispose;
let startupDelayed = false;
AppBackend.prototype.call = async function <T>(endpoint: string, payload: unknown = {}): Promise<T> {
  if (phase === 'startup' && endpoint === 'catalog' && !startupDelayed) {
    startupDelayed = true; await log('startup-start'); await sleep(350); await log('startup-end');
  }
  return call.call(this, endpoint, payload) as Promise<T>;
};
AppBackend.prototype.dispose = async function () {
  await log('dispose-start'); await sleep(600); await dispose.call(this); await log('dispose-end');
};
// Windows cannot send a POSIX SIGTERM to a Node child. IPC invokes the same installed handler there.
process.on('message', value => { if ((value as { interrupt?: boolean })?.interrupt) process.emit('SIGTERM'); });
try { process.exitCode = await runCli(['project', 'list', '--json']); }
finally { process.disconnect?.(); }
