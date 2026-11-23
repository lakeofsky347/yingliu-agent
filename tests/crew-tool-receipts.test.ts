import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject } from '../src/core/index.ts';
import { emptyStory } from '../src/agent/story.ts';
import { runCrewSubagent, type SubagentRunOptions } from '../src/agent/subagents.ts';
import type { AgentTool } from '../src/agent/contracts.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';
import { toolGateway, type GatewayReply } from './model-gateway.ts';

function tool(name: string, run: AgentTool['run']): AgentTool {
  return { name, description: name, risk: name === 'shot_patch' ? 'write' : 'read', parameters: {}, run };
}

async function delegate(turns: GatewayReply[], tools: AgentTool[], saveCheckpoint?: SubagentRunOptions['saveCheckpoint']) {
  const project = createProject('部门工具回执');
  const unused = async (): Promise<never> => { throw new Error('unexpected test fixture access'); };
  const gateway = toolGateway((_body, turn) => turns[turn] ?? { text: '部门工作结束' });
  const result = await runCrewSubagent({
    department: 'post_editor_qc', task: '执行检查',
    parentRun: { policy: { autoApprove: ['read', 'write'] } } as SubagentRunOptions['parentRun'],
    parentCtx: {
      runId: 'test-run', projectId: project.id, signal: new AbortController().signal,
      port: { snapshot: async () => ({ project } as StudioSnapshot), readSource: unused, saveSource: unused, commit: unused, route: unused, capture: unused },
      docs: { story: async () => emptyStory(project.id), updateStory: unused, ledger: unused, saveQc: unused },
    },
    allTools: tools, fetch: gateway.fetch,
    resolveSubModel: async () => ({ config: { baseUrl: 'http://gateway.test/v1', model: 'mock', supportsTools: true, timeoutMs: 1000, maxTokens: 2048 }, parameters: {} }),
    checkBudget: async () => null, onToolCall: async () => {}, onModelTurn: async () => {}, saveCheckpoint,
  });
  return { receipt: JSON.parse(result.content), requests: gateway.requests };
}

test('one checkpoint write error does not consume the next call or duplicate a tool response', async () => {
  const ran: string[] = [];
  let fault = true;
  const runTool = (name: string) => tool(name, async () => { ran.push(name); return { content: '{}' }; });
  const { receipt, requests } = await delegate([
    { toolCalls: [{ id: 'read', name: 'project_get', arguments: {} }, { id: 'edit', name: 'shot_patch', arguments: {} }] },
  ], [runTool('project_get'), runTool('shot_patch')], async state => {
    if (fault && state.pendingCalls[0]?.id === 'edit') {
      fault = false;
      throw new Error('temporary write error');
    }
  });
  assert.equal(fault, false);
  assert.equal(receipt.status, 'complete');
  assert.deepEqual(ran, ['project_get', 'shot_patch']);
  const replies = requests[1]!.messages.filter((m: { role: string }) => m.role === 'tool');
  assert.deepEqual(replies.map((m: { tool_call_id: string }) => m.tool_call_id), ['read', 'edit']);
});

test('a skipped edit is cleared only when the same change is retried, even at a new revision', async () => {
  const edit = (id: string, key: string, expectedRevision: number) => ({
    id, name: 'shot_patch', arguments: { patches: [{ shotId: 'shot-1', [key]: '改动' }], expectedRevision },
  });
  const reads = Array.from({ length: 6 }, (_, i) => ({ id: 'read-' + i, name: 'project_get', arguments: {} }));
  const first = { toolCalls: [...reads, edit('skipped', 'title', 0)] };
  const second = { toolCalls: [edit('different', 'narration', 0)] };
  const tools = ['project_get', 'shot_patch'].map(n => tool(n, async () => ({ content: '{}' })));
  const partial = await delegate([first, second], tools);
  assert.equal(partial.receipt.status, 'partial');
  assert.deepEqual(partial.receipt.skippedTools.map((s: { id: string }) => s.id), ['skipped']);
  const done = await delegate([first, second, { toolCalls: [edit('retried', 'title', 1)] }], tools);
  assert.equal(done.receipt.status, 'complete');
  assert.equal(done.receipt.skippedTools, undefined);
});

test('a failed render is reported to the director and a successful recheck clears it', async () => {
  const check = (id: string) => ({ toolCalls: [{ id, name: 'render_check', arguments: {} }] });
  const failure = { content: JSON.stringify({ status: 'failed', error: '镜头渲染异常' }) };
  const failed = await delegate([check('check-1')], [tool('render_check', async () => failure)]);
  assert.equal(failed.receipt.status, 'failed');
  assert.equal(failed.receipt.ok, false);
  assert.deepEqual(failed.receipt.failedTools, [{ id: 'check-1', tool: 'render_check', status: 'failed', error: '镜头渲染异常' }]);
  let checks = 0;
  const repair = { toolCalls: [{ id: 'repair', name: 'shot_patch', arguments: {} }] };
  const repaired = await delegate([check('check-1'), repair, check('check-2')], [
    tool('render_check', async () => ++checks === 1 ? failure : { content: '{"status":"complete"}' }),
    tool('shot_patch', async () => ({ content: '{}' })),
  ]);
  assert.equal(repaired.receipt.status, 'complete');
  assert.equal(repaired.receipt.failedTools, undefined);
});
