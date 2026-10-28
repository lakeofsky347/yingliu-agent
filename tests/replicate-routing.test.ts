import test from 'node:test';
import assert from 'node:assert/strict';
import { fillPath, submitTemplate, pollTemplate, cancelTemplate } from '../src/models/adapters/template.ts';
import type { ModelDefinition, ProviderConnection } from '../src/models/contracts.ts';

const connection: ProviderConnection = { id:'replicate', name:'本机协议测试', protocol:'async-task', baseUrl:'http://fixture.invalid/v1', auth:'none', credentialRef:'unused', enabled:true, revision:1, requestTimeoutMs:5000, concurrency:1 };
function model(name:string,preset='replicate'):ModelDefinition { return { id:'fixture', connectionId:connection.id, name:'fixture', model:name, enabled:true, inputModalities:['text'], outputModalities:['image'], parameters:{preset} }; }

test('Replicate 官方模型按 owner/name 两个路径段提交，任务 ID 仍整体编码', async()=>{
  const requests:{url:string;body:unknown}[]=[];
  const context={connection,signal:AbortSignal.timeout(5000),fetch:async(url:URL|RequestInfo,init?:RequestInit)=>{
    requests.push({url:String(url),body:init?.body?JSON.parse(String(init.body)):undefined});
    return Response.json({id:'job/id?x=1',status:requests.length===1?'starting':'canceled'});
  }};
  const m=model('owner-a/model_name.v2');
  const submitted=await submitTemplate(context,{clientRequestId:'local',model:m,prompt:'合成协议测试',parameters:{}},'image');
  assert.equal(requests[0].url,'http://fixture.invalid/v1/models/owner-a/model_name.v2/predictions');
  assert.deepEqual(requests[0].body,{input:{prompt:'合成协议测试'}});
  assert.ok(!('kind' in submitted));
  await pollTemplate(context,m,submitted.jobId,'image');await cancelTemplate(context,m,submitted.jobId);
  assert.equal(requests[1].url,'http://fixture.invalid/v1/predictions/job%2Fid%3Fx%3D1');
  assert.equal(requests[2].url,'http://fixture.invalid/v1/predictions/job%2Fid%3Fx%3D1/cancel');
  assert.equal(fillPath('/custom/{{model}}',{prompt:'',model:'owner/name',clientRequestId:'x',parameters:{}}),'/custom/owner%2Fname');
});

test('Replicate 无效模型或路径注入在发送前失败',async()=>{
  let sent=0;
  const context={connection,signal:AbortSignal.timeout(5000),fetch:async()=>{sent++;return Response.json({id:'unexpected'});}};
  for(const name of ['name','owner/name/extra','../name','owner/..','owner/name?query','owner/name#fragment','owner/a%2Fb','owner\\name/model','owner/name:version']){
    await assert.rejects(submitTemplate(context,{clientRequestId:'x',model:model(name),prompt:'fixture',parameters:{}},'image'),/owner\/name/);
  }
  assert.equal(sent,0);
});

test('Replicate 社区版本使用 predictions 端点并保留 JSON 版本标识',async()=>{
  const version='owner/community:'+ 'a'.repeat(64);let request:{url:string;body:unknown}|undefined;
  const context={connection,signal:AbortSignal.timeout(5000),fetch:async(url:URL|RequestInfo,init?:RequestInit)=>{request={url:String(url),body:JSON.parse(String(init?.body))};return Response.json({id:'version-job',status:'starting'});}};
  await submitTemplate(context,{clientRequestId:'x',model:model(version,'replicate-version'),prompt:'引用版本',parameters:{}},'image');
  assert.deepEqual(request,{url:'http://fixture.invalid/v1/predictions',body:{version,input:{prompt:'引用版本'}}});
});
