/** P0 transaction design; exercised only with synthetic keyrings and ciphertext. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {writeDurableFile,syncDirectory} from '../agent/durable-file.ts';

export interface LegacyDecryptor {available():boolean;decrypt(ciphertext:Buffer):string}
export interface Keyring {set(account:string,value:string):Promise<void>;get(account:string):Promise<string|undefined>;delete(account:string):Promise<void>}
type Phase='before-keyring-write'|'after-keyring-write'|'before-state-commit'|'after-state-commit'|'before-journal-commit';
export interface MigrationEnv {legacyDirectory:string;profileDirectory:string;decryptor:LegacyDecryptor;keyring:Keyring;ownerHeld:boolean;legacyRunning:()=>boolean;service?:string;/** Trusted synthetic fault injection only. */onPhase?:(phase:Phase)=>Promise<void>|void}
export type RefOutcome='migrated'|'undecryptable';
export interface MigrationResult {status:'committed'|'nothing-to-migrate'|'aborted';refs:Record<string,RefOutcome>;error?:{code:string;message:string};warning?:{code:string;message:string};backup?:string}
interface Journal {schemaVersion:2;attempt:string;startedAt:string;legacySha256:string;backup:string;accounts:Record<string,string>;refs:Record<string,RefOutcome>;status:'started'|'committed'|'aborted'|'rolling-back'|'rolled-back'}
interface State extends Journal {committedAt:string;status:'committed'|'rolling-back'}
const LEGACY='credentials.encrypted.json',failure=(code:string,message:string)=>Object.assign(new Error(message),{code});
const sha256=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
export function migrationPaths(profileDirectory:string){const dir=join(profileDirectory,'migration');return {dir,journal:join(dir,'credentials-journal.json'),state:join(dir,'credentials-state.json')};}
async function load<T>(file:string):Promise<T|undefined>{try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw failure('MIGRATION_STATE_UNREADABLE','迁移状态无法读取；已保留原文件和钥匙环，请先修复');}}
const save=(file:string,value:unknown)=>writeDurableFile(file,JSON.stringify(value,null,2)+'\n');
function validate(value:Journal|State):void {
  if(!value||value.schemaVersion!==2||!/^[a-f0-9-]{36}$/.test(value.attempt)||!value.accounts||typeof value.accounts!=='object'||Array.isArray(value.accounts)||!value.refs||typeof value.refs!=='object'||Array.isArray(value.refs)||!['started','committed','aborted','rolling-back','rolled-back'].includes(value.status)
    ||Object.values(value.refs).some(outcome=>outcome!=='migrated'&&outcome!=='undecryptable')
    ||Object.values(value.accounts).some(account=>typeof account!=='string'||!account.includes(':migration:'+value.attempt+':')))throw failure('MIGRATION_STATE_INVALID','迁移状态损坏；不会删除钥匙环或重新迁移');
}
async function removeOwned(env:Pick<MigrationEnv,'keyring'>,journal:Journal){
  // Every destination is a fresh attempt namespace, never the legacy/shared name.
  // Intent is durable BEFORE set(), including a set() that writes then throws.
  validate(journal);for(const account of Object.values(journal.accounts))await env.keyring.delete(account);
}
async function committedResult(paths:ReturnType<typeof migrationPaths>,state:State):Promise<MigrationResult>{
  const result:MigrationResult={status:'committed',refs:state.refs,backup:state.backup};
  try{await save(paths.journal,{...state,status:'committed'});}catch{result.warning={code:'JOURNAL_PENDING',message:'迁移已提交，状态为准；日志待修复，已保留钥匙环'};}return result;
}

