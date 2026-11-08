import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { BrowserWindow, clipboard, ClipboardItem, ipcMain, session, shell, type IpcMain, type IpcMainInvokeEvent, type MouseWheelInputEvent } from 'electron';
import { z } from 'zod';
import { SHARE_GIF_MAX_BYTES } from '@vonvon/protocol';
import type { ShareLayout, ShareRecording } from '../../ui/src/client-context.js';
import { SHARE_FRAME_MS, SHARE_FRAME_STEPS, SHARE_MARKER_STRIP, SHARE_STEP_MS, shareCardChannels, type ShareTick, type ShareTickResult } from './share-contract.js';
import { putShareOnClipboard, ownShareFile, runWindowsPowerShell, writeShareFile, type ShareClipboard } from './share-files.js';
import type { ShareGifVariant } from './share-gif.js';
import type { ShareWorkerReply, ShareWorkerRequest } from './share-gif-worker.js';
import { pointerScript, SHARE_MAX_MS, SHARE_SETTLE_MS, type ShareInput } from './share-script.js';

const TIMEOUT_MS = 60_000;
/** The size to aim for; {@link SHARE_GIF_MAX_BYTES} (Feishu's image limit) is the most there may be. */
const TARGET_BYTES = 5 * 1024 * 1024;
/** How long the GIF's first frame, the finished card, shows before the motion starts again. */
const HOLD_MS = 400;
/** Device pixels per captured frame at most: a card that big is captured at a lower scale. */
const MAX_PIXELS = 8_000_000;
/** Below one device pixel per CSS pixel the card's small type stops being readable. */
const MIN_SCALE = 1;
const MODEL_MAX = 8 * 1024 * 1024;
const KEPT = 4;

const shareText = {
  busy: '正在生成另一张分享图，请稍候再试。',
  invalid_model: '分享的内容不对，没能生成分享图。',
  timeout: '生成分享图超时了，请重试。',
  card_failed: '分享图没能画出来，请重试。',
  too_large: '分享图超过 10 MB 了。少选几项内容再试一次。',
  unknown_recording: '这张分享图已经失效，请重新生成。',
  file_failed: '分享图没能保存，请检查磁盘空间后重试。',
  clipboard_failed: '分享图已保存，但没能放进剪贴板，请重试。',
  not_found: '找不到这张分享图了，请重新复制。',
  disposed: 'Vonvon Bot 正在退出。',
} as const;
export type ShareErrorCode = keyof typeof shareText;
/** A share failure the page may show as it is. */
export class ShareError extends Error {
  constructor(readonly code: ShareErrorCode, options?: { cause?: unknown }) { super(shareText[code], options); this.name = 'ShareError'; }
}

const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() });
const layoutSchema = z.object({
  width: z.number().finite().min(16).max(4096), height: z.number().finite().min(16).max(8192),
  badges: z.array(rect).max(500),
  rail: rect.extend({ scrollWidth: z.number().finite().nonnegative(), clientWidth: z.number().finite().nonnegative() }),
});

/** What the recorder drives of an offscreen BrowserWindow, so tests can stand in for one. */
export interface ShareWindow {
  readonly webContents: ShareContents;
  setContentSize(width: number, height: number): void;
  isDestroyed(): boolean;
  destroy(): void;
}
export interface ShareContents {
  readonly id: number;
  readonly mainFrame: { url: string } | null | undefined;
  readonly debugger: { attach(version?: string): void; isAttached(): boolean; detach(): void; sendCommand(method: string, params?: object): Promise<unknown> };
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string): Promise<unknown>;
  sendInputEvent(event: ShareInput): void;
  invalidate(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}
type PaintedImage = { getSize(): { width: number; height: number }; toBitmap(): Buffer };
export interface ShareEncoder {
  /** Takes over `bgra`'s buffer; resolves once the encoder can take another frame. */
  frame(bgra: Buffer, time: number): Promise<void>;
  finish(interval: number, hold: number): Promise<ShareGifVariant[]>;
  close(): void;
}
export type ShareRecorderDeps = {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  /** The UI's index.html as a file URL; the share window loads it with `#share-card`. */
  uiUrl: string;
  openWindow(options: { width: number; height: number; scale: number }): ShareWindow;
  encoder(width: number, height: number): ShareEncoder;
  /** CSS pixels: the width of the app's content area, which the card is laid out at. */
  cardWidth(): number;
  /** The app's own share folder, under its userData. */
  folder: string;
  clipboard: ShareClipboard;
  reveal(path: string): void;
  now?: () => Date;
  timeoutMs?: number;
};

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
type Card = { contents: ShareContents; json: string; layout: Deferred<ShareLayout>; begun: Deferred<void>; failed: Deferred<never> };
type Kept = { recording: ShareRecording; gif: Buffer; path?: string };
/** This scale makes frames bigger than {@link MAX_PIXELS}; the pass starts over at `scale`. */
class Rescale extends Error { constructor(readonly scale: number) { super('rescale'); } }

