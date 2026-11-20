import type { SceneSource } from '../shared/types.ts';

export interface SourceDraft {
  projectId:string;
  shotId:string;
  source:SceneSource;
  baseRevision:number;
  updatedAt:string;
}

type DraftStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export interface NativeDraftBridge {
  readSourceDrafts():Promise<string|null>;
  writeSourceDrafts(contents:string):Promise<void>;
}
const STORAGE_KEY='yingliu-agent.source-drafts.v1';
const SESSION_WARNING='源码草稿的本地存储不可用，草稿仅保留在本次会话；关闭页面后可能丢失。';

function draftKey(projectId:string,shotId:string):string {
  return JSON.stringify([projectId,shotId]);
}

function isRecord(value:unknown):value is Record<string,unknown> {
  return typeof value==='object'&&value!==null&&!Array.isArray(value);
}

function isDraft(value:unknown):value is SourceDraft {
  if(!isRecord(value))return false;
  const source=value.source;
  return typeof value.projectId==='string'&&value.projectId.length>0
    &&typeof value.shotId==='string'&&value.shotId.length>0
    &&typeof value.baseRevision==='number'&&Number.isInteger(value.baseRevision)&&value.baseRevision>=0
    &&typeof value.updatedAt==='string'&&value.updatedAt.length>0
    &&isRecord(source)
    &&['html','css','js'].every(field=>typeof source[field]==='string');
}

/** Local edits only: storing a draft never saves or executes its scene source. */
export class SourceDraftStore {
  private readonly drafts=new Map<string,SourceDraft>();
  private readonly storage?:DraftStorage;
  private storageWarning='';
  private native?:NativeDraftBridge;
  private onStorageFailure?:(warning:string)=>void;
  private nativeWrite?:Promise<boolean>;
  private editVersion=0;
  private savedVersion=0;

  constructor(storage?:DraftStorage|null) {
    try {
      this.storage=storage===undefined?(typeof window==='undefined'?undefined:window.localStorage):storage??undefined;
    } catch {
      this.storageWarning=SESSION_WARNING;
    }
    if(!this.storage)return;
    let saved:string|null;
    try {
      saved=this.storage.getItem(STORAGE_KEY);
    } catch {
      this.storageWarning=SESSION_WARNING;
      return;
    }
    try {
      this.restore(saved);
    } catch {
      // A malformed cache must not prevent the editor from opening.
    }
  }

  static async openNative(native:NativeDraftBridge,onStorageFailure?:(warning:string)=>void):Promise<SourceDraftStore> {
    const store=new SourceDraftStore(null);
    try {
      store.restore(await native.readSourceDrafts());
      store.native=native;
    } catch {
      store.storageWarning=SESSION_WARNING;
    }
    store.onStorageFailure=onStorageFailure;
    return store;
  }

  private restore(saved:string|null):void {
    if(!saved)return;
    const values:unknown=JSON.parse(saved);
    if(!Array.isArray(values))throw new Error('源码草稿列表无效');
    for(const draft of values) {
      if(isDraft(draft))this.drafts.set(draftKey(draft.projectId,draft.shotId),structuredClone(draft));
    }
  }

  get warning():string {return this.storageWarning;}
  get pending():boolean {return this.editVersion!==this.savedVersion;}

  get(projectId:string,shotId:string):SourceDraft|undefined {
    const draft=this.drafts.get(draftKey(projectId,shotId));
    return draft?structuredClone(draft):undefined;
  }

  list(projectId:string):SourceDraft[] {
    return [...this.drafts.values()].filter(draft=>draft.projectId===projectId).map(draft=>structuredClone(draft));
  }

  set(draft:SourceDraft):void {
    this.drafts.set(draftKey(draft.projectId,draft.shotId),structuredClone(draft));
    this.editVersion++;
    this.persist();
  }

  delete(projectId:string,shotId:string):void {
    if(this.drafts.delete(draftKey(projectId,shotId)))this.editVersion++;
    this.persist();
  }

  persist():boolean {
    if(this.native){void this.flush();return !this.pending;}
    if(!this.storage)return false;
    try {
      if(this.drafts.size)this.storage.setItem(STORAGE_KEY,JSON.stringify([...this.drafts.values()]));
      else this.storage.removeItem(STORAGE_KEY);
      this.savedVersion=this.editVersion;
      this.storageWarning='';
      return true;
    } catch {
      this.storageWarning=SESSION_WARNING;
      return false;
    }
  }

  async flush():Promise<boolean> {
    if(!this.native)return this.persist();
    while(this.pending) {
      this.nativeWrite??=this.writeNative(this.native).finally(()=>{this.nativeWrite=undefined;});
      if(!await this.nativeWrite)return false;
    }
    return true;
  }

  private async writeNative(native:NativeDraftBridge):Promise<boolean> {
    const version=this.editVersion;
    try {
      await native.writeSourceDrafts(JSON.stringify([...this.drafts.values()]));
      this.savedVersion=version;
      this.storageWarning='';
      return true;
    } catch {
      if(!this.storageWarning){this.storageWarning=SESSION_WARNING;this.onStorageFailure?.(this.storageWarning);}
      return false;
    }
  }
}
