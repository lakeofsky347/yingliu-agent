import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const helper = (name: string) => import(new URL('../scripts/p0/' + name, import.meta.url).href);
const contracts = await helper('fault-drill-contracts.mjs'), policy = await helper('measurement-policy.mjs');
const processes = await helper('process-evidence.mjs'), measurement = await helper('measure.mjs');

function crashEvidence() { return { renderersSeen: ['owned-chromium'], orphansAfterGrace: [], interruptedExecId: 'exec-one', run: { status: 'paused', inFlight: undefined, uncertainSubmissions: [{ execId: 'exec-one' }], queue: [] }, project: { id: 'project-one' }, projectId: 'project-one', autoResubmittedRender: false, interruptedTaskIds: ['task-one'], tasks: [{ id: 'task-one', status: 'failed' }] }; }
test('crash drill refuses incorrect recovery state, lost uncertain receipt, orphan process and automatic resubmission', () => {
  contracts.assertCrashRecovery(crashEvidence());
  const mutations = [
    (value: any) => { value.run.status = 'running'; },
    (value: any) => { value.run.uncertainSubmissions = []; },
    (value: any) => { value.run.uncertainSubmissions = [{ execId: 'different-execution' }]; },
    (value: any) => { value.run.inFlight = { execId: 'exec-one' }; },
    (value: any) => { value.run.queue = [{ execId: 'exec-one' }]; },
    (value: any) => { value.orphansAfterGrace = ['owned-chromium']; },
    (value: any) => { value.renderersSeen = []; },
    (value: any) => { value.autoResubmittedRender = true; },
    (value: any) => { value.tasks[0].status = 'running'; },
  ];
  for (const mutate of mutations) { const broken = crashEvidence(); mutate(broken); assert.throws(() => contracts.assertCrashRecovery(broken)); }
});

test('cancel and host-death drills cannot pass without a renderer observation or confirmed cleanup', () => {
  const cancelled = { renderersSeen: ['owned-chromium'], run: { status: 'cancelled' }, renderProcessesLeft: [], healthy: true };
  contracts.assertCancelRecovery(cancelled);
  for (const broken of [{ ...cancelled, renderersSeen: [] }, { ...cancelled, run: { status: 'failed' } }, { ...cancelled, renderProcessesLeft: ['owned-chromium'] }, { ...cancelled, healthy: false }]) assert.throws(() => contracts.assertCancelRecovery(broken));
  contracts.assertHostShutdown({ exitCode: 0, ownedProcessesLeft: [], relaunchOk: true });
  assert.throws(() => contracts.assertHostShutdown({ exitCode: 'timeout', ownedProcessesLeft: [], relaunchOk: true }));
  assert.throws(() => contracts.assertHostShutdown({ exitCode: 0, ownedProcessesLeft: ['sidecar'], relaunchOk: true }));
  const localExport = { renderersSeen: ['owned-chromium'], orphansAfterGrace: [], taskId: 'actual-export', task: { id: 'actual-export', status: 'failed', error: 'TASK_INTERRUPTED' }, project: { id: 'project-one' }, projectId: 'project-one', autoResubmittedRender: false };
  contracts.assertLocalExportRecovery(localExport);
  assert.throws(() => contracts.assertLocalExportRecovery({ ...localExport, task: undefined }));
  assert.throws(() => contracts.assertLocalExportRecovery({ ...localExport, task: { ...localExport.task, status: 'running' } }));
  assert.throws(() => contracts.assertLocalExportRecovery({ ...localExport, task: { ...localExport.task, error: '' } }));
});

test('failed cache clearing never becomes a cold sample and the script never defaults to sudo', () => {
  let calls = 0;
  const execute = () => { calls++; return { status: 1 }; };
  const missing = policy.clearCacheEvidence({ requested: true }, execute); assert.equal(missing.coldEligible, false); assert.equal(calls, 0);
  const sudo = policy.clearCacheEvidence({ requested: true, command: '/usr/bin/sudo' }, execute); assert.equal(sudo.coldEligible, false); assert.equal(calls, 0);
  const failed = policy.clearCacheEvidence({ requested: true, command: process.execPath }, execute); assert.equal(failed.succeeded, false); assert.equal(failed.coldEligible, false); assert.equal(calls, 1);
  assert.equal(policy.clearCacheEvidence({ requested: false }, execute).state, 'uncontrolled'); assert.equal(calls, 1);
  const completed = policy.clearCacheEvidence({ requested: true, command: process.execPath }, () => ({ status: 0 })); assert.equal(completed.coldEligible, true);
});

