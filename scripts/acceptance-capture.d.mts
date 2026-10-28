import type {ElectronApplication} from 'playwright-core';
export function captureNativeViewport(native:ElectronApplication,options?:{timeoutMs?:number}):Promise<string>;
