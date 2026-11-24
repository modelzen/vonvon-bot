import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const MAX_ARCHIVE_BYTES = 15 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 500;

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK_TYPE = 0o120000;

export interface ZipEntryInput {
  /** Forward-slash relative path inside the archive (e.g. `skills/demo/SKILL.md`). */
  path: string;
  data: Uint8Array;
}

export interface ZipEntry {
  path: string;
  data: Buffer;
}

export interface ZipLimits {
  maxArchiveBytes?: number;
  maxUncompressedBytes?: number;
  maxFiles?: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/;

/**
 * Normalize and validate an archive entry path. Refuses absolute paths, Windows drive letters,
 * `..` traversal, empty segments, NUL/control characters, Windows reserved names, alternate data streams,
 * and trailing dots/spaces.
 */
export function normalizeZipPath(raw: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) throw new Error(`压缩包内存在非法文件名：${raw}`);
  const unified = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!unified || unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) {
    throw new Error(`压缩包内不允许绝对路径：${raw}`);
  }
  const trimmed = unified.replace(/\/+$/, '');
  if (!trimmed) throw new Error(`压缩包内存在空路径：${raw}`);
  const parts = trimmed.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      throw new Error(`压缩包内存在非法或越界路径：${raw}`);
    }
    if (WINDOWS_INVALID_CHARS.test(part) || /[. ]$/.test(part) || WINDOWS_RESERVED_NAME.test(part)) {
      throw new Error(`压缩包内存在不兼容跨平台的文件名：${raw}`);
    }
  }
  return parts.join('/');
}

/** Fixed deterministic DOS timestamp (2026-01-01 00:00:00) so identical inputs produce identical archives. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * Create a standard UTF-8 ZIP archive (Flag bit 11 set) using Node's built-in `node:zlib`.
 * Entries are sorted deterministically by normalized path.
 */
export function createZip(entries: readonly ZipEntryInput[]): Buffer {
  const seen = new Set<string>();
  const seenLower = new Set<string>();
  const sorted = entries.map(entry => {
    const path = normalizeZipPath(entry.path);
    const lower = path.toLowerCase();
    if (seen.has(path) || seenLower.has(lower)) throw new Error(`压缩包内存在重复或大小写冲突路径：${path}`);
    seen.add(path);
    seenLower.add(lower);
    return { path, data: Buffer.from(entry.data) };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const nameBytes = Buffer.from(entry.path, 'utf8');
    const uncompressed = entry.data;
    const deflated = deflateRawSync(uncompressed);
    const useDeflate = deflated.length < uncompressed.length;
    const payload = useDeflate ? deflated : uncompressed;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const checksum = crc32(uncompressed);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // UNIX creator, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    localParts.push(local, payload);
    centralParts.push(central);
    offset += local.length + payload.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function findEocdOffset(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      const commentLen = buffer.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buffer.length) return i;
    }
  }
  throw new Error('无效的 ZIP 文件：缺少目录结束标记');
}

/**
 * Safely read a ZIP buffer, enforcing size, file count, CRC-32, no symlinks, and no path traversal.
 */
