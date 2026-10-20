import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { inspectLocalPath } from './bounded-local-files';
import { BridgeMoveAllocationSchema, type BridgeMoveAllocation } from './journal';

export type MoveFileResult = { kind: 'moved' | 'conflict' | 'missing' };
export interface MoveFileIntent {
  src: string;
  dst: string;
  sha256: string;
  txId: string;
  operation?: Pick<BridgeMoveAllocation, 'sequence' | 'from' | 'to'> & { allocations: readonly BridgeMoveAllocation[] };
}
export interface MoveFileDeps {
  rename?: typeof rename;
  copyToHandle?: (source: FileHandle, target: FileHandle) => Promise<void>;
  persistAllocation?: (allocation: BridgeMoveAllocation) => Promise<void>;
  unlink?: typeof unlink;
  fault?: (point: 'after-temporary-create' | 'after-copy' | 'crash-after:exdev-publish') => void | Promise<void>;
}
export class MoveFileSafetyError extends Error {
  constructor() { super('Unsafe bridge import file move'); }
}
interface CheckedFile { metadata: Stats; hash: string }
const sameInode = (a: Pick<Stats, 'dev' | 'ino'>, b: Pick<Stats, 'dev' | 'ino'>) => a.dev === b.dev && a.ino === b.ino;
function checkedAllocation(value: BridgeMoveAllocation): BridgeMoveAllocation {
  const allocation = BridgeMoveAllocationSchema.parse(value);
  if (!((allocation.from === 'original' && allocation.to === 'stage')
    || (allocation.from === 'stage' && (allocation.to === 'original' || allocation.to === 'backup')))) throw new MoveFileSafetyError();
  return allocation;
}
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
  const oldTemporary = join(dirname(dst), `.${basename(dst)}.vonvon-${txId}.tmp`);
  if (oldTemporary === src) throw new MoveFileSafetyError();
  const move = deps.rename ?? rename;
  const remove = deps.unlink ?? unlink;
  const persist = deps.persistAllocation;
  const operation = intent.operation;
  const temporaryPath = (allocation: BridgeMoveAllocation) => join(dirname(dst),
    `.${basename(dst)}.vonvon-${txId}-${allocation.sequence}-${allocation.nonce}.tmp`);
  // No durable reservation exists for legacy names, even if their bytes match.
  if (await inspect(oldTemporary)) return { kind: 'conflict' };
  for (const rawAllocation of operation?.allocations ?? []) {
    const allocation = checkedAllocation(rawAllocation);
    if (!persist || !operation || allocation.txId !== txId || allocation.sha256 !== sha256
      || allocation.sequence !== operation?.sequence || allocation.from !== operation.from || allocation.to !== operation.to) {
      throw new MoveFileSafetyError();
    }
    const parent = await inspectLocalPath(parse(dst).root, dirname(dst));
    if (!parent?.isDirectory() || !sameInode(parent, allocation.parent)) throw new MoveFileSafetyError();
    const path = temporaryPath(allocation);
    const metadata = await inspectLocalPath(parse(dst).root, path);
    if (!metadata) continue;
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
      || (allocation.inode ? !sameInode(metadata, allocation.inode) : metadata.size !== 0)) return { kind: 'conflict' };
    if (!allocation.inode) await persist({ ...allocation, inode: { dev: metadata.dev, ino: metadata.ino } });
    const currentParent = await inspectLocalPath(parse(dst).root, dirname(dst));
    const current = await inspectLocalPath(parse(dst).root, path);
    if (!currentParent?.isDirectory() || !sameInode(currentParent, allocation.parent)
      || !current?.isFile() || current.nlink !== 1 || (current.mode & 0o777) !== 0o600
      || !sameInode(current, metadata)) return { kind: 'conflict' };
    await remove(path);
    await syncDirectory(dirname(dst));
  }
  let ownedTemporary: Stats | undefined;
  let temporary = '';

  async function removeChecked(path: string, file: CheckedFile): Promise<void> {
    await verifyParent(path);
    const current = await inspect(path);
    if (!current || current.hash !== sha256 || !sameInode(current.metadata, file.metadata)) throw new MoveFileSafetyError();
    await remove(path);
    await syncDirectory(dirname(path));
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
  if (!operation || !persist) throw new MoveFileSafetyError();
  const parent = await inspectLocalPath(parse(dst).root, dirname(dst));
  if (!parent?.isDirectory()) throw new MoveFileSafetyError();
  const allocation: BridgeMoveAllocation = { txId, sha256, sequence: operation.sequence,
    from: operation.from, to: operation.to, parent: { dev: parent.dev, ino: parent.ino }, nonce: randomUUID(), inode: null };
  temporary = temporaryPath(allocation);
  if (await inspectLocalPath(parse(dst).root, temporary)) return { kind: 'conflict' };
  checkedAllocation(allocation);
  await persist(allocation);
  const reservedParent = await inspectLocalPath(parse(dst).root, dirname(dst));
  if (!reservedParent?.isDirectory() || !sameInode(reservedParent, allocation.parent)) throw new MoveFileSafetyError();
  try {
    const target = await open(temporary, 'wx+', 0o600);
    try {
      ownedTemporary = await target.stat();
      await syncDirectory(dirname(dst));
      await deps.fault?.('after-temporary-create');
      await persist({ ...allocation, inode: { dev: ownedTemporary.dev, ino: ownedTemporary.ino } });
      const input = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!sameInode(await input.stat(), source.metadata)) throw new MoveFileSafetyError();
        if (deps.copyToHandle) await deps.copyToHandle(input, target);
        else await target.writeFile(await input.readFile());
        await target.sync();
      } finally { await input.close(); }
    } finally { await target.close(); }
    const copied = await inspect(temporary);
    if (!copied || !ownedTemporary || copied.hash !== sha256 || !sameInode(copied.metadata, ownedTemporary)) throw new MoveFileSafetyError();
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
      if (current?.isFile() && current.nlink === 1 && sameInode(current, ownedTemporary)) {
        await remove(temporary);
        await syncDirectory(dirname(dst));
      }
    }
  }
}
