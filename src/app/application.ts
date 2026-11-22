import { fetch } from '../host/http.ts';
import { AppBackend } from './backend.ts';
import { ProviderManager, type ModelContent } from './model.ts';
import { ConversationService } from './conversation.ts';
import type { RpcResult, StudioSnapshot } from '../shared/types.ts';
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
import { uploadDestination, type AuthorizeUpload } from '../models/upload-consent.ts';
import { chatCompletionSupportsTools } from '../models/provider-defaults.ts';
import { pollTemplate, submitTemplate } from '../models/adapters/template.ts';
import { discoverProviderModels } from '../models/adapters/official.ts';
import { parseSceneSource } from '../host/generator.ts';
import { readDirectorDocument } from '../director/document.ts';
import type { DirectorPlan } from '../director/contracts.ts';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { writeDurableFile } from '../agent/durable-file.ts';
import { acquireApplicationOwner, applicationDirectories, drainOwned, type OwnerLease } from './ownership.ts';

export const ENDPOINTS=new Set(['catalog','current','create','open','save','import','source','saveSource','restoreSource','preview','generate','export','cancel','environment','reveal','apply','inspect','thumbnails','list','focus','audio','tts','history','undo','redo','rename','duplicate','archive','tasks','retry','packs.list','app.health','app.exportProject','app.importProject','providers.get','providers.save','providers.check','chat.history','chat.send','chat.cancel']);
for(const endpoint of ['models.list','models.connection.save','models.connection.remove','models.model.save','models.model.remove','models.role.bind','models.check','media.generate','media.list','media.get','media.retry','media.pause','media.cancel','media.apply','video.clip.save','video.clip.remove','video.clip.extract'])ENDPOINTS.add(endpoint);
for(const endpoint of ['workflows.run','workflows.list','workflows.get','workflows.retry','workflows.pause','workflows.apply'])ENDPOINTS.add(endpoint);
for(const endpoint of ['agent.start','agent.list','agent.get','agent.trace','agent.approve','agent.reject','agent.resume','agent.pause','agent.cancel','agent.tools','agent.capabilities','story.get','story.save','agent.qc','agent.qc.last','agent.ledger','agent.budget.set'])ENDPOINTS.add(endpoint);
for(const endpoint of ['app.onboarding.get','app.onboarding.complete'])ENDPOINTS.add(endpoint);
ENDPOINTS.add('providers.vision.save');
for(const endpoint of ['styles.list','styles.save','styles.delete','audio.sfx','audio.generate','models.discover','production.set','director.document.save','director.document.approve','quality.check','quality.last','agent.message','media.deconstruct','audio.analyze','delivery.export','media.assetDataUrl'])ENDPOINTS.add(endpoint);
export class MemorySecrets implements SecretStore {
  private values=new Map<string,string>();
  async get(ref:string){return this.values.get(ref);}
  async set(ref:string,value:string){this.values.set(ref,value);}
  async delete(ref:string){this.values.delete(ref);}
}
export async function createApplication(options:{dataDirectory:string;projectsDirectory?:string;credentials:SecretStore;reveal?:(path:string)=>Promise<void>;fetch?:typeof fetch;recover?:boolean;resumeRemoteTasks?:boolean;ownership?:OwnerLease;projectRootWaitMs?:number}){
  const projectRootWaitMs=options.projectRootWaitMs===undefined?0:options.projectRootWaitMs;
  if(!Number.isFinite(projectRootWaitMs)||projectRootWaitMs<0)throw new RangeError('工程目录锁等待时间必须是非负有限数字');
  const {dataDirectory,projectsDirectory}=applicationDirectories(options);
  const onboardingFile=join(dataDirectory,'onboarding-v1');
  const ownership=options.ownership??await acquireApplicationOwner({dataDirectory,projectsDirectory},'application');
  const cleanups:(()=>Promise<unknown>)[]=[];
  try{
  // Borrowed leases also verify the resolved roots, without taking a second listener on their own ports.
  await ownership.claim([dataDirectory,projectsDirectory]);
  const providers=new ProviderManager(dataDirectory,options.credentials,options.fetch?{fetch:options.fetch}:{});await providers.initialize();
  const backend=new AppBackend({...options,dataDirectory,projectsDirectory,providers:providers.host(),claimProjectRoot:root=>ownership.claim([root],projectRootWaitMs,{existingOnly:true})});
  cleanups.push(()=>backend.dispose());
  const conversation=new ConversationService(backend,providers,dataDirectory);
  cleanups.push(()=>conversation.shutdown());
  await backend.call('catalog');
  const media=new MediaTaskService(dataDirectory,providers.registry,backend.mediaPort(),{fetch:options.fetch,resumeExistingTasks:options.recover!==false&&options.resumeRemoteTasks!==false});
  cleanups.push(()=>media.dispose());
  if(options.recover!==false&&options.resumeRemoteTasks!==false)await media.recover();
  const workflowPort:WorkflowPort={
    snapshot:id=>backend.call('current',{projectId:id}),source:(id,shotId)=>backend.call('source',{projectId:id,shotId}),
    commit:(id,expectedRevision,project,sources,label)=>backend.call('apply',{projectId:id,expectedRevision,project,sources:Object.entries(sources).map(([shotId,source])=>({shotId,source})),label}),
    stageMedia:(id,task,files,signal)=>backend.stageWorkflowMedia(id,task,files,signal),
    capture:(id,frame,signal,candidate)=>backend.workflowCapture(id,frame,signal,candidate),
    uploadDestination:async purpose=>uploadDestination(purpose==='review'?(await providers.requireVision()).route:await providers.registry.resolve('video')),
    text:async(role,prompt,signal,_request,images,authorizeUpload)=>role==='vision'?analyzeFrames(prompt,images??[],signal,authorizeUpload):providers.complete([{role:'user',content:prompt}],'你是视频制作团队的'+role+'。依据提供的工程文本执行任务。',signal,undefined,role),
    voice:async(id,shotId,text,signal,voiceOpts?:{voice?:string;speed?:number;speaker?:string})=>{
      const state=providers.registry.snapshot();
      if(!state.roles.some(binding=>binding.role==='speech')){
        const baseSettings=(await backend.call('current',{projectId:id})).tts;
        const overridden=baseSettings&&(voiceOpts?.voice||voiceOpts?.speed!==undefined)
          ?{...baseSettings,...(voiceOpts.voice?{voice:voiceOpts.voice}:{}),...(voiceOpts.speed!==undefined?{speed:voiceOpts.speed}:{})}
          :undefined;
        return backend.workflowVoice(id,shotId,text,signal,overridden,voiceOpts?.speaker);
      }
      let release:(()=>void)|undefined;
      try{
        const {selected,key}=await (async()=>{const selected=await providers.registry.resolve('speech');release=providers.registry.acquire(selected.connection.id,selected.model.id);const key=await providers.registry.credential(selected.connection);return {selected,key};})().catch(error=>{throw Object.assign(error instanceof Error?error:new Error(String(error)),{submissionUncertain:false});});
        if(selected.connection.protocol==='async-task'){
          release?.();release=undefined;
          const generated=await agentPort.generateAudio!(id,'speech',text,{signal,shotId});
          const latest=(await backend.call('current',{projectId:id})).project;
          const asset=latest?.assets.find(item=>item.id===generated.id);
          if(!asset)throw new Error('异步配音素材已生成但未能在工程中读取');
          return asset;
        }
        return await backend.workflowVoice(id,shotId,text,signal,{endpoint:selected.connection.baseUrl,model:selected.model.model,voice:String(voiceOpts?.voice??selected.model.parameters.voice??'alloy'),speed:Number(voiceOpts?.speed??selected.model.parameters.speed??1),enabled:true,requestTimeoutMs:selected.connection.requestTimeoutMs,...(key?{apiKey:key}:{})},voiceOpts?.speaker);
      }finally{release?.();}
    },
  };
  const workflows=new WorkflowService(dataDirectory,media,workflowPort);
  cleanups.push(()=>workflows.dispose());
  async function knownKeys():Promise<string[]>{const keys:string[]=[];for(const connection of providers.registry.snapshot().connections){try{const key=await providers.registry.credential(connection);if(key)keys.push(key);}catch{}}return keys;}
  /** F05: synthesize, then register the asset in the project (CAS commit) so the returned assetId is usable. Idempotent per requestId. */
  async function agentVoice(id:string,shotId:string,text:string,signal:AbortSignal,options:{expectedRevision?:number;requestId?:string;voice?:string;speed?:number;speaker?:string}={}):Promise<{id:string;name:string;revision?:number}>{
    const ledgerKey='agentVoice';
    const before=(await backend.call('current',{projectId:id})).project;if(!before)throw new Error('工程不存在或未打开');
    const done=options.requestId?((before.extensions[ledgerKey]??{}) as Record<string,{assetId:string}>)[options.requestId]:undefined;
    if(done){const asset=before.assets.find(item=>item.id===done.assetId);if(asset)return {id:asset.id,name:asset.name,revision:before.revision};}
    if(options.expectedRevision!==undefined&&options.expectedRevision!==before.revision)throw withSubmission(Object.assign(new Error('工程版本已变化（当前 '+before.revision+'），没有提交配音'),{code:'REVISION_CONFLICT'}),'preflight_failed');
    if(!before.shots.some(item=>item.id===shotId))throw withSubmission(new Error('配音目标镜头不存在'),'preflight_failed');
    const asset=await (workflowPort.voice as (id:string,shotId:string,text:string,signal:AbortSignal,v?:{voice?:string;speed?:number;speaker?:string})=>Promise<import('../shared/types.ts').Asset>)(id,shotId,text,signal,{voice:options.voice,speed:options.speed,speaker:options.speaker}).catch(error=>{throw withSubmission(error,(error as {submissionUncertain?:unknown})?.submissionUncertain===false?'preflight_failed':signal.aborted?'unknown':sendOutcome(error));});
    for(let attempt=0;;attempt++){
      const latest=(await backend.call('current',{projectId:id})).project!;const next=structuredClone(latest);
      if(!next.assets.some(item=>item.id===asset.id))next.assets.push(asset);
      if(options.requestId)next.extensions={...next.extensions,[ledgerKey]:{...((next.extensions[ledgerKey]??{}) as object),[options.requestId]:{assetId:asset.id}}};
      try{const committed=await workflowPort.commit(id,latest.revision,next,{},'智能体：登记配音素材');return {id:asset.id,name:asset.name,revision:committed.project?.revision};}
      catch(error){if(attempt>=2||!/版本|revision/i.test(error instanceof Error?error.message:'')){const failure=error instanceof Error?error:new Error(String(error));failure.message='配音已生成（可能已计费）但登记进工程失败：'+failure.message;throw withSubmission(failure,'unknown');}}
    }
  }
  // A user edit can land between reading the revision and importing. A stale-revision import is rejected before anything
  // is written, so re-reading the latest revision and retrying (bounded, like agentVoice) cannot import twice.
  const importAsset=async(id:string,name:string,description:string,bytes:Uint8Array,mime:string,failure:string)=>{
    const dataBase64=`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    for(let attempt=0;;attempt++){
      const current=await backend.call('current',{projectId:id});
      try{const snapshot=await backend.call('import',{projectId:id,expectedRevision:current.project?.revision,name,description,mime,dataBase64});const asset=snapshot.project?.assets.at(-1);if(!asset)throw new Error(failure);return {id:asset.id,name:asset.name};}
      catch(error){if(attempt>=2||!/版本冲突|REVISION_CONFLICT/.test(error instanceof Error?error.message:''))throw error;}
    }
  };
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
        if(binding.role==='vision'&&!(await providers.requireVision().then(()=>true,()=>false)))continue;
        if(['image','video','speech','music','sfx','vision'].includes(binding.role)){roles.push(binding.role as GenRole);models[binding.role as GenRole]=model.name;}}
      if(!roles.includes('speech')){try{const snapshot=await backend.call('current');if(snapshot.ttsConfigured&&snapshot.tts?.enabled){roles.push('speech');models.speech='应用内配音设置';}}catch{}}
      try{const snapshot=await backend.call('current');if(snapshot.environment?.blenderAvailable){roles.push('blender');models.blender='本机 Blender 白模预演';}}catch{}
      let director:string|undefined,scene:string|undefined;
      try{director=(await providers.registry.resolve('director')).model.name;}catch{}
      try{scene=(await providers.registry.resolve('scene')).model.name;}catch{}
      return {roles,models,...(director?{director}:{}),...(scene?{scene}:{})};
    },
    importImage:async(id,name,bytes,mime)=>{if(!/^image\/(png|jpeg|webp)$/.test(mime))throw new Error('不支持的图片格式');return importAsset(id,name,'智能体截取的尾帧',bytes,mime,'图片导入失败');},
    importAudio:async(id,name,bytes,mime)=>importAsset(id,name,'智能体本地合成',bytes,mime,'音频导入失败'),
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
            const current=await backend.call('current',{projectId:id});
            const snapshot=await backend.call('import',{projectId:id,expectedRevision:current.project?.revision,name:(role==='music'?'音乐 · ':role==='sfx'?'音效 · ':'配音 · ')+prompt.slice(0,24),description:'由 '+resolved.model.name+' 生成',mime,dataBase64:`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`});
            const asset=snapshot.project?.assets.at(-1);if(!asset)throw new Error('音频导入失败');
            await dropReceipt().catch(()=>{});return {id:asset.id,name:asset.name,cost};
          }catch(error){lastError=error;if(signal.aborted)break;await new Promise(r=>setTimeout(r,50*(attempt+1)));}
        }
        const failure=new Error('音频已生成（可能已计费）并已保存回执，但登记进工程失败：'+(lastError instanceof Error?lastError.message:String(lastError))+'。再次发起相同请求会重试本地登记，不会重新提交');
        throw withSubmission(failure,'unknown',jobId);
      }finally{release();}
    },
    visionDestination:()=>workflowPort.uploadDestination('review'),
    vision:analyzeFrames,
    imageReferenceDestination:async()=>uploadDestination(await providers.registry.resolve('image')),
    generateImageReference:(request,authorizeUpload)=>media.generate(request,authorizeUpload),
    videoReferenceDestination:()=>workflowPort.uploadDestination('video-reference'),
    generateVideoReference:(request,authorizeUpload)=>media.generate(request,authorizeUpload),
    renderPreviz:(id,spec,opts)=>backend.renderPreviz(id,spec,opts),
    generateSceneCode:async(id,shotId,instruction,signal,expectedRevision)=>{
      const current=await backend.call('current',{projectId:id});
      const project=current.project;if(!project)throw new Error('没有打开的工程');
      if(expectedRevision!==undefined&&project.revision!==expectedRevision){
        throw Object.assign(new Error(`工程版本冲突：期望 v${expectedRevision}，当前 v${project.revision}；请先读取最新工程后合并修改`),{code:'REVISION_CONFLICT'});
      }
      const baseRevision=project.revision;
      const shot=project.shots.find(item=>item.id===shotId);if(!shot)throw new Error('目标镜头不存在：'+shotId);
      const oldSource=await backend.call('source',{projectId:id,shotId});
      const askSceneModel=async(payload:Record<string,unknown>)=>{
        const prompt=JSON.stringify(payload);
        const sysPrompt='你是映流智能体的专精动态图形与场景代码工程师（scene 角色）。只返回合法 JSON 对象 {html,css,js}。';
        const raw=await providers.complete([{role:'user',content:prompt}],sysPrompt,signal,undefined,'scene')
          .catch(()=>providers.complete([{role:'user',content:prompt}],'你是映流智能体的专精动态图形与场景代码工程师。只返回合法 JSON 对象 {html,css,js}。',signal,undefined,'director'));
        return parseSceneSource(raw);
      };
      const waitPreviewTask=async(taskId:string|undefined)=>{
        if(!taskId)return null;
        for(let i=0;i<240;i++){
          signal.throwIfAborted();
          const snap=await backend.call('current',{projectId:id});
          if(!snap.task||snap.task.id!==taskId||snap.task.status!=='running')return snap;
          await new Promise(r=>setTimeout(r,60));
        }
        return await backend.call('current',{projectId:id});
      };
      const basePayload={
        shot:{id:shot.id,title:shot.title,intent:shot.intent,composition:shot.composition,action:shot.action,params:shot.params,hasVideo:Boolean(project.videoClips?.some(c=>c.shotId===shot.id))},
        target:project.target,
        videoStyle:project.videoStyle?{name:project.videoStyle.name,prompt:project.videoStyle.prompt}:null,
        currentSource:oldSource,
        instruction,
        contract:'只输出严格 JSON：{"html":"...","css":"...","js":"export function render(ctx) { ... }"}。DOM 节点须通过 ctx.root.querySelector 查询（禁止 document.getElementById），动画必须仅依赖 ctx.time 与 ctx.helpers，禁止 Date.now/setTimeout/requestAnimationFrame 或外链。若 hasVideo=true，底图透明不要遮挡底层视频。',
      };
      let parsed=await askSceneModel(basePayload);
      // CAS-protected: bind strictly to `baseRevision` so concurrent manual edits are NEVER overwritten!
      let saved=await backend.call('saveSource',{projectId:id,shotId,expectedRevision:baseRevision,source:{html:parsed.html,css:parsed.css,js:parsed.js}});
      let checked=await waitPreviewTask(saved.task?.id);
      if(checked?.task?.id===saved.task?.id&&checked?.task?.status==='failed'){
        const errDetail=checked.task.error||checked.task.message||'渲染校验失败';
        parsed=await askSceneModel({...basePayload,currentSource:parsed,instruction:`${instruction}\n\n【紧急修复】上一版镜头源码在无头浏览器渲染校验时报错：${errDetail}。请修复该错误并返回完整合法 JSON {html,css,js}。`});
        saved=await backend.call('saveSource',{projectId:id,shotId,expectedRevision:saved.project?.revision,source:{html:parsed.html,css:parsed.css,js:parsed.js}});
        checked=await waitPreviewTask(saved.task?.id);
        if(checked?.task?.id===saved.task?.id&&checked?.task?.status==='failed'){
          throw new Error(`专精场景模型自动修复后镜头渲染仍报错：${checked.task.error||checked.task.message}`);
        }
      }
      return {shotId,revision:saved.project?.revision??0,summary:`已由专精场景模型更新并通过渲染校验：${shot.title}`};
    },
  };
  async function analyzeFrames(prompt:string,images:{mime:string;bytes:Uint8Array}[],signal:AbortSignal,authorizeUpload?:AuthorizeUpload):Promise<string>{
    if(!authorizeUpload)throw new Error('发送关键帧需要明确的上传授权');
    const {route}=await providers.requireVision();
    const release=providers.registry.acquire(route.connection.id,route.model.id);
    try{
      signal.throwIfAborted();authorizeUpload(uploadDestination(route));
      const content:ModelContent[]=images.map(image=>({type:'image_url',image_url:{url:`data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`}}));
      return await providers.analyzeImages(content,prompt,signal,route);
    }finally{release();}
  }
  const agentArchive={export:(projectId:string)=>agent.exportDocs(projectId),import:(projectId:string,docs:Partial<Record<'story'|'ledger'|'qc',unknown>>)=>agent.importDocs(projectId,docs),validate:(docs:Partial<Record<'story'|'ledger'|'qc',unknown>>)=>agent.validateDocs(docs)};
  const agent=new AgentService(join(dataDirectory,'agent-runs'),agentPort,{
    fetch:options.fetch,dataDirectory:join(dataDirectory,'agent-data'),...(options.recover===false?{recover:false}:{}),
    redact:async text=>{let value=text;for(const key of await knownKeys())value=redactKey(value,key);return value;},
    resolveModel:async()=>{
      const resolved=await providers.resolveText('director'),parameters=resolved.model.parameters as Record<string,unknown>;
      return {connectionId:resolved.connection.id,parameters,config:{baseUrl:resolved.connection.baseUrl,model:resolved.model.model,key:await providers.registry.credential(resolved.connection),
        timeoutMs:Number(resolved.connection.requestTimeoutMs)||120000,maxTokens:Number(parameters.maxTokens)||4096,...(typeof parameters.temperature==='number'?{temperature:parameters.temperature}:{}),supportsTools:parameters.supportsTools!==false&&chatCompletionSupportsTools(resolved.connection.baseUrl,resolved.model.model)}};
    },
    resolveSubModel:async(preferRole)=>{
      const resolved=await providers.resolveText(preferRole).catch(()=>providers.resolveText('director'));
      const parameters=resolved.model.parameters as Record<string,unknown>;
      return {connectionId:resolved.connection.id,parameters,config:{baseUrl:resolved.connection.baseUrl,model:resolved.model.model,key:await providers.registry.credential(resolved.connection),
        timeoutMs:Number(resolved.connection.requestTimeoutMs)||120000,maxTokens:Number(parameters.maxTokens)||4096,...(typeof parameters.temperature==='number'?{temperature:parameters.temperature}:{}),supportsTools:parameters.supportsTools!==false&&chatCompletionSupportsTools(resolved.connection.baseUrl,resolved.model.model)}};
    },
  });
  cleanups.push(()=>agent.dispose());
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
        case 'agent.resume':value=await agent.resume(String(data.runId),typeof data.visionConsentId==='string'?data.visionConsentId:undefined,data.disableVision===true);break;
        case 'agent.pause':value=await agent.pause(String(data.runId));break;
        case 'agent.cancel':value=await agent.cancel(String(data.runId));break;
        case 'agent.message':value=await agent.sendMessage(String(data.runId),String(data.message??''));break;
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
        case 'workflows.retry':value=await workflows.retry(String(data.workflowId),typeof data.uploadConsentId==='string'?data.uploadConsentId:undefined);break;
        case 'workflows.pause':value=await workflows.pause(String(data.workflowId));break;
        case 'workflows.apply':value=await workflows.apply(String(data.workflowId),Number(data.expectedRevision),typeof data.uploadConsentId==='string'?data.uploadConsentId:undefined);break;
        case 'models.list':value=await providers.registry.list();break;
        case 'models.connection.save':value=await providers.registry.saveConnection(data as ConnectionInput);await backend.call('catalog');break;
        case 'models.connection.remove':await providers.registry.removeConnection(String(data.id));value=await providers.registry.list();break;
        case 'models.model.save':value=await providers.registry.saveModel(data as unknown as ModelInput);await backend.call('catalog');break;
        case 'models.model.remove':await providers.registry.removeModel(String(data.id));value=await providers.registry.list();break;
        case 'models.role.bind':await providers.registry.bindRole(data.role as ModelRole,typeof data.modelId==='string'?data.modelId:null);await backend.call('catalog');value=await providers.registry.list();break;
        case 'models.check':value=await providers.check(typeof data.connectionId==='string'?data.connectionId:undefined);break;
        case 'models.discover':{
          const connectionId=String(data.connectionId??'');
          const snapshot=providers.registry.snapshot();
          const connection=snapshot.connections.find(item=>item.id===connectionId);
          if(!connection)throw new Error('模型连接不存在');
          const release=providers.registry.acquire(connection.id);
          try{
            const key=await providers.registry.credential(connection);
            value=await discoverProviderModels({connection,key,signal:AbortSignal.timeout(Math.min(connection.requestTimeoutMs,15_000)),fetch:options.fetch});
          }finally{release();}
          break;
        }
        case 'audio.generate':{
          const projectId=typeof data.projectId==='string'?data.projectId:(await backend.call('current')).project?.id;
          if(!projectId)throw new Error('请先打开影片工程');
          const role=data.role==='music'||data.role==='sfx'||data.role==='speech'?data.role:undefined;
          if(!role)throw new Error('音频生成角色须为 speech、music 或 sfx');
          const prompt=String(data.prompt??'').trim();
          if(!prompt)throw new Error('请填写音频生成提示词');
          const durationSeconds=data.durationSeconds!==undefined&&data.durationSeconds!==''?Number(data.durationSeconds):undefined;
          const shotId=typeof data.shotId==='string'&&data.shotId?data.shotId:undefined;
          const generated=await agentPort.generateAudio!(projectId,role,prompt,{durationSeconds,shotId,signal:AbortSignal.timeout(300_000)});
          if(data.bindToTrack!==false){
            const latest=await backend.call('current',{projectId});
            if(latest.project){
              await backend.call('audio',{projectId,expectedRevision:latest.project.revision,operation:'add',assetId:generated.id,role,...(shotId?{shotId}:{}),startSeconds:Number(data.startSeconds??0),trimStart:0,volume:role==='music'?0.25:1,fadeIn:role==='music'?0.5:0,fadeOut:role==='music'?0.5:0,...(role==='music'?{loop:true}:{})});
            }
          }
          value={asset:generated,snapshot:await backend.call('current',{projectId})};
          break;
        }
        case 'media.generate':value=await media.generate(data as unknown as MediaRequest);break;
        case 'media.list':value={tasks:await media.list(typeof data.projectId==='string'?data.projectId:undefined)};break;
        case 'media.get':value=await media.get(String(data.taskId));break;
        case 'media.retry':value=await media.retry(String(data.taskId));break;
        case 'media.pause':value=await media.pause(String(data.taskId));break;
        case 'media.cancel':value=await media.cancel(String(data.taskId));break;
        case 'media.apply':value=await media.apply(String(data.taskId),Number(data.expectedRevision));break;
        case 'app.health':{const snapshot=await backend.call('current');value=await applicationHealth(snapshot.environment,await providers.settings(),dataDirectory);break;}
        case 'app.onboarding.get':{
          try{value={completed:await readFile(onboardingFile,'utf8')==='1\n'};}
          catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;value={completed:false};}
          break;
        }
        case 'app.onboarding.complete':{
          await writeDurableFile(onboardingFile,'1\n');
          value={completed:true};
          break;
        }
        case 'app.exportProject':value=await exportProjectArchive(backend,data,agentArchive);break;
        case 'app.importProject':value=await importProjectArchive(backend,data,agentArchive);break;
        case 'packs.list':value=foundationPacks;break;
        case 'providers.get':value=await providers.settings();break;
        case 'providers.save':value=await providers.save(data);await backend.call('catalog');break;
        case 'providers.vision.save':value=await providers.saveVision(data);await backend.call('catalog');break;
        case 'providers.check':value=await providers.check(typeof data.connectionId==='string'?data.connectionId:undefined,data.purpose==='vision'?'vision':'director');break;
        case 'chat.history':value=await conversation.history(typeof data.projectId==='string'?data.projectId:undefined);break;
        case 'chat.send':value=await conversation.send(data as unknown as ChatInput);break;
        case 'chat.cancel':value=await conversation.cancel();break;
        case 'director.document.save':
        case 'director.document.approve':{
          const routed=await backend.route(endpoint,payload);
          if(routed.ok&&endpoint==='director.document.approve'){
            const docVal=routed.value as {document?:{version?:number;hash?:string;status?:string;plan?:DirectorPlan};snapshot?:StudioSnapshot}|undefined;
            const pid=docVal?.snapshot?.project?.id??(typeof data.projectId==='string'?data.projectId:undefined);
            const plan=docVal?.document?.plan??(docVal?.snapshot?.project?readDirectorDocument(docVal.snapshot.project)?.plan:undefined);
            if(pid&&plan&&docVal?.document?.status==='approved'){
              await agent.syncFromDirectorPlan(pid,plan,true,{version:docVal.document.version,hash:docVal.document.hash}).catch(()=>{});
            }
          }
          return routed;
        }
        default:return backend.route(endpoint,payload);
      }
      return {ok:true,value};
    }catch(error){return {ok:false,error:{code:typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'APP_ERROR',message:error instanceof Error?error.message:'操作失败'}};}
  }
  function route(endpoint:string,payload:unknown={}):Promise<RpcResult>{
    if(stopping)return Promise.resolve({ok:false,error:{code:'APP_SHUTTING_DOWN',message:'应用正在关闭，请重新打开后继续'}});
    const request=dispatch(endpoint,payload);requests.add(request);void request.finally(()=>requests.delete(request));return request;
  }
  return {backend,providers,conversation,media,workflows,agent,route,dispose(){return disposal??=(async()=>{
    stopping=true;
    try{await drainOwned([()=>agent.dispose(),()=>conversation.shutdown(),()=>workflows.dispose(),()=>media.dispose(),()=>Promise.allSettled([...requests]),()=>backend.dispose()]);}
    finally{if(!options.ownership)await ownership.release();}
  })();}};
  }catch(error){
    try{await drainOwned([...cleanups].reverse());}finally{if(!options.ownership)await ownership.release();}
    throw error;
  }
}
export type Application=Awaited<ReturnType<typeof createApplication>>;
