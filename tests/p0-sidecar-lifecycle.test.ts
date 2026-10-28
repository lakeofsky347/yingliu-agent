import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { acquireOwner, BusyError } from '../src/cli/lock.ts';
import { createApplication, MemorySecrets, type Application } from '../src/app/application.ts';

async function sandbox() {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-p0-sidecar-')), data = join(directory, 'data'), projects = join(directory, 'projects'), resources = join(directory, 'resources');
  await mkdir(join(resources, 'ui'), { recursive: true }); await writeFile(join(resources, 'ui/index.html'), '<html><head><meta name="yingliu-token" content="__APP_TOKEN__"></head><body><div id="root"></div></body></html>');
  return { directory, data, projects, resources, args: ['--data-root', data, '--projects-root', projects, '--resource-root', resources, '--mock'] };
}
function launch(args: string[], fixture?: { phase: string; events: string }) {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture ? join(import.meta.dirname, 'fixtures/p0-sidecar-child.ts') : join(import.meta.dirname, '../src/sidecar/main.ts'), ...(fixture ? [fixture.phase, fixture.events] : []), ...args], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let out = '', err = ''; child.stdout!.on('data', bytes => { out += bytes; }); child.stderr!.on('data', bytes => { err += bytes; });
  const closed = new Promise<{ code: number | null }>(resolve => child.once('close', code => resolve({ code })));
  const messages = () => out.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const ready = async () => { await until(() => { if (child.exitCode !== null) throw new Error('sidecar提前退出：' + out + err); return out.includes('"type":"ready"'); }); return messages().find(value => value.type === 'ready'); };
  return { child, closed, ready, messages, errors: () => err };
}
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10_000; while (!await check()) { assert.ok(Date.now() < end, 'sidecar未完成预期步骤'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function stop(child: ChildProcess) { if (child.exitCode !== null || child.signalCode !== null) return; const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGKILL'); await closed; }
const terminate = (child: ChildProcess) => process.platform === 'win32' ? child.send!({ interrupt: true }) : child.kill('SIGTERM');

for (const shutdown of ['request', 'stdin-closed']) test(`sidecar借用共同lease可ready、阻止CLI竞争且通过${shutdown}完整释放`, { timeout: 15_000 }, async () => {
  const files = await sandbox(); let sidecar: ReturnType<typeof launch> | undefined;
  try {
    sidecar = launch(files.args); const ready = await sidecar.ready(); assert.equal(ready.protocolVersion, 1); assert.match(ready.token, /^[0-9a-f]{64}$/);
    await assert.rejects(acquireOwner([files.data, files.projects], 'competing-cli', 0), BusyError);
    const response = await fetch(ready.origin + '/api/create', { method: 'POST', headers: { 'content-type': 'application/json', 'x-yingliu-token': ready.token, origin: ready.origin }, body: JSON.stringify({ title: '隔离工程', blank: true }) });
    const created = await response.json(); assert.equal(created.ok, true); assert.ok(created.value.project.id);
    await assert.rejects(acquireOwner([created.value.root], 'external-project-competitor', 0), BusyError);
    if (shutdown === 'request') sidecar.child.stdin!.write('{"type":"shutdown"}\n'); else sidecar.child.stdin!.end();
    assert.equal((await sidecar.closed).code, 0, sidecar.errors()); assert.ok(sidecar.messages().some(value => value.type === 'shutdown' && value.ok && value.reason === shutdown));
    const release = await acquireOwner([files.data, files.projects, created.value.root], 'after-sidecar-cleanup', 0); await release();
  } finally { if (sidecar) await stop(sidecar.child); await rm(files.directory, { recursive: true, force: true }); }
});

test('已被默认应用占用的sidecar先返回BUSY，不会进入恢复', { timeout: 15_000 }, async () => {
  const files = await sandbox(); let app: Application | undefined, sidecar: ReturnType<typeof launch> | undefined;
  try {
    app = await createApplication({ dataDirectory: files.data, projectsDirectory: files.projects, credentials: new MemorySecrets(), resumeRemoteTasks: false });
    sidecar = launch(files.args); assert.equal((await sidecar.closed).code, 9, sidecar.errors());
    assert.equal(sidecar.messages().length, 1); assert.equal(sidecar.messages()[0].code, 'BUSY');
  } finally { if (sidecar) await stop(sidecar.child); await app?.dispose(); await rm(files.directory, { recursive: true, force: true }); }
});

test('sidecar在HTTP监听失败后清理借用应用和lease再返回单个STARTUP', { timeout: 15_000 }, async () => {
  const files = await sandbox(), occupied = createServer(); let sidecar: ReturnType<typeof launch> | undefined;
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve)); const port = (occupied.address() as { port: number }).port;
  try {
    sidecar = launch([...files.args, '--port', String(port)]); assert.equal((await sidecar.closed).code, 11, sidecar.errors());
    assert.equal(sidecar.messages().length, 1); assert.equal(sidecar.messages()[0].type, 'error'); assert.equal(sidecar.messages()[0].code, 'STARTUP');
    const release = await acquireOwner([files.data, files.projects], 'after-sidecar-startup-failure', 0); await release();
  } finally { if (sidecar) await stop(sidecar.child); await new Promise<void>(resolve => occupied.close(() => resolve())); await rm(files.directory, { recursive: true, force: true }); }
});

for (const phase of ['startup', 'dispose']) test(`sidecar在${phase}被重复终止，清理完成前仍保持共同所有权`, { timeout: 15_000 }, async () => {
  const files = await sandbox(), events = join(files.directory, 'events.jsonl'); let sidecar: ReturnType<typeof launch> | undefined;
  try {
    sidecar = launch(files.args, { phase, events });
    if (phase === 'startup') await until(async () => (await readFile(events, 'utf8').catch(() => '')).includes('startup-start')); else await sidecar.ready();
    terminate(sidecar.child); await until(async () => (await readFile(events, 'utf8').catch(() => '')).includes('dispose-start')); terminate(sidecar.child);
    await assert.rejects(acquireOwner([files.data, files.projects], 'during-sidecar-cleanup', 0), error => error instanceof BusyError && error.owner?.pid === sidecar!.child.pid);
    assert.equal((await sidecar.closed).code, 0, sidecar.errors()); assert.match(await readFile(events, 'utf8'), /dispose-end/);
    assert.ok(sidecar.messages().some(value => value.type === 'shutdown' && value.ok));
    const release = await acquireOwner([files.data, files.projects], 'after-sidecar-shutdown', 0); await release();
  } finally { if (sidecar) await stop(sidecar.child); await rm(files.directory, { recursive: true, force: true }); }
});