test('invalid/cache-failed/missing-PSS samples are excluded and different ready criteria stay non-comparable', () => {
  const valid = { valid: true, readyMs: 100, s0: { pssBytes: 10 * 2 ** 20 }, cache: { requested: true, succeeded: true, coldEligible: true } };
  const summary = policy.summarizeSamples('electron', [valid, { ...valid, valid: false, readyMs: 1 }, { ...valid, cache: { requested: true, succeeded: false, coldEligible: true } }, { ...valid, s0: null }], 1000);
  assert.equal(summary.eligibleSamples, 1); assert.equal(summary.invalidSamples, 3); assert.equal(summary.coldSamples, 1); assert.equal(summary.observedReadyMedianMs, 100); assert.equal(summary.s0PssMedianMiB, 10);
  const empty = policy.summarizeSamples('tauri', [], 1000); assert.equal(empty.observedReadyMedianMs, null); assert.equal(empty.s0PssMedianMiB, null); assert.equal(empty.crossShellComparable, false);
  assert.equal(new Set(Object.values(policy.READY_CRITERIA).map((value: any) => value.id)).size, 3);
  assert.equal(summary.idleClock, empty.idleClock); assert.notEqual(summary.readyCriterion.id, empty.readyCriterion.id);
  assert.deepEqual(measurement.parseRollup('Rss: 24 kB\nPss: 12 kB\n'), { rss: 24 * 1024, pss: 12 * 1024 });
  assert.throws(() => measurement.parseRollup('Rss: 24 kB\n'), /缺少Pss/);
});

test('a cache command that exits unsuccessfully produces only invalid measurements before any application spawn', async () => {
  const report = await measurement.runMeasurement({ mode: 'sidecar', sidecar: '/this-application-must-never-start', runs: 2, idleMs: 0, dropCaches: true, cacheClearCommand: process.execPath, cacheClearArgs: ['-e', 'process.exit(3)'] });
  assert.equal(report.status, 'FAIL'); assert.equal(report.summary.eligibleSamples, 0); assert.equal(report.summary.coldSamples, 0);
  assert.equal(report.summary.observedReadyMedianMs, null); assert.equal(report.summary.s0PssMedianMiB, null);
  assert.ok(report.samples.every((sample: any) => sample.readyMs === null && sample.s0 === null && sample.cache.exitCode === 3));
});

test('each sidecar UI preparation rebuilds existing bundles and removes obsolete copied resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-p0-ui-build-')), target = join(directory, 'release');
  try {
    await mkdir(join(directory, 'scripts')); await writeFile(join(directory, 'revision'), 'first');
    await writeFile(join(directory, 'scripts/build.mjs'), `import {mkdir,readFile,writeFile} from 'node:fs/promises';await mkdir('dist/ui',{recursive:true});await writeFile('dist/ui/app.js',await readFile('revision'));await writeFile('dist/ui/index.html','editor');`);
    const { prepareUiResources } = await helper('build-sidecar.mjs');
    await prepareUiResources({ projectRoot: directory, targetDirectory: target });
    assert.equal(await readFile(join(target, 'resources/ui/app.js'), 'utf8'), 'first');
    await writeFile(join(target, 'resources/ui/obsolete.js'), 'old'); await writeFile(join(directory, 'revision'), 'second');
    await prepareUiResources({ projectRoot: directory, targetDirectory: target });
    assert.equal(await readFile(join(target, 'resources/ui/app.js'), 'utf8'), 'second');
    await assert.rejects(stat(join(target, 'resources/ui/obsolete.js')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unsupported Windows process evidence fails closed before spawning ps or granting signal authority', async () => {
  let calls = 0;
  await assert.rejects(processes.processTable({ platform: 'win32', execute: () => { calls++; throw new Error('must never spawn'); } }), { code: 'PROCESS_EVIDENCE_UNSUPPORTED', platform: 'win32' });
  assert.equal(calls, 0);
  if (process.platform === 'win32') {
    await assert.rejects(processes.ownedTree(process.pid), { code: 'PROCESS_EVIDENCE_UNSUPPORTED' });
    await assert.rejects(processes.killOwned([{ pid: process.pid, started: 'unverified-fixture-identity' }]), { code: 'PROCESS_EVIDENCE_UNSUPPORTED' });
  }
});

test('cleanup only terminates a real fixture child with matching birth identity', { timeout: 10_000, skip: process.platform === 'win32' ? 'POSIX出生身份/回收验收不支持Windows；另有零spawn的明确拒绝测试' : false }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  try {
    await once(child, 'spawn'); const tree = await processes.ownedTree(child.pid); const root = tree.find((row: any) => row.pid === child.pid);
    assert.ok(root?.started); await processes.killOwned([{ ...root, started: 'different-birth' }]); assert.doesNotThrow(() => process.kill(child.pid!, 0));
    await processes.killOwned([root]); await exited; assert.deepEqual(await processes.stillOwned([root]), []);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
});

test('a broken sidecar fixture causes the fault-drill command to write FAIL and exit unsuccessfully', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-p0-bad-sidecar-')), output = join(directory, 'result.json');
  try {
    const execute = promisify(execFile), script = new URL('../scripts/p0/fault-drills.mjs', import.meta.url);
    await assert.rejects(execute(process.execPath, [fileURLToPath(script), '--sidecar', process.execPath, '--out', output], { timeout: 10_000 }), (error: any) => error.code === 1);
    const report = JSON.parse(await readFile(output, 'utf8')); assert.equal(report.status, 'FAIL'); assert.equal(report.results.length, 5); assert.ok(report.results.every((result: any) => result.ok === false));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
