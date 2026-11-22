import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { ChatInput, ChatMessage, Conversation, ProviderSettings } from '../app/contracts.ts';
import type { Asset, RpcResult, StudioApi, StudioSnapshot, VideoStyle } from '../shared/types.ts';
import type { PublicRun } from '../agent/contracts.ts';
import { Studio } from './Studio.tsx';
import { VideoStudioIcon } from './VideoStudioIcon.tsx';
import { StudioController } from './controller.ts';
import { ProjectHome, CreateWizard, type AppHealth } from './ProjectHome.tsx';
import { ProviderDialog } from './ProviderDialog.tsx';
import { OnboardingDialog } from './OnboardingDialog.tsx';
import { StyleLibrary } from './StyleLibrary.tsx';
import { AgentPanel } from './AgentPanel.tsx';
import { AgentRunFeed } from './agent-feed.ts';
import { briefPayload, type CreateBrief, type PackCatalog, type ProjectSummary } from './project-ui.ts';
import { Icon } from './icons.tsx';
import { AppIcon, errorMessage, localTime } from './ui.tsx';

type ChatReply={conversation:Conversation;snapshot:StudioSnapshot};
type ManageAction='rename'|'duplicate'|'archive'|'restore'|'backup';
type Archive={name:string;path?:string;dataBase64?:string;size:number};
type CopilotTab='agent'|'story'|'chat';
const turnLabels={pending:'处理中',succeeded:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};

