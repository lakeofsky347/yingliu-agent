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

test('identical content-addressed runtime resources avoid an existing-target EPERM rename while changed revisions still publish completely',{timeout:30_000},async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-runtime-reuse-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store),rename=fs.rename.bind(fs);
  try{
    const initial=createProject('不可变资源复用'),oldSources=Object.fromEntries(initial.shots.map(shot=>[shot.id,source('old',shot.id)]));
    const created=await store.create({project:initial,sources:Object.entries(oldSources).map(([shotId,source])=>({shotId,source}))}),url=await renderer.preview(created.root,created.project),old=await graph(url);let replacements=0,newFiles=0;
    t.mock.method(fs,'rename',async(...[from,to]:Parameters<typeof fs.rename>)=>{
      const destination=typeof to==='string'?relative(created.root,to).replaceAll('\\','/'):'';
      if(/^runtime\/(?:frame-[a-f0-9]{64}\.mjs|spec-[a-f0-9]{64}\.json|scenes\/[^/]+-[a-f0-9]{64}\.mjs)$/.test(destination)){
        let exists=false;try{await fs.stat(to);exists=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(exists){replacements++;throw Object.assign(new Error('synthetic Windows existing-target rename failure'),{code:'EPERM',syscall:'rename'});}newFiles++;
      }
      return rename(from,to);
    });syncBuiltinESMExports();
    await renderer.preview(created.root,created.project);assert.equal(replacements,0,'相同hash资源不可尝试替换已发布文件');assert.equal(newFiles,0);assert.deepEqual((await graph(url)).resources,old.resources);
    const next=structuredClone(created.project);next.revision++;next.title='新版本仍须完整发布';const shot=next.shots[0]!,changed=source('new',shot.id),saved=await store.commit(created.root,next,{[shot.id]:changed},{expectedRevision:created.project.revision});
    const published=await graph(await renderer.preview(created.root,saved));assert.equal(replacements,0);assert.equal(newFiles,2,'变更镜头与新spec应各耐久发布一个新hash文件');
    for(const item of published.spec.sources){const expected=item.id===shot.id?changed:oldSources[item.id]!;assert.equal(item.html,expected.html);assert.equal(item.css,expected.css);assert.equal(published.resources.get(new URL(item.moduleUrl,new URL('./runtime/',url)).href),expected.js);}
    for(const [resource,bytes]of old.resources)assert.equal(await text(resource),bytes,'旧hash资源继续保留原完整内容');
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

for(const condition of ['missing','corrupt'] as const)test(`${condition} content-addressed runtime bytes still publish through a synced temporary file and atomic rename`,{timeout:30_000},async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-runtime-repair-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store),open=fs.open.bind(fs),rename=fs.rename.bind(fs),entered=deferred(),release=deferred();let preparing:Promise<string>|undefined;
  try{
    const created=await store.create(createProject('不可变文件修复')),url=await renderer.preview(created.root,created.project),before=await graph(url),file=join(created.root,new URL(before.scriptUrl).pathname.slice(1)),expected=Buffer.from(before.resources.get(before.scriptUrl)!,'utf8'),corrupt=Buffer.from(expected);corrupt[0]=corrupt[0]!^1;
    const scenes=before.spec.sources.map(item=>new URL(item.moduleUrl,new URL('./runtime/',url)).href);assert.equal(new Set(scenes).size,created.project.shots.length,'相同JS的不同镜头保持独立ID模块URL');assert.equal(new Set(scenes.map(scene=>before.resources.get(scene))).size,1);
    if(condition==='missing')await fs.rm(file);else await fs.writeFile(file,corrupt);let fileSyncs=0,renames=0;
    t.mock.method(fs,'open',async(...[destination,flags,mode]:Parameters<typeof fs.open>)=>{
      const handle=await open(destination,flags,mode);
      if(typeof destination==='string'&&destination.startsWith(file+'.tmp-')&&flags==='wx'){const sync=handle.sync.bind(handle);t.mock.method(handle,'sync',async()=>{fileSyncs++;await sync();});entered.resolve();await release.promise;}
      return handle;
    });
    t.mock.method(fs,'rename',async(...[from,to]:Parameters<typeof fs.rename>)=>{if(to===file)renames++;return rename(from,to);});syncBuiltinESMExports();
    preparing=renderer.preview(created.root,created.project);void preparing.catch(()=>{});
    await bounded(Promise.race([entered.promise,preparing.then(()=>{throw new Error('缺失/损坏资源未经过耐久临时文件门闩');})]),'等待不可变文件修复');assert.equal(renames,0);
    if(condition==='missing')await assert.rejects(fs.stat(file),{code:'ENOENT'});else assert.deepEqual(await fs.readFile(file),corrupt,'替换前不可原位截断损坏目标');
    release.resolve();await bounded(preparing,'耐久发布完成');assert.equal(fileSyncs,1);assert.equal(renames,1);assert.deepEqual(await fs.readFile(file),expected);assert.deepEqual((await graph(url)).resources,before.resources);
  }finally{release.resolve();await preparing?.catch(()=>{});t.mock.restoreAll();syncBuiltinESMExports();await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('non-ENOENT immutable read failures retain diagnostics and fail without rename, truncate or retry',{timeout:30_000},async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-runtime-read-error-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store),open=fs.open.bind(fs),rename=fs.rename.bind(fs);
  try{
    const created=await store.create(createProject('不可变读取错误')),url=await renderer.preview(created.root,created.project),before=await graph(url),file=join(created.root,new URL(before.scriptUrl).pathname.slice(1)),expected=await fs.readFile(file);let ioCode='EACCES',reads=0,renames=0,closes=0;
    t.mock.method(fs,'open',async(...[destination,flags,mode]:Parameters<typeof fs.open>)=>{const handle=await open(destination,flags,mode);if(destination===file&&flags==='r'){t.mock.method(handle,'read',async()=>{reads++;throw Object.assign(new Error('synthetic immutable read failure'),{code:ioCode,syscall:'read'});});const close=handle.close.bind(handle);t.mock.method(handle,'close',async()=>{await close();closes++;});}return handle;});
    t.mock.method(fs,'rename',async(...[from,to]:Parameters<typeof fs.rename>)=>{if(to===file)renames++;return rename(from,to);});syncBuiltinESMExports();
    for(ioCode of ['EACCES','EIO'])await assert.rejects(renderer.preview(created.root,created.project),(error:any)=>error.code===ioCode&&error.failure?.operation==='runtime_frame_publish'&&error.failure?.ioCode===ioCode);
    assert.equal(reads,2);assert.equal(closes,2);assert.equal(renames,0);assert.deepEqual(await fs.readFile(file),expected);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

for(const condition of ['oversize','grew_after_stat'] as const)test(`${condition} immutable cache cannot trigger unbounded reads and closes its descriptor before repair`,{timeout:30_000},async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-runtime-bounded-read-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store),open=fs.open.bind(fs),rename=fs.rename.bind(fs);
  try{
    const created=await store.create(createProject('不可变读取上限')),url=await renderer.preview(created.root,created.project),before=await graph(url),file=join(created.root,new URL(before.scriptUrl).pathname.slice(1)),expected=Buffer.from(before.resources.get(before.scriptUrl)!,'utf8');await fs.writeFile(file,Buffer.concat([expected,Buffer.alloc(4096,1)]));let bytesRead=0,reads=0,closed=false,renames=0,intercepted=false;
    t.mock.method(fs,'open',async(...[destination,flags,mode]:Parameters<typeof fs.open>)=>{
      const handle=await open(destination,flags,mode);if(!intercepted&&destination===file&&flags==='r'){intercepted=true;
        if(condition==='grew_after_stat'){const info=await handle.stat();t.mock.method(handle,'stat',async()=>Object.assign(info,{size:expected.length}));}
        const read=handle.read.bind(handle);t.mock.method(handle,'read',async(buffer:Buffer,offset:number,length:number,position:null)=>{reads++;assert.ok(length<=expected.length+1);const result=await read(buffer,offset,length,position);bytesRead+=result.bytesRead;assert.ok(bytesRead<=expected.length+1);return result;});
        const close=handle.close.bind(handle);t.mock.method(handle,'close',async()=>{await close();closed=true;});
      }return handle;
    });
    t.mock.method(fs,'rename',async(...[from,to]:Parameters<typeof fs.rename>)=>{if(to===file){assert.equal(closed,true,'读取用fd必须在耐久替换前关闭');renames++;}return rename(from,to);});syncBuiltinESMExports();
    await renderer.preview(created.root,created.project);assert.equal(renames,1);assert.equal(closed,true);
    if(condition==='oversize'){assert.equal(reads,0);assert.equal(bytesRead,0);}else assert.equal(bytesRead,expected.length+1,'必须检测完整bytes之后的额外字节');
    assert.deepEqual(await fs.readFile(file),expected);assert.deepEqual((await graph(url)).resources,before.resources);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});
