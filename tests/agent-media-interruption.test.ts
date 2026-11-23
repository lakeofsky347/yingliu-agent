import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService } from '../src/agent/service.ts';
import { RunStore } from '../src/agent/run-store.ts';
import { budgetFrom, emptyUsage } from '../src/agent/budget.ts';
import type { AgentPort, AgentRun } from '../src/agent/contracts.ts';
import { createProject } from '../src/core/index.ts';
import { MAX_TOOL_RESULT_CHARS } from '../src/agent/context.ts';
import { toolGateway } from './model-gateway.ts';

for (const [known, legacy, missingArgs] of [[0, false], [1, false], [1, true], [1, true, true], [8, true]] as const) {
  const completeReceipts = known === 8;
  test(completeReceipts ? 'a legacy waiting batch returns valid JSON with all eight long errors'
    : missingArgs ? 'a legacy interrupted batch with missing history reports only the verifiable item count'
    : legacy ? 'a legacy partial batch recovers its original item count from the assistant call'
    : `interrupted four-item batch with ${known} receipts accounts for each original item`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'yl-media-interruption-'));
    const project = createProject('批次恢复');
    const total = completeReceipts ? 8 : 4;
    const precharged = known + (legacy && !completeReceipts ? 1 : 0);
    const ids = Array.from({ length: known }, (_, i) => 'task-' + i);
    const call = { id: 'batch', execId: 'exec', name: 'batch_generate_media',
      arguments: JSON.stringify({ items: Array.from({ length: total }, (_, i) => ({
        kind: 'video', shotId: project.shotOrder[0], prompt: '镜头 ' + i,
      })) }) };
    const time = new Date().toISOString();
    const run: AgentRun = {
      id: 'batch-run', version: 1, projectId: project.id, goal: '生成镜头', status: 'running', message: '',
      createdAt: time, updatedAt: time, model: {}, budget: budgetFrom(), policy: { autoApprove: [] },
      usage: { ...emptyUsage('CNY'), unknownCostCalls: precharged, toolCalls: known > 0 ? 1 : 0 },
      steps: [], messages: missingArgs ? [] : [{ role: 'assistant', content: '', tool_calls: [
        { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } },
      ] }], approvedCallIds: [], reviewRounds: 0,
      queue: legacy ? [] : [call],
      ...(legacy ? { waitingBatch: { kind: 'media' as const, ids, callId: call.id, ...(completeReceipts ? {} : { uncertainCount: 1 }) } }
        : { inFlight: { execId: call.execId, tool: call.name, argsHash: 'hash', startedAt: time },
          batchReceipts: { batch: Object.fromEntries(ids.map((id, i) => [i, id])) } }),
    };
    await new RunStore(directory).save(run);
    const fetched: string[] = [];
    const port = {
      snapshot: async () => ({ project }),
      route: async (method: string, input: { taskId: string }) => {
        assert.equal(method, 'media.get');
        fetched.push(input.taskId);
        return { ok: true, value: { phase: 'failed', usage: { cost: 0 }, error: '下载失败'.repeat(500) } };
      },
    } as unknown as AgentPort;
    const gateway = toolGateway(() => ({ text: '已汇总' }));
    const service = new AgentService(directory, port, { fetch: gateway.fetch, maxReviewRounds: 0,
      resolveModel: async () => ({ parameters: { pricePerMInput: 0, pricePerMOutput: 0, priceCurrency: 'CNY' },
        config: { baseUrl: 'http://gateway.test/v1', model: 'mock', timeoutMs: 1000, maxTokens: 1000, supportsTools: true } }),
    });
    t.after(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
    await service.importDocs(project.id, { ledger: { version: 1, unknownCostCalls: precharged } });
    await service.resume(run.id);
    let done = await service.get(run.id);
    for (let i = 0; done.status !== 'complete' && done.status !== 'failed' && i < 250; i++) {
      await new Promise(r => setTimeout(r, 10));
      done = await service.get(run.id);
    }
    assert.equal(done.status, 'complete', done.error);
    assert.deepEqual(fetched, ids);
    const content = gateway.requests[0]!.messages.find((m: {role: string}) => m.role === 'tool').content;
    assert.ok(content.length <= MAX_TOOL_RESULT_CHARS);
    const result = JSON.parse(content);
    const expectedCount = missingArgs ? known + 1 : total;
    assert.equal(result.requestedCount, missingArgs ? undefined : total);
    if (missingArgs) assert.equal(result.accountedCount, expectedCount);
    assert.equal(result.failedCount, expectedCount);
    assert.deepEqual(result.results.map((r: {index: number}) => r.index), Array.from({ length: expectedCount }, (_, i) => i));
    assert.deepEqual(result.results.map((r: {state: string}) => r.state), [
      ...ids.map(() => 'failed'), ...(completeReceipts ? [] : ['submission_uncertain', ...Array(expectedCount - known - 1).fill('not_started')]),
    ]);
    assert.equal(done.usage.toolCalls, 1);
    assert.equal(done.usage.unknownCostCalls, completeReceipts ? 0 : 1);
    assert.equal((await service.ledger(project.id)).unknownCostCalls, done.usage.unknownCostCalls);
  });
}
