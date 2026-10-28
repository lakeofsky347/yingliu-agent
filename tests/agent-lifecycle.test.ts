import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentService } from '../src/agent/service.ts';
import type { AgentPort, PublicRun } from '../src/agent/contracts.ts';
import { createProject } from '../src/core/index.ts';
import { toolGateway } from './model-gateway.ts';

const model = async () => ({ parameters: {}, vision: false, config: { baseUrl: 'http://gateway.test/v1', model: 'mock', timeoutMs: 10_000, maxTokens: 1000, supportsTools: true } });
const snapshot = (projectId: string) => ({ project: { ...createProject('生命周期隔离测试'), id: projectId }, task: null }) as any;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const blockedFetch: typeof fetch = async (_url, init) => {
  const signal = init!.signal!; signal.throwIfAborted();
  return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
};
async function waitFor(service: AgentService, id: string, states: PublicRun['status'][]) {
  for (let i = 0; i < 500; i++) { const run = await service.get(id); if (states.includes(run.status)) return run; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('运行未进入预期状态：' + (await service.get(id)).status);
}

test('同项目同时启动只创建一个运行，其他项目不等待其 snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-lifecycle-start-')), entered = deferred(), release = deferred();
  let snapshots = 0;
  const port = { snapshot: async (id: string) => { if (id === 'project-a') { snapshots++; entered.resolve(); await release.promise; } return snapshot(id); } } as AgentPort;
  const service = new AgentService(directory, port, { resolveModel: model, fetch: blockedFetch });
  let first: Promise<PublicRun> | undefined, second: Promise<PublicRun> | undefined;
  try {
    first = service.start({ projectId: 'project-a', goal: 'A' }); await entered.promise;
    second = service.start({ projectId: 'project-a', goal: '重复启动' });
    const independent = await service.start({ projectId: 'project-b', goal: 'B' });
    assert.equal(independent.status, 'running'); assert.equal(snapshots, 1);
    release.resolve();
    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(rejected.reason), /该工程已有进行中的智能体运行/);
    assert.equal((await service.list('project-a')).length, 1); assert.equal(snapshots, 1);
  } finally { release.resolve(); await Promise.allSettled([first, second].filter(Boolean)); await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('恢复旧运行不能与同项目新运行并行，暂停后可恢复且重复恢复只成功一次', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-lifecycle-resume-'));
  const service = new AgentService(directory, { snapshot: async (id: string) => snapshot(id) } as AgentPort, { resolveModel: model, fetch: blockedFetch });
  try {
    const old = await service.start({ projectId: 'project-a', goal: '旧运行' }); await service.pause(old.id);
    const newer = await service.start({ projectId: 'project-a', goal: '新运行' });
    await assert.rejects(service.resume(old.id), /该工程已有进行中的智能体运行/);
    assert.equal((await service.get(old.id)).status, 'paused'); assert.equal((await service.get(newer.id)).status, 'running');
    await service.pause(newer.id);
    const results = await Promise.allSettled([service.resume(old.id), service.resume(old.id)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await service.list('project-a')).filter(run => run.status === 'running').length, 1);
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('正在等待远程任务的运行拒绝重复恢复，随后仍能正常暂停和取消', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-lifecycle-waiting-'));
  const gateway = toolGateway(() => ({ toolCalls: [{ name: 'mock_async', arguments: {} }] }));
  const service = new AgentService(directory, {
    snapshot: async (id: string) => snapshot(id), route: async () => ({ ok: true, value: { phase: 'pending' } }),
  } as unknown as AgentPort, { resolveModel: model, fetch: gateway.fetch, pollMs: 10, tools: [{
    name: 'mock_async', description: '隔离异步任务', parameters: {}, risk: 'cost', async run() { return { content: '已提交', waitFor: { kind: 'media', id: 'mock-task' } }; },
  }] });
  try {
    const started = await service.start({ projectId: 'project-a', goal: '等待任务', autoApprove: ['read', 'cost'] });
    await waitFor(service, started.id, ['waiting_task']);
    await assert.rejects(service.resume(started.id), /当前状态不能继续/);
    assert.equal((await service.pause(started.id)).status, 'paused');
    assert.equal((await service.cancel(started.id)).status, 'cancelled');
    assert.equal(gateway.requests.length, 1);
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});

for (const decisions of [['approve', 'approve'], ['approve', 'reject'], ['reject', 'reject']] as const) {
  test(`同一步并发 ${decisions.join('/')} 仅接受一个决定`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yingliu-lifecycle-approval-')); let submissions = 0;
    const gateway = toolGateway((_body, turn) => turn === 0 ? { toolCalls: [{ id: 'same-call', name: 'mock_paid', arguments: {} }] } : { text: '完成' });
    const service = new AgentService(directory, { snapshot: async (id: string) => snapshot(id) } as AgentPort, {
      resolveModel: model, fetch: gateway.fetch, tools: [{ name: 'mock_paid', description: '隔离收费工具', parameters: {}, risk: 'cost', async run() { submissions++; return { content: '已完成', cost: 1 }; } }],
    });
    try {
      const started = await service.start({ projectId: 'project-a', goal: '审批测试' });
      const pending = (await waitFor(service, started.id, ['awaiting_approval'])).pending!;
      const results = await Promise.allSettled(decisions.map(decision => service[decision](started.id, pending.callId, pending.execId)));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
      assert.match(String(rejected.reason), /没有待批准的这一步/);
      const done = await waitFor(service, started.id, ['complete', 'failed']);
      assert.equal(done.status, 'complete', done.error); assert.equal(done.pending, undefined);
      assert.equal(submissions, decisions[0] === 'approve' ? 1 : 0);
      assert.equal(done.approvals?.length ?? 0, 0);
    } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
}

test('关闭服务会等待尚未完成的启动，不会在关闭后启动模型或保存新运行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-lifecycle-close-')), entered = deferred(), release = deferred(); let modelRequests = 0;
  const service = new AgentService(directory, { snapshot: async (id: string) => { entered.resolve(); await release.promise; return snapshot(id); } } as AgentPort, {
    resolveModel: async () => { modelRequests++; return model(); }, fetch: blockedFetch,
  });
  let starting: Promise<PublicRun> | undefined;
  try {
    starting = service.start({ projectId: 'project-a', goal: '启动时退出' }); await entered.promise;
    let disposed = false; const disposal = service.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false);
    release.resolve(); await assert.rejects(starting, /智能体服务正在关闭/); await disposal;
    assert.equal(modelRequests, 0); assert.deepEqual(await service.list(), []);
    await assert.rejects(service.start({ projectId: 'project-b', goal: '关闭后启动' }), /智能体服务正在关闭/);
  } finally { release.resolve(); await starting?.catch(() => {}); await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});
