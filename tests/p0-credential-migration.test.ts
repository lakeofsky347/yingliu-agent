// P0 Day-8 drill with SYNTHETIC credentials only: no real keyring, no real safeStorage, no real keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {createHash} from 'node:crypto';
import { migrateCredentials, rollbackCredentialMigration, migrationPaths, type Keyring } from '../src/migration/credential-migration.ts';

const SYNTH = { 'provider:a': 'synthetic-secret-AAAA-1111', 'provider:b': 'synthetic-secret-BBBB-2222', 'provider:c': 'synthetic-secret-CCCC-3333' };
const enc = (s: string) => Buffer.from([...Buffer.from(s)].map(b => b ^ 0x5a)).toString('base64');
const decryptor = (opts: { available?: boolean; bad?: string[] } = {}) => ({ available: () => opts.available !== false, decrypt: (b: Buffer) => { const s = Buffer.from([...b].map(x => x ^ 0x5a)).toString(); if (opts.bad?.some(v => s === v)) throw new Error('bad'); return s; } });
function keyring(fail: { lockedAfter?: number; denied?: boolean; mismatch?: string } = {}): Keyring & { store: Map<string, string> } {
  const store = new Map<string, string>(); let n = 0;
  return { store, async set(a, v) { if (fail.denied) throw Object.assign(new Error('denied'), { code: 'KEYRING_ACCESS_DENIED' }); if (fail.lockedAfter !== undefined && n++ >= fail.lockedAfter) throw Object.assign(new Error('locked'), { code: 'KEYRING_LOCKED' }); store.set(a, v); },
    async get(a) { return fail.mismatch && store.has(a) && a.endsWith(createHash('sha256').update(fail.mismatch).digest('hex').slice(0,32)) ? 'tampered' : store.get(a); }, async delete(a) { store.delete(a); } };
}
async function setup(contents?: string) {
  const root = await mkdtemp(join(tmpdir(), 'p0-cred-')), legacy = join(root, 'legacy'), profile = join(root, 'profile');
  await rm(legacy, { recursive: true, force: true }); await (await import('node:fs/promises')).mkdir(legacy, { recursive: true });
  const text = contents ?? JSON.stringify(Object.fromEntries(Object.entries(SYNTH).map(([k, v]) => [k, enc(v)])));
  await writeFile(join(legacy, 'credentials.encrypted.json'), text);
  return { root, legacy, profile, text };
}
async function noPlaintextOnDisk(dir: string) { for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) { const t = await readFile(join(e.parentPath, e.name), 'utf8'); for (const v of Object.values(SYNTH)) assert.ok(!t.includes(v), 'plaintext found in ' + e.name); } }
const base = (s: Awaited<ReturnType<typeof setup>>, k: Keyring, d = decryptor()) => ({ legacyDirectory: s.legacy, profileDirectory: s.profile, decryptor: d, keyring: k, ownerHeld: true, legacyRunning: () => false });

test('migration: success commits atomically, verifies read-back, keeps legacy bytes and backup, no plaintext on disk', async () => {
  const s = await setup(), k = keyring();
  const r = await migrateCredentials(base(s, k));
  assert.equal(r.status, 'committed'); assert.deepEqual(Object.values(r.refs), ['migrated', 'migrated', 'migrated']);
  const state=JSON.parse(await readFile(migrationPaths(s.profile).state,'utf8'));
  assert.equal(k.store.get(state.accounts['provider:b']), SYNTH['provider:b']);
  assert.equal(await readFile(join(s.legacy, 'credentials.encrypted.json'), 'utf8'), s.text); assert.equal(await readFile(r.backup!, 'utf8'), s.text);
  await noPlaintextOnDisk(s.root);
  assert.equal((await migrateCredentials(base(s, keyring()))).status, 'committed', 'idempotent after commit');
  await rollbackCredentialMigration({ profileDirectory: s.profile, keyring: k, ownerHeld:true }); assert.equal(k.store.size, 0);
  await assert.rejects(readFile(migrationPaths(s.profile).state)); assert.equal(await readFile(join(s.legacy, 'credentials.encrypted.json'), 'utf8'), s.text);
  await rm(s.root, { recursive: true, force: true });
});

