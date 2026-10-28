import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer,type ServerResponse} from 'node:http';
import {access,readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {browserRuntime,runtimeHtml} from '../src/runtime/browser.ts';
import {findBrowserExecutable} from '../src/host/tool-environment.ts';
import {createProject,compileSpec} from '../src/core/index.ts';

const browserPath=process.env.CHROME_PATH||findBrowserExecutable();
const candidates=process.platform==='win32'?[`${process.env.WINDIR||'C:\\Windows'}\\Fonts\\arial.ttf`]:process.platform==='darwin'?['/System/Library/Fonts/Supplemental/Arial.ttf']:['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'];
let fontPath='';for(const candidate of candidates)try{await access(candidate);fontPath=candidate;break;}catch{}

test('frame completion waits for fonts first used by render after its DOM and style mutations',{skip:!browserPath||!fontPath,timeout:20000},async()=>{
  const project=createProject('字体屏障 fixture');project.shots=project.shots.slice(0,1);project.shotOrder=project.shots.map(shot=>shot.id);project.shots[0]!.durationFrames=2;project.target={width:320,height:180,fps:{num:2,den:1},audioMode:'none'};
  const font=await readFile(fontPath),spec=compileSpec(project);let fontResponse:ServerResponse|undefined,requested!:()=>void;
  const fontRequested=new Promise<void>(resolve=>{requested=resolve;});
  const server=createServer((request,response)=>{
    if(request.url==='/font.ttf'){fontResponse=response;requested();return;}
    if(request.url==='/runtime/spec.json'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({spec,sources:[{id:spec.shots[0]!.id,html:'<div id="title"></div>',css:'@font-face{font-family:LateFixture;src:url(/font.ttf);unicode-range:U+03A9;font-display:swap}#title{font-family:LateFixture,serif;font-size:64px}',moduleUrl:'/scene.mjs'}]}));}
    else if(request.url==='/scene.mjs'){response.setHeader('Content-Type','text/javascript');response.end('export function render(ctx){ctx.root.querySelector("#title").textContent=ctx.frame?"ΩΩ":"WWWW";}');}
    else if(request.url==='/runtime/frame.mjs'){response.setHeader('Content-Type','text/javascript');response.end(browserRuntime);}
    else{response.setHeader('Content-Type','text/html');response.end(runtimeHtml(320,180));}
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({chromiumSandbox:true,headless:true,executablePath:browserPath});
  try{
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!(window as any).__VIDEO_WORKPACK__);
    await page.evaluate(()=>(window as any).__VIDEO_WORKPACK__.renderFrame({frame:0}));
    await page.evaluate(()=>{(window as any).__frameDone=false;(window as any).__framePromise=(window as any).__VIDEO_WORKPACK__.renderFrame({frame:1}).then(()=>{(window as any).__frameDone=true;});});
    await fontRequested;await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
    assert.equal(await page.evaluate(()=>(window as any).__frameDone),false,'renderFrame must remain pending while the newly used font is loading');
    fontResponse!.writeHead(200,{'Content-Type':'font/ttf'});fontResponse!.end(font);
    await page.evaluate(()=>(window as any).__framePromise);assert.equal(await page.evaluate(()=>document.fonts.status),'loaded');
  }finally{fontResponse?.end(font);await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
