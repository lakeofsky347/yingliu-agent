import { mkdir, open, rename, rm } from 'node:fs/promises';
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
