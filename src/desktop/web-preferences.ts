import type { Session, WebPreferences } from 'electron';
/** Editor window preferences (shared with the R01 Electron regression harness).
 *  nodeIntegrationInSubFrames only makes the sandboxed preload run in preview iframes too (sandbox: no Node there),
 *  so it can strip WebRTC from every frame; the IPC bridge is exposed to the main frame only and IPC is origin/frame-checked. */
export function editorWebPreferences(preload: string, session: Session): WebPreferences {
  return { preload, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, sandbox: true, webSecurity: true, session };
}
