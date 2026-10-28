import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {WorkflowService,type WorkflowPersistenceEvent,type WorkflowServiceOptions} from '../src/workflows/service.ts';
import {writeDurableFile} from '../src/agent/durable-file.ts';
import {createProject,defaultSceneSource} from '../src/core/index.ts';
import type {Asset,StudioSnapshot,VideoProject} from '../src/shared/types.ts';
import type {WorkflowPort,WorkflowRequest} from '../src/workflows/contracts.ts';
import type {MediaTaskService} from '../src/jobs/media-tasks.ts';
import type {MediaRequest,MediaTask} from '../src/jobs/contracts.ts';

const clone=<T>(value:T):T=>structuredClone(value);
const ioError=()=>Object.assign(new Error('隔离持久化故障 EIO（非实机断电）'),{code:'EIO'});
async function until<T>(read:()=>Promise<T>,check:(value:T)=>boolean){for(let count=0;count<600;count++){const value=await read();if(check(value))return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('durability fixture did not settle');}

async function fixture(t:TestContext){
  const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-workflow-durability-'));let project=createProject('回执耐久性隔离工程');project.shots=project.shots.slice(0,1);project.shotOrder=project.shots.map(shot=>shot.id);
  let inject:WorkflowServiceOptions['onPersistPhase'];const events:WorkflowPersistenceEvent[]=[],calls={director:0,scene:0,vision:0,voice:0,commit:0,media:0,ack:0};
  const hooks={voice:undefined as undefined|(()=>Promise<void>),scene:undefined as undefined|(()=>void),textOutput:undefined as undefined|((role:'director'|'scene'|'vision')=>string|undefined),loseCommitResponse:false,frame:'fixture frame'};
  const tasks=new Map<string,MediaTask>(),stable=new Map<string,string>();
  const media={
    async generate(input:MediaRequest){const previous=stable.get(input.clientRequestId!);if(previous)return clone(tasks.get(previous)!);const id='media-'+(++calls.media),now=new Date().toISOString();
      const task={version:1,id,projectId:project.id,shotId:input.shotId,clientRequestId:input.clientRequestId,startRevision:input.expectedRevision,operation:input.operation,prompt:input.prompt,imageAssetIds:[],inputHashes:[],phase:'ready',observation:'paused',progress:1,message:'fixture',createdAt:now,updatedAt:now,files:[],connection:{id:'fixture',model:'fixture'},model:{model:'fixture'}} as unknown as MediaTask;
      tasks.set(id,task);stable.set(input.clientRequestId!,id);return clone(task);},
    async get(id:string){return clone(tasks.get(id)!);},async retry(id:string){return clone(tasks.get(id)!);},async prepare(){return [];},
    async apply(id:string){calls.ack++;const task=tasks.get(id)!;task.phase='complete';return clone(task);},
  } as unknown as MediaTaskService;
  const snapshot=()=>({project:clone(project),root:directory,task:null,previewUrl:null,previewRevision:null,providers:[],recent:[],environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:false,ffmpegAvailable:false,ffprobeAvailable:false}} satisfies StudioSnapshot);
  const audio:Asset={id:'voice-fixture',kind:'audio',name:'隔离配音素材',description:'not real provider acceptance',path:'assets/voice-fixture.wav',duration:1,mime:'audio/wav'};
  const port:WorkflowPort={
    async snapshot(){return snapshot();},async source(){return defaultSceneSource();},
    async text(role){calls[role]++;const override=hooks.textOutput?.(role);if(override!==undefined)return override;if(role==='director')return JSON.stringify({shots:project.shots.map(shot=>({shotId:shot.id,prompt:'隔离画面',narration:'隔离旁白'}))});if(role==='vision')return '仅检查所提供的fixture帧';hooks.scene?.();return JSON.stringify({...defaultSceneSource(),html:'<main>隔离源码</main>'});},
    async voice(){calls.voice++;await hooks.voice?.();return clone(audio);},
    async stageMedia(_id,task){return [{id:'asset-'+task.id,kind:'image',name:'fixture image',description:'fixture',path:'assets/'+task.id+'.png',mime:'image/png'}];},
    async capture(){const bytes=Buffer.from(hooks.frame);return {bytes,mime:'image/png',sha256:createHash('sha256').update(bytes).digest('hex')};},
    async commit(_id,expectedRevision,next){if(project.revision!==expectedRevision)throw Object.assign(new Error('fixture revision conflict'),{code:'REVISION_CONFLICT'});calls.commit++;project=clone(next);project.revision=expectedRevision+1;if(hooks.loseCommitResponse){hooks.loseCommitResponse=false;throw new Error('fixture response lost after project commit');}return snapshot();},
  };
  const options:WorkflowServiceOptions={onPersistPhase:async event=>{events.push(clone(event));await inject?.(event);}};
  let service=new WorkflowService(directory,media,port,options);const services=[service];
  t.after(async()=>{for(const item of services)await item.dispose();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,calls,hooks,events,set inject(value:WorkflowServiceOptions['onPersistPhase']){inject=value;},get service(){return service;},get project(){return clone(project);},set project(value:VideoProject){project=clone(value);},
    request(patch:Partial<WorkflowRequest>={}):WorkflowRequest{return {projectId:project.id,expectedRevision:project.revision,prompt:'隔离回执验收',visual:'code',narration:false,review:false,allowImageUpload:false,...patch};},
    async settled(id:string){return until(()=>service.get(id),record=>record.status!=='running');},
    async restart(){await service.dispose();inject=undefined;service=new WorkflowService(directory,media,port,options);services.push(service);},
    file(id:string){return join(directory,'workflows',id+'.json');},
  };
}

for(const phase of ['before-write','after-write'] as const){
  test(`创建记录 ${phase} 注入失败会传播错误，且不调用模型或留下假运行`,async t=>{
    const f=await fixture(t);f.inject=event=>{if(event.checkpoint==='created'&&event.phase===phase)throw ioError();};
    await assert.rejects(f.service.run(f.request()),{code:'EIO'});assert.equal(f.calls.director,0);assert.equal(f.calls.voice,0);
    const records=await f.service.list();assert.equal(records.length,1);assert.equal(records[0].status,'failed');await f.restart();assert.equal((await f.service.get(records[0].id)).status,'failed');
    await f.service.retry(records[0].id);assert.equal((await f.settled(records[0].id)).status,'complete');assert.equal(f.calls.director,1);
  });
  test(`配音提交标记 ${phase} 注入失败时没有收费提交，修复后可重试`,async t=>{
    const f=await fixture(t);let failed=false;f.inject=event=>{if(!failed&&event.checkpoint==='speech-submission'&&event.phase===phase){failed=true;throw ioError();}};
    const started=await f.service.run(f.request({narration:true}));const failedRun=await f.settled(started.id);assert.equal(failedRun.status,'failed');assert.equal(f.calls.voice,0);assert.equal(failedRun.steps.find(step=>step.kind==='speech')?.submissionUncertain,false);
    await f.restart();await f.service.retry(started.id);assert.equal((await f.settled(started.id)).status,'complete');assert.equal(f.calls.voice,1);
  });
}

for(const role of ['director','scene','vision'] as const){
  test(`${role} 成功回执先于主记录保存，主记录持续故障后重启不重复模型请求`,async t=>{
    const f=await fixture(t);let blockRecords=false;
    f.inject=event=>{if(event.checkpoint==='success-receipt'&&event.phase==='after-write'&&event.successKind==='text'&&event.record.steps.some(step=>step.id===event.stepId&&step.modelCalls?.some(call=>call.role===role&&call.status==='complete')))blockRecords=true;
      if(blockRecords&&event.phase==='before-write'&&event.checkpoint!=='success-receipt')throw ioError();};
    const started=await f.service.run(f.request({review:role==='vision',allowImageUpload:role==='vision'}));assert.equal((await f.settled(started.id)).status,'failed');assert.equal(f.calls[role],1);
    await f.restart();await f.service.retry(started.id);const done=await f.settled(started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls[role],1);assert.equal(f.calls.commit,1);assert.equal((done as unknown as {successes?:unknown}).successes,undefined);assert.ok(done.steps.flatMap(step=>step.modelCalls??[]).every(call=>call.status!=='running'),'restored calls keep one stable identity and cannot remain falsely running');
  });
}

for(const role of ['director','scene'] as const){
  test(`${role} 的无效输出不作为成功回执缓存，重启后可重新请求修复`,async t=>{
    const f=await fixture(t);f.hooks.textOutput=selected=>selected===role?(role==='director'?'{"shots":[]}':'{"html":"missing css and js"}'):undefined;
    const started=await f.service.run(f.request());assert.equal((await f.settled(started.id)).status,'failed');assert.equal(f.calls[role],1);
    f.hooks.textOutput=undefined;await f.restart();await f.service.retry(started.id);const done=await f.settled(started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls[role],2);assert.equal(f.calls.commit,1);
  });
}

test('配音成功独立回执保留素材；主记录持续失败并重启后仍只提交一次',async t=>{
  const f=await fixture(t);let blockRecords=false;
  f.hooks.voice=async()=>{await until(()=>f.service.list(),records=>records[0]?.steps.some(step=>step.kind==='code'&&step.status==='complete')??false);};
  f.inject=event=>{if(event.checkpoint==='success-receipt'&&event.phase==='after-write'&&event.successKind==='speech')blockRecords=true;if(blockRecords&&event.phase==='before-write'&&event.checkpoint!=='success-receipt')throw ioError();};
  const started=await f.service.run(f.request({narration:true}));assert.equal((await f.settled(started.id)).status,'failed');assert.equal(f.calls.voice,1);assert.equal(f.calls.commit,0);
  const old=JSON.parse(await fs.readFile(f.file(started.id),'utf8'));assert.equal(old.steps.find((step:{kind:string})=>step.kind==='speech').submissionUncertain,true);
  await f.restart();await f.service.retry(started.id);const done=await f.settled(started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls.voice,1);assert.equal(f.calls.scene,1);assert.equal(f.project.audioClips?.length,1);assert.equal(f.project.assets.filter(asset=>asset.kind==='audio').length,1);
});

for(const kind of ['text','speech'] as const)for(const phase of ['before-write','after-write'] as const){
  test(`${kind} 成功回执 ${phase} 故障时，后续主记录保留已知成功结果供重启恢复`,async t=>{
    const f=await fixture(t);let failed=false;f.inject=event=>{if(!failed&&event.checkpoint==='success-receipt'&&event.successKind===kind&&event.phase===phase){failed=true;throw ioError();}};
    const started=await f.service.run(f.request({narration:kind==='speech'}));assert.equal((await f.settled(started.id)).status,'failed');assert.equal(f.calls[kind==='speech'?'voice':'director'],1);
    await f.restart();await f.service.retry(started.id);const done=await f.settled(started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls[kind==='speech'?'voice':'director'],1);if(kind==='speech')assert.equal(f.project.audioClips?.length,1);
  });
}

test('已发出但没有成功回执的配音在故障重启后保持 uncertain，禁止自动重复收费',async t=>{
  const f=await fixture(t);f.hooks.voice=async()=>{throw new Error('fixture response lost after provider acceptance');};
  const started=await f.service.run(f.request({narration:true}));assert.equal((await f.settled(started.id)).steps.find(step=>step.kind==='speech')?.submissionUncertain,true);await f.restart();await f.service.retry(started.id);
  const done=await f.settled(started.id);assert.equal(done.status,'failed');assert.match(done.error??'',/结果待确认/);assert.equal(f.calls.voice,1);assert.equal(f.calls.commit,0);
});

for(const checkpoint of ['candidate','before-commit','after-commit'] as const)for(const phase of ['before-write','after-write'] as const){
  test(`${checkpoint} ${phase} 注入后重启按工程提交回执对账，不重复生成/采纳`,async t=>{
    const f=await fixture(t);let failed=false;f.inject=event=>{if(!failed&&event.checkpoint===checkpoint&&event.phase===phase){failed=true;throw ioError();}};
    const started=await f.service.run(f.request({visual:'image',review:true,allowImageUpload:true}));assert.equal((await f.settled(started.id)).status,'failed');assert.equal(f.calls.media,1);assert.equal(f.calls.commit,checkpoint==='after-commit'?1:0);
    await f.restart();await f.service.retry(started.id);const done=await f.settled(started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls.media,1);assert.equal(f.calls.commit,1);assert.equal(f.calls.ack,1);assert.equal(f.project.assets.length,1);assert.equal(f.project.revision,1);
  });
}

test('工程提交成功后回包丢失与主记录失败，重启以 workflowApplications 确认已采用',async t=>{
  const f=await fixture(t);let block=false;f.hooks.loseCommitResponse=true;
  f.inject=event=>{if(event.checkpoint==='before-commit'&&event.phase==='after-write')block=true;if(block&&event.phase==='before-write'&&event.checkpoint==='record')throw ioError();};
  const started=await f.service.run(f.request({visual:'image'}));assert.equal((await f.settled(started.id)).status,'failed');assert.equal(f.calls.commit,1);await f.restart();await f.service.retry(started.id);
  const done=await f.settled(started.id);assert.equal(done.status,'complete',done.error);assert.equal(done.committedRevision,1);assert.equal(f.calls.media,1);assert.equal(f.calls.commit,1);assert.equal(f.calls.ack,1);
});

test('显式采用新版本的候选在提交前故障，重启保留 adoptionRevision 和已完成产物',async t=>{
  const f=await fixture(t);let edited=false;f.hooks.scene=()=>{if(!edited){edited=true;f.project={...f.project,title:'用户的新标题',revision:1};}};
  const started=await f.service.run(f.request());assert.equal((await f.settled(started.id)).status,'awaiting-apply');let failed=false;
  f.inject=event=>{if(!failed&&event.checkpoint==='before-commit'&&event.phase==='before-write'){failed=true;throw ioError();}};
  await f.service.apply(started.id,1);assert.equal((await f.settled(started.id)).status,'failed');await f.restart();await f.service.retry(started.id);const done=await f.settled(started.id);
  assert.equal(done.status,'complete',done.error);assert.equal(f.project.title,'用户的新标题');assert.equal(f.project.revision,2);assert.equal(f.calls.director,1);assert.equal(f.calls.scene,1);assert.equal(f.calls.commit,1);
});

test('损坏的独立成功回执保留原字节并停止，避免把损坏当缺失而重复调用',async t=>{
  const f=await fixture(t);let block=false;f.inject=event=>{if(event.checkpoint==='success-receipt'&&event.phase==='after-write')block=true;if(block&&event.phase==='before-write'&&event.checkpoint!=='success-receipt')throw ioError();};
  const started=await f.service.run(f.request());await f.settled(started.id);const folder=join(f.directory,'workflows','receipts',started.id),file=join(folder,(await fs.readdir(folder))[0]);await fs.writeFile(file,'{broken receipt');
  await f.restart();await f.service.retry(started.id);const done=await f.settled(started.id);assert.equal(done.status,'failed');assert.match(done.error??'',/成功回执无法读取/);assert.equal(f.calls.director,1);assert.equal(await fs.readFile(file,'utf8'),'{broken receipt');
});

for(const fault of ['file-sync','rename','directory-sync'] as const){
  test(`durable writer 的 ${fault} 系统调用故障会传播；前序快照/提交后新字节可判定`,async t=>{
    const directory=await fs.mkdtemp(join(tmpdir(),'yingliu-workflow-fsync-')),file=join(directory,'checkpoint.json');await fs.writeFile(file,'old');
    const open=fs.open,rename=fs.rename,order:string[]=[];
    const openMock=t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
      const name=String(args[0]);
      // Inject a supported directory handle even on hosts where native directory
      // fsync is unavailable. This tests error propagation, not platform support.
      if(name===directory&&fault==='directory-sync')return {sync:async()=>{order.push('directory-sync');throw ioError();},close:async()=>{}} as unknown as Awaited<ReturnType<typeof fs.open>>;
      const handle=await open(...args);if(!name.startsWith(directory))return handle;
      const directoryHandle=name===directory;
      return {writeFile:handle.writeFile.bind(handle),close:handle.close.bind(handle),sync:async()=>{order.push(directoryHandle?'directory-sync':'file-sync');if((directoryHandle&&fault==='directory-sync')||(!directoryHandle&&fault==='file-sync'))throw ioError();await handle.sync();}} as typeof handle;
    });
    const renameMock=t.mock.method(fs,'rename',async(...args:Parameters<typeof fs.rename>)=>{if(String(args[1])===file){order.push('rename');if(fault==='rename')throw ioError();}await rename(...args);});syncBuiltinESMExports();
    try{
      await assert.rejects(writeDurableFile(file,'new'),{code:'EIO'});assert.equal(await fs.readFile(file,'utf8'),fault==='directory-sync'?'new':'old');assert.deepEqual(await fs.readdir(directory),['checkpoint.json']);
      assert.deepEqual(order,fault==='file-sync'?['file-sync']:fault==='rename'?['file-sync','rename']:['file-sync','rename','directory-sync']);
    }finally{openMock.mock.restore();renameMock.mock.restore();syncBuiltinESMExports();await fs.rm(directory,{recursive:true,force:true});}
  });
}
