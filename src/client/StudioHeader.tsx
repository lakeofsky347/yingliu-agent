import { useEffect, useRef, useState } from 'react';
import type { TaskState, VideoProject } from '../shared/types.ts';
import type { StudioState } from './controller.ts';

import { Button, Icon } from './icons.tsx';
import { Popover } from './Feedback.tsx';

export type StageId='storyboard'|'scenes'|'preview'|'export';
export type StepState='done'|'current'|'todo'|'running'|'stale'|'warning';
export interface StepInfo { id:StageId; label:string; state:StepState; hint:string }
export interface MenuItem { id:string; label:string; icon:string; onSelect:()=>void; disabled?:boolean; danger?:boolean; separatorBefore?:boolean; hint?:string }

export function taskLabel(kind:string):string{return ({storyboard:"生成分镜",scenes:"生成画面",modify:"修改镜头",preview:"准备预览",export:"导出视频",audio:"合成声音"} as Record<string,string>)[kind]||"正在处理";}

/** Single-row studio header: identity, save state, honest progress stepper, model and primary actions. */
export function StudioHeader({project,state,steps,task,agentStatus,busy,graphOk,canExport,sceneModelName,sceneConfigured,onConfigure,onHome,onRename,onStep,onGenerate,onExport,onCancel,onHistory,onOnboarding,onToggleCopilot,copilotOpen,projects,onSwitchProject,menu}:{
  project:VideoProject;state:StudioState;steps:StepInfo[];task:TaskState|null|undefined;agentStatus?:{state:'approval'|'running';label:string;onClick:()=>void}|null;busy:boolean;graphOk:boolean;canExport:boolean;
  onHome:()=>void;onRename:(title:string)=>void;onStep:(id:StageId)=>void;onGenerate:(kind:'storyboard'|'scenes')=>void;onExport:()=>void;onCancel:()=>void;onHistory:()=>void;sceneModelName?:string;sceneConfigured:boolean;onConfigure:()=>void;
  onOnboarding?:()=>void;onToggleCopilot?:()=>void;copilotOpen?:boolean;
  projects?:{id:string;title:string;archived?:boolean}[];onSwitchProject?:(projectId:string)=>void;
  menu:MenuItem[];
}){
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState(project.title),input=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(!editing)setDraft(project.title);},[project.title,editing]);
  useEffect(()=>{if(editing)input.current?.select();},[editing]);
  const commitTitle=()=>{const value=draft.trim();setEditing(false);if(value&&value!==project.title)onRename(value);else setDraft(project.title);};
  const save=state.conflict?{tone:'danger',label:"保存冲突"}:state.saving?{tone:'busy',label:"正在保存"}:state.dirty?{tone:'warn',label:"尚未保存"}:state.sourceDraft?{tone:'warn',label:"源码未保存"}:state.panelDraft?{tone:'warn',label:state.panelDraft+"未保存"}:{tone:'ok',label:"已保存"};
  const running=task?.status==='running';
  return <header className={`vs-header ${running?'is-running':''}`}>
    {onToggleCopilot&&<button type="button" className={`vs-iconbutton ${copilotOpen?'is-active':''}`} onClick={onToggleCopilot} aria-label={copilotOpen?'收起智能体面板':'展开智能体面板'} title={copilotOpen?'收起智能体面板':'展开智能体面板'}><Icon name="spark"/></button>}
    <button type="button" className="vs-brand vs-brand-home" onClick={onHome} aria-label="项目首页" title="项目首页"><span className="vs-brandmark"><Icon name="film"/></span></button>
    <div className="vs-header-identity">
      <nav className="vs-crumbs" aria-label="位置"><button type="button" onClick={onHome}>映流智能体</button><Icon name="chevronRight"/></nav>
      {editing?<input ref={input} className="vs-title-input" aria-label="影片标题" value={draft} onChange={e=>setDraft(e.target.value)} onBlur={commitTitle} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitTitle();}if(e.key==='Escape'){e.preventDefault();setDraft(project.title);setEditing(false);}}}/>
        :<h1><button type="button" className="vs-title-button" title="点击重命名" onClick={()=>setEditing(true)} disabled={busy}>{project.title}<Icon name="text"/></button></h1>}
      <button type="button" className={`vs-save-chip vs-project-status is-${save.tone}`} onClick={onHistory} title="查看修改历史"><i/>{save.label}<span>v{project.revision}</span></button>
      {projects&&onSwitchProject&&projects.filter(item=>!item.archived).length>1&&<select className="vs-project-switch" aria-label="切换影片工程" value={project.id} disabled={busy} onChange={event=>{if(event.target.value&&event.target.value!==project.id)onSwitchProject(event.target.value);}}>{projects.filter(item=>!item.archived).map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select>}
    </div>
    <ol className="vs-stepper" aria-label="制作阶段">
      {steps.map((step,index)=><li key={step.id} className={`is-${step.state}`}>
        {index>0&&<i className="vs-step-line" aria-hidden="true"/>}
        <button type="button" aria-label={step.label} title={step.hint} aria-current={step.state==='current'?'step':undefined} onClick={()=>onStep(step.id)}>
          <span className="vs-step-dot" aria-hidden="true">{step.state==='done'?<Icon name="check"/>:step.state==='warning'||step.state==='stale'?<Icon name="warning"/>:step.state==='running'?<span className="vs-spinner"/>:index+1}</span>
          <span className="vs-step-label">{step.label}</span>
        </button>
      </li>)}
    </ol>
    <div className="vs-header-actions">
      {running&&task&&<div className="vs-task-pill" role="status" title={task.message||taskLabel(task.kind)}>
        <span className="vs-spinner"/><span className="vs-task-pill-text">{task.message||taskLabel(task.kind)}</span><b>{Math.round(task.progress*100)}%</b>
        <button type="button" onClick={onCancel} aria-label="取消" title="取消"><Icon name="close"/></button>
      </div>}
      {agentStatus&&<button type="button" className={`vs-agent-pill ${agentStatus.state==='approval'?'is-warn':'is-busy'}`} onClick={agentStatus.onClick}>{agentStatus.state==='running'?<span className="vs-spinner"/>:<Icon name="warning"/>}<span>{agentStatus.label}</span></button>}
      <button type="button" className={`vs-model-chip ${sceneConfigured?'':'is-empty'}`} aria-label="模型设置" onClick={onConfigure} title={sceneModelName?`模型设置 · ${sceneModelName}`:'模型设置'}>
        <Icon name="settings"/><span>{sceneModelName?(sceneConfigured?sceneModelName:`${sceneModelName}（待配置）`):'模型设置'}</span>
      </button>
      {onOnboarding&&<button type="button" className="vs-iconbutton" aria-label="新手引导" title="新手引导" onClick={onOnboarding}><Icon name="info"/></button>}
      <Button icon="spark" className="vs-header-generate" disabled={busy} onClick={()=>onGenerate('storyboard')} aria-label="生成分镜" title="让模型规划镜头、素材与时长">生成分镜</Button>
      <Button icon="wand" className="vs-header-generate" disabled={busy||!graphOk} onClick={()=>onGenerate('scenes')} aria-label="生成画面" title={graphOk?"让模型为每个镜头制作动画":"主链待连接"}>生成画面</Button>
      <Button variant="primary" icon="download" disabled={busy||!canExport} onClick={onExport} aria-label="导出视频" title="导出视频">导出视频</Button>
      <Popover label="更多操作" trigger={({open,toggle,ref})=><button type="button" ref={ref} className="vs-iconbutton" aria-label="更多操作" title="更多操作" aria-expanded={open} onClick={toggle}><Icon name="more"/></button>}>
        {close=><div className="vs-menu">{menu.map(item=><div key={item.id} className={item.separatorBefore?'vs-menu-group':''}><button type="button" className={item.danger?'is-danger':''} disabled={item.disabled} onClick={()=>{close();item.onSelect();}}><Icon name={item.icon}/><span>{item.label}</span>{item.hint&&<kbd>{item.hint}</kbd>}</button></div>)}</div>}
      </Popover>
    </div>
    {running&&task&&<div className="vs-header-progress" aria-hidden="true"><i style={{transform:`scaleX(${Math.max(.02,task.progress)})`}}/></div>}
  </header>;
}
