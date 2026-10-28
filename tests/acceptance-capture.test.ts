import assert from 'node:assert/strict';
import test from 'node:test';
import {captureNativeViewport} from '../scripts/acceptance-capture.mjs';
import {summarizePhase} from '../scripts/acceptance-summary.mjs';
import type {ElectronApplication} from 'playwright-core';

test('native capture restores and shows only an owned window and keeps capture awake',async()=>{
  const calls:string[]=[];let options:unknown;
  const window={isDestroyed:()=>false,isMinimized:()=>true,restore(){calls.push('restore');},show(){calls.push('show');},focus(){calls.push('focus');},webContents:{async capturePage(rect:unknown,opts:unknown){assert.equal(rect,undefined);options=opts;calls.push('capture');return {isEmpty:()=>false,toPNG:()=>Buffer.from('synthetic bitmap')};}}};
  const native={evaluate:(callback:Function)=>callback({BrowserWindow:{getAllWindows:()=>[window]}})} as unknown as ElectronApplication;
  assert.equal(await captureNativeViewport(native),Buffer.from('synthetic bitmap').toString('base64'));assert.deepEqual(calls,['restore','show','focus','capture']);assert.deepEqual(options,{stayAwake:true,stayHidden:false});
});

test('a native bitmap promise that never resolves has an explicit host-side timeout',async()=>{
  const native={evaluate:()=>new Promise(()=>{})} as unknown as ElectronApplication;
  await assert.rejects(captureNativeViewport(native,{timeoutMs:10}),{code:'CAPTURE_TIMEOUT'});
});

test('capture failure location survives allowlisting while arbitrary raw errors remain excluded',()=>{
  const summary=summarizePhase('native',{exitCode:1,location:'capture: 01-library.png',diagnosticCategory:'WAIT_TIMEOUT'},undefined);
  assert.equal(summary.status,'FAIL');assert.equal(summary.failedLocation,'capture: 01-library.png');assert.equal(summary.diagnosticCategory,'WAIT_TIMEOUT');
  const unsafe=summarizePhase('native',{exitCode:1,location:'capture /private/user/token Bearer: sk-secret-key'},undefined);
  assert.ok(!JSON.stringify(unsafe).includes('/private/user'));assert.ok(!JSON.stringify(unsafe).includes('sk-secret-key'));
});
