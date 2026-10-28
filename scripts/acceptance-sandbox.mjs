/** Observe only this application's renderer PIDs. No production bridge or launch policy is changed. */
export async function inspectNativeSandbox(native){
  return native.evaluate(({app,BrowserWindow})=>{
    const windows=BrowserWindow.getAllWindows(),metrics=app.getAppMetrics();
    const renderers=windows.map(window=>window.webContents.mainFrame.osProcessId);
    const sandboxed=renderers.map(pid=>{
      if(process.platform!=='linux')return metrics.find(metric=>metric.pid===pid)?.sandboxed===true;
      // Linux ProcessMetric omits sandboxed. Chromium's renderer applies seccomp and no_new_privs.
      if(!Number.isSafeInteger(pid)||pid<=0)return false;
      try{const status=process.getBuiltinModule('node:fs').readFileSync(`/proc/${pid}/status`,'utf8');return /^Seccomp:\s*2\s*$/m.test(status)&&/^NoNewPrivs:\s*1\s*$/m.test(status);}catch{return false;}
    });
    return {sandboxEnabled:!app.commandLine.hasSwitch('no-sandbox')&&renderers.length>0&&sandboxed.every(Boolean)};
  });
}