/** The marker frame `index` painted, read from the bottom right of the bitmap, or -1. */
function markerIndex(bitmap: Buffer, width: number, height: number, scale: number): number {
  const inset = Math.max(1, Math.round(1.5 * scale));
  const at = ((height - 1 - inset) * width + (width - 1 - inset)) * 4;
  const blue = bitmap[at]! > 127, green = bitmap[at + 1]! > 127, red = bitmap[at + 2]! > 127;
  return red === blue ? (red ? 1 : 0) | (green ? 2 : 0) : -1;
}

/** The painted frames, one per marker: each `next` resolves with the first paint carrying it, cut to the card. */
function frameSource(contents: ShareContents, scale: number, cropWidth: number, cropHeight: number) {
  let wanted: { index: number; resolve(frame: Buffer): void } | undefined;
  let poke: NodeJS.Timeout | undefined;
  const strip = Math.round(SHARE_MARKER_STRIP * scale) - 1;
  const onPaint = (_event: unknown, _dirty: unknown, image: PaintedImage): void => {
    if (!wanted) return;
    const { width, height } = image.getSize();
    if (width < cropWidth || height < cropHeight + strip) return;
    const bitmap = image.toBitmap();
    if (bitmap.length !== width * height * 4 || markerIndex(bitmap, width, height, scale) !== (wanted.index & 3)) return;
    const frame = Buffer.allocUnsafeSlow(cropWidth * cropHeight * 4);
    for (let y = 0; y < cropHeight; y++) bitmap.copy(frame, y * cropWidth * 4, y * width * 4, y * width * 4 + cropWidth * 4);
    const done = wanted;
    wanted = undefined;
    clearInterval(poke);
    done.resolve(frame);
  };
  contents.on('paint', onPaint);
  return {
    next(index: number): Promise<Buffer> {
      return new Promise(resolve => {
        wanted = { index, resolve };
        // A step that changed nothing but the marker still paints; this only covers a paint Chromium skipped.
        clearInterval(poke);
        poke = setInterval(() => contents.invalidate(), 250);
      });
    },
    close() { clearInterval(poke); contents.removeListener('paint', onPaint); },
  };
}

/**
 * now-share N5b: records the 此刻 share GIF. The card is the app's own UI (`#share-card`, N5a) in an offscreen window
 * that has no daemon access; the recorder moves a pointer and the rail's wheel over it on a stepped clock (see
 * share-clock.ts), takes a frame every third step, and encodes them in a worker. The window is destroyed when a pass
 * ends, however it ends; frames and recordings are kept in memory only, until `copy` writes one into the share folder.
 */
export class ShareRecorder {
  private readonly cards = new Map<number, Card>();
  private readonly kept = new Map<string, Kept>();
  private running: Deferred<never> | undefined;
  private disposed = false;

  constructor(private readonly deps: ShareRecorderDeps) {
    deps.ipc.handle(shareCardChannels.model, async event => {
      const card = this.card(event);
      return card ? { ok: true, value: JSON.parse(card.json) as unknown } : { ok: false };
    });
    deps.ipc.handle(shareCardChannels.ready, async (event, layout: unknown) => {
      const card = this.card(event);
      if (!card) return { ok: false };
      const parsed = layoutSchema.safeParse(layout);
      if (!parsed.success) { card.failed.reject(new ShareError('card_failed')); return { ok: false }; }
      card.layout.resolve(parsed.data);
      try { await card.begun.promise; return { ok: true, value: undefined }; }
      catch { return { ok: false }; }
    });
  }

