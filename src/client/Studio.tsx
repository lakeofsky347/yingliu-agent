import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { compileSpec, deleteAsset, deleteShot, duplicateShot, reorderShots, specMarkdown, validateGraph } from '../core/index.ts';
import type { Asset, Shot, VideoProject } from '../shared/types.ts';
import type { StudioController, EditUndo } from './controller.ts';
import { LiteGraphEditor, type GraphRemoval } from './graph-adapter.ts';
import { OutputSettings } from './output-settings.tsx';
import { AudioPanel } from './AudioPanel.tsx';
import { Dialog } from './Dialog.tsx';
import { ExportPanel } from './ExportPanel.tsx';
import { MediaPanel } from './MediaPanel.tsx';
import { WorkflowPanel } from './WorkflowPanel.tsx';
import { TaskPanel, HistoryPanel } from './TaskPanel.tsx';
import { SourceEditor } from './SourceEditor.tsx';
import { Button, Icon, IconButton } from './icons.tsx';
import { ConfirmationScope, ConfirmHost, Toasts, useCancelConfirmation, useConfirmAction } from './Feedback.tsx';
import { createToastStore } from './toast-store.ts';
import { AssetsPanel } from './AssetsPanel.tsx';
import { PropertiesPanel } from './PropertiesPanel.tsx';
import { Stage, type StageLayout, type StageMode } from './Stage.tsx';
import { Timeline } from './Timeline.tsx';
import { createPlayhead } from './playhead-store.ts';
import { BottomDrawer, type DrawerTab } from './BottomDrawer.tsx';
import { EnvironmentPanel } from './EnvironmentPanel.tsx';
import { StudioHeader, taskLabel, type MenuItem, type StageId, type StepInfo } from './StudioHeader.tsx';

import { AgentPanel } from './AgentPanel.tsx';
import { AgentRunFeed } from './agent-feed.ts';
import type { PublicRun } from '../agent/contracts.ts';
import { addPlacedShot } from './project-ui.ts';

