/** Execute real platform acceptance with local fixtures. This script installs nothing and never contacts a model API. */
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {packageLayout} from './package-layout.mjs';
import {probeBrowserVersion} from './acceptance-browser.mjs';
import {stageEnvironment} from './acceptance-environment.mjs';
import {failureCategory,platformSummary,safeLabel,summarizePhase} from './acceptance-summary.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),layout=packageLayout(root);
const args=process.argv.slice(2),options={bundle:layout.destination,summary:join(root,'artifacts/platform-acceptance',`${process.platform}-${process.arch}.json`)};
for(let i=0;i<args.length;i++){if(args[i]==='--help'){console.log('node scripts/run-platform-acceptance.mjs [--bundle PATH] [--summary PATH]\n需要已构建的本机包、真实 Chrome/FFmpeg/ffprobe，以及可运行 Electron 的桌面会话和系统钥匙环。仅运行本地协议 fixture；失败或未检查不会算作通过。');process.exit(0);}const key=args[i]?.slice(2);if(!['bundle','summary'].includes(key)||!args[i+1])throw new Error('未知参数或缺少参数');options[key]=resolve(args[++i]);}
const temporary=await mkdtemp(join(tmpdir(),'yingliu-platform-')),scratch=join(temporary,'scratch');await mkdir(scratch);
const env={...process.env,TMPDIR:scratch,TMP:scratch,TEMP:scratch};delete env.ELECTRON_RUN_AS_NODE;
const phases=[],manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const metadata={applicationVersion:manifest.version,commit:spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout?.trim(),platform:process.platform,architecture:process.arch,node:process.versions.node,workingTreeDirty:!!spawnSync('git',['status','--porcelain=v1','--untracked-files=normal'],{cwd:root,encoding:'utf8'}).stdout?.trim()};
async function run(phase,script,args=[],extraEnv={},timeoutMs=12*60*1000){
  const started=Date.now(),phaseEnv=stageEnvironment(temporary,phase,{...env,...extraEnv}),phaseOutput=phaseEnv.YINGLIU_ACCEPTANCE_OUTPUT;await mkdir(phaseOutput,{recursive:true});
  console.log('RUN '+phase);
  const child=spawn(process.execPath,[...(script.endsWith('.ts')?['--import','tsx']:[]),join(root,'scripts',script),...args],{cwd:root,env:phaseEnv,stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
  const log=join(phaseOutput,'command.log');let captured='',timedOut=false;
  const capture=chunk=>{captured=(captured+chunk).slice(-2_000_000);};child.stdout.on('data',capture);child.stderr.on('data',capture);
  const stop=()=>{if(!child.pid)return;if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
  const exitCode=await new Promise(accept=>{const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);child.once('error',()=>{clearTimeout(timer);accept(null);});child.once('close',code=>{clearTimeout(timer);accept(code);});});
  await writeFile(log,captured);const execution={exitCode,timedOut,elapsedMs:Date.now()-started,diagnosticCategory:failureCategory(captured)};
  const reportFile=phase==='package'?'package-verification.json':phase==='native'?'verification.json':phase==='models'?'ui-verification.json':'report.json';
  let report;try{report=JSON.parse(await readFile(join(phaseOutput,reportFile),'utf8'));}catch{/* Missing/invalid reports are explicit failures. */}
  try{const progress=JSON.parse(await readFile(join(phaseOutput,'progress.json'),'utf8'));if(typeof progress.location==='string')execution.location=progress.location;}catch{/* A missing diagnostic never upgrades a failed phase. */}
  const summary=summarizePhase(phase,execution,report);phases.push(summary);console.log(`${summary.status} ${phase}${summary.failureCode?' '+summary.failureCode:''}`);
  return summary;
}
try{
  const {findBrowserExecutable,findToolExecutable}=await import('../src/host/tool-environment.ts');
  const browser=env.CHROME_PATH||findBrowserExecutable?.()||'';
  const tools={browser,ffmpeg:findToolExecutable?.('ffmpeg')||'ffmpeg',ffprobe:findToolExecutable?.('ffprobe')||'ffprobe'};
  const checks=[];let ready=true;
  for(const [name,executable]of Object.entries(tools)){
    if(name==='browser'){
      const probe=await probeBrowserVersion(executable,{env});checks.push({name:'browser executable',status:probe.status,...(probe.diagnosticCategory?{diagnosticCategory:probe.diagnosticCategory}:{})});
      if(probe.status==='PASS')metadata.browser=probe.version;else ready=false;
    }else{
      const probe=spawnSync(executable,['-version'],{env,encoding:'utf8',timeout:15000,windowsHide:true});
      const passed=probe.status===0;checks.push({name:`${name} executable`,status:passed?'PASS':'FAIL',...(!passed?{diagnosticCategory:'EXECUTABLE_MISSING'}:{})});if(passed)metadata[name]=(probe.stdout||probe.stderr).split(/\r?\n/)[0];else ready=false;
    }
  }
  const display=process.platform!=='linux'||!!env.DISPLAY||!!env.WAYLAND_DISPLAY;checks.push({name:'native display session',status:display?'PASS':'FAIL'});ready&&=display;
  const bundleExists=existsSync(join(options.bundle,layout.executableRelative));checks.push({name:'host application bundle',status:bundleExists?'PASS':'FAIL'});ready&&=bundleExists;
  phases.push({phase:'preflight',status:ready?'PASS':'FAIL',checks,...(!ready?{failureCode:'ENVIRONMENT_MISSING'}:{})});
  if(!ready)throw new Error('Preflight failed');
  env.CHROME_PATH=browser;
  const relocated=join(temporary,'relocated',layout.name);await cp(options.bundle,relocated,{recursive:true,verbatimSymlinks:true});
  await run('package','verify-package.mjs',['--bundle',relocated]);
  await run('native','verify-app.ts',[],{YINGLIU_VERIFY_EXECUTABLE:join(relocated,layout.executableRelative),YINGLIU_VERIFY_DATA_DIR:join(temporary,'native-data')});
  await run('models','verify-model-ui.ts');await run('film','verify-multimodal-film.ts');await run('editor','verify-editor-safety.ts');
}catch(error){if(!phases.some(phase=>phase.status==='FAIL')){const phase=['preflight','package','native','models','film','editor'].find(name=>!phases.some(value=>value.phase===name));if(phase)phases.push({phase,status:'FAIL',failureCode:'PREPARATION_FAILED',checks:[]});}console.error('Platform acceptance stopped: '+safeLabel(error instanceof Error?error.message:'execution failed'));process.exitCode=1;}
finally{
  try{await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});metadata.cleanupStatus='PASS';}catch{metadata.cleanupStatus='FAIL';process.exitCode=1;}
  const summary=platformSummary(metadata,phases);if(summary.status!=='PASS')process.exitCode=1;
  await mkdir(dirname(options.summary),{recursive:true});await writeFile(options.summary,JSON.stringify(summary,null,2)+'\n');
  console.log(summary.status+' platform acceptance; summary '+safeLabel(options.summary));
}
