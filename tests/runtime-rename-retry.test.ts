import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {createProject} from '../src/core/index.ts';
import {ProjectStore} from '../src/host/store.ts';
import {VideoRenderer,writeRuntimeFile} from '../src/host/renderer.ts';
import {taskFailure} from '../src/shared/task-diagnostic.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function bounded<T>(promise:Promise<T>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('runtime retry fixture timed out')),10000);})]);}finally{if(timer)clearTimeout(timer);}}
async function text(url:string){const response=await fetch(url,{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);return response.text();}
async function graph(url:string){
  const index=await text(url),script=/\bsrc="([^"]+)"/.exec(index)?.[1],manifest=/<meta name="video-studio-spec" content="([^"]+)"/.exec(index)?.[1];assert.ok(script&&manifest);
  const resources=new Map<string,string>(),scriptUrl=new URL(script,url).href,specUrl=new URL(manifest,url).href;
  resources.set(scriptUrl,await text(scriptUrl));const specText=await text(specUrl);resources.set(specUrl,specText);const data=JSON.parse(specText);
  for(const source of data.sources){const moduleUrl=new URL(source.moduleUrl,new URL('./runtime/',url)).href;resources.set(moduleUrl,await text(moduleUrl));}
  return {index,resources,data};
}
const denied=()=>Object.assign(new Error('synthetic Windows rename denial'),{code:'EPERM',syscall:'rename'});

test('a temporarily denied Windows index rename preserves the old HTTP graph and publishes the new index last',{timeout:30000},async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-runtime-rename-release-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store),rename=fs.rename.bind(fs),open=fs.open.bind(fs);
  const first=deferred(),releaseFailure=deferred(),second=deferred(),releaseSuccess=deferred(),platform=Object.getOwnPropertyDescriptor(process,'platform')!;let preparing:Promise<string>|undefined;
  try{
    const created=await store.create(createProject('runtime index重试')),url=await renderer.preview(created.root,created.project),old=await graph(url),index=join(created.root,'index.html'),next=structuredClone(created.project);next.revision++;next.title='新图最后发布';
    const shot=next.shots[0]!,changed={html:'<p>new scene</p>',css:'p{color:red}',js:'export function render(ctx){ctx.root.dataset.revision="new";}'};
    const saved=await store.commit(created.root,next,{[shot.id]:changed},{expectedRevision:created.project.revision});let attempts=0,syncs=0;const published:string[]=[],temporaries=new Set<string>();
    t.mock.method(fs,'open',async(...[file,flags,mode]:Parameters<typeof fs.open>)=>{const handle=await open(file,flags,mode);if(typeof file==='string'&&file.startsWith(index+'.tmp-')&&flags==='wx'){temporaries.add(file);const sync=handle.sync.bind(handle);t.mock.method(handle,'sync',async()=>{syncs++;await sync();});}return handle;});
    t.mock.method(fs,'rename',async(...[from,to]:Parameters<typeof fs.rename>)=>{
      if(to===index){attempts++;if(attempts===1){first.resolve();await releaseFailure.promise;throw denied();}if(attempts===2){second.resolve();await releaseSuccess.promise;}}
      const result=await rename(from,to);published.push(relative(created.root,String(to)).replaceAll('\\','/'));return result;
    });syncBuiltinESMExports();
    // Keep controlled HTTP gates independent of scheduler latency; expiry of
    // the production monotonic deadline is asserted in its own case below.
    t.mock.method(performance,'now',()=>0);
    // This is a test-only host platform fixture. The production call captures
    // win32 at entry; restore it before HTTP observations and later retries.
    Object.defineProperty(process,'platform',{...platform,value:'win32'});preparing=renderer.preview(created.root,saved);void preparing.catch(()=>{});
    await bounded(Promise.race([first.promise,preparing.then(()=>{throw new Error('missing first index rename gate');})]));Object.defineProperty(process,'platform',platform);
    assert.deepEqual(await graph(url),old);releaseFailure.resolve();
    await bounded(Promise.race([second.promise,preparing.then(()=>{throw new Error('missing Windows retry');})]));assert.deepEqual(await graph(url),old,'retry等待及第二次发布前，旧index和资源必须仍完整');
    releaseSuccess.resolve();const result=await graph(await bounded(preparing));assert.equal(attempts,2);assert.equal(temporaries.size,2);assert.equal(syncs,2,'每次尝试都同步新临时文件');assert.equal(published.at(-1),'index.html');
    const source=result.data.sources.find((item:any)=>item.id===shot.id);assert.equal(source.html,changed.html);assert.equal(result.resources.get(new URL(source.moduleUrl,new URL('./runtime/',url)).href),changed.js);
    for(const [resource,bytes]of old.resources)assert.equal(await text(resource),bytes);assert.ok(!(await fs.readdir(created.root)).some(name=>name.startsWith('index.html.tmp-')));
  }finally{Object.defineProperty(process,'platform',platform);releaseFailure.resolve();releaseSuccess.resolve();await preparing?.catch(()=>{});t.mock.restoreAll();syncBuiltinESMExports();await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('permanent Windows EPERM rename stops at the attempt cap and preserves the first IO error and live index',{timeout:10000},async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-runtime-rename-cap-')),file=join(directory,'index.html'),rename=fs.rename.bind(fs),first=denied();let attempts=0;
  try{
    await fs.writeFile(file,'old complete index');t.mock.method(performance,'now',()=>0);
    t.mock.method(fs,'rename',async(...[from,to]:Parameters<typeof fs.rename>)=>{if(to===file){attempts++;throw attempts===1?first:denied();}return rename(from,to);});syncBuiltinESMExports();
    await assert.rejects(writeRuntimeFile(file,'new complete index','win32'),error=>error===first);assert.equal(attempts,8);assert.equal(await fs.readFile(file,'utf8'),'old complete index');
    assert.deepEqual(taskFailure(first,'runtime_index_publish'),{category:'IO_ERROR',operation:'runtime_index_publish',ioCode:'EPERM',syscall:'rename'});assert.deepEqual(await fs.readdir(directory),['index.html']);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await fs.rm(directory,{recursive:true,force:true});}
});

test('the monotonic Windows retry window expires without changing an IO error into a timeout or starting another write',async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-runtime-rename-deadline-')),file=join(directory,'index.html'),rename=fs.rename.bind(fs),error=denied();let clock=0,attempts=0;
  try{
    await fs.writeFile(file,'old');t.mock.method(performance,'now',()=>clock);
    t.mock.method(fs,'rename',async(...[from,to]:Parameters<typeof fs.rename>)=>{if(to===file){attempts++;clock=750;throw error;}return rename(from,to);});syncBuiltinESMExports();
    await assert.rejects(writeRuntimeFile(file,'new','win32'),value=>value===error);assert.equal(attempts,1);assert.equal(await fs.readFile(file,'utf8'),'old');assert.deepEqual(await fs.readdir(directory),['index.html']);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await fs.rm(directory,{recursive:true,force:true});}
});

