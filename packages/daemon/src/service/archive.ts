import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createGunzip, crc32, inflateRawSync } from 'node:zlib';
import { VERSION } from './current-release';

/**
 * Unpacks a standalone server package (server-3 4.3) without a tar or zip library. Only regular files and directories
 * are taken: links, devices and anything else are refused, as are absolute paths, `..` and backslashes. A package is
 * built without links (scripts/build-server.mjs `checkServerTree`). Modes are 0755 when any execute bit is set, else 0644.
 */
export type ArchiveFailure = 'unsafe' | 'too_big' | 'corrupt';
export class ArchiveError extends Error {
  constructor(readonly reason: ArchiveFailure, detail: string) { super(`archive refused (${reason}): ${detail}`); }
}
export type ArchiveLimits = { maxEntries?: number; maxBytes?: number };
const DEFAULTS = { maxEntries: 50_000, maxBytes: 2 * 1024 ** 3 };

/** The member's path inside `into`, or a refusal. */
function memberPath(into: string, name: string): string {
  const path = name.endsWith('/') ? name.slice(0, -1) : name;
  const parts = path.split('/');
  if (!path || path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[a-z]:/i.test(path)
    || parts.some(part => part === '' || part === '.' || part === '..')) throw new ArchiveError('unsafe', JSON.stringify(name));
  const target = resolve(into, ...parts);
  if (!target.startsWith(resolve(into) + sep)) throw new ArchiveError('unsafe', JSON.stringify(name));
  return target;
}

const fileMode = (mode: number): number => (mode & 0o111 ? 0o755 : 0o644);

class Writer {
  private dirs = new Set<string>();
  private entries = 0;
  private bytes = 0;
  constructor(private into: string, private limits: Required<ArchiveLimits>) {}
  count(size: number): void {
    this.entries += 1;
    this.bytes += size;
    if (this.entries > this.limits.maxEntries || this.bytes > this.limits.maxBytes) throw new ArchiveError('too_big', `${this.entries} members, ${this.bytes} bytes`);
  }
  async dir(path: string): Promise<void> {
    if (this.dirs.has(path)) return;
    await mkdir(path, { recursive: true });
    this.dirs.add(path);
  }
  async file(name: string, mode: number): Promise<FileHandle> {
    const target = memberPath(this.into, name);
    await this.dir(resolve(target, '..'));
    return open(target, 'wx', fileMode(mode));
  }
}

const octal = (field: Buffer): number => {
  const text = field.toString('ascii').replace(/[\0 ]+$/, '').trim();
  if (!/^[0-7]*$/.test(text)) throw new ArchiveError('corrupt', 'a header number is not octal');
  return text ? Number.parseInt(text, 8) : 0;
};
const text = (field: Buffer): string => { const end = field.indexOf(0); return field.subarray(0, end < 0 ? field.length : end).toString('utf8'); };

