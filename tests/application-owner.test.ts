import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createApplication, MemorySecrets, type Application } from '../src/app/application.ts';
import { acquireApplicationOwner, applicationDirectories } from '../src/app/ownership.ts';
import { acquireOwner, acquireOwnerLease, BusyError } from '../src/cli/lock.ts';

async function temporary() { const directory = await mkdtemp(join(tmpdir(), 'yingliu-app-owner-')); return { directory, dataDirectory: join(directory, 'profile'), projectsDirectory: join(directory, 'projects') }; }
const snapshot = async (app: Application, endpoint: string, payload: unknown = {}) => { const result = await app.route(endpoint, payload); assert.equal(result.ok, true, JSON.stringify(result)); return result.ok ? result.value as any : undefined; };
function child(file: string, args: string[], environment: Record<string, string>) {
  const process = spawn(globalThis.process.execPath, ['--import', 'tsx', file, ...args], { env: { ...globalThis.process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = '', err = ''; process.stdout!.on('data', bytes => { out += bytes; }); process.stderr!.on('data', bytes => { err += bytes; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => process.once('close', (code, signal) => resolve({ code, signal })));
  return { process, closed, output: () => out, errors: () => err };
}
async function stop(process: ChildProcess) { if (process.exitCode !== null || process.signalCode !== null) return; const closed = new Promise<void>(resolve => process.once('close', () => resolve())); process.kill('SIGKILL'); await closed; }
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10_000; while (!await check()) { assert.ok(Date.now() < end, '本机子进程未完成预期步骤'); await new Promise(resolve => setTimeout(resolve, 10)); } }

test('默认应用在初始化前持有profile和projects，旧CLI锁与默认应用双向互斥', async () => {
  const paths = await temporary(); let app: Application | undefined;
  try {
    app = await createApplication({ ...paths, credentials: new MemorySecrets(), resumeRemoteTasks: false });
    for (const directory of [paths.dataDirectory, paths.projectsDirectory]) await assert.rejects(acquireOwner([directory], 'old-cli', 0), BusyError);
    let reads = 0; const credentials = { async get() { reads++; return undefined; }, async set() {}, async delete() {} };
    await assert.rejects(createApplication({ ...paths, credentials }), BusyError); assert.equal(reads, 0, '竞争者不能先读取凭据或初始化恢复');
    await assert.rejects(createApplication({ dataDirectory: join(paths.directory, 'other-profile'), projectsDirectory: paths.projectsDirectory, credentials }), BusyError); assert.equal(reads, 0);
    await app.dispose(); app = undefined;
    const release = await acquireOwner([paths.dataDirectory, paths.projectsDirectory], 'legacy-owner', 0);
    try { await assert.rejects(createApplication({ ...paths, credentials }), BusyError); assert.equal(reads, 0); } finally { await release(); }
  } finally { await app?.dispose(); await rm(paths.directory, { recursive: true, force: true }); }
});

test('借用lease不自锁，应用dispose后入口仍持锁直到自己的HTTP等清理结束', async () => {
  const paths = await temporary(), owner = await acquireApplicationOwner(paths, 'desktop-entry'); let app: Application | undefined;
  try {
    app = await createApplication({ ...paths, credentials: new MemorySecrets(), ownership: owner, resumeRemoteTasks: false });
    await app.dispose(); app = undefined;
    await assert.rejects(acquireOwner([paths.dataDirectory, paths.projectsDirectory], 'before-entry-cleanup', 0), BusyError);
    await owner.release(); const release = await acquireOwner([paths.dataDirectory, paths.projectsDirectory], 'after-entry-cleanup', 0); await release();
  } finally { await app?.dispose(); await owner.release(); await rm(paths.directory, { recursive: true, force: true }); }
});

test('不同profile及projects可以并行，但不能把对方内部工程作为外部目录打开或修复', async () => {
  const paths = await temporary(); let first: Application | undefined, second: Application | undefined;
  try {
    first = await createApplication({ ...paths, credentials: new MemorySecrets(), resumeRemoteTasks: false });
    const created = await snapshot(first, 'create', { title: '独占工程', blank: true });
    const projectFile = join(created.root, 'project.json'), stage = join(created.root, '.studio', 'staging', 'must-survive.json');
    await writeFile(projectFile, 'owned projection marker'); await mkdir(join(created.root, '.studio', 'staging'), { recursive: true }); await writeFile(stage, 'owned staging marker');
    const otherProjects = join(paths.directory, 'other-projects'); await mkdir(otherProjects);
    await writeFile(join(otherProjects, 'registry.json'), JSON.stringify({ version: 1, selected: created.project.id, projects: [{ id: created.project.id, path: created.root, title: '外部工程' }], sessions: {} }));
    second = await createApplication({ dataDirectory: join(paths.directory, 'other-profile'), projectsDirectory: otherProjects, credentials: new MemorySecrets(), resumeRemoteTasks: false });
    assert.equal((await snapshot(second, 'current')).project, null, '启动恢复不能接管正在被其他profile使用的外部工程');
    const denied = await second.route('open', { path: created.root }); assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, 'BUSY');
    assert.equal(await readFile(projectFile, 'utf8'), 'owned projection marker'); assert.equal(await readFile(stage, 'utf8'), 'owned staging marker');
    const missing = join(paths.directory, 'does-not-exist'); assert.equal((await second.route('open', { path: missing })).ok, false); await assert.rejects(stat(missing), { code: 'ENOENT' });
    await first.dispose(); first = undefined;
    const opened = await snapshot(second, 'open', { path: created.root }); assert.equal(opened.project.id, created.project.id);
    await assert.rejects(stat(stage), { code: 'ENOENT' }); assert.equal(JSON.parse(await readFile(projectFile, 'utf8')).id, created.project.id);
  } finally { await first?.dispose(); await second?.dispose(); await rm(paths.directory, { recursive: true, force: true }); }
});

test('显式工程目录等待会在真实外部root释放后继续打开，且不会提前修改工程', { timeout: 10_000 }, async () => {
  const paths = await temporary(), other = { dataDirectory: join(paths.directory, 'waiting-profile'), projectsDirectory: join(paths.directory, 'waiting-projects') };
  let first: Application | undefined, waiting: Application | undefined, owner: Awaited<ReturnType<typeof acquireApplicationOwner>> | undefined;
  try {
    first = await createApplication({ ...paths, credentials: new MemorySecrets(), resumeRemoteTasks: false });
    const created = await snapshot(first, 'create', { title: '等待释放', blank: true }), projectFile = join(created.root, 'project.json'), before = await readFile(projectFile, 'utf8');
    owner = await acquireApplicationOwner(other, 'waiting-entry', 1_000);
    const originalClaim = owner.claim.bind(owner); let entered!: () => void;
    const claimed = new Promise<void>(resolve => { entered = resolve; });
    let rootWait: number | undefined, rootOptions: { existingOnly?: boolean } | undefined;
    owner.claim = (directories, timeoutMs, options) => { if (directories.includes(created.root)) { rootWait = timeoutMs; rootOptions = options; entered(); } return originalClaim(directories, timeoutMs, options); };
    waiting = await createApplication({ ...other, credentials: new MemorySecrets(), ownership: owner, projectRootWaitMs: 2_000, resumeRemoteTasks: false });
    let settled = false; const opening = waiting.route('open', { path: created.root }).then(result => { settled = true; return result; });
    await claimed; assert.equal(rootWait, 2_000); assert.deepEqual(rootOptions, { existingOnly: true });
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(settled, false, 'root仍被占用时应持续等待');
    assert.equal(await readFile(projectFile, 'utf8'), before);
    await first.dispose(); first = undefined;
    const result = await opening; assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal((result.value as any).project.id, created.project.id);
    await assert.rejects(acquireOwner([created.root], 'waiting-app-now-owns-root', 0), BusyError);
  } finally { await first?.dispose(); await waiting?.dispose(); await owner?.release(); await rm(paths.directory, { recursive: true, force: true }); }
});

test('等待真实外部root期间沿用lease取消信号，取消不释放入口已有profile锁', { timeout: 10_000 }, async () => {
  const paths = await temporary(), other = { dataDirectory: join(paths.directory, 'cancel-profile'), projectsDirectory: join(paths.directory, 'cancel-projects') }, controller = new AbortController();
  let first: Application | undefined, waiting: Application | undefined, owner: Awaited<ReturnType<typeof acquireApplicationOwner>> | undefined;
  try {
    first = await createApplication({ ...paths, credentials: new MemorySecrets(), resumeRemoteTasks: false });
    const created = await snapshot(first, 'create', { title: '可取消等待', blank: true }), projectFile = join(created.root, 'project.json'), before = await readFile(projectFile, 'utf8');
    owner = await acquireApplicationOwner(other, 'cancel-entry', 1_000, controller.signal);
    const originalClaim = owner.claim.bind(owner); let entered!: () => void;
    const claimed = new Promise<void>(resolve => { entered = resolve; });
    owner.claim = (directories, timeoutMs, options) => { if (directories.includes(created.root)) entered(); return originalClaim(directories, timeoutMs, options); };
    waiting = await createApplication({ ...other, credentials: new MemorySecrets(), ownership: owner, projectRootWaitMs: 5_000, resumeRemoteTasks: false });
    let settled = false; const opening = waiting.route('open', { path: created.root }).then(result => { settled = true; return result; });
    await claimed; await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(settled, false);
    controller.abort(new Error('测试取消工程锁等待'));
    const result = await opening; assert.equal(result.ok, false); if (!result.ok) assert.match(result.error.message, /测试取消工程锁等待/);
    assert.equal(await readFile(projectFile, 'utf8'), before);
    await assert.rejects(acquireOwner([created.root], 'first-still-owns-root', 0), BusyError);
    await waiting.dispose(); waiting = undefined;
    for (const directory of [other.dataDirectory, other.projectsDirectory]) await assert.rejects(acquireOwner([directory], 'entry-not-drained', 0), BusyError);
    await owner.release(); owner = undefined;
    const release = await acquireOwner([other.dataDirectory, other.projectsDirectory], 'after-entry-cleanup', 0); await release();
  } finally { controller.abort(); await first?.dispose(); await waiting?.dispose(); await owner?.release(); await rm(paths.directory, { recursive: true, force: true }); }
});

test('工程目录等待参数在初始化前拒绝无效值，CLI拒绝秒转毫秒溢出', { timeout: 10_000 }, async () => {
  const paths = await temporary(); let reads = 0, cli: ReturnType<typeof child> | undefined;
  const credentials = { async get() { reads++; return undefined; }, async set() {}, async delete() {} };
  try {
    for (const projectRootWaitMs of [-1, NaN, Infinity]) await assert.rejects(createApplication({ ...paths, credentials, projectRootWaitMs }), RangeError);
    assert.equal(reads, 0); await assert.rejects(stat(paths.dataDirectory), { code: 'ENOENT' });
    cli = child(join(import.meta.dirname, '../src/cli/bin.ts'), ['project', 'list', '--json', '--lock-timeout', '1e308'], { YINGLIU_DATA_DIR: paths.dataDirectory, YINGLIU_PROJECTS: paths.projectsDirectory });
    assert.equal((await cli.closed).code, 2, cli.errors()); const response = JSON.parse(cli.output()); assert.equal(response.error.code, 'USAGE');
    await assert.rejects(stat(paths.dataDirectory), { code: 'ENOENT' });
  } finally { if (cli) await stop(cli.process); await rm(paths.directory, { recursive: true, force: true }); }
});

test('新建、复制、工程包导入的实际root都在同一个应用lease中', async () => {
  const paths = await temporary(); let app: Application | undefined;
  try {
    app = await createApplication({ ...paths, credentials: new MemorySecrets(), resumeRemoteTasks: false });
    const original = await snapshot(app, 'create', { title: '原工程', blank: true });
    const copied = await snapshot(app, 'duplicate', { projectId: original.project.id, title: '副本' });
    const archive = await snapshot(app, 'app.exportProject', { projectId: original.project.id });
    const imported = await snapshot(app, 'app.importProject', { dataBase64: archive.dataBase64 });
    for (const project of [original, copied, imported]) await assert.rejects(acquireOwner([project.root], 'other-project-owner', 0), BusyError);
  } finally { await app?.dispose(); await rm(paths.directory, { recursive: true, force: true }); }
});

test('应用初始化失败会清理部分服务并释放自己取得的全部所有权', async () => {
  const paths = await temporary(); await mkdir(paths.projectsDirectory, { recursive: true }); await writeFile(join(paths.projectsDirectory, 'registry.json'), '{invalid');
  try {
    await assert.rejects(createApplication({ ...paths, credentials: new MemorySecrets(), resumeRemoteTasks: false }), /JSON|Unexpected|property/i);
    assert.equal(await readFile(join(paths.projectsDirectory, 'registry.json'), 'utf8'), '{invalid');
    const release = await acquireOwner([paths.dataDirectory, paths.projectsDirectory], 'after-startup-failure', 0); await release();
  } finally { await rm(paths.directory, { recursive: true, force: true }); }
});

test('同lease动态claim兼容别名和单端口配置，失败claim不释放已持有目录', async () => {
  const paths = await temporary(), previous = process.env.YINGLIU_LOCK_PORT;
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  process.env.YINGLIU_LOCK_PORT = String(port); const owner = await acquireOwnerLease([paths.dataDirectory, paths.projectsDirectory], 'lease-owner', 0);
  try {
    const alias = join(paths.directory, 'alias'); await symlink(paths.dataDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await Promise.all([owner.claim([alias]), owner.claim([paths.projectsDirectory]), owner.claim([paths.dataDirectory])]);
    await assert.rejects(owner.claim([join(paths.directory, 'missing')], 0, { existingOnly: true }), { code: 'ENOENT' });
    await assert.rejects(acquireOwner([alias], 'foreign-lease', 0), BusyError);
    await Promise.all([owner.release(), owner.release()]);
    const release = await acquireOwner([alias], 'after-release', 0); await release();
  } finally { await owner.release(); if (previous === undefined) delete process.env.YINGLIU_LOCK_PORT; else process.env.YINGLIU_LOCK_PORT = previous; await rm(paths.directory, { recursive: true, force: true }); }
});

test('CLI真实入口借用同一lease，应用持锁时JSON稳定返回BUSY', { timeout: 15_000 }, async () => {
  const paths = await temporary(); let app: Application | undefined, cli: ReturnType<typeof child> | undefined;
  try {
    app = await createApplication({ ...paths, credentials: new MemorySecrets(), resumeRemoteTasks: false });
    cli = child(join(import.meta.dirname, '../src/cli/bin.ts'), ['project', 'list', '--json', '--lock-timeout', '0'], { YINGLIU_DATA_DIR: paths.dataDirectory, YINGLIU_PROJECTS: paths.projectsDirectory });
    assert.equal((await cli.closed).code, 9, cli.errors()); const response = JSON.parse(cli.output()); assert.equal(response.ok, false); assert.equal(response.error.code, 'BUSY');
  } finally { if (cli) await stop(cli.process); await app?.dispose(); await rm(paths.directory, { recursive: true, force: true }); }
});

test('CLI真实入口启动中持锁，桌面使用的默认应用不能抢先初始化', { timeout: 15_000 }, async () => {
  const paths = await temporary(), events = join(paths.directory, 'cli-events.jsonl'); let cli: ReturnType<typeof child> | undefined, app: Application | undefined;
  try {
    cli = child(join(import.meta.dirname, 'fixtures/cli-signal-main-child.ts'), ['startup', events], { YINGLIU_DATA_DIR: paths.dataDirectory, YINGLIU_PROJECTS: paths.projectsDirectory });
    await until(async () => (await readFile(events, 'utf8').catch(() => '')).includes('startup-start'));
    let reads = 0; const credentials = { async get() { reads++; return undefined; }, async set() {}, async delete() {} };
    await assert.rejects(createApplication({ ...paths, credentials }), BusyError); assert.equal(reads, 0);
    if (process.platform === 'win32') cli.process.send!({ interrupt: true }); else cli.process.kill('SIGTERM');
    assert.equal((await cli.closed).code, 143, cli.errors());
    app = await createApplication({ ...paths, credentials: new MemorySecrets(), resumeRemoteTasks: false });
  } finally { if (cli) await stop(cli.process); await app?.dispose(); await rm(paths.directory, { recursive: true, force: true }); }
});

test('web-server真实入口与CLI互斥，SIGTERM清理后可以重新取得profile', { timeout: 20_000 }, async () => {
  const paths = await temporary(); let web: ReturnType<typeof child> | undefined, cli: ReturnType<typeof child> | undefined;
  try {
    web = child(join(import.meta.dirname, 'fixtures/web-owner-child.ts'), [], { YINGLIU_DATA_DIR: paths.dataDirectory, YINGLIU_PROJECTS: paths.projectsDirectory, YINGLIU_PORT: '0' });
    await until(() => { assert.equal(web!.process.exitCode, null, web!.errors()); return web!.output().includes('映流智能体 ready:'); });
    cli = child(join(import.meta.dirname, '../src/cli/bin.ts'), ['project', 'list', '--json', '--lock-timeout', '0'], { YINGLIU_DATA_DIR: paths.dataDirectory, YINGLIU_PROJECTS: paths.projectsDirectory });
    assert.equal((await cli.closed).code, 9, cli.errors());
    if (process.platform === 'win32') web.process.send!({ interrupt: true }); else web.process.kill('SIGTERM');
    assert.equal((await web.closed).code, 0, web.errors());
    const release = await acquireOwner([paths.dataDirectory, paths.projectsDirectory], 'after-web-shutdown', 0); await release();
  } finally { if (cli) await stop(cli.process); if (web) await stop(web.process); await rm(paths.directory, { recursive: true, force: true }); }
});

test('web-server监听失败仍清理应用并释放profile和projects', { timeout: 15_000 }, async () => {
  const paths = await temporary(), occupied = createServer(); let web: ReturnType<typeof child> | undefined;
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve)); const port = (occupied.address() as { port: number }).port;
  try {
    web = child(join(import.meta.dirname, 'fixtures/web-owner-child.ts'), [], { YINGLIU_DATA_DIR: paths.dataDirectory, YINGLIU_PROJECTS: paths.projectsDirectory, YINGLIU_PORT: String(port) });
    assert.equal((await web.closed).code, 1); assert.match(web.errors(), /EADDRINUSE|address already in use/);
    const release = await acquireOwner([paths.dataDirectory, paths.projectsDirectory], 'after-listen-failure', 0); await release();
  } finally { if (web) await stop(web.process); await new Promise<void>(resolve => occupied.close(() => resolve())); await rm(paths.directory, { recursive: true, force: true }); }
});

for (const phase of ['startup', 'dispose']) test(`web-server在${phase}收到重复终止请求，清理结束前持续持有全部所有权`, { timeout: 15_000 }, async () => {
  const paths = await temporary(), events = join(paths.directory, 'events.jsonl'); let web: ReturnType<typeof child> | undefined;
  const signal = () => { if (process.platform === 'win32') web!.process.send!({ interrupt: true }); else web!.process.kill('SIGTERM'); };
  try {
    web = child(join(import.meta.dirname, 'fixtures/web-owner-child.ts'), [phase, events], { YINGLIU_DATA_DIR: paths.dataDirectory, YINGLIU_PROJECTS: paths.projectsDirectory, YINGLIU_PORT: '0' });
    if (phase === 'startup') await until(async () => (await readFile(events, 'utf8').catch(() => '')).includes('startup-start'));
    else await until(() => web!.output().includes('映流智能体 ready:'));
    signal(); await until(async () => (await readFile(events, 'utf8').catch(() => '')).includes('dispose-start')); signal();
    await assert.rejects(acquireOwner([paths.dataDirectory, paths.projectsDirectory], 'during-web-cleanup', 0), error => error instanceof BusyError && error.owner?.pid === web!.process.pid);
    assert.equal((await web.closed).code, 0, web.errors());
    assert.match(await readFile(events, 'utf8'), /dispose-end/);
    const release = await acquireOwner([paths.dataDirectory, paths.projectsDirectory], 'after-web-cleanup', 0); await release();
  } finally { if (web) await stop(web.process); await rm(paths.directory, { recursive: true, force: true }); }
});

test('目录解析按显式参数、环境变量和profile默认路径依次选择', () => {
  const previous = process.env.YINGLIU_PROJECTS;
  const profile=join(tmpdir(),'yingliu-owner-profile'),environment=join(tmpdir(),'yingliu-owner-env-projects'),explicit=join(tmpdir(),'yingliu-owner-explicit-projects');
  try { process.env.YINGLIU_PROJECTS = environment; assert.equal(applicationDirectories({ dataDirectory: profile }).projectsDirectory, environment); assert.equal(applicationDirectories({ dataDirectory: profile, projectsDirectory: explicit }).projectsDirectory, explicit); delete process.env.YINGLIU_PROJECTS; assert.equal(applicationDirectories({ dataDirectory: profile }).projectsDirectory, join(profile,'projects')); }
  finally { if (previous === undefined) delete process.env.YINGLIU_PROJECTS; else process.env.YINGLIU_PROJECTS = previous; }
});
