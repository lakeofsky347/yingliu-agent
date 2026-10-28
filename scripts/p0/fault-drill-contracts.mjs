import assert from 'node:assert/strict';

export function assertCrashRecovery(evidence) {
  assert.ok(evidence.renderersSeen.length > 0, '崩溃前必须观察到真实渲染进程');
  assert.equal(evidence.orphansAfterGrace.length, 0, '崩溃后仍有自有渲染孤儿进程');
  assert.ok(evidence.interruptedExecId, '必须在持久化的 export_mp4 执行中崩溃，不能以已完成运行代替');
  assert.equal(evidence.run.status, 'paused', '中断的智能体必须恢复为paused');
  assert.equal(evidence.run.inFlight, undefined, '重启必须结算未完成执行');
  assert.ok(evidence.run.uncertainSubmissions?.some(item => item.execId === evidence.interruptedExecId), '重启必须保留该执行的uncertain回执');
  assert.ok(!evidence.run.queue?.some(item => item.execId === evidence.interruptedExecId), '结果未知的执行不能留在自动重投队列');
  assert.equal(evidence.project?.id, evidence.projectId, '恢复必须仍指向原工程');
  assert.equal(evidence.autoResubmittedRender, false, '重启不能自动重投渲染');
  for (const id of evidence.interruptedTaskIds ?? []) assert.ok(evidence.tasks.some(task => task.id === id && task.status === 'failed'), '中断的本地任务必须留下failed记录：' + id);
}
export function assertCancelRecovery(evidence) {
  assert.ok(evidence.renderersSeen.length > 0, '取消前必须观察到真实渲染进程');
  assert.equal(evidence.run.status, 'cancelled', '取消后必须持久记录cancelled');
  assert.equal(evidence.renderProcessesLeft.length, 0, '取消后仍有自有渲染进程');
  assert.equal(evidence.healthy, true, '取消后sidecar必须仍能处理请求');
}
export function assertLocalExportRecovery(evidence) {
  assert.ok(evidence.renderersSeen.length > 0, '本地导出任务崩溃前必须观察到真实渲染进程');
  assert.equal(evidence.orphansAfterGrace.length, 0, '本地导出崩溃后仍有自有孤儿进程');
  assert.ok(evidence.taskId, '必须记录实际已启动的本地导出任务ID');
  assert.equal(evidence.task?.id, evidence.taskId, '恢复必须核对实际中断的同一个任务');
  assert.equal(evidence.task?.status, 'failed', '中断本地导出必须恢复为failed');
  assert.match(evidence.task?.error ?? '', /TASK_INTERRUPTED/, '中断任务必须提供持久中断原因');
  assert.equal(evidence.project?.id, evidence.projectId, '导出崩溃后原工程必须仍可打开');
  assert.equal(evidence.autoResubmittedRender, false, '中断本地导出不能自行重投');
}
export function assertHostShutdown(evidence) {
  assert.equal(evidence.exitCode, 0, 'stdin关闭必须触发正常退出');
  assert.equal(evidence.ownedProcessesLeft.length, 0, '宿主退出后不能遗留自有进程');
  assert.equal(evidence.relaunchOk, true, '退出后必须可重新取得同profile锁');
}
