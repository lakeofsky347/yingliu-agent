import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProject} from '../src/core/index.ts';
import {ProjectStore} from '../src/host/store.ts';
import {VideoRenderer} from '../src/host/renderer.ts';
import type {SceneSource} from '../src/shared/types.ts';

type ResourceKind='scene'|'frame'|'spec';
type RuntimeGraph={index:string;scriptUrl:string;specUrl:string;spec:{spec:{projectId:string};sources:{id:string;html:string;css:string;moduleUrl:string}[]};resources:Map<string,string>};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function bounded<T>(work:Promise<T>,label:string){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+'超时')),10_000);})]);}finally{if(timer)clearTimeout(timer);}}
async function text(url:string){const response=await fetch(url,{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200,url);return response.text();}
function attribute(tag:string,name:string){return new RegExp('\\b'+name+'=["\']([^"\']*)["\']','i').exec(tag)?.[1];}
async function graph(url:string):Promise<RuntimeGraph>{
  const index=await text(url),script=/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>/i.exec(index)?.[0];
  assert.ok(script,'runtime index必须引用完整模块');
  const meta=(index.match(/<meta\b[^>]*>/gi)??[]).find(tag=>attribute(tag,'name')==='video-studio-spec');
  const scriptUrl=new URL(attribute(script,'src')!,url).href,specUrl=new URL(meta?attribute(meta,'content')!:'./runtime/spec.json',url).href;
  const resources=new Map<string,string>(),scriptText=await text(scriptUrl),specText=await text(specUrl);
  assert.ok(scriptText.length>0,'runtime模块不可为空');assert.ok(specText.length>0,'runtime规格不可为空');
  resources.set(scriptUrl,scriptText);resources.set(specUrl,specText);
  const spec=JSON.parse(specText) as RuntimeGraph['spec'];assert.ok(Array.isArray(spec.sources));
  for(const source of spec.sources){const moduleUrl=new URL(source.moduleUrl,new URL('./runtime/',url)).href,moduleText=await text(moduleUrl);assert.ok(moduleText.length>0,'场景模块不可为空');resources.set(moduleUrl,moduleText);}
  return {index,scriptUrl,specUrl,spec,resources};
}
function source(version:string,id:string):SceneSource{return {html:`<article>${version} HTML ${id}</article>`,css:`article{--fixture-version:${version}}`,js:`export function render(ctx){ctx.root.dataset.version=${JSON.stringify(version+' JS '+id)};}`};}

for(const kind of ['scene','frame','spec'] as const)test(`runtime publication: paused ${kind} write preserves the complete prior HTTP resource graph`,{timeout:30_000},async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-runtime-publication-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store),entered=deferred(),release=deferred();
  let preparing:Promise<string>|undefined;
  const originalOpen=fs.open.bind(fs),originalWriteFile=fs.writeFile.bind(fs);
  try{
    const initial=createProject('运行时发布门闩'),oldSources=Object.fromEntries(initial.shots.map(shot=>[shot.id,source('old',shot.id)]));
    const created=await store.create({project:initial,sources:Object.entries(oldSources).map(([shotId,source])=>({shotId,source}))}),url=await renderer.preview(created.root,created.project),old=await graph(url);
    const changed=structuredClone(created.project);changed.revision++;changed.title='下一版运行时';
    const newSources=Object.fromEntries(changed.shots.map(shot=>[shot.id,source('new',shot.id)])),next=await store.commit(created.root,changed,newSources,{expectedRevision:created.project.revision});
    let blocked=false;
    const matches=(file:unknown)=>{
      const name=typeof file==='string'?file:file instanceof URL?fileURLToPath(file):Buffer.isBuffer(file)?file.toString():undefined;if(!name)return false;
      const target=relative(created.root,name).replaceAll('\\','/');
      return kind==='scene'?/^runtime\/scenes\/[^/]+\.mjs(?:\.tmp-.+)?$/.test(target):new RegExp('^runtime/'+kind+'(?:-[a-f0-9]+)?\\.'+(kind==='frame'?'mjs':'json')+'(?:\\.tmp-.+)?$').test(target);
    };
    // The legacy fs.writeFile implementation opens/truncates internally, bypassing
    // the exported open hook. Reproduce that exact visible window explicitly.
    t.mock.method(fs,'writeFile',async(...[file,data,options]:Parameters<typeof fs.writeFile>)=>{
      if(!blocked&&matches(file)){blocked=true;const handle=await originalOpen(file as string,'w');await handle.close();entered.resolve();await release.promise;}
      return originalWriteFile(file,data,options);
    });
    // Atomic writers open a fresh temporary file. Pause after that open but before
    // the writer receives its handle, while HTTP continues reading published URLs.
    t.mock.method(fs,'open',async(...[file,flags,mode]:Parameters<typeof fs.open>)=>{
      const handle=await originalOpen(file,flags,mode);
      if(!blocked&&(flags==='w'||flags==='wx')&&matches(file)){blocked=true;entered.resolve();await release.promise;}
      return handle;
    });
    syncBuiltinESMExports();
    preparing=renderer.preview(created.root,next);void preparing.catch(()=>{});
    await bounded(Promise.race([entered.promise,preparing.then(()=>{throw new Error('prepare未经过'+kind+'写入门闩');})]),'等待'+kind+'写入门闩');
    const during=await graph(url);
    assert.equal(during.index,old.index,'新图尚未发布时index应保持旧版');assert.deepEqual(during.spec,old.spec,'旧index不可读取新规格');
    assert.deepEqual(during.resources,old.resources,'旧index的每个脚本/规格/场景必须仍为旧完整字节');
    release.resolve();const nextUrl=await bounded(preparing,'下一版prepare'),published=await graph(nextUrl);
    assert.equal(published.spec.spec.projectId,next.id);assert.notEqual(published.specUrl,old.specUrl,'新图必须用独立规格URL发布');
    for(const item of published.spec.sources){assert.equal(item.html,newSources[item.id]!.html);assert.equal(item.css,newSources[item.id]!.css);const moduleUrl=new URL(item.moduleUrl,new URL('./runtime/',nextUrl)).href;assert.equal(published.resources.get(moduleUrl),newSources[item.id]!.js);}
    for(const [oldUrl,bytes] of old.resources)assert.equal(await text(oldUrl),bytes,'已发布旧URL不能被后续prepare覆盖：'+oldUrl);
  }finally{
    release.resolve();await preparing?.catch(()=>{});t.mock.restoreAll();syncBuiltinESMExports();await renderer.close();await fs.rm(directory,{recursive:true,force:true});
  }
});

