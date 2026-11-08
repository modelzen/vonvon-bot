import { parentPort } from 'node:worker_threads';
import { ShareGifEncoder } from './share-gif.js';

/** now-share N5b: encodes the share GIF off the main process's thread. Messages: `init`, then a `frame` (BGRA, its
 * buffer transferred) answered by an `ack` once encoded, then `finish` answered by `done` with both frame rates. */
export type ShareWorkerRequest =
  | { type: 'init'; width: number; height: number }
  | { type: 'frame'; data: ArrayBuffer; time: number }
  | { type: 'finish'; interval: number; hold: number };
export type ShareWorkerReply =
  | { type: 'ack' }
  | { type: 'done'; variants: { fps: number; gif: Uint8Array; durationMs: number }[] }
  | { type: 'error'; message: string };

const port = parentPort;
let encoder: ShareGifEncoder | undefined;
port?.on('message', (message: ShareWorkerRequest) => {
  const reply = (value: ShareWorkerReply, transfer: ArrayBuffer[] = []): void => port.postMessage(value, transfer);
  try {
    switch (message.type) {
      case 'init':
        encoder = new ShareGifEncoder(message.width, message.height);
        return;
      case 'frame':
        if (!encoder) throw new Error('GIF encoder not started');
        encoder.add(new Uint8Array(message.data), message.time);
        reply({ type: 'ack' });
        return;
      case 'finish': {
        if (!encoder) throw new Error('GIF encoder not started');
        const variants = encoder.finish(message.interval, message.hold);
        encoder = undefined;
        reply({ type: 'done', variants }, variants.map(variant => variant.gif.buffer as ArrayBuffer));
        return;
      }
    }
  } catch (error) {
    reply({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
