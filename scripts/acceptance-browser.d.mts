interface BrowserConnection {version():string;close():Promise<void>}
interface OwnedBrowserServer {wsEndpoint():string;close():Promise<void>;kill():Promise<void>}
interface BrowserLauncher {launchServer(options:Record<string,unknown>):Promise<OwnedBrowserServer>;connect(endpoint:string,options:Record<string,unknown>):Promise<BrowserConnection>}
export function probeBrowserVersion(executablePath:string,options?:{browserType?:BrowserLauncher;env?:NodeJS.ProcessEnv;launchTimeoutMs?:number;cleanupTimeoutMs?:number}):Promise<{status:'PASS'|'FAIL';version?:string;diagnosticCategory?:string}>;