test('runtime HTTP reads size and bytes from the same index inode across atomic publication',{timeout:30_000},async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-runtime-http-inode-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store),entered=deferred(),release=deferred();
  const originalOpen=fs.open.bind(fs);let reading:Promise<string>|undefined;
  try{
    const project=createProject('HTTP文件身份');project.target.width=320;project.target.height=240;
    const created=await store.create(project),url=await renderer.preview(created.root,created.project),indexFile=join(created.root,'index.html'),before=await fs.readFile(indexFile,'utf8');
    const changed=structuredClone(created.project);changed.revision++;changed.target.width=1920;changed.target.height=1080;
    const next=await store.commit(created.root,changed,{}, {expectedRevision:created.project.revision});let blocked=false;
    t.mock.method(fs,'open',async(...[file,flags,mode]:Parameters<typeof fs.open>)=>{
      if(!blocked&&file===indexFile&&flags==='r'){blocked=true;entered.resolve();await release.promise;}
      return originalOpen(file,flags,mode);
    });syncBuiltinESMExports();
    reading=text(url);void reading.catch(()=>{});
    await bounded(Promise.race([entered.promise,reading.then(()=>{throw new Error('HTTP读取未经过index open门闩');})]),'等待index open门闩');
    await renderer.preview(created.root,next);const expected=await fs.readFile(indexFile,'utf8');
    assert.notEqual(Buffer.byteLength(expected),Buffer.byteLength(before),'fixture必须改变index长度才能检测旧size/新inode混用');
    release.resolve();assert.equal(await bounded(reading,'HTTP读取完整index'),expected,'Content-Length与流数据必须来自同一已打开文件');
  }finally{release.resolve();await reading?.catch(()=>{});t.mock.restoreAll();syncBuiltinESMExports();await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('runtime HTTP closes the opened descriptor on HEAD and rejected media range requests',{timeout:30_000},async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-runtime-http-close-')),renderer=new VideoRenderer(),originalOpen=fs.open.bind(fs),closed:Promise<void>[]=[];
  try{
    const index=join(directory,'index.html'),audio=join(directory,'assets','fixture.wav');await fs.mkdir(join(directory,'assets'));
    await fs.writeFile(index,'<!doctype html><title>descriptor fixture</title>');await fs.writeFile(audio,'fixture bytes; no codec is invoked');
    const base=await renderer.assetBaseUrl(directory);
    t.mock.method(fs,'open',async(...[file,flags,mode]:Parameters<typeof fs.open>)=>{
      const handle=await originalOpen(file,flags,mode);
      if(flags==='r'&&(file===index||file===audio)){const done=deferred(),close=handle.close.bind(handle);closed.push(done.promise);t.mock.method(handle,'close',async()=>{try{await close();}finally{done.resolve();}});}
      return handle;
    });syncBuiltinESMExports();
    const head=await fetch(new URL('index.html',base),{method:'HEAD',signal:AbortSignal.timeout(5000)});assert.equal(head.status,200);assert.equal(await head.text(),'');
    const invalid=await fetch(new URL('assets/fixture.wav',base),{headers:{range:'bytes=invalid'},signal:AbortSignal.timeout(5000)});assert.equal(invalid.status,416);await invalid.arrayBuffer();
    assert.equal(closed.length,2,'两条早退路径都应先打开用于stat的文件描述符');await bounded(Promise.all(closed),'早退文件描述符关闭');
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});