test('non-Windows, other codes, other syscalls and message-only lookalikes fail on their first attempt',async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-runtime-rename-filter-')),file=join(directory,'index.html'),rename=fs.rename.bind(fs);let current:Error,attempts=0;
  try{
    await fs.writeFile(file,'old');t.mock.method(fs,'rename',async(...[from,to]:Parameters<typeof fs.rename>)=>{if(to===file){attempts++;throw current;}return rename(from,to);});syncBuiltinESMExports();
    for(const [platform,code,syscall]of [['darwin','EPERM','rename'],['linux','EPERM','rename'],['win32','EACCES','rename'],['win32','EBUSY','rename'],['win32','EPERM','unlink'],['win32','EPERM','fsync'],['win32',undefined,'rename'],['win32','EPERM',undefined]] as const){
      current=Object.assign(new Error('EPERM rename timeout text is not a retry signal'),{code,syscall});attempts=0;await assert.rejects(writeRuntimeFile(file,'new',platform),value=>value===current);assert.equal(attempts,1);assert.equal(await fs.readFile(file,'utf8'),'old');
    }
    assert.deepEqual(await fs.readdir(directory),['index.html']);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await fs.rm(directory,{recursive:true,force:true});}
});

for(const scenario of ['first_sync_eperm','rename_then_sync_eio'] as const)test(`${scenario} propagates the current fsync error immediately and never masks it with an earlier rename denial`,async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-runtime-sync-no-retry-')),file=join(directory,'index.html'),open=fs.open.bind(fs),rename=fs.rename.bind(fs),first=denied(),current=Object.assign(new Error('synthetic actual fsync failure'),{code:scenario==='first_sync_eperm'?'EPERM':'EIO',syscall:'fsync'});let writes=0,renames=0;
  try{
    await fs.writeFile(file,'old');
    t.mock.method(fs,'open',async(...[destination,flags,mode]:Parameters<typeof fs.open>)=>{const handle=await open(destination,flags,mode);if(typeof destination==='string'&&destination.startsWith(file+'.tmp-')&&flags==='wx'){writes++;if(scenario==='first_sync_eperm'||writes===2)t.mock.method(handle,'sync',async()=>{throw current;});}return handle;});
    t.mock.method(fs,'rename',async(...[from,to]:Parameters<typeof fs.rename>)=>{if(to===file){renames++;throw first;}return rename(from,to);});syncBuiltinESMExports();
    await assert.rejects(writeRuntimeFile(file,'new','win32'),error=>error===current);assert.equal(writes,scenario==='first_sync_eperm'?1:2);assert.equal(renames,scenario==='first_sync_eperm'?0:1);
    assert.equal(await fs.readFile(file,'utf8'),'old');assert.deepEqual(await fs.readdir(directory),['index.html']);assert.equal(taskFailure(current,'runtime_index_publish').syscall,'fsync');
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await fs.rm(directory,{recursive:true,force:true});}
});

