import {createServer} from 'node:http';
import type {RemoteJob} from '../src/jobs/contracts.ts';

export const pngFixture=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDioAAAAASUVORK5CYII=','base64');
interface GatewayRequest {path:string;method:string;authorization?:string;body?:Record<string,unknown>}
/** Local protocol fixture only; never a production provider or quality acceptance result. */
export async function startMediaGateway(options:{video?:Uint8Array;loseSubmitResponse?:boolean;queued?:boolean;cancelSupported?:boolean;failDownloadOnce?:boolean;imageBase64?:boolean;loseImageResponse?:boolean}={}){
  const jobs=new Map<string,RemoteJob>();const requests:GatewayRequest[]=[],requestWaiters=new Set<(request:GatewayRequest)=>void>();let url='',lost=false,downloadFailed=false;
  const server=createServer(async(req,res)=>{const address=new URL(req.url??'/',url);let body:Record<string,unknown>|undefined;if(req.method==='POST'){const parts=[];for await(const chunk of req)parts.push(chunk);body=JSON.parse(Buffer.concat(parts).toString()||'{}');}const request={path:address.pathname+address.search,method:req.method??'GET',authorization:req.headers.authorization,body};requests.push(request);for(const notify of requestWaiters)notify(request);const json=(value:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(address.pathname==='/v1/images/generations'){if(options.loseImageResponse&&!lost){lost=true;req.socket.destroy();return;}json({data:[options.imageBase64?{b64_json:pngFixture.toString('base64')}:{url:url+'/artifacts/image.png'}]});return;}
    if(address.pathname==='/artifacts/image.png'||address.pathname==='/artifacts/video.mp4'){if(options.failDownloadOnce&&!downloadFailed){downloadFailed=true;res.writeHead(503);res.end();return;}res.writeHead(200,{'Content-Type':address.pathname.endsWith('.png')?'image/png':'video/mp4'});res.end(address.pathname.endsWith('.png')?pngFixture:options.video??Buffer.from('00000018ftypmp42'));return;}
    if(address.pathname==='/v1/media/jobs'&&req.method==='POST'){const id=String(body?.clientRequestId);let job=jobs.get(id);if(!job){job={jobId:id,status:options.queued?'running':'succeeded',...(options.queued?{}:{artifacts:[{url:url+'/artifacts/video.mp4',mimeType:'video/mp4'}]})};jobs.set(id,job);}if(options.loseSubmitResponse&&!lost){lost=true;req.socket.destroy();return;}json(job);return;}
    if(address.pathname==='/v1/media/jobs'&&req.method==='GET'){const job=jobs.get(address.searchParams.get('clientRequestId')??'');json(job??{error:'not found'},job?200:404);return;}
    const match=/^\/v1\/media\/jobs\/([^/]+)(\/cancel)?$/.exec(address.pathname);if(match){const job=jobs.get(decodeURIComponent(match[1]!));if(!job){json({error:'not found'},404);return;}if(match[2]){if(options.cancelSupported===false){json({error:'unsupported'},405);return;}job.status='cancelled';}json(job);return;}
    json({error:'not found'},404);
  });await new Promise<void>(accept=>server.listen(0,'127.0.0.1',accept));const address=server.address();if(!address||typeof address==='string')throw new Error('fixture address');url='http://127.0.0.1:'+address.port;
  return {url,requests,jobs,waitForRequest(predicate:(request:GatewayRequest)=>boolean,timeoutMs=3000):Promise<GatewayRequest>{
    const existing=requests.find(predicate);if(existing)return Promise.resolve(existing);
    return new Promise((accept,reject)=>{const notify=(request:GatewayRequest)=>{if(!predicate(request))return;clearTimeout(timer);requestWaiters.delete(notify);accept(request);};const timer=setTimeout(()=>{requestWaiters.delete(notify);reject(new Error('media fixture did not receive the expected request before the deadline'));},timeoutMs);requestWaiters.add(notify);});
  },complete(){for(const job of jobs.values()){job.status='succeeded';job.artifacts=[{url:url+'/artifacts/video.mp4',mimeType:'video/mp4'}];}},async close(){server.closeAllConnections();await new Promise<void>(accept=>server.close(()=>accept()));}};
}
