import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createProject} from '../src/core/index.ts';
import {ProjectStore} from '../src/host/store.ts';
import {VideoRenderer} from '../src/host/renderer.ts';
import {AppBackend} from '../src/app/backend.ts';
import {taskFailure,sanitizeTaskFailure,withTaskFailure} from '../src/shared/task-diagnostic.ts';
import type {StudioSnapshot} from '../src/shared/types.ts';
import {readRenderDiagnostics} from '../scripts/acceptance-task.mjs';

test('task failure metadata accepts only fixed enums and never copies exception text, paths or errno',()=>{
  const error=Object.assign(new Error('private path /private/fixture sk-private-key'),{code:'EPERM',syscall:'rename',path:'/private/fixture',dest:'C:\\private',errno:-4048,stack:'private stack'});
  const expected={category:'IO_ERROR',operation:'runtime_scene_publish',ioCode:'EPERM',syscall:'rename'};
  assert.deepEqual(taskFailure(error,'runtime_scene_publish'),expected);
  assert.deepEqual(sanitizeTaskFailure({...expected,path:error.path,message:error.message,errno:error.errno}),expected);
  assert.equal(sanitizeTaskFailure({...expected,operation:'sk-private-key'}),undefined);
  assert.deepEqual(taskFailure(Object.assign(new Error('not an IO error'),{code:'sk-private-key',syscall:'/private/fixture'}),'render_check'),{category:'UNKNOWN',operation:'render_check'});
  assert.deepEqual(taskFailure(withTaskFailure(error,'runtime_scene_publish'),'task_work'),expected,'task wrappers retain the original trusted boundary');
  for(const immutable of [Object.freeze(Object.assign(new Error(error.message),{code:'EPERM',syscall:'rename',shotId:'fixture-shot',frame:7,name:'FixtureIOError'})),Object.defineProperty(Object.assign(new Error(error.message),{code:'EPERM',syscall:'rename',shotId:'fixture-shot',frame:7,name:'FixtureIOError'}),'failure',{value:null,writable:false})]){
    const wrapped=withTaskFailure(immutable,'runtime_scene_publish');assert.equal(wrapped.message,immutable.message);assert.equal(wrapped.name,immutable.name);assert.equal(wrapped.stack,immutable.stack);assert.equal(wrapped.cause,immutable);
    for(const key of ['code','syscall','shotId','frame'] as const)assert.equal((wrapped as any)[key],immutable[key]);assert.deepEqual(wrapped.failure,expected);
  }
});

