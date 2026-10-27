import type { AgentEvent, PublicRun } from '../agent/contracts.ts';

/** Parse complete SSE blocks, retaining a partial event for the next chunk. */
export function parseSse(buffer:string):{events:AgentEvent[];rest:string}{
  const blocks=buffer.replace(/\r\n/g,'\n').split('\n\n'),rest=blocks.pop()??'',events:AgentEvent[]=[];
  for(const block of blocks){const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');if(data)try{events.push(JSON.parse(data));}catch{/* malformed events are ignored */}}
  return {events,rest};
}

interface AgentFeedOptions {
  list:()=>Promise<PublicRun[]>;
  connect:(signal:AbortSignal)=>Promise<Response>;
  onRuns:(runs:PublicRun[])=>void;
  onLive:(live:boolean)=>void;
  pollMs?:number;
}
/** One project-scoped subscription. A closed stream falls back to non-overlapping polling. */
export class AgentRunFeed {
  private active=false;private live=false;private reading=false;private refreshRequested=false;private revision=0;
  private timer:ReturnType<typeof setTimeout>|undefined;private reader:ReadableStreamDefaultReader<Uint8Array>|undefined;private abort=new AbortController();private runs:PublicRun[]=[];
  constructor(private readonly options:AgentFeedOptions){}
  start():void{if(this.active)return;this.active=true;this.options.onLive(false);void this.refresh().catch(()=>{});void this.stream();}
  stop():void{this.active=false;this.revision++;this.abort.abort();void this.reader?.cancel().catch(()=>{});clearTimeout(this.timer);this.timer=undefined;}
  private publish(runs:PublicRun[]):void{this.runs=runs;this.options.onRuns(runs);}
  private schedule():void{if(!this.active||this.live||this.timer)return;this.timer=setTimeout(()=>{this.timer=undefined;void this.refresh().catch(()=>{});},this.options.pollMs??2000);}
  async refresh():Promise<void>{
    if(!this.active)return;if(this.reading){this.refreshRequested=true;return;}this.reading=true;const revision=this.revision;
    try{const runs=await this.options.list();if(this.active)this.publish(revision===this.revision?runs:[...this.runs,...runs.filter(run=>!this.runs.some(current=>current.id===run.id))].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));}
    finally{this.reading=false;if(this.refreshRequested&&this.active){this.refreshRequested=false;void this.refresh().catch(()=>{});}else this.schedule();}
  }
  private async stream():Promise<void>{
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try{
      const response=await this.options.connect(this.abort.signal);
      if(!this.active){await response.body?.cancel().catch(()=>{});return;}if(!response.ok||!response.body)throw new Error('实时连接不可用');
      reader=response.body.getReader();this.reader=reader;this.live=true;clearTimeout(this.timer);this.timer=undefined;this.options.onLive(true);
      // Re-read after subscription: changes between the initial list and the SSE handshake may have no later event.
      void this.refresh().catch(()=>{});
      const decoder=new TextDecoder();let buffer='';
      while(this.active){const next=await reader.read();if(!this.active||next.done)break;buffer+=decoder.decode(next.value,{stream:true});const parsed=parseSse(buffer);buffer=parsed.rest;
        for(const event of parsed.events)if(event.type==='run'){
          this.revision++;this.publish([event.run,...this.runs.filter(run=>run.id!==event.run.id)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
        }
      }
    }catch{/* The list API remains available when streaming fails. */}
    finally{if(reader)await reader.cancel().catch(()=>{});this.reader=undefined;if(this.active){this.live=false;this.options.onLive(false);this.schedule();}}
  }
}
