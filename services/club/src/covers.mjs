import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { sha256Hex } from './crypto.mjs';
import { detectImageExtension, isFeishuDocUrl, MAX_COVER_UPLOAD_BYTES } from './validate.mjs';

const execFileAsync = promisify(execFile);

/**
 * Save a validated PNG/JPEG/WebP cover image into `<coversDir>` under a content-addressed filename.
 * Returns the relative public URL `/covers/<sha256>.<ext>`.
 */
export async function saveCoverBytes(coversDir, bytes, maxBytes = MAX_COVER_UPLOAD_BYTES) {
  const buf = Buffer.from(bytes);
  if (buf.length === 0) throw Object.assign(new Error('封面图片为空'), { status: 400 });
  if (buf.length > maxBytes) {
    throw Object.assign(new Error(`封面图片超过大小上限（最大 ${Math.round(maxBytes / 1024)} KB）`), { status: 400 });
  }
  const ext = detectImageExtension(buf);
  if (!ext) throw Object.assign(new Error('封面仅支持 PNG、JPEG 或 WebP 格式'), { status: 400 });

  const hash = sha256Hex(buf).slice(0, 24);
  const filename = `${hash}.${ext}`;
  await mkdir(coversDir, { recursive: true });
  const target = join(coversDir, filename);
  const tmp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, target);
  return { filename, url: `/covers/${filename}`, bytes: buf.length, ext };
}

/**
 * Optional helper for admins/hosts that have `lark-cli` logged in (`--as user` or `--as bot`):
 * attempts to download a public Feishu cloud document's cover once and cache it locally.
 * Never throws when a document simply has no cover — returns `{ ok: false, reason }` so Plan A fallback applies.
 */
export async function fetchFeishuCoverViaLarkCli(docUrl, coversDir, options = {}) {
  if (!isFeishuDocUrl(docUrl)) return { ok: false, reason: 'not_feishu_doc' };
  const larkBin = options.larkBin ?? 'lark-cli';
  const identity = options.identity ?? 'user';
  const maxBytes = options.maxBytes ?? MAX_COVER_UPLOAD_BYTES;
  const tempBase = process.platform === 'win32' ? tmpdir() : '/tmp';
  const stem = join(tempBase, `vonvon-club-cover-${randomUUID().slice(0, 8)}`);

  try {
    const { stdout } = await execFileAsync(larkBin, [
      'docs', '+resource-download', '--as', identity, '--doc', docUrl, '--type', 'cover', '--output', stem, '--overwrite', '--json',
    ], { timeout: 20_000 });
    const parsed = JSON.parse(stdout);
    const savedPath = parsed?.data?.saved_path;
    if (!parsed?.ok || typeof savedPath !== 'string') {
      return { ok: false, reason: parsed?.error?.subtype ?? 'no_cover' };
    }
    try {
      const raw = await readFile(savedPath);
      const saved = await saveCoverBytes(coversDir, raw, maxBytes);
      return { ok: true, ...saved };
    } finally {
      await rm(savedPath, { force: true }).catch(() => undefined);
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
