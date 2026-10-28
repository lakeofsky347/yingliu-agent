import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {compareFramePng} from '../src/host/frame-comparison.ts';

const signature=Buffer.from([137,80,78,71,13,10,26,10]);
// Independent bitwise fixture CRC, deliberately separate from the table decoder.
function chunk(type:string,data:Buffer){const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}const prefix=Buffer.alloc(4),suffix=Buffer.alloc(4);prefix.writeUInt32BE(data.length);suffix.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([prefix,body,suffix]);}
function header(width:number,height:number,channels:3|4){const data=Buffer.alloc(13);data.writeUInt32BE(width);data.writeUInt32BE(height,4);data[8]=8;data[9]=channels===3?2:6;return data;}
function png(width:number,height:number,pixels:Buffer,options:{channels?:3|4;filter?:number;level?:number;split?:boolean;extra?:Buffer;header?:Buffer;filtered?:Buffer}={}){
  const channels=options.channels??4,stride=width*channels,filtered=Buffer.alloc((stride+1)*height),filter=options.filter??0;
  for(let y=0;y<height;y++){
    filtered[y*(stride+1)]=filter;
    for(let x=0;x<stride;x++){
      const at=y*stride+x,a=x>=channels?pixels[at-channels]!:0,b=y?pixels[at-stride]!:0,c=y&&x>=channels?pixels[at-stride-channels]!:0;
      const candidates=[a,b,c],distance=candidates.map(value=>Math.abs(a+b-c-value)),paeth=candidates[distance.indexOf(Math.min(...distance))]!;
      const predictor=[0,a,b,Math.floor((a+b)/2),paeth][filter]??0;
      filtered[y*(stride+1)+1+x]=(pixels[at]!-predictor)&255;
    }
  }
  const compressed=deflateSync(options.filtered??filtered,{level:options.level??6}),middle=Math.floor(compressed.length/2);
  return Buffer.concat([signature,chunk('IHDR',options.header??header(width,height,channels)),...(options.extra?[options.extra]:[]),...(options.split?[chunk('IDAT',compressed.subarray(0,middle)),chunk('IDAT',compressed.subarray(middle))]:[chunk('IDAT',compressed)]),chunk('IEND',Buffer.alloc(0))]);
}
function pixels(width:number,height:number,channels=4){return Buffer.from(Array.from({length:width*height*channels},(_,index)=>(Math.floor(index/channels)*67+Math.floor(index/(width*channels))*41+index%channels*23)%256));}

test('exact RGBA difference counts pixels once and includes alpha in the maximum and bounds',()=>{
  const before=pixels(3,2),after=Buffer.from(before);after[4]=after[4]!+7;after[5]=after[5]!+2;after[23]=after[23]!-10;
  assert.deepEqual(compareFramePng(png(3,2,before),png(3,2,after)),{pixelComparison:'different',width:3,height:2,differingPixels:2,maxChannelDelta:10,bounds:{x:1,y:0,width:2,height:2}});
});
test('different PNG compression, IDAT chunking and text metadata do not invent pixel differences',()=>{
  const raw=pixels(4,3),before=png(4,3,raw,{level:0}),after=png(4,3,raw,{level:9,split:true,extra:chunk('tEXt',Buffer.from('fixture\0synthetic only'))});assert.notDeepEqual(before,after);
  assert.deepEqual(compareFramePng(before,after),{pixelComparison:'equal',width:4,height:3,differingPixels:0,maxChannelDelta:0});
});
for(const channels of [3,4] as const)for(let filter=0;filter<=4;filter++)test(`${channels===3?'RGB':'RGBA'} filter ${filter} decodes every row exactly`,()=>{
  const raw=pixels(4,3,channels),result=compareFramePng(png(4,3,raw,{channels}),png(4,3,raw,{channels,filter}));assert.deepEqual(result,{pixelComparison:'equal',width:4,height:3,differingPixels:0,maxChannelDelta:0});
});
test('RGB is compared with opaque alpha against RGBA',()=>{
  const rgb=Buffer.from([10,20,30,40,50,60]),rgba=Buffer.from([10,20,30,255,40,50,60,255]);assert.equal(compareFramePng(png(2,1,rgb,{channels:3}),png(2,1,rgba)).pixelComparison,'equal');
});
test('dimension mismatch remains different without invented pixel counts',()=>{
  assert.deepEqual(compareFramePng(png(1,1,pixels(1,1)),png(2,1,pixels(2,1))),{pixelComparison:'different',width:2,height:1});
});
test('malformed or unsupported screenshots close to unavailable without throwing',()=>{
  const raw=pixels(1,1),valid=png(1,1,raw),badCrc=Buffer.from(valid);badCrc[29]=badCrc[29]!^1;
  const bitDepth=header(1,1,4);bitDepth[8]=16;const interlaced=header(1,1,4);interlaced[12]=1;const indexed=header(1,1,4);indexed[9]=3;const oversized=header(0x7fffffff,0x7fffffff,4);
  const broken=[Buffer.alloc(0),Buffer.from('not a PNG'),valid.subarray(0,valid.length-1),badCrc,png(1,1,raw,{header:bitDepth}),png(1,1,raw,{header:interlaced}),png(1,1,raw,{header:indexed}),png(1,1,raw,{header:oversized}),png(1,1,raw,{filter:5}),png(1,1,raw,{filtered:Buffer.alloc(4)}),png(1,1,raw,{filtered:Buffer.alloc(6)}),png(1,1,raw,{extra:chunk('tRNS',Buffer.alloc(6))}),png(1,1,raw,{extra:chunk('acTL',Buffer.alloc(8))}),png(1,1,raw,{extra:chunk('ABCD',Buffer.alloc(0))}),Buffer.concat([valid,Buffer.from([0])])];
  for(const value of broken){assert.deepEqual(compareFramePng(valid,value),{pixelComparison:'unavailable'});assert.deepEqual(compareFramePng(value,valid),{pixelComparison:'unavailable'});}
});
