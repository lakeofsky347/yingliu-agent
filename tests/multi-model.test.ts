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

test('existing quick vision slot from the alternate v3 profile retains its storage and route',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'studio-model-v3-')),secrets=new Secrets();
  const priorVision={id:'custom-vision',name:'原审片接口',baseUrl:'https://vision.invalid/v1',model:'original-vision'};
  const previousKeyRef='yingliu.custom-vision.api-key';
  try{
    await writeFile(join(directory,'provider.json'),JSON.stringify({version:3,mode:'custom',vision:priorVision}));
    await secrets.set(previousKeyRef,'fixture-original-key');
    const manager=new ProviderManager(directory,secrets);
    const initial=await manager.settings();
    assert.equal(initial.config.model,'gpt-4.1-mini');
    assert.equal(initial.visionConfig?.id,priorVision.id);
    assert.equal(initial.visionConfig?.model,priorVision.model);
    assert.equal(initial.visionEnabled,true);
    assert.equal(initial.visionHasKey,true);
    assert.equal(initial.visionReady,true);
    assert.equal((await manager.registry.resolve('vision')).connection.credentialRef,previousKeyRef);
    await assert.rejects(manager.registry.bindRole('director','custom-vision-model'),/仅供视觉/);
    await assert.rejects(manager.saveVision({baseUrl:'https://other.invalid/v1'}),/更换接口域名/);

    const {route}=await manager.requireVision();
    const disabled=await manager.saveVision({enabled:false});
    assert.equal(disabled.visionEnabled,false);
    assert.equal(disabled.visionReady,false);
    assert.equal(disabled.visionHasKey,true);
    await assert.rejects(manager.analyzeImages([],'不会发送',new AbortController().signal,route),/视觉连接或角色已变化/);
    const reopened=new ProviderManager(directory,secrets);
    assert.equal((await reopened.settings()).visionEnabled,false);
    assert.equal((await reopened.saveVision({apiKey:''})).visionEnabled,false);
    assert.equal(await secrets.get(previousKeyRef),undefined);
    await reopened.saveVision({apiKey:'fixture-replacement-key'});
    const enabled=await reopened.saveVision({enabled:true});
    assert.equal(enabled.visionReady,true);
    assert.equal(enabled.visionRoute?.provider,priorVision.id);
    assert.deepEqual([...secrets.values.entries()],[[previousKeyRef,'fixture-replacement-key']]);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('persisted registry and advanced vision role govern settings over a stale v3 projection',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'studio-model-role-state-')),secrets=new Secrets();
  try{
    const manager=new ProviderManager(directory,secrets);
    await manager.initialize();
    const custom=await manager.registry.saveConnection({id:'custom-vision',baseUrl:'https://legacy.invalid/v1',apiKey:'fixture-legacy'});
    const quick=await manager.registry.saveModel({id:'custom-vision-model',connectionId:custom.id,model:'legacy-vision',inputModalities:['text','image'],parameters:{enableVision:true}});
    const advanced=await manager.registry.saveConnection({baseUrl:'https://advanced.invalid/v1',apiKey:'fixture-advanced'});
    const bound=await manager.registry.saveModel({connectionId:advanced.id,model:'advanced-vision',inputModalities:['text','image'],parameters:{enableVision:true}});
    await manager.registry.bindRole('vision',bound.id);
    await writeFile(join(directory,'provider.json'),JSON.stringify({version:3,mode:'custom',vision:{baseUrl:'file:///stale',model:'stale-vision'}}));
    const reopened=new ProviderManager(directory,secrets);
    assert.equal((await reopened.settings()).visionConfig?.baseUrl,custom.baseUrl);
    const next=await reopened.saveVision({model:'updated-fixture',enabled:false});
    assert.equal(next.visionConfig?.model,'updated-fixture');
    assert.equal(next.visionEnabled,false);
    assert.equal(next.visionReady,true);
    assert.equal(next.visionRoute?.provider,advanced.id);
    assert.equal(await secrets.get(custom.credentialRef),'fixture-legacy');
    assert.equal(await secrets.get(advanced.credentialRef),'fixture-advanced');
    await reopened.registry.removeModel(quick.id);
    await reopened.registry.removeConnection(custom.id);
    const fresh=new ProviderManager(directory,secrets);
    assert.equal((await fresh.settings()).visionConfig?.id,'vision-custom');
    assert.equal((await fresh.registry.resolve('vision')).model.id,bound.id);
  }finally{await rm(directory,{recursive:true,force:true});}
});
