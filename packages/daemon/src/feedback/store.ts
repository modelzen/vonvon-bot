import {createHash, randomUUID} from 'node:crypto';
import {constants, type BigIntStats} from 'node:fs';
import {chmod, lstat, mkdir, open, readFile, rm} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join} from 'node:path';
import {z} from 'zod';
import {acquireMutex, closeMutex} from '../config/data-access.js';
import {ensureDurableDirectory, syncDirectory} from '../config/bot-namespace.js';
import {writeFileAtomic} from '../server/atomic-file.js';
import {feedbackDraftSchema, feedbackOperationSchema, type FeedbackAttachment, type FeedbackDraft, type FeedbackOperation, type FeedbackStore} from './types.js';

const uuid = z.string().uuid();
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function privateDirectory(path: string): Promise<void> {
  await ensureDurableDirectory(path);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('反馈的本地目录不可用。');
  await chmod(path, 0o700);
}

async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const selected = await lstat(path, {bigint: true});
  const maximum = BigInt(limit);
  if (!selected.isFile() || selected.size < 1n || selected.size > maximum) throw new Error('请选择不超过 20 MB 的普通附件文件。');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat({bigint: true});
    if (!before.isFile() || before.size < 1n || before.size > maximum) throw new Error('请选择不超过 20 MB 的普通附件文件。');
    if (!sameFile(selected, before)) throw new Error('附件正在变化，请重新选择并核对。');
    const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({bigint: true});
    if (BigInt(offset) !== before.size || !sameFile(before, after)) throw new Error('附件正在变化，请重新选择并核对。');
    return buffer.subarray(0, offset);
  } finally {await handle.close();}
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export class FileFeedbackStore implements FeedbackStore {
  constructor(private readonly root: string) {
    if (!isAbsolute(root)) throw new Error('反馈存储必须使用宿主指定的绝对目录。');
  }

  directory(operationId: string): string {
    return join(this.root, uuid.parse(operationId));
  }

  async stage(operationId: string, selectedPaths: readonly string[]): Promise<FeedbackAttachment[]> {
    if (selectedPaths.length > 6) throw new Error('一次反馈最多选择 6 个附件。');
    await privateDirectory(this.root);
    const directory = this.directory(operationId);
    await mkdir(directory, {mode: 0o700});
    try {
      await syncDirectory(directory);
      await syncDirectory(this.root);
      const result: FeedbackAttachment[] = [];
      let total = 0;
      for (const path of selectedPaths) {
        if (!isAbsolute(path)) throw new Error('附件必须由本地文件选择器明确选中。');
        const filename = basename(path);
        if (!filename || ['.', '..'].includes(filename) || /[\\\u0000:*?"<>|]/.test(filename) || [...filename].length > 240) {
          throw new Error('附件文件名不可用，请重命名后重试。');
        }
        const bytes = await boundedFile(path, 20 * 1024 * 1024);
        total += bytes.length;
        if (total > 40 * 1024 * 1024) throw new Error('一次反馈的附件总大小不能超过 40 MB。');
        const relativePath = `attachments/${randomUUID()}/${filename}`;
        const target = join(directory, ...relativePath.split('/'));
        await privateDirectory(dirname(target));
        await writeFileAtomic(target, bytes, {durable: true});
        await syncDirectory(dirname(target));
        result.push({filename, relativePath, bytes: bytes.length, sha256: sha256(bytes)});
      }
      return result;
    } catch (error) {
      try {
        await rm(directory, {recursive: true, force: true});
        await syncDirectory(this.root);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '附件暂存未完成，本次私有副本清理失败。');
      }
      throw error;
    }
  }

  async create(operation: FeedbackOperation): Promise<void> {
    await this.exclusive(operation.draft.operationId, async () => {
      const path = join(this.directory(operation.draft.operationId), 'operation.json');
      try {await lstat(path);}
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          await this.write(operation);
          return;
        }
        throw error;
      }
      throw new Error('这次反馈已经存在，不能覆盖原操作。');
    });
  }

  async read(operationId: string): Promise<FeedbackOperation> {
    const path = join(this.directory(operationId), 'operation.json');
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200000) throw new Error('本地反馈记录无效。');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    const operation = feedbackOperationSchema.parse(value);
    if (operation.draft.operationId !== operationId) throw new Error('本地反馈记录与操作不匹配。');
    return operation;
  }

  async write(operation: FeedbackOperation): Promise<void> {
    const parsed = feedbackOperationSchema.parse(operation);
    await privateDirectory(this.directory(parsed.draft.operationId));
    await writeFileAtomic(join(this.directory(parsed.draft.operationId), 'operation.json'), JSON.stringify(parsed), {durable: true});
    await syncDirectory(this.directory(parsed.draft.operationId));
  }

  async exclusive<T>(operationId: string, action: () => Promise<T>): Promise<T> {
    await privateDirectory(this.directory(operationId));
    const mutex = await acquireMutex(this.directory(operationId), 'creation', 45000);
    try {return await action();}
    finally {await closeMutex(mutex);}
  }

  async verify(draft: FeedbackDraft): Promise<void> {
    const parsed = feedbackDraftSchema.parse(draft);
    const directory = this.directory(parsed.operationId);
    for (const file of parsed.attachments) {
      const parts = file.relativePath.split('/');
      const attachmentId = parts[1];
      if (!attachmentId) throw new Error('附件路径无效。');
      for (const path of [directory, join(directory, 'attachments'), join(directory, 'attachments', attachmentId)]) {
        const entry = await lstat(path);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('附件目录已变化，请重新核对。');
      }
      const bytes = await boundedFile(join(directory, ...parts), 20 * 1024 * 1024);
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('附件已发生变化，请重新核对后提交。');
    }
  }
}
