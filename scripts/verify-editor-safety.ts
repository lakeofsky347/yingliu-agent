/** Real Chromium editor regression against isolated local projects and fixture agent replies. No model API is called. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import { startUiServer } from '../src/app/ui-server.ts';
import { findBrowserExecutable } from '../src/host/tool-environment.ts';
import { budgetFrom, emptyUsage } from '../src/agent/budget.ts';
import type { PublicRun } from '../src/agent/contracts.ts';
import type { RpcResult, StudioSnapshot } from '../src/shared/types.ts';

const workspace=resolve('.'),temporary=await mkdtemp(join(tmpdir(),'yingliu-editor-safety-'));
const output=resolve(process.env.YINGLIU_ACCEPTANCE_OUTPUT||join(workspace,'artifacts/acceptance-editor-safety')),ui=join(temporary,'ui');await mkdir(output,{recursive:true});await mkdir(ui);
const checks:string[]=[],pageErrors:string[]=[],agentRequests:{endpoint:string;payload:Record<string,unknown>}[]=[];
let browser:Browser|undefined,application:Awaited<ReturnType<typeof createApplication>>|undefined,server:Awaited<ReturnType<typeof startUiServer>>|undefined;
let failSaves=false,storyReads=0,releaseBudget:(()=>void)|undefined,delayBudget=false;
const pass=(name:string)=>{checks.push(name);process.stdout.write('PASS '+name+'\n');};
function fixture(projectId:string,id:string,status:PublicRun['status']):PublicRun{
  const budget=budgetFrom({}),at=new Date().toISOString();
  return {version:1,id,projectId,goal:id,status,message:'隔离界面测试回执',createdAt:at,updatedAt:at,model:{},budget,usage:emptyUsage(budget.currency),policy:{autoApprove:['read','write']},steps:[],queue:[],approvedCallIds:[],reviewRounds:0,transcript:[],...(status==='awaiting_approval'?{pending:{callId:'call-'+id,execId:'exec-'+id,argsHash:'fixture-hash',tool:'shot_write_source',risk:'write',arguments:'{}',reason:'界面审批验证',estimate:0}}:{})};
}
async function until(check:()=>Promise<boolean>,timeout=15000){const deadline=Date.now()+timeout;while(!await check()){assert.ok(Date.now()<deadline,'等待界面状态超时');await new Promise(resolve=>setTimeout(resolve,50));}}
try{
  await build({entryPoints:[join(workspace,'src/client/index.tsx')],bundle:true,format:'esm',platform:'browser',outfile:join(ui,'app.js'),loader:{'.css':'css'},target:['chrome120'],logLevel:'silent'});await writeFile(join(ui,'index.html'),await readFile(join(workspace,'public/index.html')));
  application=await createApplication({dataDirectory:join(temporary,'data'),credentials:new MemorySecrets()});
  const a=(await application.backend.call<StudioSnapshot>('create',{title:'草稿验收 A'})).project!,b=(await application.backend.call<StudioSnapshot>('create',{title:'草稿验收 B'})).project!;
  await application.agent.saveStory(a.id,{characters:[{id:'a',name:'A 已保存角色',features:[],referenceAssetIds:[]}]},0);
  await application.agent.saveStory(b.id,{characters:[{id:'b',name:'B 已保存角色',features:[],referenceAssetIds:[]}]},0);
  await application.agent.setProjectBudget(a.id,1);await application.agent.setProjectBudget(b.id,2);await application.backend.call('focus',{projectId:a.id});
  const runs=new Map([[a.id,[fixture(a.id,'ui-approval','awaiting_approval'),fixture(a.id,'ui-resume','paused')]],[b.id,[] as PublicRun[]]]);
  const originalRoute=application.route;
  application.route=async(endpoint,payload={}):Promise<RpcResult>=>{
    const data=payload as Record<string,unknown>;
    if(endpoint==='story.get')storyReads++;
    if(endpoint==='save'&&failSaves)return {ok:false,error:{code:'FIXTURE_DISK_FAILURE',message:'隔离测试：保存失败'}};
    if(endpoint==='agent.budget.set'&&delayBudget)await new Promise<void>(resolve=>{releaseBudget=resolve;});
    if(endpoint==='agent.list')return {ok:true,value:{runs:runs.get(String(data.projectId))??[]}};
    if(['agent.start','agent.approve','agent.reject','agent.resume'].includes(endpoint)){
      agentRequests.push({endpoint,payload:structuredClone(data)});
      const created=fixture(String(data.projectId),'ui-complete-'+agentRequests.length,'complete');
      if(endpoint==='agent.start')runs.set(created.projectId,[created,...(runs.get(created.projectId)??[])]);
      return {ok:true,value:created};
    }
    return originalRoute(endpoint,payload);
  };
  server=await startUiServer(application,ui);
  const executablePath=process.env.CHROME_PATH||findBrowserExecutable();assert.ok(executablePath,'缺少 Chrome/Chromium；可设置 CHROME_PATH');
  browser=await chromium.launch({chromiumSandbox:true,executablePath,headless:true,args:['--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1600,height:1200}});page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(server.origin);await page.getByRole('button',{name:'草稿验收 A',exact:true}).click();await page.getByRole('tab',{name:'智能体',exact:true}).click();
  await page.getByLabel('角色名',{exact:true}).fill('A 未保存草稿');await page.getByLabel('项目费用上限',{exact:true}).fill('9');
  const reads=storyReads;await until(async()=>storyReads>reads,10000);
  assert.equal(await page.getByLabel('角色名',{exact:true}).inputValue(),'A 未保存草稿');assert.equal(await page.getByLabel('项目费用上限',{exact:true}).inputValue(),'9');pass('真实轮询后角色与预算输入保留');
  await page.getByRole('tab',{name:'影片预览',exact:true}).click();assert.equal(await page.getByRole('tab',{name:'智能体',exact:true}).getAttribute('aria-selected'),'true');
  await page.getByRole('button',{name:'项目首页',exact:true}).click();assert.equal(await page.locator('.vs-studio').count(),1);
  await page.getByLabel('切换影片工程',{exact:true}).selectOption(b.id);assert.equal(await page.getByLabel('角色名',{exact:true}).inputValue(),'A 未保存草稿');
  const closePrevented=await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;});assert.equal(closePrevented,true);pass('角色和预算草稿阻止切面板、首页、跨工程与浏览器关闭');
  await page.getByRole('button',{name:'批准',exact:true}).click();await page.getByRole('button',{name:'拒绝',exact:true}).click();
  await page.getByRole('button',{name:'已暂停 · ui-resume',exact:true}).click();await page.getByRole('button',{name:'继续',exact:true}).click();
  await page.getByLabel('智能体目标',{exact:true}).fill('本地界面测试');await page.getByRole('button',{name:'开始',exact:true}).click();assert.equal(agentRequests.length,0);pass('未保存草稿阻止开始、批准、拒绝与继续');
  await page.getByRole('button',{name:'放弃角色修改',exact:true}).click();await page.getByRole('button',{name:'放弃预算修改',exact:true}).click();await page.getByLabel('切换影片工程',{exact:true}).selectOption(b.id);
  await until(async()=>(await page.getByLabel('角色名',{exact:true}).inputValue())==='B 已保存角色');assert.equal(await page.getByLabel('项目费用上限',{exact:true}).inputValue(),'2');
  assert.equal((await application.agent.story(a.id)).characters[0]?.name,'A 已保存角色');pass('显式放弃后切工程，A 草稿没有写入 B');
  delayBudget=true;await page.getByLabel('项目费用上限',{exact:true}).fill('7');await page.getByRole('button',{name:'保存上限',exact:true}).click();await until(async()=>!!releaseBudget);
  assert.equal(await page.getByLabel('切换影片工程',{exact:true}).isDisabled(),true);delayBudget=false;releaseBudget!();await until(async()=>!await page.getByLabel('切换影片工程',{exact:true}).isDisabled());assert.equal((await application.agent.ledger(b.id)).maxCost,7);pass('保存预算期间持有工程导航锁，成功后释放');
  failSaves=true;await page.getByLabel('影片标题',{exact:true}).fill('保留失败保存的标题');await page.getByLabel('智能体目标',{exact:true}).fill('保存成功才开始');await page.getByRole('button',{name:'开始',exact:true}).click();assert.equal(agentRequests.length,0);assert.equal(await page.getByLabel('影片标题',{exact:true}).inputValue(),'保留失败保存的标题');pass('工程保存失败阻止智能体启动并保留编辑');
  failSaves=false;await page.getByRole('button',{name:'开始',exact:true}).click();await until(async()=>agentRequests.length===1);
  const saved=await application.backend.call<StudioSnapshot>('current',{projectId:b.id});assert.equal(saved.project?.title,'保留失败保存的标题');assert.equal(agentRequests[0]?.payload.expectedRevision,saved.project?.revision);pass('重新启动先保存工程，并使用确认后的 revision');
  await page.screenshot({path:join(output,'editor-safety.png'),fullPage:true});assert.deepEqual(pageErrors,[]);pass('实际 Chromium 界面无未捕获异常');
}catch(error){await writeFile(join(output,'error.txt'),String(error));throw error;}
finally{
  releaseBudget?.();await browser?.close();await server?.close();await application?.dispose();
  await writeFile(join(output,'report.json'),JSON.stringify({checkedAt:new Date().toISOString(),status:checks.length===8?'PASS':'FAIL',checks,pageErrors,agentRequests:agentRequests.map(request=>request.endpoint),scope:'本机 Chromium + 隔离工程 + 智能体回执 fixture；未调用真实模型/付费服务，不代表供应商或原生桌面验收'},null,2)+'\n');
  await rm(temporary,{recursive:true,force:true});
}