  /** The card of an IPC call: only the main frame of a share window the recorder opened, showing the UI. */
  private card(event: IpcMainInvokeEvent): Card | undefined {
    const card = this.cards.get(event.sender.id);
    if (!card || !event.senderFrame || event.senderFrame !== card.contents.mainFrame) return undefined;
    return event.senderFrame.url.split('#')[0] === this.deps.uiUrl ? card : undefined;
  }

  async record(model: unknown, onProgress: (fraction: number) => void = () => {}): Promise<ShareRecording> {
    if (this.disposed) throw new ShareError('disposed');
    if (this.running) throw new ShareError('busy');
    let json: string | undefined;
    try { json = model && typeof model === 'object' ? JSON.stringify(model) : undefined; }
    catch {}
    if (json === undefined || json.length > MODEL_MAX) throw new ShareError('invalid_model');
    const stop = this.running = deferred<never>();
    const timer = setTimeout(() => stop.reject(new ShareError('timeout')), this.deps.timeoutMs ?? TIMEOUT_MS);
    const deadline = Date.now() + (this.deps.timeoutMs ?? TIMEOUT_MS);
    let reported = 0;
    const report = (fraction: number): void => {
      if (fraction <= reported) return;
      reported = fraction;
      try { onProgress(fraction); } catch {}
    };
    try {
      const width = Math.round(Math.min(1200, Math.max(560, this.deps.cardWidth())));
      let best: { variant: ShareGifVariant; width: number; height: number } | undefined;
      let scale = 2;
      for (let passes = 0; passes < 4 && scale >= MIN_SCALE; passes++) {
        let result: Awaited<ReturnType<ShareRecorder['render']>>;
        try { result = await this.render(json, width, scale, stop.promise, report); }
        catch (error) {
          if (!(error instanceof Rescale)) throw error;
          scale = error.scale;
          continue;
        }
        const target = result.variants.find(variant => variant.gif.length <= TARGET_BYTES);
        if (target) { best = { ...result, variant: target }; break; }
        const fits = result.variants.find(variant => variant.gif.length <= SHARE_GIF_MAX_BYTES);
        if (fits && !best) best = { ...result, variant: fits };
        // Another pass, smaller, only while there is time for one.
        if (deadline - Date.now() < 20_000) break;
        scale = scale > 1.5 ? 1.5 : scale > 1.25 ? 1.25 : scale > MIN_SCALE ? MIN_SCALE : 0;
      }
      if (!best) throw new ShareError('too_large');
      const gif = Buffer.from(best.variant.gif.buffer, best.variant.gif.byteOffset, best.variant.gif.byteLength);
      const recording: ShareRecording = {
        id: randomUUID(), bytes: gif.length, sha256: createHash('sha256').update(gif).digest('hex'),
        width: best.width, height: best.height, durationMs: Math.round(best.variant.durationMs),
      };
      this.kept.set(recording.id, { recording, gif });
      for (const id of [...this.kept.keys()].slice(0, Math.max(0, this.kept.size - KEPT))) this.kept.delete(id);
      report(1);
      return recording;
    } catch (error) {
      throw error instanceof ShareError ? error : new ShareError('card_failed', { cause: error });
    } finally {
      clearTimeout(timer);
      if (this.running === stop) this.running = undefined;
    }
  }

