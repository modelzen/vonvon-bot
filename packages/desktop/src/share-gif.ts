import { GIFEncoder, applyPalette, quantize, type Palette } from 'gifenc';

export type ShareGifVariant = { fps: number; gif: Uint8Array; durationMs: number };

/** Writes one frame with gifenc, which always places it at the top left, then moves it to `left`, `top`. In the bytes
 * of a frame that is not the first, the graphic control extension takes 8 bytes and the image descriptor follows. */
function frameBytes(index: Uint8Array, width: number, height: number, palette: Palette, left: number, top: number, transparentIndex?: number): Uint8Array {
  const encoder = GIFEncoder({ auto: false, initialCapacity: index.length / 2 + 1024 });
  encoder.writeFrame(index, width, height, transparentIndex === undefined
    ? { palette, dispose: 1 }
    : { palette, dispose: 1, transparent: true, transparentIndex });
  const bytes = encoder.bytes();
  if (bytes[8] !== 0x2c) throw new Error('Unexpected GIF frame layout');
  bytes[9] = left & 0xff; bytes[10] = left >> 8;
  bytes[11] = top & 0xff; bytes[12] = top >> 8;
  return bytes;
}
function setDelay(bytes: Uint8Array, ms: number, offset = 0): void {
  const units = Math.max(2, Math.round(ms / 10));
  bytes[offset + 4] = units & 0xff;
  bytes[offset + 5] = units >> 8;
}

/** Levels a shown pixel may be off its frame's colour in any channel before it is drawn again: more than palette
 * rounding of a near-exact palette (two colours sharing an rgb565 bin average at most 4 off), less than a visible
 * off-white. */
const TOLERANCE = 4;
/** Draws of one colour of a pixel at most: content no palette fits (a photo, noise) is not redrawn every frame. */
const DRAWS = 3;

/**
 * A GIF built frame by frame, each frame only the rectangle that changed, with the pixels inside it that did not change
 * left transparent: the badges flip one at a time and most of the card stays still, so frames stay small. Each frame
 * has its own palette of what changed, so no colour is approximated for the whole GIF at once. "Changed" is measured
 * against what the GIF shows, not the frame before: a pixel a busy frame's palette drew off is drawn again in a later,
 * quieter frame instead of staying wrong (a few times at most).
 */
export class GifStream {
  private shown: Uint8Array | undefined;
  private previous: Uint32Array | undefined;
  private readonly draws: Uint8Array;
  private previousRgba: Uint8Array | undefined;
  private readonly chunks: { bytes: Uint8Array; time: number }[] = [];
  private lastTime = 0;

  constructor(readonly width: number, readonly height: number) { this.draws = new Uint8Array(width * height); }

