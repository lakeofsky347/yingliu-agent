import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, parseArgs, EXIT } from '../src/cli/main.ts';

async function cli(args: string[]) { let out = '', err = ''; const code = await runCli([...args, '--json'], { out: s => { out += s; }, err: s => { err += s; } }); return { code, json: out ? JSON.parse(out.trim()) : undefined, out, err }; }

test('CLI: argument parsing keeps boolean flags from swallowing positionals', () => {
  assert.deepEqual(parseArgs(['agent', 'status', 'r1', '--trace', '--timeout', '5', '--mock']), { positional: ['agent', 'status', 'r1'], flags: { trace: true, timeout: '5', mock: true } });
  assert.deepEqual(parseArgs(['--goal=a b', 'x']).flags, { goal: 'a b' });
});

test('CLI (mock): project → agent run pauses for export approval (exit 4) → approve needs execId → reject completes; docs, models and archive commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yingliu-cli-'));
  const saved = { data: process.env.YINGLIU_DATA_DIR, projects: process.env.YINGLIU_PROJECTS };
  process.env.YINGLIU_DATA_DIR = join(dir, 'data'); process.env.YINGLIU_PROJECTS = join(dir, 'projects');
  try {
    const doctor = await cli(['doctor']); assert.equal(doctor.json.ok, true); assert.ok(Array.isArray(doctor.json.data.checks)); assert.equal(doctor.code, doctor.json.data.ok ? EXIT.OK : EXIT.ENVIRONMENT);
    assert.equal((await cli(['nope'])).code, EXIT.USAGE);
    const created = await cli(['project', 'create', '--title', 'CLI 测试', '--mock']); assert.equal(created.code, 0, created.out);
    const projectId = created.json.data.id as string; assert.ok(created.json.data.root.startsWith(join(dir, 'projects')), 'honors YINGLIU_PROJECTS');
    assert.equal((await cli(['project', 'list'])).json.data.length, 1);
    assert.equal((await cli(['project', 'get', 'film-missing'])).code, EXIT.NOT_FOUND);

    // safety: paid/export auto-approval needs --allow-paid AND a positive --max-cost
    for (const extra of [[], ['--allow-paid'], ['--max-cost', '5'], ['--allow-paid', '--max-cost', '0']]) {
      const r = await cli(['agent', 'run', '--project', projectId, '--goal', 'g', '--mock', '--auto-approve', 'read,write,export', ...extra]); assert.equal(r.code, EXIT.USAGE, extra.join(' '));
    }
    const run = await cli(['agent', 'run', '--project', projectId, '--goal', '做个片头', '--mock', '--max-review-rounds', '0']);
    assert.equal(run.code, EXIT.NEEDS_APPROVAL, run.out); assert.equal(run.json.data.status, 'awaiting_approval');
    const pending = run.json.data.pending; assert.equal(pending.tool, 'export_mp4'); assert.ok(pending.execId);
    const runId = run.json.data.id as string;
    const status = await cli(['agent', 'status', runId, '--trace']); assert.equal(status.json.data.status, 'awaiting_approval'); assert.ok(status.json.data.trace.length > 0);
    assert.equal((await cli(['agent', 'approve', runId, '--call', pending.callId, '--mock'])).code, EXIT.USAGE, '--exec is required');
    const stale = await cli(['agent', 'approve', runId, '--call', pending.callId, '--exec', 'wrong', '--mock']); assert.equal(stale.code, EXIT.ERROR); assert.match(stale.json.error.message, /过期/);
    const rejected = await cli(['agent', 'reject', runId, '--call', pending.callId, '--exec', pending.execId, '--reason', '测试不导出', '--mock']);
    assert.equal(rejected.code, EXIT.OK, rejected.out); assert.equal(rejected.json.data.status, 'complete');

    const story = await cli(['story', 'show', projectId]); assert.equal(story.json.data.projectId, projectId);
    const ledger = await cli(['ledger', 'show', projectId]); assert.equal(ledger.json.data.spent, 0);
    assert.equal((await cli(['qc', 'show', projectId])).code, 0);
    const project = await cli(['project', 'get', projectId]); assert.equal(project.json.data.project.title, '模拟成片');

    process.env.CLI_TEST_KEY = 'sk-never-printed-123';
    const added = await cli(['models', 'add', '--name', 'x', '--base-url', 'http://example.invalid/v1', '--model', 'm', '--role', 'none', '--api-key-env', 'CLI_TEST_KEY']); assert.equal(added.code, 0, added.out);
    const listed = await cli(['models', 'list']); assert.ok(!listed.out.includes('sk-never-printed'), 'keys are never printed'); assert.ok(listed.json.data.connections.some((c: { apiKeyEnv: string; hasKey: boolean }) => c.apiKeyEnv === 'CLI_TEST_KEY' && c.hasKey));
    assert.equal((await cli(['models', 'add', '--name', 'y', '--base-url', 'http://example.invalid/v1', '--model', 'm', '--api-key-env', 'CLI_UNSET_VAR_X'])).code, EXIT.USAGE);

    const zip = join(dir, 'p.yingliu'); assert.equal((await cli(['project', 'export-zip', projectId, '--out', zip])).code, 0);
    const imported = await cli(['project', 'import', zip]); assert.equal(imported.code, 0, imported.out); assert.notEqual(imported.json.data.id, projectId);
  } finally {
    delete process.env.CLI_TEST_KEY;
    if (saved.data === undefined) delete process.env.YINGLIU_DATA_DIR; else process.env.YINGLIU_DATA_DIR = saved.data;
    if (saved.projects === undefined) delete process.env.YINGLIU_PROJECTS; else process.env.YINGLIU_PROJECTS = saved.projects;
    await rm(dir, { recursive: true, force: true });
  }
});
