import test from 'node:test';
import assert from 'node:assert/strict';
import { EXIT } from '../src/cli/main.ts';
import { cli, withCliEnv } from './cli-helpers.ts';

test('C03: --no-wait is rejected with a clear error (no persistent owner) and starts nothing', () => withCliEnv(async () => {
  const p = await cli(['project', 'create', '--title', 'nw', '--mock']); const projectId = p.json.data.id;
  for (const args of [['agent', 'run', '--project', projectId, '--goal', 'g'], ['agent', 'resume', 'any-run'], ['agent', 'approve', 'any', '--call', 'c', '--exec', 'e']]) {
    const r = await cli([...args, '--mock', '--no-wait']);
    assert.equal(r.code, EXIT.USAGE, args.join(' ') + ' ' + r.out); assert.equal(r.json.error.code, 'USAGE'); assert.match(r.json.error.message, /--no-wait/);
  }
  const ledger = await cli(['agent', 'status', 'any-run']); assert.equal(ledger.code, EXIT.NOT_FOUND);
}));