  /** `rgba` is opaque; `time` in animation milliseconds. A frame the GIF already shows only lengthens the one before. */
  add(rgba: Uint8Array, time: number): void {
    const { width, height } = this;
    if (rgba.length !== width * height * 4) throw new Error('GIF frame of the wrong size');
    const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
    const before = this.previous, draws = this.draws;
    this.previous = pixels;
    this.previousRgba = rgba;
    this.lastTime = time;
    const shown = this.shown;
    if (!shown || !before) {
      const palette = quantize(rgba, 256);
      const index = applyPalette(rgba, palette);
      this.shown = new Uint8Array(rgba.length);
      for (let i = 0; i < index.length; i++) this.shown.set(palette[index[i]!]!, i * 4);
      draws.fill(1);
      this.chunks.push({ bytes: frameBytes(index, width, height, palette, 0, 0), time });
      return;
    }
    const off = (i: number): boolean => {
      const at = i * 4;
      return Math.abs(rgba[at]! - shown[at]!) > TOLERANCE || Math.abs(rgba[at + 1]! - shown[at + 1]!) > TOLERANCE ||
        Math.abs(rgba[at + 2]! - shown[at + 2]!) > TOLERANCE;
    };
    const redraw = new Uint8Array(width * height);
    let left = width, right = -1, top = height, bottom = -1, changed = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0, i = y * width; x < width; x++, i++) {
        if (pixels[i] !== before[i]) draws[i] = 0;
        if (draws[i]! >= DRAWS || !off(i)) continue;
        draws[i]!++;
        redraw[i] = 1;
        changed++;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        bottom = y;
      }
    }
    if (changed === 0) return;
    const boxWidth = right - left + 1, boxHeight = bottom - top + 1;
    const colours = new Uint8Array(changed * 4);
    for (let y = top, j = 0; y <= bottom; y++) {
      for (let i = y * width + left; i <= y * width + right; i++) {
        if (!redraw[i]) continue;
        colours.set(rgba.subarray(i * 4, i * 4 + 4), j);
        j += 4;
      }
    }
    const palette = quantize(colours, 255);
    const mapped = applyPalette(colours, palette);
    const transparent = palette.length;
    const index = new Uint8Array(boxWidth * boxHeight).fill(transparent);
    for (let y = top, j = 0, k = 0; y <= bottom; y++) {
      for (let i = y * width + left; i <= y * width + right; i++, k++) {
        if (!redraw[i]) continue;
        index[k] = mapped[j]!;
        shown.set(palette[mapped[j++]!]!, i * 4);
      }
    }
    this.chunks.push({ bytes: frameBytes(index, boxWidth, boxHeight, [...palette, [0, 0, 0]], left, top, transparent), time });
  }

  /** The GIF, looping: first the last frame added (so a still preview shows the finished card) for `hold` ms, then
   * every frame in order, the last one lasting `interval`. */
  finish(interval: number, hold: number): { gif: Uint8Array; durationMs: number } {
    const final = this.previousRgba;
    if (!final) throw new Error('GIF without frames');
    const { width, height, chunks } = this;
    const head = GIFEncoder({ auto: false, initialCapacity: width * height });
    head.writeHeader();
    const palette = quantize(final, 256);
    head.writeFrame(applyPalette(final, palette), width, height, { first: true, palette, repeat: 0, delay: hold, dispose: 1 });
    const parts = [head.bytes()];
    const end = this.lastTime + interval;
    chunks.forEach((chunk, i) => {
      setDelay(chunk.bytes, (chunks[i + 1]?.time ?? end) - chunk.time);
      parts.push(chunk.bytes);
    });
    parts.push(Uint8Array.of(0x3b));
    const gif = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) { gif.set(part, at); at += part.length; }
    return { gif, durationMs: hold + end - chunks[0]!.time };
  }
}

/** BGRA, as Chromium paints, to opaque RGBA, in place. */
export function bgraToRgba(pixels: Uint8Array): Uint8Array {
  for (let i = 0; i < pixels.length; i += 4) {
    const blue = pixels[i]!;
    pixels[i] = pixels[i + 2]!;
    pixels[i + 2] = blue;
    pixels[i + 3] = 255;
  }
  return pixels;
}

/** The GIF at 20 fps and at 10, built side by side, so one too big at the full rate is ready at half without
 * recording again. Frames come in as BGRA. */
export class ShareGifEncoder {
  private readonly full: GifStream;
  private readonly half: GifStream;
  private count = 0;
  private last: { rgba: Uint8Array; time: number; inHalf: boolean } | undefined;

  constructor(width: number, height: number) {
    this.full = new GifStream(width, height);
    this.half = new GifStream(width, height);
  }

  add(bgra: Uint8Array, time: number): void {
    const rgba = bgraToRgba(bgra);
    this.full.add(rgba, time);
    const inHalf = this.count++ % 2 === 0;
    if (inHalf) this.half.add(rgba, time);
    this.last = { rgba, time, inHalf };
  }

  finish(interval: number, hold: number): ShareGifVariant[] {
    if (this.last && !this.last.inHalf) this.half.add(this.last.rgba, this.last.time);
    return [{ fps: 20, ...this.full.finish(interval, hold) }, { fps: 10, ...this.half.finish(interval, hold) }];
  }
}
