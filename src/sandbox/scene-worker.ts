/**
 * P0 W4 (minimal): run one untrusted scene in a dedicated, host-owned Chromium process with a host-side watchdog.
 * The watchdog is a Node timer in the host process, so a scene `while(true)` cannot starve it. On timeout the host
 * SIGKILLs only the process group it spawned (Chromium is started detached as its own group leader) and deletes its
 * temporary profile. Network: every request is aborted except data:/blob:, WebSockets are closed, WebRTC constructors
 * are removed and non-proxied UDP is disabled, and all traffic is pointed at a dead proxy as a second layer.
 * The scene never shares a process, origin, token or IPC bridge with the trusted editor.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { WEBRTC_LOCKDOWN_SCRIPT } from '../shared/webrtc-lockdown.ts';

export interface SceneRunOptions { browserPath: string; html: string; timeoutMs: number; width?: number; height?: number; settleMs?: number; jsWebRtcLockdown?: boolean; evaluate?: string }
export interface SceneRunResult { ok: boolean; timedOut: boolean; killed: boolean; elapsedMs: number; pid?: number; pngSha256?: string; value?: unknown; blocked: string[]; popupsClosed: number; navigationEscapes: string[]; navigationsBlocked: number; console: string[]; mainUrl?: string; error?: string }
export interface SceneHostOptions {/** Trusted host/test capability selection; never taken from a scene or RPC payload. */platform?:NodeJS.Platform}

const LOCKDOWN_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--metrics-recording-only'];

const ownedBrowsers=new WeakMap<ChildProcess,{groupId?:number;cleaned:boolean}>();
function launch(browserPath: string, profile: string,owned:(child:ChildProcess)=>void): Promise<{ child: ChildProcess; ws: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(browserPath, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, ...LOCKDOWN_ARGS, 'about:blank'], { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
    ownedBrowsers.set(child,{groupId:process.platform==='win32'?undefined:child.pid,cleaned:false});owned(child);
    let text = '';
    child.stderr!.on('data', d => { text = (text+d).slice(-65536); const m = text.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve({ child, ws: m[1]! }); });
    child.once('error', reject); child.once('exit', c => reject(new Error('Chromium 提前退出 ' + c)));
  });
}

/** Kill only what we spawned: the detached group led by our Chromium pid. */
export function killOwnBrowser(child: ChildProcess): void {
  const ownership=ownedBrowsers.get(child);if(!ownership||ownership.cleaned||child.pid===undefined)return;
  ownership.cleaned=true;
  try {
    // A POSIX group remains ours while its leader has exited and descendants are
    // still alive. Never convert arbitrary/discovered PIDs into kill targets.
    if(ownership.groupId!==undefined)process.kill(-ownership.groupId,'SIGKILL');
    else if(child.exitCode===null&&child.signalCode===null)spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'}).on('error',()=>{});
  }catch{if(child.exitCode===null&&child.signalCode===null)try{child.kill('SIGKILL');}catch{/* already gone */}}
}

export async function runScene(options: SceneRunOptions,host:SceneHostOptions={}): Promise<SceneRunResult> {
  // Actual Windows cannot be overridden to claim POSIX ownership semantics.
  if(process.platform==='win32'||host.platform==='win32')return {ok:false,timedOut:false,killed:false,elapsedMs:0,blocked:[],popupsClosed:0,navigationEscapes:[],navigationsBlocked:0,console:[],error:'SCENE_PLATFORM_UNSUPPORTED：Windows 独立场景执行需要先实现并验收 JobObject；本次未启动任何浏览器'};
  if(!Number.isFinite(options.timeoutMs)||options.timeoutMs<1)throw new Error('场景总超时须为正数');
  const started = performance.now(), profile = await mkdtemp(join(tmpdir(), 'yingliu-scene-'));
  const blocked: string[] = [], navigationEscapes: string[] = []; const consoleLines: string[] = []; let navigationsBlocked = 0, popupsClosed = 0, timedOut = false, killed = false, browser: Browser | undefined, child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result:SceneRunResult;
  try {
    const watchdog = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; if(child){killed=true;killOwnBrowser(child);} reject(new Error('场景启动或执行超过总时限，已终止自有 Chromium')); }, Math.max(1,options.timeoutMs-(performance.now()-started))); });
    const work = (async () => {
      const launched=await launch(options.browserPath,profile,process=>{child=process;});
      if(timedOut)throw new Error('场景启动超过总时限');
      browser = await chromium.connectOverCDP(launched.ws);
      if(timedOut){void browser.close().catch(()=>{});throw new Error('场景连接超过总时限');}
      const context = browser.contexts()[0]!;
      await context.route('**/*', async route => { const u = route.request().url(); if (u.startsWith('data:') || u.startsWith('blob:') || u === 'about:blank') return route.continue(); blocked.push(u.split('?')[0]!); await route.abort('blockedbyclient'); });
      await context.routeWebSocket('**/*', async socket => { blocked.push('ws:' + socket.url().split('?')[0]); await socket.close(); });
      if (options.jsWebRtcLockdown !== false) await context.addInitScript(WEBRTC_LOCKDOWN_SCRIPT);
      // A fresh page AFTER addInitScript, and a real navigation (not setContent into the pre-existing about:blank):
      // P0 found that setContent reuses a document created before the init script, leaving RTCPeerConnection intact.
      const initial = context.pages(); const page = await context.newPage(); for (const p of initial) await p.close().catch(() => {});
      await page.setViewportSize({ width: options.width ?? 640, height: options.height ?? 360 });
      context.on('page', p => { if (p !== page) { popupsClosed++; void p.close().catch(() => {}); } });
      // A blocked navigation lands on Chromium's own error page (no remote content); anything else is an escape.
      page.on('framenavigated', f => { if (f !== page.mainFrame()) return; const u = f.url(); if (u.startsWith('chrome-error://')) navigationsBlocked++; else if (u !== 'about:blank' && !u.startsWith('data:')) navigationEscapes.push(u); });
      page.on('console', m => { if (consoleLines.length < 50) consoleLines.push(m.text().slice(0, 500)); });
      await page.goto('data:text/html;base64,' + Buffer.from(options.html).toString('base64'), { waitUntil: 'load', timeout: 0 });
      if (options.settleMs) await page.waitForTimeout(options.settleMs);
      const value = options.evaluate ? await page.evaluate(options.evaluate) : undefined;
      const png = await page.screenshot({ type: 'png' });
      return { value, pngSha256: createHash('sha256').update(png).digest('hex'), mainUrl: page.url() };
    })();
    const r = await Promise.race([work, watchdog]);
    result = { ok: true, timedOut, killed, elapsedMs: 0, pid: child?.pid, ...r, blocked, popupsClosed, navigationEscapes, navigationsBlocked, console: consoleLines };
  } catch (e) {
    result = { ok: false, timedOut, killed, elapsedMs: 0, pid: child?.pid, blocked, popupsClosed, navigationEscapes, navigationsBlocked, console: consoleLines, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    if (browser && !killed) await Promise.race([browser.close().catch(() => {}), new Promise(r => {const timer=setTimeout(r,300);timer.unref();})]);
    if (child) { killOwnBrowser(child); if (child.exitCode === null && child.signalCode === null) await new Promise(r => {const timer=setTimeout(r,1000);child!.once('exit',()=>{clearTimeout(timer);r(undefined);});}); }
    await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
  result.elapsedMs=Math.round(performance.now()-started);return result;
}
