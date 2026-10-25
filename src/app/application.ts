import { fetch } from '../host/http.ts';
import { resolve } from 'node:path';
import { AppBackend } from './backend.ts';
import { ProviderManager } from './model.ts';
import { ConversationService } from './conversation.ts';
import type { RpcResult } from '../shared/types.ts';
import type { ChatInput, SecretStore } from './contracts.ts';
import { foundationPacks } from './packs.ts';
import { applicationHealth } from './health.ts';
import { exportProjectArchive, importProjectArchive } from './archive.ts';
import { sendOutcome, submissionOf, withSubmission } from '../agent/submission.ts';
import { MediaTaskService } from '../jobs/media-tasks.ts';
import type { MediaRequest } from '../jobs/contracts.ts';
import type { RemoteJob } from '../jobs/contracts.ts';
import type { ConnectionInput, ModelInput, ModelRole } from '../models/contracts.ts';
import { WorkflowService } from '../workflows/service.ts';
import type { WorkflowRequest, WorkflowPort } from '../workflows/contracts.ts';
import { AgentService } from '../agent/service.ts';
import type { AgentPort, AgentStartInput } from '../agent/contracts.ts';
import { redactKey } from '../agent/model-client.ts';
import type { GenRole } from '../agent/contracts.ts';
import { ROLE_OUTPUT, ROLE_PROTOCOLS } from '../models/contracts.ts';
import { pollTemplate, submitTemplate } from '../models/adapters/template.ts';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { writeDurableFile } from '../agent/durable-file.ts';

