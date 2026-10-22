import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, open, rename, unlink} from 'node:fs/promises';
import {dirname, parse} from 'node:path';
import {inspectLocalPath, readBoundedFile} from './bounded-local-files';

export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export async function readBytes(file: string, limit = 16 * 1024 * 1024): Promise<Buffer | undefined> {
  const before = await inspectLocalPath(parse(file).root, file);
  if (!before) return undefined;
  if (!before.isFile() || before.nlink !== 1) throw new Error('Unsafe import file');
  const bytes = await readBoundedFile(file, {maxBytes: limit, timeoutMs: 5000});
  const after = await inspectLocalPath(parse(file).root, file);
  if (!after || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Import file changed');
  return bytes;
}
export async function syncDir(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function ensureDirectory(path: string): Promise<void> {
  if (!await inspectLocalPath(parse(path).root, path)) {
    await ensureDirectory(dirname(path));
    await mkdir(path, {mode: 0o700}); await syncDir(dirname(path));
  }
  if (!(await inspectLocalPath(parse(path).root, path))?.isDirectory()) throw new Error('Unsafe import directory');
}
/** Compare-and-publish under the transaction's exclusive access. expected=null never adopts an existing file. */
export async function publishFile(path: string, bytes: string | Buffer, expected: string | null, mode = 0o600): Promise<void> {
  const existing = await readBytes(path);
  if (expected === null ? existing !== undefined : existing === undefined || sha256(existing) !== expected) throw new Error('Import file ownership changed');
  await ensureDirectory(dirname(path));
  const temporary = `${path}.import-${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    const current = await readBytes(path);
    if (expected === null ? current !== undefined : current === undefined || sha256(current) !== expected) throw new Error('Import file ownership changed');
    await rename(temporary, path); await syncDir(dirname(path));
  } finally { await unlink(temporary).catch(error => {if (error?.code !== 'ENOENT') throw error;}); }
}
export async function removeOwnedFile(path: string, expected: string): Promise<boolean> {
  const bytes = await readBytes(path);
  if (!bytes) return true;
  if (sha256(bytes) !== expected) return false;
  await unlink(path); await syncDir(dirname(path)); return true;
}
