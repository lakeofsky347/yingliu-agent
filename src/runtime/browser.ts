/** Browser-only frame adapter. Bundled as text so the plugin has no runtime source-file dependency. */
export const browserRuntime = String.raw`
const stage = document.getElementById('stage');
const sceneStyle = document.getElementById('scene-style');
let data, modules, images, videos, readyPromise, renderChain = Promise.resolve();
let pendingMessage, messageRendering=false;
function hash(value) { let n=2166136261; for(const c of String(value)){n^=c.charCodeAt(0);n=Math.imul(n,16777619)}return n>>>0; }
function helpers(seed) { return {
  clamp:(v,min=0,max=1)=>Math.max(min,Math.min(max,v)), lerp:(a,b,t)=>a+(b-a)*t,
  smoothstep:t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t)},
  easeOutCubic:t=>1-Math.pow(1-Math.max(0,Math.min(1,t)),3),
  easeInOutCubic:t=>t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2,
  random:key=>hash(String(seed)+':'+String(key))/4294967296
}; }
function decorateError(error,shot,frame) {
  const e=error instanceof Error?error:new Error(String(error));
  e.shotId=shot?.id;e.frame=frame;return e;
}
function assetUrl(asset){return asset.path?new URL('../'+asset.path.split('/').map(encodeURIComponent).join('/'),import.meta.url).href:undefined;}
async function init() {
  const specUrl=document.querySelector('meta[name="video-studio-spec"]')?.getAttribute('content')||'./runtime/spec.json';
  const response=await fetch(specUrl);
  if(!response.ok)throw new Error('Unable to read project runtime: '+response.status);
  data=await response.json();modules=new Map();images=new Map();videos=new Map();
  document.documentElement.style.setProperty('--video-width',data.spec.target.width+'px');
  document.documentElement.style.setProperty('--video-height',data.spec.target.height+'px');
  stage.style.width=data.spec.target.width+'px';stage.style.height=data.spec.target.height+'px';
  const fit=()=>{const scale=Math.min(window.innerWidth/data.spec.target.width,window.innerHeight/data.spec.target.height);stage.style.transform='translate(-50%,-50%) scale('+scale+')';};fit();window.addEventListener('resize',fit);
  await Promise.all(data.sources.map(async source=>{
    try{
      const module=await import(source.moduleUrl);
      if(typeof module.render!=='function')throw new Error('Scene module must export render(ctx)');
      if(module.ready!==undefined&&typeof module.ready!=='function')throw new Error('Scene ready export must be a function');
      modules.set(source.id,module);
    }catch(error){throw decorateError(error,{id:source.id});}
  }));
  const imageAssets=new Map();
  for(const shot of data.spec.shots)for(const asset of shot.assets)if(asset.kind==='image')imageAssets.set(asset.id,asset);
  await Promise.all([...imageAssets.values()].map(async asset=>{
    if(!asset.path)throw new Error('Image has no path: '+asset.id);
    const image=new Image();image.decoding='sync';image.src=assetUrl(asset);
    try{await image.decode();}catch{throw decorateError(new Error('Image cannot be decoded: '+asset.id+' ('+asset.name+')'),data.spec.shots.find(shot=>shot.assets.some(a=>a.id===asset.id)));}
    images.set(asset.id,image);
  }));
  const videoAssets=new Map();
  for(const shot of data.spec.shots){
    if(shot.videoClip){const asset=shot.assets.find(asset=>asset.id===shot.videoClip.assetId);if(!asset||asset.kind!=='video')throw new Error('Video asset missing');videoAssets.set(asset.id,asset);}
    for(const ov of shot.overlays||[])if(ov.kind==='video'){const asset=shot.assets.find(a=>a.id===ov.assetId);if(asset)videoAssets.set(asset.id,asset);}
  }
  await Promise.all([...videoAssets.values()].map(async asset=>{
    const video=document.createElement('video');video.preload='auto';video.muted=true;video.playsInline=true;
    const pending=mediaEvent(video,'loadeddata',()=>video.readyState>=2);video.src=assetUrl(asset);video.load();await pending;
    videos.set(asset.id,{video,frame:-1,asset});
  }));
  await document.fonts.ready;
  return {contractVersion:'1.0.0',frameCount:data.spec.durationFrames,shots:data.spec.shots.length};
}
function ready(){return readyPromise??=(init());}
function mediaEvent(video,event,ready) {
  if(ready&&ready())return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);video.removeEventListener(event,done);video.removeEventListener('error',failed);};
    const done=()=>{cleanup();resolve();};const failed=()=>{cleanup();reject(new Error('Video could not be decoded'));};
    const timer=setTimeout(()=>{cleanup();reject(new Error('Video frame decode timed out'));},20000);
    video.addEventListener(event,done,{once:true});video.addEventListener('error',failed,{once:true});
  });
}
async function seekVideo(video,time) {
  let callback,timer;
  const presented=typeof video.requestVideoFrameCallback==='function'?new Promise((resolve,reject)=>{
    callback=video.requestVideoFrameCallback(()=>resolve());
    timer=setTimeout(()=>reject(new Error('Video frame presentation timed out')),20000);
  }):Promise.resolve();
  const seek=mediaEvent(video,'seeked');video.currentTime=time;
  try{await Promise.all([seek,presented]);}
  finally{if(timer)clearTimeout(timer);if(callback!==undefined)video.cancelVideoFrameCallback(callback);}
}
async function videoFrame(shot,frame,canvas) {
  if(!shot.videoClip)return;
  const clip=shot.videoClip,entry=videos.get(clip.assetId);if(!entry)throw new Error('Video decoder missing');
  const {video,asset}=entry,fps=asset.fps.num/asset.fps.den,targetFps=data.spec.target.fps.num/data.spec.target.fps.den;
  const end=Math.min(clip.trimEnd===undefined?asset.duration:clip.trimEnd,asset.duration);
  const last=Math.min((asset.frameCount||Math.ceil(asset.duration*fps))-1,Math.max(0,Math.ceil(end*fps)-1));
  const sourceFrame=Math.max(0,Math.min(last,Math.floor((clip.trimStart+(frame-shot.startFrame)/targetFps*clip.speed)*fps+1e-7)));
  if(entry.frame!==sourceFrame){
    const time=Math.min((sourceFrame+.5)/fps,Math.max(0,video.duration-.000001));
    if(Math.abs(video.currentTime-time)>.000001||video.readyState<2)await seekVideo(video,time);
    entry.frame=sourceFrame;
  }
  const g=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  g.fillStyle='#000';g.fillRect(0,0,w,h);
  const scale=clip.fit==='cover'?Math.max(w/video.videoWidth,h/video.videoHeight):Math.min(w/video.videoWidth,h/video.videoHeight);
  const dw=video.videoWidth*scale,dh=video.videoHeight*scale;g.drawImage(video,(w-dw)/2,(h-dh)/2,dw,dh);
  return {assetId:asset.id,sourceFrame,time:sourceFrame/fps};
}
function contextFor(shot,frame,root,canvas) {
  const fps=data.spec.target.fps.num/data.spec.target.fps.den;
  const localFrame=frame-shot.startFrame;
  const seed=hash(data.spec.projectId+':'+shot.id);
  return {root,canvas,hasVideo:!!shot.videoClip,ctx2d:canvas.getContext('2d'),params:structuredClone(shot.params),
    assets:shot.assets.map(asset=>({...structuredClone(asset),asset:structuredClone(asset),url:assetUrl(asset),image:images.get(asset.id)})),
    frame,localFrame,progress:localFrame/Math.max(1,shot.durationFrames-1),time:localFrame/fps,
    duration:shot.durationFrames/fps,width:data.spec.target.width,height:data.spec.target.height,seed,helpers:helpers(seed)};
}
function gradeFilter(grade) {
  if(!grade)return '';
  const parts=[];
  if(typeof grade.exposure==='number'&&grade.exposure!==0)parts.push('brightness('+Math.pow(2,grade.exposure).toFixed(4)+')');
  if(typeof grade.contrast==='number'&&grade.contrast!==1)parts.push('contrast('+grade.contrast.toFixed(4)+')');
  if(typeof grade.saturation==='number'&&grade.saturation!==1)parts.push('saturate('+grade.saturation.toFixed(4)+')');
  if(typeof grade.temperature==='number'&&grade.temperature!==0){
    if(grade.temperature>0)parts.push('sepia('+(Math.min(0.35,grade.temperature/260)).toFixed(4)+')');
    else parts.push('hue-rotate('+(Math.max(-28,grade.temperature*0.24)).toFixed(2)+'deg)');
  }
  if(typeof grade.tint==='number'&&grade.tint!==0)parts.push('hue-rotate('+(grade.tint*0.18).toFixed(2)+'deg)');
  return parts.join(' ');
}
async function renderOverlays(shot,localTime,container) {
  if(!shot.overlays||!shot.overlays.length)return;
  for(const ov of shot.overlays){
    const end=ov.durationSeconds!==undefined?ov.startSeconds+ov.durationSeconds:Infinity;
    if(localTime<ov.startSeconds||localTime>=end)continue;
    const box=document.createElement('div');
    box.style.cssText='position:absolute;overflow:hidden;pointer-events:none;left:'+ov.x+'%;top:'+ov.y+'%;width:'+ov.width+'%;height:'+ov.height+'%;opacity:'+ov.opacity+';border-radius:'+(ov.borderRadius||0)+'px;';
    if(ov.kind==='image'){
      const img=images.get(ov.assetId);
      if(img){const clone=img.cloneNode();clone.style.cssText='width:100%;height:100%;object-fit:cover;display:block;';box.append(clone);}
    }else if(ov.kind==='video'){
      const entry=videos.get(ov.assetId);
      if(entry){
        const {video,asset}=entry,fps=asset.fps.num/asset.fps.den;
        const t=Math.min(Math.max(0,localTime-ov.startSeconds),Math.max(0,video.duration-0.001));
        await seekVideo(video,t);entry.frame=-1;
        const c=document.createElement('canvas');c.width=Math.max(2,Math.round(data.spec.target.width*ov.width/100));c.height=Math.max(2,Math.round(data.spec.target.height*ov.height/100));
        c.style.cssText='width:100%;height:100%;display:block;';
        c.getContext('2d').drawImage(video,0,0,c.width,c.height);box.append(c);
      }
    }
    container.append(box);
  }
}
async function renderShotContainer(shot,frame,useScopedStyle) {
  const source=data.sources.find(s=>s.id===shot.id);
  const wrapper=document.createElement('div');
  wrapper.style.cssText='position:absolute;inset:0;overflow:hidden;';
  if(useScopedStyle){const st=document.createElement('style');st.textContent=source.css;wrapper.append(st);}
  else sceneStyle.textContent=source.css;
  let videoInfo;
  if(shot.videoClip){
    const layer=document.createElement('canvas');layer.className='video-background';layer.width=data.spec.target.width;layer.height=data.spec.target.height;
    wrapper.append(layer);videoInfo=await videoFrame(shot,frame,layer);
  }
  const canvas=document.createElement('canvas');canvas.width=data.spec.target.width;canvas.height=data.spec.target.height;
  canvas.className='video-canvas';canvas.setAttribute('aria-hidden','true');wrapper.append(canvas);
  const root=document.createElement('div');root.className='scene-root';root.innerHTML=source.html;wrapper.append(root);
  const context=contextFor(shot,frame,root,canvas);context.video=videoInfo;
  const module=modules.get(shot.id);
  if(module.ready)await module.ready(context);
  await document.fonts.ready;
  await module.render(context);
  await renderOverlays(shot,context.time,wrapper);
  const filter=gradeFilter(shot.colorGrade);
  if(filter)wrapper.style.filter=filter;
  if(shot.colorGrade&&typeof shot.colorGrade.vignette==='number'&&shot.colorGrade.vignette>0){
    const vig=document.createElement('div');
    vig.style.cssText='position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle,transparent 52%,rgba(0,0,0,'+Math.min(0.9,shot.colorGrade.vignette).toFixed(3)+') 100%);';
    wrapper.append(vig);
  }
  return {wrapper,context};
}
async function draw(input) {
  await ready();
  const frame=typeof input==='number'?input:input.frame;
  if(!Number.isSafeInteger(frame)||frame<0||frame>=data.spec.durationFrames)throw new Error('Frame outside project: '+frame);
  const shotIdx=data.spec.shots.findIndex(s=>frame>=s.startFrame&&frame<s.endFrame);
  const shot=data.spec.shots[shotIdx];
  if(!shot)throw new Error('No shot owns frame '+frame);
  try {
    // Recreate the stage each frame: DOM and Canvas state never leak across seek order.
    stage.replaceChildren();stage.style.opacity='1';
    const fps=data.spec.target.fps.num/data.spec.target.fps.den;
    const localFrame=frame-shot.startFrame;
    const defaultTransFrames=Math.min(Math.max(1,Math.round(.25*fps)),Math.floor(shot.durationFrames/2));
    const transFrames=shot.transitionFrames?Math.min(shot.transitionFrames,Math.floor(shot.durationFrames/2)):defaultTransFrames;
    const prevShot=shotIdx>0?data.spec.shots[shotIdx-1]:null;
    const next=data.spec.shots[shotIdx+1];
    const dualTransition=(shot.transition==='dissolve'||shot.transition==='wipe_left')&&prevShot&&transFrames>0&&localFrame<transFrames;
    if(dualTransition){
      sceneStyle.textContent='';
      const under=await renderShotContainer(prevShot,prevShot.endFrame-1,true);
      stage.append(under.wrapper);
      const over=await renderShotContainer(shot,frame,true);
      const p=over.context.helpers.smoothstep((localFrame+1)/(transFrames+1));
      if(shot.transition==='dissolve')over.wrapper.style.opacity=String(p);
      else if(shot.transition==='wipe_left')over.wrapper.style.clipPath='inset(0 '+((1-p)*100).toFixed(2)+'% 0 0)';
      stage.append(over.wrapper);
    }else{
      const main=await renderShotContainer(shot,frame,false);
      stage.append(main.wrapper);
    }
    const subtitleTexts=[];
    if(Array.isArray(data.spec.subtitles)&&data.spec.subtitles.length){
      const globalTime=frame/fps;
      const activeCues=data.spec.subtitles.filter(c=>globalTime>=c.startSeconds&&globalTime<c.endSeconds);
      if(activeCues.length){
        const subBar=document.createElement('div');
        const fontSize=Math.max(22,Math.round(Math.min(data.spec.target.width,data.spec.target.height)*0.042));
        const bottomPct=data.spec.target.height>data.spec.target.width?9:6.5;
        subBar.style.cssText='position:absolute;left:7%;right:7%;bottom:'+bottomPct+'%;text-align:center;pointer-events:none;z-index:50;';
        subBar.innerHTML=activeCues.map(c=>{
          const txt=(c.speaker?c.speaker+'：':'')+c.text;subtitleTexts.push(txt);
          const safe=txt.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          return '<span style="display:inline-block;padding:0.22em 0.65em;border-radius:0.3em;background:rgba(10,12,18,0.68);color:#fff;font-size:'+fontSize+'px;line-height:1.42;text-shadow:0 2px 6px rgba(0,0,0,0.85);">'+safe+'</span>';
        }).join('<br/>');
        stage.append(subBar);
      }
    }
    if(shot.transition==='flash_white'&&transFrames>0&&localFrame<transFrames){
      const flashAlpha=Math.max(0,1-localFrame/transFrames)*0.85;
      const flash=document.createElement('div');
      flash.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:60;background:rgba(255,255,255,'+flashAlpha.toFixed(3)+');';
      stage.append(flash);
    }
    // Force layout before taking FontFaceSet.ready so dynamically added fonts settle.
    stage.getBoundingClientRect();
    await document.fonts.ready;
    let opacity=1;
    if(defaultTransFrames>0){
      if(shot.transition==='fade')opacity=Math.min(opacity,localFrame/transFrames);
      if(next?.transition==='fade'){
        const nextTrans=next.transitionFrames?Math.min(next.transitionFrames,Math.floor(shot.durationFrames/2)):defaultTransFrames;
        opacity=Math.min(opacity,(shot.durationFrames-1-localFrame)/nextTrans);
      }
    }
    stage.style.opacity=String(Math.max(0,Math.min(1,opacity)));
    // Freeze accidental CSS animations so the capture is controlled exclusively by frame.
    for(const animation of document.getAnimations())animation.pause();
    return {frame,sceneId:shot.id,declaredTexts:[shot.params.text,shot.params.subtitle,...subtitleTexts].filter(Boolean)};
  }catch(error){throw decorateError(error,shot,frame);}
}
function renderFrame(input) {
  const next=renderChain.then(()=>draw(input));renderChain=next.catch(()=>{});return next;
}
window.__VIDEO_WORKPACK__={contractVersion:'1.0.0',capabilities:{arbitrarySeek:true},ready,renderFrame};
function post(payload){if(window.parent!==window)window.parent.postMessage(payload,'*');}
window.addEventListener('message',event=>{
  if(event.source!==window.parent||!event.data||event.data.type!=='video-studio/render')return;
  if(!Number.isSafeInteger(event.data.frame)){post({type:'video-studio/error',message:'Frame must be an integer'});return;}
  pendingMessage=event.data.frame;
  if(messageRendering)return;
  messageRendering=true;
  void (async()=>{
    try{
      while(pendingMessage!==undefined){
        const requested=pendingMessage;pendingMessage=undefined;
        try{const info=await renderFrame({frame:requested});post({type:'video-studio/frame',...info});}
        catch(error){post({type:'video-studio/error',message:error.message,shotId:error.shotId,frame:error.frame});}
      }
    }finally{messageRendering=false;}
  })();
});
ready().then(async metadata=>{await renderFrame({frame:0});post({type:'video-studio/ready',...metadata});}).catch(error=>{
  console.error(error);post({type:'video-studio/error',message:error.message,shotId:error.shotId,frame:error.frame});
});
`;

export function runtimeHtml(width:number,height:number,resources:{runtimeUrl?:string;specUrl?:string}={}):string {
  const attribute=(value:string)=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  const spec=resources.specUrl?`<meta name="video-studio-spec" content="${attribute(resources.specUrl)}">`:'';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${spec}<link rel="icon" href="data:,"><title>映流视频预览</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000}
  body{position:relative}#stage{position:absolute;top:50%;left:50%;width:${width}px;height:${height}px;overflow:hidden;background:#101016;isolation:isolate;transform:translate(-50%,-50%)}
  .video-background,.video-canvas,.scene-root{position:absolute;inset:0;width:100%;height:100%}.scene-root{overflow:hidden}canvas{display:block}
  </style><style id="scene-style"></style></head><body><main id="stage"></main><script type="module" src="${attribute(resources.runtimeUrl??'./runtime/frame.mjs')}"></script></body></html>`;
}
