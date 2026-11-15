import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PreferencesStore, parsePreferences } from '../src/app/preferences.ts';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import { startUiServer } from '../src/app/ui-server.ts';
import { readFileSync } from 'node:fs';

test('ui preferences round-trip only version and theme, default paper', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-prefs-'));
  try {
    const store = new PreferencesStore(directory);
    assert.deepEqual(await store.get(), { version: 1, theme: 'paper' });
    assert.deepEqual(await store.set('darkroom'), { version: 1, theme: 'darkroom' });
    const text = await readFile(join(directory, 'ui-preferences.json'), 'utf8');
    assert.deepEqual(JSON.parse(text), { version: 1, theme: 'darkroom' });
    assert.equal(text.includes('apiKey'), false);
    assert.deepEqual(await new PreferencesStore(directory).get(), { version: 1, theme: 'darkroom' });
    await assert.rejects(() => store.set('studio' as 'paper'), /未知外观/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('preferences reject extra fields and serialize writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-prefs-'));
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'ui-preferences.json'), JSON.stringify({ version: 1, theme: 'paper', apiKey: 'should-not-load' }));
    const raw = await readFile(join(directory, 'ui-preferences.json'), 'utf8');
    assert.throws(() => parsePreferences(raw), /不允许的字段/);
    const store = new PreferencesStore(directory);
    await Promise.all([store.set('paper'), store.set('darkroom'), store.set('paper')]);
    const saved = JSON.parse(await readFile(join(directory, 'ui-preferences.json'), 'utf8'));
    assert.deepEqual(saved, { version: 1, theme: 'paper' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ui.preferences endpoint persists in an isolated data directory and CSP stays closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-prefs-app-'));
  const app = await createApplication({ dataDirectory: directory, credentials: new MemorySecrets(), resumeRemoteTasks: false });
  const server = await startUiServer(app, directory);
  try {
    const missing = await fetch(server.origin + '/secrets');
    assert.equal(missing.status, 404);
    const denied = await fetch(server.origin + '/api/ui.preferences.get', { method: 'POST', headers: { 'content-type': 'application/json', origin: server.origin }, body: '{}' });
    assert.equal(denied.status, 403);
    const csp = denied.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
    const saved = await app.route('ui.preferences.set', { theme: 'darkroom' });
    assert.equal(saved.ok, true);
    if (saved.ok) assert.deepEqual(saved.value, { version: 1, theme: 'darkroom' });
    const again = await app.route('ui.preferences.get', {});
    assert.equal(again.ok, true);
    if (again.ok) assert.deepEqual(again.value, { version: 1, theme: 'darkroom' });
    const file = JSON.parse(await readFile(join(directory, 'ui-preferences.json'), 'utf8'));
    assert.deepEqual(file, { version: 1, theme: 'darkroom' });
    const bad = await app.route('ui.preferences.set', { theme: 'neon', apiKey: 'nope' });
    assert.equal(bad.ok, false);
  } finally { await server.close(); await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('theme tokens differ and the shell background reads them', () => {
  const tokens = readFileSync(new URL('../src/client/tokens.css', import.meta.url), 'utf8');
  const apply = readFileSync(new URL('../src/client/theme-apply.css', import.meta.url), 'utf8');
  assert.match(tokens, /:root\[data-theme="paper"\]/);
  assert.match(tokens, /:root\[data-theme="darkroom"\]/);
  assert.match(tokens, /--bg:\s*#faf9f5/);
  assert.match(tokens, /--bg:\s*#08090a/);
  for (const name of ['--bg', '--panel', '--text', '--muted', '--line', '--accent', '--danger']) assert.ok(tokens.includes(name), name);
  assert.match(apply, /\.yl-app\s*\{[^}]*background:\s*var\(--bg\)/);
  assert.match(apply, /\.vs-studio\[data-scheme="light"\]/);
  assert.match(apply, /\.vs-studio\[data-scheme="dark"\]/);
});
