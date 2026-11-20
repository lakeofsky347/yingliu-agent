import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { StandaloneStudioApi, StudioController } from './controller.ts';
import { SourceDraftStore } from './source-drafts.ts';
import './styles.css';
import './app.css';

const api=new StandaloneStudioApi();
const {readSourceDrafts,writeSourceDrafts}=window.yingliu??{};
let onDraftWarning:(warning:string)=>void=()=>{};
const drafts=readSourceDrafts&&writeSourceDrafts?await SourceDraftStore.openNative({readSourceDrafts,writeSourceDrafts},warning=>onDraftWarning(warning)):new SourceDraftStore();
const controller=new StudioController(api,drafts);
onDraftWarning=warning=>controller.notify(warning);
if(drafts.warning)onDraftWarning(drafts.warning);
try{if(localStorage.getItem('yingliu-agent-workbench-scheme')==='light')controller.setScheme('light');}catch{/* Use default dark workbench theme. */}
const mount=document.getElementById('root');
if(!mount)throw new Error('缺少应用挂载节点 #root');
createRoot(mount).render(<App controller={controller} api={api}/>);
void controller.load();
const flush=()=>{controller.persistDrafts();void controller.flush();};
window.addEventListener('pagehide',flush);
// Electron owns its native save/discard close flow; browser tabs need their own unload guard.
if(!window.yingliu)window.addEventListener('beforeunload',event=>{if(controller.hasUnpersistedChanges){event.preventDefault();event.returnValue='';}});
window.addEventListener('blur',flush);
window.yingliu?.onBeforeClose?.(async()=>{
  await controller.flush();
  await controller.flushDrafts();
  if(drafts.pending)return {ok:false,message:drafts.warning||'源码草稿未能保存，请继续编辑后重试。'};
  if(controller.hasUnpersistedChanges)return {ok:false,message:'还有尚未保存的工程修改，请继续编辑并保存。'};
  return {ok:true};
});
