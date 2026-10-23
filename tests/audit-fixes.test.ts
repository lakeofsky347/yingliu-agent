/** Regression tests for the 2026-10 external audit (F01–F10 and supplementary items). Mocks only; no paid providers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDocs, emptyLedger, type Ledger } from '../src/agent/story.ts';

async function dir() { return mkdtemp(join(tmpdir(), 'yingliu-audit-')); }

test('supplementary: corrupt ledger is preserved and surfaced, never reset to zero spend', async () => {
  const d = await dir();
  try {
    const docs = new ProjectDocs<Ledger>(join(d, 'ledger'), emptyLedger);
    assert.equal((await docs.get('proj-1')).spent, 0, 'missing file still starts empty');
    await docs.update('proj-1', l => ({ ...l, spent: 12.5, maxCost: 20 }));
    await writeFile(join(d, 'ledger', 'proj-1.json'), '{"version":3,"spent":12.5,');
    await assert.rejects(docs.get('proj-1'), /已损坏/);
    await assert.rejects(docs.update('proj-1', l => ({ ...l, spent: l.spent + 1 })), /已损坏/);
    assert.equal(await readFile(join(d, 'ledger', 'proj-1.json'), 'utf8'), '{"version":3,"spent":12.5,', 'original bytes kept');
    await mkdir(join(d, 'ledger', 'proj-2.json'));
    await assert.rejects(docs.get('proj-2'), /无法读取/);
  } finally { await rm(d, { recursive: true, force: true }); }
});
