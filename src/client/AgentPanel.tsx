import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { VideoProject } from '../shared/types.ts';
import type { PublicRun, RunStep, ToolRisk } from '../agent/contracts.ts';
import { StudioController } from './controller.ts';
import { PlanReview, StoryPanel } from './StoryPanel.tsx';
import { AgentRunFeed } from './agent-feed.ts';
export { parseSse } from './agent-feed.ts';

export const runStatusNames:Record<PublicRun['status'],string>={running:'进行中',awaiting_approval:'等待你批准',waiting_task:'等待生成任务',paused:'已暂停',complete:'已完成',failed:'需要处理',cancelled:'已取消',budget_exceeded:'预算用尽'};
export const riskNames:Record<ToolRisk,string>={read:'只读',write:'修改工程',plan:'创作计划',cost:'收费生成',export:'导出'};
const roleNames:Record<string,string>={image:'生图',video:'生视频',speech:'配音',music:'音乐',sfx:'音效',vision:'视觉检查'};
const stepKinds:Record<RunStep['kind'],string>={model:'思考',tool:'工具',approval:'审批',review:'自检',compress:'整理上下文'};

export function AgentPanel({controller,project}:{controller:StudioController;project:VideoProject}){
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const [goal,setGoal]=useState(''),[runs,setRuns]=useState<PublicRun[]>([]),[selected,setSelected]=useState<string>(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [allowWrite,setAllowWrite]=useState(true),[allowImages,setAllowImages]=useState(false),[maxSteps,setMaxSteps]=useState(24),[maxCost,setMaxCost]=useState(''),[live,setLive]=useState(false),[autoPlan,setAutoPlan]=useState(false);
  const feed=useRef<AgentRunFeed|null>(null),actionBusy=useRef(false),active=useRef(false);
  const disabled=busy||state.pending;
  const [caps,setCaps]=useState<{capabilities:{roles:string[];director?:string;models?:Record<string,string>};tools:{name:string;risk:ToolRisk}[];selfMade:string[]}|null>(null);
  async function refreshCaps(){try{setCaps(await controller.api.call('agent.capabilities'));}catch{/* optional */}}
  useEffect(()=>{void refreshCaps();const listener=()=>void refreshCaps();if(typeof window!=='undefined')window.addEventListener('yingliu-models-changed',listener);return ()=>{if(typeof window!=='undefined')window.removeEventListener('yingliu-models-changed',listener);};},[]);
  useEffect(()=>{
    active.current=true;
    const token=typeof document!=='undefined'?document.querySelector<HTMLMetaElement>('meta[name="yingliu-token"]')?.content:undefined;
    const subscription=new AgentRunFeed({
      list:async()=>(await controller.api.call<{runs:PublicRun[]}>('agent.list',{projectId:project.id})).runs,
      connect:signal=>fetch('/events/agent?projectId='+encodeURIComponent(project.id),{method:'POST',headers:token?{'X-Yingliu-Token':token}:{},signal}),
      onRuns:list=>{setRuns(list);setSelected(current=>list.some(run=>run.id===current)?current:list[0]?.id??'');},
      onLive:setLive,
    });
    feed.current=subscription;subscription.start();
    return()=>{active.current=false;subscription.stop();if(feed.current===subscription)feed.current=null;};
  },[controller,project.id]);
  async function act(work:()=>Promise<unknown>){
    if(actionBusy.current||state.pending)return;actionBusy.current=true;setBusy(true);setError('');
    try{await work();await feed.current?.refresh();}catch(cause){if(active.current)setError(cause instanceof Error?cause.message:String(cause));}finally{actionBusy.current=false;if(active.current)setBusy(false);}
  }
  const run=runs.find(item=>item.id===selected);
  const autoApprove:ToolRisk[]=allowWrite?['read','write']:['read'];if(autoPlan)autoApprove.push('plan');
  return <div className="vs-agent-panel">
    <div className="vs-agent-compose">
      <h3>交给智能体</h3>
      <p>用一句话描述目标，智能体会读取工程、逐步修改镜头、检查画面并汇报。收费生成和导出每次都会先请你批准。{live?' · 实时连接':' · 轮询模式'}</p>
      <textarea rows={3} aria-label="智能体目标" placeholder="例如：把三个镜头统一成奶油色调，标题从左侧滑入，并检查文字是否溢出。" value={goal} onChange={e=>setGoal(e.target.value)}/>
      <div className="vs-agent-options">
        <label><input type="checkbox" checked={allowWrite} onChange={e=>setAllowWrite(e.target.checked)}/>修改工程无需逐步确认（可撤销）</label>
        <label><input type="checkbox" checked={autoPlan} onChange={e=>setAutoPlan(e.target.checked)}/>创作计划无需审批</label>
        <label><input type="checkbox" checked={allowImages} onChange={e=>setAllowImages(e.target.checked)}/>允许把截图发送给模型自检</label>
        <label>最多步数 <input type="number" min={1} max={200} value={maxSteps} onChange={e=>setMaxSteps(Number(e.target.value)||24)}/></label>
        <label>费用上限 <input type="number" min={0} step="0.01" placeholder="不限" value={maxCost} onChange={e=>setMaxCost(e.target.value)}/></label>
      </div>
      <button className="vs-primary" disabled={disabled||!goal.trim()} onClick={()=>void act(async()=>{const created=await controller.mediaCommand<PublicRun>('agent.start',{projectId:project.id,goal,autoApprove,allowImages,budget:{maxSteps,maxCost:maxCost===''?null:Number(maxCost)}});setSelected(created.id);setGoal('');})}>开始</button>
      {error&&<p className="vs-error" role="alert">{error}</p>}
      {caps&&<div className="vs-agent-caps" aria-label="当前能力">
        <h4>当前能力</h4>
        <p>导演：{caps.capabilities.director??'未配置（请在模型中心绑定 director 角色）'}</p>
        <p>已接入：{caps.capabilities.roles.length?caps.capabilities.roles.map(role=>`${roleNames[role]??role}${caps.capabilities.models?.[role]?`（${caps.capabilities.models[role]}）`:''}`).join('、'):'无，只用导演文本模型'}</p>
        {caps.selfMade.length>0&&<p>由导演用代码自制：{caps.selfMade.join('、')}</p>}
        <p className="vs-agent-tools">{caps.tools.map(tool=><span key={tool.name} className={'is-'+tool.risk} title={riskNames[tool.risk]}>{tool.name}</span>)}</p>
        <button disabled={disabled} onClick={()=>void refreshCaps()}>刷新能力</button>
      </div>}
      <StoryPanel controller={controller} project={project}/>
    </div>
    <div className="vs-agent-runs">
      <ul aria-label="智能体运行">{runs.map(item=><li key={item.id}><button className={item.id===selected?'is-active':''} onClick={()=>setSelected(item.id)}>{runStatusNames[item.status]} · {item.goal.slice(0,40)}</button></li>)}</ul>
      {run&&<div className="vs-agent-run">
        <header><strong>{runStatusNames[run.status]}</strong> <span>{run.message}</span></header>
        {run.active&&<p className="vs-agent-active">本步激活工具：{run.active.tools.join('、')}</p>}
        <div className="vs-agent-budget" aria-label="用量">步数 {run.usage.steps}/{run.budget.maxSteps} · 工具 {run.usage.toolCalls}/{run.budget.maxToolCalls} · tokens {run.usage.inputTokens+run.usage.outputTokens} · 费用 {run.usage.cost.toFixed(4)} {run.usage.currency}{run.usage.unknownCostCalls?`（另有 ${run.usage.unknownCostCalls} 次费用未知）`:''}{run.budget.maxCost!==null?` / 上限 ${run.budget.maxCost}`:''}</div>
        {run.pending&&<div className="vs-agent-approval" role="group" aria-label="待批准">
          <p><strong>{run.pending.tool}</strong>（{riskNames[run.pending.risk]}）：{run.pending.reason}</p>
          {run.pending.risk==='plan'?<PlanReview tool={run.pending.tool} args={run.pending.arguments}/>:<pre>{run.pending.arguments}</pre>}
          <button className="vs-primary" disabled={disabled} onClick={()=>void act(()=>controller.mediaCommand('agent.approve',{runId:run.id,callId:run.pending!.callId,execId:run.pending!.execId,argsHash:run.pending!.argsHash}))}>批准</button>
          <button disabled={disabled} onClick={()=>void act(()=>controller.mediaCommand('agent.reject',{runId:run.id,callId:run.pending!.callId,execId:run.pending!.execId,reason:''}))}>拒绝</button>
        </div>}
        <div className="vs-agent-actions">
          {['running','waiting_task'].includes(run.status)&&<button disabled={disabled} onClick={()=>void act(()=>controller.api.call('agent.pause',{runId:run.id}))}>暂停</button>}
          {['paused','failed'].includes(run.status)&&<button disabled={disabled} onClick={()=>void act(()=>controller.mediaCommand('agent.resume',{runId:run.id}))}>继续</button>}
          {!['complete','cancelled','failed','budget_exceeded'].includes(run.status)&&<button disabled={disabled} onClick={()=>void act(()=>controller.api.call('agent.cancel',{runId:run.id}))}>取消</button>}
          <button disabled={disabled} onClick={()=>void act(async()=>{await controller.load();})}>刷新工程</button>
        </div>
        <ol className="vs-agent-steps" aria-label="步骤">{run.steps.map(step=><li key={step.index} className={'is-'+step.status}>
          <span>{stepKinds[step.kind]}{step.tool?` · ${step.tool}`:''}{step.risk?`（${riskNames[step.risk]}）`:''}</span> <em>{step.status}</em>{step.durationMs!==undefined&&<small> {Math.round(step.durationMs)}ms</small>}
          {(step.summary||step.error)&&<details><summary>详情</summary>{step.arguments&&<pre>{step.arguments}</pre>}<p>{step.error??step.summary}</p></details>}
        </li>)}</ol>
        <div className="vs-agent-transcript">{run.transcript.filter(item=>item.role!=='tool').map((item,index)=><p key={index} className={'is-'+item.role}><b>{item.role==='user'?'你':'智能体'}</b>{item.tool?` → ${item.tool}`:''}：{item.content}</p>)}</div>
        {run.final&&<div className="vs-agent-final"><h4>总结</h4><p>{run.final}</p></div>}
      </div>}
    </div>
  </div>;
}
