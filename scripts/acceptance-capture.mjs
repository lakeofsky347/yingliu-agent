/** Native screenshots are part of the test, so an inactive desktop must fail with a bounded deadline. */
export async function captureNativeViewport(native,{timeoutMs=15000}={}){
  if(!Number.isFinite(timeoutMs)||timeoutMs<1)throw new Error('Invalid native capture timeout');
  let timer;
  try{
    return await Promise.race([native.evaluate(async({BrowserWindow})=>{
      const window=BrowserWindow.getAllWindows().find(candidate=>!candidate.isDestroyed());
      if(!window)throw new Error('Native capture has no owned application window');
      if(window.isMinimized())window.restore();window.show();window.focus();
      const image=await window.webContents.capturePage(undefined,{stayAwake:true,stayHidden:false});
      if(image.isEmpty())throw new Error('Native capture returned an empty bitmap');
      return image.toPNG().toString('base64');
    }),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Native capture timeout'),{code:'CAPTURE_TIMEOUT'})),timeoutMs);})]);
  }finally{clearTimeout(timer);}
}
