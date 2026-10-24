// P0 W4 negative tests against a REAL Chromium (skipped when none is installed, e.g. in CI). Egress is proven with our
// own local receivers (HTTP, WebSocket upgrade, UDP for STUN/WebRTC): every counter must stay zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { spawnSync } from 'node:child_process';
import { findBrowserExecutable } from '../src/host/tool-environment.ts';
import { runScene } from '../src/sandbox/scene-worker.ts';

const browserPath = process.env.YINGLIU_TEST_BROWSER ?? findBrowserExecutable();
const skip = !browserPath ? '未找到 Chrome/Chromium，宿主实测跳过（记为未测）' : false;

async function receivers() {
  const hits: string[] = [];
  const http = createServer((req, res) => { hits.push('http ' + req.method + ' ' + req.url); res.end('leak'); });
  http.on('upgrade', (req, socket) => { hits.push('ws ' + req.url); socket.destroy(); });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', () => r()));
  const udp = createSocket('udp4'); udp.on('message', (_m, info) => hits.push('udp ' + info.address + ':' + info.port));
  await new Promise<void>(r => udp.bind(0, '127.0.0.1', () => r()));
  const port = (http.address() as { port: number }).port, udpPort = udp.address().port;
  return { hits, port, udpPort, close: async () => { udp.close(); http.closeAllConnections(); await new Promise(r => http.close(r)); } };
}
const ownChromes = (pid?: number) => pid ? spawnSync('ps', ['-eo', 'pid=,pgid=']).stdout.toString().trim().split('\n').map(l => l.trim().split(/\s+/)).filter(([, g]) => g === String(pid)).length : 0;

test('W4: while(true) scene is recovered by the host watchdog; host heartbeat and API stay alive; only own browser killed', { skip }, async () => {
  const api = createServer((_q, s) => s.end('ok')); await new Promise<void>(r => api.listen(0, '127.0.0.1', () => r()));
  const apiPort = (api.address() as { port: number }).port;
  // An unrelated Chromium-like process that must survive (proves we only kill our own group).
  const bystander = spawnSync('sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!']).stdout.toString().trim();
  let last = performance.now(), maxGap = 0, apiOk = 0, apiFail = 0;
  const beat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 20);
  const pinger = setInterval(() => { fetch(`http://127.0.0.1:${apiPort}/`).then(r => r.ok ? apiOk++ : apiFail++, () => apiFail++); }, 100);
  try {
    const r = await runScene({ browserPath: browserPath!, html: '<script>while(true){}</script>', timeoutMs: 3000 });
    assert.equal(r.timedOut, true); assert.equal(r.killed, true); assert.equal(r.ok, false);
    assert.ok(r.elapsedMs < 3000 + 4000, 'recovered in ' + r.elapsedMs);
    await new Promise(res => setTimeout(res, 300));
    assert.equal(ownChromes(r.pid), 0, 'no process left in our Chromium group');
    assert.ok(maxGap < 250, 'host heartbeat gap ' + maxGap.toFixed(0) + 'ms');
    assert.ok(apiOk > 10 && apiFail === 0, `api ok=${apiOk} fail=${apiFail}`);
    assert.equal(spawnSync('kill', ['-0', bystander]).status, 0, 'unrelated process survived');
    console.log('P0-EVIDENCE hang ' + JSON.stringify({ elapsedMs: r.elapsedMs, maxHeartbeatGapMs: Math.round(maxGap), apiOk, apiFail, pid: r.pid }));
  } finally { clearInterval(beat); clearInterval(pinger); spawnSync('kill', [bystander]); api.close(); }
});

