import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { VERSION } from './current-release';

/**
 * Unpacks a standalone server package (server-3 4.3) without a tar library. Only regular files and directories
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
  let refusal: ArchiveError | undefined;
  try {
    // pipeline, not pipe: a read error on the archive (ENOENT, EACCES, EIO) rejects here instead of killing the daemon
    await pipeline(createReadStream(file), createGunzip(), async (chunks: AsyncIterable<Buffer>) => {
      try {
      for await (const chunk of chunks) {
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
      } catch (error) {
        // Some Node versions report the pipeline's cleanup AbortError instead
        // of the consumer's refusal. Keep the original validation reason.
        if (error instanceof ArchiveError) refusal = error;
        throw error;
      }
    });
  } catch (error) {
    throw refusal ?? error;
  } finally { await entry?.handle.close(); }
  if (!ended || entry) throw new ArchiveError('corrupt', 'the tar archive ends early');
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
