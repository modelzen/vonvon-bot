import { mkdir, open, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
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
    let reading = false;
    let pending = false;
    const today = (): string => join(this.directory, `${new Date().toISOString().slice(0, 10)}.log`);
    const pump = async (): Promise<void> => {
      if (closed) return;
      if (reading) { pending = true; return; }
      reading = true;
      try {
        const next = today();
        if (next !== file) { file = next; offset = 0; }
        const size = (await stat(file).catch(() => undefined))?.size;
        if (size === undefined) return;
        if (offset > size) offset = 0;
        const start = initial ? Math.max(0, size - 16 * 1024) : offset;
        if (size === start) { initial = false; offset = size; return; }
        const handle = await open(file, 'r');
        let lines: string;
        try {
          const buffer = Buffer.alloc(size - start);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
          lines = buffer.subarray(0, bytesRead).toString('utf8');
          if (initial && start > 0) { const nl = lines.indexOf('\n'); lines = nl < 0 ? '' : lines.slice(nl + 1); }
          offset = start + bytesRead;
          initial = false;
        } finally { await handle.close(); }
        if (!closed && peer.open && lines.trim()) peer.event({ type: 'event', event: 'log', payload: { lines } });
      } finally {
        reading = false;
        if (pending && !closed) { pending = false; void pump().catch(() => undefined); }
      }
    };
    const timer = setInterval(() => { void pump().catch(() => undefined); }, 1000);
    timer.unref();
    const close = (): void => { closed = true; watcher?.close(); clearInterval(timer); this.followers.delete(peer); };
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
