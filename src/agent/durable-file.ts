import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Directory fsync is unavailable on some supported filesystems/Windows; file sync is always required. */
export async function syncDirectory(directory: string): Promise<void> {
  try { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}
export async function writeDurableFile(file: string, data: string | Uint8Array): Promise<void> {
  const directory = dirname(file); await mkdir(directory, { recursive: true });
  const temporary = file + '.tmp-' + randomUUID();
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file); await syncDirectory(directory); await syncDirectory(dirname(directory));
  } finally { await rm(temporary, { force: true }); }
}

/** Replace an existing file. Windows can return EPERM while another reader still has it open.
 *  Same bound as writeRuntimeFile: win32 + EPERM + rename, 8 attempts inside 750ms, first error kept.
 *  Every other platform and error fails on the first attempt. */
export async function replaceFile(file: string, data: string | Uint8Array, platform: NodeJS.Platform = process.platform): Promise<void> {
  const started = performance.now(), deadline = started + 750;
  let firstError: unknown;
  for (let attempt = 1; ; attempt++) {
    const temporary = file + '.tmp-' + randomUUID();
    try {
      await writeFile(temporary, data);
      await rename(temporary, file);
      return;
    } catch (error) {
      const io = error && typeof error === 'object' ? error as NodeJS.ErrnoException : undefined;
      if (platform !== 'win32' || io?.code !== 'EPERM' || io.syscall !== 'rename') throw error;
      firstError ??= error;
      if (attempt >= 8 || performance.now() + 100 >= deadline) throw firstError;
      await new Promise(resolve => setTimeout(resolve, 100));
      if (performance.now() >= deadline) throw firstError;
    } finally { await rm(temporary, { force: true }); }
  }
}
