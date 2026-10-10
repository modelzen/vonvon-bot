import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalFileSafetyError,
  readBoundedFile,
  readBoundedUtf8FileStrict,
  statDirectoryBounded,
  withTimeout,
} from '../src/import/bridge/bounded-local-files';

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-import-files-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bounded local files', () => {
  it('accepts the exact byte cap and refuses a file one byte larger', async () => {
    const root = await fixture();
    const file = join(root, 'bytes');
    await writeFile(file, 'abcd');
    expect(await readBoundedFile(file, { maxBytes: 4, timeoutMs: 2_000 })).toEqual(Buffer.from('abcd'));
    await writeFile(file, 'abcde');
    await expect(readBoundedFile(file, { maxBytes: 4, timeoutMs: 2_000 }))
      .rejects.toMatchObject({ problem: 'too-large' });
  });

  it('refuses final symlinks, directories, and malformed UTF-8', async () => {
    const root = await fixture();
    const file = join(root, 'bytes');
    await writeFile(file, Buffer.from([0xff]));
    await symlink(file, join(root, 'link'));
    await expect(readBoundedFile(join(root, 'link'), { maxBytes: 8, timeoutMs: 2_000 })).rejects.toThrow();
    await expect(readBoundedFile(root, { maxBytes: 8, timeoutMs: 2_000 }))
      .rejects.toMatchObject({ problem: 'not-regular-file' });
    await expect(readBoundedUtf8FileStrict(file, { maxBytes: 8, timeoutMs: 2_000 }))
      .rejects.toMatchObject({ problem: 'invalid-encoding' });
    await expect(statDirectoryBounded(join(root, 'link'), 2_000, { followFinalSymlink: false }))
      .rejects.toMatchObject({ problem: 'not-directory' });
    await mkdir(join(root, 'directory'));
    expect((await statDirectoryBounded(join(root, 'directory'), 2_000, { followFinalSymlink: false })).isDirectory()).toBe(true);
  });

  it('observes late failures when a signal was already aborted', async () => {
    const root = await fixture();
    const controller = new AbortController();
    controller.abort();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(readBoundedFile(join(root, 'absent'), {
        maxBytes: 8, timeoutMs: 2_000, signal: controller.signal,
      })).rejects.toMatchObject({ problem: 'timed-out' });
      await expect(withTimeout(Promise.reject(new Error('late failure')), 2_000, controller.signal))
        .rejects.toBeInstanceOf(LocalFileSafetyError);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('refuses a FIFO without waiting for a writer', async () => {
    if (process.platform === 'win32') return;
    const root = await fixture();
    const pipe = join(root, 'pipe');
    expect(spawnSync('mkfifo', [pipe]).status).toBe(0);
    await expect(readBoundedFile(pipe, { maxBytes: 8, timeoutMs: 2_000 }))
      .rejects.toMatchObject({ problem: 'not-regular-file' });
  });
});
