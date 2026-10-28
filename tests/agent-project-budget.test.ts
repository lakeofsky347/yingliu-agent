import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentService } from '../src/agent/service.ts';
import { RunStore } from '../src/agent/run-store.ts';
import type { AgentPort, AgentTool, ToolRisk } from '../src/agent/contracts.ts';
import { createProject } from '../src/core/index.ts';
import { toolGateway } from './model-gateway.ts';

const model = async () => ({ parameters: { pricePerMInput: 0, pricePerMOutput: 0 }, vision: false, config: { baseUrl: 'http://gateway.test/v1', model: 'mock', timeoutMs: 5000, maxTokens: 1000, supportsTools: true } });
async function settled(service: AgentService, id: string) {
  for (let i = 0; i < 500; i++) { const run = await service.get(id); if (['complete', 'failed', 'awaiting_approval', 'budget_exceeded'].includes(run.status)) return run; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('运行未停止：' + (await service.get(id)).status);
}
function tool(name: string, risk: ToolRisk, run: AgentTool['run']): AgentTool { return { name, risk, description: '预算隔离测试', parameters: {}, estimate: () => 1, run }; }

for (const risk of ['read', 'write', 'cost', 'export'] as const) {
  test(`项目费用达到上限后，同一批次中的 ${risk} 工具保留在队列且不执行`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yingliu-budget-batch-')); let paid = 0, later = 0;
    const project = { ...createProject('项目预算隔离测试'), id: 'project-budget' };
    const gateway = toolGateway((_body, turn) => turn === 0 ? { toolCalls: [{ name: 'spend_once', arguments: {} }, { name: 'later', arguments: {} }] } : { text: '完成' });
    const service = new AgentService(directory, { snapshot: async () => ({ project, task: null }) } as unknown as AgentPort, { resolveModel: model, fetch: gateway.fetch, tools: [
      tool('spend_once', 'cost', async () => { paid++; return { content: '已花费 1', cost: 1 }; }),
      tool('later', risk, async () => { later++; return { content: '后续工具', ...(risk === 'cost' ? { cost: 1 } : {}) }; }),
    ] });
    try {
      await service.setProjectBudget(project.id, 1);
      const started = await service.start({ projectId: project.id, goal: '同批次工具', autoApprove: ['read', 'write', 'cost', 'export'] });
      const done = await settled(service, started.id);
      assert.equal(done.status, 'budget_exceeded'); assert.match(done.message, /项目累计花费/);
      assert.equal(paid, 1); assert.equal(later, 0); assert.equal(gateway.requests.length, 1);
      assert.equal(done.pending, undefined); assert.equal(done.queue.length, 1); assert.equal(done.queue[0].name, 'later');
      assert.equal(done.usage.toolCalls, 1); assert.equal(done.usage.cost, 1); assert.equal((await service.ledger(project.id)).spent, 1);
    } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
}

test('等待审批时收紧项目预算，已有批准也不能越过新上限提交', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-budget-approval-')); let submissions = 0;
  const project = { ...createProject('审批后预算变化'), id: 'project-budget' };
  const gateway = toolGateway((_body, turn) => turn === 0 ? { toolCalls: [{ name: 'paid', arguments: {} }] } : { text: '完成' });
  const service = new AgentService(directory, { snapshot: async () => ({ project, task: null }) } as unknown as AgentPort, { resolveModel: model, fetch: gateway.fetch, tools: [tool('paid', 'cost', async () => { submissions++; return { content: '已提交', cost: 1 }; })] });
  try {
    await service.setProjectBudget(project.id, 10);
    const started = await service.start({ projectId: project.id, goal: '等待批准', autoApprove: ['read'] });
    const awaiting = await settled(service, started.id); assert.equal(awaiting.status, 'awaiting_approval');
    await service.setProjectBudget(project.id, 0);
    await service.approve(started.id, awaiting.pending!.callId, awaiting.pending!.execId);
    const done = await settled(service, started.id);
    assert.equal(done.status, 'budget_exceeded'); assert.equal(submissions, 0); assert.equal(done.queue.length, 1);
    assert.equal((await service.ledger(project.id)).spent, 0); assert.equal(gateway.requests.length, 1);
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('批准后准备工具期间收紧项目预算，在真正提交前停止并清除未提交回执', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-budget-preparation-')); let submissions = 0, pausePreparation = false;
  const project = { ...createProject('执行前预算变化'), id: 'project-budget' };
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const gateway = toolGateway((_body, turn) => turn === 0 ? { toolCalls: [{ name: 'paid', arguments: {} }] } : { text: '完成' });
  const service = new AgentService(directory, {
    snapshot: async () => ({ project, task: null }), capabilities: async () => { if (pausePreparation) { enter(); await gate; } return { roles: [] }; },
  } as unknown as AgentPort, { resolveModel: model, fetch: gateway.fetch, tools: [tool('paid', 'cost', async () => { submissions++; return { content: '已提交', cost: 1 }; })] });
  try {
    await service.setProjectBudget(project.id, 10);
    const started = await service.start({ projectId: project.id, goal: '执行前收紧预算', autoApprove: ['read'] });
    const awaiting = await settled(service, started.id); assert.equal(awaiting.status, 'awaiting_approval');
    pausePreparation = true;
    await service.approve(started.id, awaiting.pending!.callId, awaiting.pending!.execId);
    await entered; await service.setProjectBudget(project.id, 0); release();
    const done = await settled(service, started.id);
    assert.equal(done.status, 'budget_exceeded'); assert.equal(submissions, 0); assert.equal(done.queue.length, 1);
    assert.equal(done.inFlight, undefined); assert.equal(done.uncertainSubmissions?.length ?? 0, 0);
    assert.equal(done.steps.find(step => step.kind === 'tool')?.status, 'skipped');
    assert.equal(done.usage.toolCalls, 0); assert.equal((await service.ledger(project.id)).spent, 0); assert.equal(gateway.requests.length, 1);
  } finally { release(); await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('重启后先结算已成功回执并恢复任务归属，再按已达项目上限停止', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-budget-receipt-')); let submissions = 0;
  const project = { ...createProject('预算停止前结算'), id: 'project-budget' };
  const gateway = toolGateway(() => ({ toolCalls: [{ name: 'paid', arguments: {} }] }));
  const port = { snapshot: async () => ({ project, task: null }) } as unknown as AgentPort;
  let service = new AgentService(directory, port, { resolveModel: model, fetch: gateway.fetch, tools: [tool('paid', 'cost', async () => { submissions++; return { content: '已成功', cost: 1, projectTask: { id: 'owned-task', kind: 'export' } }; })] });
  const store = (service as unknown as { store: RunStore }).store, trace = store.trace.bind(store); let fail = true;
  store.trace = async (id, event) => { if (fail && event.event === 'step.finish' && (event.step as { kind?: string })?.kind === 'tool') { fail = false; throw new Error('隔离 trace 写入故障'); } return trace(id, event); };
  try {
    await service.setProjectBudget(project.id, 1);
    const started = await service.start({ projectId: project.id, goal: '成功回执', autoApprove: ['read', 'cost'] });
    assert.equal((await settled(service, started.id)).status, 'failed');
    assert.equal((await service.ledger(project.id)).spent, 1);
    await service.dispose(); service = new AgentService(directory, port, { resolveModel: model, fetch: gateway.fetch });
    await service.resume(started.id); const done = await settled(service, started.id);
    assert.equal(done.status, 'budget_exceeded'); assert.equal(submissions, 1); assert.equal(gateway.requests.length, 1);
    assert.equal(done.queue.length, 0); assert.equal(done.inFlight, undefined); assert.equal(done.usage.cost, 1); assert.equal(done.usage.toolCalls, 1);
    assert.equal(done.taskRefs?.[0].id, 'owned-task'); assert.equal((await service.ledger(project.id)).spent, 1);
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});
