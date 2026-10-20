import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { copyFile, lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { inspectLocalPath } from './bounded-local-files';

export type MoveFileResult = { kind: 'moved' | 'conflict' | 'missing' };
export interface MoveFileIntent {
  src: string;
  dst: string;
  sha256: string;
  txId: string;
}
export interface MoveFileDeps {
  rename?: typeof rename;
  copyFile?: typeof copyFile;
  unlink?: typeof unlink;
  fault?: (point: 'after-copy' | 'crash-after:exdev-publish') => void | Promise<void>;
}
export class MoveFileSafetyError extends Error {
  constructor() { super('Unsafe bridge import file move'); }
}
interface CheckedFile { metadata: Stats; hash: string }
const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const hasCode = (error: unknown, code: string) => error instanceof Error && 'code' in error && error.code === code;

async function inspect(path: string): Promise<CheckedFile | undefined> {
  const metadata = await inspectLocalPath(parse(path).root, path);
  if (!metadata) return undefined;
  if (!metadata.isFile() || metadata.nlink !== 1) throw new MoveFileSafetyError();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !sameInode(metadata, before) || before.size > 16 * 1024 * 1024) throw new MoveFileSafetyError();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(path);
    if (!sameInode(before, current) || !sameInode(before, after) || after.nlink !== 1
      || bytes.length > 16 * 1024 * 1024 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new MoveFileSafetyError();
    }
    return { metadata: after, hash: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function verifyParent(path: string): Promise<void> {
  const metadata = await inspectLocalPath(parse(path).root, dirname(path));
  if (!metadata?.isDirectory()) throw new MoveFileSafetyError();
}

/** Requires the transaction's exclusive access; this is not an OS lock against same-uid writers.
 * Node rename has no atomic no-replace flag: a concurrent writer after inspection can be overwritten.
 */
export async function moveFileSafely(intent: MoveFileIntent, deps: MoveFileDeps = {}): Promise<MoveFileResult> {
  const { src, dst, sha256, txId } = intent;
  if (![src, dst].every(path => isAbsolute(path) && resolve(path) === path)
    || src === dst || sha256.length !== 64 || /[^a-f0-9]/.test(sha256)
    || txId.length < 1 || txId.length > 100 || /[^a-zA-Z0-9_-]/.test(txId)) throw new MoveFileSafetyError();
  const temporary = join(dirname(dst), `.${basename(dst)}.vonvon-${txId}.tmp`);
  if (temporary === src) throw new MoveFileSafetyError();
  const move = deps.rename ?? rename;
  const remove = deps.unlink ?? unlink;
  const copy = deps.copyFile ?? copyFile;
  let ownedTemporary: Stats | undefined;
  async function removeChecked(path: string, file: CheckedFile): Promise<void> {
    await verifyParent(path);
    const current = await inspect(path);
    if (!current || current.hash !== sha256 || !sameInode(current.metadata, file.metadata)) throw new MoveFileSafetyError();
    await remove(path);
    await syncDirectory(dirname(path));
  }
  // A name alone is insufficient ownership: preserve partial, linked or foreign leftovers.
  const leftover = await inspect(temporary);
  if (leftover) {
    if (leftover.hash !== sha256) return { kind: 'conflict' };
    await removeChecked(temporary, leftover);
  }
  const source = await inspect(src);
  const destination = await inspect(dst);
  if (destination) {
    if (destination.hash !== sha256 || (source && source.hash !== sha256)) return { kind: 'conflict' };
    if (source) await removeChecked(src, source);
    return { kind: 'moved' };
  }
  if (!source) return { kind: 'missing' };
  if (source.hash !== sha256) return { kind: 'conflict' };
  await verifyParent(src);
  await verifyParent(dst);
  try {
    await move(src, dst);
    await syncDirectory(dirname(dst));
    await syncDirectory(dirname(src));
    return { kind: 'moved' };
  } catch (error) {
    if (!hasCode(error, 'EXDEV')) throw error;
  }
  try {
    await copy(src, temporary, constants.COPYFILE_EXCL);
    const copied = await inspect(temporary);
    if (!copied) throw new MoveFileSafetyError();
    ownedTemporary = copied.metadata;
    if (copied.hash !== sha256) throw new MoveFileSafetyError();
    const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!sameInode(await handle.stat(), copied.metadata)) throw new MoveFileSafetyError();
      await handle.sync();
    } finally { await handle.close(); }
    await deps.fault?.('after-copy');
    await verifyParent(dst);
    if (await inspect(dst)) return { kind: 'conflict' };
    const current = await inspect(temporary);
    if (!current || current.hash !== sha256 || !sameInode(current.metadata, copied.metadata)) throw new MoveFileSafetyError();
    await move(temporary, dst);
    ownedTemporary = undefined;
    await syncDirectory(dirname(dst));
    await deps.fault?.('crash-after:exdev-publish');
    await removeChecked(src, source);
    return { kind: 'moved' };
  } finally {
    if (ownedTemporary) {
      await verifyParent(temporary);
      const current = await lstat(temporary).catch(error => {
        if (hasCode(error, 'ENOENT')) return undefined;
        throw error;
      });
      if (current?.isFile() && current.nlink === 1 && sameInode(current, ownedTemporary)) await remove(temporary);
    }
  }
}
