// P0 resource measurement (Linux). Cold start (process spawn → editor page load finished) ×N and S0 idle PSS of the full
// process tree (smaps_rollup Pss; RSS recorded only as auxiliary). Raw samples go to --out as JSON.
// Usage: node scripts/p0/measure.mjs --mode electron --app artifacts/yingliu-agent-linux-x64 --runs 10 --out docs/p0/evidence/baseline-electron.json
//        node scripts/p0/measure.mjs --mode tauri --app src-tauri/target/release/yingliu-shell-p0 --sidecar dist-p0/node-linux-x64/yingliu-sidecar --runs 10 --out ...
//        node scripts/p0/measure.mjs --mode sidecar --sidecar dist-p0/node-linux-x64/yingliu-sidecar --runs 10 --out ...
// Requires DISPLAY (e.g. Xvfb) for electron/tauri.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const mode = opt('mode'), runs = Number(opt('runs', 10)), idleMs = Number(opt('idle-ms', 10000)), out = resolve(opt('out'));
const app = opt('app') && resolve(opt('app')), sidecar = opt('sidecar') && resolve(opt('sidecar'));
const dropCaches = args.includes('--drop-caches');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function tree(pid) {
  const rows = spawnSync('ps', ['-eo', 'pid=,ppid=,comm=']).stdout.toString().trim().split('\n').map(l => l.trim().split(/\s+/));
  const kids = new Map(); for (const [p, pp, c] of rows) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push([p, c]); }
  const all = []; const walk = (p, c) => { all.push({ pid: Number(p), comm: c }); for (const [k, kc] of kids.get(String(p)) ?? []) walk(k, kc); };
  walk(pid, rows.find(r => r[0] === String(pid))?.[2] ?? '?'); return all;
}
async function memory(pid) {
  let pss = 0, rss = 0; const procs = [];
  for (const p of tree(pid)) { try { const t = await readFile(`/proc/${p.pid}/smaps_rollup`, 'utf8'); const k = n => Number(t.match(new RegExp('^' + n + ':\\s+(\\d+)', 'm'))?.[1] ?? 0) * 1024; pss += k('Pss'); rss += k('Rss'); procs.push({ ...p, pss: k('Pss'), rss: k('Rss') }); } catch {} }
  return { pssBytes: pss, rssBytes: rss, processes: procs };
}
async function once(i) {
  if (dropCaches) spawnSync('sudo', ['sh', '-c', 'sync; echo 3 > /proc/sys/vm/drop_caches']);
  const data = await mkdtemp(join(tmpdir(), 'p0-measure-'));
  let cmd, env = { ...process.env, YINGLIU_DATA_DIR: data }, cdp;
  if (mode === 'electron') { cdp = 29000 + i; cmd = [join(app, 'yingliu-agent'), '--remote-debugging-port=' + cdp, '--no-sandbox']; }
  else if (mode === 'tauri') { cmd = [app]; env = { ...env, YINGLIU_SIDECAR: sidecar }; }
  else if (mode === 'sidecar') cmd = [sidecar, '--data-root', join(data, 'data'), '--projects-root', join(data, 'projects'), '--resource-root', join(dirname(sidecar), 'resources')];
  const t0 = performance.now();
  const child = spawn(cmd[0], cmd.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let readyMs, err = '';
  const lines = l => { if (mode === 'tauri' && /page-load-finished url=http:\/\/127\.0\.0\.1/.test(l) && readyMs === undefined) readyMs = performance.now() - t0; if (mode === 'sidecar' && l.startsWith('{"type":"ready"') && readyMs === undefined) readyMs = performance.now() - t0; };
  createInterface({ input: child.stderr }).on('line', l => { err += l + '\n'; lines(l); }); createInterface({ input: child.stdout }).on('line', lines);
  const deadline = performance.now() + 60000;
  if (mode === 'electron') {
    // Editor ready = top page on the loopback editor origin with readyState complete and the React root mounted.
    while (readyMs === undefined && performance.now() < deadline) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); const page = targets.find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1'));
        if (page) { const ok = await new Promise(res => { const ws = new WebSocket(page.webSocketDebuggerUrl); ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "document.readyState==='complete'&&!!document.querySelector('#root')&&document.querySelector('#root').childElementCount>0", returnByValue: true } })); ws.onmessage = m => { const v = JSON.parse(m.data); ws.close(); res(v.result?.result?.value === true); }; ws.onerror = () => res(false); }); if (ok) readyMs = performance.now() - t0; }
      } catch {}
      if (readyMs === undefined) await sleep(25);
    }
  } else while (readyMs === undefined && performance.now() < deadline) await sleep(10);
  await sleep(idleMs);
  const mem = await memory(child.pid);
  if (mode === 'sidecar') child.stdin.write('{"type":"shutdown"}\n'); else child.kill('SIGTERM');
  const exited = await Promise.race([new Promise(r => child.on('exit', () => r(true))), sleep(15000).then(() => false)]);
  if (!exited) child.kill('SIGKILL');
  await sleep(300); const leftovers = mem.processes.filter(p => { try { process.kill(p.pid, 0); return true; } catch { return false; } });
  for (const p of leftovers) try { process.kill(p.pid, 'SIGKILL'); } catch {}
  await rm(data, { recursive: true, force: true }).catch(() => {});
  return { run: i, readyMs: readyMs === undefined ? null : Math.round(readyMs), s0: { pssBytes: mem.pssBytes, rssBytes: mem.rssBytes, processes: mem.processes }, exitedWithin15s: exited, leftovers: leftovers.map(p => p.comm), stderrTail: err.split('\n').filter(l => !/token/i.test(l)).slice(-5) };
}
const samples = []; for (let i = 0; i < runs; i++) { const s = await once(i); samples.push(s); console.log(JSON.stringify({ run: i, readyMs: s.readyMs, pssMiB: +(s.s0.pssBytes / 2 ** 20).toFixed(1), rssMiB: +(s.s0.rssBytes / 2 ** 20).toFixed(1), procs: s.s0.processes.length, leftovers: s.leftovers })); }
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const ready = samples.map(s => s.readyMs).filter(v => v !== null), pss = samples.map(s => s.s0.pssBytes);
const summary = { mode, runs, idleMs, dropCaches, readyMedianMs: q(ready, 0.5), readyP95Ms: q(ready, 0.95), readyFailures: runs - ready.length, s0PssMedianMiB: +(q(pss, 0.5) / 2 ** 20).toFixed(1), s0PssP95MiB: +(q(pss, 0.95) / 2 ** 20).toFixed(1), s0RssMedianMiB: +(q(samples.map(s => s.s0.rssBytes), 0.5) / 2 ** 20).toFixed(1) };
console.log(JSON.stringify(summary));
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ summary, host: { kernel: spawnSync('uname', ['-sr']).stdout.toString().trim(), cpus: spawnSync('nproc').stdout.toString().trim() }, measuredAt: new Date().toISOString(), samples }, null, 2));
