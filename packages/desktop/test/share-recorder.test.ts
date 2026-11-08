import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, ClipboardItem: class {}, clipboard: {}, ipcMain: {}, session: {}, shell: {} }));

import { shareCardChannels, type ShareTick } from '../src/share-contract.js';
import { ShareGifEncoder } from '../src/share-gif.js';
import { ShareError, ShareRecorder, type ShareEncoder } from '../src/share-recorder.js';
import { decodeGif } from './helpers/gif-decode.js';

const UI = 'file:///app/ui/index.html';
const LAYOUT = {
  width: 40, height: 30,
  badges: [{ x: 2, y: 6, width: 16, height: 20 }, { x: 22, y: 6, width: 16, height: 20 }],
  rail: { x: 0, y: 4, width: 40, height: 24, scrollWidth: 40, clientWidth: 40 },
};
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
type PageOptions = { ready?: 'never' | 'invalid'; crashAfterTicks?: number };

let folder = '';
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'vonvon-share-recorder-')); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

function harness(page: PageOptions = {}, timeoutMs?: number) {
  const handlers = new Map<string, Handler>();
  const order: string[] = [];
  const windows: FakeWindow[] = [];
  let nextId = 1;

  /** The share page as the recorder sees it: it asks for its model, reports its layout, then follows the clock. */
  class FakeContents extends EventEmitter {
    readonly id = nextId++;
    readonly mainFrame = { url: '' };
    size: [number, number] = [0, 0];
    time = 0;
    marker = 0;
    ticks = 0;
    model: unknown;
    readonly debugger = {
      attach: vi.fn(() => { order.push('attach'); }), isAttached: vi.fn(() => true), detach: vi.fn(),
      sendCommand: vi.fn(async (method: string, params?: object) => { order.push(params ? `${method} ${JSON.stringify(params)}` : method); }),
    };
    readonly sendInputEvent = vi.fn();
    readonly invalidate = vi.fn(() => this.paint());
    readonly loadURL = vi.fn(async (url: string) => {
      order.push(`load ${url}`);
      this.mainFrame.url = url;
      setTimeout(() => void this.run(), 0);
    });
    readonly executeJavaScript = vi.fn(async (code: string) => {
      if (code.includes('.begin(')) {
        order.push('begin');
        setTimeout(() => this.paint(), 0);
        return 0;
      }
      const tick = JSON.parse(code.slice(code.indexOf('(') + 1, code.lastIndexOf(')'))) as ShareTick;
      this.ticks++;
      this.time += tick.dt;
      if (page.crashAfterTicks === this.ticks) setTimeout(() => this.emit('render-process-gone'), 0);
      if (tick.marker !== undefined) {
        this.marker = tick.marker;
        setTimeout(() => this.paint(), 0);
      }
      return { scrollLeft: 0 };
    });
    private async run(): Promise<void> {
      const event = { sender: this, senderFrame: this.mainFrame };
      this.model = (await handlers.get(shareCardChannels.model)!(event) as { value: unknown }).value;
      if (page.ready === 'never') return;
      order.push(`ready ${JSON.stringify(await handlers.get(shareCardChannels.ready)!(event, page.ready === 'invalid' ? { width: -1 } : LAYOUT))}`);
    }
    /** A frame at scale 2: the card's shade follows the clock for half a second, then holds; the marker at the corner. */
    paint(): void {
      if (this.size[0] === 0) return;
      const width = this.size[0] * 2, height = this.size[1] * 2;
      const bitmap = Buffer.alloc(width * height * 4);
      const shade = Math.min(250, Math.round(this.time / 50) * 25);
      for (let i = 0; i < width * height; i++) bitmap.set([shade, 100, 200, 255], i * 4);
      const a = this.marker & 1 ? 255 : 0, b = this.marker & 2 ? 255 : 0;
      for (let y = height - 8; y < height; y++) for (let x = width - 8; x < width; x++) bitmap.set([a, b, a, 255], (y * width + x) * 4);
      this.emit('paint', {}, {}, { getSize: () => ({ width, height }), toBitmap: () => bitmap });
    }
  }
  class FakeWindow {
    readonly webContents = new FakeContents();
    destroyed = false;
    constructor(readonly options: { width: number; height: number; scale: number }) {}
    readonly setContentSize = vi.fn((width: number, height: number) => { order.push(`size ${width}x${height}`); this.webContents.size = [width, height]; });
    readonly isDestroyed = (): boolean => this.destroyed;
    readonly destroy = vi.fn(() => { this.destroyed = true; order.push('destroy'); });
  }

  const ipc = {
    handle: vi.fn((channel: string, handler: Handler) => { handlers.set(channel, handler); }),
    removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
  };
  const clipboard = { write: vi.fn(async (_items: unknown[]) => {}) };
  const reveal = vi.fn((_path: string) => {});
  const recorder = new ShareRecorder({
    ipc: ipc as never, uiUrl: UI,
    openWindow: options => { const window = new FakeWindow(options); windows.push(window); order.push(`open ${JSON.stringify(options)}`); return window; },
    encoder: (width, height): ShareEncoder => {
      const encoder = new ShareGifEncoder(width, height);
      return { frame: async (bgra, time) => encoder.add(new Uint8Array(bgra), time), finish: async (interval, hold) => encoder.finish(interval, hold), close: () => {} };
    },
    cardWidth: () => 700, folder,
    clipboard: { platform: 'darwin', clipboard, ClipboardItem: class { constructor(readonly entries: object) {} } as never, powershell: async () => {} },
    reveal, now: () => new Date(2026, 10, 8, 17, 39, 5), timeoutMs,
  });
  return { recorder, handlers, order, windows, ipc, clipboard, reveal };
}

