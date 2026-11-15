import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApplication, MemorySecrets, rejectUnattendedProduction } from '../src/app/application.ts';
import { createProject } from '../src/core/index.ts';
import { emptyStory } from '../src/agent/story.ts';
import { DirectorDocumentPanel } from '../src/client/DirectorDocumentPanel.tsx';
import type { StudioController } from '../src/client/controller.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';

test('the director panel saves and approves only through the human buttons', async () => {
  const project = createProject('导演');
  const controller = { api: { async call() { return { document: null }; } }, action: async () => {}, getSnapshot: () => ({ error: '' }) } as unknown as StudioController;
  const html = renderToStaticMarkup(createElement(DirectorDocumentPanel, { controller, project }));
  assert.match(html, /保存导演文档/);
  assert.match(html, /批准导演文档/);
  assert.match(html, /智能体不能代签/);
  assert.equal(rejectUnattendedProduction('director.document.approve')?.error.code, 'DIRECTOR_APPROVAL_REQUIRED');

  const directory = await mkdtemp(join(tmpdir(), 'yingliu-director-panel-'));
  const app = await createApplication({ dataDirectory: directory, projectsDirectory: join(directory, 'projects'), credentials: new MemorySecrets(), resumeRemoteTasks: false });
  try {
    const created = await app.route('create', { title: '导演面板' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const id = (created.value as StudioSnapshot).project!.id;
    const story = { ...emptyStory(id), title: '海边', logline: '走路', status: 'empty' as const };
    const saved = await app.route('director.document.save', { projectId: id, expectedRevision: (created.value as StudioSnapshot).project!.revision, story });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const got = await app.route('director.document.get', { projectId: id });
    assert.equal(got.ok, true);
    if (!got.ok) return;
    const document = (got.value as { document: { hash: string; status: string } }).document;
    assert.equal(document.status, 'draft');
    assert.equal(typeof document.hash, 'string');
  } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});
