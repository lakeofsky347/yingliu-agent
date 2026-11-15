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
import { ProductionPolicyPanel } from '../src/client/ProductionPolicyPanel.tsx';
import { QualityPanel } from '../src/client/QualityPanel.tsx';
import { AudioPanel } from '../src/client/AudioPanel.tsx';
import { MediaPanel } from '../src/client/MediaPanel.tsx';
import type { StudioController } from '../src/client/controller.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';

test('new panels expose director approval, production policy, quality, local sfx and audio preflight', () => {
  const project = createProject('入口');
  const controller = { api: { async call() { return { document: null }; } }, action: async () => {}, subscribe: () => () => {}, getSnapshot: () => ({ snapshot: { project, environment: { browserPath: '', ffmpegPath: '', ffprobePath: '', browserAvailable: false, ffmpegAvailable: false, ffprobeAvailable: false }, task: null }, error: '', pending: false }) } as unknown as StudioController;
  const director = renderToStaticMarkup(createElement(DirectorDocumentPanel, { controller, project }));
  assert.match(director, /保存导演文档/); assert.match(director, /批准导演文档/); assert.match(director, /智能体不能代签/);
  const policy = renderToStaticMarkup(createElement(ProductionPolicyPanel, { controller, project }));
  assert.match(policy, /确认制作策略/); assert.match(policy, /只能由你确认/);
  const quality = renderToStaticMarkup(createElement(QualityPanel, { controller }));
  assert.match(quality, /运行质检/); assert.match(quality, /强制导出也不能绕过/);
  const snapshot = { project, root: '/tmp', task: null, previewUrl: null, previewRevision: null, providers: [], recent: [], environment: { browserPath: '', ffmpegPath: '', ffprobePath: '', browserAvailable: false, ffmpegAvailable: false, ffprobeAvailable: false }, tts: { endpoint: '', model: '', voice: '', speed: 1, enabled: false } } as StudioSnapshot;
  const audio = renderToStaticMarkup(createElement(AudioPanel, { project, snapshot, controller, assetUrl: () => '', busy: false }));
  assert.match(audio, /合成本地音效/);
  const media = renderToStaticMarkup(createElement(MediaPanel, { controller, project }));
  assert.match(media, /需要模型自带音轨/); assert.match(media, /seedance/);
});

test('quality check, production confirmation and director approval stay on the human routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-entries-'));
  const app = await createApplication({ dataDirectory: directory, projectsDirectory: join(directory, 'projects'), credentials: new MemorySecrets(), resumeRemoteTasks: false });
  try {
    const created = await app.route('create', { blank: true, title: '入口验收' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const snap = created.value as StudioSnapshot;
    const id = snap.project!.id;
    const blocked = await app.route('quality.check', { projectId: id });
    assert.equal(blocked.ok, true);
    if (!blocked.ok) return;
    const report = blocked.value as { decision: string; checks: { message: string }[] };
    assert.equal(report.decision, 'fail');
    assert.match(report.checks.map(check => check.message).join('\n'), /没有镜头/);
    const confirmed = await app.route('production.set', { projectId: id, expectedRevision: snap.project!.revision, mode: 'code_animation' });
    assert.equal(confirmed.ok, true);
    if (!confirmed.ok) return;
    const story = { ...emptyStory(id), title: '海边', logline: '走路', status: 'empty' as const };
    const saved = await app.route('director.document.save', { projectId: id, expectedRevision: (confirmed.value as StudioSnapshot).project!.revision, story });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const got = await app.route('director.document.get', { projectId: id });
    assert.equal(got.ok, true);
    if (!got.ok) return;
    const hash = (got.value as { document: { hash: string; status: string } }).document.hash;
    assert.equal((got.value as { document: { status: string } }).document.status, 'draft');
    const approved = await app.route('director.document.approve', { projectId: id, expectedRevision: (saved.value as StudioSnapshot).project!.revision, hash });
    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.equal((approved.value as StudioSnapshot).project!.productionPolicy?.mode, 'code_animation');
    assert.equal(rejectUnattendedProduction('production.set')?.error.code, 'PRODUCTION_CONFIRMATION_REQUIRED');
    assert.equal(rejectUnattendedProduction('director.document.approve')?.error.code, 'DIRECTOR_APPROVAL_REQUIRED');
  } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});
