import {imageSize} from 'image-size';
import {staticLogoFormat} from '../../../services/recipe-api/src/logo-format.mjs';

// Chromium may attach an sRGB ICC profile to canvas output. Unprofiled WebP also
// uses sRGB, so discard that ancillary chunk while keeping the encoded pixels.
function normalizedCanvasWebp(bytes:Buffer):Buffer{
  if(staticLogoFormat(bytes)!=='webp')throw new Error('本地 Logo 处理结果无效。');
  const chunks:Buffer[]=[];
  let hasProfile=false;
  for(let start=12;start<bytes.length;){
    const length=bytes.readUInt32LE(start+4),end=start+8+length+(length%2);
    const chunk=bytes.subarray(start,end);
    if(chunk.toString('ascii',0,4)==='ICCP')hasProfile=true;
    else chunks.push(chunk);
    start=end;
  }
  if(hasProfile){
    const header=Buffer.from(bytes.subarray(0,12));
    const extended=chunks.find(chunk=>chunk.toString('ascii',0,4)==='VP8X');
    if(!extended||!(extended[8]!&0x20))throw new Error('本地 Logo 色彩配置无效。');
    extended[8]=extended[8]!&~0x20;
    bytes=Buffer.concat([header,...chunks]);
    bytes.writeUInt32LE(bytes.length-8,4);
  }
  staticLogoFormat(bytes,true);
  return bytes;
}

/** Decode and encode in the existing sandboxed renderer; no upload or external URL is involved. */
export function localRecipeLogo(render:(script:string)=>Promise<unknown>,check:()=>void){
  return async(bytes:Buffer):Promise<Buffer>=>{
    check();if(!bytes.length||bytes.length>2097152)throw new Error('Logo 文件过大。');
    const format=staticLogoFormat(bytes);
    const size=imageSize(bytes);
    if(!size.width||!size.height||size.width>8192||size.height>8192||size.width*size.height>16777216)throw new Error('Logo 图片尺寸过大。');
    // The object service encodes published avatars as 192-pixel square WebP.
    // Reuse a clean original only after the renderer has decoded this same image.
    let publishedSizeWebp=false;
    if(format==='webp'&&bytes.length<=131072&&size.width===192&&size.height===192){
      try{staticLogoFormat(bytes,true);publishedSizeWebp=true;}catch{}
    }
    const data=JSON.stringify(bytes.toString('base64'));
    const result=await render(`(async()=>{
      const raw=atob(${data}),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
      const image=await createImageBitmap(new Blob([bytes]));
      try{
        if(${publishedSizeWebp}&&image.width===192&&image.height===192)return true;
        const scale=Math.min(1,512/image.width,512/image.height),canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
        const context=canvas.getContext('2d',{colorSpace:'srgb'});if(!context)throw new Error('本地图片处理不可用');
        context.drawImage(image,0,0,canvas.width,canvas.height);
        for(const quality of [0.9,0.75,0.55,0.35,0.2]){
          const encoded=canvas.toDataURL('image/webp',quality);
          if(encoded.startsWith('data:image/webp;base64,')&&atob(encoded.split(',')[1]).length<=131072)return encoded;
        }
        throw new Error('Logo 无法压缩到允许大小');
      }finally{image.close();}
    })()`);
    check();
    if(publishedSizeWebp&&result===true)return Buffer.from(bytes);
    if(typeof result!=='string'||!/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(result))throw new Error('本地 Logo 处理结果无效。');
    const encoded=result.slice('data:image/webp;base64,'.length),output=Buffer.from(encoded,'base64');
    if(output.toString('base64')!==encoded||!output.length||output.length>131072)throw new Error('本地 Logo 处理结果无效。');
    return normalizedCanvasWebp(output);
  };
}