export function readZip(raw: Uint8Array, limits: ZipLimits = {}): ZipEntry[] {
  const maxArchiveBytes = limits.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
  const maxUncompressedBytes = limits.maxUncompressedBytes ?? MAX_UNCOMPRESSED_BYTES;
  const maxFiles = limits.maxFiles ?? MAX_ARCHIVE_FILES;

  const buffer = Buffer.from(raw);
  if (buffer.length > maxArchiveBytes) {
    throw new Error(`压缩包体积超过上限（最大 ${Math.round(maxArchiveBytes / (1024 * 1024))} MB）`);
  }
  if (buffer.length < 22) throw new Error('无效的 ZIP 文件：文件过短');

  const eocdOffset = findEocdOffset(buffer);
  const disk = buffer.readUInt16LE(eocdOffset + 4);
  const cdDisk = buffer.readUInt16LE(eocdOffset + 6);
  if (disk !== 0 || cdDisk !== 0) throw new Error('不支持分卷 ZIP 压缩包');

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('不支持 ZIP64 压缩包');
  }
  if (cdOffset + cdSize > eocdOffset) throw new Error('无效的 ZIP 文件：中央目录越界');

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  const seenLower = new Set<string>();
  let totalUncompressed = 0;
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > cdOffset + cdSize) throw new Error('无效的 ZIP 文件：中央目录项截断');
    if (buffer.readUInt32LE(pos) !== CENTRAL_HEADER_SIG) throw new Error('无效的 ZIP 文件：中央目录签名错误');

    const versionMadeBy = buffer.readUInt16LE(pos + 4);
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const expectedCrc = buffer.readUInt32LE(pos + 16);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const externalAttr = buffer.readUInt32LE(pos + 38);
    const localOffset = buffer.readUInt32LE(pos + 42);

    const headerEnd = pos + 46 + nameLen + extraLen + commentLen;
    if (headerEnd > cdOffset + cdSize) throw new Error('无效的 ZIP 文件：文件名长度越界');

    if (flags & 0x0001) throw new Error('暂不支持加密 ZIP 压缩包');

    const rawName = buffer.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos = headerEnd;

    // Reject Unix symlinks regardless of trailing slash.
    const madeByUnix = (versionMadeBy >>> 8) === 3;
    if (madeByUnix && (((externalAttr >>> 16) & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_TYPE)) {
      throw new Error(`压缩包内不允许符号链接：${rawName}`);
    }

    // Skip explicit directory entries after checking path safety.
    if (rawName.endsWith('/') || rawName.endsWith('\\')) {
      normalizeZipPath(rawName);
      continue;
    }

    const normalized = normalizeZipPath(rawName);
    const lower = normalized.toLowerCase();
    if (seen.has(normalized) || seenLower.has(lower)) throw new Error(`压缩包内存在重复或大小写冲突路径：${normalized}`);
    seen.add(normalized);
    seenLower.add(lower);

    if (entries.length + 1 > maxFiles) {
      throw new Error(`压缩包文件数超过上限（最多 ${maxFiles} 个）`);
    }
    if (uncompressedSize > maxUncompressedBytes || totalUncompressed + uncompressedSize > maxUncompressedBytes) {
      throw new Error(`压缩包解压后总大小超过上限（最大 ${Math.round(maxUncompressedBytes / (1024 * 1024))} MB）`);
    }

    if (localOffset + 30 > cdOffset) throw new Error('无效的 ZIP 文件：本地文件头越界');
    if (buffer.readUInt32LE(localOffset) !== LOCAL_HEADER_SIG) throw new Error('无效的 ZIP 文件：本地文件头签名错误');

    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) throw new Error(`无效的 ZIP 文件：条目数据越界（${normalized}）`);

    if (localMethod !== method) {
      throw new Error(`无效的 ZIP 文件：本地文件头压缩方式不一致（${normalized}）`);
    }
    const localRawName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString('utf8');
    if (normalizeZipPath(localRawName) !== normalized) {
      throw new Error(`无效的 ZIP 文件：本地文件头文件名不一致（${normalized}）`);
    }
    if ((flags & 0x0008) === 0 && (localFlags & 0x0008) === 0) {
      if (localCrc !== expectedCrc || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) {
        throw new Error(`无效的 ZIP 文件：本地文件头元数据不一致（${normalized}）`);
      }
    }

    const compressed = buffer.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (method === METHOD_STORE) {
      data = Buffer.from(compressed);
    } else if (method === METHOD_DEFLATE) {
      const remaining = maxUncompressedBytes - totalUncompressed;
      try {
        data = inflateRawSync(compressed, { maxOutputLength: remaining });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|Cannot create a Buffer larger/i.test(String(err))) {
          throw new Error(`压缩包解压后总大小超过上限（最大 ${Math.round(maxUncompressedBytes / (1024 * 1024))} MB）`);
        }
        throw new Error(`压缩包解压失败（${normalized}）：${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      throw new Error(`压缩包使用了不支持的压缩方式（method=${method}）：${normalized}`);
    }

    totalUncompressed += data.length;
    if (totalUncompressed > maxUncompressedBytes) {
      throw new Error(`压缩包解压后总大小超过上限（最大 ${Math.round(maxUncompressedBytes / (1024 * 1024))} MB）`);
    }
    if (data.length !== uncompressedSize) {
      throw new Error(`压缩包条目大小不匹配：${normalized}`);
    }
    if (crc32(data) !== expectedCrc) {
      throw new Error(`压缩包条目校验和错误：${normalized}`);
    }

    entries.push({ path: normalized, data });
  }

  return entries;
}
