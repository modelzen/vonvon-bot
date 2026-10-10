import { mkdir, open, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { JobPeer } from './jobs';

export class LogFollowers {
  private readonly followers = new Map<JobPeer, () => void>();
  constructor(private readonly directory: string) {}
  follow(peer: JobPeer, follow: boolean): void {
    this.followers.get(peer)?.();
    if (!follow || !peer.open) return;
    let closed = false;
    let watcher: FSWatcher | undefined;
    let file = '';
    let offset = 0;
    let initial = true;
    let decoder = new StringDecoder('utf8');
    let replayEnd: number | undefined;
    let suppressFirstLine = false;
    let replayText = '';
    let reading = false;
    let pending = false;
    const today = (): string => join(this.directory, `${new Date().toISOString().slice(0, 10)}.log`);
    const emit = (text: string): void => {
      let start = 0;
      let index = 0;
      let bytes = 0;
      for (const point of text) {
        const length = Buffer.byteLength(point);
        if (bytes + length > 65_536) {
          if (closed || !peer.open) return;
          peer.event({ type: 'event', event: 'log', payload: { lines: text.slice(start, index) } });
          start = index;
          bytes = 0;
        }
        bytes += length;
        index += point.length;
      }
      if (index > start && !closed && peer.open) peer.event({ type: 'event', event: 'log', payload: { lines: text.slice(start) } });
    };
    const reset = (): void => {
      offset = 0;
      decoder = new StringDecoder('utf8');
      replayEnd = undefined;
      suppressFirstLine = false;
      replayText = '';
    };
    const pump = async (): Promise<void> => {
      if (closed || !peer.open) return;
      if (reading) { pending = true; return; }
      reading = true;
      try {
        const next = today();
        if (next !== file) { if (file) initial = false; file = next; reset(); }
        const size = (await stat(file).catch(() => undefined))?.size;
        if (size === undefined || closed || !peer.open) return;
        if (offset > size) { initial = false; reset(); }
        if (initial && replayEnd === undefined) {
          replayEnd = size;
          offset = Math.max(0, size - 16 * 1024);
          suppressFirstLine = offset > 0;
        }
        const finishReplay = (): void => {
          if (!initial || offset !== replayEnd) return;
          initial = false;
          suppressFirstLine = false;
          if (replayText.trim()) emit(replayText);
          replayText = '';
        };
        finishReplay();
        if (offset >= size || closed || !peer.open) return;
        const handle = await open(file, 'r');
        try {
          while (offset < size && !closed && peer.open) {
            const end = initial ? replayEnd ?? size : size;
            const buffer = Buffer.alloc(Math.min(65_536, end - offset));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            if (!bytesRead || closed || !peer.open) break;
            offset += bytesRead;
            let bytes = buffer.subarray(0, bytesRead);
            if (suppressFirstLine) {
              const newline = bytes.indexOf(10);
              if (newline < 0) bytes = bytes.subarray(bytes.length);
              else { bytes = bytes.subarray(newline + 1); suppressFirstLine = false; }
            }
            const text = decoder.write(bytes);
            if (initial) { replayText += text; finishReplay(); }
            else emit(text);
          }
        } finally { await handle.close(); }
      } finally {
        reading = false;
        if (pending && !closed && peer.open) { pending = false; void pump().catch(() => undefined); }
      }
    };
    const timer = setInterval(() => { void pump().catch(() => undefined); }, 1000);
    timer.unref();
    const close = (): void => { closed = true; reset(); watcher?.close(); clearInterval(timer); this.followers.delete(peer); };
    this.followers.set(peer, close);
    void mkdir(this.directory, { recursive: true }).then(() => {
      if (closed) return;
      watcher = watch(this.directory, () => { void pump().catch(() => undefined); });
      return pump();
    }).catch(() => undefined);
  }
  detach(peer: JobPeer): void { this.followers.get(peer)?.(); }
  close(): void { for (const close of this.followers.values()) close(); }
}
