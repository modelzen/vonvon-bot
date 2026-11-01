import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { ArchiveError, extractTarGz, extractZip, removeStaging } from '../src/service/archive';
import { buildTools, packRelease } from './helpers/fake-release';

// main 必败: the update had no unpacker (server-3 4.3)
const root = mkdtempSync(join(tmpdir(), 'vonvon-archive-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
const scratch = (): string => join(root, `case-${++count}`);

/** A ustar member of any type, with its checksum made again after the change. */
async function member(path: string, data: string, type = '0'): Promise<Buffer> {
  const header = Buffer.from((await buildTools()).tarHeader('x', Buffer.byteLength(data), 0o644, 1));
  header.fill(0, 0, 100);
  header.write(path, 0, 'utf8');
  header.write(type, 156, 'ascii');
  header.fill(' ', 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);
  const body = Buffer.alloc(Math.ceil(Buffer.byteLength(data) / 512) * 512);
  body.write(data);
  return Buffer.concat([header, body]);
}
async function tarGz(members: Buffer[]): Promise<string> {
  const file = `${scratch()}.tar.gz`;
  await writeFile(file, gzipSync(Buffer.concat([...members, Buffer.alloc(1024)])));
  return file;
}
const refusal = async (run: Promise<unknown>): Promise<string> => run.then(() => 'accepted', (error: unknown) => (error instanceof ArchiveError ? error.reason : String(error)));

describe('extractTarGz', () => {
  it('unpacks a package with its files and modes', async () => {
    const pkg = await packRelease(root, '1.0.1');
    const into = scratch();
    await extractTarGz(pkg.archive, into);
    expect(JSON.parse(await readFile(join(into, 'standalone.json'), 'utf8'))).toEqual({ v: 1, version: '1.0.1' });
    expect((await stat(join(into, 'node/bin/node'))).mode & 0o777).toBe(0o755);
    expect((await stat(join(into, 'app/bin/vonvon.mjs'))).mode & 0o777).toBe(0o644);
  });
  it.each([
    ['a parent path', '../x', '0'],
    ['a parent path inside', 'app/../../x', '0'],
    ['an absolute path', '/tmp/x', '0'],
    ['a symbolic link', 'app/link', '2'],
    ['a hard link', 'app/hard', '1'],
    ['a device', 'app/dev', '3'],
  ])('refuses %s and writes nothing', async (_name, path, type) => {
    const into = scratch();
    expect(await refusal(extractTarGz(await tarGz([await member(path, 'evil', type)]), into))).toBe('unsafe');
    expect(await readdir(into)).toEqual([]);
  });
  it('refuses more than 50,000 members', async () => {
    const dir = await member('d/', '', '5');
    const into = scratch();
    expect(await refusal(extractTarGz(await tarGz(Array.from({ length: 50_001 }, () => dir)), into))).toBe('too_big');
  });
  it('refuses an archive cut short', async () => {
    const file = `${scratch()}.tar.gz`;
    await writeFile(file, gzipSync(await member('a.txt', 'hello')));
    expect(await refusal(extractTarGz(file, scratch()))).toBe('corrupt');
  });
});

describe('extractZip', () => {
  it('unpacks a Windows package', async () => {
    const pkg = await packRelease(root, '1.0.1', true);
    const into = scratch();
    await extractZip(pkg.archive, into);
    expect(await readFile(join(into, 'node/node.exe'), 'utf8')).toBe('MZ');
  });
  it('refuses a member whose attributes say symbolic link', async () => {
    const pkg = await packRelease(root, '1.0.2', true);
    const bytes = await readFile(pkg.archive);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(0xa1ff << 16 >>> 0, central + 38);
    const file = `${scratch()}.zip`;
    await writeFile(file, bytes);
    expect(await refusal(extractZip(file, scratch()))).toBe('unsafe');
  });
});

describe('removeStaging', () => {
  it('removes only releases/<version>.part', async () => {
    const install = scratch();
    const part = join(install, 'releases', '1.0.1.part');
    await mkdir(join(part, 'app'), { recursive: true });
    await expect(removeStaging(install, '../1.0.1')).rejects.toThrow('not a version');
    await removeStaging(install, '1.0.1');
    expect(await readdir(join(install, 'releases'))).toEqual([]);
    await removeStaging(install, '1.0.1');
  });
});