export const ENDPOINTS=new Set(['catalog','current','create','open','save','import','source','saveSource','restoreSource','preview','generate','export','cancel','environment','reveal','apply','inspect','list','focus','audio','tts','history','undo','redo','rename','duplicate','archive','tasks','retry','packs.list','app.health','app.exportProject','app.importProject','providers.get','providers.save','providers.check','chat.history','chat.send','chat.cancel']);
for(const endpoint of ['models.list','models.connection.save','models.connection.remove','models.model.save','models.model.remove','models.role.bind','models.check','media.generate','media.list','media.get','media.retry','media.pause','media.cancel','media.apply','video.clip.save','video.clip.remove','video.clip.extract'])ENDPOINTS.add(endpoint);
for(const endpoint of ['workflows.run','workflows.list','workflows.get','workflows.retry','workflows.pause','workflows.apply'])ENDPOINTS.add(endpoint);
for(const endpoint of ['agent.start','agent.list','agent.get','agent.trace','agent.approve','agent.reject','agent.resume','agent.pause','agent.cancel','agent.tools','agent.capabilities','story.get','story.save','agent.qc','agent.qc.last','agent.ledger','agent.budget.set'])ENDPOINTS.add(endpoint);
export class MemorySecrets implements SecretStore {
  private values=new Map<string,string>();
  async get(ref:string){return this.values.get(ref);}
  async set(ref:string,value:string){this.values.set(ref,value);}
  async delete(ref:string){this.values.delete(ref);}
}
export async function createApplication(options:{dataDirectory:string;projectsDirectory?:string;credentials:SecretStore;reveal?:(path:string)=>Promise<void>;fetch?:typeof fetch;recover?:boolean;resumeRemoteTasks?:boolean}){
  const dataDirectory=resolve(options.dataDirectory);
  const providers=new ProviderManager(dataDirectory,options.credentials,options.fetch?{fetch:options.fetch}:{});await providers.initialize();
  const backend=new AppBackend({...options,dataDirectory,providers:providers.host()});
  const conversation=new ConversationService(backend,providers,dataDirectory);
  await backend.call('catalog');
  const media=new MediaTaskService(dataDirectory,providers.registry,backend.mediaPort(),{fetch:options.fetch,resumeExistingTasks:options.recover!==false&&options.resumeRemoteTasks!==false});
  if(options.recover!==false&&options.resumeRemoteTasks!==false)await media.recover();
  const workflowPort:WorkflowPort={
    snapshot:id=>backend.call('current',{projectId:id}),source:(id,shotId)=>backend.call('source',{projectId:id,shotId}),
    commit:(id,expectedRevision,project,sources,label)=>backend.call('apply',{projectId:id,expectedRevision,project,sources:Object.entries(sources).map(([shotId,source])=>({shotId,source})),label}),
    stageMedia:(id,task,files,signal)=>backend.stageWorkflowMedia(id,task,files,signal),
    capture:(id,frame,signal,candidate)=>backend.workflowCapture(id,frame,signal,candidate),
    text:async(role,prompt,signal,_request,images)=>providers.complete([{role:'user',content:images?.length?[{type:'text',text:prompt},...images.map(image=>({type:'image_url' as const,image_url:{url:`data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`}}))]:prompt}],'你是视频制作团队的'+role+'。只依据提供的工程和实际图像执行任务。',signal,undefined,role),
    voice:async(id,shotId,text,signal)=>{
      const state=providers.registry.snapshot();if(!state.roles.some(binding=>binding.role==='speech'))return backend.workflowVoice(id,shotId,text,signal);
      let release:(()=>void)|undefined;
      try{
        const {selected,key}=await (async()=>{const selected=await providers.registry.resolve('speech');release=providers.registry.acquire(selected.connection.id,selected.model.id);const key=await providers.registry.credential(selected.connection);return {selected,key};})().catch(error=>{throw Object.assign(error instanceof Error?error:new Error(String(error)),{submissionUncertain:false});});
        return await backend.workflowVoice(id,shotId,text,signal,{endpoint:selected.connection.baseUrl,model:selected.model.model,voice:String(selected.model.parameters.voice??'alloy'),speed:Number(selected.model.parameters.speed??1),enabled:true,requestTimeoutMs:selected.connection.requestTimeoutMs,...(key?{apiKey:key}:{})});
      }finally{release?.();}
    },
  };
  const workflows=new WorkflowService(dataDirectory,media,workflowPort);
  async function knownKeys():Promise<string[]>{const keys:string[]=[];for(const connection of providers.registry.snapshot().connections){try{const key=await providers.registry.credential(connection);if(key)keys.push(key);}catch{}}return keys;}
  /** F05: synthesize, then register the asset in the project (CAS commit) so the returned assetId is usable. Idempotent per requestId. */
  async function agentVoice(id:string,shotId:string,text:string,signal:AbortSignal,options:{expectedRevision?:number;requestId?:string}={}):Promise<{id:string;name:string;revision?:number}>{
    const ledgerKey='agentVoice';
    const before=(await backend.call('current',{projectId:id})).project;if(!before)throw new Error('工程不存在或未打开');
    const done=options.requestId?((before.extensions[ledgerKey]??{}) as Record<string,{assetId:string}>)[options.requestId]:undefined;
    if(done){const asset=before.assets.find(item=>item.id===done.assetId);if(asset)return {id:asset.id,name:asset.name,revision:before.revision};}
    if(options.expectedRevision!==undefined&&options.expectedRevision!==before.revision)throw withSubmission(Object.assign(new Error('工程版本已变化（当前 '+before.revision+'），没有提交配音'),{code:'REVISION_CONFLICT'}),'preflight_failed');
    if(!before.shots.some(item=>item.id===shotId))throw withSubmission(new Error('配音目标镜头不存在'),'preflight_failed');
    const asset=await workflowPort.voice(id,shotId,text,signal).catch(error=>{throw withSubmission(error,(error as {submissionUncertain?:unknown})?.submissionUncertain===false?'preflight_failed':signal.aborted?'unknown':sendOutcome(error));});
    for(let attempt=0;;attempt++){
      const latest=(await backend.call('current',{projectId:id})).project!;const next=structuredClone(latest);
      if(!next.assets.some(item=>item.id===asset.id))next.assets.push(asset);
      if(options.requestId)next.extensions={...next.extensions,[ledgerKey]:{...((next.extensions[ledgerKey]??{}) as object),[options.requestId]:{assetId:asset.id}}};
      try{const committed=await workflowPort.commit(id,latest.revision,next,{},'智能体：登记配音素材');return {id:asset.id,name:asset.name,revision:committed.project?.revision};}
      catch(error){if(attempt>=2||!/版本|revision/i.test(error instanceof Error?error.message:'')){const failure=error instanceof Error?error:new Error(String(error));failure.message='配音已生成（可能已计费）但登记进工程失败：'+failure.message;throw withSubmission(failure,'unknown');}}
    }
  }
  const agentPort:AgentPort={
    snapshot:id=>backend.call('current',{projectId:id}),
    readSource:(id,shotId)=>backend.call('source',{projectId:id,shotId}),
    saveSource:(id,shotId,expectedRevision,source)=>backend.call('saveSource',{projectId:id,shotId,expectedRevision,source}),
    commit:(id,expectedRevision,project,sources,label)=>workflowPort.commit(id,expectedRevision,project,sources,label),
    route:(endpoint,payload)=>route(endpoint,payload) as ReturnType<AgentPort['route']>,
    capture:async(id,frame,signal)=>{const shot=await backend.workflowCapture(id,frame,signal) as unknown as {bytes?:Uint8Array;buffer?:Uint8Array;mime?:string;frame?:number;shotId:string};return {bytes:shot.bytes??shot.buffer??new Uint8Array(),mime:shot.mime??'image/png',frame:shot.frame??frame,shotId:shot.shotId??''};},
    voice:(id,shotId,text,signal,options)=>agentVoice(id,shotId,text,signal,options),
    capabilities:async()=>{
      const state=providers.registry.snapshot(),roles:GenRole[]=[],models:Partial<Record<GenRole,string>>={};
      for(const binding of state.roles){const model=state.models.find(m=>m.id===binding.modelId),connection=state.connections.find(c=>c.id===model?.connectionId);
        if(!model?.enabled||!connection?.enabled||!ROLE_PROTOCOLS[binding.role].includes(connection.protocol)||!model.outputModalities.includes(ROLE_OUTPUT[binding.role]))continue;
        if(['image','video','speech','music','sfx','vision'].includes(binding.role)){roles.push(binding.role as GenRole);models[binding.role as GenRole]=model.name;}}
      if(!roles.includes('speech')){try{const snapshot=await backend.call('current');if(snapshot.ttsConfigured&&snapshot.tts?.enabled){roles.push('speech');models.speech='应用内配音设置';}}catch{}}
      let director:string|undefined;try{director=(await providers.registry.resolve('director')).model.name;}catch{}
      return {roles,models,...(director?{director}:{})};
    },
    importImage:async(id,name,bytes,mime)=>{if(!/^image\/(png|jpeg|webp)$/.test(mime))throw new Error('不支持的图片格式');const snapshot=await backend.call('import',{projectId:id,name,description:'智能体截取的尾帧',mime,dataBase64:`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`});const asset=snapshot.project?.assets.at(-1);if(!asset)throw new Error('图片导入失败');return {id:asset.id,name:asset.name};},
    importAudio:async(id,name,bytes,mime)=>{const snapshot=await backend.call('import',{projectId:id,name,description:'智能体本地合成',mime,dataBase64:`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`});const asset=snapshot.project?.assets.at(-1);if(!asset)throw new Error('音频导入失败');return {id:asset.id,name:asset.name};},
    generateAudio:async(id,role,prompt,{durationSeconds,signal,shotId})=>{
      const resolved=await providers.registry.resolve(role);
      if(role==='speech'&&resolved.connection.protocol==='speech'){const project=(await backend.call('current',{projectId:id})).project;const shot=shotId??project?.shotOrder[0];if(!shot||!project?.shots.some(item=>item.id===shot))throw new Error('配音目标镜头不存在');const asset=await agentVoice(id,shot,prompt,signal,{});return {id:asset.id,name:asset.name,cost:null};}
      if(resolved.connection.protocol!=='async-task')throw new Error('该角色的模型协议不支持音频生成');
      const release=providers.registry.acquire(resolved.connection.id,resolved.model.id);
      // PR1-R04: everything after the provider accepted the job (poll, download, import, asset registration) runs against a durable
      // receipt keyed by the logical request. A repeat of the same request resumes from the receipt (re-poll / re-import) and never
      // submits a new paid job; the receipt is removed only once the asset is registered or the provider definitively failed.
      const receipts=join(dataDirectory,'agent-receipts'),key=createHash('sha256').update([id,role,resolved.connection.id,resolved.model.id,prompt,String(durationSeconds??'')].join('\0')).digest('hex').slice(0,40);
      const receiptFile=join(receipts,key+'.json'),artifactFile=join(receipts,key+'.bin');
      type Receipt={stage:'accepted'|'downloaded';jobId?:string;result?:RemoteJob;mime?:string;cost:number|null;at:string};
      const writeAtomic=async(file:string,data:string|Uint8Array)=>writeDurableFile(file,data);
      const saveReceipt=(value:Receipt)=>writeAtomic(receiptFile,JSON.stringify(value));
      const dropReceipt=async()=>{await rm(receiptFile,{force:true});await rm(artifactFile,{force:true});};
      let receipt:Receipt|undefined;
      try{receipt=JSON.parse(await readFile(receiptFile,'utf8')) as Receipt;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw withSubmission(new Error('收费请求回执无法读取，已停止以免重复提交：'+(error instanceof Error?error.message:String(error))),'unknown');}
      try{
        const context={connection:resolved.connection,key:await providers.registry.credential(resolved.connection),signal,fetch:options.fetch};
        let bytes:Uint8Array|undefined,mime='audio/mpeg';let cost:number|null=receipt?.cost??null;let jobId=receipt?.jobId;
        if(!receipt){
          const result=await submitTemplate(context,{clientRequestId:randomUUID(),model:resolved.model,prompt,duration:durationSeconds,parameters:{}},'audio').catch(error=>{throw withSubmission(error,submissionOf(error)??(signal.aborted?'unknown':sendOutcome(error)));});
          try{
            if('kind' in result){bytes=result.bytes;mime=result.mimeType;await writeAtomic(artifactFile,bytes);receipt={stage:'downloaded',mime,cost:null,at:new Date().toISOString()};}
            else{jobId=result.jobId;receipt={stage:'accepted',jobId,result,cost:typeof result.usage?.cost==='number'?result.usage.cost:null,at:new Date().toISOString()};}
            await saveReceipt(receipt);
          }catch(error){throw withSubmission(error,'unknown',jobId);}
        }
        try{
          if(receipt.stage==='accepted'){
            const configuredWait=Number(resolved.model.parameters.maxWaitMs),deadline=Date.now()+(Number.isFinite(configuredWait)&&configuredWait>=1000?Math.min(configuredWait,3_600_000):Math.max(60000,resolved.connection.requestTimeoutMs*6));
            // JSON providers may finish synchronously (idPath=''). Keep that response, including artifacts and cost.
            let result=receipt.result??await pollTemplate(context,resolved.model,jobId!,'audio');
            while(result.status==='queued'||result.status==='running'){if(Date.now()>deadline)throw withSubmission(new Error('音频生成等待超时；云端任务可能仍在执行（任务 '+jobId+'）'),'unknown',jobId);await new Promise(r=>setTimeout(r,Number(resolved.model.parameters.pollIntervalMs)||2000));signal.throwIfAborted();result=await pollTemplate(context,resolved.model,jobId!,'audio');}
            if(result.status==='failed'||result.status==='cancelled'){await dropReceipt();throw withSubmission(new Error('音频生成失败：'+(result.error??result.status)),'failed',jobId);}
            if(result.status!=='succeeded'||!result.artifacts?.length)throw withSubmission(new Error('音频生成失败：'+(result.error??result.status)),'unknown',jobId);
            cost=typeof result.usage?.cost==='number'?result.usage.cost:null;const artifact=result.artifacts[0];
            if(artifact.base64){bytes=Buffer.from(artifact.base64,'base64');mime=artifact.mimeType;}
            else{const url=new URL(artifact.url!);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new Error('音频产物地址须为 HTTPS');
              const response=await (options.fetch??fetch)(url.href,{signal});if(!response.ok)throw new Error('下载音频失败（HTTP '+response.status+'）');const buffer=new Uint8Array(await response.arrayBuffer());if(!buffer.length||buffer.length>64*1024*1024)throw new Error('音频为空或超过 64 MiB');bytes=buffer;mime=(response.headers.get('content-type')?.split(';')[0]||artifact.mimeType);}
            await writeAtomic(artifactFile,bytes);receipt={...receipt,stage:'downloaded',mime,cost};await saveReceipt(receipt);
          }
          bytes??=new Uint8Array(await readFile(artifactFile));mime=receipt.mime??mime;
        }catch(error){throw (error as {submission?:unknown})?.submission?error:withSubmission(error,'unknown',jobId);}
        if(!mime.startsWith('audio/'))mime='audio/mpeg';
        let lastError:unknown;
        for(let attempt=0;attempt<3;attempt++){
          try{
            const snapshot=await backend.call('import',{projectId:id,name:(role==='music'?'音乐 · ':role==='sfx'?'音效 · ':'配音 · ')+prompt.slice(0,24),description:'由 '+resolved.model.name+' 生成',mime,dataBase64:`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`});
            const asset=snapshot.project?.assets.at(-1);if(!asset)throw new Error('音频导入失败');
            await dropReceipt().catch(()=>{});return {id:asset.id,name:asset.name,cost};
          }catch(error){lastError=error;if(signal.aborted)break;await new Promise(r=>setTimeout(r,50*(attempt+1)));}
        }
        const failure=new Error('音频已生成（可能已计费）并已保存回执，但登记进工程失败：'+(lastError instanceof Error?lastError.message:String(lastError))+'。再次发起相同请求会重试本地登记，不会重新提交');
        throw withSubmission(failure,'unknown',jobId);
      }finally{release();}
    },
    vision:async(prompt,images,signal)=>{await providers.registry.resolve('vision');return workflowPort.text('vision',prompt,signal,{} as WorkflowRequest,images);},
  };
  const agentArchive={export:(projectId:string)=>agent.exportDocs(projectId),import:(projectId:string,docs:Partial<Record<'story'|'ledger'|'qc',unknown>>)=>agent.importDocs(projectId,docs),validate:(docs:Partial<Record<'story'|'ledger'|'qc',unknown>>)=>agent.validateDocs(docs)};
  const agent=new AgentService(join(dataDirectory,'agent-runs'),agentPort,{
    fetch:options.fetch,dataDirectory:join(dataDirectory,'agent-data'),...(options.recover===false?{recover:false}:{}),
    redact:async text=>{let value=text;for(const key of await knownKeys())value=redactKey(value,key);return value;},
    resolveModel:async()=>{
      const resolved=await providers.registry.resolve('director'),parameters=resolved.model.parameters as Record<string,unknown>;
      let vision=false;try{await providers.registry.resolve('vision');vision=true;}catch{}
      return {connectionId:resolved.connection.id,parameters,vision:vision||resolved.model.inputModalities.includes('image'),config:{baseUrl:resolved.connection.baseUrl,model:resolved.model.model,key:await providers.registry.credential(resolved.connection),
        timeoutMs:Number(resolved.connection.requestTimeoutMs)||120000,maxTokens:Number(parameters.maxTokens)||4096,...(typeof parameters.temperature==='number'?{temperature:parameters.temperature}:{}),supportsTools:parameters.supportsTools!==false}};
    },
  });
  await agent.initialize();
  const requests=new Set<Promise<RpcResult>>();let stopping=false,disposal:Promise<void>|undefined;
  async function dispatch(endpoint:string,payload:unknown={}):Promise<RpcResult>{
    try{
      if(!ENDPOINTS.has(endpoint))throw new Error('不支持此应用操作');
      const data=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload as Record<string,unknown>:{};
      let value:unknown;
      switch(endpoint){
        case 'archive':{
          if(data.archived!==false){const snapshot=await backend.call('current',{projectId:data.projectId});const id=snapshot.project?.id;if(id&&((await workflows.list(id)).some(item=>item.status==='running')||(await media.list(id)).some(item=>item.observation==='active'&&!['ready','complete','failed','cancelled'].includes(item.phase))))throw new Error('工程仍有媒体或协作任务，请先停止本地等待再归档');}
          return backend.route(endpoint,payload);
        }
        case 'agent.start':value=await agent.start(data as unknown as AgentStartInput);break;
        case 'agent.list':value={runs:await agent.list(typeof data.projectId==='string'?data.projectId:undefined)};break;
        case 'agent.get':value=await agent.get(String(data.runId));break;
        case 'agent.trace':value={events:await agent.trace(String(data.runId))};break;
        case 'agent.approve':value=await agent.approve(String(data.runId),String(data.callId),typeof data.execId==='string'?data.execId:undefined,typeof data.argsHash==='string'?data.argsHash:undefined);break;
        case 'agent.reject':value=await agent.reject(String(data.runId),String(data.callId),typeof data.execId==='string'?data.execId:undefined,typeof data.reason==='string'?data.reason:'');break;
        case 'agent.resume':value=await agent.resume(String(data.runId));break;
        case 'agent.pause':value=await agent.pause(String(data.runId));break;
        case 'agent.cancel':value=await agent.cancel(String(data.runId));break;
        case 'agent.tools':value={tools:agent.toolList.map(tool=>({name:tool.name,risk:tool.risk,description:tool.description}))};break;
        case 'agent.capabilities':value=await agent.capabilities();break;
        case 'story.get':value=await agent.story(String(data.projectId));break;
        case 'story.save':value=await agent.saveStory(String(data.projectId),(data.story??{}) as Record<string,unknown>,Number(data.expectedVersion));break;
        case 'agent.qc':value=await agent.runQc(String(data.projectId));break;
        case 'agent.qc.last':value={report:await agent.lastQc(String(data.projectId))};break;
        case 'agent.ledger':value=await agent.ledger(String(data.projectId));break;
        case 'agent.budget.set':value=await agent.setProjectBudget(String(data.projectId),data.maxCost===null||data.maxCost===undefined||data.maxCost===''?null:Number(data.maxCost),typeof data.currency==='string'?data.currency:undefined);break;
        case 'workflows.run':value=await workflows.run(data as unknown as WorkflowRequest);break;
        case 'workflows.list':value={workflows:await workflows.list(typeof data.projectId==='string'?data.projectId:undefined)};break;
        case 'workflows.get':value=await workflows.get(String(data.workflowId));break;
        case 'workflows.retry':value=await workflows.retry(String(data.workflowId));break;
        case 'workflows.pause':value=await workflows.pause(String(data.workflowId));break;
        case 'workflows.apply':value=await workflows.apply(String(data.workflowId),Number(data.expectedRevision));break;
        case 'models.list':value=await providers.registry.list();break;
        case 'models.connection.save':value=await providers.registry.saveConnection(data as ConnectionInput);await backend.call('catalog');break;
        case 'models.connection.remove':await providers.registry.removeConnection(String(data.id));value=await providers.registry.list();break;
        case 'models.model.save':value=await providers.registry.saveModel(data as unknown as ModelInput);await backend.call('catalog');break;
        case 'models.model.remove':await providers.registry.removeModel(String(data.id));value=await providers.registry.list();break;
        case 'models.role.bind':await providers.registry.bindRole(data.role as ModelRole,typeof data.modelId==='string'?data.modelId:null);value=await providers.registry.list();break;
        case 'models.check':value=await providers.check(typeof data.connectionId==='string'?data.connectionId:undefined);break;
        case 'media.generate':value=await media.generate(data as unknown as MediaRequest);break;
        case 'media.list':value={tasks:await media.list(typeof data.projectId==='string'?data.projectId:undefined)};break;
        case 'media.get':value=await media.get(String(data.taskId));break;
        case 'media.retry':value=await media.retry(String(data.taskId));break;
        case 'media.pause':value=await media.pause(String(data.taskId));break;
        case 'media.cancel':value=await media.cancel(String(data.taskId));break;
        case 'media.apply':value=await media.apply(String(data.taskId),Number(data.expectedRevision));break;
        case 'app.health':{const snapshot=await backend.call('current');value=await applicationHealth(snapshot.environment,await providers.settings(),dataDirectory);break;}
        case 'app.exportProject':value=await exportProjectArchive(backend,data,agentArchive);break;
        case 'app.importProject':value=await importProjectArchive(backend,data,agentArchive);break;
        case 'packs.list':value=foundationPacks;break;
        case 'providers.get':value=await providers.settings();break;
        case 'providers.save':value=await providers.save(data);await backend.call('catalog');break;
        case 'providers.check':value=await providers.check();break;
        case 'chat.history':value=await conversation.history(typeof data.projectId==='string'?data.projectId:undefined);break;
        case 'chat.send':value=await conversation.send(data as unknown as ChatInput);break;
        case 'chat.cancel':value=await conversation.cancel();break;
        default:return backend.route(endpoint,payload);
      }
      return {ok:true,value};
    }catch(error){return {ok:false,error:{code:typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'APP_ERROR',message:error instanceof Error?error.message:'操作失败'}};}
  }
  function route(endpoint:string,payload:unknown={}):Promise<RpcResult>{
    if(stopping)return Promise.resolve({ok:false,error:{code:'APP_SHUTTING_DOWN',message:'应用正在关闭，请重新打开后继续'}});
    const request=dispatch(endpoint,payload);requests.add(request);void request.finally(()=>requests.delete(request));return request;
  }
  return {backend,providers,conversation,media,workflows,agent,route,dispose(){return disposal??=(async()=>{stopping=true;await agent.dispose();await conversation.shutdown();await workflows.dispose();await media.dispose();await Promise.allSettled([...requests]);await backend.dispose();})();}};
}
export type Application=Awaited<ReturnType<typeof createApplication>>;
