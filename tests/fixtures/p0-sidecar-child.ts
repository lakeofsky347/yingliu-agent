/** Test-only delayed lifecycle boundaries; the production sidecar CLI and stdio protocol run unchanged. */
import { appendFile } from 'node:fs/promises';
import { AppBackend } from '../../src/app/backend.ts';
const [phase, events, ...sidecarArguments] = process.argv.slice(2);
const log = (event: string) => appendFile(events!, JSON.stringify({ event, at: Date.now() }) + '\n');
const call = AppBackend.prototype.call, dispose = AppBackend.prototype.dispose; let delayed = false;
AppBackend.prototype.call = async function<T>(endpoint: string, payload: unknown = {}): Promise<T> {
  if (phase === 'startup' && endpoint === 'catalog' && !delayed) { delayed = true; await log('startup-start'); await new Promise(resolve => setTimeout(resolve, 350)); await log('startup-end'); }
  return call.call(this, endpoint, payload) as Promise<T>;
};
AppBackend.prototype.dispose = async function() { await log('dispose-start'); await new Promise(resolve => setTimeout(resolve, 600)); await dispose.call(this); await log('dispose-end'); };
process.on('message', value => { if ((value as { interrupt?: boolean })?.interrupt) process.emit('SIGTERM'); });
process.argv = [process.execPath, process.argv[1]!, ...sidecarArguments];
await import('../../src/sidecar/main.ts');
