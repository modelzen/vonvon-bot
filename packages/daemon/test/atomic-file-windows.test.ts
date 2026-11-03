import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

/** How many renames fail the way Windows fails while another process has the target open. */
const fs = vi.hoisted(() => ({ refuse: 0, code: 'EPERM', calls: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      fs.calls++;
      if (fs.refuse > 0) { fs.refuse--; throw Object.assign(new Error(`${fs.code}: operation not permitted, rename`), { code: fs.code }); }
      return actual.rename(...args);
    },
  };
});

import { writeFileAtomic } from '../src/server/atomic-file';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const roots: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  Object.assign(fs, { refuse: 0, code: 'EPERM', calls: 0 });
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function target() {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-atomic-'));
  roots.push(root);
  const file = join(root, 'daemon.pid');
  await writeFile(file, 'old');
  return { root, file };
}

// main 必败 (#667 Windows CI): the CLI polled daemon.pid while the daemon published readiness; Windows refused the rename
// over the open file with EPERM and the daemon died before it was ready.
it('on Windows retries a rename refused while a reader has the file open, and leaves no temporary file', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const { root, file } = await target();
    Object.assign(fs, { refuse: 3, code, calls: 0 });
    await writeFileAtomic(file, `new ${code}`);
    expect(await readFile(file, 'utf8')).toBe(`new ${code}`);
    expect(fs.calls).toBe(4);
    expect(await readdir(root)).toEqual(['daemon.pid']);
  }
});

it('gives up after a short while on Windows, and does not retry elsewhere', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const windows = await target();
  fs.refuse = 100;
  await expect(writeFileAtomic(windows.file, 'new')).rejects.toMatchObject({ code: 'EPERM' });
  expect(fs.calls).toBe(9);
  expect(await readFile(windows.file, 'utf8')).toBe('old');
  expect(await readdir(windows.root)).toEqual(['daemon.pid']);
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  const linux = await target();
  Object.assign(fs, { refuse: 1, calls: 0 });
  await expect(writeFileAtomic(linux.file, 'new')).rejects.toMatchObject({ code: 'EPERM' });
  expect(fs.calls).toBe(1);
});
