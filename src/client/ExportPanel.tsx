import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { QcReport } from '../agent/story.ts';
import type { VideoProject } from '../shared/types.ts';
import type { StudioController } from './controller.ts';
import { LocalQualityPanel } from './LocalQualityPanel.tsx';
import { ExportQualityReport } from './ExportQualityReport.tsx';
import { AppIcon, localTime } from './ui.tsx';

function formatQaValue(value:unknown):string {
  if(typeof value==='boolean')return value?'是':'否';
  if(typeof value==='string'||typeof value==='number')return String(value);
  return JSON.stringify(value);
}

export function ExportPanel({project,controller}:{project:VideoProject;controller:StudioController}){
  const {snapshot,dirty,sourceDraft}=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const [selected,setSelected]=useState<string|null>(null),[error,setError]=useState('');
  const [qcReport,setQcReport]=useState<QcReport|null>(null),[qcBusy,setQcBusy]=useState(false),[qcError,setQcError]=useState('');
  const active=useRef(true);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  useEffect(()=>{
    let mounted=true;
    setQcReport(null);setQcError('');
    void controller.api.call<{report:QcReport|null}>('agent.qc.last',{projectId:project.id})
      .then(result=>{if(mounted&&result&&'report'in result)setQcReport(result.report??null);})
      .catch(()=>{/* Mock harnesses without agent.qc.last still render exports normally. */});
    return()=>{mounted=false;};
  },[controller,project.id]);
  async function runQc(){
    setQcBusy(true);setQcError('');
    try{
      const report=await controller.api.call<QcReport>('agent.qc',{projectId:project.id});
      if(active.current)setQcReport(report);
    }catch(cause){if(active.current)setQcError(cause instanceof Error?cause.message:String(cause));}
    finally{if(active.current)setQcBusy(false);}
  }
  const outputs=[...project.outputs].reverse(),playing=outputs.find(output=>output.id===selected);
  const currentExportIds=snapshot?.currentExportIds&&new Set(snapshot.currentExportIds);
  const qcStatus=!qcReport?'none':qcReport.status??(qcReport.pass?'pass':'fail');
  const qcBadge={
    none:{tone:'is-warn',label:'尚未质检'},
    pass:{tone:'',label:'通过'},
    partial:{tone:'is-warn',label:'部分未检查'},
    fail:{tone:'is-danger',label:'未通过'},
  }[qcStatus];
  const qcMismatch=qcReport?.revision!==undefined&&qcReport.revision!==project.revision;
  return <div className="yl-export-panel">
    <section className="yl-export-qc" aria-label="导出前质检">
      <div className="yl-export-qc-head">
        <div>
          <strong>导出前质检</strong> <span className={`yl-export-qc-badge ${qcBadge.tone}`}>{qcBadge.label}</span>
          {qcReport&&<small> · 检查时间 {localTime(qcReport.checkedAt)}{qcReport.revision!==undefined?` · v${qcReport.revision}`:''}</small>}
        </div>
        <button type="button" disabled={qcBusy} onClick={()=>void runQc()}>{qcBusy?'正在质检…':'运行导出前质检'}</button>
      </div>
      {qcError&&<p className="yl-error" role="alert">{qcError}</p>}
      {qcMismatch&&<p className="vs-inline-error" role="alert">报告版本 v{qcReport.revision} 与当前工程 v{project.revision} 不一致，请重新运行导出前质检。</p>}
      {qcReport&&qcReport.issues.length>0&&<ul className="vs-qc">{qcReport.issues.map((issue,index)=><li key={index} className={`is-${issue.severity}`}>[{issue.severity}] {issue.shotId?`${issue.shotId}：`:''}{issue.message}</li>)}</ul>}
      {qcReport&&qcReport.unchecked.length>0&&<ul className="vs-qc">{qcReport.unchecked.map((item,index)=><li key={index}>未检查：{item}</li>)}</ul>}
      {qcReport&&!qcReport.issues.length&&!qcReport.unchecked.length&&!qcMismatch&&<p className="vs-media-help">当前工程关键帧与音画检查未发现异常。</p>}
    </section>
    <LocalQualityPanel project={project} controller={controller}/>
    <div className="yl-panel-heading"><div><h3>已导出的影片</h3><p>每份成片记录生成时的工程版本；继续修改不会覆盖旧成片。</p></div><span>{outputs.length} 份</span></div>
    {playing?.url&&<div className="yl-export-player"><video key={playing.id} src={playing.url} controls preload="metadata" onError={()=>setError('成片无法播放。请打开文件检查，或从任务面板重新导出。')}/><div><span>{project.title} · v{playing.revision}</span><button onClick={()=>setSelected(null)}>关闭播放</button></div></div>}
    {error&&<p className="yl-error" role="alert">{error}</p>}
    {!outputs.length?<div className="yl-panel-empty"><AppIcon name="download"/><p>完成分镜和画面后，点击「导出视频」。</p></div>:outputs.map(output=>{
      const current=!dirty&&!sourceDraft&&(currentExportIds?.has(output.id)??output.revision===project.revision);
      const qaEntries=output.qa&&typeof output.qa==='object'?Object.entries(output.qa):[];
      return <article key={output.id} className="yl-export-record">
        <span className="yl-export-icon"><AppIcon name="play"/></span>
        <div>
          <strong>影片 · v{output.revision}<small>{current?'当前工程版本':'历史版本'}</small></strong>
          <p>{output.width} × {output.height} · {output.duration.toFixed(2)} 秒 · {output.frameCount} 帧</p>
          <small>{localTime(output.createdAt)}</small>
          <p className="yl-export-path" title={output.path}>{output.path}</p>
          {output.localQuality&&<ExportQualityReport report={output.localQuality} revision={output.revision}/>}
          {qaEntries.length>0&&<details className="vs-media-advanced yl-export-qa" data-export-quality>
            <summary>成片检查摘要</summary>
            <ul>{qaEntries.map(([key,value])=><li key={key}><strong>{key}</strong>：{formatQaValue(value)}</li>)}</ul>
          </details>}
        </div>
        <div><button disabled={!output.url} onClick={()=>{setError('');setSelected(output.id);}}>播放成片</button><button onClick={()=>void controller.action('reveal',{path:output.path})}>打开文件 ↗</button></div>
      </article>;
    })}
  </div>;
}
