/** Standalone browser evaluator. Never read source values, titles, IDs or paths. */
export function captureSourceUiState(){
  const all=selector=>Array.from(document.querySelectorAll(selector)),chips=all('.vs-shotchip'),tabs=all('.vs-tabs [role="tab"]');
  const sourceTabs=tabs.filter(element=>element.textContent?.trim()==='前端源码'),editors=all('textarea[aria-label="HTML 源码"]');
  const saveButtons=all('.vs-source-toolbar button').filter(element=>element.textContent?.trim()==='保存源码');
  function control(elements){
    const element=elements[0];if(!element)return {count:0,hitTest:'missing'};
    const rectangle=element.getBoundingClientRect(),style=getComputedStyle(element),visible=rectangle.width>0&&rectangle.height>0&&style.display!=='none'&&!['hidden','collapse'].includes(style.visibility);
    const inViewport=visible&&rectangle.bottom>0&&rectangle.right>0&&rectangle.top<innerHeight&&rectangle.left<innerWidth;
    const x=rectangle.x+rectangle.width/2,y=rectangle.y+rectangle.height/2,centerInside=x>=0&&y>=0&&x<innerWidth&&y<innerHeight;
    const hit=visible&&centerInside?document.elementFromPoint(x,y):null;
    return {count:elements.length,disabled:element.matches(':disabled'),visible,inViewport,
      hitTest:!visible?'hidden':!centerInside?'outside':!hit?'none':element===hit||element.contains(hit)?'self':'other',
      bounds:{x:Math.round(rectangle.x),y:Math.round(rectangle.y),width:Math.round(rectangle.width),height:Math.round(rectangle.height)}};
  }
  const active=tabs.find(element=>element.getAttribute('aria-selected')==='true'),activeText=active?.textContent?.trim();
  return {captureStatus:'CAPTURED',selectedTab:activeText==='前端源码'?'source':activeText==='影片预览'?'preview':activeText==='运行环境'?'environment':active?'other':'none',
    sourcePanel:document.querySelector('.vs-dock-content .vs-source')?'editor':document.querySelector('.vs-dock-content .vs-loading')?'loading':document.querySelector('.vs-dock-content .vs-dock-empty')?'empty':'other',
    shotCount:chips.length,selectedShotIndex:chips.findIndex(element=>element.classList.contains('is-active')),firstShotSelected:chips.length>0&&chips[0].classList.contains('is-active'),
    sourceDirty:document.querySelector('.vs-source-dirty')?.textContent?.trim()==='尚未保存',studioDisabled:!!document.querySelector('.vs-studio fieldset:disabled'),
    tabCount:all('[role="tab"]').length,buttonCount:all('button,[role="button"]').length,textboxCount:all('textarea,input[type="text"],input[type="url"],input[type="password"],[role="textbox"]').length,
    viewport:{width:innerWidth,height:innerHeight},pageScrollY:Math.round(scrollY),
    controls:{firstShot:control(chips),sourceTab:control(sourceTabs),htmlEditor:control(editors),saveSource:control(saveButtons)}};
}

/** A blocked page cannot prevent the failed acceptance result from being saved. */
export async function readSourceUiState(page,{timeoutMs=2000}={}){
  let timer;
  try{return await Promise.race([page.evaluate(captureSourceUiState),new Promise(resolve=>{timer=setTimeout(()=>resolve({captureStatus:'TIMEOUT'}),timeoutMs);})]);}
  catch{return {captureStatus:'UNAVAILABLE'};}finally{clearTimeout(timer);}
}