describe('share recorder', () => {
  it('opens the card offscreen, freezes its timeline, steps it, encodes, and closes the window', async () => {
    const h = harness();
    const model = { title: '我的 AI 团队', bots: [{ name: 'Jojo' }] };
    const progress: number[] = [];
    const recording = await h.recorder.record(model, fraction => progress.push(fraction));
    const [window] = h.windows;
    expect(h.windows).toHaveLength(1);
    expect(window!.options).toEqual({ width: 700, height: 900, scale: 2 });
    expect(window!.webContents.model).toEqual(model);
    expect(h.order.slice(0, 9)).toEqual([
      'open {"width":700,"height":900,"scale":2}', `load ${UI}#share-card`, 'size 40x38', 'attach',
      'Emulation.setEmulatedMedia {"features":[{"name":"prefers-reduced-motion","value":"no-preference"}]}', 'Animation.enable',
      'begin', 'Animation.setPlaybackRate {"playbackRate":0}', 'ready {"ok":true}',
    ]);
    expect(h.order.at(-1)).toBe('destroy');
    expect(window!.destroy).toHaveBeenCalledOnce();
    // The pointer passed both badges; the page clock moved in 60 Hz steps and stopped once the card held still.
    const moves = window!.webContents.sendInputEvent.mock.calls.map(([input]) => input as { type: string; x: number });
    expect(moves.map(move => move.x)).toEqual(expect.arrayContaining([10, 30]));
    expect(window!.webContents.ticks % 3).toBe(0);
    expect(window!.webContents.time).toBeLessThan(3000);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));

    const gif = await h.recorder.bytes(recording.id);
    expect(recording).toMatchObject({ bytes: gif.length, width: 80, height: 60, sha256: createHash('sha256').update(gif).digest('hex') });
    const decoded = decodeGif(gif);
    expect(decoded).toMatchObject({ width: 80, height: 60 });
    // The finished card first; then the shade's ten 50 ms changes; the still tail merged into the last frame.
    expect(decoded.frames[0]!.delay).toBe(400);
    expect(decoded.frames.slice(1, 11).map(frame => frame.delay)).toEqual(Array(10).fill(50));
    for (const [i, value] of [200, 100, 250].entries()) expect(Math.abs(decoded.frames[0]!.rgba[i]! - value)).toBeLessThanOrEqual(8);
    expect(recording.durationMs).toBe(decoded.frames.reduce((sum, frame) => sum + frame.delay, 0));
  });

  it('closes the window when the card never says it is ready', async () => {
    const h = harness({ ready: 'never' }, 80);
    await expect(h.recorder.record({ bots: [] })).rejects.toMatchObject({ code: 'timeout', message: '生成分享图超时了，请重试。' });
    expect(h.windows[0]!.destroyed).toBe(true);
  });

  it('closes the window when the card reports a layout of no known shape', async () => {
    const h = harness({ ready: 'invalid' });
    await expect(h.recorder.record({ bots: [] })).rejects.toMatchObject({ code: 'card_failed' });
    expect(h.windows[0]!.destroyed).toBe(true);
  });

  it('closes the window when its renderer goes in the middle of recording', async () => {
    const h = harness({ crashAfterTicks: 5 });
    await expect(h.recorder.record({ bots: [] })).rejects.toBeInstanceOf(ShareError);
    expect(h.windows[0]!.destroyed).toBe(true);
    expect(h.windows[0]!.webContents.ticks).toBeLessThan(12);
  });

  it('records one at a time and refuses what is not a model', async () => {
    const h = harness();
    const first = h.recorder.record({ bots: [] });
    await expect(h.recorder.record({ bots: [] })).rejects.toMatchObject({ code: 'busy' });
    await first;
    await expect(h.recorder.record('text')).rejects.toMatchObject({ code: 'invalid_model' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(h.recorder.record(cyclic)).rejects.toMatchObject({ code: 'invalid_model' });
  });

  it('answers the card channels only for its own share window', async () => {
    const h = harness({ ready: 'never' }, 200);
    const recording = h.recorder.record({ secret: 'model' });
    await vi.waitFor(() => expect(h.windows[0]!.webContents.model).toBeDefined());
    const window = h.windows[0]!;
    const stranger = { sender: { id: 999 }, senderFrame: { url: `${UI}#share-card` } };
    expect(await h.handlers.get(shareCardChannels.model)!(stranger)).toEqual({ ok: false });
    const wrongFrame = { sender: window.webContents, senderFrame: { url: `${UI}#share-card` } };
    expect(await h.handlers.get(shareCardChannels.ready)!(wrongFrame, LAYOUT)).toEqual({ ok: false });
    await expect(recording).rejects.toMatchObject({ code: 'timeout' });
  });

  it('stops a recording and closes its window when the app quits', async () => {
    const h = harness({ ready: 'never' });
    const recording = h.recorder.record({ bots: [] });
    await vi.waitFor(() => expect(h.windows[0]!.webContents.model).toBeDefined());
    h.recorder.dispose();
    await expect(recording).rejects.toMatchObject({ code: 'disposed' });
    expect(h.windows[0]!.destroyed).toBe(true);
    expect(h.ipc.removeHandler.mock.calls.map(([channel]) => channel)).toEqual([shareCardChannels.model, shareCardChannels.ready]);
  });

  it('copies a recording into the share folder and onto the clipboard, reveals only its files, and forgets on discard', async () => {
    const h = harness();
    const { id } = await h.recorder.record({ bots: [] });
    const { path } = await h.recorder.copy(id);
    expect(path).toBe(join(folder, 'vonvon-share-20261108-173905.gif'));
    expect(h.clipboard.write).toHaveBeenCalledOnce();
    expect(await h.recorder.copy(id)).toEqual({ path });
    await h.recorder.reveal(path);
    expect(h.reveal).toHaveBeenCalledExactlyOnceWith(path);
    await expect(h.recorder.reveal(join(folder, '..', 'elsewhere.gif'))).rejects.toMatchObject({ code: 'not_found' });
    await h.recorder.discard(id);
    await expect(h.recorder.bytes(id)).rejects.toMatchObject({ code: 'unknown_recording' });
    await expect(h.recorder.copy(id)).rejects.toMatchObject({ code: 'unknown_recording' });
  });
});
