import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicRename } from '../host/atomic-rename.ts';
import { syncDirectory } from '../host/directory-sync.ts';

const MAX_DRAFT_BYTES=64*1024*1024;

function validateContents(contents:unknown):asserts contents is string {
  if(typeof contents!=='string'||Buffer.byteLength(contents)>MAX_DRAFT_BYTES||!Array.isArray(JSON.parse(contents))) {
    throw new Error('源码草稿须为小于 64 MiB 的 JSON 数组');
  }
}

/** One profile-scoped cache, independent of the editor's assigned loopback port. */
export class SourceDraftFile {
  private readonly file:string;
  private writes:Promise<void>=Promise.resolve();

  constructor(private readonly directory:string) {
    this.file=join(directory,'source-drafts.json');
  }

  async read():Promise<string|null> {
    await this.writes;
    try {
      const contents=await readFile(this.file,'utf8');
      validateContents(contents);
      return contents;
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
      throw error;
    }
  }

  write(contents:unknown):Promise<void> {
    const work=this.writes.then(async()=>{
      validateContents(contents);
      await mkdir(this.directory,{recursive:true,mode:0o700});
      const temporary=this.file+'.tmp-'+randomUUID();
      try {
        await writeFile(temporary,contents,{flag:'wx',mode:0o600,flush:true});
        await atomicRename(temporary,this.file);
        await syncDirectory(this.directory);
      } finally {
        await rm(temporary,{force:true}).catch(()=>{});
      }
    });
    this.writes=work.catch(()=>{});
    return work;
  }

  flush():Promise<void> {return this.writes;}
}