for (const jsWebRtcLockdown of [true, false]) test(`W4: fetch/WS/img/beacon/WebRTC/window.open/navigation egress is zero (JS WebRTC lockdown ${jsWebRtcLockdown ? 'on' : 'off: browser flags only'})`, { skip }, async () => {
  const rx = await receivers();
  const target = `http://127.0.0.1:${rx.port}`;
  const html = `<body><script>
    const report = window.__report = { rtc: 'n/a', fetch: 'n/a', file: 'n/a' };
    fetch('${target}/fetch').then(() => report.fetch = 'LEAK', e => report.fetch = 'blocked');
    fetch('file:///etc/passwd').then(() => report.file = 'LEAK', () => report.file = 'blocked');
    try { new WebSocket('ws://127.0.0.1:${rx.port}/ws'); } catch (e) {}
    new Image().src = '${target}/img'; navigator.sendBeacon && navigator.sendBeacon('${target}/beacon', 'x');
    try { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${rx.udpPort}' }] }); pc.createDataChannel('x'); pc.createOffer().then(o => pc.setLocalDescription(o)); report.rtc = 'constructed'; } catch (e) { report.rtc = 'unavailable: ' + e.name; }
    window.open('${target}/popup');
    setTimeout(() => { console.log('REPORT ' + JSON.stringify(report)); location.href = '${target}/escape'; }, 1200);
  </script></body>`;
  try {
    const r = await runScene({ browserPath: browserPath!, html, timeoutMs: 15000, settleMs: 2500, jsWebRtcLockdown, evaluate: 'JSON.stringify(window.__report ?? null)' });
    await new Promise(res => setTimeout(res, 500));
    assert.deepEqual(rx.hits, [], 'receiver saw traffic: ' + rx.hits.join(', '));
    assert.deepEqual(r.navigationEscapes, [], 'main frame escaped to ' + r.navigationEscapes.join(','));
    assert.ok(r.blocked.some(u => u.includes('/fetch')), 'fetch was intercepted');
    const report = JSON.parse(r.console.find(l => l.startsWith('REPORT '))!.slice(7)); assert.equal(report.fetch, 'blocked'); assert.equal(report.file, 'blocked');
    if (jsWebRtcLockdown) assert.match(report.rtc, /^unavailable/);
    console.log('P0-EVIDENCE egress ' + JSON.stringify({ jsWebRtcLockdown, ok: r.ok, report: r.console.find(l => l.startsWith('REPORT ')), blocked: r.blocked, popupsClosed: r.popupsClosed, navigationsBlocked: r.navigationsBlocked, mainUrl: r.mainUrl, receiverHits: rx.hits.length, error: r.error }));
  } finally { await rx.close(); }
});

test('W4: scene has no invoke bridge, no editor token, no API or file access', { skip }, async () => {
  const rx = await receivers();
  const html = `<script>window.__probe = { tauri: typeof window.__TAURI__, internals: typeof window.__TAURI_INTERNALS__, ipc: typeof window.ipc, yingliu: typeof window.yingliu, tokenMeta: !!document.querySelector('meta[name="yingliu-token"]'), cookie: (() => { try { return document.cookie; } catch (e) { return 'denied'; } })(), storage: (() => { try { return localStorage.length; } catch (e) { return 'denied'; } })() };
    fetch('http://127.0.0.1:${rx.port}/api/list', { method: 'POST', headers: { 'x-yingliu-token': 'guess' }, body: '{}' }).then(() => window.__probe.api = 'LEAK', () => window.__probe.api = 'blocked');
    fetch('file:///etc/hostname').then(() => window.__probe.file = 'LEAK', () => window.__probe.file = 'blocked');</script>`;
  try {
    const r = await runScene({ browserPath: browserPath!, html, timeoutMs: 15000, settleMs: 800, evaluate: 'window.__probe' });
    const p = r.value as Record<string, unknown>; assert.ok(p, JSON.stringify(r));
    assert.equal(p.tauri, 'undefined'); assert.equal(p.internals, 'undefined'); assert.equal(p.ipc, 'undefined'); assert.equal(p.yingliu, 'undefined');
    assert.equal(p.tokenMeta, false); assert.equal(p.api, 'blocked'); assert.equal(p.file, 'blocked'); assert.deepEqual(rx.hits, []);
    console.log('P0-EVIDENCE capability ' + JSON.stringify(p));
  } finally { await rx.close(); }
});
