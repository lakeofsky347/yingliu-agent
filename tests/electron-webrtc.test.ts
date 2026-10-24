import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
test('R01: desktop editor wiring removes WebRTC in every frame (static)', () => {
  const main = readFileSync(join(root, 'src/desktop/main.ts'), 'utf8'), preload = readFileSync(join(root, 'src/desktop/preload.ts'), 'utf8'), prefs = readFileSync(join(root, 'src/desktop/web-preferences.ts'), 'utf8');
  assert.match(main, /editorWebPreferences\(/, 'the editor window uses the shared web preferences');
  assert.match(prefs, /nodeIntegrationInSubFrames:\s*true/, 'the preload must also run in preview subframes (sandboxed, no Node)');
  assert.match(prefs, /sandbox:\s*true/); assert.match(prefs, /contextIsolation:\s*true/); assert.match(prefs, /nodeIntegration:\s*false/);
  const lock = preload.indexOf('lockdownWebRTC'), bridge = preload.indexOf('exposeInMainWorld');
  assert.ok(lock >= 0 && lock < bridge, 'lockdown runs first, in every frame');
});

let electronPath: string | undefined; try { electronPath = (await import('electron')).default as unknown as string; if (!existsSync(electronPath)) electronPath = undefined; } catch { electronPath = undefined; }
const display = process.platform !== 'linux' || !!process.env.DISPLAY || spawnSync('which', ['xvfb-run']).status === 0;
test('R01: in real Electron, RTCPeerConnection is unavailable in the editor and in a cross-origin preview iframe', { skip: (!electronPath && 'electron binary not installed') || (!display && 'no display') }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r01-'));
  try {
    const { build } = await import('esbuild');
    await build({ entryPoints: [join(root, 'tests/fixtures/electron-webrtc-main.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'main.cjs'), external: ['electron'], logLevel: 'silent' });
    await build({ entryPoints: [join(root, 'src/desktop/preload.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'preload.cjs'), external: ['electron'], logLevel: 'silent' });
    const args = [join(dir, 'main.cjs'), '--no-sandbox', '--disable-gpu'];
    const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
    const out = execFileSync(useXvfb ? 'xvfb-run' : electronPath!, useXvfb ? ['-a', electronPath!, ...args] : args, { encoding: 'utf8', timeout: 60000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' } });
    const line = out.split('\n').find(l => l.startsWith('R01RESULT')); assert.ok(line, out);
    const frames = JSON.parse(line.slice(9)) as { ctor?: string; dc?: string; error?: string }[];
    assert.equal(frames.length, 2, line);
    for (const f of frames) { assert.equal(f.ctor, 'undefined', 'RTCPeerConnection must be gone: ' + line); assert.equal(f.dc, 'undefined'); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
