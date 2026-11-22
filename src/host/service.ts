import {createHash, randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,rm} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {atomicRename} from './atomic-rename.ts';
import {projectOpenPath} from './file-opener.ts';
import {homedir} from 'node:os';
import {applyProductionPolicy,createProject,compileSpec,defaultProductionPolicy,defaultSceneSource,updateShot,updateTarget,validateProject,reorderShots} from '../core/index.ts';
import type {VideoProject,StudioSnapshot,TaskState,EnvironmentSettings,ProviderGroup,RpcResult,SceneSource,Shot,ModelRoute,TtsSettings,AudioClip,VideoClip,Asset,ProductionMode,ProductionPolicy} from '../shared/types.ts';
import {approveDirectorDocument,saveDirectorDocument} from '../director/document.ts';
import {localExportQuality,localQualityFrames,type LocalQualityFrame,type LocalQualityReport} from '../workflows/local-quality.ts';
import type {HostContext} from './platform.ts';
import {ProjectStore,projectPath,validateStoredProject,validateSources} from './store.ts';
import {VideoRenderer,detectEnvironment,renderCheckError} from './renderer.ts';
import {sanitizeTaskFailure,taskFailure} from '../shared/task-diagnostic.ts';
import {AppSceneGenerator,parseSceneSource,normalizeStoryboard} from './generator.ts';
import {SpeechSynthesizer,AudioMixer,extractVideoAudio} from './audio.ts';
import {BlenderRunner,type PrevizSceneSpec} from './blender.ts';
import {synthesizeLocalSfx} from '../media/local-sfx.ts';
import {analyzeAudioAcoustics,deconstructReferenceVideo} from '../media/deconstruct.ts';
import {deriveSubtitles,formatAss,formatEdl,formatFcpxml,formatOtio,formatSrt} from '../media/delivery.ts';
import type {MediaProjectPort} from '../jobs/contracts.ts';
import {inspectGeneratedMedia,readProjectImage} from '../media/inspect.ts';
import type { GeneratedFile, MediaTask } from '../jobs/contracts.ts';
import {inspectCredential,isCredentialError,updateCredential} from '../app/secrets.ts';
import {defaultTtsSettings,validateTtsSettings} from '../shared/tts-capability.ts';
import {normalizeVideoStyle} from '../shared/video-style.ts';

interface TaskRequest { endpoint:'preview'|'export'|'generate'; payload:Record<string,string> }
interface RecordedTask extends TaskState { appRecordVersion?:1; revision?:number; request?:TaskRequest; retryOf?:string; outputId?:string }

