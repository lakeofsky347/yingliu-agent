import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { EXIT, isReadOnly, parseArgs, runCli } from '../src/cli/main.ts';

function capture() {
  let out = '', err = '';
  return { io: { out: (s: string) => { out += s; }, err: (s: string) => { err += s; } }, out: () => out, err: () => err };
}

test('CLI styles list is read-only and project create --style attaches copied VideoStyle or fails NOT_FOUND', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yingliu-cli-styles-'));
  const previousData = process.env.YINGLIU_DATA_DIR;
  process.env.YINGLIU_DATA_DIR = dir;
  try {
    assert.equal(isReadOnly(['styles', 'list'], parseArgs(['styles', 'list']).flags), true);
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(join(projectsDir, 'styles.json'), JSON.stringify([{
      id: 'paper-cut', name: '暖纸剪贴', description: '手工纸艺', prompt: '米白纸纹、暖金光影。',
      sourceFormat: 'markdown', sourceName: 'STYLE.md', createdAt: now, updatedAt: now,
    }]), 'utf8');

    const listed = capture();
    assert.equal(await runCli(['styles', 'list', '--json'], listed.io), EXIT.OK);
    const listJson = JSON.parse(listed.out().trim());
    assert.equal(listJson.ok, true);
    assert.equal(listJson.data.length, 1);
    assert.equal(listJson.data[0].id, 'paper-cut');

    const created = capture();
    assert.equal(await runCli(['project', 'create', '--title', '风格工程', '--style', 'paper-cut', '--json'], created.io), EXIT.OK);
    const createdJson = JSON.parse(created.out().trim());
    assert.equal(createdJson.ok, true);
    assert.deepEqual(createdJson.data.videoStyle, { id: 'paper-cut', name: '暖纸剪贴' });

    const fetched = capture();
    assert.equal(await runCli(['project', 'get', createdJson.data.id, '--json'], fetched.io), EXIT.OK);
    const fetchedJson = JSON.parse(fetched.out().trim());
    assert.equal(fetchedJson.data.project.videoStyle.id, 'paper-cut');
    assert.equal(fetchedJson.data.project.videoStyle.prompt, '米白纸纹、暖金光影。');

    const missing = capture();
    assert.equal(await runCli(['project', 'create', '--title', '不存在', '--style', 'no-such-style', '--json'], missing.io), EXIT.NOT_FOUND);
    const missingJson = JSON.parse(missing.out().trim());
    assert.equal(missingJson.ok, false);
    assert.equal(missingJson.error.code, 'NOT_FOUND');
  } finally {
    if (previousData === undefined) delete process.env.YINGLIU_DATA_DIR;
    else process.env.YINGLIU_DATA_DIR = previousData;
    await rm(dir, { recursive: true, force: true });
  }
});
