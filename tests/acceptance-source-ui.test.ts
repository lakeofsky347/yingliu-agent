import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {captureSourceUiState,readSourceUiState} from '../scripts/acceptance-source-ui.mjs';
import {summarizePhase} from '../scripts/acceptance-summary.mjs';

test('source UI diagnostics distinguish selection, disabled ancestors and hit interception without reading source values',()=>{
  function element(text:string,x=10,y=10,disabled=false){return {textContent:text,classList:{contains:(name:string)=>name==='is-active'},getAttribute:(name:string)=>name==='aria-selected'?'true':null,getBoundingClientRect:()=>({x,y,left:x,top:y,right:x+80,bottom:y+30,width:80,height:30}),matches:(selector:string)=>selector===':disabled'&&disabled,contains:()=>false};}
  const shot=element(''),tab=element('前端源码',100,-50),editor=element('',200,100),save=element('保存源码',300,150,true);
  for(const item of [shot,editor]){Object.defineProperty(item,'value',{get(){throw new Error('must never inspect input values');}});Object.defineProperty(item,'textContent',{get(){throw new Error('must never inspect source or shot titles');}});}
  const queries:Record<string,unknown[]>={'.vs-shotchip':[shot],'.vs-tabs [role="tab"]':[tab],'textarea[aria-label="HTML 源码"]':[editor],'.vs-source-toolbar button':[save],'[role="tab"]':[tab],'button,[role="button"]':[shot,tab,save],'textarea,input[type="text"],input[type="url"],input[type="password"],[role="textbox"]':[editor]};
  const document={querySelectorAll:(selector:string)=>queries[selector]??[],querySelector:(selector:string)=>({'.vs-dock-content .vs-source':{},'.vs-source-dirty':{textContent:'尚未保存'},'.vs-studio fieldset:disabled':{}} as Record<string,unknown>)[selector]??null,elementFromPoint:(x:number)=>x>250?save:{}};
  const result=JSON.parse(JSON.stringify(runInNewContext(`(${captureSourceUiState.toString()})()`,{document,getComputedStyle:()=>({display:'block',visibility:'visible'}),innerWidth:1280,innerHeight:720,scrollY:450})));
  assert.equal(result.captureStatus,'CAPTURED');assert.equal(result.sourcePanel,'editor');assert.equal(result.selectedTab,'source');assert.equal(result.firstShotSelected,true);assert.equal(result.selectedShotIndex,0);assert.equal(result.sourceDirty,true);assert.equal(result.studioDisabled,true);
  assert.equal(result.controls.htmlEditor.hitTest,'other');assert.equal(result.controls.sourceTab.hitTest,'outside');assert.equal(result.controls.saveSource.disabled,true);assert.equal(result.controls.saveSource.hitTest,'self');assert.deepEqual(result.controls.htmlEditor.bounds,{x:200,y:100,width:80,height:30});assert.equal(result.buttonCount,3);
});

test('blocked or failed page diagnostics remain bounded and contain no exception text',async()=>{
  assert.deepEqual(await readSourceUiState({evaluate:()=>new Promise(()=>{})},{timeoutMs:5}),{captureStatus:'TIMEOUT'});
  assert.deepEqual(await readSourceUiState({evaluate:async()=>{throw new Error('sk-private-secret /private/source.html');}}),{captureStatus:'UNAVAILABLE'});
});

test('source interaction summary preserves only bounded enums, numbers and booleans',()=>{
  const sourceUi={captureStatus:'CAPTURED',selectedTab:'source',sourcePanel:'loading',shotCount:3,selectedShotIndex:0,firstShotSelected:true,sourceDirty:false,studioDisabled:true,tabCount:11,buttonCount:32,textboxCount:4,viewport:{width:1600,height:1000},pageScrollY:420,controls:{htmlEditor:{count:1,disabled:false,visible:true,inViewport:false,hitTest:'outside',bounds:{x:20,y:1400,width:900,height:450},value:'sk-private-value',path:'/private/source.html'},arbitrary:{value:'sk-private-value'}},message:'sk-private-value',shotId:'private-shot-id'};
  const phase=summarizePhase('package',{exitCode:1},{status:'FAIL',location:'source editor: HTML edit fill',checks:[{name:'source editor: HTML edit fill',status:'FAIL',diagnostic:{diagnosticCategory:'UI_ACTION_FAILED',sourceUi}}]});
  const diagnostic=(phase.checks![0] as any).diagnostic;assert.equal(diagnostic.diagnosticCategory,'UI_ACTION_FAILED');assert.equal(diagnostic.sourceUi.sourcePanel,'loading');assert.equal(diagnostic.sourceUi.controls.htmlEditor.hitTest,'outside');assert.deepEqual(diagnostic.sourceUi.controls.htmlEditor.bounds,{x:20,y:1400,width:900,height:450});
  for(const value of ['sk-private-value','/private/source.html','private-shot-id','arbitrary'])assert.ok(!JSON.stringify(phase).includes(value));
});

test('invalid source diagnostic values cannot become unbounded data or arbitrary strings',()=>{
  const phase=summarizePhase('package',{exitCode:1},{status:'FAIL',checks:[{name:'source editor: source tab click',status:'FAIL',diagnostic:{sourceUi:{captureStatus:'CAPTURED',selectedTab:'sk-private',sourcePanel:'/private/source',shotCount:Infinity,selectedShotIndex:-2,firstShotSelected:'secret',viewport:{width:99999999,height:10},pageScrollY:NaN,controls:{htmlEditor:{count:-1,disabled:'secret',hitTest:'https://private.test',bounds:{x:0,y:0,width:-1,height:10},value:'secret'}}}}}]});
  assert.deepEqual((phase.checks![0] as any).diagnostic.sourceUi,{captureStatus:'CAPTURED',controls:{htmlEditor:{}}});assert.ok(!JSON.stringify(phase).includes('secret'));assert.ok(!JSON.stringify(phase).includes('private'));
});
