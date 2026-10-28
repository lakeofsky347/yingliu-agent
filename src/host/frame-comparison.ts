import {inflateSync} from 'node:zlib';

export interface FramePixelComparison {
  pixelComparison:'equal'|'different'|'unavailable';
  width?:number;height?:number;differingPixels?:number;maxChannelDelta?:number;
  bounds?:{x:number;y:number;width:number;height:number};
}
interface DecodedPng {width:number;height:number;channels:3|4;pixels:Buffer}
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
// Diagnostics must remain bounded even for a malformed or oversized screenshot.
const maxDecodedBytes=128*1024*1024;
const crcTable=Uint32Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function crc32(bytes:Buffer){let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]!^(value>>>8);return (value^0xffffffff)>>>0;}
function paeth(left:number,up:number,corner:number){const predicted=left+up-corner,a=Math.abs(predicted-left),b=Math.abs(predicted-up),c=Math.abs(predicted-corner);return a<=b&&a<=c?left:b<=c?up:corner;}

/** Decode only the noninterlaced 8-bit RGB/RGBA format used by Chromium screenshots. */
function decodePng(bytes:Buffer):DecodedPng|undefined {
  if(bytes.length<33||!bytes.subarray(0,8).equals(signature))return;
  let offset=8,width=0,height=0,channels:3|4=4,header=false,ended=false,idatEnded=false,palette=false;
  const compressed:Buffer[]=[];
  while(offset<bytes.length){
    if(bytes.length-offset<12)return;
    const length=bytes.readUInt32BE(offset),end=offset+12+length;if(end>bytes.length)return;
    const typeBytes=bytes.subarray(offset+4,offset+8);if([...typeBytes].some(byte=>byte<65||byte>90&&byte<97||byte>122))return;
    const type=typeBytes.toString('ascii'),data=bytes.subarray(offset+8,end-4);
    if(crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))return;
    if(!header&&type!=='IHDR')return;
    if(compressed.length&&type!=='IDAT')idatEnded=true;
    if(type==='IHDR'){
      if(header||length!==13)return;header=true;width=data.readUInt32BE(0);height=data.readUInt32BE(4);
      if(!width||!height||data[8]!==8||![2,6].includes(data[9]!)||data[10]!==0||data[11]!==0||data[12]!==0)return;
      channels=data[9]===2?3:4;
      if(!Number.isSafeInteger((width*channels+1)*height)||(width*channels+1)*height>maxDecodedBytes)return;
    }else if(type==='IDAT'){
      if(idatEnded)return;compressed.push(data);
    }else if(type==='IEND'){
      if(length!==0||!compressed.length||end!==bytes.length)return;ended=true;break;
    }else if(type==='PLTE'){
      if(palette||compressed.length||length===0||length>768||length%3!==0)return;palette=true;
    }else if(['tRNS','acTL','fcTL','fdAT'].includes(type)||!(typeBytes[0]!&32))return;
    offset=end;
  }
  if(!ended)return;
  const stride=width*channels,filtered=inflateSync(Buffer.concat(compressed),{maxOutputLength:(stride+1)*height});
  if(filtered.length!==(stride+1)*height)return;
  const pixels=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++){
    const filter=filtered[y*(stride+1)]!;if(filter>4)return;
    for(let x=0;x<stride;x++){
      const at=y*stride+x,left=x>=channels?pixels[at-channels]!:0,up=y?pixels[at-stride]!:0,corner=y&&x>=channels?pixels[at-stride-channels]!:0;
      const predictor=filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):paeth(left,up,corner);
      pixels[at]=(filtered[y*(stride+1)+1+x]!+predictor)&255;
    }
  }
  return {width,height,channels,pixels};
}

/** Exact raw channel diagnostics only. Never replaces the renderer's PNG SHA-256 gate. */
export function compareFramePng(expected:Buffer,actual:Buffer):FramePixelComparison {
  try{
    const before=decodePng(expected),after=decodePng(actual);if(!before||!after)return {pixelComparison:'unavailable'};
    const {width,height}=after;if(before.width!==width||before.height!==height)return {pixelComparison:'different',width,height};
    let differingPixels=0,maxChannelDelta=0,minX=width,minY=height,maxX=-1,maxY=-1;
    for(let pixel=0;pixel<width*height;pixel++){
      let differs=false;
      for(let channel=0;channel<4;channel++){
        const a=channel===3&&before.channels===3?255:before.pixels[pixel*before.channels+channel]!;
        const b=channel===3&&after.channels===3?255:after.pixels[pixel*after.channels+channel]!;
        const delta=Math.abs(a-b);if(delta){differs=true;maxChannelDelta=Math.max(maxChannelDelta,delta);}
      }
      if(differs){differingPixels++;const x=pixel%width,y=Math.floor(pixel/width);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
    }
    return {pixelComparison:differingPixels?'different':'equal',width,height,differingPixels,maxChannelDelta,
      ...(differingPixels?{bounds:{x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1}}:{})};
  }catch{return {pixelComparison:'unavailable'};}
}
