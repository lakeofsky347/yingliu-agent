// Linux PSS测量。三种模式的ready判据明确分层，不把WebView load、React挂载和后台握手当成同一冷启动指标。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { ownedTree, stillOwned, killOwned, sleep, withTimeout } from './process-evidence.mjs';
import { READY_CRITERIA, EDITOR_READY_EXPRESSION, clearCacheEvidence, summarizeSamples } from './measurement-policy.mjs';

async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
export function parseRollup(text) {
  const field = name => { const value = text.match(new RegExp('^' + name + ':\\s+(\\d+)', 'm')); if (!value) throw new Error('缺少' + name); return Number(value[1]) * 1024; };
  return { pss: field('Pss'), rss: field('Rss') };
}
async function memory(pid) {
  const processes = await ownedTree(pid), sampled = [], missing = [];
  for (const processInfo of processes) {
    try {
      const text = await readFile(`/proc/${processInfo.pid}/smaps_rollup`, 'utf8');
      sampled.push({ ...processInfo, ...parseRollup(text) });
    } catch { if ((await stillOwned([processInfo])).length) missing.push(processInfo.pid); }
  }
  if (!sampled.length || missing.length) throw new Error('PSS测量缺失，样本无效：' + missing.join(','));
  return { pssBytes: sampled.reduce((sum, row) => sum + row.pss, 0), rssBytes: sampled.reduce((sum, row) => sum + row.rss, 0), processes: sampled };
}
async function electronReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) });
    const pages = await response.json(), page = pages.find(page => page.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+/.test(page.url)); if (!page?.webSocketDebuggerUrl) return false;
    return await withTimeout(new Promise(resolve => {
      const socket = new WebSocket(page.webSocketDebuggerUrl);
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: EDITOR_READY_EXPRESSION, returnByValue: true } }));
      socket.onmessage = message => { let value; try { value = JSON.parse(message.data); } catch { socket.close(); resolve(false); return; } if (value.id !== 1) return; socket.close(); resolve(value.result?.result?.value === true); };
      socket.onerror = () => { socket.close(); resolve(false); };
      setTimeout(() => socket.close(), 1900).unref?.();
    }), 2000, '编辑器挂载检查');
  } catch { return false; }
}
export async function measureOnce(options, run) {
  const cache = clearCacheEvidence({ requested: options.dropCaches, command: options.cacheClearCommand, args: options.cacheClearArgs });
  const sample = { run, valid: false, readyCriterion: READY_CRITERIA[options.mode].id, cache, readyMs: null, s0: null, exitedWithin15s: false, leftovers: [] };
  if (cache.requested && !cache.succeeded) return { ...sample, error: cache.error };
  if (process.platform !== 'linux') return { ...sample, error: '本脚本只在Linux读取/proc PSS，未将其他平台的缺失读数记为0' };
  const data = await mkdtemp(join(tmpdir(), 'p0-measure-')); let child, exited, captured = [], stderr = '', readyMs;
  const readers = [];
  try {
    const env = { ...process.env, YINGLIU_DATA_DIR: join(data, 'data'), YINGLIU_PROJECTS: join(data, 'projects') }; let command, cdp;
    if (options.mode === 'electron') { cdp = await freePort(); command = [join(options.app, 'yingliu-agent'), '--remote-debugging-port=' + cdp]; }
    else if (options.mode === 'tauri') { command = [options.app]; env.YINGLIU_SIDECAR = options.sidecar; }
    else command = [options.sidecar, '--data-root', join(data, 'data'), '--projects-root', join(data, 'projects'), '--resource-root', join(dirname(options.sidecar), 'resources')];
    const t0 = performance.now(); child = spawn(command[0], command.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] });
    exited = new Promise(resolve => { child.once('close', (code, signal) => resolve({ code, signal })); });
    let spawnError; child.once('error', error => { spawnError = error; });
    function line(text) {
      if (readyMs !== undefined) return;
      if (options.mode === 'tauri' && /page-load-finished url=http:\/\/127\.0\.0\.1:\d+/.test(text)) readyMs = performance.now() - t0;
      if (options.mode === 'sidecar') try { const value = JSON.parse(text); if (value.type === 'error') spawnError = new Error('sidecar启动失败'); if (value.type === 'ready' && value.protocolVersion === 1 && value.pid === child.pid) readyMs = performance.now() - t0; } catch {}
    }
    const output = createInterface({ input: child.stdout }), errors = createInterface({ input: child.stderr }); readers.push(output, errors);
    output.on('line', line); errors.on('line', text => { stderr = (stderr + text + '\n').slice(-8192); line(text); });
    const deadline = performance.now() + (options.readyTimeoutMs ?? 60_000);
    while (readyMs === undefined && performance.now() < deadline) {
      if (spawnError) throw spawnError; if (child.exitCode !== null || child.signalCode !== null) throw new Error('ready前进程已退出');
      if (options.mode === 'electron' && await electronReady(cdp)) readyMs = performance.now() - t0;
      if (readyMs === undefined) await sleep(25);
    }
    if (readyMs === undefined) throw new Error('未达到本模式ready判据；未采集S0');
    sample.readyMs = Math.round(readyMs);
    // The S0 clock always starts at the recorded criterion; failed readiness never advances to idle measurement.
    await sleep(options.idleMs);
    captured = await ownedTree(child.pid); sample.s0 = await memory(child.pid);
    if (options.mode === 'sidecar') child.stdin.write('{"type":"shutdown"}\n'); else child.kill('SIGTERM');
    await withTimeout(exited, 15_000, '被测应用退出'); sample.exitedWithin15s = true;
    await sleep(300); sample.leftovers = (await stillOwned(captured)).map(row => row.comm);
    if (sample.leftovers.length) throw new Error('退出后仍有自有进程，样本无效');
    sample.valid = true;
  } catch (error) { sample.error = error instanceof Error ? error.message : String(error); }
  finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      if (!captured.length) try { captured = await ownedTree(child.pid); } catch {}
      child.kill('SIGKILL'); if (exited) try { await withTimeout(exited, 5000, '强制回收测量进程'); } catch (error) { sample.valid = false; sample.error = error.message; }
    }
    try { await killOwned(captured); } catch (error) { sample.valid = false; sample.error = '自有进程清理未完成：' + error.message; }
    for (const reader of readers) reader.close();
    sample.stderrTail = stderr.split('\n').filter(line => line && !/token|authorization|api.key/i.test(line)).slice(-5);
    await rm(data, { recursive: true, force: true });
  }
  return sample;
}
export async function runMeasurement(options) {
  if (!READY_CRITERIA[options.mode] || !Number.isSafeInteger(options.runs) || options.runs < 1 || options.runs > 100 || !Number.isSafeInteger(options.idleMs) || options.idleMs < 0) throw new Error('mode/runs/idle-ms无效');
  if (options.mode !== 'sidecar' && !options.app || options.mode !== 'electron' && !options.sidecar) throw new Error('被测模式缺少--app或--sidecar');
  const samples = []; for (let run = 0; run < options.runs; run++) { const sample = await measureOnce(options, run); samples.push(sample); console.log(JSON.stringify({ run, valid: sample.valid, readyCriterion: sample.readyCriterion, readyMs: sample.readyMs, error: sample.error })); }
  return { schemaVersion: 2, status: samples.every(sample => sample.valid) ? 'PASS' : 'FAIL', summary: summarizeSamples(options.mode, samples, options.idleMs), measuredAt: new Date().toISOString(), host: { platform: process.platform, kernel: spawnSync('uname', ['-sr'], { encoding: 'utf8' }).stdout?.trim() ?? null }, samples };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), option = (key, fallback) => { const index = args.indexOf('--' + key); return index >= 0 ? args[index + 1] : fallback; };
  if (!option('out')) throw new Error('需要--out保存新的原始测量记录');
  const options = { mode: option('mode'), runs: Number(option('runs', 10)), idleMs: Number(option('idle-ms', 10_000)), app: option('app') && resolve(option('app')), sidecar: option('sidecar') && resolve(option('sidecar')), dropCaches: args.includes('--drop-caches'), cacheClearCommand: option('cache-clear-command'), cacheClearArgs: option('cache-clear-args') ? JSON.parse(option('cache-clear-args')) : [] };
  if (!Array.isArray(options.cacheClearArgs) || options.cacheClearArgs.some(value => typeof value !== 'string')) throw new Error('--cache-clear-args须为字符串数组JSON');
  const report = await runMeasurement(options), out = resolve(option('out')); await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.status === 'PASS' ? 0 : 1;
}
