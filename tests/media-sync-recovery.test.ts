import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MediaTaskService} from '../src/jobs/media-tasks.ts';
import {ModelRegistry} from '../src/models/registry.ts';
import type {MediaProjectPort,MediaTask} from '../src/jobs/contracts.ts';
import {pngFixture} from './media-gateway.ts';

async function settle(service:MediaTaskService,id:string,predicate:(task:MediaTask)=>boolean){
  for(let count=0;count<200;count++){const task=await service.get(id);if(predicate(task))return task;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error('synchronous media fixture did not settle');
}

for(const output of ['image','video'] as const)for(const format of ['binary','json-base64','json-url'] as const)for(const restart of [false,true]){
  test(`synchronous ${format} ${output} reuses its successful receipt after ${restart?'restart':'retry'} without another submission`,async()=>{
    const directory=await mkdtemp(join(tmpdir(),'yingliu-media-sync-recovery-')),values=new Map<string,string>();
    const registry=new ModelRegistry(directory,{async get(key){return values.get(key);},async set(key,value){values.set(key,value);},async delete(key){values.delete(key);}});
    const bytes=output==='image'?pngFixture:Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypmp42'),Buffer.alloc(20)]),mime=output==='image'?'image/png':'video/mp4';
    const connection=await registry.saveConnection({id:'sync',name:'test fixture',protocol:'async-task',baseUrl:'http://127.0.0.1:1',auth:'none'});
    await registry.saveModel({id:'sync-model',connectionId:connection.id,model:'fixture',outputModalities:[output],parameters:format==='binary'?{responseType:'binary',resultMime:mime}:{idPath:'',resultMime:mime}});await registry.bindRole(output,'sync-model');
    const requests:{url:string;method?:string}[]=[];let validations=0;
    const fetchMock:typeof fetch=async(input,init)=>{
      const url=String(input);requests.push({url,method:init?.method});
      if(init?.method==='POST')return format==='binary'?new Response(bytes,{headers:{'Content-Type':mime}}):Response.json({status:'succeeded',output:format==='json-url'?'http://127.0.0.1:1/result':`data:${mime};base64,${bytes.toString('base64')}`});
      assert.equal(url,'http://127.0.0.1:1/result','a synchronous result has no remote polling endpoint');return new Response(bytes,{headers:{'Content-Type':mime}});
    };
    const port:MediaProjectPort={async inspect(){return {revision:0,shotIds:[]};},async readImage(){throw new Error('unused');},async validateArtifact(file){assert.deepEqual(await readFile(file),bytes);if(++validations===1)throw new Error('fixture local validation temporarily unavailable');return {mime};},async applyResult(){throw new Error('unused');}};
    let service=new MediaTaskService(directory,registry,port,{fetch:fetchMock});
    try{
      const started=await service.generate({projectId:'fixture-project',expectedRevision:0,operation:output==='image'?'text-to-image':'text-to-video',prompt:'fixture only'});
      await settle(service,started.id,task=>task.observation==='paused'&&task.phase==='validating');
      if(restart){await service.dispose();service=new MediaTaskService(directory,registry,port,{fetch:fetchMock});await service.recover();}else await service.retry(started.id);
      const ready=await settle(service,started.id,task=>task.phase==='ready');assert.equal(ready.files.length,1);assert.equal(validations,2);assert.equal(requests.filter(request=>request.method==='POST').length,1);
      assert.equal(requests.filter(request=>request.method!=='POST').length,format==='json-url'?2:0);assert.deepEqual(await readFile(ready.files[0]!.path),bytes);
    }finally{await service.dispose();await rm(directory,{recursive:true,force:true});}
  });
}

test('a real asynchronous job refreshes expired artifact URLs using its provider job ID',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-media-async-recovery-'));
  const registry=new ModelRegistry(directory,{async get(){return undefined;},async set(){},async delete(){}});
  const connection=await registry.saveConnection({id:'async',name:'test fixture',protocol:'async-task',baseUrl:'http://127.0.0.1:1',auth:'none'});
  await registry.saveModel({id:'async-model',connectionId:connection.id,model:'fixture',outputModalities:['image']});await registry.bindRole('image','async-model');
  const requests:{url:string;method?:string}[]=[];
  const fetchMock:typeof fetch=async(input,init)=>{
    const url=String(input);requests.push({url,method:init?.method});
    if(init?.method==='POST')return Response.json({id:'provider-job-id',status:'succeeded',output:'http://127.0.0.1:1/expired'});
    if(url.endsWith('/expired'))return new Response('',{status:403});
    if(url.endsWith('/tasks/provider-job-id'))return Response.json({status:'succeeded',output:'http://127.0.0.1:1/refreshed'});
    assert.equal(url,'http://127.0.0.1:1/refreshed');return new Response(pngFixture,{headers:{'Content-Type':'image/png'}});
  };
  const port:MediaProjectPort={async inspect(){return {revision:0,shotIds:[]};},async readImage(){throw new Error('unused');},async validateArtifact(){return {};},async applyResult(){throw new Error('unused');}};
  const service=new MediaTaskService(directory,registry,port,{fetch:fetchMock});
  try{
    const task=await service.generate({projectId:'fixture-project',expectedRevision:0,operation:'text-to-image',prompt:'fixture only'});await settle(service,task.id,item=>item.observation==='paused');await service.retry(task.id);
    const ready=await settle(service,task.id,item=>item.phase==='ready');assert.equal(ready.remoteJobId,'provider-job-id');assert.equal(requests.filter(request=>request.method==='POST').length,1);assert.ok(requests.some(request=>request.url.endsWith('/tasks/provider-job-id')));
  }finally{await service.dispose();await rm(directory,{recursive:true,force:true});}
});
