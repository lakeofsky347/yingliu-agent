import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes } from 'react';
import type { SceneSource, Shot } from '../shared/types.ts';
import type { StudioController } from './controller.ts';

const noopSubscribe = () => () => {};
const EMPTY_STATE = { snapshot: null, error: '' } as unknown as ReturnType<StudioController['getSnapshot']>;
const getEmptyState = () => EMPTY_STATE;

function SourceButton({icon,children,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{icon:'undo'|'check'}){
  return <button {...props}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={icon==='undo'?'M8 4 3 9l5 5M3 9h10a7 7 0 0 1 0 14':'m5 12 4 4L19 6'}/></svg><span>{children}</span></button>;
}

function downloadDraft(name:string,source:SceneSource){
  const url=URL.createObjectURL(new Blob([JSON.stringify(source,null,2)],{type:'application/json;charset=utf-8'})),link=document.createElement('a');
  link.href=url;link.download=name+'-源码草稿.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function SourceEditor({controller,selectedShot,busy,version}:{controller:StudioController;selectedShot?:Shot;busy:boolean;version:string}){
  const hasDraftStore=typeof (controller as Partial<StudioController>).subscribe==='function'&&typeof (controller as Partial<StudioController>).getSourceDraft==='function';
  const state=useSyncExternalStore(hasDraftStore?controller.subscribe:noopSubscribe,hasDraftStore?controller.getSnapshot:getEmptyState,hasDraftStore?controller.getSnapshot:getEmptyState);
  const project=state.snapshot?.project,projectId=project?.id;
  const [saved,setSaved]=useState<SceneSource|null>(null),[loadedRevision,setLoadedRevision]=useState(0),[language,setLanguage]=useState<'html'|'css'|'js'>('html'),[loading,setLoading]=useState(true),[error,setError]=useState(''),[dirty,setDirty]=useState(false),[reload,setReload]=useState(0),[confirm,setConfirm]=useState<'discard'|'restore'|null>(null);
  const previousShot=useRef<string|undefined>(undefined);
  const draft=hasDraftStore&&selectedShot?controller.getSourceDraft(selectedShot.id,projectId):undefined;
  const source=draft?.source??saved;

  // Hide unloaded/stale source before the browser can present it as editable.
  // Keep an existing manual draft when a project version refreshes underneath it.
  useLayoutEffect(()=>{
    let active=true;
    const shotChanged=previousShot.current!==selectedShot?.id;
    previousShot.current=selectedShot?.id;
    setConfirm(null);
    if(!selectedShot){setSaved(null);setLoading(false);if(shotChanged)setDirty(false);return;}
    setError('');
    if(shotChanged)setDirty(false);
    if(!hasDraftStore&&!shotChanged&&dirty){setLoading(false);return;}
    setLoading(true);
    setSaved(null);
    const revision=hasDraftStore?(controller.confirmedRevision??0):0;
    controller.readSource(selectedShot.id).then(value=>{
      if(active){setSaved(value);setLoadedRevision(revision);if(!hasDraftStore)setDirty(false);}
    }).catch(e=>{
      if(active)setError(e instanceof Error?e.message:'读取源码失败');
    }).finally(()=>{
      if(active)setLoading(false);
    });
    return()=>{active=false;};
  },[selectedShot?.id,controller,projectId,version,reload]);

  useEffect(()=>{
    if(hasDraftStore)return;
    controller.setSourceDraftDirty(dirty);
    return()=>controller.setSourceDraftDirty(false);
  },[controller,dirty,hasDraftStore]);

  const stale=!!(hasDraftStore&&draft&&draft.baseRevision!==(controller.confirmedRevision??draft.baseRevision));
  const hasEdit=hasDraftStore?!!draft:dirty;

  function editLanguage(nextValue:string){
    const current=source||{html:'',css:'',js:''};
    const next={...current,[language]:nextValue};
    if(hasDraftStore&&selectedShot){
      controller.setSourceDraft(selectedShot.id,next,loadedRevision);
    }else{
      setSaved(next);
      setDirty(true);
    }
  }

  async function save(useCurrentRevision=false){
    if(!source||!selectedShot)return;
    const result=hasDraftStore?await controller.saveSource(selectedShot.id,source,useCurrentRevision):await controller.saveSource(selectedShot.id,source);
    const ok=(result as unknown)!==false&&!controller.getSnapshot().error;
    if(ok){setSaved(source);setDirty(false);setError('');setConfirm(null);}
    else setError(controller.getSnapshot().error||'源码尚未保存，草稿仍保留。');
  }

  async function restore(){
    if(!selectedShot)return;
    try{
      const result=await controller.restoreSource(selectedShot.id);
      if((result as unknown)===false||controller.getSnapshot().error)throw new Error(controller.getSnapshot().error||'恢复源码失败');
      const value=await controller.readSource(selectedShot.id);
      setSaved(value);setDirty(false);setError('');setConfirm(null);
      if(hasDraftStore)setReload(count=>count+1);
    }catch(cause){setError(cause instanceof Error?cause.message:'恢复源码失败');}
  }

  const drafts=hasDraftStore?controller.sourceDrafts(projectId):[];
  const shelf=drafts.length>0&&<div className="vs-source-draft-list"><span>本工程的源码草稿</span>{drafts.map(item=>{const shot=project?.shots.find(value=>value.id===item.shotId);return <div key={item.shotId}><button disabled={!shot} onClick={()=>controller.select(item.shotId)}>{shot?.title||'已移除镜头的草稿'}</button><button onClick={()=>downloadDraft(shot?.title||item.shotId,item.source)}>下载草稿</button>{!shot&&<button onClick={()=>controller.discardSourceDraft(item.shotId)}>丢弃草稿</button>}</div>;})}</div>;

  if(!selectedShot)return <div className="vs-source">{shelf}<div className="vs-dock-empty"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16M12 5v15M8 20h8"/></svg><p>选中一个镜头，查看与编辑它的前端源码。</p></div></div>;
  if(loading&&!draft)return <div className="vs-loading"><span className="vs-spinner"/>读取镜头源码…</div>;
  if(!source)return <div className="vs-source">{shelf}<p className="vs-inline-error" role="alert">{error||'尚未读取到镜头源码，请重新选择镜头。'}</p>{hasDraftStore&&<button onClick={()=>setReload(value=>value+1)}>重试读取源码</button>}</div>;

  return <div className="vs-source">{shelf}<div className="vs-source-toolbar"><span>{selectedShot.title}</span><div className="vs-code-tabs">{(['html','css','js'] as const).map(l=><button key={l} className={language===l?'is-active':''} onClick={()=>setLanguage(l)}>{l.toUpperCase()}</button>)}</div><span className="vs-source-dirty">{hasEdit?'草稿已保留 · 未提交':'已保存'}</span>{hasDraftStore&&draft&&<button disabled={busy} onClick={()=>setConfirm('discard')}>丢弃草稿</button>}<SourceButton icon="undo" disabled={busy} onClick={()=>hasDraftStore&&draft?setConfirm('restore'):void restore()}>恢复上次可用</SourceButton><SourceButton className="vs-primary" icon="check" disabled={!source||!hasEdit||busy||stale} onClick={()=>void save()}>保存源码</SourceButton></div>
    {stale&&<div className="vs-source-stale" role="status"><span>草稿基于 v{draft!.baseRevision}，当前工程是 v{controller.confirmedRevision}。草稿已保留，请对照最新源码后再保存。</span><button disabled={busy} onClick={()=>void controller.load().then(()=>setReload(value=>value+1))}>读取最新工程</button><details><summary>查看已保存源码</summary><pre>{saved?.[language]||'正在读取…'}</pre></details><button disabled={busy||!saved} onClick={()=>void save(true)}>将草稿保存到当前版本</button></div>}
    {confirm&&<div className="vs-source-confirm" role="alert"><span>{confirm==='discard'?'丢弃这份草稿并返回已保存源码？':'恢复上次可用源码，并丢弃此草稿？'}</span><button onClick={()=>setConfirm(null)}>取消</button><button aria-label={confirm==='discard'?'确认丢弃源码草稿':'确认恢复上次源码'} disabled={busy} onClick={()=>{if(confirm==='discard'){controller.discardSourceDraft(selectedShot.id);setConfirm(null);setReload(value=>value+1);}else void restore();}}>{confirm==='discard'?'丢弃草稿':'恢复源码'}</button></div>}
    {error&&<p className="vs-inline-error" role="alert">{error}</p>}
    <textarea disabled={busy} className="vs-code-editor" aria-label={`${language.toUpperCase()} 源码`} spellCheck={false} value={source[language]||''} onChange={e=>editLanguage(e.target.value)} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(source&&hasEdit&&!busy&&!stale)void save();}if(e.key==='Tab'){e.preventDefault();const field=e.currentTarget,start=field.selectionStart,end=field.selectionEnd,text=field.value;editLanguage(text.slice(0,start)+'  '+text.slice(end));requestAnimationFrame(()=>field.setSelectionRange(start+2,start+2));}}}/>
    <p className="vs-source-note">{hasDraftStore?'源码草稿按工程与镜头保留，保存源码后才会进入预览与成片。Ctrl / ⌘ S 保存当前源码。':'修改源码后保存，再刷新预览。镜头参数保持独立，源码中写死的属性由代码控制。'}</p>
  </div>;
}
