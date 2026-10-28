import assert from 'node:assert/strict';
import test from 'node:test';
import {waitForNewTask,readRenderDiagnostics,snapshotTaskDiagnostic,taskFailureDiagnostic} from '../scripts/acceptance-task.mjs';
import {FAILURE_CATEGORIES,FAILURE_OPERATIONS,IO_CODES,IO_SYSCALLS,sanitizeTaskFailure} from '../src/shared/task-diagnostic.ts';

function fixture(states:any[],timeoutMs=100){let index=0,clock=0;return {read:async()=>states[Math.min(index++,states.length-1)],previousTaskId:'old',projectId:'project',minimumRevision:4,timeoutMs,pollMs:10,now:()=>clock,sleep:async(ms:number)=>{clock+=ms;}};}
const state=(id:string,status:string,extra:Record<string,unknown>={})=>({project:{id:'project',revision:4},task:{id,status,kind:'preview',revision:4,...extra}});

test('packaged GUI waits past the previous terminal task until its own new task completes',async()=>{
  const expected=state('new','complete'),options=fixture([state('old','complete'),state('old','complete'),state('new','running'),expected]);
  assert.equal(await waitForNewTask(options),expected);
});
test('a new failed task is never retried or accepted as an eventual success',async()=>{
  const options=fixture([state('new','failed',{error:'Frame is not repeatable after a cold page reload /private/fixture sk-secret'}),state('new','complete')]);
  await assert.rejects(waitForNewTask(options),(error:any)=>{assert.deepEqual(error.acceptanceDiagnostic,{expected:'complete',actual:'failed',taskKind:'preview',diagnosticCategory:'FRAME_NOT_REPEATABLE',taskRevision:4,projectRevision:4});assert.ok(!JSON.stringify(error.acceptanceDiagnostic).includes('sk-secret'));return true;});
});
test('task barriers reject a different project, task kind or stale revision',async()=>{
  for(const value of [{...state('new','complete'),project:{id:'other',revision:4}},state('new','complete',{kind:'export'}),state('new','complete',{revision:3})])await assert.rejects(waitForNewTask(fixture([value])),(error:any)=>error.acceptanceDiagnostic.diagnosticCategory==='TASK_IDENTITY_MISMATCH');
});
test('missing and indefinitely running new tasks fail within the original bounded deadline',async()=>{
  for(const [value,actual] of [[state('old','complete'),'no_new_task'],[state('new','running'),'running']] as const)await assert.rejects(waitForNewTask(fixture([value],20)),(error:any)=>error.acceptanceDiagnostic.actual===actual&&error.acceptanceDiagnostic.diagnosticCategory==='WAIT_TIMEOUT');
});
test('a cancelled task fails explicitly instead of looking like completed work',async()=>{
  await assert.rejects(waitForNewTask(fixture([state('new','cancelled')])),(error:any)=>error.acceptanceDiagnostic.actual==='cancelled');
});
test('render diagnostics read only comparison fields from the newest matching fixture revision',async()=>{
  const {mkdtemp,mkdir,writeFile,rm,utimes}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const root=await mkdtemp(join(tmpdir(),'render-diagnostic-'));
  try{
    for(const [name,revision,phase,time]of [['check-old',4,'backward',1],['check-current',4,'cold',2],['check-other',3,'backward',3]] as const){const folder=join(root,'validation',name);await mkdir(folder,{recursive:true});const file=join(folder,'check.json');await writeFile(file,JSON.stringify({projectRevision:revision,errors:[{message:'raw secret',path:'/private/file',comparison:{phase,frame:0}}]}));await utimes(file,time,time);}
    assert.deepEqual(await readRenderDiagnostics(root,4),[{phase:'cold',frame:0}]);assert.deepEqual(await readRenderDiagnostics(root,9),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('failed task barriers and native snapshots preserve fixed failure details without exception fields or chat text',async()=>{
  const failure={category:'IO_ERROR',operation:'runtime_index_publish',ioCode:'EACCES',syscall:'rename',path:'/private/fixture',errno:-4048,message:'sk-private-key'},safe={category:'IO_ERROR',operation:'runtime_index_publish',ioCode:'EACCES',syscall:'rename'};
  const latest=state('new','failed',{failure,error:'private raw task error'});
  await assert.rejects(waitForNewTask(fixture([latest])),(error:any)=>{assert.deepEqual(error.acceptanceDiagnostic.failure,safe);assert.equal(error.acceptanceDiagnostic.diagnosticCategory,'TASK_FAILED');return true;});
  const observation=snapshotTaskDiagnostic(latest,{turns:[{id:'private-turn',status:'failed',error:'sk-private-key'}]});assert.deepEqual(observation,{currentTask:{kind:'preview',status:'failed',revision:4,failure:safe},lastChatStatus:'failed'});
  for(const raw of ['private-turn','sk-private-key','/private/fixture','errno','message'])assert.ok(!JSON.stringify(observation).includes(raw));
});

test('host and upload failure allowlists stay equivalent and reject unknown labels',()=>{
  const base={category:'UNKNOWN',operation:'task_work'};
  for(const field of ['category','operation','ioCode','syscall'] as const){const values={category:FAILURE_CATEGORIES,operation:FAILURE_OPERATIONS,ioCode:IO_CODES,syscall:IO_SYSCALLS}[field];for(const value of values){const input={...base,[field]:value,path:'/private/fixture',errno:-1};assert.deepEqual(taskFailureDiagnostic(input),sanitizeTaskFailure(input));}}
  assert.equal(taskFailureDiagnostic({...base,category:'sk-private-key'}),undefined);
  assert.deepEqual(taskFailureDiagnostic({...base,ioCode:'private-code',syscall:'/private/fixture'}),base);
});

test('native failure capture returns already collected task metadata when chat history remains pending',async()=>{
  const {readFile}=await import('node:fs/promises'),{transformSync}=await import('esbuild'),{runInNewContext}=await import('node:vm');
  const source=await readFile(new URL('../scripts/verify-app.ts',import.meta.url),'utf8'),start=source.indexOf('async function currentFailureDiagnostic(){'),end=source.indexOf('async function create(',start);
  assert.ok(start>=0&&end>start);const code=transformSync(source.slice(start,end),{loader:'ts',target:'es2022'}).code;
  const failure={category:'IO_ERROR',operation:'runtime_index_publish',ioCode:'EPERM',syscall:'rename'},snapshot=state('private-id','failed',{failure,error:'sk-private-key'});
  const result=await runInNewContext(code+'\ncurrentFailureDiagnostic();',{snapshotTaskDiagnostic,readRenderDiagnostics:async()=>[],call:async(endpoint?:string)=>endpoint==='chat.history'?new Promise(()=>{}):snapshot,setTimeout:(callback:()=>void,ms:number)=>{assert.equal(ms,2000,'retain the original diagnostic deadline');return setTimeout(callback,1);},clearTimeout});
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{currentTask:{kind:'preview',status:'failed',revision:4,failure}});
  assert.ok(!JSON.stringify(result).includes('private-id'));assert.ok(!JSON.stringify(result).includes('sk-private-key'));
});
