import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,type LaunchOptions} from 'playwright-core';
import {createProject,reorderShots} from '../src/core/index.ts';
import {ProjectStore} from '../src/host/store.ts';
import {VideoRenderer,detectEnvironment} from '../src/host/renderer.ts';

const environment=detectEnvironment();
test('default DOM text at frame zero repeats exactly after reverse seeks and cold reload with grayscale text and complete compositor stages',{skip:!environment.browserAvailable,timeout:60000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'renderer-text-repeat-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);
  let options:LaunchOptions|undefined,actualTextFlag=false;const launch=chromium.launch.bind(chromium);
  t.mock.method(chromium,'launch',async(config:LaunchOptions)=>{
    options=config;const browser=await launch(config);t.after(()=>browser.close());actualTextFlag=config.args?.includes('--disable-lcd-text')===true;
    return browser;
  });
  try{
    // Reproduce the package GUI's three default shots and move the third first.
    // Keep its actual 1920x1080 DOM text/opacity/transform profile and frame range.
    const project=createProject('默认分镜文字精确重复性'),order=project.shotOrder;
    const moved=reorderShots(project,[order[2]!,order[0]!,order[1]!]);moved.revision=4;
    const created=await store.create(moved),result=await renderer.check(created.root,created.project,environment);
    assert.equal(result.ok,true,JSON.stringify(result.errors));assert.equal(result.frames.length,9);assert.equal(result.frames[0]?.frame,0);
    assert.equal(actualTextFlag,true,'the actual Chromium process must receive the text-only raster flag');assert.equal(options?.chromiumSandbox,true);
    assert.ok(options?.args?.includes('--run-all-compositor-stages-before-draw'),'complete each compositor stage before drawing the requested frame');
    for(const flag of ['--disable-gpu','--disable-gpu-compositing','--disable-webgl','--disable-3d-apis'])assert.ok(!options?.args?.includes(flag),'do not broaden the text fix to '+flag);
    assert.ok(result.frames.every(frame=>/^[a-f0-9]{64}$/.test(frame.sha256)),'strict captured PNG hashes remain available');
  }finally{await renderer.close();await rm(directory,{recursive:true,force:true});}
});
