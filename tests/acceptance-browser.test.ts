import assert from 'node:assert/strict';
import test from 'node:test';
import {probeBrowserVersion} from '../scripts/acceptance-browser.mjs';

function fixture(options:{connectError?:boolean;versionError?:boolean;closeError?:boolean;closeHang?:boolean;version?:string}={}){
  const calls:string[]=[],launches:Record<string,unknown>[]=[];
  const browser={version(){calls.push('version');if(options.versionError)throw new Error('synthetic version failure');return options.version??'156.0.1.2';},async close(){calls.push('disconnect');}};
  const server={wsEndpoint(){return 'ws://127.0.0.1/owned-fixture';},async close(){calls.push('close');if(options.closeError)throw new Error('synthetic close failure');if(options.closeHang)await new Promise(()=>{});},async kill(){calls.push('kill');}};
  const browserType={async launchServer(config:Record<string,unknown>){launches.push(config);return server;},async connect(){calls.push('connect');if(options.connectError)throw new Error('synthetic connect failure');return browser;}};
  return {browserType,calls,launches};
}

test('browser preflight gets the version through an isolated real browser protocol, not GUI --version',async()=>{
  const f=fixture(),result=await probeBrowserVersion('C:\\Chrome\\chrome.exe',{browserType:f.browserType});
  assert.equal(result.status,'PASS');assert.equal(result.version,'Chromium 156.0.1.2');assert.deepEqual(f.calls,['connect','version','close','disconnect']);
  assert.equal(f.launches[0]?.headless,true);assert.equal(f.launches[0]?.chromiumSandbox,true);assert.equal(f.launches[0]?.executablePath,'C:\\Chrome\\chrome.exe');assert.equal(f.launches[0]?.args,undefined);
});

test('connect and version errors still close the owned browser server',async()=>{
  for(const options of [{connectError:true},{versionError:true}]){
    const f=fixture(options),result=await probeBrowserVersion('browser',{browserType:f.browserType});assert.equal(result.status,'FAIL');assert.ok(f.calls.includes('close'));assert.ok(!f.calls.includes('kill'));
    assert.ok(!JSON.stringify(result).includes('synthetic'));
  }
});

test('a failed or stalled graceful close forces only the owned server down and cannot leave a passing probe',async()=>{
  for(const options of [{closeError:true},{closeHang:true}]){
    const f=fixture(options),result=await probeBrowserVersion('browser',{browserType:f.browserType,cleanupTimeoutMs:10});assert.equal(result.status,'FAIL');assert.ok(f.calls.includes('kill'));assert.ok(f.calls.includes('disconnect'));
  }
});

test('missing executable and invalid protocol version fail closed without publishing raw errors',async()=>{
  const f=fixture(),missing=await probeBrowserVersion('',{browserType:f.browserType});assert.equal(missing.status,'FAIL');assert.equal(missing.diagnosticCategory,'EXECUTABLE_MISSING');assert.equal(f.launches.length,0);
  const invalid=fixture({version:'error: sk-private-key'}),result=await probeBrowserVersion('browser',{browserType:invalid.browserType});assert.equal(result.status,'FAIL');assert.equal(result.version,undefined);assert.ok(!JSON.stringify(result).includes('sk-private-key'));assert.ok(invalid.calls.includes('close'));
});
