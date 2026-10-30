// Adapted from getpaseo/paseo packages/server/src/server/atomic-file.ts at 0009a7e71.
// Copyright Paseo contributors. Licensed under Apache-2.0; see NOTICE.
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { basename, dirname, join } from 'node:path';

export async function writeFileAtomic(filePath: string, data: string | NodeJS.ArrayBufferView, opts?: { durable?: boolean }): Promise<void> {
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
    await rename(temporary, filePath);
    if (opts?.durable) {
      const directory = await open(parent, 'r');
      try {
        await directory.sync();
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EINVAL')) throw error;
        log.warn('atomic-file', 'directory-sync-unsupported', { path: parent });
      } finally { await directory.close(); }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
