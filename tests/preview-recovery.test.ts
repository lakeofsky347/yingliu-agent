import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {createServer,type Server} from 'node:http';
import {build} from 'esbuild';
import {chromium,type Browser,type Page} from 'playwright-core';
import {findBrowserExecutable} from '../src/host/tool-environment.ts';

const executablePath=process.env.CHROME_PATH||findBrowserExecutable();
let browser:Browser|undefined,server:Server|undefined,origin='';
before(async()=>{
  if(!executablePath)return;
  const bundle=await build({stdin:{contents:`
    import React,{useLayoutEffect,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {Preview} from './src/client/Preview.tsx';
    import {createProject} from './src/core/index.ts';
    const project=createProject('恢复回归'),controller={};
    const deliver=(type,source=document.querySelector('iframe[title="影片画面预览"]').contentWindow)=>window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source,data:{type,sceneId:project.shots[0].id,message:'fixture failure'}}));
    function Fixture(){
      const [version,setVersion]=useState(1),[fast,setFast]=useState(false);
      useLayoutEffect(()=>{window.fixture={deliver,change:(next,immediate=false)=>flushSync(()=>{setFast(immediate);setVersion(next);})};if(fast)deliver('video-studio/frame');},[version,fast]);
      return <Preview project={project} controller={controller} snapshot={{previewUrl:location.origin+'/scene?revision='+version,previewRevision:project.revision}}/>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `,resolveDir:process.cwd(),sourcefile:'preview-recovery-fixture.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'esm',write:false,logLevel:'silent'});
  const script=bundle.outputFiles[0]!.text;
  server=createServer((request,response)=>{
    response.setHeader('Cache-Control','no-store');
    if(request.url==='/fixture.js'){response.setHeader('Content-Type','text/javascript');response.end(script);}
    else if(request.url?.startsWith('/scene')){response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>受控画面回执 fixture</title>');}
    else{response.setHeader('Content-Type','text/html');response.end('<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');}
  });
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  browser=await chromium.launch({chromiumSandbox:true,executablePath,headless:true});
});
after(async()=>{await browser?.close();await new Promise<void>((resolve,reject)=>server?server.close(error=>error?reject(error):resolve()):resolve());});
async function fixture(run:(page:Page)=>Promise<void>){const page=await browser!.newPage();try{await page.goto(origin);await page.locator('iframe[title="影片画面预览"]').waitFor();await page.waitForFunction(()=>Boolean((window as any).fixture));await run(page);}finally{await page.close();}}
const options={skip:!executablePath&&'no Chromium available'};

test('a successful current scene frame clears a previously reported render failure',options,async()=>fixture(async page=>{
  await page.evaluate(()=>(window as any).fixture.deliver('video-studio/error'));
  await page.getByRole('alert').waitFor();
  await page.evaluate(()=>(window as any).fixture.deliver('video-studio/frame'));
  await page.waitForFunction(()=>!(document.querySelector('.vs-player button') as HTMLButtonElement)?.disabled);
  assert.equal(await page.getByRole('alert').count(),0,'successful frame must remove the stale error overlay');
}));

test('a new preview revision rejects queued messages from the old browsing context',options,async()=>fixture(async page=>{
  await page.evaluate(()=>{(window as any).oldScene=(document.querySelector('iframe[title="影片画面预览"]') as HTMLIFrameElement).contentWindow;(window as any).fixture.change(2);});
  const freshContext=await page.evaluate(()=>(window as any).oldScene!==(document.querySelector('iframe[title="影片画面预览"]') as HTMLIFrameElement).contentWindow);
  assert.equal(freshContext,true,'a revision switch must replace the browsing context');
  await page.evaluate(()=>{for(const type of ['video-studio/ready','video-studio/frame','video-studio/error'])(window as any).fixture.deliver(type,(window as any).oldScene);});
  assert.equal(await page.getByRole('button',{name:'播放',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('alert').count(),0);
  await page.evaluate(()=>(window as any).fixture.deliver('video-studio/frame'));
  await page.waitForFunction(()=>!(document.querySelector('.vs-player button') as HTMLButtonElement)?.disabled);
}));

test('the earliest valid frame after a revision commit survives lifecycle resets',options,async()=>fixture(async page=>{
  await page.evaluate(()=>(window as any).fixture.change(2,true));
  // The fixture sends its sole frame in its parent layout effect, before passive effects.
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
  assert.equal(await page.getByRole('button',{name:'播放',exact:true}).isEnabled(),true,'passive reset must not erase an acknowledged frame');
  assert.equal(await page.getByRole('alert').count(),0);
}));
