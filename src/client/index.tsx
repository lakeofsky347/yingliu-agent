import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { StandaloneStudioApi, StudioController } from './controller.ts';
import './tokens.css';
import './styles.css';
import './app.css';
import './theme-apply.css';

const api=new StandaloneStudioApi();
const controller=new StudioController(api);
const initialTheme=document.documentElement.dataset.theme==='darkroom'?'darkroom':'paper';
document.documentElement.dataset.theme=initialTheme;
controller.setScheme(initialTheme==='darkroom'?'dark':'light');
const mount=document.getElementById('root');
if(!mount)throw new Error('缺少应用挂载节点 #root');
createRoot(mount).render(<App controller={controller} api={api}/>);
void controller.load();
const flush=()=>{void controller.flush();};
window.addEventListener('pagehide',flush);
// Electron owns its native save/discard close flow; browser tabs need their own unload guard.
if(!window.yingliu)window.addEventListener('beforeunload',event=>{if(controller.hasUnsavedChanges){event.preventDefault();event.returnValue='';}});
window.addEventListener('blur',flush);
window.yingliu?.onBeforeClose?.(async()=>{
  await controller.flush();
  return controller.hasUnsavedChanges?{ok:false,message:controller.unsavedMessage}:{ok:true};
});
