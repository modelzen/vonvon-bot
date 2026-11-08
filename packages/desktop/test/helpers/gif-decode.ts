/** A small GIF89a decoder for tests: each frame composed onto the canvas as a viewer shows it (disposal 0 and 1, and
 * transparency, which is all the share GIF uses). */
export type DecodedFrame = { delay: number; rect: { left: number; top: number; width: number; height: number }; rgba: Uint8Array };
export type DecodedGif = { width: number; height: number; loops: boolean; frames: DecodedFrame[] };

function lzw(data: Uint8Array, minSize: number, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels);
  const clear = 1 << minSize, end = clear + 1;
  let size = minSize + 1, next = end + 1, at = 0, bits = 0, buffer = 0, previous = -1;
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), length = new Int32Array(4096);
  for (let i = 0; i < clear; i++) { suffix[i] = i; first[i] = i; length[i] = 1; prefix[i] = -1; }
  const emit = (code: number): void => {
    for (let i = length[code]! - 1, c = code; i >= 0; i--, c = prefix[c]!) if (at + i < pixels) out[at + i] = suffix[c]!;
    at += length[code]!;
  };
  for (const byte of data) {
    buffer |= byte << bits;
    bits += 8;
    while (bits >= size) {
      const code = buffer & ((1 << size) - 1);
      buffer >>= size;
      bits -= size;
      if (code === clear) { size = minSize + 1; next = end + 1; previous = -1; continue; }
      if (code === end) return out;
      if (previous === -1) { emit(code); previous = code; continue; }
      const known = code < next;
      const head = known ? first[code]! : first[previous]!;
      if (next < 4096) {
        prefix[next] = previous; suffix[next] = head; first[next] = first[previous]!; length[next] = length[previous]! + 1;
        next++;
        if (next === 1 << size && size < 12) size++;
      }
      emit(known ? code : next - 1);
      previous = code;
    }
  }
  return out;
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  let at = 0;
  const u16 = (): number => { const value = bytes[at]! | bytes[at + 1]! << 8; at += 2; return value; };
  const table = (flags: number): number[][] => {
    const colours: number[][] = [];
    for (let i = 0; i < 1 << ((flags & 7) + 1); i++, at += 3) colours.push([bytes[at]!, bytes[at + 1]!, bytes[at + 2]!]);
    return colours;
  };
  const blocks = (): Uint8Array => {
    const parts: number[] = [];
    for (let size = bytes[at++]!; size > 0; size = bytes[at++]!) { parts.push(...bytes.subarray(at, at + size)); at += size; }
    return Uint8Array.from(parts);
  };
  if (String.fromCharCode(...bytes.subarray(0, 6)) !== 'GIF89a') throw new Error('not a GIF89a');
  at = 6;
  const width = u16(), height = u16(), flags = bytes[at]!;
  at += 3;
  const global = flags & 0x80 ? table(flags) : [];
  const canvas = new Uint8Array(width * height * 4);
  const frames: DecodedFrame[] = [];
  let control = { delay: 0, transparent: -1 }, loops = false;
  for (;;) {
    const kind = bytes[at++];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = bytes[at++];
      const body = blocks();
      if (label === 0xf9) control = { delay: (body[1]! | body[2]! << 8) * 10, transparent: body[0]! & 1 ? body[3]! : -1 };
      if (label === 0xff && String.fromCharCode(...body.subarray(0, 11)) === 'NETSCAPE2.0') loops = true;
      continue;
    }
    if (kind !== 0x2c) throw new Error(`unexpected block ${kind}`);
    const left = u16(), top = u16(), w = u16(), h = u16(), local = bytes[at++]!;
    const colours = local & 0x80 ? table(local) : global;
    const minSize = bytes[at++]!;
    const index = lzw(blocks(), minSize, w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const value = index[y * w + x]!;
      if (value === control.transparent) continue;
      const colour = colours[value]!, out = ((top + y) * width + left + x) * 4;
      canvas[out] = colour[0]!; canvas[out + 1] = colour[1]!; canvas[out + 2] = colour[2]!; canvas[out + 3] = 255;
    }
    frames.push({ delay: control.delay, rect: { left, top, width: w, height: h }, rgba: canvas.slice() });
    control = { delay: 0, transparent: -1 };
  }
  return { width, height, loops, frames };
}
