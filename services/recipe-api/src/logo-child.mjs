import sharp from 'sharp';
import { staticLogoFormat } from './logo-format.mjs';

sharp.cache(false);
sharp.concurrency(1);
const options = {limitInputPixels:4194304,failOn:'warning'};
try {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > 2097152) throw new Error();
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks,total);
  const check = process.argv[2] === 'check';
  const expected = staticLogoFormat(data, check);
  const metadata = await sharp(data,options).metadata();
  if (metadata.format !== expected || (metadata.pages ?? 1) !== 1 ||
    metadata.width < 1 || metadata.height < 1 || metadata.width > 2048 || metadata.height > 2048) throw new Error();
  if (check) {
    if (total > 131072 || metadata.width !== 192 || metadata.height !== 192) throw new Error();
    await sharp(data,options).raw().toBuffer();
  } else {
    const out = await sharp(data,options).toColourspace('srgb').rotate().resize(192,192,{fit:'cover',position:'centre'})
      .webp({quality:85,effort:3}).timeout({seconds:3}).toBuffer();
    if (out.length > 131072) throw new Error();
    staticLogoFormat(out,true);
    process.stdout.write(out);
  }
} catch { process.exitCode = 2; }
