import assert from 'node:assert/strict';
import test from 'node:test';
import {waitForNewTask} from '../scripts/acceptance-task.mjs';

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
