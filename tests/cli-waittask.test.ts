import test from 'node:test';
import assert from 'node:assert/strict';
import { waitTask, CliError } from '../src/cli/main.ts';

test('C04b: export that returns no task ID fails RUN_FAILED instead of adopting the current (older) task', async () => {
  const routed: string[] = [];
  const ctx = {
    flags: {}, mock: true, secrets: {},
    lifecycle: { throwIfInterrupted() {} },
    app: { route: async (endpoint: string) => { routed.push(endpoint); return { ok: true, value: { project: { outputs: [] }, task: { id: 'older-export', kind: 'export', status: 'complete' } } }; } },
  } as any;
  await assert.rejects(waitTask(ctx, 'p', 'export', undefined), (error: unknown) => error instanceof CliError && error.code === 'RUN_FAILED');
  assert.deepEqual(routed, [], 'no fallback lookup of the current task');
});
