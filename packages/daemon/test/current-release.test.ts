import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readlink, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readCurrent, ReleaseIncomplete, switchCurrent } from '../src/service/current-release';

// main 必败: there was no current pointer to switch (server-3 C5)
const root = mkdtempSync(join(tmpdir(), 'vonvon-current-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
async function install(...versions: string[]): Promise<string> {
  const dir = join(root, `install-${++count}`);
  for (const version of versions) {
    await mkdir(join(dir, 'releases', version), { recursive: true });
    await writeFile(join(dir, 'releases', version, 'standalone.json'), JSON.stringify({ v: 1, version }));
  }
  return dir;
}

describe('POSIX current link', () => {
  it('points current at releases/<v> through current.next, and returns what it pointed at', async () => {
    const dir = await install('1.0.0', '1.0.1');
    expect(await switchCurrent(dir, '1.0.0', 'linux')).toEqual({ previous: null });
    await symlink('releases/stale', join(dir, 'current.next'));
    expect(await switchCurrent(dir, '1.0.1', 'linux')).toEqual({ previous: '1.0.0' });
    expect(await readlink(join(dir, 'current'))).toBe('releases/1.0.1');
    expect(await readdir(dir)).not.toContain('current.next');
    expect(await readCurrent(dir, 'linux')).toEqual({ version: '1.0.1' });
  });
  it('refuses a release without its standalone.json and leaves current alone', async () => {
    const dir = await install('1.0.0');
    await switchCurrent(dir, '1.0.0', 'linux');
    await mkdir(join(dir, 'releases', '1.0.1'));
    await expect(switchCurrent(dir, '1.0.1', 'linux')).rejects.toBeInstanceOf(ReleaseIncomplete);
    await writeFile(join(dir, 'releases', '1.0.1', 'standalone.json'), JSON.stringify({ v: 1, version: '1.0.2' }));
    await expect(switchCurrent(dir, '1.0.1', 'linux')).rejects.toBeInstanceOf(ReleaseIncomplete);
    expect(await readlink(join(dir, 'current'))).toBe('releases/1.0.0');
  });
  it('reads a link that is not a release as no current', async () => {
    const dir = await install();
    await mkdir(dir, { recursive: true });
    expect(await readCurrent(dir, 'linux')).toBeNull();
    await symlink('/elsewhere', join(dir, 'current'));
    expect(await readCurrent(dir, 'linux')).toBeNull();
  });
});

describe('Windows current.txt', () => {
  it('writes the version and the one before it, and no temporary file is left', async () => {
    const dir = await install('1.0.0', '1.0.1');
    await switchCurrent(dir, '1.0.0', 'win32');
    expect(await readFile(join(dir, 'current.txt'), 'utf8')).toBe('1.0.0\n\n');
    expect(await switchCurrent(dir, '1.0.1', 'win32')).toEqual({ previous: '1.0.0' });
    expect(await readFile(join(dir, 'current.txt'), 'utf8')).toBe('1.0.1\n1.0.0\n');
    expect(await readCurrent(dir, 'win32')).toEqual({ version: '1.0.1', previous: '1.0.0' });
    expect(await readdir(dir)).not.toContain('current.txt.tmp');
  });
});
