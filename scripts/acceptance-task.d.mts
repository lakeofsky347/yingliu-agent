export function waitForNewTask(options:{read:()=>Promise<any>;previousTaskId?:string;projectId:string;minimumRevision:number;kind?:string;timeoutMs?:number;pollMs?:number;now?:()=>number;sleep?:(ms:number)=>Promise<void>}):Promise<any>;
export function readRenderDiagnostics(root:string,revision:number):Promise<Record<string,unknown>[]>;
