import {readdir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
/** A GUI click can finish before its async handler submits a task. Observe that
 * action's new task, never a previous terminal record. A failed task stays failed. */
export async function waitForNewTask({read,previousTaskId,projectId,minimumRevision,kind='preview',timeoutMs=120000,pollMs=300,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  const deadline=now()+timeoutMs;
  let latest;
  const fail=(actual,category)=>{
    const error=new Error('Packaged GUI task acceptance failed');
    error.acceptanceDiagnostic={expected:'complete',actual,taskKind:['preview','export','audio','storyboard','scenes','modify'].includes(latest?.task?.kind)?latest.task.kind:'unknown',diagnosticCategory:category,...(Number.isSafeInteger(latest?.task?.revision)?{taskRevision:latest.task.revision}:{}),...(Number.isSafeInteger(latest?.project?.revision)?{projectRevision:latest.project.revision}:{})};
    throw error;
  };
  for(;;){
    latest=await read();
    if(latest?.project?.id!==projectId)fail('wrong_project','TASK_IDENTITY_MISMATCH');
    const task=latest?.task;
    if(task?.id&&task.id!==previousTaskId){
      if(task.kind!==kind||!Number.isSafeInteger(task.revision)||task.revision<minimumRevision||task.revision!==latest.project.revision)fail('wrong_task','TASK_IDENTITY_MISMATCH');
      if(task.status==='complete')return latest;
      if(task.status!=='running'){
        const message=String(task.error??task.message??'');
        const category=/not repeatable/i.test(message)?'FRAME_NOT_REPEATABLE':/timeout|timed out|超时/i.test(message)?'WAIT_TIMEOUT':/sandbox/i.test(message)?'SANDBOX_UNAVAILABLE':'TASK_FAILED';
        fail(['failed','cancelled'].includes(task.status)?task.status:'unknown',category);
      }
    }
    if(now()>=deadline)fail(task?.id&&task.id!==previousTaskId?'running':'no_new_task','WAIT_TIMEOUT');
    await sleep(Math.min(pollMs,Math.max(0,deadline-now())));
  }
}

/** Read only the isolated fixture's newest matching render report. The upload
 * boundary applies its own enum/number/hash allowlist to these observations. */
export async function readRenderDiagnostics(root,revision){
  try{
    const folder=join(root,'validation'),names=(await readdir(folder)).filter(name=>/^check-[\w-]+$/.test(name)).slice(-200),reports=[];
    for(const name of names){try{const file=join(folder,name,'check.json'),report=JSON.parse(await readFile(file,'utf8'));if(report.projectRevision===revision)reports.push({report,time:(await stat(file)).mtimeMs});}catch{}}
    const latest=reports.sort((a,b)=>b.time-a.time)[0]?.report;
    return Array.isArray(latest?.errors)?latest.errors.map(error=>error?.comparison).filter(value=>value&&typeof value==='object').slice(0,12):[];
  }catch{return [];}
}
