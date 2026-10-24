/**
 * P0 Day-8 dry-run design (W5 preview): move Electron safeStorage ciphertext into an OS keyring as an independent
 * transaction. The legacy file is never modified; plaintext exists only in memory between decrypt() and keyring.set()
 * and never enters the journal, logs, argv or temp files. Exercised with SYNTHETIC credentials only (tests).
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface LegacyDecryptor { available(): boolean; decrypt(ciphertext: Buffer): string }
export interface Keyring { set(account: string, value: string): Promise<void>; get(account: string): Promise<string | undefined>; delete(account: string): Promise<void> }
export interface MigrationEnv { legacyDirectory: string; profileDirectory: string; decryptor: LegacyDecryptor; keyring: Keyring; ownerHeld: boolean; legacyRunning: () => boolean; service?: string }
export type RefOutcome = 'migrated' | 'undecryptable';
export interface MigrationResult { status: 'committed' | 'nothing-to-migrate' | 'aborted'; refs: Record<string, RefOutcome>; error?: { code: string; message: string }; backup?: string }

const LEGACY = 'credentials.encrypted.json';
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
async function atomicJson(file: string, value: unknown) { const tmp = file + '.' + randomUUID() + '.tmp'; await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(tmp, file); }

export function migrationPaths(profileDirectory: string) { const dir = join(profileDirectory, 'migration'); return { dir, journal: join(dir, 'credentials-journal.json'), state: join(dir, 'credentials-state.json') }; }

export async function migrateCredentials(env: MigrationEnv): Promise<MigrationResult> {
  if (!env.ownerHeld) throw failure('NOT_OWNER', '迁移前必须持有 profile owner 锁');
  if (env.legacyRunning()) throw failure('LEGACY_RUNNING', '旧版应用仍在运行，请先退出');
  const paths = migrationPaths(env.profileDirectory); await mkdir(paths.dir, { recursive: true });
  try { const state = JSON.parse(await readFile(paths.state, 'utf8')); if (state.schemaVersion === 1) return { status: 'committed', refs: state.refs, backup: state.backup }; } catch { /* not yet committed */ }
  let bytes: Buffer; try { bytes = await readFile(join(env.legacyDirectory, LEGACY)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'nothing-to-migrate', refs: {} }; throw e; }
  const attempt = randomUUID(), backup = join(paths.dir, 'backup-' + attempt + '.json');
  await copyFile(join(env.legacyDirectory, LEGACY), backup);
  if (sha256(await readFile(backup)) !== sha256(bytes)) throw failure('BACKUP_MISMATCH', '备份校验失败');
  const journal: { schemaVersion: 1; attempt: string; startedAt: string; legacySha256: string; backup: string; steps: { ref: string; step: string; code?: string }[]; status: string } =
    { schemaVersion: 1, attempt, startedAt: new Date().toISOString(), legacySha256: sha256(bytes), backup, steps: [], status: 'started' };
  await atomicJson(paths.journal, journal);
  const written: string[] = [], refs: Record<string, RefOutcome> = {};
  const account = (ref: string) => (env.service ?? 'yingliu-agent') + ':' + ref;
  try {
    let parsed: Record<string, string>;
    try { parsed = JSON.parse(bytes.toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); } catch { throw failure('LEGACY_CORRUPT', '旧凭据文件格式损坏；原件与备份均保留'); }
    if (!env.decryptor.available()) throw failure('LEGACY_UNAVAILABLE', '原系统安全存储不可用，无法解密；只迁移非密钥配置并提示重新配置');
    for (const [ref, encoded] of Object.entries(parsed)) {
      let plain: string;
      try { plain = env.decryptor.decrypt(Buffer.from(String(encoded), 'base64')); }
      catch { refs[ref] = 'undecryptable'; journal.steps.push({ ref, step: 'skip', code: 'DECRYPT_FAILED' }); await atomicJson(paths.journal, journal); continue; }
      try { await env.keyring.set(account(ref), plain); written.push(ref); }
      catch (e) { throw failure((e as { code?: string }).code ?? 'KEYRING_WRITE_FAILED', '写入系统钥匙环失败（' + ref + '）'); }
      const back = await env.keyring.get(account(ref)).catch(() => undefined);
      if (back !== plain) throw failure('KEYRING_READBACK_MISMATCH', '钥匙环读回核对失败（' + ref + '）');
      refs[ref] = 'migrated'; journal.steps.push({ ref, step: 'verified' }); await atomicJson(paths.journal, journal);
    }
    await atomicJson(paths.state, { schemaVersion: 1, attempt, committedAt: new Date().toISOString(), refs, backup, legacySha256: journal.legacySha256 });
    journal.status = 'committed'; await atomicJson(paths.journal, journal);
    return { status: 'committed', refs, backup };
  } catch (e) {
    for (const ref of written) await env.keyring.delete(account(ref)).catch(() => {});
    const code = (e as { code?: string }).code ?? 'MIGRATION_FAILED';
    journal.status = 'aborted'; journal.steps.push({ ref: '*', step: 'rolled-back', code }); await atomicJson(paths.journal, journal).catch(() => {});
    return { status: 'aborted', refs, error: { code, message: (e as Error).message } };
  }
}

/** Fallback entry: remove what the new store holds and the commit marker; the untouched legacy file keeps the old app working. */
export async function rollbackCredentialMigration(env: Pick<MigrationEnv, 'profileDirectory' | 'keyring' | 'service'>): Promise<void> {
  const paths = migrationPaths(env.profileDirectory);
  let state: { refs: Record<string, RefOutcome> }; try { state = JSON.parse(await readFile(paths.state, 'utf8')); } catch { return; }
  for (const [ref, outcome] of Object.entries(state.refs)) if (outcome === 'migrated') await env.keyring.delete((env.service ?? 'yingliu-agent') + ':' + ref);
  await rm(paths.state, { force: true });
}
