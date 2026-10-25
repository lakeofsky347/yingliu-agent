import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const child = join(import.meta.dirname, 'fixtures', 'undici-security-child.mjs');
const loader = import.meta.resolve('tsx');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
type Result = { event: string; versions?: Record<string, string>; scenario?: string; requests?: number; blockedRequests?: number; activeUndici?: string };
function probe(executable: string, scenario: string): Result[] {
  const result = spawnSync(executable, ['--import', loader, child, scenario], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${scenario} exited ${result.status}/${result.signal}\n${result.stdout}\n${result.stderr}`);
  const events: Result[] = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const survived = events.find(event => event.event === 'survived');
  assert.ok(survived, result.stdout);
  assert.equal(survived.activeUndici, manifest.dependencies.undici);
  assert.equal(survived.requests, scenario === 'sri' ? 2 : scenario === 'tls-options' ? 0 : 1);
  if (scenario === 'mock-guard') assert.equal(survived.blockedRequests, 0);
  return events;
}

for (const scenario of ['normal', 'malformed', 'abort', 'sri', 'tls-options', 'mock-guard']) {
  test(`patched Node HTTP: ${scenario} remains contained in an isolated process`, () => { probe(process.execPath, scenario); });
}

// Read the install marker directly: importing electron can lazily download a
// native binary, which a security unit test must never trigger implicitly.
let electron: string | undefined;
try {
  const marker = readFileSync(join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim();
  const candidate = join(root, 'node_modules', 'electron', 'dist', marker);
  if (existsSync(candidate)) electron = candidate;
} catch { /* Native acceptance is explicitly skipped on source-only machines. */ }
test('patched HTTP survives malformed responses inside the actual pinned Electron runtime', { skip: !electron && 'Electron binary not installed (no lazy download)' }, t => {
  const events = probe(electron!, 'malformed');
  const versions = events.find(event => event.event === 'runtime')?.versions;
  assert.equal(versions?.electron, manifest.devDependencies.electron);
  assert.ok(versions?.node); assert.ok(versions?.undici);
  t.diagnostic(JSON.stringify({ native: versions, activeUndici: events.find(event => event.event === 'survived')?.activeUndici }));
});
