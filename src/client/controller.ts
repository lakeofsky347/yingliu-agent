import type { ModelRoute, SceneSource, StudioApi, StudioSnapshot, VideoProject, VideoStyle } from '../shared/types.ts';
import { SourceDraftStore, type SourceDraft } from './source-drafts.ts';

export interface ProjectHistory {canUndo:boolean;canRedo:boolean;entries:{id:string;label:string;createdAt:string;revision:number}[];cursor:number}
export interface EditUndo {available:()=>boolean;run:()=>Promise<boolean>}
export interface StudioState {
  snapshot:StudioSnapshot|null;loading:boolean;pending:boolean;previewing?:boolean;saving:boolean;dirty:boolean;sourceDraft:boolean;sourceDraftCount:number;draftSerial:number;panelDraft:string;conflict:boolean;styles:VideoStyle[];
  error:string;notice:string;scheme:'light'|'dark';selected:string|null;route:ModelRoute;
  canUndo:boolean;canRedo:boolean;history:ProjectHistory|null;localImages:Record<string,string>;focusFrame:number|null;focusSerial:number;
}
export interface YingliuBridge {
  call(endpoint:string,payload?:unknown):Promise<import('../shared/types.ts').RpcResult>;
  pickProject?():Promise<string|null>;
  pickExecutable?():Promise<string|null>;
  resetScene?():Promise<{reset:boolean}>;
  readSourceDrafts?():Promise<string|null>;
  writeSourceDrafts?(contents:string):Promise<void>;
  exportProject?(projectId:string):Promise<import('../shared/types.ts').RpcResult<{name:string;path?:string;dataBase64?:string;size:number}>|null>;
  importProject?():Promise<import('../shared/types.ts').RpcResult<StudioSnapshot>|null>;
  onBeforeClose?(handler:()=>Promise<{ok:boolean;message?:string}>):()=>void;
}
declare global {interface Window {yingliu?:YingliuBridge}}
export class StudioRequestError extends Error {constructor(message:string,readonly code:string){super(message);this.name='StudioRequestError';}}
export class StandaloneStudioApi implements StudioApi {
  async call<T>(endpoint:string,payload:unknown={}):Promise<T>{
    let response:import('../shared/types.ts').RpcResult;
    if(window.yingliu)response=await window.yingliu.call(endpoint,payload);
    else{
      const token=document.querySelector<HTMLMetaElement>('meta[name="yingliu-token"]')?.content;
      const http=await fetch(`/api/${encodeURIComponent(endpoint)}`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'X-Yingliu-Token':token}:{})},body:JSON.stringify(payload)});
      try{response=await http.json() as import('../shared/types.ts').RpcResult;}catch{throw new Error(`本地应用服务未返回有效数据（HTTP ${http.status}）。`);}
      if(!http.ok&&response.ok)throw new Error(`应用服务请求失败（HTTP ${http.status}）`);
    }
    if(!response||typeof response.ok!=='boolean')throw new Error('应用服务响应格式错误');
    if(!response.ok)throw new StudioRequestError(response.error.message,response.error.code);
    return response.value as T;
  }
}
/** One owner for edits, persisted history, revision checks, and project task polling. */
export class StudioController {
  private state:StudioState={snapshot:null,loading:true,pending:false,previewing:false,saving:false,dirty:false,sourceDraft:false,sourceDraftCount:0,draftSerial:0,panelDraft:'',conflict:false,styles:[],error:'',notice:'',scheme:'dark',selected:null,route:{provider:'',model:''},canUndo:false,canRedo:false,history:null,localImages:{},focusFrame:null,focusSerial:0};
  private listeners=new Set<()=>void>();private disposed=false;
  private saveTimer:ReturnType<typeof setTimeout>|undefined;private pollTimer:ReturnType<typeof setTimeout>|undefined;
  private sourceDraftDirty=false;private panelDrafts=new Map<string,string>();private loadSerial=0;
  private editSerial=0;private savedEditSerial=0;private dirty=false;private savingPromise:Promise<void>|null=null;private saveFailed=false;
  private polling=false;private actionEpoch=0;private snapshotReadSerial=0;private serverRevision:number|null=null;private serverProjectId:string|null=null;
  private creativeHandler:((kind:'storyboard'|'scenes'|'modify',instruction:string,shotId?:string)=>Promise<void>)|null=null;
  private readonly drafts:SourceDraftStore;
  constructor(readonly api:StudioApi,drafts?:SourceDraftStore){this.drafts=drafts??new SourceDraftStore();}
  getSnapshot=():StudioState=>this.state;
  subscribe=(fn:()=>void):(()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private update(patch:Partial<StudioState>):void{if(this.disposed)return;this.state={...this.state,...patch};for(const fn of this.listeners)fn();}
  private draftState(projectId=this.state.snapshot?.project?.id):Pick<StudioState,'sourceDraft'|'sourceDraftCount'|'draftSerial'>{const count=projectId?this.drafts.list(projectId).length:0;return {sourceDraft:count>0||this.sourceDraftDirty,sourceDraftCount:count,draftSerial:this.state.draftSerial+1};}
  private accept(snapshot:StudioSnapshot,protectDraft=true,ownSave=false):void{
    const previousRevision=this.serverRevision;
    const previous=this.state.snapshot?.project||null;const same=previous?.id===snapshot.project?.id;
    if(!same&&(this.sourceDraftDirty||this.panelDrafts.size))throw new Error(this.unsavedMessage);
    const keepProject=protectDraft&&same&&this.dirty;const conflict=keepProject&&!ownSave&&snapshot.project?.revision!==this.serverRevision;
    if(!keepProject||ownSave){this.serverProjectId=snapshot.project?.id??null;this.serverRevision=snapshot.project?.revision??null;}
    if(ownSave&&same&&snapshot.project&&previousRevision!==null)for(const draft of this.drafts.list(snapshot.project.id)){if(draft.baseRevision===previousRevision)this.drafts.set({...draft,baseRevision:snapshot.project.revision});}
    const project=keepProject?previous:snapshot.project,changed=project?.id!==previous?.id;
    if(changed){this.dirty=false;this.update({history:null,canUndo:false,canRedo:false,localImages:{}});}
    const route=this.state.route;
    const available=snapshot.providers.filter(provider=>provider.id!=='demo');
    const provider=available.find(p=>p.id===route.provider)||available.find(p=>p.models.length);
    const model=provider?.models.find(m=>m.id===route.model)||provider?.models[0];
    const selected=this.state.selected;
    this.update({snapshot:{...snapshot,project},loading:false,dirty:this.dirty,...this.draftState(project?.id),
      ...(Array.isArray(snapshot.styles)?{styles:snapshot.styles}:{}),
      ...(changed?{selected:null,focusFrame:null,conflict:false}:{}),...(conflict?{conflict:true,error:'工程已在其他操作中更新。本地修改已保留；请先导出本地副本，再重新载入已保存版本。'}:{}),
      ...(!selected||project?.shots.some(s=>s.id===selected)||project?.assets.some(a=>a.id===selected)?{}:{selected:null}),route:{provider:provider?.id||'',model:model?.id||''}});
    if(snapshot.task?.status==='running')this.schedulePoll();
  }
  async load(force=false):Promise<void>{
    if(this.state.pending)return;const serial=++this.loadSerial,epoch=this.actionEpoch;
    try{const snapshot=await this.api.call<StudioSnapshot>('catalog');if(serial!==this.loadSerial||epoch!==this.actionEpoch||this.state.pending)return;
      if(snapshot.project?.id!==this.state.snapshot?.project?.id&&(this.sourceDraftDirty||this.panelDrafts.size))throw new Error(this.unsavedMessage);
      if(force){this.dirty=false;this.update({dirty:false,conflict:false,saving:false});}this.accept(snapshot,!force);if(!this.state.conflict)this.update({error:''});await this.refreshHistory();
    }catch(error){if(serial===this.loadSerial&&epoch===this.actionEpoch)this.update({loading:false,error:message(error)});}
  }
  private snapshotReadGuard(projectId:string):()=>boolean{
    const epoch=this.actionEpoch,revision=this.serverRevision,edits=this.editSerial,read=++this.snapshotReadSerial;
    return()=>!this.disposed&&!this.state.pending&&!this.dirty&&this.state.snapshot?.project?.id===projectId&&this.actionEpoch===epoch&&this.serverRevision===revision&&this.editSerial===edits&&this.snapshotReadSerial===read;
  }
  async refreshHistory():Promise<void>{
    const projectId=this.state.snapshot?.project?.id;if(!projectId)return;
    try{const history=await this.api.call<ProjectHistory>('history',{projectId});if(this.state.snapshot?.project?.id===projectId&&Array.isArray(history.entries))this.update({history,canUndo:history.canUndo,canRedo:history.canRedo});}catch{/* A history read never discards an unsaved draft. */}
  }
  async refreshStyles():Promise<void>{try{const result=await this.api.call<{styles:VideoStyle[]}>('styles.list');if(Array.isArray(result.styles))this.update({styles:result.styles});}catch{/* A style-library read never blocks opening an existing project. */}}
  async saveStyle(style:Partial<VideoStyle>):Promise<VideoStyle>{const result=await this.api.call<{style:VideoStyle;styles:VideoStyle[]}>('styles.save',{style});if(Array.isArray(result.styles))this.update({styles:result.styles});return result.style;}
  async deleteStyle(id:string):Promise<void>{const result=await this.api.call<{styles:VideoStyle[]}>('styles.delete',{id});if(Array.isArray(result.styles))this.update({styles:result.styles});}
  async focusProject(project:string|{projectId?:string;path?:string;sessionId?:string;shotId?:string;frame?:number},focus:{shotId?:string;frame?:number;sessionId?:string}={}):Promise<void>{
    const payload=typeof project==='string'?{projectId:project,...focus}:project;await this.action('focus',payload);
    if(this.state.error)throw new Error(this.state.error);if(payload.projectId&&this.state.snapshot?.project?.id!==payload.projectId)throw new Error('工程定位未完成');
    const selected=payload.shotId??this.state.snapshot?.focus?.shotId;if(selected)this.select(selected);
    const frame=payload.frame??this.state.snapshot?.focus?.frame;if(frame!==undefined)this.update({focusFrame:frame,focusSerial:this.state.focusSerial+1});
  }
  async bindSession(sessionId:string):Promise<void>{await this.action('bindSession',{sessionId},'工程已关联到会话');}
  async audio(payload:unknown):Promise<void>{await this.action('audio',payload);}
  private schedulePoll():void{if(this.disposed||this.polling||this.pollTimer)return;this.pollTimer=setTimeout(()=>{this.pollTimer=undefined;void this.poll();},700);}
  private async poll():Promise<void>{
    if(this.disposed||this.polling)return;this.polling=true;const epoch=this.actionEpoch;
    try{const snapshot=await this.api.call<StudioSnapshot>('current',{projectId:this.state.snapshot?.project?.id});if(epoch===this.actionEpoch&&!this.state.pending){this.accept(snapshot);if(snapshot.task?.status!=='running')await this.refreshHistory();}}catch(error){this.update({error:message(error)});}
    finally{this.polling=false;if(this.state.snapshot?.task?.status==='running')this.schedulePoll();}
  }
  setScheme=(scheme:'light'|'dark'):void=>this.update({scheme});select=(selected:string|null):void=>{if(this.sourceDraftDirty&&selected!==this.state.selected){this.update({error:'前端源码尚未保存，请保存源码后再切换镜头。'});return;}this.update({selected});};
  setSourceDraftDirty(value:boolean):void{if(this.sourceDraftDirty===value)return;this.sourceDraftDirty=value;this.update(this.draftState());}
  getSourceDraft(shotId:string,projectId=this.state.snapshot?.project?.id):SourceDraft|undefined{return projectId?this.drafts.get(projectId,shotId):undefined;}
  sourceDrafts(projectId=this.state.snapshot?.project?.id):SourceDraft[]{return projectId?this.drafts.list(projectId):[];}
  setSourceDraft(shotId:string,source:SceneSource,baseRevision?:number):void{const projectId=this.state.snapshot?.project?.id;if(!projectId)return;const previous=this.drafts.get(projectId,shotId);this.drafts.set({projectId,shotId,source,baseRevision:previous?.baseRevision??baseRevision??this.serverRevision??0,updatedAt:new Date().toISOString()});this.update({...this.draftState(),...(this.drafts.warning?{notice:this.drafts.warning}:{})});}
  discardSourceDraft(shotId:string,projectId=this.state.snapshot?.project?.id):void{if(!projectId)return;this.drafts.delete(projectId,shotId);this.update({...this.draftState(),...(!this.dirty?{conflict:false,error:''}:{}),notice:'源码草稿已丢弃，已保存源码保持原样。'});}
  persistDrafts():void{this.drafts.persist();if(this.drafts.warning)this.update({notice:this.drafts.warning});}
  async flushDrafts():Promise<void>{await this.drafts.flush();}
  get confirmedRevision():number|null{return this.serverRevision;}
  /** Named manual drafts participate in navigation, task starts and native close checks. */
  setPanelDraftDirty(key:string,label:string,value:boolean):void{
    const previous=this.unsavedMessage;if(value)this.panelDrafts.set(key,label);else this.panelDrafts.delete(key);
    this.update({panelDraft:[...new Set(this.panelDrafts.values())].join('、'),...(this.state.error===previous?{error:''}:{})});
  }
  get unsavedMessage():string{
    if(this.hasSourceDraft)return '前端源码尚未保存，请在源码面板保存草稿后继续。';
    if(this.panelDrafts.size)return [...new Set(this.panelDrafts.values())].join('、')+'尚未保存，请在智能体面板保存或放弃修改后继续。';
    return this.state.error||'影片修改尚未保存，请处理保存错误后继续。';
  }
  setRoute=(route:ModelRoute):void=>this.update({route});clearError=():void=>{if(!this.state.conflict)this.update({error:''});};notify=(notice:string):void=>this.update({notice});
  setCreativeHandler(handler:typeof this.creativeHandler):void{this.creativeHandler=handler;}
  edit=(project:VideoProject,_record=true):boolean=>{
    if(this.disposed||this.state.snapshot?.project?.id!==project.id||this.busy||this.state.conflict)return false;
    this.editSerial++;this.dirty=true;
    this.update({snapshot:{...this.state.snapshot,project},saving:true,dirty:true,notice:'',error:''});
    clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>{this.saveTimer=undefined;void this.flush();},450);
    return true;
  };
  /** Undo the deletion only while its isolated save is still the latest edit. */
  editWithUndo(project:VideoProject):{undo?:EditUndo}|null{
    const revision=this.serverRevision,epoch=this.actionEpoch,serial=this.editSerial+1;
    const isolated=!this.hasUnsavedChanges&&!this.busy&&revision!==null&&this.serverProjectId===project.id;
    if(!this.edit(project))return null;
    if(!isolated||revision===null)return {};
    const nextRevision=revision+1;
    const available=()=>!this.disposed&&!this.busy&&!this.state.conflict&&!this.saveFailed&&!this.hasSourceDraft&&!this.hasPanelDraft
      &&this.state.snapshot?.project?.id===project.id&&this.editSerial===serial&&this.actionEpoch===epoch
      &&(this.dirty?this.serverRevision===revision:this.savedEditSerial===serial&&this.serverRevision===nextRevision);
    return {undo:{available,run:async()=>{
      if(!available())return false;
      await this.flush();
      if(!available()||this.dirty||this.serverRevision!==nextRevision)return false;
      await this.action('undo',{projectId:project.id,expectedRevision:nextRevision},'已撤销，修改历史保存在工程中。');
      return !this.state.error;
    }}};
  }
  undo=():void=>{void this.action('undo',{},'已撤销上一步，历史保存在工程中。');};
  redo=():void=>{void this.action('redo',{},'已重做，历史保存在工程中。');};
  async flush():Promise<void>{
    clearTimeout(this.saveTimer);this.saveTimer=undefined;
    if(this.savingPromise){await this.savingPromise;if(this.dirty&&!this.saveFailed&&!this.state.conflict)return this.flush();return;}
    const project=this.state.snapshot?.project;if(!project||!this.dirty||this.state.conflict)return;
    const serial=this.editSerial;this.saveFailed=false;
    const operation=(async()=>{try{
      const expectedRevision=this.serverProjectId===project.id?this.serverRevision:undefined;
      const snapshot=await this.api.call<StudioSnapshot>('save',{project,expectedRevision,deferPreview:true});
      this.savedEditSerial=serial;
      if(serial===this.editSerial){this.dirty=false;this.accept(snapshot,false,true);this.update({saving:false,dirty:false,error:'',conflict:false});}
      else{this.accept(snapshot,true,true);this.update({error:''});}
      await this.refreshHistory();
    }catch(error){this.saveFailed=true;const conflict=/revision|版本|冲突|修改.*更新|已更新/i.test(message(error))||(error instanceof StudioRequestError&&/CONFLICT/.test(error.code));this.update({saving:false,error:message(error),conflict});}})();
    this.savingPromise=operation;await operation;if(this.savingPromise===operation)this.savingPromise=null;
    if(this.dirty&&!this.saveFailed&&!this.state.conflict&&serial!==this.editSerial)await this.flush();
  }
  async action(endpoint:string,payload:unknown={},notice=''):Promise<boolean>{
    if(this.state.pending)return false;this.actionEpoch++;this.update({pending:true,error:this.state.conflict?this.state.error:'',notice:''});
    try{
      await this.flush();if(this.panelDrafts.size&&!['reveal','cancel'].includes(endpoint))throw new Error(this.unsavedMessage);if(this.sourceDraftDirty&&!['saveSource','restoreSource','reveal','environment','cancel'].includes(endpoint))throw new Error('前端源码尚未保存，请先在源码面板保存修改。');if(this.dirty)throw new Error(this.state.error||'项目尚未保存，请重试保存。');
      if(['create','open','focus'].includes(endpoint)&&this.drafts.pending&&!await this.drafts.flush())throw new Error(this.drafts.warning||this.unsavedMessage);
      if(this.state.sourceDraft&&['preview','export','generate','retry','job.retry','undo','redo'].includes(endpoint))throw new Error('本工程有源码草稿，请保存或丢弃草稿后再执行此操作。切换面板会保留草稿。');
      const guard=['saveSource','restoreSource','apply','rename','duplicate','undo','redo','retry','job.retry','audio','audio.sfx','import','preview','generate'].includes(endpoint)?{expectedRevision:this.serverRevision}:{};
      const request=['create','open','focus'].includes(endpoint)?payload:{projectId:this.state.snapshot?.project?.id,...guard,...payload as object};
      const snapshot=await this.api.call<StudioSnapshot>(endpoint,request);this.accept(snapshot,false,['saveSource','restoreSource','import','rename'].includes(endpoint));await this.refreshHistory();this.update({notice,conflict:false,error:''});return true;
    }catch(error){this.update({error:message(error)});return false;}finally{this.update({pending:false});}
  }
  /** Prepare the saved revision's preview in the host command queue without blocking user edits. */
  async refreshPreview():Promise<boolean|undefined>{
    if(this.disposed||this.state.previewing||this.busy||this.hasUnsavedChanges||this.state.conflict)return;
    const projectId=this.state.snapshot?.project?.id,revision=this.serverRevision;
    if(!projectId||revision===null)return;
    const current=this.snapshotReadGuard(projectId);
    this.update({previewing:true});
    try{
      const snapshot=await this.api.call<StudioSnapshot>('preview',{projectId,expectedRevision:revision,prepareOnly:true});
      if(!current())return;
      if(snapshot.project?.id!==projectId||snapshot.previewRevision!==revision)throw new Error('未收到当前工程版本的预览');
      const {previewUrl,previewRevision,audioUrl}=snapshot;
      this.update({snapshot:{...this.state.snapshot!,previewUrl,previewRevision,audioUrl}});
      return true;
    }catch(error){
      if(!current())return;
      this.update({error:message(error)});
      return false;
    }finally{this.update({previewing:false});}
  }
  async preparePreview(projectId:string):Promise<boolean>{
    if(this.busy||this.hasUnsavedChanges||this.state.snapshot?.project?.id!==projectId)return false;
    await this.action('preview',{projectId,prepareOnly:true});
    return !this.state.error&&this.state.snapshot?.project?.id===projectId&&Boolean(this.state.snapshot.previewUrl);
  }
  /** Background workflow refreshes never follow another project's global selection. */
  async refreshMediaProject():Promise<boolean>{
    if(this.state.pending)return false;const projectId=this.state.snapshot?.project?.id,epoch=this.actionEpoch;if(!projectId)return false;
    const snapshot=await this.api.call<StudioSnapshot>('current',{projectId});
    if(this.state.pending||this.actionEpoch!==epoch||this.state.snapshot?.project?.id!==projectId||snapshot.project?.id!==projectId)return false;
    if(this.serverRevision!==null&&snapshot.project.revision<this.serverRevision)return true;
    if(this.state.sourceDraft&&snapshot.project.revision!==this.serverRevision){this.update({conflict:true,error:'工程已由制作任务更新。前端源码草稿已保留，请先复制草稿，再重新载入已保存版本。'});return true;}
    const active=this.state.snapshot;
    if(snapshot.project.revision===this.serverRevision&&active?.previewRevision===this.serverRevision&&snapshot.previewRevision!==this.serverRevision){
      snapshot.previewUrl=active.previewUrl;snapshot.previewRevision=active.previewRevision;snapshot.audioUrl=active.audioUrl;
    }
    this.accept(snapshot,true);await this.refreshHistory();return true;
  }
  /** Media jobs return task records, not StudioSnapshot; preserve the editor's CAS boundary. */
  async mediaCommand<T>(endpoint:string,payload:Record<string,unknown>={},refreshProject=false):Promise<T>{
    return this.projectCommand<T>(endpoint,payload,refreshProject);
  }
  /** Saving a manual panel draft owns the same navigation lock while allowing that draft to be persisted. */
  async panelCommand<T>(endpoint:'story.save'|'agent.budget.set',payload:Record<string,unknown>):Promise<T>{
    return this.projectCommand<T>(endpoint,payload,false,true);
  }
  private async projectCommand<T>(endpoint:string,payload:Record<string,unknown>,refreshProject=false,savesPanelDraft=false):Promise<T>{
    if(this.state.pending)throw new Error('已有界面操作进行中，请稍后重试');
    const projectId=this.state.snapshot?.project?.id;
    if(!projectId)throw new Error('请先创建或打开影片工程');
    if(payload.projectId!==undefined&&payload.projectId!==projectId)throw new Error('工程已切换，请重新发起操作');
    const prepares=!['media.cancel','media.pause','workflows.pause'].includes(endpoint);
    this.actionEpoch++;this.update({pending:true});
    try{
      if(prepares){await this.flush();if(this.dirty||this.hasSourceDraft||(!savesPanelDraft&&this.panelDrafts.size))throw new Error(this.unsavedMessage);}
      if(this.state.snapshot?.project?.id!==projectId)throw new Error('工程已切换，请重新发起操作');
      const result=await this.api.call<T>(endpoint,{...payload,projectId,...(prepares?{expectedRevision:this.serverRevision}:{})});
      if(refreshProject){const snapshot=await this.api.call<StudioSnapshot>('current',{projectId});if(snapshot.project?.id!==projectId)throw new Error('工程刷新结果不匹配');this.accept(snapshot,true,true);await this.refreshHistory();}
      this.update({notice:'',...(!this.state.conflict?{error:''}:{})});return result;
    }catch(error){this.update({error:message(error)});throw error;}finally{this.update({pending:false});}
  }
  async generate(kind:'storyboard'|'scenes'|'modify',instruction='',shotId?:string):Promise<void>{
    if(this.busy)return;if(this.creativeHandler)return this.creativeHandler(kind,instruction,shotId);
    if(!this.state.route.provider||!this.state.route.model){this.update({error:'请在模型设置中配置创作模型。'});return;}await this.action('generate',{kind,instruction,shotId,...this.state.route});
  }
  async readSource(shotId:string):Promise<SceneSource>{return this.api.call<SceneSource>('source',{shotId,projectId:this.state.snapshot?.project?.id});}
  async saveSource(shotId:string,source:SceneSource,useCurrentRevision=false):Promise<boolean>{
    const projectId=this.state.snapshot?.project?.id;
    if(!projectId||this.state.pending)return false;
    await this.flush();
    if(this.dirty||this.state.pending||this.state.snapshot?.project?.id!==projectId)return false;
    const draft=projectId?this.drafts.get(projectId,shotId):undefined;
    const expectedRevision=useCurrentRevision?this.serverRevision:draft?.baseRevision??this.serverRevision;
    const success=await this.action('saveSource',{shotId,source,expectedRevision},'源码已保存，可以刷新预览。');
    if(success&&projectId){
      const current=this.drafts.get(projectId,shotId);
      if(!current||JSON.stringify(current.source)===JSON.stringify(source))this.drafts.delete(projectId,shotId);
      this.sourceDraftDirty=false;
      this.update(this.draftState());
    }
    return success;
  }
  async restoreSource(shotId:string):Promise<boolean>{
    const success=await this.action('restoreSource',{shotId},'已恢复上次可用源码。');
    if(success){this.discardSourceDraft(shotId);this.update({notice:'已恢复上次可用源码。'});}
    return success;
  }
  async importFile(file:File):Promise<void>{
    if(file.size>64*1024*1024){this.update({error:'此文件超过浏览器上传大小，请在“模型与素材生成”中通过本地路径导入。'});return;}
    if((file.type.startsWith('video/')||/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name))&&file.size>32*1024*1024){this.update({error:'视频文件超过 32 MiB，请在“模型与素材生成”中通过本地路径导入。'});return;}
    if(file.type.startsWith('image/')){const data=await readDataUrl(file);await this.action('import',{name:file.name,mime:file.type,dataBase64:data.slice(data.indexOf(',')+1)});const asset=[...(this.state.snapshot?.project?.assets||[])].reverse().find(a=>a.name===file.name&&a.kind==='image');if(asset)this.update({localImages:{...this.state.localImages,[asset.id]:data}});}
    else if(file.type.startsWith('text/')||/\.(txt|md)$/i.test(file.name))await this.action('import',{name:file.name,mime:'text/plain',text:await file.text()});
    else if(file.type.startsWith('audio/')||/\.(wav|mp3|m4a|aac|flac|ogg|aiff)$/i.test(file.name)){const data=await readDataUrl(file);await this.action('import',{name:file.name,mime:file.type,dataBase64:data.slice(data.indexOf(',')+1)});}
    else if(file.type.startsWith('video/')||/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name)){const data=await readDataUrl(file);await this.action('import',{name:file.name,mime:file.type||'video/mp4',dataBase64:data.slice(data.indexOf(',')+1)});}
    else this.update({error:'请选择图片、文字、音频或 MP4、MOV、WebM 视频。'});
  }
  get busy():boolean{return this.state.pending||this.state.snapshot?.task?.status==='running';}
  get hasVolatileSourceDraft():boolean{return this.sourceDraftDirty;}
  get hasSourceDraft():boolean{return this.state.sourceDraft;}
  get hasPanelDraft():boolean{return this.panelDrafts.size>0;}
  get hasUnpersistedChanges():boolean{return this.dirty||this.sourceDraftDirty||this.drafts.pending||this.hasPanelDraft;}
  get hasUnsavedChanges():boolean{return this.dirty||this.state.sourceDraft||this.panelDrafts.size>0;}
  async dispose():Promise<void>{this.persistDrafts();clearTimeout(this.saveTimer);clearTimeout(this.pollTimer);await this.flush();this.disposed=true;this.listeners.clear();}
}
function message(error:unknown):string{return error instanceof Error?error.message:'操作未完成';}
function readDataUrl(file:File):Promise<string>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('读取素材失败'));reader.readAsDataURL(file);});}
