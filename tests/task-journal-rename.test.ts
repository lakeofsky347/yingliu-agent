import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { replaceFile } from '../src/agent/durable-file.ts';

const denied = () => Object.assign(new Error('synthetic Windows rename denial'), { code: 'EPERM', syscall: 'rename' });

test('a Windows task-journal rename retries a temporary EPERM and then replaces the file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-journal-rename-'));
  const file = join(directory, 'task.json');
  const rename = fs.rename.bind(fs);
  let attempts = 0;
  try {
    await writeFile(file, 'running');
    t.mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
      if (to === file) { attempts++; if (attempts === 1) throw denied(); }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    t.mock.method(performance, 'now', () => 0);
    await replaceFile(file, 'complete\n', 'win32');
    assert.equal(attempts, 2);
    assert.equal(await readFile(file, 'utf8'), 'complete\n');
    assert.deepEqual(await fs.readdir(directory), ['task.json']);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(directory, { recursive: true, force: true }); }
});

test('a permanent Windows EPERM rename stops at the attempt cap and keeps the first error', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-journal-rename-cap-'));
  const file = join(directory, 'task.json');
  const rename = fs.rename.bind(fs);
  const first = denied();
  let attempts = 0;
  try {
    await writeFile(file, 'running');
    t.mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
      if (to === file) { attempts++; throw attempts === 1 ? first : denied(); }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    t.mock.method(performance, 'now', () => 0);
    await assert.rejects(replaceFile(file, 'complete\n', 'win32'), error => error === first);
    assert.equal(attempts, 8);
    assert.equal(await readFile(file, 'utf8'), 'running');
    assert.deepEqual(await fs.readdir(directory), ['task.json']);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(directory, { recursive: true, force: true }); }
});

test('non-Windows EPERM and other rename errors fail on the first attempt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-journal-rename-filter-'));
  const file = join(directory, 'task.json');
  const rename = fs.rename.bind(fs);
  let attempts = 0;
  let current: Error = denied();
  try {
    await writeFile(file, 'running');
    t.mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
      if (to === file) { attempts++; throw current; }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    for (const [platform, code, syscall] of [['linux', 'EPERM', 'rename'], ['darwin', 'EPERM', 'rename'], ['win32', 'EBUSY', 'rename'], ['win32', 'EPERM', 'open']] as const) {
      current = Object.assign(new Error('not a Windows replace denial'), { code, syscall });
      attempts = 0;
      await assert.rejects(replaceFile(file, 'complete\n', platform), error => error === current);
      assert.equal(attempts, 1);
      assert.equal(await readFile(file, 'utf8'), 'running');
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(directory, { recursive: true, force: true }); }
});
