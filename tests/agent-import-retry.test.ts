import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { AgentPort } from '../src/agent/contracts.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';
import { createApplication, MemorySecrets } from '../src/app/application.ts';

const hasFfprobe = (() => { try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

for (const kind of ['image', 'audio'] as const) {
  test(`agent ${kind} import retries once the project moved on between reading the revision and importing`, { skip: kind === 'audio' && !hasFfprobe && 'ffprobe 不可用（音频导入需要探测时长）' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-import-retry-'));
    const app = await createApplication({ dataDirectory: directory, credentials: new MemorySecrets() });
    try {
      const created = (await app.route('create', { blank: true, title: '并发导入' })) as { ok: true; value: StudioSnapshot };
      assert.equal(created.ok, true); const id = created.value.project!.id;
      const backend = app.backend as unknown as { call: (endpoint: string, payload?: unknown) => Promise<StudioSnapshot> };
      const original = backend.call.bind(backend); let raced = false, imports = 0;
      backend.call = async (endpoint, payload) => {
        if (endpoint === 'import') {
          imports++;
          if (!raced) { // A user edit lands after the agent read `current` but before its import.
            raced = true; const latest = await original('current', { projectId: id });
            await original('rename', { projectId: id, expectedRevision: latest.project!.revision, title: '用户改名' });
          }
        }
        return original(endpoint, payload);
      };
      const port = (app.agent as unknown as { port: AgentPort }).port;
      const asset = kind === 'image' ? await port.importImage!(id, 'tail.png', PNG, 'image/png') : await port.importAudio!(id, 'voice.wav', wav(), 'audio/wav');
      backend.call = original;
      const after = await original('current', { projectId: id });
      assert.equal(after.project!.title, '用户改名', 'the concurrent user edit is kept');
      assert.equal(after.project!.assets.filter(item => item.id === asset.id).length, 1);
      assert.equal(after.project!.assets.length, 1, 'imported exactly once');
      assert.equal(imports, 2);
    } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
}

function wav() {
  const samples = 800, data = Buffer.alloc(samples * 2), header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
