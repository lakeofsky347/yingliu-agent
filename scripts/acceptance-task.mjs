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
