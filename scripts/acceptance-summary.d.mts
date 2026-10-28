export interface AcceptancePhase {phase:string;status:string;failureCode?:string;checks?:{name:string;status:string}[];[key:string]:unknown}
export function failureCategory(value:unknown):string;
export function safeLabel(value:unknown):string;
export function summarizePhase(phase:string,execution:{exitCode:number|null;timedOut?:boolean;elapsedMs?:number;diagnosticCategory?:string;location?:string}|undefined,report:Record<string,any>|undefined):AcceptancePhase;
export function platformSummary(metadata:Record<string,unknown>,phases:AcceptancePhase[]):Record<string,any>;
