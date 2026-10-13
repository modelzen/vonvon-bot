import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ImageRef, RunEvent } from '../model';

const MAX_IMAGES = 12;
const extensions: Record<ImageRef['mime'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface ImagePayload {
  base64: string;
  mime: ImageRef['mime'];
  placement: ImageRef['placement'];
}

export interface ImageSinkOptions {
  dataDir: string;
  runId: string;
  emit: (event: Extract<RunEvent, { type: 'image' | 'notice' }>) => void;
  isOpen: () => boolean;
}

export class ImageSink {
  private tail: Promise<void> = Promise.resolve();
  private written = 0;
  private capNotified = false;
  private readonly directory: string;

  constructor(private readonly options: ImageSinkOptions) {
    if (!/^[A-Za-z0-9_-]+$/.test(options.runId)) throw new Error('invalid run id');
    this.directory = resolve(options.dataDir, 'images', options.runId);
  }

  accept(payload: ImagePayload): Promise<ImageRef | undefined> {
    const result = this.tail.then(() => this.write(payload));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async write(payload: ImagePayload): Promise<ImageRef | undefined> {
    if (!this.options.isOpen()) return undefined;
    if (this.written >= MAX_IMAGES) {
      if (!this.capNotified) {
        this.capNotified = true;
        this.options.emit({ type: 'notice', kind: 'image-cap', text: '最多保留 12 张图片。' });
      }
      return undefined;
    }
    if (!payload.base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.base64)) {
      return undefined;
    }
    const bytes = Buffer.from(payload.base64, 'base64');
    if (bytes.length === 0 || bytes.toString('base64') !== payload.base64) return undefined;

    const id = randomUUID();
    const path = join(this.directory, `${id}.${extensions[payload.mime]}`);
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(path, bytes, { flag: 'wx' });
    } catch {
      return undefined;
    }
    if (!this.options.isOpen()) {
      await unlink(path).catch(() => undefined);
      return undefined;
    }
    const image: ImageRef = { id, path, mime: payload.mime, placement: structuredClone(payload.placement) };
    this.written++;
    this.options.emit({ type: 'image', image });
    return structuredClone(image);
  }
}