test('a real runtime rename failure reaches matching-revision check diagnostics without retry or raw error fields',async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-check-io-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store),rename=fs.rename.bind(fs);let attempts=0;
  try{
    const created=await store.create(createProject('IO诊断')),expected={category:'IO_ERROR',operation:'runtime_scene_publish',ioCode:'EPERM',syscall:'rename'};
    t.mock.method(fs,'rename',async(...[from,to]:Parameters<typeof fs.rename>)=>{
      if(typeof to==='string'&&/runtime[\\/]scenes[\\/][^/\\]+-[a-f0-9]{64}\.mjs$/.test(to)){attempts++;throw Object.assign(new Error('synthetic /private/fixture sk-private-key'),{code:'EPERM',syscall:'rename',path:'/private/fixture',errno:-4048});}
      return rename(from,to);
    });syncBuiltinESMExports();
    const checked=await renderer.check(created.root,created.project,{browserPath:process.execPath,ffmpegPath:process.execPath,ffprobePath:process.execPath});
    assert.equal(checked.ok,false);assert.equal(attempts,1,'diagnostics never retry the failed operation');assert.deepEqual(checked.errors[0]?.failure,expected);
    const disk=JSON.parse(await fs.readFile(checked.reportPath!,'utf8'));assert.deepEqual(disk.errors[0].failure,expected);
    const uploaded=await readRenderDiagnostics(created.root,created.project.revision);assert.deepEqual(uploaded,[{failure:expected}]);
    for(const raw of ['sk-private-key','/private/fixture','errno','message','path'])assert.ok(!JSON.stringify(uploaded).includes(raw));
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('a browser launch failure is distinguished from runtime IO and is observed once without launching a browser',async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-check-launch-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);let attempts=0;
  try{
    const created=await store.create(createProject('启动诊断'));
    t.mock.method(chromium,'launch',async()=>{attempts++;throw new Error('browserType.launch: synthetic launch failure /private/fixture sk-private-key');});
    const checked=await renderer.check(created.root,created.project,{browserPath:process.execPath,ffmpegPath:process.execPath,ffprobePath:process.execPath});
    assert.equal(checked.ok,false);assert.equal(attempts,1);assert.deepEqual(checked.errors[0]?.failure,{category:'UNKNOWN',operation:'render_browser_launch'});
    assert.deepEqual(await readRenderDiagnostics(created.root,created.project.revision),[{failure:{category:'UNKNOWN',operation:'render_browser_launch'}}]);
  }finally{await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('scene page and console errors retain render_check diagnostics alongside a page-load failure',async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-check-page-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);
  try{
    const created=await store.create(createProject('场景错误诊断'));
    const page={setDefaultTimeout(){},on(event:string,callback:(value:any)=>void){if(event==='pageerror')callback(new Error('synthetic scene exception'));if(event==='console')callback({type:()=> 'error',text:()=> 'synthetic console error'});},async goto(){throw new Error('synthetic page load failure');}};
    const browser={async close(){},async newContext(){return {async route(){},async routeWebSocket(){},async addInitScript(){},async newPage(){return page;}};}};
    t.mock.method(chromium,'launch',async()=>browser as unknown as import('playwright-core').Browser);
    const checked=await renderer.check(created.root,created.project,{browserPath:process.execPath,ffmpegPath:process.execPath,ffprobePath:process.execPath});
    assert.equal(checked.ok,false);assert.equal(checked.errors.length,3);
    assert.deepEqual(checked.errors.map(issue=>issue.failure?.operation),['render_check','render_check','render_page_load']);
    assert.deepEqual((await readRenderDiagnostics(created.root,created.project.revision)).map(item=>(item.failure as any).operation),['render_check','render_check','render_page_load']);
  }finally{await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('optional failure metadata survives task journal and restart while legacy records remain readable',async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-task-failure-'));
  const providers={listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('No real provider may be called');}},credentials={async get(){return undefined;},async set(){},async delete(){}};
  const expected={category:'IO_ERROR' as const,operation:'runtime_spec_publish' as const,ioCode:'EBUSY' as const,syscall:'rename' as const};
  t.mock.method(VideoRenderer.prototype,'preview',async()=> 'http://127.0.0.1:1/index.html');t.mock.method(VideoRenderer.prototype,'assetBaseUrl',async()=> 'http://127.0.0.1:1/');t.mock.method(VideoRenderer.prototype,'audioPreview',async()=>null);
  t.mock.method(VideoRenderer.prototype,'check',async()=>({ok:false,errors:[{message:'synthetic existing task error',failure:expected}],frames:[]}));
  let backend:AppBackend|undefined=new AppBackend({dataDirectory:directory,providers,credentials});
  try{
    const created=await backend.call<StudioSnapshot>('create',{title:'任务诊断'});await backend.call('preview',{projectId:created.project!.id});
    const deadline=Date.now()+10000;let snapshot:StudioSnapshot;
    for(;;){snapshot=await backend.call('current',{projectId:created.project!.id});if(snapshot.task?.status==='failed'&&snapshot.task.finishedAt)break;assert.ok(Date.now()<deadline,'task did not finish');await new Promise(resolve=>setTimeout(resolve,5));}
    assert.deepEqual(snapshot.task!.failure,expected);assert.equal(snapshot.task!.error,'synthetic existing task error');
    await backend.dispose();backend=new AppBackend({dataDirectory:directory,providers,credentials});
    const restored=await backend.call<StudioSnapshot>('current',{projectId:created.project!.id});assert.equal(restored.task!.status,'failed');assert.deepEqual(restored.task!.failure,expected);assert.equal(restored.task!.error,snapshot.task!.error);
    await backend.dispose();backend=undefined;
    const record=JSON.parse(await fs.readFile(restored.task!.logPath!,'utf8'));delete record.failure;await fs.writeFile(restored.task!.logPath!,JSON.stringify(record));
    backend=new AppBackend({dataDirectory:directory,providers,credentials});const legacy=await backend.call<StudioSnapshot>('current',{projectId:created.project!.id});assert.equal(legacy.task!.status,'failed');assert.equal(legacy.task!.failure,undefined);assert.equal(legacy.task!.error,record.error);
  }finally{await backend?.dispose();await fs.rm(directory,{recursive:true,force:true});}
});
