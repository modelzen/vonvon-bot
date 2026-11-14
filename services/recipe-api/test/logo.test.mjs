import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { normalizeLogo, verifyNormalizedLogo } from '../src/logo.mjs';

const image = (width,height,color='red') => sharp({create:{width,height,channels:4,background:color}});
const invalid = input => assert.rejects(normalizeLogo(input),e=>e.code === 'invalid_logo');

function pngChunk(type,data) {
  const header=Buffer.alloc(8),footer=Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  header.write(type,4,'latin1');
  let crc=0xffffffff;
  for(const byte of Buffer.concat([header.subarray(4),data])) {
    crc ^= byte;
    for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  }
  footer.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([header,data,footer]);
}
function pngParts(bytes) {
  const parts=[];
  for(let at=8;at<bytes.length;) {
    const n=bytes.readUInt32BE(at);
    parts.push({name:bytes.toString('latin1',at+4,at+8),data:bytes.subarray(at+8,at+8+n)});
    at+=12+n;
  }
  return parts;
}
async function animatedPng() {
  const [a,b]=await Promise.all(['red','blue'].map(c=>image(16,16,c).png().toBuffer()));
  const parts=pngParts(a), second=pngParts(b);
  const anim=Buffer.alloc(8); anim.writeUInt32BE(2);
  const control=sequence=>{
    const data=Buffer.alloc(26);
    data.writeUInt32BE(sequence); data.writeUInt32BE(16,4);data.writeUInt32BE(16,8);data.writeUInt16BE(1,20);data.writeUInt16BE(10,22);
    return pngChunk('fcTL',data);
  };
  const sequence=Buffer.alloc(4); sequence.writeUInt32BE(2);
  return Buffer.concat([a.subarray(0,8),pngChunk('IHDR',parts[0].data),pngChunk('acTL',anim),control(0),
    ...parts.filter(p=>p.name==='IDAT').map(p=>pngChunk('IDAT',p.data)),
    control(1),pngChunk('fdAT',Buffer.concat([sequence,...second.filter(p=>p.name==='IDAT').map(p=>p.data)])),
    pngChunk('IEND',Buffer.alloc(0))]);
}

test('Logo re-encodes static PNG/JPEG/WebP with no metadata and re-decodes the final bytes',async () => {
  for (const kind of ['png','jpeg','webp']) {
    const input=await image(240,120).withMetadata({orientation:6})[kind]().toBuffer();
    const normalized=await normalizeLogo(input);
    assert.ok(normalized.length<=131072);
    await verifyNormalizedLogo(normalized);
    const m=await sharp(normalized).metadata();
    assert.deepEqual([m.format,m.width,m.height,m.pages??1,m.exif,m.icc,m.xmp],['webp',192,192,1,undefined,undefined,undefined]);
  }
});

test('Logo rejects animation chunks, multiples, damaged images, document formats and both size limits',async () => {
  const apng=await animatedPng();
  assert.equal((await sharp(apng,{animated:true}).metadata()).pages??1,1);
  await invalid(apng);
  const frame=Buffer.alloc(16*16*4,255);
  const webp=await sharp(Buffer.concat([frame,Buffer.alloc(frame.length,80)]),{raw:{width:16,height:32,channels:4,pageHeight:16}})
    .webp({loop:0,delay:[50,50]}).toBuffer();
  assert.equal((await sharp(webp,{animated:true}).metadata()).pages,2);
  await invalid(webp);
  const jpeg=await image(10,10).jpeg().toBuffer();
  await invalid(Buffer.concat([jpeg,jpeg]));
  await invalid(Buffer.concat([jpeg.subarray(0,2),Buffer.from([255,226,0,6,77,80,70,0]),jpeg.subarray(2)]));
  await invalid(await image(2049,1).png().toBuffer());
  await invalid(Buffer.alloc(2*1024*1024+1));
  await invalid(Buffer.from('<svg/>')); await invalid('https://example.invalid/image');
  const png=await image(16,16).png().toBuffer();
  await invalid(png.subarray(0,-4));
  await assert.rejects(verifyNormalizedLogo(await image(192,192).withMetadata().webp().toBuffer()));
  await assert.rejects(verifyNormalizedLogo(await image(191,192).webp().toBuffer()));
});
