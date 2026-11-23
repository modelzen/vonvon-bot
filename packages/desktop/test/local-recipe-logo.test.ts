import {expect,it,vi} from 'vitest';
import {localRecipeLogo} from '../src/local-recipe-logo';

const webp=Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=','base64');

it('passes only embedded image bytes to the local renderer and validates its static WebP result',async()=>{
  const render=vi.fn(async()=> 'data:image/webp;base64,'+webp.toString('base64'));
  const check=vi.fn();
  expect(await localRecipeLogo(render,check)(webp)).toEqual(webp);
  expect(check).toHaveBeenCalledTimes(2);
  expect(render).toHaveBeenCalledOnce();
  expect(render.mock.calls[0]).toBeDefined();
});

it.each([Buffer.alloc(0),Buffer.alloc(2097153),Buffer.from('<svg onload="fetch(1)"></svg>')])('rejects invalid image input before invoking the renderer',async bytes=>{
  const render=vi.fn();
  await expect(localRecipeLogo(render,()=>{})(bytes)).rejects.toThrow();
  expect(render).not.toHaveBeenCalled();
});

it.each(['data:image/png;base64,AAAA','data:image/webp;base64,AAAA','https://example.invalid/logo.webp'])('rejects an invalid renderer result without a network fallback',async output=>{
  await expect(localRecipeLogo(async()=>output,()=>{})(webp)).rejects.toThrow();
});

it('does not return decoded bytes after the source document is revoked during rendering',async()=>{
  let active=true;
  const normalize=localRecipeLogo(async()=>{active=false;return 'data:image/webp;base64,'+webp.toString('base64');},()=>{if(!active)throw Error('revoked');});
  await expect(normalize(webp)).rejects.toThrow('revoked');
});

function profiledCanvasWebp(tag:string){
  const extended=Buffer.alloc(18);extended.write('VP8X');extended.writeUInt32LE(10,4);
  extended[8]=0x20;extended[12]=1;extended[15]=1;
  const metadata=Buffer.alloc(12);metadata.write(tag);metadata.writeUInt32LE(3,4);metadata.write('ICC',8);
  const bytes=Buffer.concat([webp.subarray(0,12),extended,metadata,webp.subarray(12)]);
  bytes.writeUInt32LE(bytes.length-8,4);return bytes;
}

it('strips the Chromium sRGB profile and repairs both headers without re-encoding pixels',async()=>{
  const input=profiledCanvasWebp('ICCP');
  const result=await localRecipeLogo(async()=> 'data:image/webp;base64,'+input.toString('base64'),()=>{})(webp);
  expect(result.readUInt32LE(4)).toBe(result.length-8);
  expect(result.toString('ascii',12,16)).toBe('VP8X');
  expect(result[20]).toBe(0);
  expect(result.subarray(30)).toEqual(webp.subarray(12));
});

it('continues rejecting renderer metadata outside the expected sRGB profile',async()=>{
  const input=profiledCanvasWebp('EXIF');
  await expect(localRecipeLogo(async()=> 'data:image/webp;base64,'+input.toString('base64'),()=>{})(webp)).rejects.toThrow();
});

it('reuses a metadata-free published-size image only after successful renderer decoding',async()=>{
  const avatar=Buffer.from('UklGRiYAAABXRUJQVlA4TBkAAAAvv8AvAAfQ//73v/8BIUHC//cmI/qf9r8/AA==','base64');
  const render=vi.fn(async()=>true);
  expect(await localRecipeLogo(render,()=>{})(avatar)).toEqual(avatar);
  expect(render).toHaveBeenCalledOnce();
  await expect(localRecipeLogo(async()=>{throw Error('decode failed');},()=>{})(avatar)).rejects.toThrow('decode failed');
  await expect(localRecipeLogo(render,()=>{})(webp)).rejects.toThrow();
});
