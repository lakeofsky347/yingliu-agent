export interface ModelRoute { provider:string; model:string }
export type ProductionMode='unresolved'|'code_animation'|'model_video'|'hybrid';
export type ProductionOperation='code'|'image'|'video';
export interface HybridProductionGrant {
  id:string; projectId:string; shotIds:string[]; operations:('code'|'video')[]; confirmedAt:string;
}
/** Only a trusted host user-decision path may create or replace this policy. */
export interface ProductionPolicy {
  version:1; decisionId:string; mode:ProductionMode; allowGeneratedImages:boolean; allowImportedVideo:boolean;
  baseMode?:'code_animation'|'model_video';
  hybridGrants?:HybridProductionGrant[];
}
export interface AssetProvenance {
  origin:'user_import'|'model_generation'|'code_render'|'unknown'; usage:'reference_only'|'production';
  sourceProjectId?:string; sourceExportId?:string;
}
export interface ShotVisual { kind:'unresolved'|'code'|'model_video'|'imported_video'|'hybrid' }
export interface Asset {
  id:string; kind:'image'|'text'|'audio'|'video'; name:string; description:string;
  path?:string; originalPath?:string; text?:string; mime?:string; width?:number; height?:number;
  duration?:number; sampleRate?:number; channels?:number;
  fps?:{num:number;den:number}; frameCount?:number; hasAudio?:boolean; sha256?:string; sourceSha256?:string;
  generation?:{taskId:string;connectionId?:string;model:string;operation:string;prompt:string;inputHashes?:{assetId:string;sha256:string}[]};
  provenance?:AssetProvenance;
}
export interface ShotParams {
  text:string; subtitle:string; background:string; foreground:string; accent:string;
  imageX:number; imageY:number; imageScale:number; imageFit:'cover'|'contain';
  fontSize:number; motion:'fade'|'slide'|'zoom'|'none';
  [key:string]:string|number|boolean;
}
export type ShotTransition = 'cut'|'fade'|'dissolve'|'wipe_left'|'flash_white';
export interface ShotColorGrade {
  /** Exposure stops (-2 to +2, default 0). */
  exposure?:number;
  /** Contrast multiplier (0.2 to 3, default 1). */
  contrast?:number;
  /** Saturation multiplier (0 to 3, default 1). */
  saturation?:number;
  /** Color temperature shift (-100 cool to +100 warm, default 0). */
  temperature?:number;
  /** Green-magenta tint shift (-100 to +100, default 0). */
  tint?:number;
  /** Edge vignette strength (0 to 1, default 0). */
  vignette?:number;
}
export interface ShotTake {
  id:string; assetId:string; kind:'video'|'image'; score?:number; notes?:string; createdAt:string;
}
export interface OverlayClip {
  id:string; shotId:string; assetId:string; kind:'image'|'video';
  /** Normalized 0..100 stage percentage coordinates and size. */
  x:number; y:number; width:number; height:number; opacity:number;
  startSeconds:number; durationSeconds?:number; borderRadius?:number;
}
export interface SubtitleCue {
  id:string; startSeconds:number; endSeconds:number; text:string;
  speaker?:string; shotId?:string; style?:'default'|'cinema'|'minimal';
}
export interface AudioMixSettings {
  /** Automatically duck BGM when voice clips are active. */
  autoDucking?:boolean;
  /** Ducking attenuation in dB (e.g. 8 means -8 dB on music during speech). */
  duckingDb?:number;
  /** Target integrated loudness in LUFS (e.g. -14 for web, -16 for mobile, -23 for broadcast). */
  targetLufs?:number;
  /** Acoustic space preset applied to dialogue voice bus. */
  voiceReverb?:'none'|'room'|'hall'|'phone';
}
export interface Shot {
  id:string; title:string; intent:string; composition:string; action:string;
  durationFrames:number; assetIds:string[]; referenceIds:string[];
  transition:ShotTransition; transitionFrames?:number; params:ShotParams; sourcePath:string;
  narration?:string;
  visual?:ShotVisual;
  colorGrade?:ShotColorGrade;
  takes?:ShotTake[];
}
export interface GraphLayout {
  positions:Record<string,[number,number]>;
  groups:{id:string;title:string;bounds:[number,number,number,number]}[];
}
export interface VideoTarget { width:number; height:number; fps:{num:number;den:number}; audioMode:'none'|'mixed'; quality?:'standard'|'high'|'small' }
export interface VideoStyle {
  id:string; name:string; description:string; prompt:string;
  sourceFormat:'markdown'|'json'|'zip'|'folder'|'custom'; sourceName:string; createdAt:string; updatedAt:string;
}
export interface AudioClip {
  id:string;assetId:string;role:'voice'|'music'|'sfx';shotId?:string;
  startSeconds:number;trimStart:number;trimEnd?:number;volume:number;fadeIn:number;fadeOut:number;loop?:boolean;
  characterId?:string;speaker?:string;
}
/** One deterministic source-video layer per shot; time values are source seconds. */
export interface VideoClip {
  id:string; shotId:string; assetId:string; trimStart:number; trimEnd?:number;
  speed:number; fit:'cover'|'contain'; audio:'mute'|'keep'|'extract';
}
export interface TtsSettings {endpoint:string;model:string;voice:string;apiKey?:string;speed:number;enabled:boolean;requestTimeoutMs?:number}
export interface ExportResult {
  id:string; path:string; url?:string; createdAt:string; revision:number;
  width:number; height:number; frameCount:number; duration:number; qa?:Record<string,unknown>; localQuality?:import('../workflows/local-quality.ts').LocalQualityReport;
}
export interface VideoProject {
  schemaVersion:1|2|3; id:string; title:string; topic:string; targetDuration:number;
  createdAt:string; updatedAt:string; revision:number; target:VideoTarget;
  assets:Asset[]; shots:Shot[]; shotOrder:string[]; graph:GraphLayout;
  outputs:ExportResult[]; extensions:Record<string,unknown>;
  sessionIds?:string[];audioClips?:AudioClip[];videoClips?:VideoClip[];videoStyle?:VideoStyle;
  productionPolicy?:ProductionPolicy;
  overlayClips?:OverlayClip[];
  subtitles?:SubtitleCue[];
  audioMix?:AudioMixSettings;
}
export interface SpecShot extends Shot { startFrame:number; endFrame:number; assets:Asset[]; videoClip?:VideoClip; overlays?:OverlayClip[] }
export interface VideoSpec {
  projectId:string; title:string; topic:string; target:VideoTarget;
  durationFrames:number; durationSeconds:number; shots:SpecShot[];
  productionPolicy?:ProductionPolicy;
  subtitles?:SubtitleCue[];
}
export interface SceneSource { html:string; css:string; js:string; shotPatch?:Partial<Shot> }
export interface TaskState {
  id:string; kind:'storyboard'|'scenes'|'modify'|'preview'|'export'|'audio';
  status:'running'|'complete'|'failed'|'cancelled'; progress:number; message:string;
  startedAt:string; finishedAt?:string; error?:string; shotId?:string; failedShotIds?:string[]; logPath?:string; failure?:import('./task-diagnostic.ts').TaskFailureDiagnostic;
}
export interface EnvironmentSettings { browserPath:string; ffmpegPath:string; ffprobePath:string; blenderPath?:string; maxVideoBytes?:number }
export interface EnvironmentInfo extends EnvironmentSettings { browserAvailable:boolean; ffmpegAvailable:boolean; ffprobeAvailable:boolean; blenderAvailable?:boolean; blenderVersion?:string; platform?:string; localSpeechAvailable?:boolean }
export interface ProviderGroup { id:string; name:string; models:{id:string;name:string;inputModalities?:string[]}[]; error?:string }
export interface SecretStoreStatus {
  available:boolean; backend:string; hasStoredKey?:boolean; error?:string;
}
export interface StudioSnapshot {
  project:VideoProject|null; root:string|null; task:TaskState|null;
  previewUrl:string|null; previewRevision:number|null; assetBaseUrl?:string|null; providers:ProviderGroup[];
  currentExportIds?:string[];
  environment:EnvironmentInfo; recent:{path:string;title:string;id:string}[];
  sessionId?:string;focus?:{shotId?:string;frame?:number};audioUrl?:string|null;tts?:TtsSettings;ttsConfigured?:boolean;credentialStatus?:SecretStoreStatus;styles?:VideoStyle[];
}
export type RpcResult<T=unknown>={ok:true;value:T}|{ok:false;error:{code:string;message:string}};
export interface ClientRpc { call(channel:string,endpoint:string,payload:unknown,signal?:AbortSignal):Promise<RpcResult> }
export interface StudioApi { call<T=unknown>(endpoint:string,payload?:unknown):Promise<T> }

/** Keep third-party graph formats behind this interface. */
export interface GraphEditorAdapter {
  setProject(project:VideoProject,assetUrl:(asset:Asset)=>string):void;
  resize():void; dispose():void;
}
export interface SceneGenerator {
  storyboard(project:VideoProject,route:ModelRoute,signal:AbortSignal):Promise<Shot[]>;
  scene(project:VideoProject,shot:Shot,route:ModelRoute,signal:AbortSignal,current?:SceneSource,instruction?:string):Promise<SceneSource>;
}
export interface FrameRenderer {
  ready():Promise<void>;
  renderFrame(input:{frame:number;fps:{num:number;den:number}}):Promise<{frame:number;sceneId:string;declaredTexts:string[]}>;
}
export interface Exporter {
  export(root:string,project:VideoProject,settings:EnvironmentSettings,signal:AbortSignal,onProgress:(progress:number,message:string)=>void):Promise<ExportResult>;
}
