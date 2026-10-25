import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import net from 'node:net';

const scenario = process.argv[2];
console.log(JSON.stringify({ event: 'runtime', versions: process.versions }));
const { fetch: hostFetch } = await import('../../src/host/http.ts');
const activeUndici = createRequire(import.meta.url)('undici/package.json').version;
const body = JSON.stringify({ ok: true });
const sockets = new Set();
const controller = new AbortController();
let requests = 0, blockedRequests;
const server = net.createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  let headers = '';
  socket.on('data', chunk => {
    headers += String(chunk);
    if (!headers.includes('\r\n\r\n') || socket.responded) return;
    socket.responded = true;
    requests++;
    if (scenario === 'abort') { setTimeout(() => controller.abort(), 10); return; }
    if (scenario === 'malformed') {
      // GHSA-xjj6-f33q-929c: rejection must also dispose the internal body stream.
      socket.write('HTTP/1.1 200 OK\r\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nContent-Length: 128\r\nConnection: close\r\n\r\n');
      setTimeout(() => socket.end(), 30);
      return;
    }
    socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body);
  });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = 'http://127.0.0.1:' + server.address().port;
const timeout = setTimeout(() => controller.abort(), 4000);
try {
  if (scenario === 'normal') {
    const response = await hostFetch(new Request(base, { headers: new Headers({ 'x-security-probe': 'normal' }) }), { signal: controller.signal });
    assert.ok(response instanceof Response, 'Fetch API classes must come from the same implementation');
    assert.deepEqual(await response.json(), { ok: true });
  } else if (scenario === 'malformed') {
    await assert.rejects(hostFetch(base, { signal: controller.signal }), /fetch failed/);
  } else if (scenario === 'abort') {
    await assert.rejects(hostFetch(base, { signal: controller.signal }), error => error?.name === 'AbortError');
    assert.equal(controller.signal.aborted, true);
  } else if (scenario === 'sri') {
    const integrity = value => 'SHA256-' + createHash('sha256').update(value).digest('base64');
    const valid = await hostFetch(base, { integrity: integrity(body), signal: controller.signal });
    assert.equal(await valid.text(), body, 'uppercase algorithm names must accept a matching digest');
    await assert.rejects(hostFetch(base, { integrity: integrity('different body'), signal: controller.signal }), error => error?.cause?.message === 'integrity mismatch');
  } else if (scenario === 'tls-options') {
    // GHSA-2m5v-pch6-74hx: preserve custom verification at the per-origin
    // dispatcher boundary. The factory stops before opening any TLS socket.
    const { Agent } = await import('undici');
    const verify = () => new Error('certificate deliberately refused');
    const stopped = new Error('probe factory stopped before network');
    let forwarded;
    const agent = new Agent({ tls: { checkServerIdentity: verify }, factory(_origin, options) { forwarded = options.tls?.checkServerIdentity; throw stopped; } });
    try {
      await assert.rejects(agent.request({ origin: 'https://never-connect.invalid', path: '/', method: 'GET' }), error => error === stopped);
      assert.equal(forwarded, verify, 'custom TLS verification callback must reach the origin dispatcher unchanged');
    } finally { await agent.close(); }
  } else if (scenario === 'mock-guard') {
    const { installMockNetworkGuard, MockNetworkError } = await import('../../src/cli/mock.ts');
    const unguard = installMockNetworkGuard();
    try {
      await assert.rejects(hostFetch(base, { signal: controller.signal }), error => error instanceof MockNetworkError && error.submissionUncertain === false);
      blockedRequests = requests;
      assert.equal(blockedRequests, 0, 'mock mode must refuse even loopback before any socket request');
    } finally { unguard(); }
    assert.deepEqual(await (await hostFetch(base, { signal: controller.signal })).json(), { ok: true });
  } else { throw new Error('unknown security scenario: ' + scenario); }
  // No uncaughtException handler: the vulnerable native fetch rejects first,
  // then crashes later on an orphaned stream despite a successful catch above.
  await new Promise(resolve => setTimeout(resolve, 250));
  console.log(JSON.stringify({ event: 'survived', scenario, requests, blockedRequests, activeUndici }));
} finally {
  clearTimeout(timeout);
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