export async function migrateCredentials(env:MigrationEnv):Promise<MigrationResult>{
  if(!env.ownerHeld)throw failure('NOT_OWNER','迁移前必须持有 profile owner 锁');
  if(env.legacyRunning())throw failure('LEGACY_RUNNING','旧版应用仍在运行，请先退出');
  const paths=migrationPaths(env.profileDirectory);await mkdir(paths.dir,{recursive:true});
  const state=await load<State>(paths.state);
  if(state!==undefined){validate(state);if(state.status==='committed')return committedResult(paths,state);throw failure('ROLLBACK_PENDING','迁移正在回滚，请先完成显式回滚');}
  const pending=await load<Journal>(paths.journal);
  if(pending!==undefined){validate(pending);if(pending.status==='committed')throw failure('MIGRATION_INCONSISTENT','已提交日志缺少状态；已停止以免删除已提交凭据');if(pending.status!=='rolled-back'){await removeOwned(env,pending);await save(paths.journal,{...pending,status:'rolled-back'});}}
  let bytes:Buffer;try{bytes=await readFile(join(env.legacyDirectory,LEGACY));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {status:'nothing-to-migrate',refs:{}};throw error;}
  const attempt=randomUUID(),backup=join(paths.dir,'backup-'+attempt+'.json');await writeDurableFile(backup,bytes);
  if(sha256(await readFile(backup))!==sha256(bytes))throw failure('BACKUP_MISMATCH','备份校验失败');
  const journal:Journal={schemaVersion:2,attempt,startedAt:new Date().toISOString(),legacySha256:sha256(bytes),backup,accounts:Object.create(null),refs:Object.create(null),status:'started'};
  await save(paths.journal,journal);
  try{
    let parsed:Record<string,string>;try{parsed=JSON.parse(bytes.toString('utf8'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();}catch{throw failure('LEGACY_CORRUPT','旧凭据文件格式损坏；原件与备份均保留');}
    if(!env.decryptor.available())throw failure('LEGACY_UNAVAILABLE','原系统安全存储不可用，无法解密；请重新配置');
    for(const [ref,encoded]of Object.entries(parsed)){
      let plain:string;try{plain=env.decryptor.decrypt(Buffer.from(String(encoded),'base64'));}catch{journal.refs[ref]='undecryptable';await save(paths.journal,journal);continue;}
      const account=(env.service??'yingliu-agent')+':migration:'+attempt+':'+sha256(ref).slice(0,32);
      if(await env.keyring.get(account)!==undefined)throw failure('KEYRING_ACCOUNT_EXISTS','迁移目标已存在；不会覆盖已有值');
      journal.accounts[ref]=account;await save(paths.journal,journal);await env.onPhase?.('before-keyring-write');
      try{await env.keyring.set(account,plain);}catch(error){throw failure((error as {code?:string}).code??'KEYRING_WRITE_FAILED','写入系统钥匙环失败');}
      await env.onPhase?.('after-keyring-write');
      if(await env.keyring.get(account)!==plain)throw failure('KEYRING_READBACK_MISMATCH','钥匙环读回核对失败');
      journal.refs[ref]='migrated';await save(paths.journal,journal);
    }
    await env.onPhase?.('before-state-commit');
    const committed:State={...journal,status:'committed',committedAt:new Date().toISOString()};
    await save(paths.state,committed);await env.onPhase?.('after-state-commit');
    await env.onPhase?.('before-journal-commit');return committedResult(paths,committed);
  }catch(error){
    // Rename may already have installed the authoritative commit marker even if
    // a directory sync or the following journal write reports failure.
    const committed=await load<State>(paths.state);if(committed!==undefined){validate(committed);if(committed.attempt===attempt&&committed.status==='committed')return committedResult(paths,committed);throw failure('MIGRATION_INCONSISTENT','状态指向其他迁移；不会删除钥匙环');}
    let rollbackError:unknown;try{await removeOwned(env,journal);}catch(cause){rollbackError=cause;}
    journal.status='aborted';await save(paths.journal,journal).catch(()=>{});
    const proposed=(error as {code?:string}).code,code=typeof proposed==='string'&&/^[A-Z0-9_]{1,64}$/.test(proposed)?proposed:'MIGRATION_FAILED';
    return {status:'aborted',refs:journal.refs,error:{code:rollbackError?'ROLLBACK_PENDING':code,message:rollbackError?'迁移中断，部分新凭据仍待清理；日志与旧文件保留':'迁移中断；原文件、备份与日志保留，请按错误代码检查后重试'},backup};
  }
}

/** Explicit rollback removes only this attempt namespace; pre-existing/shared keys are never touched. */
export async function rollbackCredentialMigration(env:Pick<MigrationEnv,'profileDirectory'|'keyring'|'service'|'ownerHeld'>):Promise<void>{
  if(!env.ownerHeld)throw failure('NOT_OWNER','回滚前必须持有 profile owner 锁');
  const paths=migrationPaths(env.profileDirectory),state=await load<State>(paths.state);if(state===undefined)return;validate(state);
  const rolling={...state,status:'rolling-back' as const};await save(paths.state,rolling);await save(paths.journal,rolling);
  await removeOwned(env,rolling);await save(paths.journal,{...rolling,status:'rolled-back'});await rm(paths.state);await syncDirectory(paths.dir);
}
