// P0 Day-8 fault drills against a built sidecar (mock director, real Chromium/FFmpeg render).
// Usage: node scripts/p0/fault-drills.mjs --sidecar dist-p0/node-linux-x64/yingliu-sidecar --out docs/p0/evidence/fault-drills-node.json
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2), opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const bin = resolve(opt('sidecar')), out = resolve(opt('out'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const record = (drill, ok, detail) => { results.push({ drill, ok, ...detail }); console.log((ok ? 'PASS ' : 'FAIL ') + drill + ' ' + JSON.stringify(detail).slice(0, 400)); };
const ps = () => spawnSync('ps', ['-eo', 'pid=,ppid=,comm=']).stdout.toString().trim().split('\n').map(l => l.trim().split(/\s+/)).map(([p, pp, c]) => ({ pid: +p, ppid: +pp, comm: c }));
const tree = pid => { const all = ps(), res = []; const walk = p => { for (const x of all.filter(y => y.ppid === p)) { res.push(x); walk(x.pid); } }; walk(pid); return res; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function start(profile) {
  const child = spawn(bin, ['--data-root', join(profile, 'data'), '--projects-root', join(profile, 'projects'), '--resource-root', join(dirname(bin), 'resources'), '--mock', '--lock-timeout-ms', '3000'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', d => err += d);
  const ready = await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('ready timeout ' + err)), 30000); createInterface({ input: child.stdout }).on('line', l => { try { const m = JSON.parse(l); if (m.type === 'ready' || m.type === 'error') { clearTimeout(t); res(m); } } catch {} }); });
  if (ready.type !== 'ready') throw new Error(JSON.stringify(ready));
  const api = async (e, p = {}, signal) => { const r = await fetch(ready.origin + '/api/' + e, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-yingliu-token': ready.token, origin: ready.origin }, body: JSON.stringify(p) }); const v = await r.json(); if (!v.ok) throw new Error(e + ': ' + v.error?.message); return v.value; };
  return { child, ready, api, stop: async () => { if (child.exitCode !== null || child.signalCode) return; child.stdin.write('{"type":"shutdown"}\n'); await new Promise(r => { child.once('exit', r); setTimeout(r, 20000); }); } };
}
async function prepare(s) {
  await s.api('models.connection.save', { id: 'cli-mock', name: 'mock', protocol: 'chat-completions', baseUrl: 'http://mock.yingliu.invalid/v1', auth: 'none' });
  await s.api('models.model.save', { id: 'cli-mock-director', connectionId: 'cli-mock', model: 'mock-director', name: 'mock', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
  await s.api('models.role.bind', { role: 'director', modelId: 'cli-mock-director' });
  const projectId = (await s.api('create', { blank: true, title: '故障 演练' })).project.id;
  let run = await s.api('agent.start', { projectId, goal: '演练', autoApprove: ['read', 'write', 'plan'], maxReviewRounds: 0 });
  while (run.status !== 'awaiting_approval') { await sleep(200); run = await s.api('agent.get', { runId: run.id }); if (['failed', 'complete'].includes(run.status)) throw new Error('unexpected ' + run.status); }
  return { projectId, run };
}
const waitFor = async (fn, ms = 60000) => { const until = Date.now() + ms; while (Date.now() < until) { const v = await fn(); if (v) return v; await sleep(150); } return undefined; };

// 1. Crash (SIGKILL sidecar) during real render → OS lock release, orphan check, restart and recovery without resubmission.
{
  const profile = await mkdtemp(join(tmpdir(), 'p0 drill 崩溃 '));
  let s = await start(profile); const { projectId, run } = await prepare(s);
  await s.api('agent.approve', { runId: run.id, callId: run.pending.callId, execId: run.pending.execId, argsHash: run.pending.argsHash });
  const renderers = await waitFor(() => { const t = tree(s.child.pid).filter(p => /chrom|ffmpeg/.test(p.comm)); return t.length ? t : undefined; });
  const before = tree(s.child.pid);
  s.child.kill('SIGKILL'); await new Promise(r => s.child.once('exit', r));
  await sleep(3000); const orphans = before.filter(p => alive(p.pid)).map(p => p.comm);
  const t0 = Date.now(); s = await start(profile); const relockMs = Date.now() - t0;
  const after = await s.api('agent.get', { runId: run.id }); const snap = await s.api('current', { projectId }); const tasks = (await s.api('tasks', { projectId })).tasks ?? [];
  await sleep(3000); const resubmitted = tree(s.child.pid).some(p => /chrom|ffmpeg/.test(p.comm));
  record('crash-during-render', !!renderers && !resubmitted && !!snap.project, { renderersSeen: renderers?.map(p => p.comm), orphansAfter3s: orphans, restartAcquiredLockMs: relockMs, runStatusAfterRestart: after.status, runMessage: after.message, uncertain: after.uncertainSubmissions?.length ?? 0, taskStatuses: [snap.task?.status, ...tasks.map(t => t.kind + ':' + t.status)], autoResubmittedRender: resubmitted, projectRevision: snap.project?.revision });
  for (const o of before.filter(p => alive(p.pid))) try { process.kill(o.pid, 'SIGKILL'); } catch {}
  await s.stop();
}
// 2. Cancel during real render → task cancelled, own render processes gone, sidecar healthy.
{
  const profile = await mkdtemp(join(tmpdir(), 'p0 drill 取消 '));
  const s = await start(profile); const { projectId, run } = await prepare(s);
  await s.api('agent.approve', { runId: run.id, callId: run.pending.callId, execId: run.pending.execId, argsHash: run.pending.argsHash });
  await waitFor(() => tree(s.child.pid).some(p => /chrom|ffmpeg/.test(p.comm)));
  const seen = tree(s.child.pid);
  const t0 = Date.now(); await s.api('agent.cancel', { runId: run.id });
  const fin = await waitFor(async () => { const v = await s.api('agent.get', { runId: run.id }); return ['cancelled', 'failed', 'complete'].includes(v.status) ? v : undefined; });
  const cancelMs = Date.now() - t0;
  await sleep(1500); const left = seen.filter(p => /chrom|ffmpeg/.test(p.comm) && alive(p.pid)).map(p => p.comm);
  const healthy = !!(await s.api('list'));
  record('cancel-during-render', fin?.status === 'cancelled' && left.length === 0 && healthy, { runStatus: fin?.status, cancelMs, renderProcessesLeft: left, healthy, projectId });
  await s.stop();
}
// 3. Client disconnect: abort an SSE subscription and an in-flight request; the shared owner must keep serving.
{
  const profile = await mkdtemp(join(tmpdir(), 'p0 drill 断连 '));
  const s = await start(profile);
  const ac = new AbortController(); const sse = fetch(s.ready.origin + '/events/agent', { method: 'POST', signal: ac.signal, headers: { 'x-yingliu-token': s.ready.token, origin: s.ready.origin } }).catch(e => e.name);
  await sleep(500); ac.abort(); await sse;
  const ac2 = new AbortController(); const p = s.api('create', { blank: true, title: '断连' }, ac2.signal).catch(e => e.name); ac2.abort(); await p;
  await sleep(500); const list = await s.api('list');
  record('client-disconnect', s.child.exitCode === null && Array.isArray(list.projects), { sidecarAlive: s.child.exitCode === null, projectsAfter: list.projects.length, note: '中断的 create 是否已受理由 list 判定；P1 requestId 将使其可查询' });
  await s.stop();
}
// 4. Host death: closing stdin (parent gone) triggers graceful shutdown and lock release.
{
  const profile = await mkdtemp(join(tmpdir(), 'p0 drill 宿主 '));
  const s = await start(profile); s.child.stdin.end();
  const code = await new Promise(r => { s.child.once('exit', c => r(c)); setTimeout(() => r('timeout'), 20000); });
  const again = await start(profile); await again.stop();
  record('host-stdin-closed', code === 0, { exit: code, relaunchOk: true });
}
await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify({ sidecar: bin, at: new Date().toISOString(), results }, null, 2));
process.exit(results.every(r => r.ok) ? 0 : 1);
