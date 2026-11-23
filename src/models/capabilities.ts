import type { ModelProtocol, ResolvedModel } from './contracts.ts';
import type { MediaOperation } from '../jobs/contracts.ts';
import { templateAcceptsImage, templateAcceptsLipSync, templateMaxImages } from './template-presets.ts';

export type MediaReferenceRole = 'reference' | 'first_frame' | 'last_frame' | 'character' | 'style' | 'layout' | 'depth' | 'location' | 'prop';
export interface MediaReferenceInput { type:'image'|'video'|'audio'; dataUrl?:string; role?:string }
export interface MediaCapabilityRequest {
  operation:MediaOperation;
  /** Effective parameters after merging model defaults; never silently filter request parameters. */
  parameters?:Record<string,string|number|boolean>;
  imageAssetIds?:readonly string[];
  videoAssetId?:string;
  audioAssetId?:string;
  inputs?:readonly MediaReferenceInput[];
  referenceRoles?:readonly string[];
  /** A requirement, not a provider toggle. Unknown native audio support fails closed. */
  requiresAudio?:boolean;
}
export interface MediaCapabilities {
  protocol:ModelProtocol; model:string; operations:MediaOperation[];
  references:{max:number;roles:MediaReferenceRole[];defaultRole:MediaReferenceRole};
  parameters:string[];
  duration?:{integer:boolean;min:number;max:number;values?:number[]};
  aspectRatios?:string[];
  sizes?:string[];
  audio:{input:false;output:'unknown'|'native';controllable:false};
  verification:{level:'adapter-contract'|'documentation-checked';modelRecognized:boolean;realProviderTested:false;checkedAt:string;sources:string[];notes:string[]};
  recovery:{lookupByClientRequestId:boolean;automaticResubmit:false};
}
export class MediaCapabilityError extends Error {
  readonly code='UNSUPPORTED_MEDIA_CAPABILITY';
  readonly submissionUncertain=false;
  constructor(message:string){super(message);this.name='MediaCapabilityError';}
}
const IMAGE_PARAMETERS=['size','quality','style','response_format','background','output_format','n'];
const VIDEO_PARAMETERS=['durationSeconds','width','height','fps','aspectRatio','seed','negativePrompt'];
const OPENAI_DOC='https://developers.openai.com/api/reference/resources/videos/methods/create';
const VOLC_DOC='https://docs.volcengine.com/docs/ark/video-generation-tutorial?lang=en&redirect=1';
const WAN_DOC='https://help.aliyun.com/en/model-studio/legacy-wan-text-to-video-api-reference';
const VEO_DOC='https://ai.google.dev/gemini-api/docs/veo';
const WAN_SIZES={low:['832x480','480x832','624x624'],medium:['1280x720','720x1280','960x960','1088x832','832x1088'],high:['1920x1080','1080x1920','1440x1440','1632x1248','1248x1632']};
const isImageOut=(op:MediaOperation)=>op==='text-to-image'||op==='image-compose';
const needsImageIn=(op:MediaOperation)=>op==='image-compose'||op==='image-to-video'||op==='first-last-frame-video';
function declaredCapabilities(cap:MediaCapabilities,resolved:ResolvedModel):MediaCapabilities {
  cap.operations=cap.operations.filter(op=>resolved.model.inputModalities.includes('text')&&resolved.model.outputModalities.includes(isImageOut(op)?'image':'video')&&(!needsImageIn(op)||resolved.model.inputModalities.includes('image')));
  if(!cap.operations.some(needsImageIn)){cap.references.max=0;cap.references.roles=[];}
  return cap;
}

