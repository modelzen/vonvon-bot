import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { clearPosixFixtures, logicalFixturePath, mappedServiceFs, registerPosixFixture } from './service-posix-fixture';

it('rejects traversal at every mapped filesystem boundary without changing outside bytes', async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'vonvon-fixture-boundary-')));
  try {
    const backing = join(root, 'backing');
    await fs.mkdir(backing);
    const outside = join(root, 'outside');
    await fs.writeFile(outside, 'outside sentinel');
    await fs.writeFile(join(backing, 'inside'), 'inside sentinel');
    const logical = registerPosixFixture(backing);
    const mapped = mappedServiceFs(fs);
    const operations: { name: string; run: (path: string) => Promise<unknown> }[] = [
      { name: 'mkdir', run: path => mapped.mkdir(path) },
      { name: 'open', run: async path => { const handle = await mapped.open(path, 'w'); await handle.close(); } },
      { name: 'lstat', run: path => mapped.lstat(path) },
      { name: 'stat', run: path => mapped.stat(path) },
      { name: 'readFile', run: path => mapped.readFile(path) },
      { name: 'writeFile', run: path => mapped.writeFile(path, 'overwritten') },
      { name: 'readdir', run: path => mapped.readdir(path) },
      { name: 'rm', run: path => mapped.rm(path, { recursive: true, force: true }) },
      { name: 'unlink', run: path => mapped.unlink(path) },
      { name: 'rename source', run: path => mapped.rename(path, `${logical}/renamed`) },
      { name: 'rename destination', run: path => mapped.rename(`${logical}/inside`, path) },
      { name: 'symlink target', run: path => mapped.symlink(path, `${logical}/link`) },
      { name: 'symlink destination', run: path => mapped.symlink(`${logical}/inside`, path) },
      { name: 'realpath', run: path => mapped.realpath(path) },
    ];
    for (const path of [`${logical}/../outside`, `${logical}/nested/../../outside`, `${logical}\\..\\outside`]) {
      expect(() => logicalFixturePath(path)).toThrow('POSIX fixture path escapes its backing directory');
      for (const operation of operations) {
        await expect(Promise.resolve().then(() => operation.run(path)), operation.name)
          .rejects.toThrow('POSIX fixture path escapes its backing directory');
        expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel');
        expect(await fs.readFile(join(backing, 'inside'), 'utf8')).toBe('inside sentinel');
        expect(await fs.readdir(backing)).toEqual(['inside']);
      }
    }
    await mapped.writeFile(`${logical}/created`, 'mapped bytes');
    expect(await fs.readFile(join(backing, 'created'), 'utf8')).toBe('mapped bytes');
    expect(await mapped.readFile(`${logical}\\created`, 'utf8')).toBe('mapped bytes');
    expect(await mapped.realpath(`${logical}/created`)).toBe(`${logical}/created`);
    expect(await mapped.readFile(outside, 'utf8')).toBe('outside sentinel');
  } finally {
    clearPosixFixtures();
    await fs.rm(root, { recursive: true, force: true });
  }
});
