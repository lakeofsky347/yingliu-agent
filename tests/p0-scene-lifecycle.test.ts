import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {runScene,killOwnBrowser} from '../src/sandbox/scene-worker.ts';

const skip=process.platform==='win32'?'本组验证 POSIX 自有进程组；Windows 独立执行已前置拒绝':false;
const alive=(pid:number)=>{try{process.kill(pid,0);return !spawnSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).stdout.trim().startsWith('Z');}catch{return false;}};
async function fixture(body:string){const directory=await mkdtemp(join(tmpdir(),'p0-scene-owned-')),executable=join(directory,'browser.cjs');await writeFile(executable,'#!'+process.execPath+'\n'+body);await chmod(executable,0o700);return {directory,executable};}

test('Windows 独立场景在 JobObject 未实现时前置拒绝，完全不调用 spawn',async t=>{
  let spawns=0;const mocked=t.mock.method(childProcess,'spawn',()=>{spawns++;throw new Error('不应启动浏览器');});syncBuiltinESMExports();
  try{const result=await runScene({browserPath:process.execPath,html:'fixture',timeoutMs:1000},{platform:'win32'});assert.equal(result.ok,false);assert.match(result.error??'',/SCENE_PLATFORM_UNSUPPORTED.*JobObject/);assert.equal(result.pid,undefined);assert.equal(result.timedOut,false);assert.equal(spawns,0);}
  finally{mocked.mock.restore();syncBuiltinESMExports();}
});

test('browser ownership starts at spawn and a missing DevTools line shares the total timeout',{skip},async()=>{
  const f=await fixture('setInterval(()=>{},1000);');const start=performance.now();try{
    const result=await runScene({browserPath:f.executable,html:'fixture',timeoutMs:150});assert.equal(result.ok,false);assert.equal(result.timedOut,true);assert.ok(result.pid);assert.equal(alive(result.pid!),false);assert.ok(performance.now()-start<1800,'startup must not retain the previous separate 15 second deadline');assert.ok(result.elapsedMs>=100);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});

test('an exited leader cannot leave descendants in its owned group; an unrelated child is untouched',{skip},async()=>{
  const f=await fixture("const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(__filename+'.pid',String(child.pid));process.exit(0);");
  const bystander=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  try{
    killOwnBrowser(bystander);assert.equal(alive(bystander.pid!),true,'unregistered child handles are not kill authority');
    const result=await runScene({browserPath:f.executable,html:'fixture',timeoutMs:1000});assert.equal(result.ok,false);assert.match(result.error??'',/提前退出/);const descendant=Number(await readFile(f.executable+'.pid','utf8'));
    for(let n=0;n<50&&alive(descendant);n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(alive(descendant),false,'descendant retained its original owned group even after leader exit');assert.equal(alive(bystander.pid!),true);
  }finally{bystander.kill('SIGKILL');await new Promise(resolve=>bystander.once('exit',resolve));await rm(f.directory,{recursive:true,force:true});}
});

test('spawn failure is bounded and cannot kill any unrelated PID',{skip},async()=>{
  const result=await runScene({browserPath:'/missing/synthetic/browser',html:'fixture',timeoutMs:200});assert.equal(result.ok,false);assert.match(result.error??'',/ENOENT/);assert.equal(result.pid,undefined);assert.ok(result.elapsedMs<1500);
});