  /** One pass at one scale: the window, the pointer script on the stepped clock, the frames, both encodings. */
  private async render(json: string, layoutWidth: number, scale: number, stopped: Promise<never>, report: (fraction: number) => void) {
    const window = this.deps.openWindow({ width: layoutWidth, height: 900, scale });
    const contents = window.webContents;
    const card: Card = { contents, json, layout: deferred(), begun: deferred(), failed: deferred() };
    this.cards.set(contents.id, card);
    const gone = (): void => card.failed.reject(new ShareError('card_failed'));
    const failedLoad = (_event: unknown, code: number, _description: string, _url: string, isMainFrame: boolean): void => {
      if (isMainFrame && code !== -3) gone();
    };
    contents.on('render-process-gone', gone);
    contents.on('did-fail-load', failedLoad);
    const guard = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, card.failed.promise, stopped]);
    let frames: ReturnType<typeof frameSource> | undefined;
    let encoder: ShareEncoder | undefined;
    try {
      await guard(contents.loadURL(`${this.deps.uiUrl}#share-card`));
      const layout = await guard(card.layout.promise);
      const width = Math.ceil(layout.width), height = Math.ceil(layout.height);
      if (width * height * scale * scale > MAX_PIXELS && scale > MIN_SCALE) {
        throw new Rescale(Math.max(MIN_SCALE, Math.floor(Math.sqrt(MAX_PIXELS / (width * height)) * 4) / 4));
      }
      window.setContentSize(width, height + SHARE_MARKER_STRIP);
      const cropWidth = Math.round(layout.width * scale), cropHeight = Math.round(layout.height * scale);
      frames = frameSource(contents, scale, cropWidth, cropHeight);
      encoder = this.deps.encoder(cropWidth, cropHeight);
      contents.debugger.attach('1.3');
      await guard(contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }));
      await guard(contents.debugger.sendCommand('Animation.enable'));
      await guard(contents.executeJavaScript(`window.__vonvonShareClock.begin(${JSON.stringify(layout.rail)})`));
      // CSS transitions and animations now move only when the page clock moves them.
      await guard(contents.debugger.sendCommand('Animation.setPlaybackRate', { playbackRate: 0 }));
      card.begun.resolve();

      let scrollLeft: number | undefined;
      const script = pointerScript(layout, () => scrollLeft);
      const settleSteps = Math.round(SHARE_SETTLE_MS / SHARE_STEP_MS);
      const planned = [...pointerScript(layout)].length + settleSteps;
      const maxSteps = Math.round(SHARE_MAX_MS / SHARE_STEP_MS);
      const maxScroll = Math.max(0, layout.rail.scrollWidth - layout.rail.clientWidth);
      let previous: Buffer | undefined, frame = 0, unchanged = 0, scripted = true, settled = 0, wheels = 0, scroll = 0;
      for (let step = 0; ; step++) {
        if (step % SHARE_FRAME_STEPS === 0) {
          const image = await guard(frames.next(frame));
          unchanged = previous?.equals(image) ? unchanged + 1 : 0;
          if (previous) await guard(encoder.frame(previous, (frame - 1) * SHARE_FRAME_MS));
          previous = image;
          frame++;
          report(Math.min(0.95, step / planned));
          // Done once the pointer has gone and three frames in a row are alike, or the time is up.
          if (!scripted && (unchanged >= 2 || settled >= settleSteps) || step >= maxSteps) break;
        }
        const next = scripted ? script.next() : undefined;
        if (next?.done) scripted = false;
        const tick: ShareTick = { dt: SHARE_STEP_MS };
        for (const input of next && !next.done ? next.value : []) {
          contents.sendInputEvent(input);
          if (input.type === 'mouseMove') tick.pointer = [input.x, input.y];
          else {
            tick.wheels = ++wheels;
            tick.scroll = scroll = Math.min(maxScroll, Math.max(0, scroll - ((input as MouseWheelInputEvent).deltaX ?? 0)));
          }
        }
        if (!scripted) settled++;
        if ((step + 1) % SHARE_FRAME_STEPS === 0) tick.marker = frame & 3;
        const result = await guard(contents.executeJavaScript(`window.__vonvonShareClock.tick(${JSON.stringify(tick)})`)) as ShareTickResult | undefined;
        if (typeof result?.scrollLeft === 'number') scrollLeft = result.scrollLeft;
      }
      await guard(encoder.frame(previous!, (frame - 1) * SHARE_FRAME_MS));
      frames.close();
      frames = undefined;
      if (!window.isDestroyed()) window.destroy();
      const variants = await guard(encoder.finish(SHARE_FRAME_MS, HOLD_MS));
      return { variants, width: cropWidth, height: cropHeight };
    } finally {
      card.begun.reject(new ShareError('card_failed'));
      this.cards.delete(contents.id);
      frames?.close();
      encoder?.close();
      contents.removeListener('render-process-gone', gone);
      contents.removeListener('did-fail-load', failedLoad);
      if (!window.isDestroyed()) {
        try { if (contents.debugger.isAttached()) contents.debugger.detach(); } catch {}
        window.destroy();
      }
    }
  }

  private keptRecording(id: unknown): Kept {
    const kept = typeof id === 'string' ? this.kept.get(id) : undefined;
    if (!kept) throw new ShareError('unknown_recording');
    return kept;
  }

  async copy(id: string): Promise<{ path: string }> {
    const kept = this.keptRecording(id);
    if (!kept.path || !await stat(kept.path).then(info => info.isFile(), () => false)) {
      try { kept.path = await writeShareFile(this.deps.folder, kept.gif, this.deps.now?.() ?? new Date()); }
      catch { throw new ShareError('file_failed'); }
    }
    try { await putShareOnClipboard(this.deps.clipboard, kept.path, kept.gif); }
    catch { throw new ShareError('clipboard_failed'); }
    return { path: kept.path };
  }

  async reveal(path: string): Promise<void> {
    const own = ownShareFile(this.deps.folder, path);
    if (!own || !await stat(own).then(info => info.isFile(), () => false)) throw new ShareError('not_found');
    this.deps.reveal(own);
  }

  async bytes(id: string): Promise<Uint8Array> {
    return this.keptRecording(id).gif;
  }

  async discard(id: string): Promise<void> {
    this.kept.delete(id);
  }

  /** Quitting: a recording in progress stops and closes its window. */
  dispose(): void {
    this.disposed = true;
    this.running?.reject(new ShareError('disposed'));
    this.deps.ipc.removeHandler(shareCardChannels.model);
    this.deps.ipc.removeHandler(shareCardChannels.ready);
    this.kept.clear();
  }
}

