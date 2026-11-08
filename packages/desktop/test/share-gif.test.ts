import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { GifStream, ShareGifEncoder } from '../src/share-gif.js';
import { decodeGif } from './helpers/gif-decode.js';

const W = 40, H = 24;
/** A card-like frame: a pale background with a gradient band, and a dark square at `x`. */
function frame(x: number, format: 'rgba' | 'bgra' = 'rgba'): Uint8Array {
  const pixels = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let i = 0; i < W; i++) {
    const at = (y * W + i) * 4;
    const square = i >= x && i < x + 6 && y >= 8 && y < 14;
    const [r, g, b] = square ? [30, 40, 200] : y < 4 ? [200 + i, 120, 90] : [250, 248, 244];
    pixels.set(format === 'rgba' ? [r, g, b, 255] : [b, g, r, 255], at);
  }
  return pixels;
}
const pixel = (rgba: Uint8Array, x: number, y: number): number[] => [...rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
const near = (actual: number[], expected: number[]): void => {
  for (let i = 0; i < 3; i++) expect(Math.abs(actual[i]! - expected[i]!)).toBeLessThanOrEqual(8);
};

describe('share GIF stream', () => {
  it('puts the final frame first, then every frame with its animation-time delay, looping', () => {
    const stream = new GifStream(W, H);
    for (let i = 0; i <= 6; i++) stream.add(frame(i * 4), i * 50);
    const { gif, durationMs } = stream.finish(50, 400);
    const decoded = decodeGif(gif);
    expect(decoded).toMatchObject({ width: W, height: H, loops: true });
    expect(decoded.frames.map(f => f.delay)).toEqual([400, 50, 50, 50, 50, 50, 50, 50]);
    expect(durationMs).toBe(400 + 7 * 50);
    // The still preview is the finished card.
    near(pixel(decoded.frames[0]!.rgba, 25, 10), [30, 40, 200]);
    near(pixel(decoded.frames[1]!.rgba, 25, 10), [250, 248, 244]);
    near(pixel(decoded.frames[1]!.rgba, 2, 10), [30, 40, 200]);
    // Later frames carry only the rectangle that changed, and the composed picture is right.
    expect(decoded.frames[3]!.rect).toEqual({ left: 4, top: 8, width: 10, height: 6 });
    near(pixel(decoded.frames[3]!.rgba, 9, 10), [30, 40, 200]);
    near(pixel(decoded.frames[3]!.rgba, 5, 10), [250, 248, 244]);
    near(pixel(decoded.frames[3]!.rgba, 20, 1), [220, 120, 90]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) near(pixel(decoded.frames.at(-1)!.rgba, x, y), pixel(frame(24), x, y));
  });

  it('lets a frame like the one before only lengthen that one', () => {
    const stream = new GifStream(W, H);
    stream.add(frame(0), 0);
    stream.add(frame(0), 50);
    stream.add(frame(0), 100);
    stream.add(frame(8), 150);
    const decoded = decodeGif(stream.finish(50, 300).gif);
    expect(decoded.frames.map(f => f.delay)).toEqual([300, 150, 50]);
  });

  describe('after a frame too busy for one palette', () => {
    let seed = 7;
    const random = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const plain = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) plain.set([250, 248, 244, 255], i * 4);
    const busy = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) busy.set([random() * 256, random() * 256, random() * 256, 255].map(Math.floor), i * 4);
    const white = [5 * W + 30, 5 * W + 31, 6 * W + 30, 6 * W + 31];
    for (const i of white) busy.set([255, 255, 255, 255], i * 4);
    const after = plain.slice();
    for (const i of white) after.set([255, 255, 255, 255], i * 4);
    const off = (shown: Uint8Array, truth: Uint8Array, at: number[] = Array.from({ length: W * H }, (_, i) => i)): number =>
      Math.max(...at.map(i => Math.max(...[0, 1, 2].map(c => Math.abs(shown[i * 4 + c]! - truth[i * 4 + c]!)))));

    it('draws again what its palette drew off once frames are quieter, so no ghost stays', () => {
      const stream = new GifStream(W, H);
      [plain, busy, after, after, after].forEach((rgba, i) => stream.add(rgba, i * 50));
      const frames = decodeGif(stream.finish(50, 400).gif).frames;
      // The white patch did not change after the busy frame, which drew it off; the next frame puts it right.
      expect(off(frames[2]!.rgba, busy, white)).toBeGreaterThan(4);
      expect(off(frames[3]!.rgba, after)).toBeLessThanOrEqual(4);
      expect(frames.map(f => f.delay)).toEqual([400, 50, 50, 150]);
    });

    it('corrects a picture no palette fits a few times only, then lets it hold', () => {
      const stream = new GifStream(W, H);
      stream.add(plain, 0);
      for (let i = 1; i <= 10; i++) stream.add(busy, i * 50);
      expect(decodeGif(stream.finish(50, 400).gif).frames.map(f => f.delay)).toEqual([400, 50, 50, 50, 400]);
    });
  });

  it('builds 20 and 10 fps from the same BGRA frames, both ending on the last one', () => {
    const encoder = new ShareGifEncoder(W, H);
    for (let i = 0; i <= 5; i++) encoder.add(frame(i * 5, 'bgra'), i * 50);
    const [full, half] = encoder.finish(50, 400);
    const fullFrames = decodeGif(full!.gif).frames, halfFrames = decodeGif(half!.gif).frames;
    expect([full!.fps, half!.fps]).toEqual([20, 10]);
    expect(fullFrames.map(f => f.delay)).toEqual([400, 50, 50, 50, 50, 50, 50]);
    expect(halfFrames.map(f => f.delay)).toEqual([400, 100, 100, 50, 50]);
    expect(full!.durationMs).toBe(half!.durationMs);
    near(pixel(halfFrames.at(-1)!.rgba, 27, 10), [30, 40, 200]);
    near(pixel(fullFrames[0]!.rgba, 27, 10), [30, 40, 200]);
    expect(half!.gif.length).toBeLessThan(full!.gif.length);
  });

  it('ships gifenc\'s license with the app, in the notices the UI carries', () => {
    const license = readFileSync(createRequire(import.meta.url).resolve('gifenc/LICENSE.md'), 'utf8').trim();
    const notices = readFileSync(new URL('../../ui/public/THIRD-PARTY-NOTICES.txt', import.meta.url), 'utf8');
    expect(license).toContain('Copyright (c) 2017 Matt DesLauriers');
    expect(notices).toContain(license);
  });
});
