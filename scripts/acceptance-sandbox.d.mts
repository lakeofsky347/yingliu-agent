import type { ElectronApplication } from 'playwright-core';
export function inspectNativeSandbox(native:ElectronApplication):Promise<{sandboxEnabled:boolean}>;
