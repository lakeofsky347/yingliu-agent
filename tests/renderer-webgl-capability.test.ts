import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {chromium,type Browser} from 'playwright-core';
import {RENDER_BROWSER_ARGS,detectEnvironment,WEBRTC_LOCKDOWN_SCRIPT} from '../src/host/renderer.ts';

type Capability={available:boolean;pixels?:number[];error?:number;contextLost?:boolean;backend?:string;software?:boolean};
const browserPath=process.env.CHROME_PATH||detectEnvironment().browserPath;
const profiles=new Map<string,Record<'webgl'|'webgl2',Capability>>(),owned:Browser[]=[];
before(async()=>{
  if(!browserPath)return;
  assert.ok(RENDER_BROWSER_ARGS.includes('--disable-gpu-compositing'),'candidate must be the current software compositor profile');
  for(const [name,args]of [['baseline',RENDER_BROWSER_ARGS.filter(flag=>flag!=='--disable-gpu-compositing')],['candidate',[...RENDER_BROWSER_ARGS]]] as const){
    // Both runs retain the production sandbox, WebRTC restrictions and other
    // capture flags. Only the compositor selection differs between profiles.
    const browser=await chromium.launch({executablePath:browserPath,chromiumSandbox:true,headless:true,args:[...args]});owned.push(browser);
    const context=await browser.newContext({viewport:{width:8,height:8},deviceScaleFactor:1,serviceWorkers:'block'});await context.addInitScript(WEBRTC_LOCKDOWN_SCRIPT);
    const page=await context.newPage();await page.goto('about:blank');
    const result=await page.evaluate(()=>{
      const capabilities={} as Record<'webgl'|'webgl2',Capability>;
      for(const api of ['webgl','webgl2'] as const){
        const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;document.body.append(canvas);
        const gl=canvas.getContext(api,{antialias:false,preserveDrawingBuffer:true}) as WebGLRenderingContext|WebGL2RenderingContext|null;
        if(!gl){capabilities[api]={available:false};continue;}
        const extension=gl.getExtension('WEBGL_debug_renderer_info'),backend=String(gl.getParameter(extension?extension.UNMASKED_RENDERER_WEBGL:gl.RENDERER));
        gl.viewport(0,0,2,2);gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.finish();
        const pixels=new Uint8Array(16);gl.readPixels(0,0,2,2,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        capabilities[api]={available:true,pixels:[...pixels],error:gl.getError(),contextLost:gl.isContextLost(),backend,software:/swiftshader|llvmpipe|softpipe|software/i.test(backend)};
      }
      return capabilities;
    });profiles.set(name,result);await browser.close();
  }
});
after(async()=>{await Promise.allSettled(owned.map(browser=>browser.close()));});

for(const api of ['webgl','webgl2'] as const)test(`software compositor preserves ${api} availability, backend and exact clear/readPixels output`,{skip:!browserPath&&'no Chromium available; 3D capability NOT_CHECKED'},t=>{
  const baseline=profiles.get('baseline')![api],candidate=profiles.get('candidate')![api];
  t.diagnostic(JSON.stringify({api,baseline:baseline.available?'AVAILABLE':'UNAVAILABLE',candidate:candidate.available?'AVAILABLE':'UNAVAILABLE',baselineSoftware:baseline.software??null,candidateSoftware:candidate.software??null,scope:'3D API capability; availability alone does not prove hardware GPU acceleration'}));
  if(!baseline.available){t.skip('baseline context unavailable; preservation of this 3D API is NOT_CHECKED');return;}
  assert.equal(candidate.available,true,'software compositor must not disable a working 3D API');
  const expected=Array.from({length:4},()=>[255,0,0,255]).flat();
  for(const profile of [baseline,candidate]){assert.equal(profile.contextLost,false);assert.equal(profile.error,0);assert.deepEqual(profile.pixels,expected);}
  assert.equal(candidate.backend,baseline.backend,'the compositor switch must not silently change the WebGL renderer backend');
  assert.deepEqual(candidate.pixels,baseline.pixels);
});
