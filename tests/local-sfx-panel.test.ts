import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createProject } from '../src/core/index.ts';
import { AudioPanel } from '../src/client/AudioPanel.tsx';
import type { StudioController } from '../src/client/controller.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';

test('the audio panel can register a local synthesized effect without a model', () => {
  const project = createProject('音效');
  const snapshot = { project, root: '/tmp', task: null, previewUrl: null, previewRevision: null, providers: [], recent: [], environment: { browserPath: '', ffmpegPath: '', ffprobePath: '', browserAvailable: false, ffmpegAvailable: false, ffprobeAvailable: false }, tts: { endpoint: '', model: '', voice: '', speed: 1, enabled: false } } as StudioSnapshot;
  const controller = { action: async () => {} } as unknown as StudioController;
  const html = renderToStaticMarkup(createElement(AudioPanel, { project, snapshot, controller, assetUrl: () => '', busy: false }));
  assert.match(html, /合成本地音效/);
  assert.match(html, /aria-label="本地音效种类"/);
  assert.doesNotMatch(html, /调用模型/);
});
