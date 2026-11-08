// The part of gifenc 1.0.3 (MIT) the share GIF uses; the package ships no types.
declare module 'gifenc' {
  export type Palette = number[][];
  export type FrameOptions = {
    palette?: Palette; delay?: number; repeat?: number; first?: boolean;
    transparent?: boolean; transparentIndex?: number; dispose?: number;
  };
  export interface Encoder {
    writeHeader(): void;
    writeFrame(index: Uint8Array, width: number, height: number, options?: FrameOptions): void;
    bytes(): Uint8Array;
  }
  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): Encoder;
  export function quantize(rgba: Uint8Array, maxColors: number): Palette;
  export function applyPalette(rgba: Uint8Array, palette: Palette): Uint8Array;
}
