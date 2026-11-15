import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication, MemorySecrets, rejectUnattendedProduction } from '../src/app/application.ts';
import { emptyStory } from '../src/agent/story.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';
import { readDirectorDocument } from '../src/director/document.ts';

test('director document is approved only by a human, keeps its hash, and does not change production policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-director-'));
  const app = await createApplication({ dataDirectory: directory, projectsDirectory: join(directory, 'projects'), credentials: new MemorySecrets(), resumeRemoteTasks: false });
  const call = (endpoint: string, payload: unknown = {}) => app.route(endpoint, payload);
  try {
    const created = await call('create', { title: '导演文档' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const project = (created.value as StudioSnapshot).project!;
    const story = { ...emptyStory(project.id), title: '海边', logline: '一个人走路', status: 'approved' as const, version: 1 };
    (story as { apiKey?: string }).apiKey = 'should-not-persist';
    const saved = await call('director.document.save', { projectId: project.id, expectedRevision: project.revision, story });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const drafted = (saved.value as StudioSnapshot).project!;
    const doc = readDirectorDocument(drafted);
    assert.ok(doc);
    assert.equal(doc!.status, 'draft');
    assert.equal(JSON.stringify(doc).includes('should-not-persist'), false);
    assert.equal(drafted.productionPolicy?.mode, project.productionPolicy?.mode);
    const approved = await call('director.document.approve', { projectId: project.id, expectedRevision: drafted.revision, hash: doc!.hash });
    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    const after = (approved.value as StudioSnapshot).project!;
    const signed = readDirectorDocument(after);
    assert.equal(signed?.status, 'approved');
    assert.equal(signed?.hash, doc!.hash);
    assert.equal(after.productionPolicy?.decisionId, drafted.productionPolicy?.decisionId);
    const stale = await call('director.document.save', { projectId: project.id, expectedRevision: after.revision, baseHash: 'old-hash', story });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, 'DIRECTOR_BASE_CONFLICT');
    assert.equal(rejectUnattendedProduction('director.document.approve')?.error.code, 'DIRECTOR_APPROVAL_REQUIRED');
    const generated = await call('media.generate', { projectId: project.id, expectedRevision: after.revision, operation: 'text-to-video', prompt: '不应开始' });
    assert.equal(generated.ok, false);
    if (!generated.ok) assert.equal(generated.error.code, 'PRODUCTION_POLICY_VIOLATION');
  } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});
