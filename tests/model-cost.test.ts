import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredTokenCost, estimateTokenScenario } from '../src/shared/model-cost.ts';
import { tokenCost } from '../src/agent/budget.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelCostEstimate } from '../src/client/ModelCostEstimate.tsx';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentService } from '../src/agent/service.ts';
import type { AgentPort } from '../src/agent/contracts.ts';
import { createProject } from '../src/core/index.ts';
import { toolGateway } from './model-gateway.ts';

test('缺失、空白、null、布尔或非法单价保留未知，显式零单价有效',()=>{
  for(const value of [undefined,null,'','  ',false,true,-1,'bad',Infinity,{},[]])assert.equal(configuredTokenCost({pricePerMInput:value,pricePerMOutput:2},1000,1000),null);
  assert.equal(tokenCost({pricePerMInput:0,pricePerMOutput:'0'},1000,1000),0);
});
test('情景试算按单价、token 和轮数计算，并拒绝非法数量与溢出',()=>{
  const parameters={pricePerMInput:2,pricePerMOutput:8};
  assert.equal(estimateTokenScenario(parameters,10000,2000,3).cost,0.108);
  for(const counts of [[-1,1,1],[1.5,1,1],[0.5,0.5,2],[1,1,0],[1,1,201],[NaN,1,1],[Number.MAX_SAFE_INTEGER,1,2]])assert.equal(estimateTokenScenario(parameters,...counts as [number,number,number]).cost,null);
  assert.equal(configuredTokenCost({pricePerMInput:1e308,pricePerMOutput:1},100,1),null);
});
test('报价币种不等于账本币种时不混算，不自动换汇',()=>{
  const parameters={pricePerMInput:2,pricePerMOutput:8,priceCurrency:'USD'};
  assert.equal(tokenCost(parameters,1000,1000,'CNY'),null);
  assert.equal(tokenCost(parameters,1000,1000,'USD'),0.01);
  assert.equal(estimateTokenScenario(parameters,1000,1000,1).currency,'USD');
  assert.equal(estimateTokenScenario({...parameters,priceCurrency:'us$'},1000,1000,1).cost,null);
});
test('费用面板明确来源与未知范围，不发模型请求或批准费用',()=>{
  const html=renderToStaticMarkup(createElement(ModelCostEstimate,{parameters:'{}',onChange:()=>{throw new Error('渲染不能保存配置');}}));
  assert.match(html,/费用未知/);assert.match(html,/价格来源与核对日期/);assert.match(html,/不会自动批准/);
  for(const parameters of ['null','[]','broken'])assert.match(renderToStaticMarkup(createElement(ModelCostEstimate,{parameters,onChange:()=>{}})),/修正模型参数/);
});

for(const scenario of [
  {name:'缺单价',parameters:{},currency:'CNY',unknown:1},
  {name:'币种不一致',parameters:{pricePerMInput:1,pricePerMOutput:2,priceCurrency:'USD'},currency:'CNY',unknown:1},
  {name:'显式零单价',parameters:{pricePerMInput:0,pricePerMOutput:0},currency:'CNY',unknown:0},
  {name:'匹配美元单价',parameters:{pricePerMInput:1,pricePerMOutput:2,priceCurrency:'USD'},currency:'USD',unknown:0},
])test(`模型用量和项目账本保持费用语义：${scenario.name}`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-cost-ledger-')),project=createProject('隔离费用回归');
  const gateway=toolGateway(()=>({text:'完成'}));
  const service=new AgentService(directory,{snapshot:async()=>({project,task:null})} as unknown as AgentPort,{fetch:gateway.fetch,resolveModel:async()=>({config:{baseUrl:'http://gateway.test/v1',model:'mock',timeoutMs:5000,maxTokens:1000,supportsTools:true},parameters:scenario.parameters,vision:false})});
  try{
    await service.setProjectBudget(project.id,null,scenario.currency);
    const started=await service.start({projectId:project.id,goal:'计算配置价格',budget:{currency:scenario.currency}});
    let run=await service.get(started.id);
    for(let i=0;i<500&&!['complete','failed'].includes(run.status);i++){await new Promise(resolve=>setTimeout(resolve,10));run=await service.get(started.id);}
    assert.equal(run.status,'complete');const ledger=await service.ledger(project.id);
    assert.equal(run.usage.unknownCostCalls,scenario.unknown);assert.equal(ledger.unknownCostCalls,scenario.unknown);
    assert.equal(ledger.byTool.director.calls,1);assert.equal(ledger.spent,run.usage.cost);assert.equal(gateway.requests.length,1);
    if(ledger.spent>0||ledger.unknownCostCalls>0){await assert.rejects(service.setProjectBudget(project.id,null,scenario.currency==='CNY'?'USD':'CNY'),/不能直接更改/);assert.equal((await service.ledger(project.id)).currency,scenario.currency);}
    assert.throws(()=>service.setProjectBudget(project.id,null,'usd'),/三个大写字母/);
  }finally{await service.dispose();await rm(directory,{recursive:true,force:true});}
});

test('供应商缺失或非法 usage 不记为已知零费用',async()=>{
  for(const usage of [undefined,{prompt_tokens:100},{prompt_tokens:-1,completion_tokens:2},{prompt_tokens:'100',completion_tokens:2},{prompt_tokens:1.5,completion_tokens:2}]){
    const directory=await mkdtemp(join(tmpdir(),'yingliu-usage-unknown-')),project=createProject('未报告用量');
    const service=new AgentService(directory,{snapshot:async()=>({project,task:null})} as unknown as AgentPort,{fetch:async()=>Response.json({choices:[{message:{content:'完成'},finish_reason:'stop'}],...(usage===undefined?{}:{usage})}),resolveModel:async()=>({config:{baseUrl:'http://fixture.invalid/v1',model:'mock',timeoutMs:5000,maxTokens:1000,supportsTools:true},parameters:{pricePerMInput:2,pricePerMOutput:8},vision:false})});
    try{
      const started=await service.start({projectId:project.id,goal:'保持未知费用'});let run=await service.get(started.id);
      for(let i=0;i<500&&!['complete','failed'].includes(run.status);i++){await new Promise(resolve=>setTimeout(resolve,10));run=await service.get(started.id);}
      assert.equal(run.status,'complete');assert.equal(run.usage.unknownCostCalls,1);assert.equal((await service.ledger(project.id)).unknownCostCalls,1);assert.ok(Number.isFinite(run.usage.inputTokens));
    }finally{await service.dispose();await rm(directory,{recursive:true,force:true});}
  }
});
