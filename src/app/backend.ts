import { join, resolve } from 'node:path';
import type { BackendPort, ProviderHost, SecretStore } from './contracts.ts';
import type { RpcResult, StudioSnapshot } from '../shared/types.ts';
import { ProjectHub } from '../host/project-hub.ts';
import type { GeneratedFile, MediaTask } from '../jobs/contracts.ts';
import type { TtsSettings } from '../shared/types.ts';

export interface AppBackendOptions {
  dataDirectory:string;
  providers:ProviderHost;
  credentials:SecretStore;
  reveal?:(path:string)=>Promise<void>;
  /** Project root directory; defaults to <dataDirectory>/projects. */
  projectsDirectory?:string;
  claimProjectRoot?:(root:string)=>Promise<void>;
}

/** Native shell and conversation coordinator share this application backend. */
export class AppBackend implements BackendPort {
  private readonly hub:ProjectHub;
  constructor(options:AppBackendOptions){
    this.hub=new ProjectHub({llm:options.providers,credentials:options.credentials,reveal:options.reveal,claimProjectRoot:options.claimProjectRoot},
      {baseDirectory:options.projectsDirectory?resolve(options.projectsDirectory):join(resolve(options.dataDirectory),'projects')});
  }
  call<T=StudioSnapshot>(endpoint:string,payload:unknown={}):Promise<T>{return this.hub.call<T>(endpoint,payload);}
  route(endpoint:string,payload:unknown={}):Promise<RpcResult>{return this.hub.route(endpoint,payload);}
  mediaPort(){return this.hub.mediaPort();}
  stageWorkflowMedia(id:string,task:MediaTask,files:GeneratedFile[],signal:AbortSignal){return this.hub.stageWorkflowMedia(id,task,files,signal);}
  workflowVoice(id:string,shotId:string,text:string,signal:AbortSignal,settings?:TtsSettings){return this.hub.workflowVoice(id,shotId,text,signal,settings);}
  workflowCapture(id:string,frame:number,signal:AbortSignal,candidate?:import('../workflows/contracts.ts').WorkflowCandidate){return this.hub.workflowCapture(id,frame,signal,candidate);}
  dispose():Promise<void>{return this.hub.dispose();}
}
