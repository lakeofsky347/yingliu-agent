export function captureSourceUiState():Record<string,unknown>;
export function readSourceUiState(page:{evaluate:(read:()=>unknown)=>Promise<unknown>},{timeoutMs}?:{timeoutMs?:number}):Promise<Record<string,unknown>>;
