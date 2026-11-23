// Adapted from getpaseo/paseo packages/server/src/server/atomic-file.ts at 0009a7e71.
// Copyright Paseo contributors. Licensed under Apache-2.0; see NOTICE.
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { basename, dirname, join } from 'node:path';

export async function writeFileAtomic(filePath: string, data: string | NodeJS.ArrayBufferView, opts?: { durable?: boolean; beforeCommit?:()=>void }): Promise<void> {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    if (opts?.durable) {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        await file.sync();
      } finally { await file.close(); }
    } else await writeFile(temporary, data, { mode: 0o600 });
    await renameOverReaders(temporary, filePath, opts?.beforeCommit);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  // The rename is the commit point: the new content is in place, so nothing after it may reject.
  if (opts?.durable) await syncDirectoryBestEffort(parent);
}

/** Windows will not replace a file that another process has open (EPERM, EACCES or EBUSY): daemon.pid while the CLI or the
 * desktop polls it for readiness made `daemon start` die (#667 Windows CI). Readers hold it for milliseconds; retry ~2.5 s. */
export async function renameOverReaders(from: string, to: string, beforeCommit?: () => void): Promise<void> {
  for (let delay = 10; ; delay *= 2) {
    // Revalidate immediately before every attempt; authorization failures must never be retried.
    beforeCommit?.();
    try { return await rename(from, to); }
    catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code) || delay > 1280) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/** Makes the rename itself durable where the platform allows it; a failure only costs durability, never the write. */
async function syncDirectoryBestEffort(path: string): Promise<void> {
  // Node cannot fsync a directory on Windows (FlushFileBuffers on a directory handle fails with EPERM);
  // on NTFS the rename is the commit point. Same guard as config/bot-namespace.ts syncDirectory.
  if (process.platform === 'win32') return;
  try {
    const directory = await open(path, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    // EINVAL on some macOS filesystems, EIO, ENOTSUP: log and resolve.
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    log.warn('atomic-file', 'directory-sync-failed', { path, code });
  }
}
