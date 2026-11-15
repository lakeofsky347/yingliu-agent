import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createProject } from '../src/core/index.ts';
import { ProductionPolicyPanel } from '../src/client/ProductionPolicyPanel.tsx';
import { rejectUnattendedProduction } from '../src/app/application.ts';
import type { StudioController } from '../src/client/controller.ts';

test('the production policy panel is a human confirmation and the agent route still refuses it', () => {
  const project = createProject('策略');
  const controller = { action: async () => {}, getSnapshot: () => ({ error: '' }) } as unknown as StudioController;
  const html = renderToStaticMarkup(createElement(ProductionPolicyPanel, { controller, project }));
  assert.match(html, /确认制作策略/);
  assert.match(html, /aria-label="制作策略模式"/);
  assert.match(html, /只能由你确认/);
  assert.equal(rejectUnattendedProduction('production.set')?.error.code, 'PRODUCTION_CONFIRMATION_REQUIRED');
});
