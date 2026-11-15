/** Browser acceptance with an isolated local model gateway. No external provider is called. */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import { startUiServer } from '../src/app/ui-server.ts';
import { defaultSceneSource } from '../src/core/index.ts';
import { findBrowserExecutable } from '../src/host/tool-environment.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';
import type { Conversation } from '../src/app/contracts.ts';
import type { WorkflowRecord } from '../src/workflows/contracts.ts';

const workspace=resolve('.'),temporary=await mkdtemp(join(tmpdir(),'yingliu-model-ui-')),output=resolve(process.env.YINGLIU_ACCEPTANCE_OUTPUT||join(workspace,'artifacts/acceptance-multimodal'));await mkdir(output,{recursive:true});
const png=join(temporary,'sample.png'),video=join(temporary,'sample.mp4'),ui=join(temporary,'ui');await mkdir(ui);
for(const args of [ ['-v','error','-f','lavfi','-i','color=c=blue:s=64x64','-frames:v','1','-threads','1','-y',png], ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-f','lavfi','-i','sine=frequency=330:sample_rate=48000','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-threads','1','-y',video] ]){const result=spawnSync('ffmpeg',args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
const pngBytes=await readFile(png),videoBytes=await readFile(video);let imageRequests=0,textRequests=0,visionRequests=0,videoRequests=0,templateRequests=0,origin='';
const remoteJobs=new Map<string,{id:string;clientRequestId:string}>();
const gateway=createServer(async(req,res)=>{try{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'local-text'},{id:'local-image'},{id:'local-video'}]}));return;}
  if(req.url==='/result.mp4'){res.setHeader('Content-Type','video/mp4');res.end(videoBytes);return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
  if(req.url==='/v1/images/generations'){imageRequests++;res.end(JSON.stringify({data:[{b64_json:pngBytes.toString('base64')}],usage:{cost:0,currency:'USD'}}));return;}
  if(req.url==='/template/tasks'&&req.method==='POST'){
    templateRequests++;assert.equal(body.prompt,'通过本地模板生成测试素材');
    res.setHeader('Content-Type','image/png');res.end(pngBytes);return;
  }
  if(req.url==='/vision/models'){res.end(JSON.stringify({data:[{id:'local-vision'}]}));return;}
  if(req.url==='/vision/chat/completions'){
    visionRequests++;
    assert.equal(body.model,'local-vision');
    assert.equal(req.headers.authorization,'Bearer local-vision-test');
    const images=body.messages.flatMap((message:{content:unknown})=>Array.isArray(message.content)?message.content.filter(part=>part.type==='image_url'):[]);
    assert.equal(images.length,1);
    assert.match(images[0].image_url.url,/^data:image\/png;base64,/);
    res.end(JSON.stringify({choices:[{message:{content:'已检查本地验收关键帧。'},finish_reason:'stop'}]}));return;
  }
  if(req.url==='/v1/chat/completions'){textRequests++;assert.equal(body.model,'local-text');assert.ok(body.messages.every((message:{content:unknown})=>typeof message.content==='string'));const input:string=body.messages.at(-1).content;const context=JSON.parse(input.replace(/^当前上下文：/,''));let answer:unknown;
    if(context.shots)answer={shots:context.shots.length?context.shots.map((shot:{id:string})=>({shotId:shot.id,prompt:'本地验收镜头画面',narration:'本地测试旁白'})):[{title:'协作验收镜头',intent:'测试工作流',durationSeconds:2,params:{text:'本地验收'},prompt:'测试画面',narration:''}]};
    else if(context.contract)answer=defaultSceneSource();
    else if(context.requestedIntent==='discuss'){
      assert.equal(context.imageEvidence.pixelsSent,false);
      if(context.request==='请讨论本次附上的参考图'){
        assert.equal(context.imageEvidence.sentAssetIds.length,1);
        assert.match(context.imageEvidence.observations,/本地验收关键帧/);
      }else assert.equal(context.imageEvidence.sentAssetIds.length,0);
      answer={intent:'discuss',message:'这是一条本地验收讨论回执。',done:true,actions:[]};
    }else answer='已检查提供的实际关键帧；这是本地测试回执。';
    res.end(JSON.stringify({choices:[{message:{content:typeof answer==='string'?answer:JSON.stringify(answer)},finish_reason:'stop'}]}));return;
  }
  if(req.url==='/v1/media/jobs'&&req.method==='POST'){videoRequests++;let job=remoteJobs.get(body.clientRequestId);if(!job){job={id:'local-job-'+remoteJobs.size,clientRequestId:body.clientRequestId};remoteJobs.set(body.clientRequestId,job);}res.end(JSON.stringify({jobId:job.id,status:'queued',progress:0}));return;}
  if(req.url?.startsWith('/v1/media/jobs')){const url=new URL(req.url,origin),id=url.searchParams.get('clientRequestId');const job=id?remoteJobs.get(id):[...remoteJobs.values()].find(value=>url.pathname.endsWith('/'+value.id));if(!job){res.writeHead(404);res.end('{}');return;}res.end(JSON.stringify({jobId:job.id,status:'succeeded',progress:1,artifacts:[{url:origin+'/result.mp4',mimeType:'video/mp4'}],usage:{cost:0,currency:'USD'}}));return;}
  res.writeHead(404);res.end('{}');
}catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}});
await new Promise<void>(accept=>gateway.listen(0,'127.0.0.1',accept));origin='http://127.0.0.1:'+(gateway.address() as {port:number}).port;
const checks:string[]=[],pageErrors:string[]=[];let status:'PASS'|'FAIL'='FAIL';let browser:Browser|undefined,application:Awaited<ReturnType<typeof createApplication>>|undefined,server:Awaited<ReturnType<typeof startUiServer>>|undefined;
const pass=(name:string)=>{checks.push(name);process.stdout.write('PASS '+name+'\n');};
async function until(check:()=>Promise<boolean>,timeout=45000){const end=Date.now()+timeout;while(!await check()){if(Date.now()>end)throw new Error('等待界面状态超时');await new Promise(accept=>setTimeout(accept,150));}}
try{
  await build({entryPoints:[join(workspace,'src/client/index.tsx')],bundle:true,format:'esm',platform:'browser',outfile:join(ui,'app.js'),loader:{'.css':'css'},target:['chrome120'],logLevel:'silent'});await writeFile(join(ui,'index.html'),await readFile(join(workspace,'public/index.html')));
  application=await createApplication({dataDirectory:join(temporary,'data'),credentials:new MemorySecrets()});server=await startUiServer(application,ui);
  const executablePath=process.env.CHROME_PATH||findBrowserExecutable();assert.ok(executablePath,'缺少 Chrome/Chromium，可设置 CHROME_PATH');
  browser=await chromium.launch({chromiumSandbox:true,executablePath,headless:true,args:['--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>pageErrors.push(error.message));await page.goto(server.origin);await page.getByRole('heading',{name:'我的影片',exact:false}).waitFor();
  const guide=page.getByRole('dialog',{name:'开始使用映流智能体'}),modelDialog=page.getByRole('dialog',{name:'模型与 API 接入'});
  await guide.getByRole('button',{name:'配置文本模型',exact:true}).click();
  await modelDialog.getByLabel('API Base URL',{exact:true}).waitFor();
  assert.equal(await modelDialog.getByLabel('API Base URL',{exact:true}).inputValue(),'https://api.openai.com/v1');
  await modelDialog.getByRole('button',{name:'关闭模型设置',exact:true}).press('Escape');
  await guide.getByRole('button',{name:'配置多模态模型',exact:true}).click();
  assert.equal(await modelDialog.getByRole('button',{name:'多模态模型',exact:true}).getAttribute('aria-pressed'),'true');
  await modelDialog.getByRole('button',{name:'关闭模型设置',exact:true}).click();
  await guide.waitFor();
  await page.keyboard.press('Escape');
  await guide.waitFor({state:'hidden'});
  await until(async()=>{const result=await application!.route('app.onboarding.get');return result.ok&&(result.value as {completed:boolean}).completed;});
  await page.reload();
  await page.getByRole('heading',{name:'我的影片',exact:false}).waitFor();
  await page.getByRole('button',{name:'模型设置',exact:true}).click();
  await modelDialog.getByRole('button',{name:'关闭模型设置',exact:true}).click();
  await page.getByRole('button',{name:'新手引导',exact:true}).click();
  await guide.getByRole('button',{name:'稍后再看',exact:true}).click();
  assert.equal(textRequests+imageRequests+videoRequests,0);
  pass('首次启动引导分别打开文本和多模态设置，跳过状态持久保存并可从标题栏重开');
  await page.getByRole('button',{name:'模型设置',exact:true}).click();
  await modelDialog.getByRole('button',{name:'高级模型中心',exact:true}).click();
  async function connection(name:string,protocol:string,model:string,role:string){
    const center=page.getByRole('dialog').getByRole('region',{name:'模型中心'});await center.getByRole('button',{name:'新增连接',exact:true}).click();await center.getByLabel('连接名称',{exact:true}).fill(name);await center.getByLabel('接口协议',{exact:true}).selectOption(protocol);await center.getByLabel('模型连接地址',{exact:true}).fill(origin+'/v1');await center.getByLabel('模型认证方式',{exact:true}).selectOption('none');await center.getByRole('button',{name:'保存连接',exact:true}).click();await center.getByLabel('服务端模型 ID',{exact:true}).waitFor();await center.getByLabel('服务端模型 ID',{exact:true}).fill(model);await center.getByLabel('模型显示名称',{exact:true}).fill(name+'模型');await center.getByRole('button',{name:'保存模型',exact:true}).click();await until(async()=>{const registry=await application!.providers.registry.list();return registry.models.some(value=>value.model===model);});const definition=(await application!.providers.registry.list()).models.find(value=>value.model===model)!;await center.getByLabel(role+'模型',{exact:true}).selectOption(definition.id);await until(async()=>{const registry=await application!.providers.registry.list();return registry.roles.some(value=>value.modelId===definition.id);});return definition.id;
  }
  const textId=await connection('本地验收文本','chat-completions','local-text','导演与讨论');await page.getByRole('dialog').getByLabel('场景代码模型',{exact:true}).selectOption(textId);
  await connection('本地验收图片','images','local-image','图片生成');await connection('本地验收视频','video-gateway','local-video','视频生成');
  const center=page.getByRole('dialog').getByRole('region',{name:'模型中心'}),textDefinition=(await application.providers.registry.list()).models.find(model=>model.id===textId)!;
  await center.getByLabel('已保存的模型连接',{exact:true}).selectOption(textDefinition.connectionId);await center.getByLabel('编辑已保存模型',{exact:true}).selectOption(textId);
  await center.getByText('文本费用情景试算',{exact:true}).click();const estimate=center.locator('details').filter({hasText:'文本费用情景试算'}),estimateStatus=estimate.getByRole('status');
  assert.match(await estimateStatus.textContent()??'',/费用未知/);pass('文本费用情景未填单价时明确显示未知');
  await estimate.getByLabel('每百万输入 token 单价',{exact:true}).fill('2');await estimate.getByLabel('每百万输出 token 单价',{exact:true}).fill('8');
  await estimate.getByLabel('试算输入 token',{exact:true}).fill('10000');await estimate.getByLabel('试算输出 token',{exact:true}).fill('2000');await estimate.getByLabel('试算轮数',{exact:true}).fill('3');
  assert.match(await estimateStatus.textContent()??'',/0\.108000 CNY/);await estimate.getByLabel('试算输入 token',{exact:true}).fill('0.5');assert.match(await estimateStatus.textContent()??'',/费用未知.*安全整数/);pass('文本情景计算 0.108000 CNY，非整数 token 保持未知');
  await estimate.getByLabel('试算输入 token',{exact:true}).fill('10000');await estimate.getByLabel('单价币种',{exact:true}).selectOption('USD');assert.match(await estimateStatus.textContent()??'',/0\.108000 USD/);assert.match(await estimate.textContent()??'',/不自动换汇/);
  const priceSource='合成账户价格页，2026-10-28';await estimate.getByLabel('价格来源与核对日期',{exact:true}).fill(priceSource);await center.getByRole('button',{name:'保存模型',exact:true}).click();
  await until(async()=>{const saved=(await application!.providers.registry.list()).models.find(model=>model.id===textId);return saved?.parameters.priceSource===priceSource&&saved.parameters.priceCurrency==='USD';});
  assert.equal(textRequests+imageRequests+videoRequests,0);pass('单价币种与来源通过真实表单保存，试算不生成请求也不自动换汇');
  assert.equal((await application.providers.registry.list()).connections.filter(value=>value.baseUrl===origin+'/v1').length,3);assert.equal(textRequests+imageRequests+videoRequests,0);assert.equal(await page.getByRole('dialog').evaluate(element=>element.scrollWidth>element.clientWidth+2),false);assert.equal(await page.getByRole('dialog').evaluate(element=>{const rect=element.getBoundingClientRect();return [...element.querySelectorAll('input,select,textarea,button')].filter(value=>value.getClientRects().length).some(value=>{const box=value.getBoundingClientRect();return box.left<rect.left-1||box.right>rect.right+1;});}),false);pass('模型中心通过真实表单保存三类连接、模型与角色，配置不触发生成');await page.screenshot({path:join(output,'model-center.png'),fullPage:true});await page.getByRole('button',{name:'关闭模型设置',exact:true}).click();
  await page.getByRole('button',{name:'新手引导',exact:true}).click();await guide.getByRole('button',{name:'开始新建影片',exact:true}).click();await page.getByLabel('影片名称',{exact:true}).fill('多模态界面验收');await page.getByLabel('主题与创作简报',{exact:true}).fill('本地测试网关与实际媒体的界面操作验收');await page.getByRole('button',{name:'创建空白影片',exact:true}).click();await page.locator('.vs-studio').waitFor();await page.getByTitle('添加镜头',{exact:true}).click();
  await until(async()=>{const value=await application!.backend.call<StudioSnapshot>('current');return !!value.project?.shots.length;});
  await page.getByRole('tab',{name:'模型与素材生成',exact:true}).click();await page.getByLabel('素材画面描述',{exact:true}).fill('蓝色方块测试图');await page.getByRole('button',{name:'开始生成素材',exact:true}).click();await page.getByRole('button',{name:'采用结果',exact:true}).waitFor({timeout:45000});await page.getByRole('button',{name:'采用结果',exact:true}).click();await until(async()=>{const value=await application!.backend.call<StudioSnapshot>('current');return value.project?.assets.some(asset=>asset.kind==='image')===true;});assert.equal(imageRequests,1);pass('图片生成、任务轮询与采用通过真实界面完成');
  await page.getByText('从本地路径导入视频',{exact:true}).click();await page.getByLabel('本地视频文件路径',{exact:true}).fill(video);await page.getByRole('button',{name:'导入本地视频',exact:true}).click();await until(async()=>{const value=await application!.backend.call<StudioSnapshot>('current');return value.project?.assets.some(asset=>asset.kind==='video')===true;});
  const snapshot=await application.backend.call<StudioSnapshot>('current'),asset=snapshot.project!.assets.find(value=>value.kind==='video')!,shot=snapshot.project!.shots[0]!;
  await page.locator('.vs-shotchip').first().click();await page.getByText('视频片段',{exact:true}).click();await page.getByLabel('镜头主视频',{exact:true}).selectOption(asset.id);await page.getByLabel('视频裁入',{exact:true}).fill('0.25');await page.getByLabel('视频裁出',{exact:true}).fill('1.75');await page.getByRole('button',{name:'保存视频片段',exact:true}).click();await until(async()=>{const value=await application!.backend.call<StudioSnapshot>('current');return value.project?.videoClips?.[0]?.trimStart===.25;});pass('本地视频路径导入与镜头裁剪绑定通过真实表单完成');
  await page.getByRole('tab',{name:'模型与素材生成',exact:true}).click();await page.getByLabel('媒体生成方式',{exact:true}).selectOption('text-to-video');await page.getByLabel('素材画面描述',{exact:true}).fill('生成一个本地验收视频');await page.getByRole('button',{name:'开始生成素材',exact:true}).click();await page.getByRole('button',{name:'采用结果',exact:true}).waitFor({timeout:45000});await page.getByRole('button',{name:'采用结果',exact:true}).click();await until(async()=>{const tasks=await application!.media.list(snapshot.project!.id);return tasks.some(task=>task.operation==='text-to-video'&&task.phase==='complete');});assert.equal(videoRequests,1);pass('异步视频网关生成与采用通过真实界面完成');await page.screenshot({path:join(output,'media-generation.png'),fullPage:true});
  await page.getByRole('tab',{name:'协作制作',exact:true}).click();
  const review=page.getByRole('checkbox',{name:'使用视觉模型检查关键帧'});
  assert.equal(await review.isDisabled(),true);
  assert.equal(await page.getByRole('group',{name:/视频生成参考图/}).count(),0);
  await page.getByRole('button',{name:'配置视觉理解模型',exact:true}).click();
  await modelDialog.getByRole('form',{name:'多模态模型设置',exact:true}).waitFor();
  assert.equal(await modelDialog.getByLabel('API Base URL',{exact:true}).inputValue(),'https://api.openai.com/v1');
  await modelDialog.getByLabel('接口名称',{exact:true}).fill('本地验收视觉');
  await modelDialog.getByLabel('API Base URL',{exact:true}).fill(origin+'/vision');
  await modelDialog.getByLabel('模型 ID',{exact:true}).fill('local-vision');
  await modelDialog.getByLabel('API Key',{exact:true}).fill('local-vision-test');
  await modelDialog.getByRole('button',{name:'保存设置',exact:true}).click();
  await modelDialog.getByText('多模态模型设置已保存。',{exact:true}).waitFor();
  await modelDialog.getByRole('button',{name:'关闭模型设置',exact:true}).click();
  await until(()=>review.isEnabled());
  await page.getByLabel('协作制作要求',{exact:true}).fill('保留当前镜头，完善可编辑的代码画面');
  await review.check();
  const startWorkflow=page.getByRole('button',{name:'开始协作制作',exact:true});
  assert.equal(await startWorkflow.isDisabled(),true);
  await page.getByRole('checkbox',{name:'允许本次向视觉模型发送实际关键帧'}).check();
  await startWorkflow.click();
  await until(async()=>{
    const result=await application!.route('workflows.list',{projectId:snapshot.project!.id});
    const workflow=result.ok?(result.value as {workflows:WorkflowRecord[]}).workflows[0]:undefined;
    if(workflow?.status==='failed')throw new Error(workflow.error);
    return workflow?.status==='complete'&&workflow.steps.some(step=>step.kind==='review'&&step.frameEvidence?.length===1);
  },60000);
  await page.locator('[data-workflow-id]').getByText('已完成',{exact:true}).waitFor();
  assert.ok(textRequests>=2);
  assert.equal(visionRequests,1);
  pass('协作制作按独立授权发送关键帧，导演与场景接口只接收文本');
  await page.screenshot({path:join(output,'workflow.png'),fullPage:true});
  const chat=page.getByRole('complementary',{name:'创作对话'});
  await chat.getByText('本次参考图',{exact:true}).click();
  const permission=chat.getByRole('checkbox',{name:'允许视觉模型处理本次选择的图片'});
  await permission.check();
  const reference=chat.locator('.yl-image-context input[type=checkbox]').nth(1);
  await reference.check();
  async function discuss(message:string){
    await chat.getByLabel('创作指令',{exact:true}).fill(message);
    await chat.getByRole('button',{name:'发送',exact:true}).click();
    await until(async()=>{
      const result=await application!.route('chat.history',{projectId:snapshot.project!.id});
      const turn=result.ok?(result.value as Conversation).turns?.at(-1):undefined;
      if(turn?.request.message!==message)return false;
      if(turn.status==='failed')throw new Error(turn.error);
      return turn.status==='succeeded';
    });
  }
  await discuss('请讨论本次附上的参考图');
  assert.equal(visionRequests,2);
  assert.equal(await permission.isChecked(),false);
  assert.equal(await reference.count(),0);
  await discuss('再谈一谈影片节奏');
  assert.equal(visionRequests,2);
  pass('创作对话仅向视觉接口发送本次授权的参考图，并在下一轮前清除授权');
  await page.getByRole('tab',{name:'模型与素材生成',exact:true}).click();
  const templateConnection=await application.providers.registry.saveConnection({name:'本地模板',protocol:'async-task',baseUrl:origin+'/template',auth:'none'});
  const templateModel=await application.providers.registry.saveModel({connectionId:templateConnection.id,model:'local-template',outputModalities:['image'],parameters:{responseType:'binary',resultMime:'image/png'}});
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('yingliu-models-changed')));
  await page.getByLabel('媒体生成方式',{exact:true}).selectOption('text-to-image');
  await page.getByLabel('素材生成模型',{exact:true}).selectOption(templateModel.id);
  await page.getByLabel('素材画面描述',{exact:true}).fill('通过本地模板生成测试素材');
  await page.getByRole('button',{name:'开始生成素材',exact:true}).click();
  const templateTask=page.locator('[data-media-task-id]').filter({hasText:'通过本地模板生成测试素材'});
  await templateTask.getByRole('button',{name:'采用结果',exact:true}).click({timeout:45000});
  await until(async()=>{const tasks=await application!.media.list(snapshot.project!.id);return tasks.some(task=>task.model.id===templateModel.id&&task.phase==='complete');});
  assert.equal(templateRequests,1);
  pass('素材面板热更新模板模型，提交并采用隔离服务返回的图片');
  await page.getByRole('tab',{name:'运行环境',exact:true}).click();await page.getByLabel('视频文件上限（MiB）',{exact:true}).fill('16');await page.getByRole('button',{name:'保存并检查环境',exact:true}).click();await until(async()=>{const value=await application!.backend.call<StudioSnapshot>('current');return value.environment.maxVideoBytes===16*1024*1024;});pass('运行环境视频文件限额通过界面保存并回读');
  await page.setViewportSize({width:1180,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2),false);pass('紧凑窗口无页面横向溢出');assert.deepEqual(pageErrors,[]);pass('模型与媒体界面无浏览器未捕获异常');status='PASS';
}catch(error){await writeFile(join(output,'ui-error.txt'),String(error));throw error;}
finally{await browser?.close().catch(()=>{});await server?.close();await application?.dispose();await new Promise<void>(accept=>gateway.close(()=>accept()));await writeFile(join(output,'ui-verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),status,platform:process.platform,architecture:process.arch,checks,pageErrors,requests:{text:textRequests,vision:visionRequests,image:imageRequests,video:videoRequests},gateway:'isolated localhost fixture',realProvider:'NOT_CHECKED'},null,2)+'\n');await rm(temporary,{recursive:true,force:true});}
