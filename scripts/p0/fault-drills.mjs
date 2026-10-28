// P0故障演练：只用隔离profile和mock导演。每项恢复状态、未知回执及自有进程回收都是硬门槛。
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { ownedTree, stillOwned, killOwned, sleep, waitUntil, withTimeout } from './process-evidence.mjs';
import { assertCrashRecovery, assertCancelRecovery, assertHostShutdown, assertLocalExportRecovery } from './fault-drill-contracts.mjs';

const rendering = processes => processes.filter(row => /chrom|ffmpeg/i.test(row.comm));
export async function startSidecar(bin, profile, timeoutMs = 30_000) {
  const child = spawn(bin, ['--data-root', join(profile, 'data'), '--projects-root', join(profile, 'projects'), '--resource-root', join(dirname(bin), 'resources'), '--mock', '--lock-timeout-ms', '3000'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let stderr = ''; child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
  const lines = createInterface({ input: child.stdout });
  try {
    const ready = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('sidecar ready超时')), timeoutMs);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail); child.once('exit', (code, signal) => fail(new Error(`sidecar在ready前退出：${code ?? signal}`)));
      lines.on('line', line => {
        if (line.length > 8192) return fail(new Error('sidecar握手超过8KiB'));
        let value; try { value = JSON.parse(line); } catch { return fail(new Error('sidecar首行不是JSON握手')); }
        if (value.type !== 'ready' || value.protocolVersion !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin) || !/^[0-9a-f]{64}$/.test(value.token)) return fail(new Error('sidecar未返回有效协议1 ready握手'));
        clearTimeout(timer); accept(value);
      });
    });
    const api = async (endpoint, payload = {}, signal) => {
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      const response = await fetch(ready.origin + '/api/' + endpoint, { method: 'POST', signal: requestSignal, headers: { 'content-type': 'application/json', 'x-yingliu-token': ready.token, origin: ready.origin }, body: JSON.stringify(payload) });
      const result = await response.json(); if (!result.ok) throw new Error(endpoint + ': ' + result.error?.message); return result.value;
    };
    return { child, ready, api, exited, async stop() {
      if (child.exitCode !== null || child.signalCode !== null) { await withTimeout(exited, 5000, 'sidecar管道关闭'); return; }
      child.stdin.write('{"type":"shutdown"}\n');
      await withTimeout(exited, 20_000, 'sidecar关闭');
      assert.equal(child.exitCode, 0, 'sidecar未正常关闭');
    } };
  } catch (error) {
    let descendants = []; try { descendants = await ownedTree(child.pid); } catch {}
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await killOwned(descendants); await withTimeout(exited, 5000, '失败sidecar回收'); throw error;
  } finally { lines.close(); }
}
async function prepare(sidecar) {
  await sidecar.api('models.connection.save', { id: 'cli-mock', name: 'mock', protocol: 'chat-completions', baseUrl: 'http://mock.yingliu.invalid/v1', auth: 'none' });
  await sidecar.api('models.model.save', { id: 'cli-mock-director', connectionId: 'cli-mock', model: 'mock-director', name: 'mock', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
  await sidecar.api('models.role.bind', { role: 'director', modelId: 'cli-mock-director' });
  const projectId = (await sidecar.api('create', { blank: true, title: '故障演练' })).project.id;
  const started = await sidecar.api('agent.start', { projectId, goal: '演练', autoApprove: ['read', 'write', 'plan'], maxReviewRounds: 0 });
  const run = await waitUntil(async () => {
    const run = await sidecar.api('agent.get', { runId: started.id });
    if (['failed', 'complete', 'budget_exceeded'].includes(run.status)) throw new Error('未进入导出审批：' + run.status);
    return run.status === 'awaiting_approval' ? run : undefined;
  }, 30_000, '等待导出审批');
  assert.equal(run.pending?.tool, 'export_mp4'); return { projectId, run };
}
export async function runFaultDrills({ bin, start = startSidecar }) {
  const results = [];
  async function drill(name, work) {
    const profile = await mkdtemp(join(tmpdir(), 'yingliu-p0-fault-')); const children = [], observed = [];
    const launch = async () => { const sidecar = await start(bin, profile); children.push(sidecar); return sidecar; };
    const capture = async sidecar => { const processes = await ownedTree(sidecar.child.pid); observed.push(...processes); return processes; };
    let detail;
    try { detail = await work({ launch, capture }); results.push({ drill: name, ok: true, ...detail }); }
    catch (error) { results.push({ drill: name, ok: false, error: error instanceof Error ? error.message : String(error), ...(error.observations ? { observations: error.observations } : {}) }); }
    finally {
      // Evidence has already been evaluated. Cleanup can never turn an orphan failure into PASS.
      try {
        for (const sidecar of children) {
          try { await sidecar.stop(); } catch { if (sidecar.child.exitCode === null && sidecar.child.signalCode === null) sidecar.child.kill('SIGKILL'); await killOwned(observed); await withTimeout(sidecar.exited, 5000, '失败演练进程回收'); }
        }
        await killOwned(observed); await rm(profile, { recursive: true, force: true });
      } catch (error) { results.at(-1).ok = false; results.at(-1).cleanupError = error.message; }
    }
    console.log((results.at(-1).ok ? 'PASS ' : 'FAIL ') + name);
  }
  await drill('crash-during-agent-export-qc', async ({ launch, capture }) => {
    let sidecar = await launch(); const { projectId, run } = await prepare(sidecar);
    await sidecar.api('agent.approve', { runId: run.id, callId: run.pending.callId, execId: run.pending.execId, argsHash: run.pending.argsHash });
    const atCrash = await waitUntil(async () => {
      const processes = await capture(sidecar), current = await sidecar.api('agent.get', { runId: run.id });
      return rendering(processes).length && current.inFlight?.tool === 'export_mp4' ? { processes, run: current, snapshot: await sidecar.api('current', { projectId }) } : undefined;
    }, 30_000, '等待持久化export执行中的真实渲染');
    sidecar.child.kill('SIGKILL'); await withTimeout(sidecar.exited, 5000, '崩溃sidecar退出'); await sleep(3000);
    const orphansAfterGrace = (await stillOwned(atCrash.processes)).map(row => row.comm);
    const t0 = Date.now(); sidecar = await launch(); const restartAcquiredLockMs = Date.now() - t0;
    const after = await sidecar.api('agent.get', { runId: run.id }), snapshot = await sidecar.api('current', { projectId });
    const tasks = (await sidecar.api('tasks', { projectId })).tasks ?? [];
    await sleep(3000); const autoResubmittedRender = rendering(await capture(sidecar)).length > 0;
    const evidence = { renderersSeen: rendering(atCrash.processes).map(row => row.comm), orphansAfterGrace, interruptedExecId: atCrash.run.inFlight.execId, run: after, project: snapshot.project, projectId, tasks, interruptedTaskIds: atCrash.snapshot.task?.status === 'running' ? [atCrash.snapshot.task.id] : [], autoResubmittedRender };
    try { assertCrashRecovery(evidence); } catch (error) { error.observations = { renderersSeen: evidence.renderersSeen, orphansAfterGrace, runStatus: after.status, uncertain: after.uncertainSubmissions?.length ?? 0, taskStatuses: tasks.map(task => ({ id: task.id, status: task.status })), autoResubmittedRender }; throw error; }
    return { ...evidence, restartAcquiredLockMs, run: { status: after.status, uncertain: after.uncertainSubmissions?.length ?? 0 }, project: { id: snapshot.project.id, revision: snapshot.project.revision } };
  });
  await drill('crash-during-local-export-task', async ({ launch, capture }) => {
    let sidecar = await launch(); const { projectId, run } = await prepare(sidecar);
    // The agent's QC capture is a different boundary. Stop that pending run and explicitly start a real host export.
    await sidecar.api('agent.cancel', { runId: run.id });
    const before = await sidecar.api('current', { projectId });
    const submitted = await sidecar.api('export', { projectId, expectedRevision: before.project.revision });
    assert.equal(submitted.task?.kind, 'export'); const taskId = submitted.task.id;
    const atCrash = await waitUntil(async () => {
      const processes = await capture(sidecar), snapshot = await sidecar.api('current', { projectId });
      if (snapshot.task?.id !== taskId || snapshot.task.status !== 'running') throw new Error('本地导出在故障注入前已结束，未计为通过');
      return rendering(processes).length ? { processes, snapshot } : undefined;
    }, 30_000, '等待实际本地导出任务及渲染进程');
    sidecar.child.kill('SIGKILL'); await withTimeout(sidecar.exited, 5000, '本地导出sidecar崩溃退出'); await sleep(3000);
    const orphansAfterGrace = (await stillOwned(atCrash.processes)).map(row => row.comm);
    sidecar = await launch(); const snapshot = await sidecar.api('current', { projectId });
    const tasks = (await sidecar.api('tasks', { projectId })).tasks ?? [], task = tasks.find(task => task.id === taskId);
    await sleep(3000); const autoResubmittedRender = rendering(await capture(sidecar)).length > 0;
    const evidence = { renderersSeen: rendering(atCrash.processes).map(row => row.comm), orphansAfterGrace, taskId, task, project: snapshot.project, projectId, autoResubmittedRender };
    try { assertLocalExportRecovery(evidence); } catch (error) { error.observations = { renderersSeen: evidence.renderersSeen, orphansAfterGrace, taskId, taskStatus: task?.status, taskError: task?.error, autoResubmittedRender }; throw error; }
    return { ...evidence, task: { id: task.id, status: task.status, error: task.error }, project: { id: snapshot.project.id, revision: snapshot.project.revision } };
  });
  await drill('cancel-during-render', async ({ launch, capture }) => {
    const sidecar = await launch(), { projectId, run } = await prepare(sidecar);
    await sidecar.api('agent.approve', { runId: run.id, callId: run.pending.callId, execId: run.pending.execId, argsHash: run.pending.argsHash });
    const seen = await waitUntil(async () => { const processes = await capture(sidecar); return rendering(processes).length ? processes : undefined; }, 30_000, '等待取消前的渲染');
    const started = Date.now(); await sidecar.api('agent.cancel', { runId: run.id });
    const finished = await waitUntil(async () => { const value = await sidecar.api('agent.get', { runId: run.id }); return ['cancelled', 'failed', 'complete'].includes(value.status) ? value : undefined; }, 20_000, '等待取消完成');
    await sleep(1500);
    const evidence = { renderersSeen: rendering(seen).map(row => row.comm), run: finished, renderProcessesLeft: rendering(await stillOwned(seen)).map(row => row.comm), healthy: Array.isArray((await sidecar.api('list')).projects) };
    try { assertCancelRecovery(evidence); } catch (error) { error.observations = { renderersSeen: evidence.renderersSeen, runStatus: finished.status, renderProcessesLeft: evidence.renderProcessesLeft, healthy: evidence.healthy }; throw error; }
    return { ...evidence, run: { status: finished.status }, cancelMs: Date.now() - started, projectId };
  });
  await drill('client-disconnect', async ({ launch }) => {
    const sidecar = await launch(), first = new AbortController();
    const stream = fetch(sidecar.ready.origin + '/events/agent', { method: 'POST', signal: first.signal, headers: { 'x-yingliu-token': sidecar.ready.token, origin: sidecar.ready.origin } }).then(response => response.body?.cancel()).catch(() => {});
    await sleep(100); first.abort(); await stream;
    const second = new AbortController(), request = sidecar.api('create', { blank: true, title: '断连' }, second.signal).catch(() => {}); second.abort(); await request;
    const list = await sidecar.api('list'); assert.equal(sidecar.child.exitCode, null); assert.ok(Array.isArray(list.projects)); return { sidecarAlive: true, projectsAfter: list.projects.length };
  });
  await drill('host-stdin-closed', async ({ launch, capture }) => {
    const sidecar = await launch(), seen = await capture(sidecar); sidecar.child.stdin.end();
    const exit = await withTimeout(sidecar.exited, 20_000, 'stdin关闭后sidecar退出');
    const again = await launch(); await again.stop();
    const evidence = { exitCode: exit.code, ownedProcessesLeft: (await stillOwned(seen)).map(row => row.comm), relaunchOk: true }; assertHostShutdown(evidence); return evidence;
  });
  return { schemaVersion: 2, sidecar: bin, at: new Date().toISOString(), status: results.length === 5 && results.every(result => result.ok) ? 'PASS' : 'FAIL', results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), option = key => { const index = args.indexOf('--' + key); return index >= 0 ? args[index + 1] : undefined; };
  if (!option('sidecar') || !option('out')) throw new Error('用法：fault-drills.mjs --sidecar <绝对路径> --out <新验收JSON路径>');
  const report = await runFaultDrills({ bin: resolve(option('sidecar')) }), out = resolve(option('out'));
  await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.status === 'PASS' ? 0 : 1;
}
