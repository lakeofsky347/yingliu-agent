import {chromium} from 'playwright-core';
import {failureCategory} from './acceptance-summary.mjs';
async function bounded(work,timeoutMs){
  let timer;
  try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('browser cleanup timeout')),timeoutMs);})]);}
  finally{clearTimeout(timer);}
}
/** Windows Chrome is a GUI executable: --version is not a portable readiness probe.
 * launchServer owns a fresh temporary profile and gives us a public kill handle for cleanup failures. */
export async function probeBrowserVersion(executablePath,{browserType=chromium,env,launchTimeoutMs=15000,cleanupTimeoutMs=5000}={}){
  if(!executablePath)return {status:'FAIL',diagnosticCategory:'EXECUTABLE_MISSING'};
  let server,browser,version,diagnosticCategory;
  try{
    server=await browserType.launchServer({executablePath,headless:true,chromiumSandbox:true,timeout:launchTimeoutMs,...(env?{env}:{})});
    browser=await browserType.connect(server.wsEndpoint(),{timeout:launchTimeoutMs});version=browser.version();
    if(typeof version!=='string'||!/^\d+(?:\.\d+){1,3}$/.test(version))throw new Error('Browser returned no valid version');
  }catch(error){diagnosticCategory=failureCategory(error instanceof Error?error.message:'browser startup failed');}
  finally{
    if(server){
      try{await bounded(server.close(),cleanupTimeoutMs);}
      catch{diagnosticCategory??='CHECK_FAILED';try{await bounded(server.kill(),cleanupTimeoutMs);}catch{/* The probe remains failed if forced cleanup could not be confirmed. */}}
    }
    if(browser)try{await bounded(browser.close(),cleanupTimeoutMs);}catch{diagnosticCategory??='CHECK_FAILED';}
  }
  return diagnosticCategory?{status:'FAIL',diagnosticCategory}:{status:'PASS',version:'Chromium '+version};
}