/** Adapter-supported intersection, not a claim that every model of a vendor supports it. */
export function getMediaCapabilities(resolved:ResolvedModel):MediaCapabilities {
  const {protocol}=resolved.connection,model=resolved.model.model;
  const result:MediaCapabilities={protocol,model,operations:[],references:{max:0,roles:[],defaultRole:'first_frame'},parameters:[],audio:{input:false,output:'unknown',controllable:false},verification:{level:'adapter-contract',modelRecognized:false,realProviderTested:false,checkedAt:'2026-11-22',sources:[],notes:['仅声明适配器可编码的请求；未验证当前账号、地区、端点或真实生成质量。']},recovery:{lookupByClientRequestId:protocol==='video-gateway',automaticResubmit:false}};
  if(protocol==='async-task'){
    const maxImgs=templateMaxImages(resolved.model.parameters);
    if(resolved.model.outputModalities.includes('image')){
      result.operations=maxImgs>0?['text-to-image','image-compose']:['text-to-image'];
      result.references=maxImgs>0?{max:maxImgs,roles:['reference','layout','depth','character','location','style','prop'],defaultRole:'reference'}:{max:0,roles:[],defaultRole:'reference'};
      result.parameters=[...IMAGE_PARAMETERS];
    }else if(resolved.model.outputModalities.includes('video')){
      const acceptsImage=templateAcceptsImage(resolved.model.parameters);
      const acceptsLipSync=templateAcceptsLipSync(resolved.model.parameters);
      const ops:MediaOperation[]=maxImgs>=2?['text-to-video','image-to-video','first-last-frame-video']:acceptsImage?['text-to-video','image-to-video']:['text-to-video'];
      if(acceptsLipSync)ops.push('lip-sync-video');
      result.operations=ops;
      result.references=acceptsImage?{max:maxImgs||1,roles:['first_frame','last_frame','reference','character','style','layout','depth'],defaultRole:'first_frame'}:{max:0,roles:[],defaultRole:'first_frame'};
      result.parameters=[...VIDEO_PARAMETERS];
      result.duration={integer:false,min:0,max:120};
    }
    return declaredCapabilities(result,resolved);
  }
  if(protocol==='images'||protocol==='gemini-image'){
    const acceptsImg=resolved.model.inputModalities.includes('image');
    result.operations=acceptsImg?['text-to-image','image-compose']:['text-to-image'];
    result.references=acceptsImg?{max:4,roles:['reference','layout','depth','character','location','style','prop'],defaultRole:'reference'}:{max:0,roles:[],defaultRole:'reference'};
    result.parameters=protocol==='images'?[...IMAGE_PARAMETERS]:[];return declaredCapabilities(result,resolved);
  }
  if(!['video-gateway','openai-videos','kling-video','minimax-video','volc-video','dashscope-video','gemini-video'].includes(protocol))return result;
  const supportsFlf=['video-gateway','kling-video','volc-video','dashscope-video','gemini-video'].includes(protocol);
  result.operations=protocol==='video-gateway'
    ?['text-to-video','image-to-video','first-last-frame-video','lip-sync-video']
    :supportsFlf?['text-to-video','image-to-video','first-last-frame-video']:['text-to-video','image-to-video'];
  result.references=protocol==='video-gateway'
    ?{max:4,roles:['reference','first_frame','last_frame','character','style','layout','depth','location','prop'],defaultRole:'reference'}
    :supportsFlf
      ?{max:2,roles:['first_frame','last_frame'],defaultRole:'first_frame'}
      :{max:1,roles:['first_frame'],defaultRole:'first_frame'};
  result.duration={integer:protocol!=='video-gateway',min:protocol==='video-gateway'?0:1,max:120};
  const params:Partial<Record<ModelProtocol,string[]>>={
    'video-gateway':VIDEO_PARAMETERS,'openai-videos':['durationSeconds','width','height','aspectRatio'],
    'kling-video':['durationSeconds','aspectRatio','negativePrompt'],'minimax-video':['durationSeconds'],
    'volc-video':['durationSeconds','aspectRatio','seed'],'dashscope-video':['durationSeconds'],
    'gemini-video':['durationSeconds','aspectRatio'],
  };
  result.parameters=[...(params[protocol]??[])];
  if(protocol==='openai-videos'){
    result.aspectRatios=['16:9','9:16'];
    result.duration={integer:true,min:4,max:12,values:[4,8,12]};
    result.sizes=['720x1280','1280x720','1024x1792','1792x1024'];
    if(['sora-2','sora-2-2025-10-06','sora-2-2025-12-08','sora-2-pro','sora-2-pro-2025-10-06'].includes(model)){
      result.verification.modelRecognized=true;result.verification.level='documentation-checked';result.verification.sources=[OPENAI_DOC,'https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide'];
      result.audio.output='native';
      result.verification.sources.push('https://developers.openai.com/api/docs/models/'+(model.startsWith('sora-2-pro')?'sora-2-pro':'sora-2'),'https://developers.openai.com/api/docs/deprecations');
      result.verification.notes.push('官方 Videos API 与 Sora 2 型号已于 2026-09-24 退役；历史能力不代表当前端点可用，兼容端点须独立验证。');
      if(!model.startsWith('sora-2-pro'))result.sizes=['720x1280','1280x720'];
    }
  }
  if(protocol==='volc-video'){
    result.verification.sources=[VOLC_DOC];
    const seedance=['doubao-seedance-2-5-260628','doubao-seedance-2-0-260128','doubao-seedance-2-0-fast-260128','doubao-seedance-2-0-mini-260615'];
    if(seedance.includes(model)){
      result.duration={integer:true,min:4,max:model==='doubao-seedance-2-5-260628'?30:15};
      result.aspectRatios=['16:9','4:3','1:1','3:4','9:16','21:9','adaptive'];
      result.verification.modelRecognized=true;result.verification.level='documentation-checked';
    }
    result.verification.notes.push('durationSeconds、aspectRatio、seed 映射为 duration、ratio、seed；未实现多图、首尾帧或音频控制。');
  }
  if(protocol==='gemini-video'){
    result.aspectRatios=['16:9','9:16'];
    if(['veo-3.1-generate-preview','veo-3.1-fast-generate-preview','veo-3.1-lite-generate-preview'].includes(model)){
      result.duration={integer:true,min:4,max:8,values:[4,6,8]};result.audio.output='native';
      result.verification.modelRecognized=true;result.verification.level='documentation-checked';result.verification.sources=[VEO_DOC];
      result.verification.notes.push('官方文档已将这些 Gemini API preview ID 标记停用；本地兼容端点是否可用未验证，不自动改用其他模型。');
    }
  }
  if(protocol==='dashscope-video'){
    const profiles:Record<string,{duration:number[]|{min:number;max:number};sizes:string[]}>= {
      'wan2.6-t2v':{duration:{min:2,max:15},sizes:[...WAN_SIZES.medium,...WAN_SIZES.high]},
      'wan2.5-t2v-preview':{duration:[5,10],sizes:[...WAN_SIZES.low,...WAN_SIZES.medium,...WAN_SIZES.high]},
      'wan2.2-t2v-plus':{duration:[5],sizes:[...WAN_SIZES.low,...WAN_SIZES.high]},
      'wanx2.1-t2v-turbo':{duration:[5],sizes:[...WAN_SIZES.low,...WAN_SIZES.medium]},
      'wanx2.1-t2v-plus':{duration:[5],sizes:[...WAN_SIZES.medium]},
    };
    const profile=profiles[model];
    if(profile){
      result.operations=['text-to-video'];result.references.max=0;result.references.roles=[];
      result.parameters=['durationSeconds','width','height','seed','negativePrompt'];result.sizes=profile.sizes;
      const d=profile.duration;result.duration=Array.isArray(d)?{integer:true,min:Math.min(...d),max:Math.max(...d),values:d}:{integer:true,...d};
      result.verification.modelRecognized=true;result.verification.level='documentation-checked';result.verification.sources=[WAN_DOC];
    }
    result.verification.notes.push('旧 video-synthesis 不把宽高比写成未经验证的 ratio 字段；已识别文生视频型号只接受明确 width/height。');
  }
  return declaredCapabilities(result,resolved);
}

