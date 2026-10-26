import { randomUUID } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { botPaths } from './paths';

/** Evidence from an actual incoming cardAction, separate from the supervisor's manual setup.json writes. */
export const cardCallbackFile = (appId: string): string => join(botPaths(appId).dir, 'card-callback.json');
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 8_640_000_000_000_000;

async function readVerifiedAt(file: string): Promise<number | undefined> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  const verifiedAt = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).verifiedAt : undefined;
  if (!validTime(verifiedAt)) throw new Error('卡片回调验证记录无效。');
  return verifiedAt;
}

/** Missing, unreadable or invalid evidence cannot establish that a callback was received. */
export async function readCardCallbackVerifiedAt(appId: string): Promise<number | undefined> {
  try { return await readVerifiedAt(cardCallbackFile(appId)); }
  catch { return undefined; }
}

/** Publish a complete first-receipt record without replacing an existing one. No mkdir: a deleted Bot stays deleted. */
export async function recordCardCallback(appId: string, verifiedAt: number): Promise<void> {
  if (!validTime(verifiedAt)) throw new Error('卡片回调验证时间无效。');
  const file = cardCallbackFile(appId);
  if (await readVerifiedAt(file) !== undefined) return;
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ verifiedAt })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { await link(tmp, file); }
    catch (error) {
      // Another receiver may have published first. Never overwrite its timestamp or a file we cannot read.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readVerifiedAt(file) === undefined) throw error;
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

/** The receive path never waits for disk. A failed write is retried on the next callback with the first receipt time. */
export function createCardCallbackRecorder(appId: string, options: {
  now?: () => number;
  write?: typeof recordCardCallback;
  onError?: (error: unknown) => void;
} = {}) {
  let firstAt: number | undefined;
  let recorded = false;
  let closed = false;
  let pending: Promise<void> | undefined;
  return {
    received(): void {
      if (closed || recorded || pending) return;
      const at = firstAt ?? (options.now ?? Date.now)();
      if (!validTime(at)) return;
      firstAt = at;
      pending = Promise.resolve().then(() => (options.write ?? recordCardCallback)(appId, at))
        .then(() => { recorded = true; }, error => {
          // Reporting an evidence-storage failure must not turn a successful card action into a failed one.
          try { options.onError?.(error); } catch { /* logging is best effort */ }
        }).finally(() => { pending = undefined; });
    },
    async close(): Promise<void> {
      closed = true;
      await pending;
    },
  };
}
