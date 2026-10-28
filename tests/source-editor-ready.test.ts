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
    import {SourceEditor} from './src/client/SourceEditor.tsx';
    const pending=[],shots=[{id:'shot-a',title:'A'},{id:'shot-b',title:'B'}];
    window.fixture={pending,dirty:false,complete:(index,html)=>pending[index].resolve({html,css:'fixture css',js:'fixture js'})};
    const controller={readSource:id=>new Promise(resolve=>pending.push({id,resolve})),setSourceDraftDirty:dirty=>{window.fixture.dirty=dirty;},getSnapshot:()=>({error:''})};
    function Fixture(){
      const [shot,setShot]=useState(0),[version,setVersion]=useState(0);
      useLayoutEffect(()=>{window.fixture.initialEditable=!!document.querySelector('textarea');window.fixture.change=(next,revision)=>flushSync(()=>{setShot(next);setVersion(revision);});},[]);
      return <SourceEditor controller={controller} selectedShot={shots[shot]} busy={false} version={String(version)}/>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `,resolveDir:process.cwd(),sourcefile:'source-editor-ready-fixture.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'esm',write:false,logLevel:'silent'});
  const script=bundle.outputFiles[0]!.text;
  server=createServer((request,response)=>{response.setHeader('Cache-Control','no-store');if(request.url==='/fixture.js'){response.setHeader('Content-Type','text/javascript');response.end(script);}else{response.setHeader('Content-Type','text/html');response.end('<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');}});
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  browser=await chromium.launch({chromiumSandbox:true,executablePath,headless:true});
});
after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise<void>((resolve,reject)=>server?server.close(error=>error?reject(error):resolve()):resolve());});
const options={skip:!executablePath&&'no Chromium available'};
async function fixture(run:(page:Page)=>Promise<void>){const page=await browser!.newPage();try{await page.goto(origin);await page.waitForFunction(()=>Boolean((window as any).fixture?.change));await run(page);}finally{await page.close();}}

test('a controlled pending source read never exposes an empty editable field before or after passive effects',options,async()=>fixture(async page=>{
  assert.equal(await page.evaluate(()=>(window as any).fixture.initialEditable),false,'initial commit cannot expose a false ready textarea');assert.equal(await page.getByRole('textbox',{name:'HTML 源码'}).count(),0);
  await page.evaluate(()=>(window as any).fixture.complete(0,'<main>loaded A</main>'));await page.getByRole('textbox',{name:'HTML 源码'}).waitFor();assert.equal(await page.getByRole('textbox',{name:'HTML 源码'}).inputValue(),'<main>loaded A</main>');
}));

test('switching shots hides the old editor and ignores a late source response from the previous shot',options,async()=>fixture(async page=>{
  await page.evaluate(()=>(window as any).fixture.change(1,0));await page.waitForFunction(()=>(window as any).fixture.pending.length===2);assert.equal(await page.getByRole('textbox',{name:'HTML 源码'}).count(),0);
  await page.evaluate(()=>(window as any).fixture.complete(0,'<main>stale A</main>'));assert.equal(await page.getByRole('textbox',{name:'HTML 源码'}).count(),0);
  await page.evaluate(()=>(window as any).fixture.complete(1,'<main>loaded B</main>'));await page.getByRole('textbox',{name:'HTML 源码'}).waitFor();assert.equal(await page.getByRole('textbox',{name:'HTML 源码'}).inputValue(),'<main>loaded B</main>');
}));

test('an already loaded manual draft survives a version refresh without another source read',options,async()=>fixture(async page=>{
  await page.evaluate(()=>(window as any).fixture.complete(0,'<main>loaded A</main>'));const editor=page.getByRole('textbox',{name:'HTML 源码'});await editor.waitFor();await editor.fill('<main>manual draft</main>');await page.waitForFunction(()=>(window as any).fixture.dirty===true);
  await page.evaluate(()=>(window as any).fixture.change(0,1));assert.equal(await editor.inputValue(),'<main>manual draft</main>');assert.equal(await page.evaluate(()=>(window as any).fixture.pending.length),1);assert.equal(await page.evaluate(()=>(window as any).fixture.dirty),true);
}));
