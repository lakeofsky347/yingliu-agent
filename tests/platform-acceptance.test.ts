import assert from 'node:assert/strict';
import test from 'node:test';
import { failureCategory, platformSummary, safeLabel, summarizePhase } from '../scripts/acceptance-summary.mjs';

const execution={exitCode:0,elapsedMs:100};
test('acceptance summaries never convert a missing, partial or skipped report into a pass',()=>{
  assert.equal(summarizePhase('film',execution,undefined).status,'FAIL');
  assert.equal(summarizePhase('film',execution,{status:'PASS',checks:[]}).status,'FAIL');
  assert.equal(summarizePhase('package',execution,{status:'PASS',guiVerified:false,checks:[{name:'layout',status:'PASS'}]}).status,'FAIL');
  assert.equal(summarizePhase('native',execution,{nativeAcceptance:'PARTIAL',checks:[{name:'window',status:'PASS'}]}).status,'FAIL');
  assert.equal(summarizePhase('film',{exitCode:1},{status:'PASS',checks:[{name:'encode',status:'PASS'}]}).status,'FAIL');
  assert.equal(summarizePhase('film',{exitCode:0,timedOut:true},{status:'PASS',checks:[{name:'encode',status:'PASS'}]}).failureCode,'TIMEOUT');
  assert.equal(summarizePhase('film',undefined,undefined).status,'NOT_CHECKED');
});

test('summary extraction drops raw data, URLs, paths, credentials and nested check details',()=>{
  const report={status:'PASS',checks:[{name:'encode /Users/example/private.mp4 Bearer: sk-sensitive-key',status:'PASS',details:{apiKey:'do-not-upload'}}],credentials:{secret:'do-not-upload'},path:'C:\\private\\data',message:'sk-sensitive-key',requests:[{url:'https://example.com?token=private'}]};
  const phase=summarizePhase('film',execution,report),summary=platformSummary({applicationVersion:'0.5.0',platform:'linux',architecture:'x64',node:'22.18.0',commit:'a'.repeat(40),apiKey:'do-not-upload'},[phase]);
  const bytes=JSON.stringify(summary);for(const secret of ['sk-sensitive-key','do-not-upload','/Users/example','C:\\private','https://example.com','token=private'])assert.ok(!bytes.includes(secret),secret);
  assert.match(safeLabel('failed https://local.test/file?api_key=private C:\\private\\file.log'),/\[URL\].*\[PATH\]/);
  assert.equal(phase.status,'PASS');assert.equal(summary.status,'FAIL','unexecuted phases remain incomplete');
});

test('native success requires a real safeStorage encryption capability in the summary',()=>{
  const base={nativeAcceptance:'PASS',checks:[{name:'native',status:'PASS'}],nativeRuntime:{credentialBackend:'basic_text',encryptionAvailable:false}};
  assert.equal(summarizePhase('native',execution,base).status,'FAIL');
  assert.equal(summarizePhase('native',execution,{...base,nativeRuntime:{credentialBackend:'macos_keychain',encryptionAvailable:true,sandboxEnabled:true,electron:'44.9.3'}}).status,'PASS');
});

test('overall pass requires every native, package and media phase and keeps unsupported evidence explicit',()=>{
  const names=['preflight','package','native','models','film','editor'];
  const summary=platformSummary({applicationVersion:'0.5.0',platform:'darwin',architecture:'arm64',commit:'b'.repeat(40),cleanupStatus:'PASS'},names.map(phase=>({phase,status:'PASS'})));
  assert.equal(summary.status,'PASS');assert.equal(summary.deliveryVersion,'v1.0.0');assert.equal(summary.applicationVersion,'0.5.0');
  assert.equal(platformSummary({cleanupStatus:'FAIL'},names.map(phase=>({phase,status:'PASS'}))).status,'FAIL','cleanup failure cannot leave a passing summary');
  assert.equal(summary.evidenceLimits.realPaidProviders,'NOT_CHECKED');assert.equal(summary.evidenceLimits.cleanMachineInstallation,'NOT_CHECKED');assert.equal(summary.evidenceLimits.humanFullViewingAndListening,'NOT_CHECKED');
});