for (const [name, k, code] of [['keyring locked mid-way', keyring({ lockedAfter: 1 }), 'KEYRING_LOCKED'], ['access denied', keyring({ denied: true }), 'KEYRING_ACCESS_DENIED'], ['read-back mismatch', keyring({ mismatch: 'provider:b' }), 'KEYRING_READBACK_MISMATCH']] as const)
  test(`migration: ${name} rolls back new entries, leaves original unchanged and is retryable`, async () => {
    const s = await setup();
    const r = await migrateCredentials(base(s, k));
    assert.equal(r.status, 'aborted'); assert.equal(r.error?.code, code); assert.equal(k.store.size, 0, 'partial writes rolled back');
    assert.equal(await readFile(join(s.legacy, 'credentials.encrypted.json'), 'utf8'), s.text);
    await assert.rejects(readFile(migrationPaths(s.profile).state), 'no commit marker');
    await noPlaintextOnDisk(s.root);
    const retry = await migrateCredentials(base(s, keyring())); assert.equal(retry.status, 'committed');
    await rm(s.root, { recursive: true, force: true });
  });

test('migration: injected error after first keyring write cleans the durable intent before retry', async () => {
  const s = await setup(), k = keyring(); let calls = 0;
  const crashing: Keyring = { ...k, async set(a, v) { await k.set(a, v); if (++calls === 1) throw Object.assign(new Error('SIGKILL'), { code: 'INTERRUPTED' }); } };
  const r = await migrateCredentials(base(s, crashing)); assert.equal(r.status, 'aborted');
  const journal = JSON.parse(await readFile(migrationPaths(s.profile).journal, 'utf8')); assert.equal(journal.status, 'aborted');
  const again = await migrateCredentials(base(s, k)); assert.equal(again.status, 'committed'); assert.equal(k.store.size, 3);
  await rm(s.root, { recursive: true, force: true });
});

for(const phase of ['after-state-commit','before-journal-commit'] as const)test(`migration: ${phase} failure cannot remove committed keys`,async()=>{
  const s=await setup(),k=keyring();try{
    const result=await migrateCredentials({...base(s,k),onPhase(point){if(point===phase)throw Object.assign(new Error('synthetic postcommit I/O failure'),{code:'EIO'});}});
    assert.equal(result.status,'committed');assert.equal(k.store.size,3);
    const state=JSON.parse(await readFile(migrationPaths(s.profile).state,'utf8')),journal=JSON.parse(await readFile(migrationPaths(s.profile).journal,'utf8'));
    assert.equal(state.attempt,journal.attempt);assert.equal(journal.status,'committed');
    assert.equal((await migrateCredentials(base(s,k))).status,'committed');assert.equal(k.store.size,3);await noPlaintextOnDisk(s.root);
  }finally{await rm(s.root,{recursive:true,force:true});}
});

test('migration: pre-existing canonical key is neither overwritten nor removed by abort or explicit rollback',async()=>{
  const s=await setup(),k=keyring();k.store.set('yingliu-agent:provider:a','existing synthetic credential');
  try{
    const aborted=await migrateCredentials({...base(s,k),onPhase(point){if(point==='after-keyring-write')throw new Error('synthetic precommit fault');}});assert.equal(aborted.status,'aborted');assert.equal(k.store.size,1);assert.equal(k.store.get('yingliu-agent:provider:a'),'existing synthetic credential');
    const committed=await migrateCredentials(base(s,k));assert.equal(committed.status,'committed');assert.equal(k.store.size,4);
    await rollbackCredentialMigration({profileDirectory:s.profile,keyring:k,ownerHeld:true});assert.equal(k.store.size,1);assert.equal(k.store.get('yingliu-agent:provider:a'),'existing synthetic credential');
  }finally{await rm(s.root,{recursive:true,force:true});}
});

test('migration: malformed state is not treated as a new migration or cleaned up',async()=>{
  const s=await setup(),k=keyring();try{
    assert.equal((await migrateCredentials(base(s,k))).status,'committed');const paths=migrationPaths(s.profile);
    for(const bytes of ['{broken state','null','[]','false','0']){await writeFile(paths.state,bytes);const code=bytes.startsWith('{broken')?'MIGRATION_STATE_UNREADABLE':'MIGRATION_STATE_INVALID';
      await assert.rejects(migrateCredentials(base(s,k)),{code});await assert.rejects(rollbackCredentialMigration({profileDirectory:s.profile,keyring:k,ownerHeld:true}),{code});assert.equal(k.store.size,3);assert.equal(await readFile(paths.state,'utf8'),bytes);}
  }finally{await rm(s.root,{recursive:true,force:true});}
});