export class StudioService {
  readonly store:ProjectStore;readonly renderer=new VideoRenderer();
  private project:VideoProject|null=null;private root:string|null=null;
  private task:RecordedTask|null=null;private controller?:AbortController;private job?:Promise<void>;
  private commands:Promise<unknown>=Promise.resolve();
  private providers:ProviderGroup[]=[];private previewUrl:string|null=null;private previewRevision:number|null=null;private assetBaseUrl:string|null=null;
  private settings:EnvironmentSettings;private initialized:Promise<void>;private disposed=false;
  private readonly baseDirectory:string;
  private readonly restoreRecent:boolean;
  private readonly speech=new SpeechSynthesizer();
  private readonly blender=new BlenderRunner();
  private audioUrl:string|null=null;
  private currentExports?:{project:VideoProject;ids:Promise<string[]>};
  private tts:TtsSettings;
  constructor(private ctx:HostContext,config:{baseDirectory?:string;restoreRecent?:boolean}={}){
    this.baseDirectory=resolve(config.baseDirectory??process.env.YINGLIU_PROJECTS??join(homedir(),'Documents','YingliuAgentProjects'));
    this.restoreRecent=config.restoreRecent!==false;
    this.store=new ProjectStore({baseDirectory:this.baseDirectory,claimRoot:ctx.claimProjectRoot});
    const env=detectEnvironment();this.settings={browserPath:env.browserPath,ffmpegPath:env.ffmpegPath,ffprobePath:env.ffprobePath,...(env.blenderPath?{blenderPath:env.blenderPath}:{})};this.tts=defaultTtsSettings(env);
    this.initialized=this.initialize();
  }
  private async initialize(){
    try{this.settings={...this.settings,...JSON.parse(await readFile(join(this.baseDirectory,'environment.json'),'utf8'))};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    try{this.tts={...this.tts,...JSON.parse(await readFile(join(this.baseDirectory,'tts.json'),'utf8'))};delete this.tts.apiKey;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const recent=this.restoreRecent?await this.store.recent():[];
    if(recent[0])try{this.project=await this.store.open(recent[0].path);this.root=recent[0].path;await this.recoverTask();await this.refreshPreview();}catch{/* Recent path may have been moved; keep the picker usable. */}
  }
  async snapshot():Promise<StudioSnapshot>{
    await this.initialized;const credentials=await inspectCredential(this.ctx.credentials,'YINGLIU_TTS_API_KEY');
    const {project,root,task,previewUrl,previewRevision,assetBaseUrl,audioUrl,tts,providers}=this;
    let currentExportIds:Promise<string[]>|undefined;
    if(project&&root){
      // Reuse the comparison while polling this immutable committed project version.
      if(this.currentExports?.project!==project){
        const ids=this.store.currentExportIds(root,project).catch(()=>project.outputs.filter(output=>output.revision===project.revision).map(output=>output.id));
        this.currentExports={project,ids};
      }
      currentExportIds=this.currentExports.ids;
    }
    const environment=detectEnvironment(this.settings);
    const [ids,recent]=await Promise.all([currentExportIds,this.store.recent()]);
    return structuredClone({project,root,task,previewUrl,previewRevision,assetBaseUrl,currentExportIds:ids,audioUrl,tts:{...tts,apiKey:undefined},ttsConfigured:credentials.hasKey,credentialStatus:credentials.credentialStatus,providers,environment,recent});
  }
  /** Trusted host port: generated paths never cross the public RPC or model tool surface. */
  async inspectMediaProject(){await this.initialized;const {project}=this.required();return {revision:project.revision,shotIds:project.shots.map(shot=>shot.id)};}
  async readMediaImage(assetId:string,shotId?:string){await this.initialized;const {root,project}=this.required();return readProjectImage(root,project,assetId,shotId);}
  async validateMediaArtifact(path:string,mimeType:string,signal?:AbortSignal){await this.initialized;return inspectGeneratedMedia(path,mimeType,this.settings,signal);}
  async stageWorkflowMedia(task:MediaTask,files:GeneratedFile[],signal:AbortSignal):Promise<Asset[]>{
    await this.initialized;const {root,project}=this.required();if(task.projectId!==project.id)throw new Error('素材任务工程不匹配');
    const assets:Asset[]=[];for(const file of files){signal.throwIfAborted();const asset=await this.store.importAsset(root,{path:file.path,mime:file.mimeType,name:file.name,description:task.prompt},this.settings,signal);asset.generation={taskId:task.id,connectionId:task.connection.id,model:task.model.model,operation:task.operation,prompt:task.prompt,inputHashes:task.inputHashes};assets.push(asset);}return assets;
  }
  async workflowVoice(shotId:string,text:string,signal:AbortSignal,settings?:TtsSettings,speakerLabel?:string):Promise<Asset>{
    const prepared=await (async()=>{
      await this.initialized;signal.throwIfAborted();const {root,project}=this.required(),shot=project.shots.find(item=>item.id===shotId);if(!shot)throw new Error('配音目标镜头不存在');
      const speechSettings=settings??await this.speechSettings();if(!speechSettings.enabled)throw new Error('请先配置并启用配音服务');validateTtsSettings(speechSettings,detectEnvironment(this.settings));if(!text.trim())throw new Error('配音文本不能为空');
      return {root,shot,speechSettings};
    })().catch(error=>{throw Object.assign(error instanceof Error?error:new Error(String(error)),{submissionUncertain:false});});
    const label=speakerLabel?`${prepared.shot.title} · ${speakerLabel}配音`:`${prepared.shot.title} · 协作配音`;
    return this.speech.synthesize(prepared.root,{text,name:label,description:text},prepared.speechSettings,this.settings,signal);
  }
  async workflowCapture(frame:number,signal:AbortSignal,candidate?:import('../workflows/contracts.ts').WorkflowCandidate){await this.initialized;const {root,project}=this.required();if(candidate){if(candidate.project.id!==project.id)throw new Error('候选工程不匹配');return this.renderer.captureCandidate(root,candidate.project,candidate.sources,this.settings,frame,signal);}const capture=await this.renderer.capture(root,project,this.settings,frame,signal);return {bytes:await readFile(capture.path),mime:'image/png',sha256:capture.sha256};}
  async applyMediaResult(input:Parameters<MediaProjectPort['applyResult']>[0]):Promise<{assetIds:string[];revision:number}>{
    await this.initialized;
    return this.enqueue(async()=>{
      if(this.disposed)throw new Error('应用服务已停止');this.assertIdle();const {root,project}=this.required();
      if(input.projectId!==project.id)throw new Error('媒体任务工程不匹配');
      const applications=(project.extensions.mediaApplications??{}) as Record<string,{assetIds:string[];revision:number}>;
      const prior=applications[input.provenance.taskId];if(prior)return structuredClone(prior);
      this.assertRevision(input,true);if(input.shotId&&!project.shots.some(shot=>shot.id===input.shotId))throw new Error('媒体任务镜头已不存在');
      const next=structuredClone(project),assetIds:string[]=[];
      for(const file of input.files){
        const asset=await this.store.importAsset(root,{path:file.path,mime:file.mimeType,name:file.name,description:input.provenance.prompt},this.settings);
        Object.assign(asset,{generation:structuredClone(input.provenance)});next.assets.push(asset);assetIds.push(asset.id);next.graph.positions[asset.id]=[60,80+(next.assets.length-1)*180];
      }
      if(!assetIds.length)throw new Error('媒体任务没有可采用的结果');
      const shot=next.shots.find(item=>item.id===input.shotId);
      if(shot){
        const imageIds=next.assets.filter(asset=>assetIds.includes(asset.id)&&asset.kind==='image').map(asset=>asset.id);shot.assetIds=[...new Set([...shot.assetIds,...imageIds])];
        const video=next.assets.find(asset=>assetIds.includes(asset.id)&&asset.kind==='video');
        if(video){next.schemaVersion=2;next.videoClips=[...(next.videoClips??[]).filter(clip=>clip.shotId!==shot.id),{id:randomUUID(),shotId:shot.id,assetId:video.id,trimStart:0,trimEnd:video.duration,speed:1,fit:'cover',audio:'mute'}];}
      }
      const applied={assetIds,revision:project.revision+1};next.extensions.mediaApplications={...applications,[input.provenance.taskId]:applied};
      await this.persist(next,{},'采用生成媒体');return structuredClone(applied);
    });
  }
  private required(){if(!this.project||!this.root)throw new Error('请先新建或打开项目');return {project:this.project,root:this.root};}
  private assertIdle(){if(this.task?.status==='running')throw new Error('已有任务运行，请等待或取消');}
  private resolveOutputUrls(project:VideoProject,root:string,baseUrl:string):void{
    for(const output of project.outputs){output.path=join(root,'exports',output.id,'video.mp4');output.url=new URL(`exports/${encodeURIComponent(output.id)}/video.mp4`,baseUrl).href;}
  }
  private async refreshPreview(){
    if(!this.project||!this.root)return;
    this.assetBaseUrl=await this.renderer.assetBaseUrl(this.root);
    this.resolveOutputUrls(this.project,this.root,this.assetBaseUrl);
    try{compileSpec(this.project);}catch{this.previewUrl=null;this.previewRevision=null;this.audioUrl=null;return;}
    const previewUrl=await this.renderer.preview(this.root,this.project);
    const audioUrl=await this.renderer.audioPreview(this.root,this.project,this.settings);
    this.previewUrl=previewUrl;this.previewRevision=this.project.revision;this.audioUrl=audioUrl;
  }
  private async refreshAfterCommit():Promise<void>{
    try{await this.refreshPreview();}catch(error){
      this.previewUrl=null;this.previewRevision=null;this.audioUrl=null;
      if(this.task?.status==='running')throw error;
      const message=await this.redact(error instanceof Error?error.message:String(error)),now=new Date().toISOString();
      this.task={id:randomUUID(),kind:'preview',status:'failed',progress:0,message:'工程已保存，预览准备失败：'+message,error:message,failure:taskFailure(error,'preview_refresh'),startedAt:now,finishedAt:now,revision:this.required().project.revision,appRecordVersion:1,request:this.recordedRequest('preview',{})};
      try{await this.writeTaskJournal(this.required().root,this.task);}catch{this.task.message+='；任务日志写入失败，请检查工程目录权限';}
    }
  }
  private async persist(next:VideoProject,sources:Record<string,SceneSource>={},label='编辑工程',historyGroup?:string,deferPreview=false){
    const {root,project:current}=this.required();next=structuredClone(next);next.revision=current.revision+1;this.fitAudio(next);
    this.project=await this.store.commit(root,next,sources,{expectedRevision:current.revision,label,historyGroup});
    // Rendering follows the durable commit. A preview failure leaves the new version undoable.
    if(deferPreview&&this.assetBaseUrl){
      this.resolveOutputUrls(this.project,root,this.assetBaseUrl);
      try{compileSpec(this.project);}catch{this.previewUrl=null;this.previewRevision=null;this.audioUrl=null;}
      return;
    }
    await this.refreshAfterCommit();
  }
  private async apply(data:any){
    this.assertIdle();const {root,project:current}=this.required();let project=structuredClone(current);
    const incoming=data.project??{};
    const metadata={...incoming,...data};
    for(const key of ['title','topic'] as const)if(typeof metadata[key]==='string')project[key]=metadata[key];
    if(metadata.targetDuration!==undefined)project.targetDuration=Number(metadata.targetDuration);
    if(metadata.target)project=updateTarget(project,metadata.target);
    if(metadata.graph)project.graph=structuredClone(metadata.graph);
    if(metadata.assets){if(!Array.isArray(metadata.assets))throw new Error('assets须为数组');project.assets=structuredClone(metadata.assets);}
    if(metadata.storyboard){project.shots=normalizeStoryboard(metadata.storyboard,project);project.shotOrder=project.shots.map(s=>s.id);delete project.extensions.graphEdges;}
    if(metadata.shots){if(!Array.isArray(metadata.shots))throw new Error('shots须为数组');project.shots=structuredClone(metadata.shots);project.shotOrder=project.shots.map(s=>s.id);delete project.extensions.graphEdges;}
    if(metadata.shotOrder)project=reorderShots(project,metadata.shotOrder);
    for(const item of metadata.shotPatches??[])project=updateShot(project,item.id??item.shotId,item.patch);
    if(metadata.schemaVersion!==undefined&&(metadata.schemaVersion===2||metadata.schemaVersion===3))project.schemaVersion=metadata.schemaVersion;
    if(metadata.productionPolicy!==undefined)project.productionPolicy=structuredClone(metadata.productionPolicy);
    if('videoStyle' in incoming){if(incoming.videoStyle)project.videoStyle=structuredClone(incoming.videoStyle);else delete project.videoStyle;}
    else if(data.videoStyle!==undefined){if(data.videoStyle)project.videoStyle=structuredClone(data.videoStyle);else delete project.videoStyle;}
    if(metadata.audioClips!==undefined)project.audioClips=structuredClone(metadata.audioClips);
    if(metadata.videoClips!==undefined)project.videoClips=structuredClone(metadata.videoClips);
    if(metadata.overlayClips!==undefined)project.overlayClips=structuredClone(metadata.overlayClips);
    if(metadata.subtitles!==undefined)project.subtitles=structuredClone(metadata.subtitles);
    if(metadata.audioMix!==undefined)project.audioMix=structuredClone(metadata.audioMix);
    if(metadata.sessionIds)project.sessionIds=[...new Set<string>(metadata.sessionIds)];
    if(metadata.extensions)project.extensions={...project.extensions,...metadata.extensions};
    this.fitAudio(project);
    const sources=(metadata.sources??[]).map((item:any)=>{const shot=project.shots.find(s=>s.id===item.shotId);if(!shot)throw new Error('源码引用的镜头不存在');return {shot,source:parseSceneSource(JSON.stringify(item.source))};});
    await this.persist(project,Object.fromEntries(sources.map(({shot,source}:any)=>[shot.id,source])),String(data.label??'应用分镜与源码变更'));
  }
  private fitAudio(project:VideoProject,fitDuration=true):void{
    const check=validateProject(project);if(!check.ok)throw new Error(check.errors.join('\n'));
    if(project.target.audioMode==='none')return;
    const fps=project.target.fps.num/project.target.fps.den;
    for(const clip of project.audioClips??[]){
      if(clip.role!=='voice'||clip.loop)continue;
      const asset=project.assets.find(a=>a.id===clip.assetId)!;
      const end=clip.startSeconds+Math.min(clip.trimEnd??asset.duration!,asset.duration!)-clip.trimStart;
      if(clip.trimStart>=asset.duration!)throw new Error('旁白裁剪起点超出音频长度');
      if(clip.shotId){
        const shot=project.shots.find(s=>s.id===clip.shotId)!;
        if(end>shot.durationFrames/fps+1e-6){
          if(project.extensions.lockDuration===true||!fitDuration)throw new Error(`旁白超出镜头时长 ${(end-shot.durationFrames/fps).toFixed(2)} 秒，请调整裁剪、旁白或解除时长锁定`);
          shot.durationFrames=Math.ceil((end+.25)*fps);
        }
      }else if(end>project.shots.reduce((sum,s)=>sum+s.durationFrames/fps,0)+1e-6)throw new Error('全片旁白超出成片时长，请延长镜头或裁剪音频');
    }
  }
  private withAudioClip(project:VideoProject,assetId:string,data:any):VideoProject{
    const asset=project.assets.find(a=>a.id===assetId&&a.kind==='audio');if(!asset)throw new Error('请选择音频资产');
    const clip:AudioClip={id:randomUUID(),assetId,role:data.role??'voice',shotId:data.shotId,startSeconds:Number(data.startSeconds??0),trimStart:Number(data.trimStart??0),trimEnd:data.trimEnd,volume:Number(data.volume??1),fadeIn:Number(data.fadeIn??0),fadeOut:Number(data.fadeOut??0),loop:!!data.loop};
    project.audioClips=[...(project.audioClips??[]).filter(c=>!data.replaceVoice||c.role!=='voice'||c.shotId!==clip.shotId),clip];project.target.audioMode='mixed';
    this.fitAudio(project,data.fitDuration!==false);project.revision++;return project;
  }
  private assertRevision(data:any,required=false):void {
    const current=this.required().project;
    if(data.expectedRevision===undefined){
      if(required)throw Object.assign(new Error('修改需要 expectedRevision，请先读取最新工程'),{code:'REVISION_REQUIRED'});
      return;
    }
    if(!Number.isSafeInteger(data.expectedRevision)||data.expectedRevision!==current.revision)
      throw Object.assign(new Error(`工程版本冲突：期望 v${data.expectedRevision}，当前 v${current.revision}；请读取最新工程后合并修改`),{code:'REVISION_CONFLICT'});
  }
  /** Every externally requested mutation and background commit shares one project queue. */
  private enqueue<T>(work:()=>Promise<T>):Promise<T>{
    const result=this.commands.then(work);this.commands=result.then(()=>undefined,()=>undefined);return result;
  }
  private async speechSettings():Promise<TtsSettings>{
    try{this.tts={...this.tts,...JSON.parse(await readFile(join(this.baseDirectory,'tts.json'),'utf8'))};delete this.tts.apiKey;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(this.tts.endpoint==='local:say')return {...this.tts};
    return {...this.tts,apiKey:await this.ctx.credentials.get('YINGLIU_TTS_API_KEY')};
  }
  private async redact(text:string):Promise<string>{
    for(const reference of ['YINGLIU_TTS_API_KEY','yingliu.custom-model.api-key']){try{const key=await this.ctx.credentials.get(reference);if(key)text=text.split(key).join('[redacted]');}catch(error){if(!isCredentialError(error))throw error;}}
    return text.replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [redacted]').replace(/\bsk-[a-zA-Z0-9_-]{8,}/g,'[redacted]');
  }
  private async writeTaskJournal(root:string,task:RecordedTask):Promise<void>{
    const folder=await projectPath(root,'.studio/tasks');await mkdir(folder,{recursive:true});
    const file=await projectPath(root,`.studio/tasks/${task.id}.json`),temporary=file+'.tmp-'+randomUUID();
    task.logPath=file;task.message=await this.redact(task.message);if(task.error)task.error=await this.redact(task.error);
    if(task.request){task.request=this.recordedRequest(task.request.endpoint,task.request.payload);if(task.request)for(const key of Object.keys(task.request.payload))task.request.payload[key]=await this.redact(task.request.payload[key]!);}
    try{await writeFile(temporary,JSON.stringify(task,null,2)+'\n');await atomicRename(temporary,file);}
    finally{await rm(temporary,{force:true});}
  }
  private recordedRequest(endpoint:string,data:any):TaskRequest|undefined{
    if(!data||typeof data!=='object'||Array.isArray(data))return;
    if(!['preview','export','generate'].includes(endpoint))return;
    const payload:Record<string,string>={};
    if(endpoint==='generate'){
      if(!['storyboard','scenes','modify'].includes(data.kind)||typeof data.provider!=='string'||typeof data.model!=='string')return;
      for(const key of ['kind','provider','model','shotId','instruction'])if(typeof data[key]==='string')payload[key]=data[key].slice(0,key==='instruction'?100000:200);
    }
    return {endpoint:endpoint as TaskRequest['endpoint'],payload};
  }
  private async taskRecords():Promise<RecordedTask[]>{
    const {root}=this.required();let names:string[];
    try{names=await readdir(await projectPath(root,'.studio/tasks'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    const tasks:RecordedTask[]=[];
    for(const name of names.filter(name=>/^[a-zA-Z0-9_-]+\.json$/.test(name))){
      try{const value=JSON.parse(await readFile(await projectPath(root,'.studio/tasks/'+name),'utf8')) as RecordedTask;
        if(value.id+'.json'!==name||typeof value.startedAt!=='string'||!['storyboard','scenes','modify','preview','export','audio'].includes(value.kind)||!['running','complete','failed','cancelled'].includes(value.status))continue;
        const task:RecordedTask={id:value.id,kind:value.kind,status:value.status,startedAt:value.startedAt,progress:Number.isFinite(value.progress)?value.progress:0,message:await this.redact(String(value.message??'')),logPath:await projectPath(root,'.studio/tasks/'+name),finishedAt:typeof value.finishedAt==='string'?value.finishedAt:undefined,error:typeof value.error==='string'?await this.redact(value.error):undefined,failure:sanitizeTaskFailure(value.failure),shotId:typeof value.shotId==='string'?value.shotId:undefined,appRecordVersion:value.appRecordVersion===1?1:undefined,revision:Number.isSafeInteger(value.revision)?value.revision:undefined,retryOf:typeof value.retryOf==='string'?value.retryOf:undefined,outputId:typeof value.outputId==='string'?value.outputId:undefined};
        const request=value.appRecordVersion===1&&value.request?this.recordedRequest(value.request.endpoint,value.request.payload):undefined;
        if(request&&((request.endpoint==='preview'||request.endpoint==='export')?request.endpoint===value.kind:request.payload.kind===value.kind)){
          for(const key of Object.keys(request.payload))request.payload[key]=await this.redact(request.payload[key]!);task.request=request;
        }
        tasks.push(task);
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    }
    return tasks.sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||b.id.localeCompare(a.id));
  }
  private async recoverTask():Promise<void>{
    if(!this.root)return;const records=await this.taskRecords();
    for(const task of records)if(task.status==='running'){
      task.status='failed';task.message='上次任务已中断 · 可重试';task.error='TASK_INTERRUPTED: 应用退出前任务未完成；请读取当前工程后重试';task.finishedAt=new Date().toISOString();await this.writeTaskJournal(this.root,task);
    }
    this.task=records[0]??null;
  }
  private async start(kind:TaskState['kind'],work:(signal:AbortSignal,task:RecordedTask)=>Promise<void>,shotId?:string,request?:TaskRequest,retryOf?:string):Promise<void>{
    this.assertIdle();const root=this.required().root;
    const task:RecordedTask={id:randomUUID(),kind,status:'running',progress:0,message:'准备中',startedAt:new Date().toISOString(),shotId,appRecordVersion:1,revision:this.required().project.revision,request,retryOf};
    const controller=new AbortController();this.controller=controller;this.task=task;
    try{await this.writeTaskJournal(root,task);}catch(error){task.status='failed';task.failure=taskFailure(error,'task_journal_start');task.error='任务记录保存失败：'+String(error);task.message=task.error;throw error;}
    this.job=(async()=>{
      try{await work(controller.signal,task);controller.signal.throwIfAborted();task.status='complete';task.progress=1;task.message='已完成';}
      catch(error){task.status=controller.signal.aborted?'cancelled':'failed';task.failure=taskFailure(error,'task_work');task.error=error instanceof Error?error.message:String(error);task.message=task.status==='cancelled'?'已取消':task.error;}
      finally{
        task.error=task.error?await this.redact(task.error):undefined;task.message=await this.redact(task.message);task.finishedAt=new Date().toISOString();
        try{await this.writeTaskJournal(root,task);}catch(error){task.status='failed';task.failure=taskFailure(error,'task_journal_finish');task.error='任务结束记录保存失败：'+String(error);task.message=task.error;}
      }
    })();
  }
  private progress(progress:number,message:string){if(this.task?.status==='running'){this.task.progress=progress;this.task.message=message;}}
  private generator(){return new AppSceneGenerator(this.ctx,text=>{if(this.task?.status==='running')this.task.message=`正在生成 · 已收到 ${text.length.toLocaleString()} 字符`;});}
  private patched(project:VideoProject,shotId:string,patch:Partial<Shot>|undefined):VideoProject{
    if(!patch)return project;
    const current=project.shots.find(s=>s.id===shotId);if(!current)return project;
    const safe:Partial<Shot>={};
    for(const key of ['title','intent','composition','action','narration'] as const)if(typeof patch[key]==='string')safe[key]=patch[key];
    if(Number.isInteger(patch.durationFrames)&&patch.durationFrames!>0)safe.durationFrames=patch.durationFrames;
    if(patch.transition==='cut'||patch.transition==='fade')safe.transition=patch.transition;
    const ids=new Set(project.assets.map(a=>a.id));for(const key of ['assetIds','referenceIds'] as const)if(Array.isArray(patch[key]))safe[key]=patch[key]!.filter(id=>ids.has(id));
    if(patch.params&&typeof patch.params==='object')safe.params={...current.params,...patch.params};
    return updateShot(project,shotId,safe);
  }
  private async generateScene(root:string,shotId:string,route:ModelRoute,signal:AbortSignal,instruction?:string){
    const generator=this.generator(),initial=structuredClone(this.required().project),shot=initial.shots.find(s=>s.id===shotId);if(!shot)throw new Error('镜头已不存在');
    const old=await this.store.readSource(root,shot);const source=await generator.scene(initial,shot,route,signal,instruction?old:undefined,instruction);
    signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();this.assertRevision({expectedRevision:initial.revision});const next=this.patched(structuredClone(this.required().project),shotId,source.shotPatch);await this.persist(next,{[shotId]:{html:source.html,css:source.css,js:source.js}},'模型生成镜头',this.task?.id);});
    let checked=await this.renderer.check(root,this.required().project,this.settings,signal);
    if(!checked.ok){
      this.progress(this.task?.progress??0,'发现代码错误，正在修复');
      const errors=checked.errors.filter(e=>!e.shotId||e.shotId===shotId);if(!errors.length)throw renderCheckError(checked);
      const repaired=await generator.scene(this.required().project,this.required().project.shots.find(s=>s.id===shotId)!,route,signal,source,`修复运行错误，保留当前设计和可编辑参数：${JSON.stringify(errors)}`);
      signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();await this.persist(this.required().project,{[shotId]:{html:repaired.html,css:repaired.css,js:repaired.js}},'模型修复镜头',this.task?.id);});checked=await this.renderer.check(root,this.required().project,this.settings,signal);
    }
    if(!checked.ok)throw Object.assign(new Error(checked.errors.map(e=>`镜头 ${e.shotId??shotId} 帧 ${e.frame??'?'}：${e.message}`).join('\n')),{failure:taskFailure(renderCheckError(checked),'render_check')});
    await this.enqueue(()=>this.store.markSourceGood(root,shot));
  }
  async rpc(endpoint:string,payload:unknown):Promise<RpcResult>{
    await this.initialized;
    if(endpoint==='cancel'){this.controller?.abort(new Error('用户已取消'));return {ok:true,value:await this.snapshot()};}
    return this.enqueue(()=>this.performRpc(endpoint,payload));
  }
  private async performRpc(endpoint:string,payload:unknown):Promise<RpcResult>{
    try{
      await this.initialized;if(this.disposed)throw new Error('应用服务已停止');const data=(payload??{}) as any;
      if(['save','apply','saveSource','restoreSource','undo','redo','rename','retry','job.retry','import','audio','video.clip.save','video.clip.remove','video.clip.extract','production.set'].includes(endpoint))this.assertRevision(data,true);
      else if(['generate','export','preview'].includes(endpoint)&&data.expectedRevision!==undefined)this.assertRevision(data);
      switch(endpoint){
        case 'catalog':this.providers=await Promise.all(this.ctx.llm.listProviders().map(async p=>{try{return {...p,models:await this.ctx.llm.listModels(p.id)};}catch(error){return {...p,models:[],error:error instanceof Error?error.message:'模型目录读取失败'};}}));break;
        case 'current':break;
        case 'create':{
          this.assertIdle();let project:VideoProject;
          if(data.project){project=structuredClone(data.project);validateStoredProject(project);validateSources(project,data.sources??[]);for(const item of data.sources??[])parseSceneSource(JSON.stringify(item.source));}
          else{
            project=createProject(String(data.title||'未命名视频'),String(data.topic||''));if(data.target)project=updateTarget(project,data.target);if(data.targetDuration!==undefined)project.targetDuration=Number(data.targetDuration);
            if(data.videoStyle!==undefined)project.videoStyle=normalizeVideoStyle(data.videoStyle);
            if(data.blank===true){project.shots=[];project.shotOrder=[];project.graph={positions:{'film-output':[375,140]},groups:[]};project.extensions.graphEdges=[];}
            project.extensions.brief={profile:String(data.profile??''),preset:String(data.preset??'')};
            if(typeof data.productionMode==='string'&&['code_animation','model_video','hybrid'].includes(data.productionMode)){
              const policy=defaultProductionPolicy(data.productionMode as ProductionMode);
              if(policy.mode==='hybrid')policy.baseMode='code_animation';
              project=applyProductionPolicy(project,policy);project.revision=0;
            }
          }
          this.fitAudio(project);const created=await this.store.create({project,sources:data.sources??[],assetFiles:data.assetFiles??[]});this.root=created.root;this.project=created.project;this.task=null;
          if(!data.project)for(const shot of this.project.shots)await this.store.markSourceGood(this.root,shot).catch(()=>{});await this.refreshAfterCommit();break;
        }
        case 'open':this.assertIdle();this.root=resolve(String(data.path));this.project=await this.store.open(this.root);this.task=null;await this.recoverTask();await this.refreshAfterCommit();break;
        case 'save':{if(this.task?.status==='running'&&this.task.kind!=='export')this.assertIdle();const {project}=this.required();if(!data.project||data.project.id!==project.id)throw new Error('项目已切换，请刷新后重试');const next=structuredClone(data.project) as VideoProject;this.fitAudio(next);await this.persist({...next,outputs:project.outputs},{},'保存工程',undefined,data.deferPreview===true);break;}
        case 'apply':await this.apply(data);break;
        case 'import':{this.assertIdle();const {root,project}=this.required();const asset=await this.store.importAsset(root,data,this.settings);const next=structuredClone(project);next.assets.push(asset);next.graph.positions[asset.id]=[60,80+(next.assets.length-1)*180];await this.persist(next,{},'导入素材');break;}
        case 'video.clip.save':{
          this.assertIdle();const next=structuredClone(this.required().project),raw=data.clip;
          if(!raw||typeof raw!=='object'||!['mute','keep'].includes(raw.audio??'mute'))throw new Error('视频片段参数无效');
          if(!next.shots.some(shot=>shot.id===raw.shotId)||!next.assets.some(asset=>asset.id===raw.assetId&&asset.kind==='video'))throw new Error('请选择当前工程的视频素材和镜头');
          const existing=(next.videoClips??[]).find(clip=>clip.shotId===raw.shotId);
          if(raw.id&&raw.id!==existing?.id)throw new Error('视频片段已变化，请刷新');
          const clip:VideoClip={id:existing?.id??randomUUID(),shotId:raw.shotId,assetId:raw.assetId,trimStart:Number(raw.trimStart??0),...(raw.trimEnd!==undefined?{trimEnd:Number(raw.trimEnd)}:{}),speed:Number(raw.speed??1),fit:raw.fit??'cover',audio:raw.audio??'mute'};
          next.schemaVersion=2;next.videoClips=[...(next.videoClips??[]).filter(item=>item.shotId!==clip.shotId),clip];if(clip.audio==='keep')next.target.audioMode='mixed';await this.persist(next,{},'保存视频片段');break;
        }
        case 'video.clip.remove':{
          this.assertIdle();const next=structuredClone(this.required().project);if(!next.videoClips?.some(clip=>clip.id===data.clipId))throw new Error('视频片段不存在');
          next.videoClips=next.videoClips.filter(clip=>clip.id!==data.clipId);await this.persist(next,{},'移除视频片段');break;
        }
        case 'video.clip.extract':{
          this.assertIdle();const {root,project}=this.required(),next=structuredClone(project),clip=next.videoClips?.find(item=>item.id===data.clipId);
          if(!clip)throw new Error('视频片段不存在');const video=next.assets.find(asset=>asset.id===clip.assetId)!;
          const audio=await extractVideoAudio(root,video,clip,this.settings);next.assets.push(audio);clip.audio='mute';
          const shot=next.shots.find(item=>item.id===clip.shotId)!;
          next.audioClips=[...(next.audioClips??[]),{id:randomUUID(),assetId:audio.id,role:'sfx',shotId:clip.shotId,startSeconds:0,trimStart:0,trimEnd:Math.min(audio.duration!,shot.durationFrames*next.target.fps.den/next.target.fps.num),volume:1,fadeIn:0,fadeOut:0}];next.target.audioMode='mixed';await this.persist(next,{},'提取视频原声');break;
        }
        case 'tts':{
          this.assertIdle();const options:Partial<TtsSettings>={};for(const key of ['endpoint','model','voice','speed','enabled'] as const)if(data[key]!==undefined)(options as any)[key]=data[key];
          const next={...this.tts,...options},file=join(this.baseDirectory,'tts.json'),temporary=file+'.tmp-'+randomUUID();
          const onlyClearingKey=data.apiKey!==undefined&&!String(data.apiKey).trim()&&!Object.keys(options).length;
          if(!onlyClearingKey)validateTtsSettings(next,detectEnvironment(this.settings));
          const commit=async()=>{await mkdir(this.baseDirectory,{recursive:true});await writeFile(temporary,JSON.stringify(next,null,2));await atomicRename(temporary,file);this.tts=next;};
          try{if(data.apiKey===undefined)await commit();else await updateCredential(this.ctx.credentials,'YINGLIU_TTS_API_KEY',String(data.apiKey).trim()||undefined,commit);}
          finally{await rm(temporary,{force:true});}break;
        }
        case 'audio':{
          this.assertIdle();const {root,project}=this.required(),operation=data.operation??data.action;
          if(operation==='synthesize'||operation==='tts'){
            const shot=project.shots.find(s=>s.id===data.shotId);const text=String(data.text??shot?.narration??'').trim();if(!text)throw new Error('请先填写旁白');
            await this.start('audio',async signal=>{this.progress(.1,'生成配音');const asset=await this.speech.synthesize(root,{text,name:shot?shot.title+' · 配音':'配音'},await this.speechSettings(),this.settings,signal);signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();const next=structuredClone(this.required().project);next.assets.push(asset);const currentShot=next.shots.find(s=>s.id===data.shotId);if(currentShot)currentShot.narration=text;await this.persist(this.withAudioClip(next,asset.id,{...data,role:'voice',replaceVoice:true}),{},'生成配音');});},data.shotId);
          }else if(operation==='add'||operation==='bind'){await this.persist(this.withAudioClip(structuredClone(project),data.assetId??data.clip?.assetId,{...data,...data.clip}),{},'添加音轨');}
          else if(operation==='update'){const next=structuredClone(project),clip=next.audioClips?.find(c=>c.id===data.clipId);if(!clip)throw new Error('音频片段不存在');Object.assign(clip,data.patch);this.fitAudio(next,data.fitDuration!==false);await this.persist(next,{},operation==='update'?'修改音轨':'删除音轨');}
          else if(operation==='remove'){const next=structuredClone(project);next.audioClips=next.audioClips?.filter(c=>c.id!==data.clipId);await this.persist(next,{},operation==='update'?'修改音轨':'删除音轨');}
          else if(operation==='import'){const asset=await this.store.importAsset(root,data,this.settings);const next=structuredClone(project);next.assets.push(asset);await this.persist(this.withAudioClip(next,asset.id,data),{},'导入音频');}
          else throw new Error('音频操作无效');break;
        }
        case 'audio.sfx':{
          const {root,project}=this.required();
          if(data.projectId!==undefined&&data.projectId!==project.id)throw new Error('工程已切换，请刷新后重试');
          if(!Number.isSafeInteger(data.expectedRevision))this.assertRevision(data,true);
          const requestId=data.requestId===undefined?randomUUID():data.requestId;
          if(typeof requestId!=='string'||requestId.length<1||requestId.length>300)throw new Error('导入 requestId 须为 1–300 字符');
          const sfxName=String(data.name||'本地音效').trim().slice(0,60)||'本地音效';
          const placement={role:'sfx' as const,shotId:data.shotId,startSeconds:data.startSeconds,trimStart:data.trimStart,trimEnd:data.trimEnd,volume:data.volume,fadeIn:data.fadeIn,fadeOut:data.fadeOut,loop:data.loop,fitDuration:data.fitDuration};
          const key=createHash('sha256').update(requestId).digest('hex');
          const digest=createHash('sha256').update(JSON.stringify({name:sfxName,spec:data.spec,placement})).digest('hex');
          const existing=(project.extensions.importRequests as Record<string,{digest:string;assetId:string}>|undefined)?.[key];
          if(existing){
            if(existing.digest!==digest)throw Object.assign(new Error('相同导入请求 ID 不能用于不同内容'),{code:'IMPORT_REQUEST_CONFLICT'});
            break;
          }
          this.assertRevision(data,true);
          this.assertIdle();
          const bytes=synthesizeLocalSfx(data.spec);
          const asset=await this.store.importAsset(root,{name:sfxName+'.wav',mime:'audio/wav',dataBase64:Buffer.from(bytes).toString('base64')},this.settings);
          const next=structuredClone(project);
          next.assets.push(asset);
          next.graph.positions[asset.id]=[60,80+(next.assets.length-1)*180];
          next.extensions={...next.extensions,importRequests:{...(next.extensions.importRequests as Record<string,unknown>|undefined),[key]:{digest,assetId:asset.id}}};
          try{this.withAudioClip(next,asset.id,placement);}
          catch(error){
            if(asset.path)await projectPath(root,asset.path).then(file=>rm(file,{force:true})).catch(()=>{});
            throw error;
          }
          await this.persist(next,{},'合成并导入本地音效');
          break;
        }
        case 'inspect':{const {root,project}=this.required();const spec=compileSpec(project);const shot=project.shots.find(s=>s.id===data.shotId);const source=shot&&data.includeSource?await this.store.readSource(root,shot):undefined;let frame;
          if(data.frame!==undefined)frame=await this.renderer.capture(root,project,this.settings,Number(data.frame),data.signal instanceof AbortSignal?data.signal:undefined);
          return {ok:true,value:{projectId:project.id,revision:project.revision,spec,source,frame}};
        }
        case 'thumbnails':{
          const {root,project}=this.required();
          if(data.projectId!==project.id)throw new Error('缩略图请求必须指定当前工程 ID');
          this.assertRevision(data,true);
          this.assertIdle();
          const frames=await this.renderer.thumbnails(root,project,this.settings,data.frames);
          return {ok:true,value:{projectId:project.id,revision:project.revision,frames}};
        }
        case 'source':{const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');return {ok:true,value:await this.store.readSource(root,shot)};}
        case 'saveSource':{this.assertIdle();const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');const source=parseSceneSource(JSON.stringify(data.source));await this.persist(project,{[shot.id]:source},'保存镜头源码');await this.start('preview',async signal=>{const checked=await this.renderer.check(root,this.required().project,this.settings,signal);if(!checked.ok)throw renderCheckError(checked);await this.store.markSourceGood(root,shot);},shot.id,this.recordedRequest('preview',data));break;}
        case 'restoreSource':{this.assertIdle();const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');const source=await this.store.restorationSource(root,shot);await this.persist(project,{[shot.id]:source},'恢复镜头源码');break;}
        case 'preview':{
          const {root,project}=this.required();
          if(data.prepareOnly===true){
            if(data.projectId!==project.id)throw new Error('预览请求必须指定当前工程 ID');
            this.assertRevision(data,true);
            this.assertIdle();
            compileSpec(project);
            await this.refreshPreview();
            break;
          }
          compileSpec(project);
          await this.start('preview',async signal=>{await this.refreshPreview();signal.throwIfAborted();this.progress(.1,'检查资源与关键帧');const checked=await this.renderer.check(root,this.required().project,this.settings,signal);if(!checked.ok)throw renderCheckError(checked);for(const shot of this.required().project.shots)await this.store.markSourceGood(root,shot);},undefined,this.recordedRequest('preview',data),data._retryOf);break;
        }
        case 'generate':{
          const {root,project}=this.required(),route={provider:String(data.provider??''),model:String(data.model??'')},kind=data.kind as 'storyboard'|'scenes'|'modify';if(!['storyboard','scenes','modify'].includes(kind))throw new Error('生成类型无效');
          await this.start(kind,async signal=>{
            if(kind==='storyboard'){
              const shots=await this.generator().storyboard(structuredClone(project),route,signal);signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();this.assertRevision({expectedRevision:project.revision});const current=structuredClone(this.required().project);
              current.shots=shots;current.shotOrder=shots.map(s=>s.id);delete current.extensions.graphEdges;current.revision++;
              for(let i=0;i<shots.length;i++)current.graph.positions[shots[i]!.id]=[420+i*340,160];current.graph.positions['film-output']=[420+shots.length*340,160];await this.persist(current,Object.fromEntries(shots.map(s=>[s.id,defaultSceneSource()])),'模型生成分镜',this.task?.id);});
            }else{
              compileSpec(this.required().project);const ids=data.shotId?[String(data.shotId)]:[...this.required().project.shotOrder];
              for(let i=0;i<ids.length;i++){signal.throwIfAborted();this.progress(i/ids.length,`生成镜头 ${i+1}/${ids.length}`);await this.generateScene(root,ids[i]!,route,signal,kind==='modify'?String(data.instruction??'改进画面与动作，保留内容'):undefined);}
            }
          },data.shotId,this.recordedRequest('generate',data),data._retryOf);break;
        }
        case 'export':{const {root,project}=this.required();compileSpec(project);const snapshot=structuredClone(project);await this.start('export',async(signal,task)=>{const result=await this.renderer.export(root,snapshot,this.settings,signal,(p,m)=>this.progress(p,m));signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();const current=structuredClone(this.required().project);current.outputs.push(result);await this.persist(current,{},'导出成片记录');task.outputId=result.id;if(!result.url&&this.previewUrl)result.url=new URL(relative(root,result.path).split('/').map(encodeURIComponent).join('/'),this.previewUrl).href;});},undefined,this.recordedRequest('export',data),data._retryOf);break;}
        case 'history':return {ok:true,value:await this.store.history(this.required().root)};
        case 'undo':case 'redo':{this.assertIdle();this.project=await this.store.moveHistory(this.required().root,endpoint,data.expectedRevision);await this.refreshAfterCommit();break;}
        case 'rename':{this.assertIdle();if(typeof data.title!=='string'||!data.title.trim())throw new Error('工程名称不能为空');const next=structuredClone(this.required().project);next.title=data.title.trim();await this.persist(next,{},'重命名工程');break;}
        case 'duplicate':{this.assertIdle();if(data.expectedRevision!==undefined)this.assertRevision(data);return {ok:true,value:await this.store.duplicate(this.required().root,data.title)};}
        case 'tasks':case 'jobs':{const tasks=await this.taskRecords();return {ok:true,value:{tasks:tasks.map(task=>({...task,retryable:!!task.request&&task.status!=='running'}))}};}
        case 'retry':case 'job.retry':{
          this.assertIdle();const task=(await this.taskRecords()).find(task=>task.id===data.taskId);
          if(!task||!task.request||task.status==='running')throw new Error('此任务没有可重试的本应用请求记录');
          return this.performRpc(task.request.endpoint,{...task.request.payload,expectedRevision:data.expectedRevision,_retryOf:task.id});
        }
        case 'cancel':this.controller?.abort(new Error('用户已取消'));break;
        case 'production.set':{
          this.assertIdle();const current=this.required().project;
          const mode=(data.mode??'unresolved') as ProductionMode;
          const base=defaultProductionPolicy(mode);
          const policy:ProductionPolicy={
            ...base,
            allowGeneratedImages:Boolean(data.allowGeneratedImages),
            allowImportedVideo:Boolean(data.allowImportedVideo),
            ...(mode==='hybrid'?{baseMode:(data.baseMode==='model_video'?'model_video':'code_animation') as 'code_animation'|'model_video'}:{}),
            ...(mode==='hybrid'&&Array.isArray(data.shotIds)&&data.shotIds.length?{hybridGrants:[{id:randomUUID(),projectId:current.id,shotIds:data.shotIds.map(String),operations:(Array.isArray(data.operations)&&data.operations.length?data.operations:['code','video']) as ('code'|'video')[],confirmedAt:new Date().toISOString()}]}:{}),
          };
          const next=applyProductionPolicy(current,policy);
          await this.persist(next,{},'更新制作策略');break;
        }
        case 'director.document.save':{
          this.assertIdle();const current=this.required().project;
          const document=saveDirectorDocument(current,data.plan,{expectedVersion:Number(data.expectedVersion??0)});
          const next=structuredClone(current);next.extensions={...next.extensions,directorDocument:document};
          await this.persist(next,{},'保存导演计划草稿');
          return {ok:true,value:{document,snapshot:await this.snapshot()}};
        }
        case 'director.document.approve':{
          this.assertIdle();const current=this.required().project;
          const document=approveDirectorDocument(current,{expectedVersion:Number(data.expectedVersion),expectedHash:String(data.expectedHash??'')});
          const next=structuredClone(current);next.extensions={...next.extensions,directorDocument:document};
          await this.persist(next,{},'批准导演计划');
          return {ok:true,value:{document,snapshot:await this.snapshot()}};
        }
        case 'quality.check':{
          const {root,project}=this.required();
          const sources:Record<string,SceneSource>={};
          for(const shot of project.shots)sources[shot.id]=await this.store.readSource(root,shot).catch(()=>defaultSceneSource());
          const requested=localQualityFrames(project,Number.isSafeInteger(data.maxFrames)?Number(data.maxFrames):12);
          const samples:LocalQualityFrame[]=[];
          for(const item of requested){
            try{
              const captured=await this.renderer.capture(root,project,this.settings,item.frame);
              samples.push({shotId:item.shotId,frame:item.frame,bytes:await readFile(captured.path)});
            }catch(error){
              samples.push({shotId:item.shotId,frame:item.frame,error:error instanceof Error?error.message:String(error)});
            }
          }
          const report=localExportQuality(project,sources,samples);
          const reportFile=await projectPath(root,'.studio/local-quality.json');
          await mkdir(join(root,'.studio'),{recursive:true});
          await writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
          return {ok:true,value:report};
        }
        case 'quality.last':{
          const {root}=this.required();
          try{
            const raw=await readFile(await projectPath(root,'.studio/local-quality.json'),'utf8');
            return {ok:true,value:JSON.parse(raw) as LocalQualityReport};
          }catch(error){
            if((error as NodeJS.ErrnoException).code==='ENOENT')return {ok:true,value:null};
            throw error;
          }
        }
        case 'media.deconstruct':{
          const {root,project}=this.required();
          const asset=project.assets.find(item=>item.id===String(data.assetId??'')&&item.kind==='video');
          if(!asset?.path)throw new Error('请选择当前工程内已有的视频素材进行拉片拆解');
          const file=await projectPath(root,asset.path);
          const analysis=await deconstructReferenceVideo(file,this.settings,{threshold:typeof data.threshold==='number'?data.threshold:undefined});
          return {ok:true,value:{assetId:asset.id,name:asset.name,...analysis}};
        }
        case 'audio.analyze':{
          const {root,project}=this.required();
          if(typeof data.assetId==='string'&&data.assetId){
            const asset=project.assets.find(item=>item.id===data.assetId&&(item.kind==='audio'||item.kind==='video'));
            if(!asset?.path)throw new Error('未找到指定的音视频资产');
            const file=await projectPath(root,asset.path);
            return {ok:true,value:{scope:'asset',assetId:asset.id,name:asset.name,...await analyzeAudioAcoustics(file,this.settings)}};
          }
          const mixer=new AudioMixer();
          try{
            const mixed=await mixer.mix(root,project,this.settings);
            if(!mixed)return {ok:true,value:{scope:'mix',empty:true,integratedLufs:null,loudnessRangeLu:null,truePeakDbtp:null,clippingRisk:false,tooQuiet:false,silenceIntervals:[],totalSilenceSeconds:0}};
            return {ok:true,value:{scope:'mix',durationSeconds:mixed.duration,...await analyzeAudioAcoustics(mixed.path,this.settings)}};
          }finally{await mixer.close();}
        }
        case 'delivery.export':{
          const {root,project}=this.required();
          compileSpec(project);
          const formats=Array.isArray(data.formats)&&data.formats.length?data.formats.map(String):['srt','ass','otio','fcpxml','edl'];
          const folderRel=`exports/delivery-${project.revision}-${Date.now().toString(36)}`;
          const folder=await projectPath(root,folderRel);
          await mkdir(folder,{recursive:true});
          const cues=deriveSubtitles(project);
          const written:{format:string;relativePath:string;bytes:number}[]=[];
          for(const fmt of formats){
            let filename='',content='';
            if(fmt==='srt'){filename='subtitles.srt';content=formatSrt(cues);}
            else if(fmt==='ass'){filename='subtitles.ass';content=formatAss(cues,project.target,project.title);}
            else if(fmt==='otio'){filename='timeline.otio';content=formatOtio(project);}
            else if(fmt==='fcpxml'){filename='timeline.fcpxml';content=formatFcpxml(project);}
            else if(fmt==='edl'){filename='timeline.edl';content=formatEdl(project);}
            else continue;
            const targetFile=join(folder,filename);
            await writeFile(targetFile,content,'utf8');
            written.push({format:fmt,relativePath:`${folderRel}/${filename}`,bytes:Buffer.byteLength(content,'utf8')});
          }
          return {ok:true,value:{projectId:project.id,revision:project.revision,subtitleCount:cues.length,files:written}};
        }
        case 'media.assetDataUrl':{
          const {root,project}=this.required();
          const asset=project.assets.find(item=>item.id===String(data.assetId??''));
          if(!asset?.path)throw new Error('素材不存在');
          const file=await projectPath(root,asset.path);
          const bytes=await readFile(file);
          if(bytes.byteLength>32*1024*1024)throw new Error('用于内联驱动的单个音视频素材不得超过 32 MiB');
          const fallbackMime=asset.kind==='video'?'video/mp4':asset.kind==='audio'?'audio/wav':'image/png';
          return {ok:true,value:{assetId:asset.id,mime:asset.mime||fallbackMime,dataUrl:`data:${asset.mime||fallbackMime};base64,${bytes.toString('base64')}`}};
        }
        case 'environment':this.assertIdle();if(data.maxVideoBytes!==undefined){if(!Number.isSafeInteger(data.maxVideoBytes)||data.maxVideoBytes<1||data.maxVideoBytes>512*1024*1024)throw new Error('单个视频文件上限须为 1 字节至 512 MiB');this.settings.maxVideoBytes=data.maxVideoBytes;}for(const key of ['browserPath','ffmpegPath','ffprobePath','blenderPath'] as const)if(data[key]!==undefined){if(typeof data[key]!=='string')throw new Error('执行文件路径须为字符串');this.settings[key]=data[key];}await mkdir(this.baseDirectory,{recursive:true});await writeFile(join(this.baseDirectory,'environment.json'),JSON.stringify(this.settings,null,2));break;
        case 'reveal':{const {root}=this.required(),target=await projectOpenPath(root,data.path==null?root:String(data.path));if(!this.ctx.reveal)throw new Error('当前运行器没有文件打开服务');await this.ctx.reveal(target);break;}
        default:throw new Error('未找到应用操作');
      }
      return {ok:true,value:await this.snapshot()};
    }catch(error){return {ok:false,error:{code:error instanceof Error&&'code' in error?String(error.code):'STUDIO_ERROR',message:error instanceof Error?error.message:String(error)}};}
  }
  async renderPreviz(spec:PrevizSceneSpec,options:{shotId?:string;name?:string;bindPreviewClip?:boolean;signal?:AbortSignal}={}):Promise<{imageAssetId:string;depthAssetId?:string;videoAssetId?:string;width:number;height:number;fps:number;frameCount:number;revision:number}>{
    await this.initialized;
    const {root}=this.required();
    const rendered=await this.blender.renderPreviz(root,spec,this.settings,{signal:options.signal});
    options.signal?.throwIfAborted();
    return this.enqueue(async()=>{
      options.signal?.throwIfAborted();
      const {root:currentRoot,project}=this.required();
      const label=(options.name||'白模预演').trim().slice(0,80)||'白模预演';
      const imageAsset=await this.store.importAsset(currentRoot,{name:`${label} · 预演帧.png`,description:'Blender 白模空间预演关键帧（参考用）',mime:'image/png',dataBase64:`data:image/png;base64,${Buffer.from(rendered.keyframePng).toString('base64')}`},this.settings);
      imageAsset.provenance={origin:'code_render',usage:'reference_only'};
      let depthAsset:Asset|undefined;
      if(rendered.depthPng){
        depthAsset=await this.store.importAsset(currentRoot,{name:`${label} · 深度图.png`,description:'Blender 空间景深遮罩图（构图与空间控制参考用）',mime:'image/png',dataBase64:`data:image/png;base64,${Buffer.from(rendered.depthPng).toString('base64')}`},this.settings);
        depthAsset.provenance={origin:'code_render',usage:'reference_only'};
      }
      let videoAsset:Asset|undefined;
      if(rendered.videoMp4){
        videoAsset=await this.store.importAsset(currentRoot,{name:`${label} · 白模预演.mp4`,description:'Blender 白模动态预演视频（审阅用）',mime:'video/mp4',dataBase64:`data:video/mp4;base64,${Buffer.from(rendered.videoMp4).toString('base64')}`},this.settings);
        videoAsset.provenance={origin:'code_render',usage:'reference_only'};
      }
      const next=structuredClone(project);
      next.assets.push(imageAsset);
      next.graph.positions[imageAsset.id]=[60,80+(next.assets.length-1)*180];
      if(depthAsset){
        next.assets.push(depthAsset);
        next.graph.positions[depthAsset.id]=[60,80+(next.assets.length-1)*180];
      }
      if(videoAsset){
        next.assets.push(videoAsset);
        next.graph.positions[videoAsset.id]=[60,80+(next.assets.length-1)*180];
      }
      if(options.shotId){
        const shot=next.shots.find(item=>item.id===options.shotId);
        if(shot){
          if(!shot.referenceIds.includes(imageAsset.id))shot.referenceIds.push(imageAsset.id);
          if(depthAsset&&!shot.referenceIds.includes(depthAsset.id))shot.referenceIds.push(depthAsset.id);
          if(videoAsset&&options.bindPreviewClip&&next.schemaVersion!==3){
            next.videoClips=[...(next.videoClips??[]).filter(item=>item.shotId!==shot.id),{id:randomUUID(),shotId:shot.id,assetId:videoAsset.id,trimStart:0,speed:1,fit:'cover',audio:'mute'}];
          }
        }
      }
      await this.persist(next,{},'Blender 白模预演');
      return {imageAssetId:imageAsset.id,...(depthAsset?{depthAssetId:depthAsset.id}:{}),...(videoAsset?{videoAssetId:videoAsset.id}:{}),width:rendered.width,height:rendered.height,fps:rendered.fps,frameCount:rendered.frameCount,revision:this.required().project.revision};
    });
  }
  async dispose(){
    this.disposed=true;this.controller?.abort(new Error('应用已停止'));await Promise.allSettled([this.initialized,this.commands,this.job]);await this.commands.catch(()=>{});
    const results=await Promise.allSettled([this.speech.close(),this.blender.close(),this.renderer.close()]);const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
  }
}
