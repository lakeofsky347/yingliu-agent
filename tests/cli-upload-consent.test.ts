import test from 'node:test';
import assert from 'node:assert/strict';
import { cli, withCliEnv } from './cli-helpers.ts';
import { EXIT } from '../src/cli/main.ts';
import { toolGateway } from './model-gateway.ts';

test('CLI exposes the current upload decision and resumes the same run without implicitly approving upload or spending',()=>withCliEnv(async()=>{
  const director=await cli(['models','add','--name','fixture director','--base-url','https://gateway.test/v1','--model','fixture-director']);
  assert.equal(director.code,EXIT.OK,director.out);
  const video=await cli(['models','add','--name','fixture video','--protocol','video-gateway','--base-url','https://video.invalid/v1','--model','fixture-video']);
  assert.equal(video.code,EXIT.OK,video.out);
  const project=await cli(['project','create','--title','隔离参考图授权']);
  assert.equal(project.code,EXIT.OK,project.out);
  const gateway=toolGateway(body=>body.messages.at(-1)?.role==='tool'?{text:'已按用户选择继续'}:{toolCalls:[{id:'video',name:'generate_video',arguments:{expectedRevision:0,prompt:'参考图 fixture',imageAssetId:'fixture-image'}}]});
  const previous=globalThis.fetch;
  globalThis.fetch=(async(input,init)=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    assert.equal(url.origin,'https://gateway.test');
    return gateway.fetch(input,init);
  }) as typeof fetch;
  try {
    const held=await cli(['agent','run','--project',project.json.data.id,'--goal','请求图生视频']);
    assert.equal(held.code,EXIT.NEEDS_APPROVAL,held.out);
    const runId=held.json.data.id,challenge=held.json.data.visionConsentRequired;
    assert.match(challenge.id,/^[0-9a-f-]+$/);
    assert.deepEqual({...challenge,id:undefined},{id:undefined,purpose:'video-reference',origin:'https://video.invalid',model:'fixture-video',assetId:'fixture-image'});

    const status=await cli(['agent','status',runId]);
    assert.equal(status.code,EXIT.OK,status.out);assert.deepEqual(status.json.data.visionConsentRequired,challenge);
    const bare=await cli(['agent','resume',runId]);
    assert.equal(bare.code,EXIT.NEEDS_APPROVAL,bare.out);assert.deepEqual(bare.json.data.visionConsentRequired,challenge);
    assert.equal(gateway.requests.length,1);

    for(const args of [['--upload-consent',challenge.id,'--skip-upload'],['--upload-consent'],['--skip-upload=false']]){
      const invalid=await cli(['agent','resume',runId,...args]);assert.equal(invalid.code,EXIT.USAGE,invalid.out);assert.equal(invalid.lines.length,1);
    }
    const stale=await cli(['agent','resume',runId,'--upload-consent','old-id']);
    assert.equal(stale.code,EXIT.ERROR,stale.out);assert.match(stale.json.error.message,/已过期/);
    const granted=await cli(['agent','resume',runId,'--upload-consent',challenge.id]);
    assert.equal(granted.code,EXIT.NEEDS_APPROVAL,granted.out);
    assert.equal(granted.json.data.id,runId);assert.equal(granted.json.data.status,'awaiting_approval');assert.equal(granted.json.data.pending.tool,'generate_video');
    assert.equal(granted.json.data.visionConsentRequired,undefined);assert.equal(gateway.requests.length,1);

    const heldAgain=await cli(['agent','reject',runId,'--call','video','--exec',granted.json.data.pending.execId]);
    assert.equal(heldAgain.code,EXIT.OK,heldAgain.out);
    const second=await cli(['agent','run','--project',project.json.data.id,'--goal','再次请求图生视频']);
    assert.equal(second.code,EXIT.NEEDS_APPROVAL,second.out);
    const skipped=await cli(['agent','resume',second.json.data.id,'--skip-upload']);
    assert.equal(skipped.code,EXIT.OK,skipped.out);assert.equal(skipped.json.data.id,second.json.data.id);assert.equal(skipped.json.data.status,'complete');
    assert.equal(skipped.json.data.visionConsentRequired,undefined);
    assert.match(gateway.requests.at(-1)?.messages.at(-1).content,/拒绝上传参考图片/);
  }finally{globalThis.fetch=previous;}
}));
