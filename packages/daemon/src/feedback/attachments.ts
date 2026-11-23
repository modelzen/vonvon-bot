import {randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Transform, type Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {cleanFileName} from '../bot/media';

type Resource = {type: 'image' | 'file'; key: string; name: string};
export type FeedbackDownload = (messageId: string, resource: Resource) => Promise<Readable>;
const oneFile = 20 * 1024 * 1024;
const allFiles = 40 * 1024 * 1024;

export function directFeedbackAttachments(message: NormalizedMessage) {
  const resources = new Map<string, Resource>();
  const seen = new Set<string>();
  if (['post', 'file', 'image', 'text'].includes(message.rawContentType)) for (const item of message.resources) {
    if ((item.type !== 'image' && item.type !== 'file') || !item.fileKey || seen.has(item.fileKey)) continue;
    seen.add(item.fileKey);
    const name = cleanFileName(item.fileName)?.replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, '_') || (item.type === 'image' ? '图片' : '附件');
    resources.set(randomUUID(), {type: item.type, key: item.fileKey, name});
  }
  return {
    refs: [...resources].map(([ref, {name}]) => ({ref, name})),
    async withFiles<T>(refs: readonly string[], root: string, download: FeedbackDownload, signal: AbortSignal, use: (paths: readonly string[]) => Promise<T>) {
      signal.throwIfAborted();
      if (refs.length > 6 || new Set(refs).size !== refs.length || refs.some(ref => !resources.has(ref))) throw new Error('只可选择本条消息的附件，每次最多六个。');
      if (!refs.length) return use([]);
      await mkdir(root, {recursive: true, mode: 0o700});
      const temporary = await mkdtemp(join(root, 'download-'));
      try {
        let total = 0;
        const paths: string[] = [];
        for (const ref of refs) {
          signal.throwIfAborted();
          const resource = resources.get(ref)!;
          const dir = join(temporary, ref);
          await mkdir(dir, {mode: 0o700});
          const path = join(dir, resource.name);
          let size = 0;
          const bound = new Transform({transform(chunk: Buffer, _encoding, next) {
            size += chunk.byteLength;
            total += chunk.byteLength;
            if (size > oneFile || total > allFiles) next(new Error('附件超出单个 20 MB 或合计 40 MB 限额。'));
            else next(null, chunk);
          }});
          const stream = await download(message.messageId, resource);
          await pipeline(stream, bound, createWriteStream(path, {mode: 0o600, flags: 'wx'}), {signal});
          if (size === 0) throw new Error('附件为空。');
          paths.push(path);
        }
        signal.throwIfAborted();
        return await use(paths);
      } finally {await rm(temporary, {recursive: true, force: true});}
    },
  };
}