test('directory fsync failure after a successful rename reports the current error without retrying or rolling back the complete index',async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-runtime-directory-sync-')),file=join(directory,'index.html'),open=fs.open.bind(fs),rename=fs.rename.bind(fs),error=Object.assign(new Error('synthetic directory sync failure'),{code:'EIO',syscall:'fsync'});let renames=0,writes=0,closed=0;
  try{
    await fs.writeFile(file,'old complete index');
    t.mock.method(fs,'open',async(...[destination,flags,mode]:Parameters<typeof fs.open>)=>{
      if(destination===directory&&flags==='r'){
        // Inject at the directory-open boundary with a real owned descriptor;
        // opening directories itself is unsupported on some Windows hosts.
        const handle=await open(file,'r'),close=handle.close.bind(handle);t.mock.method(handle,'sync',async()=>{throw error;});t.mock.method(handle,'close',async()=>{await close();closed++;});return handle;
      }
      if(typeof destination==='string'&&destination.startsWith(file+'.tmp-')&&flags==='wx')writes++;return open(destination,flags,mode);
    });
    t.mock.method(fs,'rename',async(...[from,to]:Parameters<typeof fs.rename>)=>{if(to===file)renames++;return rename(from,to);});syncBuiltinESMExports();
    await assert.rejects(writeRuntimeFile(file,'new complete index','win32'),value=>value===error);assert.equal(renames,1);assert.equal(writes,1);assert.equal(closed,1);assert.equal(await fs.readFile(file,'utf8'),'new complete index');assert.deepEqual(await fs.readdir(directory),['index.html']);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await fs.rm(directory,{recursive:true,force:true});}
});
