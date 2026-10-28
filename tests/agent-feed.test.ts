import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRunFeed, parseSse } from '../src/client/agent-feed.ts';
import type { PublicRun } from '../src/agent/contracts.ts';

function run(id:string,status:PublicRun['status']='running'):PublicRun{return {id,status,createdAt:'2026-10-27T00:00:00Z'} as PublicRun;}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(res=>{resolve=res;});return {promise,resolve};}
async function until(check:()=>boolean){const deadline=Date.now()+2000;while(!check()){assert.ok(Date.now()<deadline,'feed did not settle');await new Promise(resolve=>setTimeout(resolve,5));}}
const unavailable=async()=>new Response(null,{status:503});

test('a normally closed SSE stream returns to polling, including initially empty projects',async()=>{
  let stream!:ReadableStreamDefaultController<Uint8Array>,calls=0;const live:boolean[]=[],updates:PublicRun[][]=[];
  const feed=new AgentRunFeed({list:async()=>++calls<=2?[]:[run('later','complete')],connect:async()=>new Response(new ReadableStream<Uint8Array>({start(controller){stream=controller;}})),onLive:value=>live.push(value),onRuns:value=>updates.push(value),pollMs:10});
  try{feed.start();await until(()=>live.includes(true));await until(()=>calls===2);await new Promise(resolve=>setTimeout(resolve,40));assert.equal(calls,2,'healthy SSE does not keep polling');stream.close();await until(()=>updates.some(list=>list[0]?.id==='later'));assert.equal(live.at(-1),false);}
  finally{feed.stop();}
});

test('a late list response preserves newer streamed state and still includes historical runs',async()=>{
  let stream!:ReadableStreamDefaultController<Uint8Array>;const list=deferred<PublicRun[]>(),updates:PublicRun[][]=[];let calls=0;
  const feed=new AgentRunFeed({list:()=>++calls===1?list.promise:Promise.resolve([run('active','complete'),run('history','complete')]),connect:async()=>new Response(new ReadableStream<Uint8Array>({start(controller){stream=controller;}})),onLive:()=>{},onRuns:value=>updates.push(value)});
  try{feed.start();await until(()=>!!stream);stream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'run',run:run('active','complete')})+'\n\n'));await until(()=>updates.length>0);list.resolve([run('active'),run('history','complete')]);await until(()=>updates.at(-1)?.length===2);assert.equal(updates.at(-1)?.find(value=>value.id==='active')?.status,'complete');}
  finally{feed.stop();}
});

test('stopped project subscriptions ignore late responses and release the stream',async()=>{
  const list=deferred<PublicRun[]>();let updates=0,cancelled=false;
  const feed=new AgentRunFeed({list:()=>list.promise,connect:async()=>new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}})),onLive:()=>{},onRuns:()=>updates++});
  feed.start();await new Promise(resolve=>setTimeout(resolve,0));feed.stop();list.resolve([run('old-project')]);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(updates,0);assert.equal(cancelled,true);
});

test('failed polling requests retry without overlap and recover after the stream is unavailable',async()=>{
  let calls=0,concurrent=0,peak=0;const updates:PublicRun[][]=[];
  const feed=new AgentRunFeed({list:async()=>{concurrent++;peak=Math.max(peak,concurrent);try{await new Promise(resolve=>setTimeout(resolve,10));if(++calls===1)throw new Error('temporary');return [run('recovered')];}finally{concurrent--;}},connect:unavailable,onLive:()=>{},onRuns:value=>updates.push(value),pollMs:5});
  try{feed.start();await until(()=>updates.length>0);assert.ok(calls>=2);assert.equal(peak,1);assert.equal(updates[0]?.[0]?.id,'recovered');}
  finally{feed.stop();}
});

test('SSE parser accepts CRLF and preserves a split event',()=>{
  const event={type:'run',run:run('one')};const first=parseSse('data: '+JSON.stringify(event)+'\r');assert.equal(first.events.length,0);
  const parsed=parseSse(first.rest+'\n\r\n');assert.deepEqual(parsed.events,[event]);assert.equal(parsed.rest,'');
});

test('subscription handshake refreshes changes that occurred after the initial list without another event',async()=>{
  const connected=deferred<Response>();let current=run('approval'),calls=0;const updates:PublicRun[][]=[];
  const feed=new AgentRunFeed({list:async()=>{calls++;return [current];},connect:()=>connected.promise,onLive:()=>{},onRuns:value=>updates.push(value),pollMs:1000});
  try{
    feed.start();await until(()=>updates.length===1);assert.equal(updates[0]?.[0]?.status,'running');
    current=run('approval','awaiting_approval');connected.resolve(new Response(new ReadableStream<Uint8Array>()));
    await until(()=>updates.at(-1)?.[0]?.status==='awaiting_approval');assert.equal(calls,2);
  }finally{feed.stop();}
});

test('subscription handshake queues its post-connect read behind an in-flight initial list',async()=>{
  const initial=deferred<PublicRun[]>();let calls=0;const updates:PublicRun[][]=[];
  const feed=new AgentRunFeed({list:()=>++calls===1?initial.promise:Promise.resolve([run('approval','awaiting_approval')]),connect:async()=>new Response(new ReadableStream<Uint8Array>()),onLive:()=>{},onRuns:value=>updates.push(value)});
  try{feed.start();await new Promise(resolve=>setTimeout(resolve,0));initial.resolve([run('approval')]);await until(()=>updates.at(-1)?.[0]?.status==='awaiting_approval');assert.equal(calls,2);}
  finally{feed.stop();}
});
