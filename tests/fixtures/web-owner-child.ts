/** Test-only IPC adapter for platforms that cannot send a POSIX signal to a Node child. */
import { appendFile } from 'node:fs/promises';
import { AppBackend } from '../../src/app/backend.ts';
const [phase, events] = process.argv.slice(2);
const log = (event: string) => events ? appendFile(events, JSON.stringify({ event, at: Date.now() }) + '\n') : Promise.resolve();
const call = AppBackend.prototype.call, dispose = AppBackend.prototype.dispose; let delayed = false;
AppBackend.prototype.call = async function<T>(endpoint: string, payload: unknown = {}): Promise<T> {
  if (phase === 'startup' && endpoint === 'catalog' && !delayed) { delayed = true; await log('startup-start'); await new Promise(resolve => setTimeout(resolve, 350)); await log('startup-end'); }
  return call.call(this, endpoint, payload) as Promise<T>;
};
AppBackend.prototype.dispose = async function() { if (phase) { await log('dispose-start'); await new Promise(resolve => setTimeout(resolve, 600)); } await dispose.call(this); if (phase) await log('dispose-end'); };
process.on('message', value => { if ((value as { interrupt?: boolean })?.interrupt) process.emit('SIGTERM'); });
await import('../../src/app/web-server.ts');
process.channel?.unref();
process.once('beforeExit', () => { if (process.connected) process.disconnect?.(); });
