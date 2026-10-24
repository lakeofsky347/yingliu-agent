// P0 W1 acceptance for a built sidecar release directory. Copies the release to an install path with spaces and Chinese
// characters, launches it through isolate.sh (source tree, dev node_modules, /opt CLI and node/npm/bun hidden), then via
// HTTP only: project create/read/write, mock agent run, approval, real Chromium render + MP4 export, full ffprobe/ffmpeg
// decode, archive export/import, CLI BUSY against the same profile, graceful shutdown and leftover-process check.
// Usage: node scripts/p0/verify-sidecar.mjs --release dist-p0/node-linux-x64 --evidence docs/p0/evidence/node-linux-x64 [--no-isolate]
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2), opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const release = resolve(opt('release')), evidence = resolve(opt('evidence')), isolate = !args.includes('--no-isolate') && process.platform === 'linux';
const hide = (opt('hide') ?? [resolve('.'), '/opt/yingliu-agent'].join(',')).split(',').filter(Boolean);
await mkdir(evidence, { recursive: true });
const log = []; const t0 = Date.now();
const note = (step, ok, detail = {}) => { const e = { t: Date.now() - t0, step, ok, ...detail }; log.push(e); console.log((ok ? 'PASS ' : 'FAIL ') + step + ' ' + JSON.stringify(detail).slice(0, 300)); return ok; };
const root = await mkdtemp(join(tmpdir(), 'p0 验证 '));
const install = join(root, '映流 智能体 安装', 'sidecar');
await cp(release, install, { recursive: true });
const profile = join(root, '用户 数据'), data = join(profile, 'data'), projects = join(profile, 'projects');
const exe = join(install, process.platform === 'win32' ? 'yingliu-sidecar.exe' : 'yingliu-sidecar');
const sidecarArgs = ['--data-root', data, '--projects-root', projects, '--resource-root', join(install, 'resources'), '--mock'];
const cmd = isolate ? [resolve('scripts/p0/isolate.sh'), ...hide, '--', exe, ...sidecarArgs] : [exe, ...sidecarArgs];
note('install-path', true, { install, isolate, hidden: isolate ? hide : [] });

const spawnedAt = performance.now();
const child = spawn(cmd[0], cmd.slice(1), { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', d => { stderr += d; });
const lines = createInterface({ input: child.stdout }); const control = [];
const ready = await new Promise((res, rej) => { const timer = setTimeout(() => rej(new Error('ready timeout; stderr=' + stderr)), 30000); lines.on('line', l => { let m; try { m = JSON.parse(l); } catch { return; } control.push(m.type === 'ready' ? { ...m, token: '<redacted>' } : m); if (m.type === 'ready' || m.type === 'error') { clearTimeout(timer); res(m); } }); });
const readyWallMs = Math.round(performance.now() - spawnedAt);
if (!note('ready-handshake', ready.type === 'ready' && ready.protocolVersion === 1 && /^[0-9a-f]{32}$/.test(ready.profileId) && /^[0-9a-f]{64}$/.test(ready.token), { readyWallMs, readyMs: ready.readyMs, runtime: ready.runtime, protocolVersion: ready.protocolVersion })) throw new Error(JSON.stringify(ready));
const api = async (endpoint, payload = {}, token = ready.token) => {
  const r = await fetch(ready.origin + '/api/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-yingliu-token': token, origin: ready.origin }, body: JSON.stringify(payload) });
  if (r.status !== 200) return { status: r.status };
  const v = await r.json(); if (!v.ok) throw new Error(endpoint + ': ' + v.error?.message); return v.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const descendants = () => { if (process.platform === 'win32') return []; const out = spawnSync('ps', ['-eo', 'pid=,ppid=,comm=']).stdout.toString().trim().split('\n').map(l => l.trim().split(/\s+/)); const kids = new Map(); for (const [p, pp, c] of out) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push({ pid: p, comm: c }); } const all = []; const walk = p => { for (const k of kids.get(String(p)) ?? []) { all.push(k); walk(k.pid); } }; walk(child.pid); return all; };
