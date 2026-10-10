// Adapted from getpaseo/paseo packages/server/src/server/atomic-file.ts at 0009a7e71.
// Copyright Paseo contributors. Licensed under Apache-2.0; see NOTICE.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function writeFileAtomic(filePath: string, data: string | NodeJS.ArrayBufferView): Promise<void> {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
