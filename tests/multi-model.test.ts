import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderManager } from '../src/app/model.ts';
import type { SecretStore } from '../src/app/contracts.ts';
class Secrets implements SecretStore {values=new Map<string,string>();async get(ref:string){return this.values.get(ref);}async set(ref:string,value:string){this.values.set(ref,value);}async delete(ref:string){this.values.delete(ref);}}

test('legacy provider settings and credential ref migrate once, preserving role bindings on restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'studio-model-migration-')),secrets=new Secrets();
  try{
    await writeFile(join(directory,'provider.json'),JSON.stringify({version:2,mode:'custom',config:{name:'旧接口',baseUrl:'https://old.invalid/v1',model:'old-chat'}}));await secrets.set('yingliu.custom-model.api-key','old-synthetic-secret');
    const manager=new ProviderManager(directory,secrets);await manager.initialize();const migrated=await manager.registry.resolve('director');assert.equal(migrated.connection.credentialRef,'yingliu.custom-model.api-key');assert.equal(migrated.model.model,'old-chat');assert.equal((await manager.settings()).hasKey,true);
    const local=await manager.registry.saveConnection({name:'新本地模型',baseUrl:'http://127.0.0.1:8001/v1',auth:'none'});const model=await manager.registry.saveModel({connectionId:local.id,model:'local-chat'});await manager.registry.bindRole('director',model.id);
    const reopened=new ProviderManager(directory,secrets);const settings=await reopened.settings();assert.equal(settings.ready,true);assert.equal(settings.hasKey,false);assert.equal(settings.route?.provider,local.id);assert.equal(settings.sceneRoute?.provider,'custom');assert.equal(settings.legacyConfig?.model,'old-chat');
    assert.ok(!(await readFile(join(directory,'model-registry.json'),'utf8')).includes('old-synthetic-secret'));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('director and scene roles use separate routes and keyless requests omit Authorization',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'studio-model-routing-')),secrets=new Secrets(),requests:{url:string;headers:Headers;body:any}[]=[];
  try{
    const manager=new ProviderManager(directory,secrets,{fetch:async(url,options)=>{requests.push({url:String(url),headers:new Headers(options?.headers),body:JSON.parse(String(options?.body))});return Response.json({choices:[{message:{content:'完整回复'},finish_reason:'stop'}]});}});
    await manager.save({apiKey:'synthetic-director-secret',baseUrl:'https://director.invalid/v1',model:'director'});
    const connection=await manager.registry.saveConnection({name:'本地场景',baseUrl:'http://127.0.0.1:8002/v1',auth:'none'}),model=await manager.registry.saveModel({connectionId:connection.id,model:'scene'});await manager.registry.bindRole('scene',model.id);
    const messages=[{role:'user' as const,content:'生成内容'}],signal=new AbortController().signal;
    await manager.complete(messages,'system',signal);await manager.complete(messages,'system',signal,1024,'scene');await manager.complete(messages,'system',signal,1024,{provider:connection.id,model:'scene'});
    assert.equal(requests[0]?.url,'https://director.invalid/v1/chat/completions');assert.equal(requests[0]?.headers.get('authorization'),'Bearer synthetic-director-secret');assert.equal(requests[1]?.url,'http://127.0.0.1:8002/v1/chat/completions');assert.equal(requests[1]?.headers.get('authorization'),null);assert.equal(requests[1]?.body.model,'scene');assert.equal(requests[2]?.body.model,'scene');
    assert.equal(manager.host().listProviders().length,2);assert.equal((await manager.host().listModels(connection.id))[0]?.id,'scene');
  }finally{await rm(directory,{recursive:true,force:true});}
});


test('deleting and recreating the legacy connection keeps its isolated credential reference',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'studio-model-recreate-')),secrets=new Secrets();
  try{const manager=new ProviderManager(directory,secrets);await manager.save({apiKey:'first-synthetic-key'});await manager.registry.removeConnection('custom');assert.equal((await manager.settings()).ready,false);await manager.save({apiKey:'replacement-synthetic-key'});const selected=await manager.registry.resolve('director');assert.equal(selected.connection.credentialRef,'yingliu.custom-model.api-key');assert.equal(await manager.registry.credential(selected.connection),'replacement-synthetic-key');assert.equal((await manager.settings()).ready,true);}
  finally{await rm(directory,{recursive:true,force:true});}
});