export function App({controller,api}:{controller:StudioController;api:StudioApi}){
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),project=state.snapshot?.project;
  const selectedShot=project?.shots.find(shot=>shot.id===state.selected);
  const [view,setView]=useState<'home'|'studio'>('home'),[collapsed,setCollapsed]=useState(()=>window.innerWidth<1220);
  const [copilotTab,setCopilotTab]=useState<CopilotTab>('agent');
  const [projects,setProjects]=useState<ProjectSummary[]>([]),[projectsLoading,setProjectsLoading]=useState(true),[health,setHealth]=useState<AppHealth|null>(null),[packs,setPacks]=useState<PackCatalog|null>(null);
  const [conversation,setConversation]=useState<Conversation|null>(null),[historyLoading,setHistoryLoading]=useState(false);
  const [agentRuns,setAgentRuns]=useState<PublicRun[]>([]),[agentLive,setAgentLive]=useState(false),[agentStream,setAgentStream]=useState<Record<string,string>>({});
  const [draft,setDraft]=useState(''),[intent,setIntent]=useState<ChatInput['intent']>('discuss'),[imageIds,setImageIds]=useState<string[]>([]),[allowImages,setAllowImages]=useState(false);
  const [sending,setSending]=useState(false),[canceling,setCanceling]=useState(false),[pendingMessage,setPendingMessage]=useState<string|null>(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[settings,setSettings]=useState<ProviderSettings|null>(null),[settingsOpen,setSettingsOpen]=useState(false);
  const [settingsSection,setSettingsSection]=useState<'text'|'multimodal'>('text');
  const [onboardingComplete,setOnboardingComplete]=useState<boolean|null>(null),[onboardingOpen,setOnboardingOpen]=useState(false),[onboardingDismissed,setOnboardingDismissed]=useState(false);
  const [libraryReady,setLibraryReady]=useState(false);
  const [wizard,setWizard]=useState(false),[stylesOpen,setStylesOpen]=useState(false),[selectedStyle,setSelectedStyle]=useState<VideoStyle|undefined>(undefined),[environmentOpen,setEnvironmentOpen]=useState(false),[importOpen,setImportOpen]=useState(false),[importPath,setImportPath]=useState(''),[projectBusy,setProjectBusy]=useState(false);
  const [manage,setManage]=useState<{project:ProjectSummary;action:ManageAction}|null>(null),[manageTitle,setManageTitle]=useState('');
  const messagesEnd=useRef<HTMLDivElement>(null),inputRef=useRef<HTMLTextAreaElement>(null),archiveInput=useRef<HTMLInputElement>(null),sendingRef=useRef(false),historySerial=useRef(0),agentFeedRef=useRef<AgentRunFeed|null>(null);
  const sendRef=useRef<(message:string,intent:ChatInput['intent'],retryTurnId?:string,shotId?:string|null,role?:ChatInput['role'])=>Promise<void>>(async()=>{});
  const configured=!!(settings?.ready??settings?.hasKey),sceneConfigured=settings?.sceneReady??configured,visionReady=settings?.visionReady===true,blocked=sending||projectBusy||state.pending||state.snapshot?.task?.status==='running';
  const libraryRead=useRef(0),lastLibraryRead=useRef(0);

  const assetUrl=(asset:Asset)=>{
    const base=state.snapshot?.assetBaseUrl??state.snapshot?.previewUrl;
    if(!base||!asset.path)return '';
    try{return new URL(asset.path.split('/').map(encodeURIComponent).join('/'),base).href;}catch{return '';}
  };

  async function refreshLibrary(showLoading=true){
    const read=++libraryRead.current;lastLibraryRead.current=Date.now();
    if(showLoading)setProjectsLoading(true);
    try{
      const value=await api.call<{projects:ProjectSummary[]}>('list',{includeArchived:true});
      if(read===libraryRead.current){setProjects(value.projects);setLibraryReady(true);}
    }catch(cause){if(read===libraryRead.current)setError(errorMessage(cause));}
    finally{if(read===libraryRead.current)setProjectsLoading(false);}
  }
  useEffect(()=>{
    if(view!=='home'||projectsLoading||blocked)return;
    const refresh=()=>{if(Date.now()-lastLibraryRead.current>=5000)void refreshLibrary(false);};
    window.addEventListener('focus',refresh);
    return()=>window.removeEventListener('focus',refresh);
  },[api,view,projectsLoading,blocked]);
  async function refreshHealth(){try{setHealth(await api.call<AppHealth>('app.health'));}catch(cause){setError(errorMessage(cause));}}
  useEffect(()=>{let active=true;void controller.refreshStyles();void refreshLibrary();void refreshHealth();api.call<PackCatalog>('packs.list').then(value=>{if(active)setPacks(value);}).catch(()=>{});api.call<ProviderSettings>('providers.get').then(value=>{if(active){setSettings(value);controller.setRoute(value.sceneRoute??value.route??{provider:value.config.id||'custom',model:value.config.model});}}).catch(cause=>{if(active)setError(errorMessage(cause));});return()=>{active=false;};},[api]);
  useEffect(()=>{
    let active=true;
    void api.call<{completed:boolean}>('app.onboarding.get').then(({completed})=>{
      if(active)setOnboardingComplete(previous=>previous??completed);
    }).catch(cause=>{
      if(active)setError(errorMessage(cause));
    });
    return()=>{active=false;};
  },[api]);
  useEffect(()=>{
    if(!onboardingDismissed&&onboardingComplete===false&&libraryReady&&!projectsLoading&&!projects.length&&!state.loading&&view==='home'
      &&!blocked&&!settingsOpen&&!wizard&&!importOpen&&!environmentOpen&&!manage)setOnboardingOpen(true);
  },[onboardingDismissed,onboardingComplete,libraryReady,projectsLoading,projects.length,state.loading,view,blocked,settingsOpen,wizard,importOpen,environmentOpen,manage]);
  function dismissOnboarding(){
    setOnboardingOpen(false);
    setOnboardingDismissed(true);
    if(onboardingComplete===true)return;
    void api.call('app.onboarding.complete').then(()=>setOnboardingComplete(true)).catch(cause=>setError(errorMessage(cause)));
  }
  function openSettingsAt(section:'text'|'multimodal'){setSettingsSection(section);setSettingsOpen(true);}
  function closeSettings(){setSettingsOpen(false);setSettingsSection('text');}
  useEffect(()=>{const changed=(event:Event)=>{const value=(event as CustomEvent<ProviderSettings>).detail;void (value?providerSaved(value):api.call<ProviderSettings>('providers.get').then(providerSaved)).catch(cause=>setError(errorMessage(cause)));};window.addEventListener('yingliu-models-changed',changed);return()=>window.removeEventListener('yingliu-models-changed',changed);},[api,controller]);
  useEffect(()=>{if(state.loading||sendingRef.current||view!=='studio')return;const serial=++historySerial.current;setHistoryLoading(true);api.call<Conversation>('chat.history',{projectId:project?.id}).then(value=>{if(serial===historySerial.current)setConversation(value);}).catch(cause=>{if(serial===historySerial.current)setError(errorMessage(cause));}).finally(()=>{if(serial===historySerial.current)setHistoryLoading(false);});return()=>{historySerial.current++;};},[api,project?.id,state.loading,view]);
  useEffect(()=>{
    const projectId=view==='studio'?project?.id:undefined;
    setAgentRuns([]);setAgentLive(false);setAgentStream({});
    if(!projectId)return;
    let active=true,refreshNeeded=false,refreshing=false;
    let versions=new Map<string,string>();
    async function refreshProject(){
      const current=controller.getSnapshot();
      if(!active||refreshing||!refreshNeeded||current.pending||current.snapshot?.project?.id!==projectId)return;
      refreshNeeded=false;refreshing=true;
      let refreshed=false;
      try{refreshed=await controller.refreshMediaProject();if(!refreshed)refreshNeeded=true;}
      catch{/* Next agent event refreshes after transient transport error. */}
      finally{refreshing=false;if(refreshed&&refreshNeeded)void refreshProject();}
    }
    const unsubscribe=controller.subscribe(()=>void refreshProject());
    const token=typeof document!=='undefined'?document.querySelector<HTMLMetaElement>('meta[name="yingliu-token"]')?.content:undefined;
    const subscription=new AgentRunFeed({
      list:async()=>{const result=await controller.api.call<{runs?:PublicRun[]}|undefined>('agent.list',{projectId});return Array.isArray(result?.runs)?result.runs:[];},
      connect:signal=>fetch('/events/agent?projectId='+encodeURIComponent(projectId),{method:'POST',headers:token?{'X-Yingliu-Token':token}:{},signal}),
      onRuns:list=>{
        if(!active)return;
        setAgentRuns(list);
        setAgentStream(prev=>{const next={...prev};for(const item of list)if(item.status!=='running')delete next[item.id];return next;});
        const nextVersions=new Map(list.map(run=>[run.id,`${run.status}:${run.steps.length}:${run.updatedAt??''}`]));
        if([...nextVersions].some(([id,version])=>versions.get(id)!==version))refreshNeeded=true;
        versions=nextVersions;
        void refreshProject();
      },
      onDelta:(runId,text)=>{if(active)setAgentStream(prev=>({...prev,[runId]:((prev[runId]??'')+text).slice(-2000)}));},
      onLive:setAgentLive,
    });
    agentFeedRef.current=subscription;subscription.start();
    return()=>{active=false;unsubscribe();subscription.stop();if(agentFeedRef.current===subscription)agentFeedRef.current=null;};
  },[controller,project?.id,view]);
  useEffect(()=>{setImageIds([]);setAllowImages(false);},[project?.id,intent,selectedShot?.id]);
  useEffect(()=>{messagesEnd.current?.scrollIntoView({block:'nearest',behavior:'smooth'});},[conversation?.messages.length,conversation?.turns?.at(-1)?.status,pendingMessage,sending]);
  useEffect(()=>{controller.setCreativeHandler(async(kind,instruction,shotId)=>{setCollapsed(false);setCopilotTab('chat');setIntent(kind==='storyboard'?'create':'modify');const current=controller.getSnapshot().snapshot?.project;const content=instruction.trim()||(kind==='storyboard'?`根据现有创作简报构建可编辑分镜和画面。主题：${current?.topic||current?.title||''}。目标片长 ${current?.targetDuration||30} 秒。`:'为现有分镜生成完整画面源码，保留镜头标题、意图和播放顺序。');await sendRef.current(content,kind==='storyboard'?'create':'modify',undefined,shotId??null,kind==='storyboard'?'director':'scene');});return()=>controller.setCreativeHandler(null);},[controller]);

  async function performSend(content:string,mode:ChatInput['intent'],retryTurnId?:string,requestedShotId?:string|null,role:ChatInput['role']='director',imageAssetIds?:string[]){
    if(sendingRef.current||projectBusy||controller.busy)return;
    if(!(role==='scene'?sceneConfigured:configured)){openSettingsAt('text');setNotice(role==='scene'?'请配置场景代码模型，再生成或修改画面。':'请配置文本模型，再继续讨论或生成初稿。');return;}
    if(!content.trim()&&!retryTurnId)return;
    sendingRef.current=true;historySerial.current++;setSending(true);setCanceling(false);setError('');setNotice('');setPendingMessage(retryTurnId?null:content);let timer:ReturnType<typeof setInterval>|undefined;
    try{await controller.flush();const current=controller.getSnapshot();if(controller.hasUnsavedChanges)throw new Error(controller.unsavedMessage);
      const projectId=current.snapshot?.project?.id,shotId=requestedShotId!==undefined?(requestedShotId??undefined):(mode==='modify'&&current.snapshot?.project?.shots.some(shot=>shot.id===current.selected)?current.selected??undefined:undefined);
      const route=(role==='scene'?settings?.sceneRoute:settings?.route)??{provider:settings!.config.id,model:settings!.config.model};
      const preset=(current.snapshot?.project?.extensions.brief as {preset?:unknown}|undefined)?.preset;
      const input:ChatInput=retryTurnId?{message:'',projectId,...route,role,retryTurnId}:{message:content,projectId,shotId,...route,role,intent:mode,packId:typeof preset==='string'?preset:undefined,...(visionReady&&imageAssetIds?.length?{allowImageUpload:true,imageAssetIds}:{})};
      timer=setInterval(()=>{void api.call<Conversation>('chat.history',{projectId}).then(value=>{if(sendingRef.current){setConversation(value);if(value.messages.some(message=>message.role==='user'&&message.content===content))setPendingMessage(null);}}).catch(()=>{});},1000);
      const reply=await api.call<ChatReply>('chat.send',input);clearInterval(timer);setConversation(reply.conversation);setDraft('');setPendingMessage(null);
      if(reply.snapshot.project){await controller.load();const assistant=[...reply.conversation.messages].reverse().find(message=>message.role==='assistant'),actions=assistant?.actions||[];const focus=actions.find(action=>action.shotId===shotId)||actions.find(action=>action.shotId)||actions.find(action=>action.frame!==undefined);await controller.focusProject(reply.snapshot.project.id,{shotId:focus?.shotId??shotId,frame:focus?.frame});setView('studio');}
      setNotice(mode==='discuss'||mode==='chat'?'讨论已保存':'对话与工程已保存');void refreshLibrary();
    }catch(cause){setError(errorMessage(cause));setPendingMessage(null);try{setConversation(await api.call<Conversation>('chat.history',{projectId:controller.getSnapshot().snapshot?.project?.id}));await controller.load();}catch{}}finally{clearInterval(timer);sendingRef.current=false;setSending(false);setCanceling(false);setHistoryLoading(false);}
  }
  sendRef.current=performSend;
  async function send(event?:FormEvent){
    event?.preventDefault();
    const content=draft.trim();if(!content||blocked||sendingRef.current)return;
    const attachments=allowImages?imageIds.filter(id=>images.some(image=>image.id===id)):undefined;
    setImageIds([]);setAllowImages(false);
    await performSend(content,intent,undefined,undefined,'director',attachments);
  }
  async function cancel(){if(!sending||canceling)return;setCanceling(true);try{await api.call('chat.cancel',{projectId:project?.id});setNotice('已请求取消；已完成的修改会保留。');}catch(cause){setError(errorMessage(cause));setCanceling(false);}}
  async function openProject(value:ProjectSummary|string){if(blocked)return;if(view==='studio'){await controller.flush();await controller.flushDrafts();if(controller.hasUnpersistedChanges){setError(controller.unsavedMessage);return;}}setProjectBusy(true);setError('');try{typeof value==='string'?await controller.action('open',{path:value.trim()}):await controller.focusProject(value.id);if(controller.getSnapshot().error)throw new Error(controller.getSnapshot().error);setView('studio');setImportOpen(false);setImportPath('');void refreshLibrary();}catch(cause){setError(errorMessage(cause));}finally{setProjectBusy(false);}}
  async function chooseProject(){if(window.yingliu?.pickProject){try{const path=await window.yingliu.pickProject();if(path)await openProject(path);}catch(cause){setError(errorMessage(cause));}}else setImportOpen(true);}
  async function home(){await controller.flush();await controller.flushDrafts();if(controller.hasUnpersistedChanges){setError(controller.unsavedMessage);return;}setView('home');void refreshLibrary();void refreshHealth();}
  async function create(brief:CreateBrief){if(blocked)return;setProjectBusy(true);setError('');try{await controller.action('create',briefPayload(brief));if(controller.getSnapshot().error)throw new Error(controller.getSnapshot().error);setView('studio');setWizard(false);setSelectedStyle(undefined);setIntent(brief.mode==='ai'?'modify':'discuss');setNotice('简报已保存，可以开始编辑。');void refreshLibrary();}catch(cause){setProjectBusy(false);throw cause;}setProjectBusy(false);if(brief.mode==='ai'){setCollapsed(false);setCopilotTab('chat');await performSend(`根据保存的简报构建影片初稿，生成分镜与各镜头画面。主题：${brief.topic}。目标 ${brief.duration} 秒。`, 'create');}}
  async function jump(action:NonNullable<ChatMessage['actions']>[number]){if(blocked)return;try{const id=action.projectId??project?.id;if(!id)throw new Error('这条记录没有关联工程');await controller.focusProject(id,{shotId:action.shotId,frame:action.frame});setView('studio');}catch(cause){setError(errorMessage(cause));}}
  async function providerSaved(value:ProviderSettings){setImageIds([]);setAllowImages(false);setSettings(value);await controller.load();controller.setRoute(value.sceneRoute??value.route??{provider:value.config.id,model:value.config.model});await refreshHealth();}
  async function quickProviderSaved(value:ProviderSettings){window.dispatchEvent(new CustomEvent('yingliu-models-changed',{detail:value}));}
  function unwrap<T>(result:RpcResult<T>):T{if(!result.ok)throw new Error(result.error.message);return result.value;}
  function downloadArchive(value:Archive){if(!value.dataBase64)throw new Error('未收到工程包数据');const bytes=Uint8Array.from(atob(value.dataBase64),character=>character.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'})),link=document.createElement('a');link.href=url;link.download=value.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function backup(id:string){await controller.flush();if(controller.hasUnsavedChanges)throw new Error(controller.unsavedMessage);if(window.yingliu?.exportProject){const result=await window.yingliu.exportProject(id);if(!result)return;const value=unwrap(result);setNotice(`工程包已保存：${value.path||value.name}`);}else{const value=await api.call<Archive>('app.exportProject',{projectId:id});downloadArchive(value);setNotice('工程包已下载。');}}
  async function importPackage(file?:File){if(blocked)return;if(!file&&!window.yingliu?.importProject){archiveInput.current?.click();return;}setProjectBusy(true);setError('');try{await controller.flush();if(controller.hasUnsavedChanges)throw new Error(controller.unsavedMessage);let snapshot:StudioSnapshot|null=null;if(file){const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=()=>reject(new Error('读取工程包失败'));reader.readAsDataURL(file);});snapshot=await api.call<StudioSnapshot>('app.importProject',{dataBase64:base64});}else{const result=await window.yingliu!.importProject!();if(result)snapshot=unwrap(result);}if(snapshot?.project){await controller.load();await controller.focusProject(snapshot.project.id);setView('studio');setNotice('工程包已导入，可继续编辑。');void refreshLibrary();}}catch(cause){setError(errorMessage(cause));}finally{setProjectBusy(false);}}
  function manageProject(value:ProjectSummary,action:ManageAction){setManage({project:value,action});setManageTitle(action==='duplicate'?`${value.title} 副本`:value.title);setError('');}
  async function finishManage(){if(!manage||blocked)return;setProjectBusy(true);setError('');try{const {project:value,action}=manage;if(action==='backup')await backup(value.id);else{if(action==='rename'||action==='duplicate')await controller.focusProject(value.id);if(action==='rename'||action==='duplicate'){if(!manageTitle.trim())throw new Error('名称不能为空');await controller.action(action,{title:manageTitle.trim()});}else await controller.action('archive',{projectId:value.id,archived:action!=='restore'});if(controller.getSnapshot().error)throw new Error(controller.getSnapshot().error);if(action==='duplicate'){setView('studio');setNotice('已复制工程，素材与源码已保留；新工程的对话从这里开始。');}else if(action==='archive')setView('home');else setNotice(action==='restore'?'工程已恢复':'工程名称已保存');await refreshLibrary();}setManage(null);}catch(cause){setError(errorMessage(cause));}finally{setProjectBusy(false);}}
  function toggleTheme(){
    const next=state.scheme==='dark'?'light':'dark';
    controller.setScheme(next);
    try{localStorage.setItem('yingliu-agent-workbench-scheme',next);}catch{/* session only */}
  }

  const currentTurn=conversation?.turns?.at(-1);
  const scopedAssets=selectedShot&&intent==='modify'?new Set([...selectedShot.assetIds,...selectedShot.referenceIds]):undefined;
  const images=project?.assets.filter(asset=>asset.kind==='image'&&(!scopedAssets||scopedAssets.has(asset.id)))??[];
  const pendingApproval=agentRuns.some(r=>r.status==='awaiting_approval'||(r.status==='paused'&&Boolean(r.visionConsentRequired)));
  const activeAgentRun=agentRuns.some(r=>['running','waiting_task'].includes(r.status));

  return <div className={`yl-app ${collapsed?'is-chat-collapsed':''} ${view==='home'?'vs-studio vs-home-shell is-home':'is-studio-view'}`} data-scheme={state.scheme} lang="zh-CN">
    {view==='home'&&<>
      <header className="vs-topbar">
        <button type="button" className="vs-brand vs-brand-home" disabled={blocked} onClick={()=>void home()} aria-label="映流智能体 项目首页">
          <span className="vs-brandmark"><VideoStudioIcon size={18}/></span>
          <strong>映流智能体</strong>
          <small>本地视频智能体</small>
        </button>
        <div className="vs-top-actions">
          <button type="button" onClick={()=>{setStylesOpen(true);void controller.refreshStyles();}}><Icon name="spark"/><span>风格库</span></button>
          <button type="button" aria-label="新手引导" onClick={()=>setOnboardingOpen(true)}><Icon name="info"/><span>新手引导</span></button>
          <button type="button" aria-label="模型设置" onClick={()=>setSettingsOpen(true)}><Icon name="settings"/><span>模型设置</span></button>
          <button type="button" className="vs-iconbutton" aria-label={state.scheme==='dark'?'切换到浅色主题':'切换到深色主题'} title={state.scheme==='dark'?'切换到浅色主题':'切换到深色主题'} onClick={toggleTheme}><Icon name="monitor"/></button>
        </div>
      </header>
      <div className="yl-global-feedback">
        {error&&<div className="yl-error" role="alert"><span>{error}</span><button aria-label="关闭错误" onClick={()=>setError('')}>×</button></div>}
        {notice&&!error&&<p className="yl-dialog-success" role="status">{notice}</p>}
      </div>
      <ProjectHome projects={projects} loading={projectsLoading||state.loading} configured={configured} health={health} styleCount={state.styles.length} onCreate={()=>setWizard(true)} onOpen={value=>void openProject(value)} onImport={()=>void chooseProject()} onImportPackage={()=>void importPackage()} onConfigure={()=>setSettingsOpen(true)} onManage={manageProject} onHealth={()=>{setEnvironmentOpen(true);void refreshHealth();}} onStyles={()=>{setStylesOpen(true);void controller.refreshStyles();}}/>
    </>}

    {view==='studio'&&<div className="yl-studio-layout">
      {!collapsed?<aside className="yl-copilot" aria-label={copilotTab==='chat'?'创作对话':'智能体副驾驶'}>
        <div className="yl-copilot-head">
          <div className="vs-segmented yl-copilot-tabs" role="tablist" aria-label="AI 助手模式">
            <button type="button" role="tab" aria-selected={copilotTab==='agent'} className={copilotTab==='agent'?'is-active':''} onClick={()=>setCopilotTab('agent')}>
              智能体{pendingApproval?<i className="vs-tab-dot is-warn"/>:activeAgentRun?<i className="vs-tab-dot is-busy"/>:null}
            </button>
            <button type="button" role="tab" aria-selected={copilotTab==='chat'} className={copilotTab==='chat'?'is-active':''} onClick={()=>{if(controller.hasPanelDraft){setError(controller.unsavedMessage);return;}setCopilotTab('chat');}}>创作对话</button>
          </div>
          <button type="button" className="vs-iconbutton" aria-label="收起智能体面板" title="收起智能体面板" onClick={()=>setCollapsed(true)}><Icon name="chevronLeft"/></button>
        </div>

        {copilotTab==='agent'&&project&&<div className="yl-copilot-scroll">
          <AgentPanel key={project.id} compact controller={controller} project={project} assetUrl={assetUrl} onConfigure={()=>setSettingsOpen(true)} externalRuns={agentRuns} externalLive={agentLive} externalStreamText={agentStream} onExternalRefresh={()=>agentFeedRef.current?.refresh()}/>
        </div>}

        {copilotTab==='chat'&&<div className="yl-chat-pane">
          <div className="yl-provider-note">
            <span className={`yl-status-dot ${configured?'':'is-missing'}`}/>
            <div><strong>{configured?settings?.config.name:'模型尚未配置'}</strong><p>{configured?`${settings?.config.model} · 快速讨论与修改`:'可以手动编排；使用 AI 前请填写模型接口。'}</p></div>
            <button type="button" onClick={()=>setSettingsOpen(true)}>设置 ↗</button>
          </div>
          <div className="yl-messages" aria-live="polite" aria-busy={historyLoading||sending}>
            {historyLoading&&!conversation?<div className="yl-history-loading"><span className="vs-spinner"/>读取工程对话…</div>
              :!conversation?.messages.length&&!pendingMessage?<div className="yl-chat-welcome">
                <h2>快速创作对话</h2>
                <p>适合单轮讨论与轻量修改；多镜头编排、虚拟剧组分工、3D 白模预演与声画质检推荐切换到「智能体」主面板。</p>
                {project?.topic&&<blockquote>{project.topic}</blockquote>}
                <div style={{display:'flex',gap:'8px',flexWrap:'wrap'}}>
                  <button type="button" className="vs-primary" onClick={()=>setCopilotTab('agent')}>进入剧组智能体编排</button>
                  {!configured&&<button type="button" onClick={()=>setSettingsOpen(true)}>连接创作模型</button>}
                </div>
              </div>
              :conversation?.messages.map(message=>{const turn=conversation.turns?.find(value=>value.id===message.turnId);return <article key={message.id} className={`yl-message is-${message.role}`} data-message-id={message.id}><div className="yl-message-meta"><span className="yl-avatar">{message.role==='user'?'你':'映'}</span><strong>{message.role==='user'?'你':settings?.config.name||'创作助手'}</strong><time dateTime={message.createdAt}>{localTime(message.createdAt)}</time></div><div className="yl-message-content">{message.content}</div>{message.actions?.length?<div className="yl-message-actions">{message.actions.map((action,index)=><button key={index} disabled={blocked} onClick={()=>void jump(action)}>{action.label} ↗</button>)}</div>:null}{message.role==='user'&&turn&&<div className={`yl-turn is-${turn.status}`}><span>{turnLabels[turn.status]}{turn.committedRevision!==undefined?` · 工程 v${turn.committedRevision}`:''}</span>{turn.error&&<p>{turn.error}</p>}{turn.status==='interrupted'&&<p>上次运行已中断，工程会保留最后保存的版本。</p>}{['failed','cancelled','interrupted'].includes(turn.status)&&<button disabled={blocked} onClick={()=>void performSend('',turn.request.intent||'auto',turn.id,undefined,turn.request.role)}>重试这次请求</button>}</div>}</article>;})}
            {pendingMessage&&!conversation?.messages.some(message=>message.content===pendingMessage&&message.role==='user'&&new Date(message.createdAt).getTime()>Date.now()-10000)&&<article className="yl-message is-user"><div className="yl-message-meta"><span className="yl-avatar">你</span><strong>你</strong><small>提交中</small></div><div className="yl-message-content">{pendingMessage}</div></article>}
            {sending&&<div className="yl-chat-running" role="status"><span className="vs-spinner"/><div><strong>{canceling?'等待取消完成':intent==='discuss'?'正在讨论影片':'正在处理创作请求'}</strong><small>{currentTurn?.status==='pending'?'请求已记录，正在等待模型与工程检查。':'修改完成后同步到分镜工作台。'}</small></div><button type="button" disabled={canceling} onClick={()=>void cancel()}>{canceling?'取消中':'取消'}</button></div>}
            <div ref={messagesEnd}/>
          </div>
          {error&&<div className="yl-error" role="alert"><span>{error}</span><button aria-label="关闭对话错误" onClick={()=>setError('')}>×</button></div>}
          {notice&&!error&&<div className="yl-chat-notice" role="status"><AppIcon name="check"/>{notice}</div>}
          <form className="yl-composer" onSubmit={event=>void send(event)}>
            <div className="yl-intent-tabs">{([{id:'discuss',label:'讨论'},{id:'create',label:'构建初稿'},{id:'modify',label:'修改'}] as const).map(mode=><button type="button" key={mode.id} className={intent===mode.id?'is-active':''} disabled={sending} onClick={()=>setIntent(mode.id)}>{mode.label}</button>)}</div>
            <div className="yl-context"><span className={selectedShot&&intent==='modify'?'is-shot':''}>{selectedShot&&intent==='modify'?`当前镜头 · ${selectedShot.title}`:`整部影片 · ${project?.title||''}`}</span>{selectedShot&&intent==='modify'&&<button type="button" onClick={()=>controller.select(null)} disabled={blocked}>改整片</button>}</div>
            <textarea ref={inputRef} aria-label="创作指令" rows={3} placeholder={intent==='discuss'?'讨论主题、结构或制作方法…':intent==='create'?'描述要构建的影片与分镜…':'告诉我需要怎样调整…'} value={draft} disabled={sending} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void send();}}}/>
            {visionReady&&images.length>0&&<details className="yl-image-context">
              <summary>本次参考图{allowImages?`（${imageIds.filter(id=>images.some(image=>image.id===id)).length}/3）`:''}</summary>
              <label><input type="checkbox" checked={allowImages} disabled={sending} onChange={event=>{setAllowImages(event.target.checked);if(!event.target.checked)setImageIds([]);}}/>允许视觉模型处理本次选择的图片</label>
              {allowImages&&<><small>使用 {settings?.visionRoute?.model??'当前视觉模型'}，每次最多 3 张。</small>{images.map(asset=><label key={asset.id}><input type="checkbox" checked={imageIds.includes(asset.id)} disabled={sending||(!imageIds.includes(asset.id)&&imageIds.length>=3)} onChange={event=>setImageIds(ids=>event.target.checked?[...ids,asset.id]:ids.filter(id=>id!==asset.id))}/>{asset.name}</label>)}</>}
            </details>}
            {!visionReady&&images.length>0&&<button className="yl-image-setup" type="button" disabled={blocked} onClick={()=>openSettingsAt('multimodal')}>配置多模态模型以使用参考图</button>}
            <div className="yl-composer-bottom"><small>Ctrl / ⌘ Enter 发送</small><button className="vs-primary" type="submit" disabled={!draft.trim()||blocked}><span>{sending?'处理中':configured?'发送':'配置模型'}</span></button></div>
          </form>
        </div>}
      </aside>
      :<button type="button" className="yl-copilot-rail" onClick={()=>setCollapsed(false)} aria-label="展开智能体面板">
        <Icon name="spark"/><span>智能体</span>{pendingApproval&&<i className="vs-tab-dot is-warn"/>}
      </button>}

      <div className="yl-editor-shell" aria-busy={sending}>
        <Studio controller={controller} onHome={()=>void home()} conversationBusy={sending}
          onNew={()=>setWizard(true)} onOpen={()=>void chooseProject()} onConfigure={()=>setSettingsOpen(true)}
          onOnboarding={()=>setOnboardingOpen(true)} onStyles={()=>{setStylesOpen(true);void controller.refreshStyles();}}
          onManageProject={action=>{if(project)manageProject({id:project.id,title:project.title,path:state.snapshot?.root||''},action);}}
          onToggleCopilot={()=>setCollapsed(v=>!v)} copilotOpen={!collapsed}
          onOpenCopilot={()=>{setCollapsed(false);setCopilotTab('agent');}}
          projects={projects} onSwitchProject={id=>{const value=projects.find(item=>item.id===id);if(value)void openProject(value);}}
          externalAgentRuns={agentRuns} externalAgentLive={agentLive} externalAgentStream={agentStream}
          onRefreshAgentRuns={()=>agentFeedRef.current?.refresh()}
          onProjectUpdated={()=>void refreshLibrary(false)} modelConfigured={configured} visionReady={visionReady}
          onConfigureVision={()=>openSettingsAt('multimodal')} sceneModelName={settings?.sceneRoute?.model} sceneConfigured={sceneConfigured}/>
      </div>
    </div>}

    <input ref={archiveInput} hidden type="file" accept=".yingliu,application/octet-stream" onChange={event=>{const file=event.target.files?.[0];if(file)void importPackage(file);event.target.value='';}}/>
    {onboardingOpen&&!settingsOpen&&<OnboardingDialog textReady={configured} inStudio={view==='studio'} busy={blocked} onConfigure={openSettingsAt} onContinue={()=>{dismissOnboarding();if(view==='home')setWizard(true);}} onDismiss={dismissOnboarding}/>}
    {settingsOpen&&<ProviderDialog api={api} initial={settings} initialSection={settingsSection} onClose={closeSettings} onSave={quickProviderSaved} blocked={blocked}/>}
    {stylesOpen&&<div className="vs-studio yl-style-overlay" data-scheme={state.scheme}><StyleLibrary styles={state.styles} onClose={()=>setStylesOpen(false)} onSave={style=>controller.saveStyle(style)} onDelete={id=>controller.deleteStyle(id)} onUse={style=>{setSelectedStyle(style);setStylesOpen(false);setWizard(true);}}/></div>}
    {wizard&&<CreateWizard styles={state.styles} initialStyle={selectedStyle} onStyles={()=>setStylesOpen(true)} packs={packs} configured={configured} busy={projectBusy||sending} onCreate={create} onClose={()=>{setWizard(false);setSelectedStyle(undefined);}} onConfigure={()=>setSettingsOpen(true)}/>}
    {importOpen&&<div className="yl-modal-backdrop"><section className="yl-modal" role="dialog" aria-modal="true" aria-labelledby="yl-import-title"><div className="yl-modal-heading"><h2 id="yl-import-title">打开现有工程目录</h2><button className="yl-button yl-icon-button" aria-label="关闭打开工程" onClick={()=>setImportOpen(false)}><AppIcon name="close"/></button></div><p>输入包含 project.json 的工程目录。工程包请使用首页的「导入工程包」。</p><label className="yl-field"><span>工程目录的绝对路径</span><input autoFocus aria-label="工程目录的绝对路径" value={importPath} onChange={event=>setImportPath(event.target.value)} placeholder="/Users/…/我的影片"/></label>{error&&<p className="yl-error" role="alert">{error}</p>}<div className="yl-modal-actions"><button className="yl-button" onClick={()=>setImportOpen(false)}>取消</button><button className="yl-button yl-primary" disabled={!importPath.trim()||blocked} onClick={()=>void openProject(importPath)}>打开工程</button></div></section></div>}
    {manage&&<div className="yl-modal-backdrop"><section className="yl-modal" role="dialog" aria-modal="true" aria-labelledby="yl-manage-title"><div className="yl-modal-heading"><h2 id="yl-manage-title">{({rename:'重命名影片',duplicate:'复制影片工程',archive:'归档影片',restore:'恢复影片',backup:'备份工程包'})[manage.action]}</h2><button className="yl-button yl-icon-button" disabled={projectBusy} aria-label="关闭工程操作" onClick={()=>setManage(null)}><AppIcon name="close"/></button></div>{['rename','duplicate'].includes(manage.action)?<><label className="yl-field"><span>影片名称</span><input autoFocus aria-label="新的影片名称" value={manageTitle} onChange={event=>setManageTitle(event.target.value)}/></label>{manage.action==='duplicate'&&<p>复制分镜、源码和素材；新工程不会继承旧对话或导出视频。</p>}</>:<p>{manage.action==='archive'?'归档后影片从创作列表隐藏，工程文件仍保留，可随时恢复。':manage.action==='restore'?'恢复后，影片重新出现在创作列表。':'备份包含可编辑工程、简报、镜头源码和素材；不包含对话记录或已导出的较大视频。'}</p>}{error&&<p className="yl-error" role="alert">{error}</p>}<div className="yl-modal-actions"><button className="yl-button" disabled={projectBusy} onClick={()=>setManage(null)}>取消</button><button className="yl-button yl-primary" disabled={projectBusy||sending} onClick={()=>void finishManage()}>{projectBusy?'处理中':manage.action==='backup'?'保存工程包':'确认'}</button></div></section></div>}
    {environmentOpen&&<div className="yl-modal-backdrop"><section className="yl-modal" role="dialog" aria-modal="true" aria-labelledby="yl-health-title"><div className="yl-modal-heading"><h2 id="yl-health-title">本地运行与预演环境</h2><button className="yl-button yl-icon-button" aria-label="关闭运行环境" onClick={()=>setEnvironmentOpen(false)}><AppIcon name="close"/></button></div><p>工程保存在 {health?.dataDirectory||'本地应用目录'}。渲染使用本机浏览器逐帧捕获并由 FFmpeg 编码；安装 Blender 后可为智能体开启 3D 白模预演镜头。</p><div className="yl-health-tools">{Object.entries(health?.tools||{}).map(([name,tool])=><article key={name}><span className={`yl-status-dot ${tool.available?'':'is-missing'}`}/><div><strong>{name==='browser'?'Chromium 浏览器':name==='ffmpeg'?'FFmpeg 编码器':name==='ffprobe'?'ffprobe 媒体检查':'Blender（可选 · 白模预演）'}</strong><small>{tool.version||tool.message||tool.path||'未找到工具'}</small></div><span>{tool.available?'可用':tool.optional?'未配置（可选）':'待配置'}</span></article>)}</div><p>在工程工作台的「运行环境」中填写工具绝对路径并检查。缺少工具时仍可编排分镜和编辑源码。</p><div className="yl-modal-actions"><button className="yl-button" onClick={()=>void refreshHealth()}>重新检查</button><button className="yl-button yl-primary" onClick={()=>setEnvironmentOpen(false)}>完成</button></div></section></div>}
  </div>;
}
