import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Asset, VideoProject } from '../shared/types.ts';
import type { PublicRun, RunStep, ToolRisk } from '../agent/contracts.ts';
import { StudioController } from './controller.ts';
import { PlanReview, StoryPanel } from './StoryPanel.tsx';
import { AgentRunFeed } from './agent-feed.ts';
export { parseSse } from './agent-feed.ts';

export const runStatusNames:Record<PublicRun['status'],string>={running:'进行中',awaiting_approval:'等待你批准',waiting_task:'等待生成任务',paused:'已暂停',complete:'已完成',failed:'需要处理',cancelled:'已取消',budget_exceeded:'预算用尽'};
export const riskNames:Record<ToolRisk,string>={read:'只读',write:'修改工程',plan:'计划/预演审阅',cost:'收费生成',export:'导出'};
const roleNames:Record<string,string>={scene:'场景代码',image:'生图',video:'生视频',speech:'配音',music:'音乐',sfx:'音效',vision:'视觉检查',blender:'Blender 3D 预演'};
const stepKinds:Record<RunStep['kind'],string>={model:'思考',tool:'工具',approval:'审批',review:'自检',compress:'整理上下文'};

export function AgentPanel({controller,project,externalRuns,externalLive,externalStreamText,onExternalRefresh,onConfigure,assetUrl,compact=false,hideStory=false}:{
  controller:StudioController;project:VideoProject;
  externalRuns?:PublicRun[];externalLive?:boolean;externalStreamText?:Record<string,string>;
  onExternalRefresh?:()=>Promise<void>|void;onConfigure?:()=>void;
  assetUrl?:(asset:Asset)=>string;compact?:boolean;hideStory?:boolean;
}){
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const [goal,setGoal]=useState(''),[followup,setFollowup]=useState(''),[internalRuns,setInternalRuns]=useState<PublicRun[]>([]),[selected,setSelected]=useState<string>(()=>externalRuns?.[0]?.id??''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [allowWrite,setAllowWrite]=useState(true),[allowImages,setAllowImages]=useState(false),[maxSteps,setMaxSteps]=useState(24),[maxCost,setMaxCost]=useState(''),[internalLive,setInternalLive]=useState(false),[autoPlan,setAutoPlan]=useState(false);
  const [internalStream,setInternalStream]=useState<Record<string,string>>({});
  const [optionsOpen,setOptionsOpen]=useState(false);
  const feed=useRef<AgentRunFeed|null>(null),actionBusy=useRef(false),active=useRef(false);
  const hasExternalRuns=externalRuns!==undefined;
  const runs=hasExternalRuns?externalRuns:internalRuns;
  const live=hasExternalRuns?Boolean(externalLive):internalLive;
  const streamText=hasExternalRuns?(externalStreamText??{}):internalStream;
  const disabled=busy||state.pending;
  const [caps,setCaps]=useState<{capabilities:{roles:string[];director?:string;models?:Record<string,string>};tools:{name:string;risk:ToolRisk}[];selfMade:string[]}|null>(null);
  const canReviewImages=caps?.capabilities.roles.includes('vision')??false;
  const hasBlender=caps?.capabilities.roles.includes('blender')??false;
  async function refreshCaps(){setAllowImages(false);try{setCaps(await controller.api.call('agent.capabilities'));}catch{setCaps(null);}}
  useEffect(()=>{void refreshCaps();const listener=()=>{setCaps(null);void refreshCaps();};window.addEventListener('yingliu-models-changed',listener);return ()=>window.removeEventListener('yingliu-models-changed',listener);},[controller]);
  useEffect(()=>{
    if(!hasExternalRuns)return;
    setSelected(current=>externalRuns.some(run=>run.id===current)?current:externalRuns[0]?.id??'');
  },[hasExternalRuns,externalRuns]);
  useEffect(()=>{
    active.current=true;
    if(hasExternalRuns)return()=>{active.current=false;};
    const token=typeof document!=='undefined'?document.querySelector<HTMLMetaElement>('meta[name="yingliu-token"]')?.content:undefined;
    const subscription=new AgentRunFeed({
      list:async()=>{const result=await controller.api.call<{runs?:PublicRun[]}|undefined>('agent.list',{projectId:project.id});return Array.isArray(result?.runs)?result.runs:[];},
      connect:signal=>fetch('/events/agent?projectId='+encodeURIComponent(project.id),{method:'POST',headers:token?{'X-Yingliu-Token':token}:{},signal}),
      onRuns:list=>{
        setInternalRuns(list);
        setSelected(current=>list.some(run=>run.id===current)?current:list[0]?.id??'');
        setInternalStream(prev=>{const next={...prev};for(const item of list)if(item.status!=='running')delete next[item.id];return next;});
      },
      onDelta:(runId,text)=>setInternalStream(prev=>({...prev,[runId]:((prev[runId]??'')+text).slice(-2000)})),
      onLive:setInternalLive,
    });
    feed.current=subscription;subscription.start();
    return()=>{active.current=false;subscription.stop();if(feed.current===subscription)feed.current=null;};
  },[controller,project.id,hasExternalRuns]);
  async function act(work:()=>Promise<unknown>){
    if(actionBusy.current||state.pending)return;actionBusy.current=true;setBusy(true);setError('');
    try{await work();await (onExternalRefresh?onExternalRefresh():feed.current?.refresh());}catch(cause){if(active.current)setError(cause instanceof Error?cause.message:String(cause));}finally{actionBusy.current=false;if(active.current)setBusy(false);}
  }
  const run=runs.find(item=>item.id===selected)??runs[0];
  const consent=run?.visionConsentRequired;
  const videoReference=consent?.purpose==='video-reference';
  const consentAssetIds=consent?.assetIds?.length?consent.assetIds:(consent?.assetId?[consent.assetId]:[]);
  const consentAssets=consentAssetIds.map(id=>{
    const found=project.assets.find(asset=>asset.id===id);
    const kindLabel=found?.kind==='video'?'视频':found?.kind==='audio'?'配音':'参考图';
    return {id,kind:found?.kind??'image',label:`${kindLabel}「${found?.name??id}」`};
  });
  const referenceDescription=consentAssets.length?consentAssets.map(a=>a.label).join('、'):(consent?.role==='image'?'生图参考素材':'视频生成参考素材');
  const hasNonImageConsent=consentAssets.some(a=>a.kind==='video'||a.kind==='audio');
  const autoApprove:ToolRisk[]=allowWrite?['read','write']:['read'];if(autoPlan)autoApprove.push('plan');
  const liveDelta=run&&run.status==='running'?streamText[run.id]:'';
  const canSendFollowup=!!run&&!['awaiting_approval','cancelled','budget_exceeded'].includes(run.status);

  return <div className={`vs-agent-panel${compact?' is-compact':''}`}>
    <div className="vs-agent-compose">
      <div className="vs-agent-head">
        <div>
          <h3>智能体导演</h3>
          <p className="vs-muted">对话确认分镜 → {hasBlender?'Blender 白模预演审阅 → ':''}模型实际呈现与质检{live?' · 实时':' · 轮询'}</p>
        </div>
        {onConfigure&&<button type="button" className="vs-agent-config-btn" onClick={onConfigure}>模型设置</button>}
      </div>
      <div className="vs-agent-pipeline" aria-label="四阶段创作流程">
        <span className="is-stage">1 分镜确认</span>
        <i>›</i>
        <span className={`is-stage ${hasBlender?'is-ready':'is-muted'}`} title={hasBlender?'本机 Blender 已就绪，可先搭建白模场景/运镜预演':'未检测到 Blender，可在运行环境中配置'}>2 白模预演</span>
        <i>›</i>
        <span className="is-stage">3 审阅通过</span>
        <i>›</i>
        <span className="is-stage">4 模型呈现</span>
      </div>
      {caps&&<div className="vs-agent-caps-bar" aria-label="当前能力">
        <span className={`vs-cap-chip ${caps.capabilities.director?'is-on':'is-warn'}`}>导演：{caps.capabilities.director??'未配置'}</span>
        {caps.capabilities.roles.map(role=><span key={role} className="vs-cap-chip is-on" title={caps.capabilities.models?.[role]??role}>{roleNames[role]??role}</span>)}
        {!hasBlender&&<span className="vs-cap-chip is-off" title="在运行环境中配置 Blender 路径后自动激活白模预演工具">Blender 未配置</span>}
        <button type="button" className="vs-cap-refresh" disabled={disabled} onClick={()=>void refreshCaps()} title="刷新已接入能力">刷新</button>
      </div>}
      <div className="vs-agent-composer-box">
        <textarea rows={3} aria-label="智能体目标" placeholder={hasBlender?'描述影片创意或镜头修改；例如：先规划 4 镜悬疑短片分镜，再用 Blender 做白模走位与运镜预演供我审阅…':'描述目标；例如：把三个镜头统一成大理石白极简风格，并检查文字是否溢出。'} value={goal} onChange={e=>setGoal(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&goal.trim()&&!disabled){e.preventDefault();void act(async()=>{const reviewImages=canReviewImages&&allowImages;setAllowImages(false);const created=await controller.mediaCommand<PublicRun>('agent.start',{projectId:project.id,goal,autoApprove,allowImages:reviewImages,budget:{maxSteps,maxCost:maxCost===''?null:Number(maxCost)}});setSelected(created.id);setGoal('');});}}}/>
        <div className="vs-agent-composer-foot">
          <button type="button" className="vs-agent-opt-toggle" onClick={()=>setOptionsOpen(v=>!v)}>{optionsOpen?'收起策略 ▴':'权限与预算 ▾'}</button>
          <button type="button" className="vs-primary" disabled={disabled||!goal.trim()} onClick={()=>void act(async()=>{const reviewImages=canReviewImages&&allowImages;setAllowImages(false);const created=await controller.mediaCommand<PublicRun>('agent.start',{projectId:project.id,goal,autoApprove,allowImages:reviewImages,budget:{maxSteps,maxCost:maxCost===''?null:Number(maxCost)}});setSelected(created.id);setGoal('');})}>开始</button>
        </div>
        {optionsOpen&&<div className="vs-agent-options">
          <label><input type="checkbox" checked={allowWrite} onChange={e=>setAllowWrite(e.target.checked)}/>修改工程无需逐步确认（可撤销）</label>
          <label><input type="checkbox" checked={autoPlan} onChange={e=>setAutoPlan(e.target.checked)}/>分镜/预演审阅无需审批</label>
          <label><input type="checkbox" checked={allowImages&&canReviewImages} disabled={disabled||!canReviewImages} onChange={e=>setAllowImages(e.target.checked)}/>允许视觉模型处理本次截图</label>
          <div className="vs-agent-budget-inputs">
            <label>最多步数 <input type="number" min={1} max={200} value={maxSteps} onChange={e=>setMaxSteps(Number(e.target.value)||24)}/></label>
            <label>费用上限 <input type="number" min={0} step="0.01" placeholder="不限" value={maxCost} onChange={e=>setMaxCost(e.target.value)}/></label>
          </div>
          {!canReviewImages&&<p className="vs-media-help">截图自检需要在模型设置中配置多模态模型。</p>}
          {caps&&<p className="vs-agent-tools">{caps.tools.map(tool=><span key={tool.name} className={'is-'+tool.risk} title={riskNames[tool.risk]}>{tool.name}</span>)}</p>}
        </div>}
      </div>
      {error&&<p className="vs-inline-error" role="alert">{error}</p>}
      {!hideStory&&<StoryPanel controller={controller} project={project}/>}
    </div>
    <div className="vs-agent-runs">
      {runs.length>0&&<ul className="vs-agent-run-tabs" aria-label="智能体运行">{runs.slice(0,8).map(item=><li key={item.id}><button type="button" className={item.id===selected?'is-active':''} onClick={()=>setSelected(item.id)}>{runStatusNames[item.status]} · {item.goal.slice(0,40)}</button></li>)}</ul>}
      {run&&<div className="vs-agent-run">
        <header className="vs-agent-run-head"><strong className={`is-status is-${run.status}`}>{runStatusNames[run.status]}</strong> <span>{run.message}</span></header>
        <div className="vs-agent-budget" aria-label="用量">步数 {run.usage.steps}/{run.budget.maxSteps} · 工具 {run.usage.toolCalls}/{run.budget.maxToolCalls} · tokens {run.usage.inputTokens+run.usage.outputTokens} · 费用 {run.usage.cost.toFixed(4)} {run.usage.currency}{run.usage.unknownCostCalls?`（+${run.usage.unknownCostCalls} 未知）`:''}{run.budget.maxCost!==null?` / 上限 ${run.budget.maxCost}`:''}</div>
        {run.pending&&<div className="vs-agent-approval" role="group" aria-label="待批准">
          <p className="vs-agent-approval-head"><strong>{run.pending.tool}</strong><span className="vs-risk-tag">{riskNames[run.pending.risk]}</span></p>
          <p className="vs-muted">{run.pending.reason}</p>
          {run.pending.risk==='plan'?<PlanReview tool={run.pending.tool} args={run.pending.arguments} project={project} assetUrl={assetUrl}/>:run.pending.tool==='batch_generate_media'?(()=>{try{const b=JSON.parse(run.pending!.arguments);return Array.isArray(b.items)?<div className="vs-plan-review"><h4>场次并发生成清单（共 {b.items.length} 项）</h4><ul className="vs-plan-characters">{b.items.map((it:any,idx:number)=><li key={idx}><strong>[{String(it.kind)}] 镜头 {String(it.shotId)}</strong>：{String(it.prompt??'').slice(0,120)}</li>)}</ul></div>:<pre>{run.pending!.arguments}</pre>;}catch{return <pre>{run.pending!.arguments}</pre>;}})():<pre>{run.pending.arguments}</pre>}
          <div className="vs-agent-approval-actions">
            <button type="button" className="vs-primary" disabled={disabled} onClick={()=>void act(()=>controller.mediaCommand('agent.approve',{runId:run.id,callId:run.pending!.callId,execId:run.pending!.execId,argsHash:run.pending!.argsHash}))}>{run.pending.tool==='submit_previz_review'?'批准预演并进入正式呈现':'批准'}</button>
            <button type="button" disabled={disabled} onClick={()=>void act(()=>controller.mediaCommand('agent.reject',{runId:run.id,callId:run.pending!.callId,execId:run.pending!.execId,reason:''}))}>拒绝</button>
          </div>
        </div>}
        {consent&&<p className="vs-media-help" role="status">
          继续前请确认将{videoReference?referenceDescription:'截图'}发送给 {consent.model}（{consent.origin}）。
        </p>}
        <div className="vs-agent-actions">
          {['running','waiting_task'].includes(run.status)&&<button type="button" disabled={disabled} onClick={()=>void act(()=>controller.api.call('agent.pause',{runId:run.id}))}>暂停</button>}
          {['paused','failed'].includes(run.status)&&<button type="button" className="vs-primary" disabled={disabled} onClick={()=>void act(()=>controller.mediaCommand('agent.resume',{runId:run.id,...(consent?{visionConsentId:consent.id}:{})}))}>{consent?'授权并继续':'继续'}</button>}
          {['paused','failed'].includes(run.status)&&consent&&<button type="button" disabled={disabled} onClick={()=>void act(()=>controller.mediaCommand('agent.resume',{runId:run.id,disableVision:true}))}>{videoReference?(hasNonImageConsent?'取消媒体上传':consent?.role==='image'?'跳过参考图上传':'跳过图生视频'):'仅做本地检查'}</button>}
          {!['complete','cancelled','failed','budget_exceeded'].includes(run.status)&&<button type="button" disabled={disabled} onClick={()=>void act(()=>controller.api.call('agent.cancel',{runId:run.id}))}>取消</button>}
          <button type="button" disabled={disabled} onClick={()=>void act(async()=>{await controller.load();})}>刷新工程</button>
        </div>
        {liveDelta&&<div className="vs-agent-stream" aria-live="polite"><span className="vs-spinner"/><pre>{liveDelta}</pre></div>}
        <details className="vs-agent-steps-wrap" open={run.status==='running'||run.status==='failed'}>
          <summary>执行步骤（{run.steps.length}）</summary>
          <ol className="vs-agent-steps" aria-label="步骤">{run.steps.map(step=><li key={step.index} className={'is-'+step.status}>
            <span>{stepKinds[step.kind]}{step.tool?` · ${step.tool}`:''}{step.risk?`（${riskNames[step.risk]}）`:''}</span> <em>{step.status}</em>{step.durationMs!==undefined&&<small> {Math.round(step.durationMs)}ms</small>}
            {(step.summary||step.error)&&<details><summary>详情</summary>{step.arguments&&<pre>{step.arguments}</pre>}<p>{step.error??step.summary}</p></details>}
          </li>)}</ol>
        </details>
        <div className="vs-agent-transcript">{run.transcript.filter(item=>item.role!=='tool').map((item,index)=><p key={index} className={'is-'+item.role}><b>{item.role==='user'?'你':'智能体'}</b>{item.tool?` → ${item.tool}`:''}：{item.content}</p>)}</div>
        {run.final&&<div className="vs-agent-final"><h4>总结</h4><p>{run.final}</p></div>}
        {canSendFollowup&&<form className="vs-agent-followup" onSubmit={e=>{e.preventDefault();const msg=followup.trim();if(!msg||disabled)return;void act(async()=>{await controller.mediaCommand('agent.message',{runId:run.id,message:msg});setFollowup('');});}}>
          <input aria-label="补充指令" value={followup} disabled={disabled} onChange={e=>setFollowup(e.target.value)} placeholder={['running','waiting_task'].includes(run.status)?'运行中补充纠偏指令…':'继续追问或要求调整白模/镜头…'}/>
          <button type="submit" className="vs-primary" disabled={disabled||!followup.trim()}>发送</button>
        </form>}
      </div>}
    </div>
  </div>;
}
