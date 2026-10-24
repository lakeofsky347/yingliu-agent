import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProject, defaultSceneSource } from '../src/core/index.ts';
import { AgentService } from '../src/agent/service.ts';
import type { AgentPort, PublicRun } from '../src/agent/contracts.ts';
import { RunStore } from '../src/agent/run-store.ts';
import { toolGateway } from './model-gateway.ts';

const model = async () => ({ parameters: {}, vision: false, config: { baseUrl: 'http://gateway.test/v1', model: 'mock', timeoutMs: 1000, maxTokens: 1000, supportsTools: true } });
async function settle(service: AgentService, id: string, states: PublicRun['status'][]) {
  for (let i = 0; i < 500; i++) { const run = await service.get(id); if (states.includes(run.status)) return run; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('run did not settle: ' + (await service.get(id)).status);
}

for (const fault of ['ledger', 'trace', 'run-save'] as const) for (const restart of [false, true]) {
  test(`R2-01: successful paid result survives ${fault} failure and ${restart ? 'restart' : 'same-instance resume'} without resubmission or double charge`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yingliu-success-' + fault + '-'));
    const project = { ...createProject('已成功的付费请求'), id: 'project-success' };
    let accepted = 0; let failedOnce = false; let service: AgentService;
    const gateway = toolGateway((_body, turn) => turn === 0 ? { toolCalls: [{ name: 'generate_music', arguments: { prompt: 'one music request' } }] } : { text: 'done' });
    const port: AgentPort = {
      snapshot: async () => ({ project, task: null }) as any, readSource: async () => defaultSceneSource(),
      saveSource: async () => ({ project }) as any, commit: async () => ({ project }) as any,
      route: async () => ({ ok: true, value: {} }), capture: async () => ({ bytes: new Uint8Array(), mime: 'image/png', frame: 0, shotId: '' }),
      capabilities: async () => ({ roles: ['music'] }),
      generateAudio: async () => {
        accepted++;
        const store = (service as unknown as { store: RunStore }).store;
        if (fault === 'ledger') await writeFile(join(directory, 'ledger'), 'ledger path unavailable');
        if (fault === 'trace') {
          const trace = store.trace.bind(store);
          store.trace = async (id, event) => { if (!failedOnce && event.event === 'step.finish' && (event.step as { kind?: string })?.kind === 'tool') { failedOnce = true; throw new Error('injected trace ENOSPC'); } return trace(id, event); };
        }
        if (fault === 'run-save') {
          const save = store.save.bind(store);
          store.save = async run => { if (!failedOnce && !run.queue.length && run.settledToolExecIds?.length) { failedOnce = true; throw new Error('injected snapshot ENOSPC'); } return save(run); };
        }
        return { id: 'audio-once', name: 'music', cost: 1.25 };
      },
    };
    service = new AgentService(directory, port, { resolveModel: model, fetch: gateway.fetch });
    try {
      const started = await service.start({ projectId: project.id, goal: 'music', autoApprove: ['read', 'write', 'cost'] });
      const failed = await settle(service, started.id, ['failed', 'complete']);
      assert.equal(failed.status, 'failed'); assert.equal(accepted, 1);
      const receipts = await readdir(join(directory, started.id + '.results')); assert.equal(receipts.length, 1, 'success is independently durable');
      const receipt = JSON.parse(await readFile(join(directory, started.id + '.results', receipts[0]), 'utf8'));
      assert.equal(receipt.result.cost, 1.25);
      if (fault === 'ledger') await rm(join(directory, 'ledger'));
      if (restart) { await service.dispose(); service = new AgentService(directory, port, { resolveModel: model, fetch: gateway.fetch }); }
      await service.resume(started.id);
      const done = await settle(service, started.id, ['complete', 'failed', 'awaiting_approval']);
      assert.equal(done.status, 'complete', done.error);
      assert.equal(accepted, 1, 'only bookkeeping may be retried');
      assert.equal(done.usage.toolCalls, 1); assert.equal(done.usage.cost, 1.25);
      const ledger = await service.ledger(project.id);
      assert.equal(ledger.spent, 1.25); assert.equal(ledger.byTool.generate_music.calls, 1); assert.equal(ledger.byTool.generate_music.cost, 1.25);
      assert.equal(Object.keys(ledger.settledExecutions ?? {}).length, 1);
      assert.equal(done.queue.length, 0); assert.equal(done.inFlight, undefined);
      assert.equal((await readdir(join(directory, started.id + '.results'))).length, 0);
    } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
}

test('R2-01: cancel keeps a known successful receipt until failed local settlement can be repaired', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-success-cancel-')); let accepted = 0;
  const project = { ...createProject('cancel settlement'), id: 'project-cancel' };
  const gateway = toolGateway((_body, turn) => turn === 0 ? { toolCalls: [{ name: 'generate_music', arguments: { prompt: 'music' } }] } : { text: 'done' });
  const port = { snapshot: async () => ({ project }), capabilities: async () => ({ roles: ['music'] }), generateAudio: async () => { accepted++; await writeFile(join(directory, 'ledger'), 'ledger unavailable'); return { id: 'one-asset', name: 'music', cost: 2 }; } } as unknown as AgentPort;
  const service = new AgentService(directory, port, { resolveModel: model, fetch: gateway.fetch });
  try {
    const started = await service.start({ projectId: project.id, goal: 'music', autoApprove: ['read', 'cost'] });
    assert.equal((await settle(service, started.id, ['failed', 'complete'])).status, 'failed');
    const refused = await service.cancel(started.id); assert.equal(refused.status, 'failed'); assert.equal(refused.queue.length, 1);
    assert.equal((await readdir(join(directory, started.id + '.results'))).length, 1);
    await rm(join(directory, 'ledger'));
    const cancelled = await service.cancel(started.id); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.queue.length, 0);
    assert.equal(accepted, 1); assert.equal((await service.ledger(project.id)).spent, 2); assert.equal(gateway.requests.length, 1);
    assert.equal((await readdir(join(directory, started.id + '.results'))).length, 0);
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('R2-01: success journal restores task ownership before a changed budget can block bookkeeping', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-success-task-'));
  const project = { ...createProject('export task'), id: 'project-task' };
  const gateway = toolGateway((_body, turn) => turn === 0 ? { toolCalls: [{ name: 'export_once', arguments: {} }] } : { text: 'done' });
  let accepted = 0;
  const port = { snapshot: async () => ({ project, task: null }) } as unknown as AgentPort;
  let service = new AgentService(directory, port, { resolveModel: model, fetch: gateway.fetch, tools: [{ name: 'export_once', description: 'test export', parameters: {}, risk: 'export', async run() { accepted++; return { content: 'started', projectTask: { id: 'export-task', kind: 'export' } }; } }] });
  const store = (service as unknown as { store: RunStore }).store; const trace = store.trace.bind(store); let fail = true;
  store.trace = async (id, event) => { if (fail && event.event === 'step.finish' && (event.step as { kind?: string })?.kind === 'tool') { fail = false; throw new Error('trace unavailable'); } return trace(id, event); };
  try {
    const started = await service.start({ projectId: project.id, goal: 'export', autoApprove: ['read', 'export'], budget: { maxToolCalls: 1 } });
    assert.equal((await settle(service, started.id, ['failed', 'complete', 'budget_exceeded'])).status, 'failed');
    await service.dispose();
    service = new AgentService(directory, port, { resolveModel: model, fetch: gateway.fetch });
    await service.resume(started.id); const done = await settle(service, started.id, ['budget_exceeded', 'failed']);
    assert.equal(accepted, 1); assert.equal(done.status, 'budget_exceeded');
    assert.equal(done.queue.length, 0); assert.equal(done.taskRefs?.length, 1); assert.equal(done.taskRefs?.[0].id, 'export-task');
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});
