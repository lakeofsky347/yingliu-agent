import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createProject } from '../src/core/index.ts';
import { DEMO_MODEL, demoSceneSource, demoStoryboard, ProviderManager } from '../src/app/model.ts';
import type { SecretStore } from '../src/app/contracts.ts';
import { OPENAI_BASE_URL, OPENAI_CHAT_MODEL, VISION_CONNECTION_ID } from '../src/models/provider-defaults.ts';
import { chatTurn } from '../src/agent/model-client.ts';
import type { AgentTool } from '../src/agent/contracts.ts';

class MemorySecrets implements SecretStore {values=new Map<string,string>();async get(ref:string){return this.values.get(ref);}async set(ref:string,value:string){this.values.set(ref,value);}async delete(ref:string){this.values.delete(ref);}}

test('fresh production settings default to OpenAI and have no fixture or active vision model',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-model-'));const secrets=new MemorySecrets();
  try{const providers=new ProviderManager(directory,secrets);await providers.initialize();let settings=await providers.settings();assert.equal(settings.mode,'custom');assert.equal(settings.config.baseUrl,OPENAI_BASE_URL);assert.equal(settings.config.model,OPENAI_CHAT_MODEL);assert.equal(settings.hasKey,false);assert.equal(settings.visionConfig?.baseUrl,OPENAI_BASE_URL);assert.equal(settings.visionReady,false);assert.equal(settings.visionRoute,undefined);
    assert.deepEqual(providers.host().listProviders().map(p=>p.id),['custom']);await assert.rejects(providers.host().listModels('demo'),/未知/);await assert.rejects(providers.save({mode:'demo'}),/仅供测试/);assert.equal((await new ProviderManager(join(directory,'fixture'),secrets,{allowFixtures:true}).host().listModels('demo'))[0]?.id,DEMO_MODEL);
    settings=await providers.save({apiKey:'fixture-secret-do-not-persist',mode:'custom',name:'我的接口'});assert.equal(settings.hasKey,true);const config=await readFile(join(directory,'provider.json'),'utf8');assert.ok(!config.includes('fixture-secret'));
    const reopened=new ProviderManager(directory,secrets);assert.equal((await reopened.settings()).config.name,'我的接口');assert.equal((await reopened.settings()).mode,'custom');
    await reopened.save({apiKey:''});assert.equal((await reopened.settings()).hasKey,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('model settings serialize concurrent partial saves and text transport always advertises text',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-settings-'));
  try{const providers=new ProviderManager(directory,new MemorySecrets());await Promise.all([providers.save({temperature:.3,name:'my custom'}),providers.save({maxTokens:1024,requestTimeoutMs:10000})]);const config=(await providers.settings()).config;assert.equal(config.name,'my custom');assert.equal(config.temperature,.3);assert.equal(config.maxTokens,1024);
    await providers.save({supportsVision:true});assert.deepEqual((await providers.host().listModels('custom'))[0]?.inputModalities,['text']);await providers.save({enableVision:true});assert.deepEqual((await providers.host().resolveModelInfo!('custom',OPENAI_CHAT_MODEL))?.inputModalities,['text']);await assert.rejects(providers.save({maxTokens:1}),/maxTokens/);await assert.rejects(providers.save({supportsVision:false}),/确认/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('offline storyboard varies by topic and returns real editable scene modules',()=>{
  const a=createProject('海边','海边散步'),b=createProject('猫','猫的午后');a.targetDuration=18;b.targetDuration=18;
  const shotsA=demoStoryboard(a),shotsB=demoStoryboard(b);assert.equal(shotsA.length,3);assert.equal(shotsA.reduce((sum,s)=>sum+s.durationFrames,0),540);
  assert.notEqual(shotsA[0]?.params.text,shotsB[0]?.params.text);assert.ok(shotsA[1]?.params.text.includes('海边散步'));
  for(let i=0;i<3;i++){const scene=demoSceneSource(i);assert.match(scene.js,/export function render\(ctx\)/);assert.match(scene.js,/ctx\.progress/);assert.match(scene.js,/params:p/);assert.ok(scene.html.length>100);}
});

test('compatible SSE consumes all text, retains full multi-turn messages and normal completion',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-stream-'));const originalFetch=globalThis.fetch;const captured:unknown[]=[];
  try{const providers=new ProviderManager(directory,new MemorySecrets());await providers.save({mode:'custom',apiKey:'fixture-only',baseUrl:'https://provider.example/v1',model:'fixture-chat'});
    globalThis.fetch=async(url,options)=>{assert.equal(String(url),'https://provider.example/v1/chat/completions');captured.push(JSON.parse(String(options?.body)));return new Response('data: {"choices":[{"delta":{"content":"{\\"ok\\":"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{"content":"true}"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
    const result=await providers.complete([{role:'user',content:'first'},{role:'assistant',content:'prior'},{role:'user',content:'second'}],'system',new AbortController().signal);
    assert.equal(result,'{"ok":true}');assert.equal((captured[0] as {messages:unknown[]}).messages.length,4);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

test('provider rejects truncated responses and never fetches without an app key',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-truncated-'));const originalFetch=globalThis.fetch;let calls=0;
  try{const providers=new ProviderManager(directory,new MemorySecrets());globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:'unfinished'},finish_reason:'length'}]});};
    await assert.rejects(providers.complete([{role:'user',content:'x'}],'system',new AbortController().signal),/API Key/);assert.equal(calls,0);
    await providers.save({apiKey:'fixture-only'});await assert.rejects(providers.complete([{role:'user',content:'x'}],'system',new AbortController().signal),/不完整/);assert.equal(calls,1);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

test('vision-only completion keeps separate credentials and enforces request text/image budgets',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-model-vision-'));let calls=0;const captured:{url:string;header:string|null;redirect?:RequestRedirect;body:Record<string,any>}[]=[];
  try{const providers=new ProviderManager(directory,new MemorySecrets(),{fetch:async(url,options)=>{calls++;captured.push({url:String(url),header:new Headers(options?.headers).get('authorization'),redirect:options?.redirect,body:JSON.parse(String(options?.body))});return Response.json({choices:[{message:{content:'完整回复'},finish_reason:'stop'}]});}});await providers.save({apiKey:'mock-key',supportsVision:true,enableVision:true,contextCharLimit:8000});
    const image={type:'image_url' as const,image_url:{url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII='}};await assert.rejects(providers.complete([{role:'user',content:[image]}],'system',new AbortController().signal),/未启用/);assert.equal(calls,0);
    const signal=new AbortController().signal;
    await assert.rejects(providers.analyzeImages([image],'本轮授权图片',signal),/多模态视觉/);
    const settings=await providers.saveVision({baseUrl:'https://vision.invalid/v1',model:'vision-model',apiKey:'vision-credential',maxVisionBytes:1024});
    assert.equal(settings.visionReady,true);assert.equal(settings.visionRoute?.provider,VISION_CONNECTION_ID);
    await assert.rejects(providers.registry.bindRole('director','vision-custom-model'),/仅供视觉/);
    await providers.analyzeImages([image],'本轮授权图片',signal);
    assert.equal(captured[0]!.body.messages[1].content[1].image_url.url,image.image_url.url);assert.equal(captured[0]!.url,'https://vision.invalid/v1/chat/completions');assert.equal(captured[0]!.header,'Bearer vision-credential');assert.equal(captured[0]!.body.max_tokens,1800);assert.equal(captured[0]!.redirect,'manual');
    await providers.complete([{role:'user',content:'文本请求'}],'system',signal);
    assert.equal(captured[1]!.url,OPENAI_BASE_URL+'/chat/completions');assert.equal(captured[1]!.header,'Bearer mock-key');assert.equal(captured[1]!.body.max_completion_tokens,7000);assert.ok(!('max_tokens' in captured[1]!.body));
    await assert.rejects(providers.complete([{role:'user',content:'x'.repeat(8001)}],'system',signal),/文本上下文/);await assert.rejects(providers.analyzeImages([image,image,image,image],'system',signal),/图片数量/);const oversized={type:'image_url' as const,image_url:{url:'data:image/png;base64,'+Buffer.alloc(1025).toString('base64')}};await assert.rejects(providers.analyzeImages([oversized],'system',signal),/总字节/);assert.equal(calls,2);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('OpenAI reasoning models use only supported Chat Completions options',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-gpt6-shape-'));
  const payloads:Record<string,unknown>[]=[];
  const fixtureFetch:typeof fetch=async(_url,options)=>{
    payloads.push(JSON.parse(String(options?.body)));
    return Response.json({choices:[{message:{content:'fixture reply'},finish_reason:'stop'}]});
  };
  const tools:AgentTool[]=[{name:'read_project',description:'Return project summary',risk:'read',parameters:{type:'object'},run:async()=>({content:'fixture summary'})}];
  const signal=new AbortController().signal;
  try{
    const provider=new ProviderManager(directory,new MemorySecrets(),{fetch:fixtureFetch});
    await provider.save({model:'gpt-6-luna',apiKey:'fixture-key'});
    await provider.complete([{role:'user',content:'fixture request'}],'fixture system',signal);
    assert.equal(payloads[0]?.max_completion_tokens,7000);
    assert.ok(!('temperature' in payloads[0]!)&&!('max_tokens' in payloads[0]!));

    const config={baseUrl:OPENAI_BASE_URL,model:'gpt-6-luna',timeoutMs:5000,temperature:.7,maxTokens:7000,supportsTools:true};
    assert.equal((await chatTurn(config,'fixture',[],tools,signal,fixtureFetch)).mode,'tools');
    assert.equal(payloads[1]?.reasoning_effort,'none');
    assert.ok(Array.isArray(payloads[1]?.tools));

    assert.equal((await chatTurn({...config,model:'gpt-6.1-terra'},'fixture',[],tools,signal,fixtureFetch)).mode,'plan-json');
    assert.equal(payloads[2]?.max_completion_tokens,7000);
    assert.ok(!('tools' in payloads[2]!)&&!('temperature' in payloads[2]!));

    await chatTurn({...config,baseUrl:'https://compatible.invalid/v1'},'fixture',[],tools,signal,fixtureFetch);
    assert.equal(payloads[3]?.max_tokens,7000);
    assert.equal(payloads[3]?.temperature,.7);
    assert.ok(!('reasoning_effort' in payloads[3]!));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('text, vision, and agent chat POSTs do not follow redirects with private payloads',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-model-redirect-'));
  let forwarded=0;
  const sink=createServer((_request,response)=>{forwarded++;response.end();}).listen(0,'127.0.0.1');
  await once(sink,'listening');
  const redirector=createServer(async(request,response)=>{
    for await(const _chunk of request){ /* drain request before redirecting */ }
    response.writeHead(307,{Location:`http://127.0.0.1:${(sink.address() as {port:number}).port}/collect`});
    response.end();
  }).listen(0,'127.0.0.1');
  await once(redirector,'listening');
  const baseUrl=`http://127.0.0.1:${(redirector.address() as {port:number}).port}/v1`;
  try{
    const provider=new ProviderManager(directory,new MemorySecrets()),signal=new AbortController().signal;
    await provider.save({baseUrl,model:'fixture-text',apiKey:'fixture-text-key'});
    await provider.saveVision({baseUrl,model:'fixture-vision',apiKey:'fixture-vision-key'});
    const image={type:'image_url' as const,image_url:{url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII='}};
    await assert.rejects(provider.complete([{role:'user',content:'synthetic private context'}],'fixture',signal),/重定向/);
    await assert.rejects(provider.analyzeImages([image],'synthetic reference',signal),/重定向/);
    await assert.rejects(chatTurn({baseUrl,model:'fixture-agent',timeoutMs:5000,maxTokens:500,supportsTools:true},'synthetic agent context',[],[],signal),/重定向/);
    assert.equal(forwarded,0);
  }finally{
    await Promise.all([sink,redirector].map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));
    await rm(directory,{recursive:true,force:true});
  }
});


test('the transport validates real image dimensions for workflow and direct vision calls',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-vision-dimension-'));let requests=0;
  try{const providers=new ProviderManager(directory,new MemorySecrets(),{fetch:async()=>{requests++;return Response.json({choices:[{message:{content:'ok'},finish_reason:'stop'}]});}});await providers.saveVision({apiKey:'synthetic-only',maxVisionDimension:64});
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=','base64');png.writeUInt32BE(65,16);
    await assert.rejects(providers.analyzeImages([{type:'image_url',image_url:{url:'data:image/png;base64,'+png.toString('base64')}}],'检查关键帧',new AbortController().signal),/像素尺寸/);assert.equal(requests,0);
    await assert.rejects(providers.analyzeImages([{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}],'检查关键帧',new AbortController().signal),/格式|尺寸/);assert.equal(requests,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
