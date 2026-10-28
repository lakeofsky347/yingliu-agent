import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedSceneProcesses, sameSceneProcess, type SceneFrame, type SceneProcess } from '../src/desktop/scene-recovery.ts';

const url = 'http://localhost:43210/index.html?revision=2';
const scene = (pid = 200, value = url): SceneFrame => ({ pid, url: value });
const metric = (pid = 200, type = 'Tab', creationTime = 1234): SceneProcess => ({ pid, type, creationTime });

test('selects and deduplicates an owned preview and its thumbnails, without selecting unrelated app metrics', () => {
  assert.deepEqual(ownedSceneProcesses(100, [scene(), scene(), scene(300)], [metric(400), metric(300), metric()], [100]), [
    { pid: 200, creationTime: 1234, origin: 'http://localhost:43210' },
    { pid: 300, creationTime: 1234, origin: 'http://localhost:43210' },
  ]);
});

test('never selects the editor or another protected top-level renderer', () => {
  assert.deepEqual(ownedSceneProcesses(100, [scene(100), scene(200), scene(300)], [metric(100), metric(200), metric(300)], [200]), [
    { pid: 300, creationTime: 1234, origin: 'http://localhost:43210' },
  ]);
  for (const editorPid of [0, -1, NaN, Infinity, 1.5]) assert.deepEqual(ownedSceneProcesses(editorPid, [scene()], [metric()], []), []);
});

test('requires the exact preview scheme, localhost host, index path, explicit port and no URL credentials', () => {
  for (const value of [
    'http://127.0.0.1:43210/index.html', 'https://localhost:43210/index.html', 'http://localhost.evil:43210/index.html',
    'http://localhost.:43210/index.html', 'http://localhost:43210/other.html', 'http://localhost:43210/index.html/child',
    'http://localhost:43210/index%2ehtml', 'http://user:pass@localhost:43210/index.html', 'http://localhost/index.html',
    'http://localhost:0/index.html', 'about:blank', 'file:///index.html', 'not a URL', '',
  ]) assert.deepEqual(ownedSceneProcesses(100, [scene(200, value)], [metric()], []), [], value);
});

test('excludes the entire PID if any descendant in that PID is not a scene or has a different scene origin', () => {
  for (const other of ['about:blank', 'http://localhost:43210/editor.html', 'http://localhost:43211/index.html']) {
    assert.deepEqual(ownedSceneProcesses(100, [scene(), scene(200, other)], [metric()], []), [], other);
  }
});

test('requires a current unique Tab process record with a positive finite creation time', () => {
  for (const values of [
    [], [metric(300)], [metric(200, 'Browser')], [metric(200, 'GPU')], [metric(200, 'Utility')],
    [metric(200, 'Tab', 0)], [metric(200, 'Tab', -1)], [metric(200, 'Tab', NaN)], [metric(200, 'Tab', Infinity)],
    [metric(), metric()], [metric(), metric(200, 'Tab', 5678)], [metric(), metric(200, 'Browser')],
  ]) assert.deepEqual(ownedSceneProcesses(100, [scene()], values, []), []);
  for (const pid of [0, -1, NaN, Infinity, 2.5]) assert.deepEqual(ownedSceneProcesses(100, [scene(pid)], [metric(pid)], []), []);
});

test('recovery revalidation rejects PID reuse, changed origin and a no-longer-owned process', () => {
  const before = ownedSceneProcesses(100, [scene()], [metric()], [100])[0];
  const unchanged = ownedSceneProcesses(100, [scene()], [metric()], [100])[0];
  assert.equal(sameSceneProcess(before, unchanged), true);
  const reused = ownedSceneProcesses(100, [scene()], [metric(200, 'Tab', 5678)], [100])[0];
  assert.equal(sameSceneProcess(before, reused), false);
  assert.equal(sameSceneProcess(before, { ...before, pid: 201 }), false);
  assert.equal(sameSceneProcess(before, { ...before, origin: 'http://localhost:43211' }), false);
  assert.equal(sameSceneProcess(before, { ...before, creationTime: 0 }), false);
  assert.equal(sameSceneProcess(before, { ...before, origin: 'http://foreign:43210' }), false);
  assert.deepEqual(ownedSceneProcesses(100, [scene()], [metric()], [200]), []);
  assert.deepEqual(ownedSceneProcesses(100, [], [metric()], []), []);
});
