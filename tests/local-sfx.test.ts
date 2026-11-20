import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesizeLocalSfx } from '../src/media/local-sfx.ts';
import { StudioService } from '../src/host/service.ts';
import { MemorySecrets } from '../src/app/application.ts';
import { detectEnvironment } from '../src/host/renderer.ts';
import { qualityCheck } from '../src/agent/tools.ts';
import { createProject } from '../src/core/index.ts';
import type { HostContext } from '../src/host/platform.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';
import type { QcReport, Story } from '../src/agent/story.ts';

const environment=detectEnvironment();
const context={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('Local SFX test must not call external LLM providers');}},credentials:new MemorySecrets()} as unknown as HostContext;

async function call<T=StudioSnapshot>(service:StudioService,endpoint:string,payload:unknown={}):Promise<T>{
  const result=await service.rpc(endpoint,payload);
  assert.equal(result.ok,true,result.ok?'':result.error.message);
  return (result.ok?result.value:undefined) as T;
}

test('synthesizeLocalSfx produces deterministic RIFF/WAVE bytes and rejects invalid params',()=>{
  const a=synthesizeLocalSfx({kind:'chime',durationSeconds:.5,frequency:880,volume:.6,seed:42});
  const b=synthesizeLocalSfx({kind:'chime',durationSeconds:.5,frequency:880,volume:.6,seed:42});
  const c=synthesizeLocalSfx({kind:'whoosh',durationSeconds:.4,seed:7});
  assert.deepEqual(a,b);
  assert.equal(Buffer.from(a.subarray(0,4)).toString('ascii'),'RIFF');
  assert.equal(Buffer.from(a.subarray(8,12)).toString('ascii'),'WAVE');
  assert.equal(a.length,44+22050*2);
  assert.notDeepEqual(a,c);
  assert.throws(()=>synthesizeLocalSfx({kind:'tone',durationSeconds:99}),/音效时长/);
  assert.throws(()=>synthesizeLocalSfx({kind:'tone',durationSeconds:.5,seed:1.5}),/整数/);
});

test('audio.sfx imports WAV asset, adds sfx clip, enforces requestId idempotency and conflict detection',{skip:!environment.ffprobeAvailable},async()=>{
  const base=await mkdtemp(join(tmpdir(),'yingliu-agent-sfx-'));
  const service=new StudioService(context,{baseDirectory:base});
  try{
    let snapshot=await call(service,'create',{title:'本地音效测试',blank:false});
    const spec={kind:'chime' as const,durationSeconds:.5,frequency:880,volume:.6,seed:42};
    const request={name:'确定性钟声',spec,requestId:'sfx-req-1',expectedRevision:snapshot.project!.revision};
    snapshot=await call(service,'audio.sfx',request);
    const first=snapshot.project!;
    assert.equal(first.assets.filter(a=>a.kind==='audio').length,1);
    assert.equal(first.audioClips?.length,1);
    assert.equal(first.audioClips?.[0]?.role,'sfx');
    assert.equal(first.target.audioMode,'mixed');
    const asset=first.assets.find(a=>a.kind==='audio')!;
    assert.deepEqual(await readFile(join(snapshot.root!,asset.path!)),Buffer.from(synthesizeLocalSfx(spec)));

    // A retry after a lost reply sends the original revision and must not duplicate the effect.
    snapshot=await call(service,'audio.sfx',request);
    assert.equal(snapshot.project!.revision,first.revision);
    assert.equal(snapshot.project!.assets.filter(a=>a.kind==='audio').length,1);
    assert.equal(snapshot.project!.audioClips?.length,1);

    // Repeating the same requestId with different content rejects with IMPORT_REQUEST_CONFLICT.
    const conflict=await service.rpc('audio.sfx',{...request,name:'另一个音效',spec:{...spec,seed:99}});
    assert.equal(conflict.ok,false);
    if(!conflict.ok)assert.equal(conflict.error.code,'IMPORT_REQUEST_CONFLICT');
    const stale=await service.rpc('audio.sfx',{...request,requestId:'another-id'});
    assert.ok(!stale.ok);assert.equal(stale.error.code,'REVISION_CONFLICT');

    const assetsBefore=await readdir(join(snapshot.root!,'assets'));
    const invalid=await service.rpc('audio.sfx',{...request,requestId:'invalid-clip',expectedRevision:first.revision,shotId:'missing-shot'});
    assert.equal(invalid.ok,false);
    assert.deepEqual(await readdir(join(snapshot.root!,'assets')),assetsBefore);
    const current=await call(service,'current');
    assert.equal(current.project!.revision,first.revision);
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});

test('qualityCheck records project revision on saved QcReport',async()=>{
  const project=createProject('质检版本记录');
  project.revision=7;
  let saved:QcReport|undefined;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR42mP8z8DAAwAAAwAB/2gU8QAAAABJRU5ErkJggg==','base64');
  const story:Story={version:1,projectId:project.id,title:project.title,logline:'',targetSeconds:10,style:{look:'',palette:'',typography:'',motion:'',negative:''},characters:[],shots:[],consistency:{},status:'empty',updatedAt:new Date().toISOString()};
  const report=await qualityCheck({
    runId:'qc-run-1',
    projectId:project.id,
    signal:new AbortController().signal,
    port:{
      snapshot:async()=>({project,root:null,task:null,previewUrl:null,previewRevision:null,providers:[],environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:false,ffmpegAvailable:false,ffprobeAvailable:false},recent:[]}),
      capture:async()=>({bytes:png,mime:'image/png'}),
    } as any,
    docs:{
      story:async()=>story,
      saveQc:async(value:QcReport)=>{saved=value;},
    } as any,
  });
  assert.equal(report.revision,7);
  assert.equal(saved?.revision,7);
});
