// P0 W1: build the production sidecar as a Node SEA (default) or a Bun --compile comparison build.
// Usage: node scripts/p0/build-sidecar.mjs [--runtime node|bun] [--out dist-p0]
// Requires Node >= 22.18 for SEA. Output: <out>/<runtime>-<platform>-<arch>/{yingliu-sidecar[.exe], resources/ui/*, manifest.json}
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile, copyFile, chmod } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const runtime = opt('runtime', 'node'), outRoot = resolve(opt('out', 'dist-p0'));
const exe = process.platform === 'win32' ? '.exe' : '';
const target = join(outRoot, `${runtime}-${process.platform}-${process.arch}`);
const work = join(outRoot, `.work-${runtime}`);
await rm(target, { recursive: true, force: true }); await rm(work, { recursive: true, force: true });
await mkdir(join(target, 'resources'), { recursive: true }); await mkdir(work, { recursive: true });

// UI resources (trusted editor) — same bundle the Electron build ships.
if (!(await stat('dist/ui/app.js').catch(() => null))) execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
await cp('dist/ui', join(target, 'resources', 'ui'), { recursive: true });

const binary = join(target, 'yingliu-sidecar' + exe);
const started = Date.now();
// chromium-bidi is only used by Playwright's BiDi (Firefox) protocol; we drive Chromium over CDP. Stub it so the bundle
// has zero runtime node_modules (a stub throws loudly if anything ever reaches it).
const stubBidi = { name: 'stub-chromium-bidi', setup(b) { b.onResolve({ filter: /^chromium-bidi\// }, a => ({ path: a.path, namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents: `throw new Error('chromium-bidi 未打包（P0 sidecar 仅支持 Chromium CDP）: ${a.path}');`, loader: 'js' })); } };
// playwright-core reads its own package.json through a computed path at load time; inline it (version only).
const inlinePlaywrightPackage = { name: 'inline-playwright-package', setup(b) { b.onLoad({ filter: /playwright-core[\\/]lib[\\/]coreBundle\.js$/ }, async a => {
  const pkg = JSON.parse(await readFile(join(a.path, '..', '..', 'package.json'), 'utf8')); let text = await readFile(a.path, 'utf8');
  const before = text; text = text.replace(/require\(import_path\d+\.default\.join\(packageRoot, "package\.json"\)\)/, JSON.stringify({ name: pkg.name, version: pkg.version }));
  const browsers = await readFile(join(a.path, '..', '..', 'browsers.json'), 'utf8'), mid = text;
  text = text.replace(/new Registry\(require\(import_path\d+\.default\.join\(packageRoot, "browsers\.json"\)\)\)/, () => 'new Registry(' + browsers.trim() + ')');
  if (text === before || text === mid) throw new Error('playwright-core package.json 加载点已变化，需更新 build-sidecar.mjs');
  return { contents: text, loader: 'js' }; }); } };
// SEA main must be CommonJS and its require() only resolves builtins, so every production dependency is bundled in.
// The Bun comparison compiles the very same bundle, so both runtimes carry identical application code.
const result = await build({ entryPoints: ['src/sidecar/main.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: join(work, 'sidecar.cjs'), metafile: true, logLevel: 'warning', plugins: [stubBidi, inlinePlaywrightPackage],
  define: { 'import.meta.url': '__yingliu_import_meta_url' }, banner: { js: 'const __yingliu_import_meta_url = require("url").pathToFileURL(__filename).href;' } });
const metafile = result.metafile;
if (runtime === 'node') {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new Error('Node SEA 需要 Node >= 22.18，当前 ' + process.version);
  await writeFile(join(work, 'sea-config.json'), JSON.stringify({ main: join(work, 'sidecar.cjs'), output: join(work, 'sea.blob'), disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
  execFileSync(process.execPath, ['--experimental-sea-config', join(work, 'sea-config.json')], { stdio: 'inherit' });
  await copyFile(process.execPath, binary); await chmod(binary, 0o755);
  if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', binary]);
  const postject = ['postject', binary, 'NODE_SEA_BLOB', join(work, 'sea.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])];
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'postject@1.0.0-alpha.6', ...postject.slice(1)], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', binary]); // ad-hoc only, not a release signature
} else if (runtime === 'bun') {
  const bun = process.env.BUN ?? 'bun';
  execFileSync(bun, ['build', '--compile', '--target=bun', join(work, 'sidecar.cjs'), '--outfile', binary], { stdio: 'inherit', shell: process.platform === 'win32' });
} else throw new Error('未知 runtime ' + runtime);

const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
async function tree(dir) { let total = 0, files = []; for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) { if (!e.isFile()) continue; const f = join(e.parentPath ?? e.path, e.name); const s = (await stat(f)).size; total += s; files.push({ path: relative(target, f).split('\\').join('/'), bytes: s, sha256: await sha(f) }); } return { total, files }; }
const contents = await tree(target);
const deps = true ? [...new Set(Object.keys(metafile.inputs).map(p => p.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean))].sort() : 'bun bundle（见 bun build 输出）';
const pkgVersion = name => { try { return JSON.parse(execFileSync(process.execPath, ['-p', `JSON.stringify(require('./node_modules/${name}/package.json').version)`]).toString()); } catch { return null; } };
const manifest = { schemaVersion: 1, runtime, runtimeVersion: runtime === 'node' ? process.version : execFileSync(process.env.BUN ?? 'bun', ['--version'], { shell: process.platform === 'win32' }).toString().trim(), platform: process.platform, arch: process.arch,
  builtAt: new Date().toISOString(), buildMs: Date.now() - started, commit: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(); } catch { return null; } })(),
  binary: { path: relative(target, binary), bytes: (await stat(binary)).size, sha256: await sha(binary) }, totalBytes: contents.total, files: contents.files,
  bundledDependencies: Array.isArray(deps) ? deps.map(d => ({ name: d, version: pkgVersion(d) })) : deps,
  externalTools: ['Chrome/Chromium (system, browserPath)', 'ffmpeg', 'ffprobe'], signed: false };
await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await rm(work, { recursive: true, force: true });
console.log(JSON.stringify({ target, binaryBytes: manifest.binary.bytes, totalBytes: manifest.totalBytes, sha256: manifest.binary.sha256 }));
