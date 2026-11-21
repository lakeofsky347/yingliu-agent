import { cloneElement, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import type { StudioSnapshot } from '../shared/types.ts';
import type { StudioController } from './controller.ts';
import { Button } from './icons.tsx';

export function Field({label,children,hint}:{label:string;children:ReactNode;hint?:string}){
  const control=isValidElement(children)&&typeof children.type==='string'&&['input','textarea','select'].includes(children.type)
    ?cloneElement(children as ReactElement<{'aria-label'?:string}>,{'aria-label':label}):children;
  return <label className="vs-field"><span>{label}</span>{control}{hint&&<small>{hint}</small>}</label>;
}

export function EnvironmentPanel({controller,snapshot}:{controller:StudioController;snapshot:StudioSnapshot}){
  const [settings,setSettings]=useState({...snapshot.environment});useEffect(()=>setSettings({...snapshot.environment}),[snapshot.environment]);
  const [health,setHealth]=useState<{canRender:boolean;canPreviz?:boolean;tools:Record<string,{available:boolean;optional?:boolean;version?:string;message?:string}>}|null>(null),[checking,setChecking]=useState(false),[error,setError]=useState('');
  const checks=[
    ['browserPath','Chromium 浏览器','browserAvailable','browser',false],
    ['ffmpegPath','FFmpeg 编码器','ffmpegAvailable','ffmpeg',false],
    ['ffprobePath','ffprobe 媒体检查','ffprobeAvailable','ffprobe',false],
    ['blenderPath','Blender（可选 · 3D 白模预演）','blenderAvailable','blender',true],
  ] as const;
  async function choose(key:'browserPath'|'ffmpegPath'|'ffprobePath'|'blenderPath'){try{const path=await window.yingliu?.pickExecutable?.();if(path){setSettings(previous=>({...previous,[key]:path}));setHealth(null);}}catch(cause){setError(cause instanceof Error?cause.message:'文件选择失败');}}
  async function save(){setChecking(true);setError('');try{await controller.action('environment',{browserPath:settings.browserPath,ffmpegPath:settings.ffmpegPath,ffprobePath:settings.ffprobePath,blenderPath:settings.blenderPath??'',maxVideoBytes:settings.maxVideoBytes??512*1024*1024});if(controller.getSnapshot().error)throw new Error(controller.getSnapshot().error);const checked=await controller.api.call<NonNullable<typeof health>>('app.health');setHealth(checked);if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('yingliu-models-changed'));if(!checked.canRender)setError('部分基础渲染工具无法执行。工程可以继续编辑；请修正路径后重新检查。');else controller.notify(checked.canPreviz?'本地渲染工具与 Blender 白模预演环境已就绪。':'本地浏览器、编码器和媒体检查工具已就绪。');}catch(cause){setError(cause instanceof Error?cause.message:'环境检查失败');}finally{setChecking(false);}}
  return <div className="vs-environment"><div className="vs-environment-intro"><h3>本地渲染与预演环境</h3><p>预览在浏览器中运行；成片由本地 Chromium 逐帧捕获，再交给 FFmpeg 编码。配置 Blender 后，智能体可在分镜确认后搭建白模场景预演，审阅通过再交给创作模型呈现。</p></div><div className="vs-environment-fields">{checks.map(([key,label,available,toolKey,optional])=>{const tool=health?.tools[toolKey],ready=tool?.available??Boolean(snapshot.environment[available]);return <Field key={key} label={label}><div className="vs-env-row"><span className={ready?'is-ready':'is-missing'}>{ready?(health?'可执行':'已检测到'):optional?'未配置（可选）':'待配置'}</span><input aria-label={label+'路径'} value={settings[key]??''} placeholder={optional?'可选：例如 /Applications/Blender.app/Contents/MacOS/Blender':'工具的绝对路径'} onChange={e=>{setSettings({...settings,[key]:e.target.value});setHealth(null);}}/>{window.yingliu?.pickExecutable&&<Button disabled={checking} onClick={()=>void choose(key)}>选择文件</Button>}</div>{tool&&<small className="vs-env-result">{tool.version||tool.message}</small>}</Field>;})}<Field label="视频文件上限（MiB）"><input aria-label="视频文件上限（MiB）" type="number" min="1" max="512" step="1" value={(settings.maxVideoBytes??512*1024*1024)/(1024*1024)} onChange={event=>setSettings({...settings,maxVideoBytes:Number(event.target.value)*1024*1024})}/><small>每个导入或生成视频的最大大小，默认 512 MiB。可降低上限以控制本地存储和处理开销。</small></Field><Button className="vs-primary" icon="check" disabled={checking||controller.busy||!(settings.maxVideoBytes===undefined||Number.isInteger(settings.maxVideoBytes/(1024*1024))&&settings.maxVideoBytes>=1024*1024&&settings.maxVideoBytes<=512*1024*1024)} onClick={()=>void save()}>{checking?'正在执行检查':'保存并检查环境'}</Button>{error&&<p className="vs-inline-error" role="alert">{error}</p>}{health?.canRender&&<p className="vs-env-result" role="status">{health.canPreviz?'本地渲染工具与 Blender 白模预演已就绪。':'本地浏览器、编码器和媒体检查工具已就绪。'}</p>}</div></div>;
}
