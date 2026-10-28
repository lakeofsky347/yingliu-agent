/** Deliberate allowlist for CI uploads. Raw reports, commands, paths, logs, keys and media never cross this boundary. */
const PHASES=new Set(['preflight','package','native','models','film','editor']);
const STATES=new Set(['PASS','FAIL','NOT_CHECKED','PARTIAL','SKIP']);
export function safeLabel(value){
  return String(value??'').replace(/https?:\/\/[^\s)"'<>]+/gi,'[URL]')
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]+/g,'[PATH]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|synthetic-[A-Za-z0-9_-]*key[A-Za-z0-9_-]*|local-fixture-only)\b/g,'[REDACTED]')
    .replace(/(?:bearer|api[_ -]?key|authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,'[REDACTED]')
    .replace(/[\r\n\t]/g,' ').slice(0,220);
}
/** Emit a fixed diagnostic category, never an arbitrary exception or captured command log. */
export function failureCategory(value){
  const text=String(value??'');
  if(/no usable sandbox|suid sandbox|apparmor|sandbox.*(?:failed|unavailable)|sandboxed preload/i.test(text))return 'SANDBOX_UNAVAILABLE';
  if(/safeStorage|keyring|keychain|系统安全存储|系统钥匙环|加密.*(?:不可用|失败)/i.test(text))return 'CREDENTIALS_UNAVAILABLE';
  if(/ENOENT|executable.*(?:doesn.t exist|not found)|browser.*not found|缺少 Chrome|需要真实 Chrome/i.test(text))return 'EXECUTABLE_MISSING';
  if(/ffmpeg|ffprobe|media qa|encode|decode|编码|解码|音轨|采样率/i.test(text))return 'MEDIA_VALIDATION_FAILED';
  if(/timeout|timed out|超时/i.test(text))return 'WAIT_TIMEOUT';
  if(/AssertionError|ERR_ASSERTION/i.test(text))return 'ASSERTION_FAILED';
  if(/launch|startup|启动|browserType/i.test(text))return 'APPLICATION_STARTUP_FAILED';
  return 'CHECK_FAILED';
}
const number=value=>Number.isFinite(value)?value:undefined;
const version=value=>typeof value==='string'?safeLabel(value.split(/\r?\n/)[0]).slice(0,160):undefined;
/** Task observations use fixed enums and revision numbers, never task messages or IDs. */
function taskDiagnostic(value){
  if(!value||typeof value!=='object')return undefined;
  const result={};
  const fields={expected:['complete','ready'],actual:['failed','cancelled','running','no_new_task','wrong_project','wrong_task','not_ready','unknown'],taskKind:['preview','export','audio','storyboard','scenes','modify','unknown'],diagnosticCategory:['FRAME_NOT_REPEATABLE','WAIT_TIMEOUT','SANDBOX_UNAVAILABLE','TASK_FAILED','TASK_IDENTITY_MISMATCH']};
  for(const [key,allowed]of Object.entries(fields))if(allowed.includes(value[key]))result[key]=value[key];
  for(const key of ['taskRevision','projectRevision'])if(Number.isSafeInteger(value[key])&&value[key]>=0)result[key]=value[key];
  return Object.keys(result).length?result:undefined;
}
export function summarizePhase(phase,execution,report){
  if(!PHASES.has(phase))throw new Error('Unknown acceptance phase');
  const checks=Array.isArray(report?.checks)?report.checks.slice(0,120).map(check=>typeof check==='string'?{name:safeLabel(check),status:'PASS'}:{name:safeLabel(check?.name),status:STATES.has(check?.status)?check.status:'NOT_CHECKED',...(check?.status==='FAIL'&&taskDiagnostic(check?.diagnostic)?{diagnostic:taskDiagnostic(check.diagnostic)}:{})}):[];
  const declared=phase==='native'?report?.nativeAcceptance:report?.status;
  const nativeCredentials=phase!=='native'||report?.nativeRuntime?.sandboxEnabled===true&&report?.nativeRuntime?.encryptionAvailable===true&&['macos_keychain','windows_dpapi','gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(report.nativeRuntime.credentialBackend);
  const complete=nativeCredentials&&declared==='PASS'&&checks.length>0&&!checks.some(check=>check.status!=='PASS')&&(phase!=='package'||report.guiVerified===true&&report.sandboxVerified===true);
  const status=!execution?'NOT_CHECKED':execution.exitCode===0&&!execution.timedOut&&complete?'PASS':'FAIL';
  const failureCode=status==='PASS'?undefined:!execution?'NOT_RUN':execution.timedOut?'TIMEOUT':execution.exitCode!==0?'COMMAND_FAILED':!report?'REPORT_MISSING':!complete?'ACCEPTANCE_INCOMPLETE':undefined;
  return {phase,status,...(failureCode?{failureCode,...(typeof (report?.location??execution?.location)==='string'?{failedLocation:safeLabel(report?.location??execution?.location)}:{}),...(execution?.diagnosticCategory?{diagnosticCategory:['SANDBOX_UNAVAILABLE','CREDENTIALS_UNAVAILABLE','EXECUTABLE_MISSING','MEDIA_VALIDATION_FAILED','WAIT_TIMEOUT','ASSERTION_FAILED','APPLICATION_STARTUP_FAILED','CHECK_FAILED'].includes(execution.diagnosticCategory)?execution.diagnosticCategory:'CHECK_FAILED'}:{})}:{}),...(execution?{exitCode:number(execution.exitCode)??null,timedOut:!!execution.timedOut,elapsedMs:number(execution.elapsedMs)}:{}),checks,
    scope:phase==='package'||phase==='native'?'relocated native application':'source services with isolated localhost fixtures',
    ...(phase==='native'&&report?.nativeRuntime?{credentialBackend:safeLabel(report.nativeRuntime.credentialBackend),encryptionAvailable:report.nativeRuntime.encryptionAvailable===true,sandboxEnabled:report.nativeRuntime.sandboxEnabled===true,electron:version(report.nativeRuntime.electron)}:{})};
}
export function platformSummary(metadata,phases){
  const expected=['preflight','package','native','models','film','editor'];
  const complete=metadata.cleanupStatus==='PASS'&&expected.every(name=>phases.some(phase=>phase.phase===name&&phase.status==='PASS'));
  return {schemaVersion:1,deliveryVersion:'v1.0.0',applicationVersion:version(metadata.applicationVersion),checkedAt:new Date().toISOString(),
    workingTreeDirty:metadata.workingTreeDirty===true,commit:/^[a-f0-9]{40}$/.test(metadata.commit??'')?metadata.commit:null,platform:['darwin','win32','linux'].includes(metadata.platform)?metadata.platform:'unknown',architecture:['x64','arm64'].includes(metadata.architecture)?metadata.architecture:'unknown',
    runtime:{node:version(metadata.node),browser:version(metadata.browser),ffmpeg:version(metadata.ffmpeg),ffprobe:version(metadata.ffprobe)},
    status:complete?'PASS':'FAIL',temporaryDataCleanup:metadata.cleanupStatus==='PASS'?'PASS':metadata.cleanupStatus==='FAIL'?'FAIL':'NOT_CHECKED',phases:expected.map(name=>phases.find(phase=>phase.phase===name)||{phase:name,status:'NOT_CHECKED',failureCode:'NOT_RUN'}),
    evidenceLimits:{realPaidProviders:'NOT_CHECKED',cleanMachineInstallation:'NOT_CHECKED',humanFullViewingAndListening:'NOT_CHECKED',signingCertificateAndNotarization:'NOT_CHECKED',otherArchitectures:'NOT_CHECKED'},
    artifactPolicy:'Only this allowlisted JSON summary is uploadable; raw reports, temporary data, credentials, logs, screenshots and media are excluded.'};
}
