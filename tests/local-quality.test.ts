import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import { synthesize } from '../src/agent/synth.ts';
import { localQualityFrames } from '../src/workflows/local-quality.ts';
import { createProject } from '../src/core/index.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';

test('local sfx bytes are deterministic and export hard-failures do not create a film', async () => {
  const first = synthesize({ kind: 'chime', durationSeconds: 0.2, frequency: 440, seed: 7 });
  const second = synthesize({ kind: 'chime', durationSeconds: 0.2, frequency: 440, seed: 7 });
  assert.deepEqual(first, second);
  const project = createProject('抽样');
  project.shotOrder = Array.from({ length: 8 }, (_, index) => 's' + index);
  project.shots = project.shotOrder.map(id => ({ ...project.shots[0]!, id, durationFrames: 30 }));
  assert.ok(localQualityFrames(project).length <= 12);
  assert.ok(localQualityFrames(project, 12).length === 12);

  const directory = await mkdtemp(join(tmpdir(), 'yingliu-quality-'));
  const app = await createApplication({ dataDirectory: directory, projectsDirectory: join(directory, 'projects'), credentials: new MemorySecrets(), resumeRemoteTasks: false });
  try {
    const created = await app.route('create', { title: '质检' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const snap = created.value as StudioSnapshot;
    const id = snap.project!.id;
    await app.route('production.set', { projectId: id, expectedRevision: snap.project!.revision, mode: 'code_animation' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const imported = await app.route('import', { projectId: id, expectedRevision: snap.project!.revision + 1, name: 'dot.png', mime: 'image/png', dataBase64: png.toString('base64') });
    assert.equal(imported.ok, true);
    if (!imported.ok) return;
    const root = (imported.value as StudioSnapshot).root!;
    const asset = (imported.value as StudioSnapshot).project!.assets.at(-1)!;
    await rm(join(root, asset.path!));
    const blocked = await app.route('export', { projectId: id, expectedRevision: (imported.value as StudioSnapshot).project!.revision, force: true });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, 'LOCAL_QUALITY_FAILED');
    const current = await app.route('current', { projectId: id });
    if (current.ok) assert.equal((current.value as StudioSnapshot).project!.outputs.length, 0);
  } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});