/** Pure preflight: call before journaling a new task and immediately before HTTP submission. */
export function validateMediaRequest(resolved:ResolvedModel,request:MediaCapabilityRequest):MediaCapabilities {
  const cap=getMediaCapabilities(resolved),fail=(message:string):never=>{throw new MediaCapabilityError(message);};
  if(!resolved.connection.enabled||!resolved.model.enabled||resolved.model.connectionId!==resolved.connection.id)fail('模型连接已停用或与模型不匹配');
  if(!cap.operations.includes(request.operation))fail('所选模型/协议不支持此生成操作：'+request.operation);
  const output=isImageOut(request.operation)?'image':'video';
  if(!resolved.model.outputModalities.includes(output)||!resolved.model.inputModalities.includes('text'))fail('所选模型未声明所需文字输入或媒体输出能力');
  if(request.inputs!==undefined&&!Array.isArray(request.inputs)||request.imageAssetIds!==undefined&&!Array.isArray(request.imageAssetIds))fail('参考素材列表无效');
  if(request.imageAssetIds&&(request.imageAssetIds.some(id=>typeof id!=='string'||!id)||new Set(request.imageAssetIds).size!==request.imageAssetIds.length))fail('参考资产 ID 必须有效且不重复');
  if(request.operation==='lip-sync-video'){
    if(request.imageAssetIds?.length)fail('口型同步操作使用源视频与配音资产，不接受静态参考图片');
    if(request.inputs!==undefined){
      if(request.inputs.length!==2||request.inputs[0]?.type!=='video'||request.inputs[1]?.type!=='audio')fail('口型同步需要提供 1 个源视频输入和 1 个驱动音频输入');
      if(typeof request.inputs[0].dataUrl!=='string'||!/^data:video\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i.test(request.inputs[0].dataUrl))fail('源视频必须是有效的视频 Data URL');
      if(typeof request.inputs[1].dataUrl!=='string'||!/^data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i.test(request.inputs[1].dataUrl))fail('驱动音频必须是有效的音频 Data URL');
    }else{
      if(typeof request.videoAssetId!=='string'||!request.videoAssetId||typeof request.audioAssetId!=='string'||!request.audioAssetId)fail('口型同步需要同时指定有效的源视频与配音资产 ID');
    }
  }else{
    const count=request.inputs?.length??request.imageAssetIds?.length??0;
    if(request.inputs&&request.imageAssetIds&&request.inputs.length!==request.imageAssetIds.length)fail('参考素材数量与资产列表不一致');
    const opMax=request.operation==='image-to-video'&&!['video-gateway'].includes(cap.protocol)?1:cap.references.max;
    if(count>opMax)fail('当前适配器最多支持 '+opMax+' 张参考图片；不会只取首图');
    if(needsImageIn(request.operation)&&(!count||!resolved.model.inputModalities.includes('image')))fail('此操作需要参考图片及模型图片输入能力');
    if(request.operation==='first-last-frame-video'&&count<2)fail('首尾帧生视频需要同时提供首帧与尾帧图片');
    if(!needsImageIn(request.operation)&&count)fail('此操作不支持参考图片');
    if(request.referenceRoles!==undefined&&(!Array.isArray(request.referenceRoles)||request.referenceRoles.length!==count))fail('参考图片角色必须与图片逐项对应');
    for(let i=0;i<count;i++){
      const input=request.inputs?.[i];
      if(request.inputs&&(!input||typeof input!=='object'||input.type!=='image'))fail('当前适配器只支持有效的图片参考输入，不支持视频或音频参考');
      if(input?.role&&request.referenceRoles?.[i]&&input.role!==request.referenceRoles[i])fail('参考图片角色声明冲突');
      const fallbackRole=request.operation==='first-last-frame-video'&&i===1?'last_frame':cap.references.defaultRole;
      const role=input?.role??request.referenceRoles?.[i]??fallbackRole;
      if(typeof role!=='string'||!cap.references.roles.includes(role as MediaReferenceRole))fail('当前适配器不支持参考角色：'+String(role));
      if(input&&(typeof input.dataUrl!=='string'||!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(input.dataUrl)))fail('参考图片必须是 PNG、JPEG 或 WebP Data URL');
    }
  }
  if(request.requiresAudio!==undefined&&typeof request.requiresAudio!=='boolean')fail('音频要求须为开关');
  if(request.requiresAudio&&cap.audio.output!=='native')fail('此具体模型的原生音频输出未验证，不能承诺带音频生成');
  if(request.parameters!==undefined&&(request.parameters===null||typeof request.parameters!=='object'||Array.isArray(request.parameters)))fail('生成参数须为对象');
  const p=request.parameters??{};
  if(!p||typeof p!=='object'||Array.isArray(p))fail('生成参数须为对象');
  for(const [key,value] of Object.entries(p)){
    if(!cap.parameters.includes(key))fail('当前适配器不支持生成参数：'+key+'；不会静默忽略');
    if(!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value)||typeof value==='string'&&value.length>4000)fail('生成参数无效：'+key);
  }
  if(output==='image'){
    for(const [key,value] of Object.entries(p))if(key!=='n'&&typeof value!=='string')fail('生图参数须为文本：'+key);
    if(p.n!==undefined&&(!Number.isSafeInteger(p.n)||Number(p.n)<1||Number(p.n)>4))fail('每次生图数量须为 1–4');
    return cap;
  }
  if(p.negativePrompt!==undefined&&typeof p.negativePrompt!=='string')fail('负向提示须为文本');
  for(const key of ['width','height','seed'])if(p[key]!==undefined&&!Number.isSafeInteger(p[key]))fail('生成参数须为整数：'+key);
  for(const [key,limitKey,hardLimit]of [['durationSeconds','maxDurationSeconds',120],['width','maxWidth',8192],['height','maxHeight',8192],['fps','maxFps',120]] as const){
    const value=p[key],configured=resolved.model.parameters[limitKey];
    if(configured!==undefined&&(typeof configured!=='number'||!Number.isFinite(configured)||configured<=0))fail('模型参数上限无效：'+limitKey);
    if(value!==undefined&&(typeof value!=='number'||value<=0||value>Math.min(hardLimit,typeof configured==='number'?configured:hardLimit)))fail('生成参数超过模型范围：'+key);
  }
  if(p.durationSeconds!==undefined&&cap.duration){const d=cap.duration,v=Number(p.durationSeconds);if(d.integer&&!Number.isInteger(v)||v<d.min||v>d.max||d.values&&!d.values.includes(v))fail('时长不在当前模型支持范围；不会四舍五入或改用默认值');}
  if(p.aspectRatio!==undefined&&(typeof p.aspectRatio!=='string'||!p.aspectRatio||p.aspectRatio.length>32||cap.aspectRatios&&!cap.aspectRatios.includes(p.aspectRatio)))fail('画面比例不在当前模型支持范围');
  if(!['video-gateway','async-task'].includes(cap.protocol)&&(p.width!==undefined)!==(p.height!==undefined))fail('宽度和高度必须同时指定');
  if(cap.sizes&&p.width!==undefined&&!cap.sizes.includes(p.width+'x'+p.height))fail('分辨率不在当前模型支持范围');
  if(cap.protocol==='openai-videos'&&p.aspectRatio!==undefined&&p.width!==undefined){const [w,h]=String(p.aspectRatio).split(':').map(Number);if(Number(p.width)*h! !==Number(p.height)*w!)fail('画幅与明确分辨率冲突，请只指定一致的尺寸');}
  if(cap.protocol==='kling-video'&&request.operation==='image-to-video'&&p.aspectRatio!==undefined)fail('当前可灵图生视频适配器未验证画幅控制，请由首帧确定画幅');
  if(cap.protocol==='volc-video'&&cap.model==='doubao-seedance-2-5-260628'&&request.operation==='image-to-video'&&p.aspectRatio!==undefined&&p.aspectRatio!=='adaptive')fail('Seedance 2.5 首帧生视频只支持 adaptive 画幅');
  if(cap.protocol==='dashscope-video'&&p.seed!==undefined&&(Number(p.seed)<0||Number(p.seed)>2147483647))fail('万相 seed 须为 0–2147483647');
  return cap;
}
