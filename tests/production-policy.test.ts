import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication, MemorySecrets, rejectUnattendedProduction } from '../src/app/application.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';

test('schema 2 opens as schema 3 unresolved, and generation or export waits for a human decision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-policy-'));
  const app = await createApplication({ dataDirectory: directory, projectsDirectory: join(directory, 'projects'), credentials: new MemorySecrets(), resumeRemoteTasks: false });
  const call = (endpoint: string, payload: unknown = {}) => app.route(endpoint, payload);
  try {
    const created = await call('create', { blank: true, title: '待确认' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const project = (created.value as StudioSnapshot).project!;
    const shotIds = project.shots.map(shot => shot.id);
    assert.equal(project.schemaVersion, 3);
    assert.equal(project.productionPolicy?.mode, 'unresolved');
    const edited = structuredClone(project);
    edited.title = '改过标题';
    const written = await call('save', { projectId: project.id, expectedRevision: project.revision, project: edited });
    assert.equal(written.ok, true);
    if (!written.ok) return;
    const saved = (written.value as StudioSnapshot).project!;
    assert.equal(saved.schemaVersion, 3);
    assert.equal(saved.productionPolicy?.mode, 'unresolved');
    assert.deepEqual(saved.shots.map(shot => shot.id), shotIds);
    const forged = structuredClone(saved);
    forged.productionPolicy = { ...saved.productionPolicy!, mode: 'model_video' };
    const blockedSave = await call('save', { projectId: project.id, expectedRevision: saved.revision, project: forged });
    assert.equal(blockedSave.ok, false);
    const media = await call('media.generate', { projectId: project.id, expectedRevision: saved.revision, operation: 'text-to-video', prompt: '一只猫' });
    assert.equal(media.ok, false);
    if (!media.ok) assert.equal(media.error.code, 'PRODUCTION_POLICY_VIOLATION');
    const exported = await call('export', { projectId: project.id, expectedRevision: saved.revision });
    assert.equal(exported.ok, false);
    if (!exported.ok) assert.equal(exported.error.code, 'PRODUCTION_POLICY_VIOLATION');
    const stale = await call('production.set', { projectId: project.id, expectedRevision: saved.revision - 1, mode: 'model_video' });
    assert.equal(stale.ok, false);
    assert.equal(rejectUnattendedProduction('production.set')?.error.code, 'PRODUCTION_CONFIRMATION_REQUIRED');
    assert.equal(rejectUnattendedProduction('export'), undefined);
    const confirmed = await call('production.set', { projectId: project.id, expectedRevision: saved.revision, mode: 'model_video', allowGeneratedImages: true });
    assert.equal(confirmed.ok, true);
    if (confirmed.ok) assert.equal((confirmed.value as StudioSnapshot).project?.productionPolicy?.mode, 'model_video');
  } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});
