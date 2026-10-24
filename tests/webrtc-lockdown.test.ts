import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { chromium } from 'playwright-core';
import { detectEnvironment, WEBRTC_LOCKDOWN_ARGS, WEBRTC_LOCKDOWN_SCRIPT } from '../src/host/renderer.ts';

const browserPath = detectEnvironment({}).browserPath;
// Chromium skips loopback STUN, so listen on a real interface when one exists.
const host = Object.values(networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal)?.address ?? '127.0.0.1';

/** Attempt STUN to a local UDP receiver from the top frame and from a fresh same-origin iframe. */
const PAGE = (port: number) => `<!doctype html><body><script>
async function attempt(win){try{const Ctor=win.RTCPeerConnection||win.webkitRTCPeerConnection;if(!Ctor)return 'no-ctor';const pc=new Ctor({iceServers:[{urls:'stun:${host}:${port}'}]});pc.createDataChannel('x');await pc.setLocalDescription(await pc.createOffer());return 'tried';}catch(e){return 'error:'+e.message;}}
window.result=(async()=>{const f=document.createElement('iframe');document.body.appendChild(f);return [await attempt(window),await attempt(f.contentWindow)];})();
</script></body>`;

async function udpPackets(lockdown: boolean): Promise<{ packets: number; results: string[] }> {
  const udp = createSocket('udp4'); let packets = 0; udp.on('message', () => { packets++; });
  await new Promise<void>(r => udp.bind(0, host, () => r())); const port = udp.address().port;
  const http = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(PAGE(port)); });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', () => r()));
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: lockdown ? WEBRTC_LOCKDOWN_ARGS : [] });
  try {
    const context = await browser.newContext(); if (lockdown) await context.addInitScript(WEBRTC_LOCKDOWN_SCRIPT);
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${(http.address() as { port: number }).port}/`);
    const results = await page.evaluate(() => (window as unknown as { result: Promise<string[]> }).result);
    await new Promise(r => setTimeout(r, 1500)); return { packets, results };
  } finally { await browser.close(); http.close(); udp.close(); }
}

test('F01: renderer lockdown stops WebRTC UDP from scene code (top frame and iframe)', { skip: !browserPath && 'no Chromium available' }, async () => {
  const baseline = await udpPackets(false);
  const locked = await udpPackets(true);
  assert.equal(locked.packets, 0, 'no UDP datagrams may leave the locked renderer: ' + JSON.stringify(locked.results));
  if (baseline.packets === 0) console.log('# note: baseline browser sent no STUN either; lockdown still verified by constructor removal', baseline.results);
  else assert.ok(baseline.packets > 0);
  assert.equal(locked.results[0], 'no-ctor');
  console.log('# baseline', baseline.packets, baseline.results, 'locked', locked.results);
});