test('migration: explicit rollback requires the same profile ownership before touching state or keys',async()=>{
  const s=await setup(),k=keyring();try{
    assert.equal((await migrateCredentials(base(s,k))).status,'committed');const paths=migrationPaths(s.profile),before=await readFile(paths.state,'utf8');
    await assert.rejects(rollbackCredentialMigration({profileDirectory:s.profile,keyring:k,ownerHeld:false}),{code:'NOT_OWNER'});assert.equal(k.store.size,3);assert.equal(await readFile(paths.state,'utf8'),before);
  }finally{await rm(s.root,{recursive:true,force:true});}
});

test('migration: special own-property refs keep durable intents for commit and interrupted cleanup',async()=>{
  for(const abort of [false,true]){
    const s=await setup('{"__proto__":"'+enc(SYNTH['provider:a'])+'","constructor":"'+enc(SYNTH['provider:b'])+'"}'),k=keyring();try{
      const result=await migrateCredentials({...base(s,k),onPhase(point){if(abort&&point==='after-keyring-write')throw new Error('synthetic fault');}});
      assert.equal(result.status,abort?'aborted':'committed');assert.equal(k.store.size,abort?0:2);
      const journal=JSON.parse(await readFile(migrationPaths(s.profile).journal,'utf8'));assert.ok(Object.hasOwn(journal.accounts,'__proto__'));
      if(!abort){assert.equal(result.refs.__proto__,'migrated');await rollbackCredentialMigration({profileDirectory:s.profile,keyring:k,ownerHeld:true});assert.equal(k.store.size,0);}
    }finally{await rm(s.root,{recursive:true,force:true});}
  }
});

test('migration: interrupted durable intent is cleaned before a fresh attempt without touching old accounts',async()=>{
  const s=await setup(),k=keyring();try{
    const committed=await migrateCredentials(base(s,k));assert.equal(committed.status,'committed');const paths=migrationPaths(s.profile),journal=JSON.parse(await readFile(paths.journal,'utf8'));
    await rm(paths.state);journal.status='started';await writeFile(paths.journal,JSON.stringify(journal));k.store.set('yingliu-agent:unrelated','existing synthetic value');
    const oldAccounts=Object.values(journal.accounts) as string[];assert.equal((await migrateCredentials(base(s,k))).status,'committed');assert.ok(oldAccounts.every(account=>!k.store.has(account)));assert.equal(k.store.size,4);assert.equal(k.store.get('yingliu-agent:unrelated'),'existing synthetic value');
  }finally{await rm(s.root,{recursive:true,force:true});}
});

test('migration: bad ciphertext → that ref is marked undecryptable (reconfigure), others migrate; unavailable/corrupt/legacy-running/no-owner refuse', async () => {
  const s = await setup();
  const r = await migrateCredentials(base(s, keyring(), decryptor({ bad: [SYNTH['provider:a']] }))); assert.equal(r.status, 'committed'); assert.equal(r.refs['provider:a'], 'undecryptable'); assert.equal(r.refs['provider:c'], 'migrated');
  const u = await setup(); assert.equal((await migrateCredentials(base(u, keyring(), decryptor({ available: false })))).error?.code, 'LEGACY_UNAVAILABLE');
  const c = await setup('{not json'); assert.equal((await migrateCredentials(base(c, keyring()))).error?.code, 'LEGACY_CORRUPT'); assert.equal(await readFile(join(c.legacy, 'credentials.encrypted.json'), 'utf8'), '{not json');
  await assert.rejects(migrateCredentials({ ...base(u, keyring()), legacyRunning: () => true }), /旧版/);
  await assert.rejects(migrateCredentials({ ...base(u, keyring()), ownerHeld: false }), /owner/);
  for (const x of [s, u, c]) await rm(x.root, { recursive: true, force: true });
});
