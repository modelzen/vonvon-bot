const pngSignature = Buffer.from([137,80,78,71,13,10,26,10]);
const invalid = () => { throw new Error('invalid_logo'); };

function staticPng(b) {
  let offset = 8;
  while (offset + 12 <= b.length) {
    const size = b.readUInt32BE(offset);
    const type = b.toString('latin1',offset+4,offset+8);
    if (size > b.length-offset-12 || ['acTL','fcTL','fdAT'].includes(type)) invalid();
    offset += size+12;
    if (type === 'IEND') return size === 0 && offset === b.length ? 'png' : invalid();
  }
  invalid();
}

function staticWebp(b, normalized) {
  if (b.readUInt32LE(4) !== b.length-8) invalid();
  let offset = 12;
  let frames = 0;
  while (offset+8 <= b.length) {
    const type = b.toString('latin1',offset,offset+4);
    const size = b.readUInt32LE(offset+4);
    if (size > b.length-offset-8 || ['ANIM','ANMF'].includes(type)) invalid();
    if (type === 'VP8X' && (size !== 10 || (b[offset+8] & 2))) invalid();
    if (normalized && !['VP8X','ALPH','VP8 ','VP8L'].includes(type)) invalid();
    if (['VP8 ','VP8L'].includes(type)) frames++;
    offset += 8 + size + size%2;
  }
  if (offset !== b.length || frames !== 1) invalid();
  return 'webp';
}

function staticJpeg(b) {
  let offset = 2;
  let scan = false;
  while (offset < b.length) {
    if (scan) offset = b.indexOf(0xff,offset);
    if (offset < 0 || b[offset++] !== 0xff) invalid();
    while (b[offset] === 0xff) offset++;
    const marker = b[offset++];
    if (scan && (marker === 0 || marker >= 0xd0 && marker <= 0xd7)) continue;
    scan = false;
    if (marker === 0xd9) return offset === b.length ? 'jpeg' : invalid();
    if (marker === 0 || marker === 0xd8 || marker === undefined || offset+2 > b.length) invalid();
    const size = b.readUInt16BE(offset);
    if (size < 2 || offset+size > b.length) invalid();
    if (marker === 0xe2 && b.toString('latin1',offset+2,offset+6) === 'MPF\0') invalid();
    offset += size;
    scan = marker === 0xda;
  }
  invalid();
}

export function staticLogoFormat(b, normalized = false) {
  if (b.length >= 12 && b.toString('latin1',0,4) === 'RIFF' && b.toString('latin1',8,12) === 'WEBP') {
    return staticWebp(b,normalized);
  }
  if (normalized) invalid();
  if (b.subarray(0,8).equals(pngSignature)) return staticPng(b);
  if (b[0] === 0xff && b[1] === 0xd8) return staticJpeg(b);
  invalid();
}