const seen = new Map(); const sampler = setInterval(() => { for (const d of descendants()) seen.set(d.pid, d.comm); }, 100);
try {
  note('token-required', (await api('list', {}, 'wrong')).status === 403);
  const html = await (await fetch(ready.origin + '/')).text(); note('editor-served', html.includes('<') && !html.includes('__APP_TOKEN__'));
  const csp = (await fetch(ready.origin + '/')).headers.get('content-security-policy'); note('editor-csp-no-scene-frames', /frame-src 'none'/.test(csp ?? ''), { csp });
  const created = await api('create', { blank: true, title: 'P0 验证 工程' }); const projectId = created.project.id;
  note('project-create', !!projectId, { projectId, root: created.root, underProjectsRoot: created.root.startsWith(projects) });
  const got = await api('current', { projectId }); note('project-read', got.project?.id === projectId);
  await api('rename', { projectId, title: 'P0 验证 已改名', expectedRevision: got.project.revision }); const renamed = await api('current', { projectId }); note('project-write', renamed.project.title === 'P0 验证 已改名', { revision: renamed.project.revision });
  // Mock director (no network; mockFetch inside the sidecar) → video_update → export_mp4 approval → real render.
  await api('models.connection.save', { id: 'cli-mock', name: 'mock', protocol: 'chat-completions', baseUrl: 'http://mock.yingliu.invalid/v1', auth: 'none' });
  await api('models.model.save', { id: 'cli-mock-director', connectionId: 'cli-mock', model: 'mock-director', name: 'mock', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
  await api('models.role.bind', { role: 'director', modelId: 'cli-mock-director' });
  let run = await api('agent.start', { projectId, goal: 'P0 片头', autoApprove: ['read', 'write', 'plan'], maxReviewRounds: 0 });
  const until = Date.now() + 120000; while (!['awaiting_approval', 'complete', 'failed', 'cancelled', 'paused', 'budget_exceeded'].includes(run.status) && Date.now() < until) { await sleep(200); run = await api('agent.get', { runId: run.id }); }
  note('agent-run-mock-until-approval', run.status === 'awaiting_approval' && run.pending?.tool === 'export_mp4', { status: run.status, tool: run.pending?.tool });
  const renderStart = performance.now();
  run = await api('agent.approve', { runId: run.id, callId: run.pending.callId, execId: run.pending.execId, argsHash: run.pending.argsHash });
  while (!['complete', 'failed', 'cancelled', 'budget_exceeded', 'awaiting_approval', 'paused'].includes(run.status) && Date.now() < until + 300000) { await sleep(300); run = await api('agent.get', { runId: run.id }); }
  let snap; const tUntil = Date.now() + 600000; while (Date.now() < tUntil) { snap = await api('current', { projectId }); if (snap.task?.status !== 'running') break; await sleep(300); }
  const output = (snap.project.outputs ?? []).find(o => o.path); const renderMs = Math.round(performance.now() - renderStart);
  note('agent-run-complete-real-render', run.status === 'complete' && !!output, { status: run.status, task: snap.task && { kind: snap.task.kind, status: snap.task.status, error: snap.task.error }, output: output?.path, renderMs, chromiumSeen: [...seen.values()].some(c => /chrom/i.test(c)) });
  if (output) {
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', output.path]).toString());
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', output.path, '-f', 'null', '-'], { encoding: 'utf8' });
    const v = probe.streams.find(s => s.codec_type === 'video'), a = probe.streams.find(s => s.codec_type === 'audio');
    note('mp4-full-decode', decode.status === 0 && decode.stderr.trim() === '' && Number(v?.nb_read_frames) > 0, { video: v && { codec: v.codec_name, w: v.width, h: v.height, fps: v.avg_frame_rate, frames: v.nb_read_frames }, audio: a && { codec: a.codec_name, rate: a.sample_rate }, duration: probe.format.duration, bytes: Number(probe.format.size) });
    await writeFile(join(evidence, 'ffprobe.json'), JSON.stringify(probe, null, 2));
  }
  const archive = join(root, '备份 目录', 'P0 工程.yingliu'); await mkdir(join(root, '备份 目录'), { recursive: true });
  const exported = await api('app.exportProject', { projectId, path: archive }); const imported = await api('app.importProject', { path: archive });
  note('archive-export-import', (await stat(archive)).size > 0 && !!imported.project?.id && imported.project.id !== projectId, { bytes: (await stat(archive)).size, importedId: imported.project?.id, exported: !!exported });
  // Same profile from the installed CLI must be refused (P0 transitional single-writer result).
  const cli = process.env.YINGLIU_CLI ?? '/usr/local/bin/yingliu';
  const busy = spawnSync(cli, ['project', 'list', '--json', '--lock-timeout', '0'], { env: { ...process.env, YINGLIU_DATA_DIR: data, YINGLIU_PROJECTS: projects }, encoding: 'utf8' });
  let busyJson; try { busyJson = JSON.parse(busy.stdout.trim()); } catch {}
  note('cli-busy-same-profile', busy.status === 9 && busyJson?.error?.code === 'BUSY', { exit: busy.status, code: busyJson?.error?.code });
  const second = spawnSync(exe, sidecarArgs, { encoding: 'utf8', timeout: 20000, input: '' });
  note('second-sidecar-busy', second.status === 9 && /"code":"BUSY"/.test(second.stdout), { exit: second.status });
} catch (e) { note('exception', false, { message: String(e?.stack ?? e) }); }
clearInterval(sampler); for (const d of descendants()) seen.set(d.pid, d.comm);
const shutdownAt = performance.now(); child.stdin.write('{"type":"shutdown"}\n');
const code = await new Promise(r => child.on('exit', c => r(c)));
await sleep(500);
const alive = [...seen.keys()].filter(p => { try { process.kill(Number(p), 0); return true; } catch { return false; } });
note('graceful-shutdown', code === 0 && control.some(m => m.type === 'shutdown' && m.ok), { exit: code, shutdownMs: Math.round(performance.now() - shutdownAt) });
note('no-leftover-children', alive.length === 0, { observedDescendants: [...new Set(seen.values())], alive });
const after = spawnSync(process.env.YINGLIU_CLI ?? '/usr/local/bin/yingliu', ['project', 'list', '--json', '--lock-timeout', '0'], { env: { ...process.env, YINGLIU_DATA_DIR: data, YINGLIU_PROJECTS: projects }, encoding: 'utf8' });
note('lock-released-after-exit', after.status === 0, { exit: after.status });
const manifest = JSON.parse(await readFile(join(release, 'manifest.json'), 'utf8'));
await writeFile(join(evidence, 'verify-log.json'), JSON.stringify({ release, manifest: { runtime: manifest.runtime, runtimeVersion: manifest.runtimeVersion, binary: manifest.binary, totalBytes: manifest.totalBytes, commit: manifest.commit }, control, steps: log, stderr: stderr.slice(-4000) }, null, 2));
await rm(root, { recursive: true, force: true }).catch(() => {});
const failed = log.filter(e => !e.ok); console.log(failed.length ? `FAILED ${failed.length}` : 'ALL PASS'); process.exit(failed.length ? 1 : 0);