export async function extractTarGz(file: string, into: string, limits: ArchiveLimits = {}): Promise<void> {
  const writer = new Writer(into, { ...DEFAULTS, ...limits });
  await mkdir(into, { recursive: true });
  let pending = Buffer.alloc(0);
  let entry: { handle: FileHandle; remaining: number; pad: number } | undefined;
  let ended = false;
  try {
    for await (const chunk of createReadStream(file).pipe(createGunzip()) as AsyncIterable<Buffer>) {
      if (ended) continue;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        if (entry) {
          if (entry.remaining > 0) {
            if (!pending.length) break;
            const take = Math.min(entry.remaining, pending.length);
            await entry.handle.write(pending.subarray(0, take));
            pending = pending.subarray(take);
            entry.remaining -= take;
            continue;
          }
          if (pending.length < entry.pad) break;
          pending = pending.subarray(entry.pad);
          await entry.handle.close();
          entry = undefined;
          continue;
        }
        if (pending.length < 512) break;
        const header = pending.subarray(0, 512);
        pending = pending.subarray(512);
        if (header.every(byte => byte === 0)) { ended = true; break; }
        let sum = 0;
        for (let at = 0; at < 512; at++) sum += at >= 148 && at < 156 ? 32 : header[at]!;
        if (octal(header.subarray(148, 156)) !== sum || !header.subarray(257, 262).equals(Buffer.from('ustar'))) throw new ArchiveError('corrupt', 'bad tar header');
        const prefix = text(header.subarray(345, 500));
        const name = prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100));
        const type = String.fromCharCode(header[156]!);
        const size = octal(header.subarray(124, 136));
        writer.count(size);
        if (type === '5') { await writer.dir(memberPath(into, name)); continue; }
        if (type !== '0' && type !== '\0') throw new ArchiveError('unsafe', `${JSON.stringify(name)} is not a regular file or directory`);
        entry = { handle: await writer.file(name, octal(header.subarray(100, 108))), remaining: size, pad: (512 - (size % 512)) % 512 };
      }
    }
  } finally { await entry?.handle.close(); }
  if (!ended || entry) throw new ArchiveError('corrupt', 'the tar archive ends early');
}

/** A zip read through its central directory: stored or deflated, CRC checked, no ZIP64 or encryption. */
export async function extractZip(file: string, into: string, limits: ArchiveLimits = {}): Promise<void> {
  const writer = new Writer(into, { ...DEFAULTS, ...limits });
  await mkdir(into, { recursive: true });
  const bytes = await readFile(file);
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length) throw new ArchiveError('corrupt', 'not a zip');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) throw new ArchiveError('corrupt', 'bad central directory');
    const [flags, method, crc, size, length, nameLength, extra, comment] = [bytes.readUInt16LE(at + 8), bytes.readUInt16LE(at + 10), bytes.readUInt32LE(at + 16), bytes.readUInt32LE(at + 20), bytes.readUInt32LE(at + 24), bytes.readUInt16LE(at + 28), bytes.readUInt16LE(at + 30), bytes.readUInt16LE(at + 32)];
    const attributes = bytes.readUInt32LE(at + 38);
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extra + comment;
    const kind = (attributes >>> 16) & 0o170000;
    if (kind && kind !== 0o100000 && kind !== 0o040000) throw new ArchiveError('unsafe', `${JSON.stringify(name)} is not a regular file or directory`);
    if (flags & 1 || ![0, 8].includes(method) || size === 0xffffffff || length === 0xffffffff) throw new ArchiveError('corrupt', `unsupported entry ${JSON.stringify(name)}`);
    writer.count(length);
    if (name.endsWith('/') || kind === 0o040000) { await writer.dir(memberPath(into, name)); continue; }
    if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) throw new ArchiveError('corrupt', `bad local header for ${JSON.stringify(name)}`);
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const body = bytes.subarray(start, start + size);
    let data: Buffer;
    try { data = method === 8 ? inflateRawSync(body, { maxOutputLength: length + 1 }) : body; }
    catch { throw new ArchiveError('corrupt', `${JSON.stringify(name)} does not inflate`); }
    if (data.length !== length || crc32(data) !== crc) throw new ArchiveError('corrupt', `${JSON.stringify(name)} is damaged`);
    const handle = await writer.file(name, (attributes >>> 16) & 0o777);
    try { await handle.write(data); } finally { await handle.close(); }
  }
}

/**
 * Removes `<installRoot>/releases/<version>.part`, a half-unpacked download, and nothing else: the version must be one,
 * and the path a real directory, not a link.
 */
export async function removeStaging(installRoot: string, version: string): Promise<void> {
  if (!VERSION.test(version)) throw new Error(`not a version: ${version}`);
  const staging = join(installRoot, 'releases', `${version}.part`);
  try {
    const info = await lstat(staging);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${staging} is not a directory`);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  await rm(staging, { recursive: true, force: true });
}