test('the platform harness exits nonzero and records missing tools without starting native acceptance',async()=>{
  const {mkdtemp,readFile,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os'),{spawnSync}=await import('node:child_process');
  const temporary=await mkdtemp(join(tmpdir(),'platform-preflight-test-')),summary=join(temporary,'summary.json');
  try{
    const result=spawnSync(process.execPath,['scripts/run-platform-acceptance.mjs','--summary',summary],{cwd:join(import.meta.dirname,'..'),env:{...process.env,CHROME_PATH:join(temporary,'missing-browser')},encoding:'utf8',timeout:30000});
    assert.equal(result.status,1,result.stderr);const report=JSON.parse(await readFile(summary,'utf8'));
    assert.equal(report.status,'FAIL');assert.equal(report.phases[0].failureCode,'ENVIRONMENT_MISSING');assert.equal(report.phases[0].checks.find((check:{name:string})=>check.name==='browser executable').status,'FAIL');
    assert.ok(report.phases.slice(1).every((phase:{status:string})=>phase.status==='NOT_CHECKED'));
    assert.ok(!JSON.stringify(report).includes(temporary));
  }finally{await rm(temporary,{recursive:true,force:true});}
});


test('failure diagnostics expose only fixed categories, never captured error messages',()=>{
  assert.equal(failureCategory('AppArmor: no usable sandbox /private/details'),'SANDBOX_UNAVAILABLE');
  assert.equal(failureCategory('safeStorage keyring failed sk-private-key'),'CREDENTIALS_UNAVAILABLE');
  const summary=summarizePhase('native',{exitCode:1,diagnosticCategory:failureCategory('safeStorage keyring failed sk-private-key')},undefined);
  assert.equal(summary.diagnosticCategory,'CREDENTIALS_UNAVAILABLE');assert.ok(!JSON.stringify(summary).includes('sk-private-key'));
});

test('package task failure summaries retain only fixed states, categories and revision numbers',()=>{
  const phase=summarizePhase('package',{exitCode:1},{status:'FAIL',location:'manual storyboard preview task completion',checks:[{name:'manual storyboard preview task completion',status:'FAIL',diagnostic:{expected:'complete',actual:'failed',taskKind:'preview',diagnosticCategory:'FRAME_NOT_REPEATABLE',taskRevision:4,projectRevision:4,id:'private-id',message:'sk-private-key',path:'/private/fixture'}},{name:'untrusted',status:'FAIL',diagnostic:{expected:'sk-private-key',actual:'/private/fixture',diagnosticCategory:'raw error',taskRevision:-1}}]});
  assert.deepEqual((phase.checks![0] as any).diagnostic,{expected:'complete',actual:'failed',taskKind:'preview',diagnosticCategory:'FRAME_NOT_REPEATABLE',taskRevision:4,projectRevision:4});
  assert.equal((phase.checks![1] as any).diagnostic,undefined);
  assert.equal(phase.failedLocation,'manual storyboard preview task completion');
  for(const value of ['private-id','sk-private-key','/private/fixture','raw error'])assert.ok(!JSON.stringify(phase).includes(value));
});
test('render mismatch summaries retain bounded pixels, hashes and readiness without paths or raw text',()=>{
  const comparison={phase:'cold',frame:0,width:1920,height:1080,differingPixels:12,maxChannelDelta:1,bounds:{x:20,y:30,width:5,height:4},expectedHash:'a'.repeat(64),actualHash:'b'.repeat(64),fontsStatus:'loaded',fontFaces:0,deviceScaleFactor:1,pixelComparison:'different',path:'/private/raw.png',message:'sk-private-key'};
  const phase=summarizePhase('package',{exitCode:1},{status:'FAIL',checks:[{name:'preview',status:'FAIL',diagnostic:{expected:'complete',actual:'failed',render:[comparison,{phase:'https://secret.test'}, {...comparison,frame:-1,expectedHash:'sk-private-key',differingPixels:Infinity,bounds:{x:-1,y:0,width:1,height:1}}]}}]});
  const render=(phase.checks![0] as any).diagnostic.render;assert.equal(render.length,2);assert.equal(render[0].differingPixels,12);assert.deepEqual(render[0].bounds,{x:20,y:30,width:5,height:4});assert.equal(render[1].frame,undefined);assert.equal(render[1].expectedHash,undefined);assert.equal(render[1].bounds,undefined);
  for(const secret of ['/private/raw.png','sk-private-key','https://secret.test'])assert.ok(!JSON.stringify(phase).includes(secret));
});

test('generic TASK_FAILED summaries retain fixed IO stages and current task/chat states but drop raw exception fields',()=>{
  const failure={category:'IO_ERROR',operation:'runtime_scene_alias_publish',ioCode:'EPERM',syscall:'rename',message:'sk-private-key',path:'/private/fixture',errno:-4048},safe={category:'IO_ERROR',operation:'runtime_scene_alias_publish',ioCode:'EPERM',syscall:'rename'};
  const phase=summarizePhase('native',{exitCode:1},{nativeAcceptance:'FAIL',checks:[{name:'preview',status:'FAIL',diagnostic:{diagnosticCategory:'TASK_FAILED',failure,currentTask:{status:'failed',kind:'preview',revision:4,failure,id:'private-id'},lastChatStatus:'failed',render:[{failure,message:'raw check text',path:'/private/fixture'},{failure:{...failure,operation:'/private/fixture'}}]}}]});
  assert.deepEqual((phase.checks![0] as any).diagnostic,{diagnosticCategory:'TASK_FAILED',failure:safe,currentTask:{status:'failed',kind:'preview',revision:4,failure:safe},lastChatStatus:'failed',render:[{failure:safe}]});
  const invalid=summarizePhase('package',{exitCode:1},{checks:[{name:'bad labels',status:'FAIL',diagnostic:{failure:{...failure,operation:'sk-private-key'},currentTask:{status:'private-status'},lastChatStatus:'sk-private-key',render:[{failure:{category:'UNKNOWN',operation:'task_work',ioCode:'sk-private-key',syscall:'/private/fixture'}}]}}]});
  for(const raw of ['private-id','sk-private-key','/private/fixture','errno','raw check text','private-status'])assert.ok(!JSON.stringify([phase,invalid]).includes(raw));
});

test('sandbox inspection checks the application renderer rather than another sandboxed process',async()=>{
  const {inspectNativeSandbox}=await import('../scripts/acceptance-sandbox.mjs'),{runInNewContext}=await import('node:vm');
  async function inspect(sandboxed:boolean,disabled=false){
    const electron={app:{commandLine:{hasSwitch:()=>disabled},getAppMetrics:()=>[{pid:12,type:'GPU',sandboxed:true},{pid:21,type:'Tab',sandboxed}]},BrowserWindow:{getAllWindows:()=>[{webContents:{mainFrame:{osProcessId:21}}}]}};
    const native={evaluate:(callback:Function)=>runInNewContext(`(${callback.toString()})(electron)`,{electron,process:{platform:'darwin'}})};
    return inspectNativeSandbox(native as unknown as import('playwright-core').ElectronApplication);
  }
  assert.equal((await inspect(false)).sandboxEnabled,false);assert.equal((await inspect(true,true)).sandboxEnabled,false);assert.equal((await inspect(true)).sandboxEnabled,true);
});

test('Linux sandbox evidence fails closed unless owned renderer has both seccomp and no_new_privs',async()=>{
  const {inspectNativeSandbox}=await import('../scripts/acceptance-sandbox.mjs'),{runInNewContext}=await import('node:vm');
  async function inspect(status:string|Error){
    const electron={app:{commandLine:{hasSwitch:()=>false},getAppMetrics:()=>[]},BrowserWindow:{getAllWindows:()=>[{webContents:{mainFrame:{osProcessId:21}}}]}};
    const processFixture={platform:'linux',getBuiltinModule:()=>({readFileSync:(path:string)=>{assert.equal(path,'/proc/21/status');if(status instanceof Error)throw status;return status;}})};
    const native={evaluate:(callback:Function)=>runInNewContext(`(${callback.toString()})(electron)`,{electron,process:processFixture})};
    return inspectNativeSandbox(native as unknown as import('playwright-core').ElectronApplication);
  }
  assert.equal((await inspect('Seccomp:\t2\nNoNewPrivs:\t0\n')).sandboxEnabled,false);
  assert.equal((await inspect('Seccomp:\t0\nNoNewPrivs:\t1\n')).sandboxEnabled,false);
  assert.equal((await inspect(new Error('process gone'))).sandboxEnabled,false);
  assert.equal((await inspect('Seccomp:\t2\nNoNewPrivs:\t1\n')).sandboxEnabled,true);
});

test('phase project registries are isolated while restarts retain their own phase directory',async()=>{
  const {stageEnvironment}=await import('../scripts/acceptance-environment.mjs'),{join}=await import('node:path');
  const inherited={YINGLIU_PROJECTS:'/user/real-projects',YINGLIU_ACCEPTANCE_OUTPUT:'/user/old-reports',CHROME_PATH:'/browser'};
  const packageEnv=stageEnvironment('/temporary','package',inherited),nativeEnv=stageEnvironment('/temporary','native',inherited),filmEnv=stageEnvironment('/temporary','film',inherited);
  assert.equal(nativeEnv.YINGLIU_PROJECTS,join('/temporary','projects','native'));
  assert.notEqual(packageEnv.YINGLIU_PROJECTS,nativeEnv.YINGLIU_PROJECTS);assert.notEqual(nativeEnv.YINGLIU_PROJECTS,filmEnv.YINGLIU_PROJECTS);
  assert.equal(stageEnvironment('/temporary','native',inherited).YINGLIU_PROJECTS,nativeEnv.YINGLIU_PROJECTS);
  assert.equal(nativeEnv.YINGLIU_ACCEPTANCE_OUTPUT,join('/temporary','raw','native'));assert.equal(nativeEnv.CHROME_PATH,'/browser');assert.equal(inherited.YINGLIU_PROJECTS,'/user/real-projects');
});