/** The encoder in a worker thread. The worker's code is read here and run as a script, so loading it does not depend
 * on worker threads reading the app's asar archive. */
export function workerEncoder(source: () => string): (width: number, height: number) => ShareEncoder {
  return (width, height) => {
    const worker = new Worker(source(), { eval: true });
    let inFlight = 0, failure: Error | undefined, closed = false;
    let drained: (() => void) | undefined;
    let finishing: Deferred<ShareGifVariant[]> | undefined;
    const fail = (error: Error): void => {
      failure ??= error;
      drained?.();
      finishing?.reject(failure);
    };
    worker.on('message', (reply: ShareWorkerReply) => {
      if (reply.type === 'ack') { inFlight--; drained?.(); }
      else if (reply.type === 'done') finishing?.resolve(reply.variants);
      else fail(new Error(reply.message));
    });
    worker.on('error', fail);
    worker.on('exit', () => { if (!closed) fail(new Error('GIF encoder stopped')); });
    const post = (message: ShareWorkerRequest, transfer: ArrayBuffer[] = []): void => worker.postMessage(message, transfer);
    post({ type: 'init', width, height });
    return {
      async frame(bgra, time) {
        if (failure) throw failure;
        inFlight++;
        const data = bgra.buffer as ArrayBuffer;
        post({ type: 'frame', data, time }, [data]);
        while (inFlight > 3 && !failure) await new Promise<void>(resolve => { drained = resolve; });
        if (failure) throw failure;
      },
      finish(interval, hold) {
        finishing = deferred();
        if (failure) finishing.reject(failure);
        else post({ type: 'finish', interval, hold });
        return finishing.promise;
      },
      close() {
        closed = true;
        void worker.terminate();
      },
    };
  };
}

/** The recorder as the app runs it. The share window has its own in-memory session, which grants no permission. */
export function createShareRecorder(options: { uiUrl: string; preload: string; worker: string; folder: string; cardWidth(): number }): ShareRecorder {
  const partition = session.fromPartition('vonvon-share');
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  let source: string | undefined;
  return new ShareRecorder({
    ipc: ipcMain,
    uiUrl: options.uiUrl,
    openWindow: ({ width, height, scale }) => {
      const window = new BrowserWindow({
        show: false, width, height, useContentSize: true, frame: false, skipTaskbar: true, paintWhenInitiallyHidden: true,
        backgroundColor: '#ffffff',
        webPreferences: {
          preload: options.preload, offscreen: { deviceScaleFactor: scale }, session: partition,
          sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, spellcheck: false,
        },
      });
      const contents = window.webContents;
      contents.setAudioMuted(true);
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', event => event.preventDefault());
      contents.on('will-frame-navigate', event => event.preventDefault());
      contents.on('will-redirect', event => event.preventDefault());
      contents.on('will-attach-webview', event => event.preventDefault());
      contents.setFrameRate(60);
      return window;
    },
    encoder: workerEncoder(() => source ??= readFileSync(options.worker, 'utf8')),
    cardWidth: options.cardWidth,
    folder: options.folder,
    clipboard: { platform: process.platform, clipboard, ClipboardItem, powershell: runWindowsPowerShell },
    reveal: path => shell.showItemInFolder(path),
  });
}