type PanelTab='agent'|'media'|'audio'|'source'|'workflow'|'spec'|'history'|'tasks'|'exports'|'environment';
type Pane='properties'|'assets'|'panels';
export interface StudioProps {
  controller:StudioController;
  onHome:()=>void;
  onNew:()=>void;
  onOpen:()=>void;
  onConfigure:()=>void;
  onProjectUpdated?:()=>void;
  modelConfigured:boolean;
  visionReady:boolean;
  sceneModelName?:string;
  sceneConfigured:boolean;
  onConfigureVision:()=>void;
  conversationBusy:boolean;
}
export function FilmMark(){return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.6"/><path d="M8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5" stroke="currentColor" strokeWidth="1.4"/><path d="m11 9 4 3-4 3V9Z" fill="currentColor"/></svg>;}


const store={
  get<T>(key:string,fallback:T):T{try{const value=globalThis.localStorage?.getItem(key);return value===null||value===undefined?fallback:JSON.parse(value) as T;}catch{return fallback;}},
  set(key:string,value:unknown):void{try{globalThis.localStorage?.setItem(key,JSON.stringify(value));}catch{/* optional */}},
};
/** Layout follows the studio's own width, so the DSH right sidebar gets the compact layout even in a wide window. */
function useLayout(ref:RefObject<HTMLElement>):StageLayout{
  const [layout,setLayout]=useState<StageLayout>('wide');
  useLayoutEffect(()=>{
    const element=ref.current;if(!element||typeof ResizeObserver==='undefined')return;
    const measure=()=>{const width=element.getBoundingClientRect().width;setLayout(width<780?'narrow':width<1180?'medium':'wide');};
    measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[ref]);
  return layout;
}

export function Studio(props:StudioProps){return <ConfirmationScope><StudioContent {...props}/></ConfirmationScope>;}

function StudioContent({controller,onHome,onNew,onOpen,onConfigure,onProjectUpdated,modelConfigured,visionReady,sceneModelName,sceneConfigured,onConfigureVision,conversationBusy}:StudioProps){
  const confirmAction=useConfirmAction(),cancelConfirmation=useCancelConfirmation();
  const [toasts]=useState(createToastStore),{toast}=toasts;
  useEffect(()=>controller.subscribe(toasts.dropUnavailableActions),[controller,toasts]);
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const snapshot=state.snapshot,project=snapshot?.project||null,task=snapshot?.task;
  const isHome=!project;
  useEffect(()=>()=>{cancelConfirmation?.();toasts.clear();controller.persistDrafts();},[controller,project?.id,isHome,cancelConfirmation,toasts]);
  const busy=conversationBusy||state.pending||task?.status==='running';
  const generating=task?.status==='running'&&['storyboard','scenes','modify','audio'].includes(task.kind);
  const locked=busy;
  const studioRef=useRef<HTMLElement>(null),canvasRef=useRef<HTMLCanvasElement>(null),graphRef=useRef<LiteGraphEditor|null>(null);
  const minimapRef=useRef<HTMLCanvasElement>(null),autoPreviewedRef=useRef('');
  const [playhead]=useState(createPlayhead);
  const layout=useLayout(studioRef);
  const [preferredStageMode,setStageModeState]=useState<StageMode>(()=>store.get<StageMode>('yingliu-agent-stage-mode','monitor'));
  const [panel,setPanel]=useState<PanelTab>(()=>store.get<PanelTab>('yingliu-agent-drawer-tab','agent'));
  const [drawerOpen,setDrawerOpen]=useState(false),[drawerHeight,setDrawerHeight]=useState(()=>store.get('yingliu-agent-drawer-height',320)),[flash,setFlash]=useState(0);
  const [pane,setPane]=useState<Pane>('properties'),[assetsOpen,setAssetsOpen]=useState(false);
  const [textOpen,setTextOpen]=useState(false),[textAsset,setTextAsset]=useState('');
  const [zoom,setZoom]=useState(.9),[outputOpen,setOutputOpen]=useState(false),[keysOpen,setKeysOpen]=useState(false);
  const [wordOpen,setWordOpen]=useState(false),[instruction,setInstruction]=useState(''),[editScope,setEditScope]=useState<'shot'|'film'>('film');
  const [dismissedTask,setDismissedTask]=useState('');
  const [agentRuns,setAgentRuns]=useState<PublicRun[]>([]),[agentLive,setAgentLive]=useState(false);
  const agentFeedRef=useRef<AgentRunFeed|null>(null);
  useEffect(()=>{
    const projectId=project?.id;
    setAgentRuns([]);setAgentLive(false);
    if(!projectId)return;
    let active=true,refreshNeeded=false,refreshing=false;
    let versions=new Map<string,string>();
    async function refreshProject(){
      const current=controller.getSnapshot();
      if(!active||refreshing||!refreshNeeded||current.pending||current.snapshot?.project?.id!==projectId)return;
      refreshNeeded=false;refreshing=true;
      let refreshed=false;
      try{refreshed=await controller.refreshMediaProject();if(!refreshed)refreshNeeded=true;}
      catch{/* The next agent event can refresh after a transport failure. */}
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
        const nextVersions=new Map(list.map(run=>[run.id,`${run.status}:${run.steps.length}:${run.updatedAt??''}`]));
        if([...nextVersions].some(([id,version])=>versions.get(id)!==version))refreshNeeded=true;
        versions=nextVersions;
        void refreshProject();
      },
      onLive:setAgentLive,
    });
    agentFeedRef.current=subscription;subscription.start();
    return()=>{active=false;unsubscribe();subscription.stop();if(agentFeedRef.current===subscription)agentFeedRef.current=null;};
  },[controller,project?.id]);
  const selectedShot=project?.shots.find(s=>s.id===state.selected),selectedAsset=project?.assets.find(a=>a.id===state.selected);
  const graphCheck=useMemo(()=>project?validateGraph(project):null,[project]);
  const spec=useMemo(()=>{try{return project?compileSpec(project):null;}catch{return null;}},[project]);
  const connectedShots=project?.shotOrder.length??0;
  const totalFrames=project?.shots.reduce((sum,shot)=>sum+(project.shotOrder.includes(shot.id)?shot.durationFrames:0),0)||0;
  const fps=project?project.target.fps.num/project.target.fps.den:30;
  const duration=totalFrames/fps;
  const stageMode=layout==='narrow'&&preferredStageMode==='split'?'monitor':preferredStageMode;
  const canvasVisible=stageMode!=='monitor';
  const setStageMode=(mode:StageMode)=>{setStageModeState(mode);store.set('yingliu-agent-stage-mode',mode);};
  function canHidePanel():boolean{
    if(!controller.hasPanelDraft&&!controller.hasVolatileSourceDraft)return true;
    toast({tone:'warning',message:controller.unsavedMessage});
    return false;
  }
  function openPanel(tab:PanelTab,focus=true):boolean{
    if(tab!==panel&&!canHidePanel())return false;
    setPanel(tab);
    store.set('yingliu-agent-drawer-tab',tab);
    setDrawerOpen(true);
    if(layout==='narrow')setPane('panels');
    if(focus)setFlash(value=>value+1);
    return true;
  }
  useEffect(()=>setEditScope(selectedShot?'shot':'film'),[selectedShot?.id]);
  useEffect(()=>{if(!state.focusSerial)return;
    if(stageMode==='canvas')setStageMode(layout==='narrow'?'monitor':'split');
    if(state.selected)graphRef.current?.focus(state.selected);},[state.focusSerial]);
  const assetBaseUrl=snapshot?.assetBaseUrl||snapshot?.previewUrl;
  const assetUrl=(asset:Asset):string=>state.localImages[asset.id]||(assetBaseUrl&&asset.path?new URL(asset.path,assetBaseUrl).href:'');
  const commit=controller.edit;
  // Debounced auto-preview: ~1.2s after a saved revision settles with an outdated preview, prepare without locking edits.
  useEffect(()=>{
    if(!project||!graphCheck?.ok||state.dirty||state.saving||state.pending||state.previewing||state.conflict||state.sourceDraft||!!state.panelDraft||conversationBusy||generating||task?.status==='running')return;
    if(snapshot?.previewRevision===project.revision)return;
    const key=`${project.id}:${project.revision}`;if(autoPreviewedRef.current===key)return;
    const timer=setTimeout(()=>{
      autoPreviewedRef.current=key;
      void controller.refreshPreview().then(result=>{if(result===undefined&&autoPreviewedRef.current===key)autoPreviewedRef.current='';});
    },1200);
    return()=>clearTimeout(timer);
  },[project?.id,project?.revision,snapshot?.previewRevision,graphCheck?.ok,state.dirty,state.saving,state.pending,state.previewing,state.conflict,state.sourceDraft,state.panelDraft,conversationBusy,generating,task?.status,controller]);
  const graphUndo=useRef<EditUndo>();
  const undoAction=(undo:EditUndo|undefined)=>undo?.available()?{label:"撤销",...undo}:undefined;
  const onGraphRemoved=(removal:GraphRemoval)=>{
    const messages=removal.shots.length?[removal.shots.length===1?`已删除镜头「${removal.shots[0]}」`:`已删除 ${removal.shots.length} 个镜头`]:[];
    for(const asset of removal.assets)messages.push(asset.links?`已解除「${asset.name}」的 ${asset.links} 处关联，资产仍保留在资产库`:`「${asset.name}」没有关联任何镜头。删除资产请在资产库中操作。`);
    const action=undoAction(graphUndo.current);graphUndo.current=undefined;
    for(const [index,message] of messages.entries())toast({message,action:index===messages.length-1?action:undefined});
  };
  const removedRef=useRef(onGraphRemoved);removedRef.current=onGraphRemoved;
  useEffect(()=>{
    if(!canvasRef.current||!project)return;
    const editor=new LiteGraphEditor(canvasRef.current,(next,offerUndo)=>{
      if(!offerUndo)return controller.edit(next);
      const result=controller.editWithUndo(next);
      graphUndo.current=result?.undo;
      return result!==null;
    },controller.select,setZoom,removal=>removedRef.current(removal),playhead);graphRef.current=editor;
    return()=>{editor.dispose();graphRef.current=null;};
  },[project?.id,controller,playhead]);
  useEffect(()=>{graphRef.current?.attachMinimap(canvasVisible?minimapRef.current:null);},[canvasVisible,project?.id,controller]);
  useEffect(()=>{if(project)graphRef.current?.setProject(project,assetUrl);},[project,state.localImages,assetBaseUrl]);
  useEffect(()=>{graphRef.current?.setSelected(state.selected);},[state.selected,project?.id]);
  useEffect(()=>{graphRef.current?.setInteractive(!locked&&!state.sourceDraft);},[locked,state.sourceDraft]);
  useEffect(()=>{graphRef.current?.applyTheme();},[state.scheme]);
  useEffect(()=>{if(canvasVisible)requestAnimationFrame(()=>graphRef.current?.resize());},[canvasVisible,stageMode,layout]);
  useEffect(()=>{graphRef.current?.clearShotThumbs();},[project?.id,project?.revision,snapshot?.previewUrl,snapshot?.previewRevision]);
  // Thumbnail requests target the same saved revision as the canvas and obey the host's 3-frame limit.
  useEffect(()=>{
    const editor=graphRef.current;
    if(!editor||!canvasVisible||!project||!spec?.shots.length||!snapshot?.previewUrl||
      snapshot.previewRevision!==project.revision||busy||state.dirty||state.saving)return;
    let active=true;
    const entries=spec.shots.map(shot=>({shotId:shot.id,frame:Math.floor((shot.startFrame+shot.endFrame-1)/2)}));
    async function load(projectId:string,revision:number){
      for(let offset=0;active&&offset<entries.length;offset+=3){
        const batch=entries.slice(offset,offset+3);
        try{
          const result=await controller.api.call<{frames:{frame:number;url:string}[]}>('thumbnails',{
            projectId,expectedRevision:revision,frames:batch.map(entry=>entry.frame),
          });
          if(!active)return;
          const byFrame=new Map(result.frames.map(item=>[item.frame,item.url]));
          const urls:Record<string,string>={};
          for(const {shotId,frame} of batch){const url=byFrame.get(frame);if(url)urls[shotId]=url;}
          editor?.setShotThumbs(urls);
        }catch{/* Other batches can still provide thumbnails. */}
      }
    }
    const timer=setTimeout(()=>void load(project.id,project.revision),180);
    return()=>{active=false;clearTimeout(timer);};
  },[canvasVisible,project?.id,project?.revision,spec,snapshot?.previewUrl,snapshot?.previewRevision,busy,state.dirty,state.saving,controller]);
  useEffect(()=>{if(state.notice)toast({tone:'success',message:state.notice});},[state.notice]);
  useEffect(()=>{if(state.error&&!state.conflict&&!state.dirty)toast({tone:'error',message:state.error});},[state.error]);
  const lastTask=useRef<{id:string;status:string}|null>(null);
  useEffect(()=>{
    if(!task){lastTask.current=null;return;}
    const previous=lastTask.current;lastTask.current={id:task.id,status:task.status};
    if(!previous||task.status==='running')return;
    if((previous.id===task.id&&previous.status==='running')||previous.id!==task.id){
      if(task.status==='complete')toast({tone:'success',message:`${taskLabel(task.kind)}已完成`,...(task.kind==='export'?{action:{label:"查看成片",run:()=>openPanel('exports')}}:{})});
      else if(task.status==='cancelled')toast({tone:'info',message:`${taskLabel(task.kind)}已取消`});
    }
  },[task?.id,task?.status]);
  useEffect(()=>{
    const studio=studioRef.current;if(!studio)return;
    const keyboard=(e:KeyboardEvent)=>{const target=e.target instanceof Element?e.target:null;if(e.defaultPrevented||target?.closest('[role=dialog]'))return;
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'&&!isHome){e.preventDefault();setWordOpen(open=>!open);return;}
      if(e.key==='Escape'&&wordOpen){e.preventDefault();setWordOpen(false);return;}
      if(target?.closest('input, textarea, select, [contenteditable=true]')||locked)return;
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?controller.redo():controller.undo();}
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();void controller.flush();}
      if(e.key==='?'||(e.shiftKey&&e.key==='/')){e.preventDefault();setKeysOpen(open=>!open);}
      if(e.key==='['||e.key===']'){const current=controller.getSnapshot(),film=current.snapshot?.project;if(!film?.shots.length)return;const ids=[...film.shotOrder.filter(id=>film.shots.some(shot=>shot.id===id)),...film.shots.map(shot=>shot.id).filter(id=>!film.shotOrder.includes(id))];e.preventDefault();const index=ids.indexOf(current.selected||'');const next=e.key===']'?ids[(Math.max(index,0)+1)%ids.length]:ids[(index<=0?ids.length:index)-1];controller.select(next);graphRef.current?.focus(next);}
    };studio.addEventListener('keydown',keyboard);return()=>studio.removeEventListener('keydown',keyboard);
  },[controller,locked,wordOpen,isHome]);
  async function importFiles(files:FileList|null){if(!files||locked||!canHidePanel())return;for(const file of Array.from(files))await controller.importFile(file);}
  async function refreshPreview(){
    if(!canHidePanel())return;
    autoPreviewedRef.current=`${project?.id||''}:${project?.revision??''}`;
    await controller.action('preview');
  }
  async function modify(){
    if(busy||!instruction.trim()||(editScope==='shot'&&!selectedShot))return;
    if(!sceneConfigured){onConfigure();return;}
    await controller.generate('modify',instruction,editScope==='shot'?selectedShot?.id:undefined);
    if(!controller.getSnapshot().error){setInstruction('');setWordOpen(false);}
  }
  function connectOrder(ids:string[]){if(!project||locked||controller.hasSourceDraft)return;
    const next=reorderShots(project,ids);next.extensions={...next.extensions,graphEdges:ids.map((id,index)=>({from:id,to:ids[index+1]||'film-output'}))};commit(next);}
  const ordered=project?[...project.shotOrder.map(id=>project.shots.find(s=>s.id===id)).filter((s):s is Shot=>Boolean(s)),...project.shots.filter(s=>!project.shotOrder.includes(s.id))]:[];
  function addShotAfterSelection(){
    if(!project||locked||controller.hasSourceDraft)return;
    const after=selectedShot&&project.shotOrder.includes(selectedShot.id)?selectedShot.id:undefined;
    const next=addPlacedShot(project,after);
    const created=next.shots.find(shot=>!project.shots.some(old=>old.id===shot.id));
    if(commit(next)&&created)controller.select(created.id);
  }
  function removeShot(shot:Shot){
    const current=controller.getSnapshot().snapshot?.project;
    if(locked||controller.hasSourceDraft||!current||current.id!==project?.id||!current.shots.some(item=>item.id===shot.id))return;
    const result=controller.editWithUndo(deleteShot(current,shot.id));
    if(result)toast({message:`已删除镜头「${shot.title}」`,action:undoAction(result.undo)});
  }
  async function removeAsset(asset:Asset){
    if(!project||locked||!canHidePanel())return;const uses=project.shots.filter(shot=>shot.assetIds.includes(asset.id)||shot.referenceIds.includes(asset.id)).length;
    if(!await confirmAction({title:`删除资产「${asset.name}」？`,body:uses?`它正被 ${uses} 个镜头使用，删除后这些关联会一并移除。可以立即撤销，或在修改历史中恢复。`:"资产会从工程中移除。可以立即撤销，或在修改历史中恢复。",confirmLabel:"删除资产",tone:'danger'}))return;
    const state=controller.getSnapshot(),current=state.snapshot?.project;
    if(conversationBusy||state.sourceDraft||state.panelDraft||!current||current.id!==project.id||!current.assets.some(item=>item.id===asset.id))return;
    const result=controller.editWithUndo(deleteAsset(current,asset.id));
    if(result)toast({message:`已删除资产「${asset.name}」`,action:undoAction(result.undo)});
  }
  async function generate(kind:'storyboard'|'scenes'){
    if(!project||busy||!canHidePanel())return;
    if(kind==='storyboard'&&!modelConfigured||kind==='scenes'&&!sceneConfigured){onConfigure();return;}
    if(kind==='storyboard'&&project.shots.length&&((state.history?.entries.length||0)>1||project.shots.some(shot=>shot.assetIds.length||shot.referenceIds.length))){
      if(!await confirmAction({title:"重新生成分镜？",body:`模型会用新的方案替换当前 ${project.shots.length} 个镜头及其编排。之前的版本保留在「修改历史」中，可以随时恢复。`,confirmLabel:"重新生成",tone:'danger'}))return;
      const current=controller.getSnapshot();
      if(current.snapshot?.project?.id!==project.id||current.snapshot.project.revision!==project.revision||controller.hasPanelDraft||controller.hasSourceDraft)return;
    }
    await controller.generate(kind);
  }
  function onStep(id:StageId){
    if(id==='storyboard'){if(stageMode==='monitor')setStageMode('canvas');requestAnimationFrame(()=>graphRef.current?.fit());}
    else if(id==='scenes')openPanel('source');
    else if(id==='preview'){if(stageMode==='canvas')setStageMode('monitor');}
    else openPanel('exports');
  }
  const runningKind=task?.status==='running'?task.kind:'';
  const steps:StepInfo[]=project?(()=>{
    const storyboardDone=project.shots.length>0&&!!graphCheck?.ok;
    const scenesDone=!!snapshot?.previewUrl&&snapshot.previewRevision!==null;
    const previewFresh=scenesDone&&snapshot?.previewRevision===project.revision;
    const latest=project.outputs.at(-1);
    return [
      {id:'storyboard',label:"分镜",state:runningKind==='storyboard'?'running':storyboardDone?'done':project.shots.length?'warning':'current',hint:storyboardDone?`${project.shots.length} 个镜头，主链完整`:project.shots.length?"主链待连接":"画布上的镜头"},
      {id:'scenes',label:"画面",state:runningKind==='scenes'||runningKind==='modify'?'running':scenesDone?'done':storyboardDone?'current':'todo',hint:"模型与素材"},
      {id:'preview',label:"预览",state:runningKind==='preview'||state.previewing?'running':previewFresh?'done':scenesDone?'stale':'todo',hint:previewFresh?"预览与当前版本一致":"影片预览"},
      {id:'export',label:"成片",state:runningKind==='export'?'running':latest&&(snapshot?.currentExportIds?.includes(latest.id)??latest.revision===project.revision)?'done':latest?'stale':previewFresh?'current':'todo',hint:latest?`最近导出 v${latest.revision}`:"历史成片"},
    ];
  })():[];
  const menu:MenuItem[]=project?[
    {id:'output',label:"输出设定",icon:'film',onSelect:()=>setOutputOpen(true)},
    {id:'reveal',label:"打开项目文件夹",icon:'folder',disabled:!snapshot?.root,onSelect:()=>{if(snapshot?.root)void controller.action('reveal',{path:snapshot.root});}},
    {id:'media',label:"媒体模型",icon:'spark',separatorBefore:true,onSelect:()=>openPanel('media')},
    {id:'environment',label:"运行环境",icon:'settings',onSelect:()=>openPanel('environment')},
    {id:'theme',label:state.scheme==='dark'?'切换到浅色工作台':'切换到深色工作台',icon:'monitor',onSelect:()=>{
      const scheme=state.scheme==='dark'?'light':'dark';
      controller.setScheme(scheme);
      try{localStorage.setItem('yingliu-agent-workbench-scheme',scheme);}catch{/* Keep current theme for this session. */}
    }},
    {id:'keys',label:"快捷键",icon:'keyboard',hint:'?',onSelect:()=>setKeysOpen(true)},
    {id:'new',label:'新建影片',icon:'plus',separatorBefore:true,disabled:busy,onSelect:onNew},
    {id:'open',label:'打开工程目录',icon:'folder',disabled:busy,onSelect:onOpen},
  ]:[];
  const agentStatus=useMemo(()=>{
    const approval=agentRuns.find(run=>run.status==='awaiting_approval'||(run.status==='paused'&&Boolean(run.visionConsentRequired)));
    if(approval)return {state:'approval' as const,label:'智能体待批准',onClick:()=>{openPanel('agent');}};
    const activeRun=agentRuns.find(run=>['running','waiting_task'].includes(run.status));
    if(activeRun)return {state:'running' as const,label:'智能体运行中',onClick:()=>{openPanel('agent');}};
    return null;
  },[agentRuns]);
  const drawerTabs:DrawerTab<PanelTab>[]=[
    {id:'agent',label:'智能体',icon:'spark',badge:agentStatus?.state==='approval'?<i className="vs-tab-dot is-warn" aria-hidden="true"/>:agentStatus?.state==='running'?<i className="vs-tab-dot is-busy" aria-hidden="true"/>:undefined},
    {id:'audio',label:"声音与配音",icon:'music'},{id:'media',label:"模型与素材生成",icon:'spark'},{id:'source',label:"前端源码",icon:'code'},
    {id:'workflow',label:"协作制作",icon:'users'},{id:'spec',label:"制作要求",icon:'doc'},{id:'history',label:"修改历史",icon:'history'},
    {id:'tasks',label:"任务记录",icon:'tasks',badge:task?.status==='failed'?<i className="vs-tab-dot is-danger"/>:task?.status==='running'?<i className="vs-tab-dot is-busy"/>:undefined},
    {id:'exports',label:"导出成片",icon:'film',badge:project?.outputs.length?<small className="vs-tab-count">{project.outputs.length}</small>:undefined},
    {id:'environment',label:"运行环境",icon:'settings'},
  ];
  const failedTask=task&&task.status==='failed'&&task.id!==dismissedTask?task:null;
  const bannerError=state.error&&(state.conflict||state.dirty)?state.error:'';
  const lockReason=generating?"正在生成，完成后可以继续编辑":"正在处理，请稍候…";
  const effectiveDrawerOpen=drawerOpen;
  return <main ref={studioRef} className="vs-studio" data-scheme={state.scheme} data-layout={layout} lang="zh-CN">
    {project&&<StudioHeader project={project} state={state} steps={steps} task={task} agentStatus={agentStatus} busy={busy} graphOk={!!graphCheck?.ok} canExport={!!graphCheck?.ok&&!state.sourceDraft&&!state.panelDraft&&!state.conflict}
      sceneModelName={sceneModelName} sceneConfigured={sceneConfigured} onConfigure={onConfigure}
      onHome={onHome} onRename={title=>void controller.action('rename',{title},'影片名称已保存。').then(ok=>{if(ok)onProjectUpdated?.();})}
      onStep={onStep} onGenerate={kind=>void generate(kind)} onExport={()=>{
        if(!canHidePanel())return;
        if(state.sourceDraft){toast({tone:'warning',message:'本工程有源码草稿，请保存或丢弃草稿后再导出。'});return;}
        if(openPanel('tasks'))void controller.action('export');
      }}
      onCancel={()=>void controller.action('cancel')} onHistory={()=>openPanel('history')} menu={menu}/>}
    {state.loading?<div className="vs-loading"><div className="vs-skeleton-grid" aria-hidden="true"><i/><i/><i/><i/></div><span>正在打开工作台…</span></div>:!project?<div className="vs-loading"><Button icon="plus" variant="primary" onClick={onNew}>新建影片</Button><Button icon="folder" onClick={onOpen}>打开工程目录</Button></div>:<>
      {(bannerError||state.sourceDraft||failedTask)&&<div className="vs-banners">
        {bannerError&&<div className="vs-banner is-danger" role="alert"><Icon name="warning"/><span>{bannerError}</span>{state.dirty&&<Button size="sm" icon="download" onClick={()=>downloadText(`${project.title||"影片"}-本地参数副本.json`,JSON.stringify(project,null,2),'application/json;charset=utf-8')}>保存本地参数副本</Button>}{state.conflict?<Button size="sm" icon="refresh" onClick={()=>void controller.load(true)}>{state.dirty?"放弃本地参数并重新读取":"重新读取工程（保留源码草稿）"}</Button>:state.dirty?<Button size="sm" icon="check" onClick={()=>void controller.flush()}>重试保存</Button>:null}</div>}
        {failedTask&&<div className="vs-banner is-warning" role="status"><Icon name="warning"/><span><strong>{failedTask.message||taskLabel(failedTask.kind)}</strong>{failedTask.error&&<small className="vs-task-error">{failedTask.error}</small>}</span><Button size="sm" icon="tasks" onClick={()=>openPanel('tasks')}>查看任务记录</Button><IconButton icon="close" label="关闭提示" onClick={()=>setDismissedTask(failedTask.id)}/></div>}
        {state.sourceDraft&&<div className="vs-banner is-info vs-draft-banner" role="status"><Icon name="code"/><span>{state.sourceDraftCount?`${state.sourceDraftCount} 份源码草稿已保留，保存源码后才会进入预览与成片。`:'前端源码尚未保存，请在源码面板保存或丢弃草稿。'}</span><Button size="sm" onClick={()=>{const draft=controller.sourceDrafts().find(value=>project.shots.some(shot=>shot.id===value.shotId));if(draft)controller.select(draft.shotId);openPanel('source');}}>查看源码草稿</Button></div>}
      </div>}
      <div className={`vs-workbench ${assetsOpen?'is-assets-open':''}`} data-pane={pane} data-drawer={effectiveDrawerOpen?'open':'closed'}>
        <AssetsPanel project={project} selectedId={state.selected} assetUrl={assetUrl} pending={state.pending} locked={locked}
          onSelect={id=>{controller.select(id);if(layout==='narrow')setPane('properties');}} onImport={files=>void importFiles(files)} onAddText={()=>setTextOpen(true)} onDelete={asset=>void removeAsset(asset)}
          onClose={layout==='wide'?undefined:()=>{setAssetsOpen(false);if(layout==='narrow')setPane('properties');}}/>
        {assetsOpen&&layout==='medium'&&<button type="button" className="vs-scrim" aria-label="收起资产库" onClick={()=>setAssetsOpen(false)}/>}
        <Stage project={project} snapshot={snapshot!} state={state} controller={controller} playhead={playhead} layout={layout} stageMode={stageMode} onStageMode={setStageMode}
          assetsOpen={assetsOpen} onToggleAssets={()=>{if(layout==='narrow')setPane('assets');else setAssetsOpen(open=>!open);}} onOutputSettings={()=>setOutputOpen(true)}
          duration={duration} selectedShot={selectedShot} locked={locked} busy={busy} sceneConfigured={sceneConfigured} graphCheck={graphCheck} canvasRef={canvasRef} minimapRef={minimapRef} graphRef={graphRef} zoom={zoom}
          onAddShot={addShotAfterSelection} onRefreshPreview={()=>void refreshPreview()} onConnectOrder={connectOrder} ordered={ordered}
          wordOpen={wordOpen} onWordOpen={setWordOpen} editScope={editScope} onEditScope={setEditScope} instruction={instruction} onInstruction={setInstruction} onModify={()=>void modify()}/>
        <Timeline shots={ordered} connectedCount={connectedShots} fps={fps} playhead={playhead} selectedId={selectedShot?.id||null} locked={locked} onSelect={id=>{
          controller.select(id);
          if(controller.getSnapshot().selected!==id)return;
          if(canvasVisible)graphRef.current?.focus(id);
          if(layout==='narrow')setPane('properties');
        }} onReorder={connectOrder} onAdd={addShotAfterSelection} onDelete={id=>{const shot=project.shots.find(s=>s.id===id);if(shot)removeShot(shot);}}/>
        <div className="vs-pane-switch vs-segmented" role="tablist" aria-label="切换面板">
          {([['properties','info',selectedShot?"镜头属性":selectedAsset?"资产属性":"影片设定"],['assets','image',"资产库"],['panels','drawer',"工作面板"]] as const).map(([id,icon,label])=><button type="button" role="tab" key={id} aria-selected={pane===id} className={pane===id?'is-active':''} onClick={()=>{if(id==='panels')openPanel(panel,false);else setPane(id);}}><Icon name={icon}/><span>{label}</span></button>)}
        </div>
        <PropertiesPanel project={project} controller={controller} selectedShot={selectedShot} selectedAsset={selectedAsset} assetUrl={assetUrl} fps={fps} duration={duration}
          locked={locked} lockReason={lockReason} commit={commit} onOpenPanel={openPanel} onDeleteShot={removeShot} onDeleteAsset={asset=>void removeAsset(asset)}
          onDuplicateShot={shot=>commit(duplicateShot(project,shot.id))}/>
        <BottomDrawer tabs={drawerTabs} active={panel} open={effectiveDrawerOpen} height={drawerHeight} flash={flash}
          onSelect={tab=>openPanel(tab,false)} onToggle={()=>{if(!effectiveDrawerOpen||canHidePanel())setDrawerOpen(!effectiveDrawerOpen);}} onResize={height=>{setDrawerHeight(height);store.set('yingliu-agent-drawer-height',height);}}>
          <fieldset className="vs-panel-fields" disabled={conversationBusy}>
            {panel==='agent'&&<AgentPanel key={project.id} controller={controller} project={project} externalRuns={agentRuns} externalLive={agentLive} onExternalRefresh={()=>agentFeedRef.current?.refresh()}/>}
            {panel==='workflow'&&<WorkflowPanel key={project.id} controller={controller} project={project} selectedShot={selectedShot} visionReady={visionReady} onConfigure={onConfigureVision}/>}
            {panel==='media'&&<MediaPanel controller={controller} project={project} selectedShot={selectedShot}/>}
            {panel==='history'&&<HistoryPanel controller={controller}/>}
            {panel==='tasks'&&<TaskPanel controller={controller}/>}
            {panel==='exports'&&<ExportPanel project={project} controller={controller}/>}
            {panel==='audio'&&<AudioPanel project={project} snapshot={snapshot!} controller={controller} assetUrl={assetUrl} selectedShot={selectedShot} busy={busy}/>}
            {panel==='spec'&&<div className="vs-spec-view">
              {spec?<><div className="vs-spec-meta">
                <span>{spec.shots.length} 个镜头</span><span>{spec.durationSeconds.toFixed(1)} 秒</span>
                <Button size="sm" icon="copy" onClick={()=>void navigator.clipboard.writeText(specMarkdown(spec)).then(()=>controller.notify('制作要求已复制。')).catch(()=>controller.notify('复制失败，可以在下方选择文本。'))}>复制</Button>
                <Button size="sm" icon="download" onClick={()=>downloadText(project.title+'-制作要求.md',specMarkdown(spec),'text/markdown;charset=utf-8')}>导出 Markdown</Button>
                <Button size="sm" icon="download" onClick={()=>downloadText(project.title+'-制作要求.json',JSON.stringify(spec,null,2),'application/json;charset=utf-8')}>导出 JSON</Button>
              </div><pre>{specMarkdown(spec)}</pre></>:<div className="vs-dock-empty">
                <Icon name="grid"/><p>把镜头连接成一条主链，制作要求会自动整理。</p><small>{graphCheck?.errors.join('；')}</small>
              </div>}
            </div>}
            {panel==='source'&&<SourceEditor controller={controller} selectedShot={selectedShot} busy={busy} version={`${project.revision}:${task?.status==='complete'?task.id:''}`}/>}
            {panel==='environment'&&<EnvironmentPanel controller={controller} snapshot={snapshot!}/>}
          </fieldset>
        </BottomDrawer>
      </div>
    </>}
    {outputOpen&&project&&<Dialog label="输出设定" onClose={()=>setOutputOpen(false)} className="vs-output-modal"><div className="vs-section-header"><h2>输出设定</h2><IconButton icon="close" label="关闭输出设定" onClick={()=>setOutputOpen(false)}/></div><fieldset className="vs-property-scroll" disabled={locked}><OutputSettings project={project} onChange={commit}/></fieldset></Dialog>}
    {textOpen&&<Dialog label="添加文字资产" onClose={()=>setTextOpen(false)} busy={state.pending}><div className="vs-section-header"><div><h2>添加文字资产</h2><p className="vs-modal-lead">文案、故事或风格说明都可以连接到镜头，成为画面或参考。</p></div><IconButton icon="close" label="关闭" onClick={()=>setTextOpen(false)}/></div><textarea className="vs-textasset-input" aria-label="文字素材" rows={10} value={textAsset} onChange={e=>setTextAsset(e.target.value)} placeholder="粘贴文案、故事、产品介绍或风格参考…" data-dialog-autofocus/><div className="vs-modal-actions"><Button variant="primary" icon="plus" disabled={!textAsset.trim()||state.pending} onClick={()=>void controller.action('import',{name:truncate(textAsset.trim().split('\n')[0]||"文字素材",22),mime:'text/plain',text:textAsset}).then(()=>{if(!controller.getSnapshot().error){setTextOpen(false);setTextAsset('');}})}>加入资产库</Button></div></Dialog>}
    {keysOpen&&<Dialog label="快捷键" onClose={()=>setKeysOpen(false)} className="vs-keys-modal"><div className="vs-section-header"><h2>快捷键</h2><IconButton icon="close" label="关闭快捷键" onClick={()=>setKeysOpen(false)}/></div><ul className="vs-keys">
      <li><span>播放或暂停</span><span><kbd>空格</kbd></span></li>
      <li><span>上一帧 / 下一帧（监视器聚焦）</span><span><kbd>←</kbd><kbd>→</kbd></span></li>
      <li><span>上一个 / 下一个镜头</span><span><kbd>[</kbd><kbd>]</kbd></span></li>
      <li><span>在时间线上移动选中镜头</span><span><kbd>Alt</kbd><kbd>←</kbd><kbd>→</kbd></span></li>
      <li><span>用文字修改</span><span><kbd>⌘ K</kbd></span></li>
      <li><span>提交改词</span><span><kbd>⌘ Enter</kbd></span></li>
      <li><span>撤销 / 重做</span><span><kbd>⌘ Z</kbd><kbd>⇧ ⌘ Z</kbd></span></li>
      <li><span>保存工程</span><span><kbd>⌘ S</kbd></span></li>
      <li><span>删除选中镜头 / 解除资产关联</span><span><kbd>Delete</kbd></span></li>
      <li><span>收起大预览</span><span><kbd>Esc</kbd></span></li>
    </ul></Dialog>}
    <ConfirmHost/>
    <Toasts store={toasts}/>
  </main>;
}

function truncate(value:string,length:number):string{const units=[...value];return units.length>length?units.slice(0,length-1).join('')+'…':value;}
function downloadText(name:string,text:string,mime:string):void{const blob=new Blob([text],{type:mime});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name.replace(/[\\/:*?"<>|]/g,'-');document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
