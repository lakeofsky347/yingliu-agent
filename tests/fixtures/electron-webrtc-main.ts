// Harness for R01: production preload + production webPreferences, a page with a cross-origin (OOPIF) preview iframe.
import { app, BrowserWindow, session } from 'electron';
import { createServer } from 'node:http';
import { join } from 'node:path';
import * as prefs from '../../src/desktop/web-preferences.ts';

const probe = `<script>try{const C=window.RTCPeerConnection||window.webkitRTCPeerConnection;window.parent.postMessage({frame:location.port,ctor:typeof C,dc:typeof window.RTCDataChannel},'*');}catch(e){window.parent.postMessage({frame:location.port,error:String(e)},'*');}</script>`;
const inner = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<!doctype html>' + probe); });
const outer = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(`<!doctype html><script>const out=[];addEventListener('message',e=>{out.push(e.data);if(out.length===2)document.title='DONE'+JSON.stringify(out);});</script>${probe.replace('window.parent.postMessage','window.postMessage')}<iframe src="http://localhost:${(inner.address() as { port: number }).port}/"></iframe>`); });
app.whenReady().then(async () => {
  await new Promise<void>(r => inner.listen(0, '127.0.0.1', () => r())); await new Promise<void>(r => outer.listen(0, '127.0.0.1', () => r()));
  const s = session.fromPartition('r01-test');
  const window = new BrowserWindow({ show: false, webPreferences: prefs.editorWebPreferences(join(__dirname, 'preload.cjs'), s) });
  const timer = setTimeout(() => { console.log('R01RESULT' + JSON.stringify({ error: 'timeout' })); app.exit(2); }, 20000);
  window.webContents.on('page-title-updated', (_e, title) => { if (title.startsWith('DONE')) { clearTimeout(timer); console.log('R01RESULT' + title.slice(4)); app.exit(0); } });
  await window.loadURL(`http://127.0.0.1:${(outer.address() as { port: number }).port}/`);
});
