import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createApplication, MemorySecrets, type Application } from './application.ts';
import { acquireApplicationOwner, applicationDirectories, drainOwned, type OwnerLease } from './ownership.ts';
import { startUiServer } from './ui-server.ts';
const directory=dirname(fileURLToPath(import.meta.url));
const directories=applicationDirectories({dataDirectory:resolve(process.env.YINGLIU_DATA_DIR||'.local/agent-webdata')});
const abort=new AbortController();
let application:Application|undefined,server:Awaited<ReturnType<typeof startUiServer>>|undefined,ownership:OwnerLease|undefined;
let startup:Promise<void>,closing:Promise<void>|undefined;
async function close(){return closing??=(async()=>{
  try{await startup?.catch(()=>{});await drainOwned([()=>application?.dispose(),()=>server?.close()]);}
  finally{await ownership?.release();process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
})();}
function interrupt(){if(!abort.signal.aborted)abort.abort(new Error('应用正在关闭'));void close().catch(error=>{console.error(error instanceof Error?error.message:'关闭失败');process.exitCode=1;});}
process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
startup=(async()=>{
  ownership=await acquireApplicationOwner(directories,'web-server',0,abort.signal);abort.signal.throwIfAborted();
  application=await createApplication({...directories,credentials:new MemorySecrets(),ownership});abort.signal.throwIfAborted();
  server=await startUiServer(application,join(directory,'ui'),Number(process.env.YINGLIU_PORT||19440));abort.signal.throwIfAborted();
  console.log('映流智能体 ready: '+server.origin+' (浏览器模式密钥只保存在本进程内存)');
})();
try{await startup;}catch(error){await close();if(!abort.signal.aborted){console.error(error instanceof Error?error.message:'启动失败');process.exitCode=1;}}
