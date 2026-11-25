import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { paths } from '../config/paths';
import { resolveLarkCliBin } from '../platform/lark-cli';
import { binChildEnv } from '../platform/tool-path';
import { MAX_ARCHIVE_BYTES } from './zip';
import type { TemplateSourceKind } from './club-client';

const execFileAsync = promisify(execFile);

const FETCH_TIMEOUT_MS = 15_000;
const GIT_CLONE_TIMEOUT_MS = 45_000;
const LARK_CLI_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 8;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface FetchTemplateResult {
  url: string;
  resolved: boolean;
  /** Local `.vonvon.zip` file or cloned repository directory ready for `vonvon template inspect` / `stage`. */
  localPath?: string;
  sourceKind?: TemplateSourceKind;
  sourceUrl?: string;
  docUrl?: string;
  via?: 'lark-cli' | 'feishu-public' | 'git-clone' | 'direct-download';
  title?: string;
  attachmentName?: string;
  attachmentToken?: string;
  repositories?: string[];
  reason?: string;
  hint?: string;
}

export interface FeishuDocSourceHints {
  title?: string;
  docToken?: string;
  repositories: string[];
  embeddedZips: { name: string; token: string }[];
  driveFileUrls: string[];
  directZipUrls: string[];
  templateId?: string;
}

export function isAllowedFeishuHost(hostname: string): boolean {
  return /(?:^|\.)(?:feishu\.cn|larkoffice\.com|larksuite\.com|feishucdn\.com|larksuitecdn\.com)$/i.test(hostname);
}

export function isFeishuDocUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:'
      && /(?:^|\.)(?:feishu\.cn|larkoffice\.com|larksuite\.com)$/i.test(u.hostname)
      && /^\/(?:docx|wiki|docs)\/[A-Za-z0-9_-]+/.test(u.pathname);
  } catch {
    return false;
  }
}

export function parseGitHubRepoUrl(raw: string): { repoUrl: string; branch?: string; subdir?: string } | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') return undefined;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return undefined;
    const owner = parts[0]!;
    const repo = parts[1]!.replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return undefined;
    if (parts.length >= 4 && parts[2] === 'tree') {
      const branch = parts[3]!;
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..')) {
        return { repoUrl: `https://github.com/${owner}/${repo}` };
      }
      const subdirParts = parts.slice(4);
      if (subdirParts.some(p => p === '.' || p === '..' || p.includes('\\'))) {
        return { repoUrl: `https://github.com/${owner}/${repo}`, branch };
      }
      return {
        repoUrl: `https://github.com/${owner}/${repo}`,
        branch,
        ...(subdirParts.length ? { subdir: subdirParts.join('/') } : {}),
      };
    }
    return { repoUrl: `https://github.com/${owner}/${repo}` };
  } catch {
    return undefined;
  }
}

function isZipMagic(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05) && (buf[3] === 0x04 || buf[3] === 0x06);
}

function sanitizeZipFilename(rawName: string | undefined, fallback = 'template.vonvon.zip'): string {
  const base = basename((rawName ?? '').trim().replace(/\\/g, '/'))
    .replace(/[^A-Za-z0-9._\u4e00-\u9fa5-]/g, '-')
    .replace(/^\.+/, '');
  if (!base) return fallback;
  return base.toLowerCase().endsWith('.vonvon.zip')
    ? base
    : base.toLowerCase().endsWith('.zip')
      ? base
      : `${base}.vonvon.zip`;
}

function extractXmlAttr(tag: string, attr: string): string | undefined {
  const re = new RegExp(`\\b${attr}=(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = tag.match(re);
  return (m?.[1] ?? m?.[2])?.trim() || undefined;
}

function dedupePush<T>(list: T[], value: T, keyFn: (v: T) => string): void {
  const k = keyFn(value);
  if (!list.some(item => keyFn(item) === k)) list.push(value);
}

/**
 * Parse embedded `.vonvon.zip` attachments, Drive file links, and GitHub repository URLs
 * from either `lark-cli docs +fetch` DocxXML/Markdown output or anonymous Feishu SSR HTML.
 */
export function extractFeishuDocSourceHints(content: string): FeishuDocSourceHints {
  const repositories: string[] = [];
  const embeddedZips: { name: string; token: string }[] = [];
  const driveFileUrls: string[] = [];
  const directZipUrls: string[] = [];

  const titleMatch = content.match(/<title>([^<]{1,200})<\/title>/i);
  const title = titleMatch?.[1]?.trim();

  const docTokenMatch = content.match(/window\.SERVER_DATA\s*=\s*Object\(\{"meta":\{[^{}]{0,500}"token"\s*:\s*"([A-Za-z0-9_-]{12,64})"/);
  const docToken = docTokenMatch?.[1];

  // 1. DocxXML file/source tags from `lark-cli docs +fetch`
  const xmlTagRe = /<(?:source|file)\b[^>]*>/gi;
  for (const m of content.matchAll(xmlTagRe)) {
    const tag = m[0];
    const token = extractXmlAttr(tag, 'token') ?? extractXmlAttr(tag, 'file_token');
    const name = extractXmlAttr(tag, 'name') ?? extractXmlAttr(tag, 'file_name') ?? '';
    if (token && /\.vonvon\.zip$/i.test(name)) {
      dedupePush(embeddedZips, { name, token }, item => item.token);
    }
  }

  // 2. Feishu SSR `block_map` JSON file blocks: `"file":{"name":"...vonvon.zip","token":"..."}` (either key order)
  const jsonFileRe1 = /"file"\s*:\s*\{[^{}]{0,400}"name"\s*:\s*"([^"]+\.vonvon\.zip)"[^{}]{0,400}"token"\s*:\s*"([A-Za-z0-9_-]{12,80})"/gi;
  for (const m of content.matchAll(jsonFileRe1)) {
    dedupePush(embeddedZips, { name: m[1]!, token: m[2]! }, item => item.token);
  }
  const jsonFileRe2 = /"file"\s*:\s*\{[^{}]{0,400}"token"\s*:\s*"([A-Za-z0-9_-]{12,80})"[^{}]{0,400}"name"\s*:\s*"([^"]+\.vonvon\.zip)"/gi;
  for (const m of content.matchAll(jsonFileRe2)) {
    dedupePush(embeddedZips, { name: m[2]!, token: m[1]! }, item => item.token);
  }

  // 3. Normalize escaped slashes / URL encoding before scanning links
  const normalized = content
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&');

  const githubRe = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/tree\/[A-Za-z0-9._/%-]+)?/g;
  for (const m of normalized.matchAll(githubRe)) {
    const cleaned = m[0].replace(/[),.;:!?'"`<>\]}]+$/, '').replace(/\.git$/i, '');
    const parsed = parseGitHubRepoUrl(cleaned);
    if (parsed) {
      dedupePush(repositories, cleaned, s => s.toLowerCase());
    }
  }

  const driveFileRe = /https:\/\/[A-Za-z0-9.-]+\.(?:feishu\.cn|larkoffice\.com|larksuite\.com)\/file\/[A-Za-z0-9_-]+/g;
  for (const m of normalized.matchAll(driveFileRe)) {
    dedupePush(driveFileUrls, m[0], s => s);
  }

  const directZipRe = /https:\/\/[^\s"'<>\\)]+\.vonvon\.zip(?:\?[^\s"'<>\\)]*)?/gi;
  for (const m of normalized.matchAll(directZipRe)) {
    dedupePush(directZipUrls, m[0], s => s);
  }

  const idMatch = content.match(/Vonvon\s*配方[：:]\s*([a-z0-9][a-z0-9/-]{0,126})/i);
  const templateId = idMatch?.[1]?.trim();

  return {
    ...(title ? { title } : {}),
    ...(docToken ? { docToken } : {}),
    repositories,
    embeddedZips,
    driveFileUrls,
    directZipUrls,
    ...(templateId ? { templateId } : {}),
  };
}

function mergeCookies(jar: Map<string, string>, response: Response): void {
  const headers = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  for (const line of headers) {
    const first = line.split(';', 1)[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const val = first.slice(eq + 1).trim();
    if (name) jar.set(name, val);
  }
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error(`下载体积超过上限（最大 ${Math.round(maxBytes / (1024 * 1024))} MB）`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function fetchWithCookies(
  initialUrl: string,
  jar: Map<string, string>,
  options: {
    fetchImpl?: typeof fetch;
    referer?: string;
    maxBytes: number;
    allowAnyHttps?: boolean;
  },
): Promise<{ ok: true; finalUrl: string; contentType: string; bytes: Buffer } | { ok: false; reason: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let current = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return { ok: false, reason: 'invalid_url' };
    }
    if (parsed.protocol !== 'https:') return { ok: false, reason: 'non_https' };
    if (!options.allowAnyHttps && !isAllowedFeishuHost(parsed.hostname)) {
      return { ok: false, reason: 'disallowed_redirect_host' };
    }

    const headers: Record<string, string> = {
      'user-agent': BROWSER_UA,
      'accept-language': 'zh-CN,zh;q=0.9',
      ...(options.referer ? { referer: options.referer } : {}),
    };
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;

    const res = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    mergeCookies(jar, res);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return { ok: false, reason: 'empty_redirect' };
      try {
        current = new URL(location, current).toString();
      } catch {
        return { ok: false, reason: 'invalid_redirect' };
      }
      continue;
    }

    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const bytes = await readBoundedBytes(res, options.maxBytes);
    return { ok: true, finalUrl: current, contentType: res.headers.get('content-type') ?? '', bytes };
  }
  return { ok: false, reason: 'too_many_redirects' };
}

async function ensureEmptyDestDir(destDir: string): Promise<string> {
  const resolved = resolve(destDir);
  try {
    const info = await lstat(resolved);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`目标路径必须是目录且不能是符号链接：${destDir}`);
    }
    const entries = (await readdir(resolved)).filter(n => n !== '.DS_Store' && n !== 'Thumbs.db');
    if (entries.length > 0) {
      throw new Error(`拉取目标目录非空（请指定空目录）：${resolved}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    await mkdir(resolved, { recursive: true });
  }
  return realpath(resolved);
}

async function cloneGitHubRepo(
  rawRepoUrl: string,
  destDir: string,
  gitRunner?: (args: string[]) => Promise<void>,
): Promise<{ localPath: string; sourceUrl: string }> {
  const parsed = parseGitHubRepoUrl(rawRepoUrl);
  if (!parsed) throw new Error(`不支持的 GitHub 仓库链接：${rawRepoUrl}`);
  const cloneTarget = join(destDir, 'repo');
  const args = ['clone', '--depth', '1', '--single-branch'];
  if (parsed.branch) args.push('--branch', parsed.branch);
  args.push('--', parsed.repoUrl, cloneTarget);

  if (gitRunner) {
    await gitRunner(args);
  } else {
    await execFileAsync('git', args, {
      timeout: GIT_CLONE_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  }

  let localPath = cloneTarget;
  if (parsed.subdir) {
    const candidate = resolve(cloneTarget, parsed.subdir);
    const realClone = await realpath(cloneTarget);
    const realCand = await realpath(candidate);
    if (!realCand.startsWith(realClone)) throw new Error('仓库子目录越界');
    localPath = realCand;
  }
  return { localPath, sourceUrl: rawRepoUrl };
}

async function tryLarkCliFetchDoc(
  docUrl: string,
  dataRoot: string,
  execLark?: (args: string[]) => Promise<string>,
): Promise<{ ok: true; content: string; title?: string; docId?: string } | { ok: false }> {
  const bin = resolveLarkCliBin({ dataRoot }) ?? 'lark-cli';
  const args = ['docs', '+fetch', '--as', 'user', '--doc', docUrl, '--format', 'json'];
  try {
    const stdout = execLark
      ? await execLark(args)
      : (await execFileAsync(bin, args, {
          timeout: LARK_CLI_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          ...(process.platform !== 'win32' && bin !== 'lark-cli' ? { env: binChildEnv(bin) } : {}),
        })).stdout;
    const parsed = JSON.parse(stdout) as {
      ok?: boolean;
      data?: { document?: { content?: string; title?: string; document_id?: string } };
    };
    const content = parsed?.data?.document?.content;
    if (!parsed?.ok || typeof content !== 'string' || !content.trim()) return { ok: false };
    return {
      ok: true,
      content,
      ...(parsed.data?.document?.title ? { title: parsed.data.document.title } : {}),
      ...(parsed.data?.document?.document_id ? { docId: parsed.data.document.document_id } : {}),
    };
  } catch {
    return { ok: false };
  }
}

async function tryLarkCliMediaDownload(
  token: string,
  filename: string,
  destDir: string,
  dataRoot: string,
  execLark?: (args: string[]) => Promise<string>,
): Promise<string | undefined> {
  const bin = resolveLarkCliBin({ dataRoot }) ?? 'lark-cli';
  const baseTmp = process.platform === 'win32' ? tmpdir() : '/tmp';
  const tmpOut = join(baseTmp, `vonvon-tpl-${process.pid}-${randomUUID().slice(0, 8)}-${sanitizeZipFilename(filename)}`);
  const args = ['docs', '+media-download', '--as', 'user', '--token', token, '--output', tmpOut, '--overwrite', '--json'];
  let savedPath: string | undefined;
  try {
    const stdout = execLark
      ? await execLark(args)
      : (await execFileAsync(bin, args, {
          timeout: LARK_CLI_TIMEOUT_MS,
          maxBuffer: 512 * 1024,
          ...(process.platform !== 'win32' && bin !== 'lark-cli' ? { env: binChildEnv(bin) } : {}),
        })).stdout;
    const parsed = JSON.parse(stdout) as { ok?: boolean; data?: { saved_path?: string } };
    if (!parsed?.ok) return undefined;
    savedPath = typeof parsed.data?.saved_path === 'string' ? parsed.data.saved_path : tmpOut;
    const bytes = await readFile(savedPath);
    if (bytes.length > MAX_ARCHIVE_BYTES || !isZipMagic(bytes)) return undefined;
    const finalPath = join(destDir, sanitizeZipFilename(filename));
    await writeFile(finalPath, bytes);
    return finalPath;
  } catch {
    return undefined;
  } finally {
    if (savedPath) await rm(savedPath, { force: true }).catch(() => undefined);
    await rm(tmpOut, { force: true }).catch(() => undefined);
  }
}

async function tryLarkCliDriveDownload(
  fileUrl: string,
  destDir: string,
  dataRoot: string,
  execLark?: (args: string[]) => Promise<string>,
): Promise<string | undefined> {
  const bin = resolveLarkCliBin({ dataRoot }) ?? 'lark-cli';
  const baseTmp = process.platform === 'win32' ? tmpdir() : '/tmp';
  const tmpOut = join(baseTmp, `vonvon-drive-${process.pid}-${randomUUID().slice(0, 8)}.vonvon.zip`);
  const args = ['drive', '+download', '--as', 'user', '--url', fileUrl, '--output', tmpOut, '--overwrite', '--json'];
  let savedPath: string | undefined;
  try {
    const stdout = execLark
      ? await execLark(args)
      : (await execFileAsync(bin, args, {
          timeout: LARK_CLI_TIMEOUT_MS,
          maxBuffer: 512 * 1024,
          ...(process.platform !== 'win32' && bin !== 'lark-cli' ? { env: binChildEnv(bin) } : {}),
        })).stdout;
    const parsed = JSON.parse(stdout) as { ok?: boolean; data?: { saved_path?: string } };
    if (!parsed?.ok) return undefined;
    savedPath = typeof parsed.data?.saved_path === 'string' ? parsed.data.saved_path : tmpOut;
    const bytes = await readFile(savedPath);
    if (bytes.length > MAX_ARCHIVE_BYTES || !isZipMagic(bytes)) return undefined;
    const finalPath = join(destDir, sanitizeZipFilename(basename(savedPath)));
    await writeFile(finalPath, bytes);
    return finalPath;
  } catch {
    return undefined;
  } finally {
    if (savedPath) await rm(savedPath, { force: true }).catch(() => undefined);
    await rm(tmpOut, { force: true }).catch(() => undefined);
  }
}

async function tryGuestDownloadEmbeddedZip(
  token: string,
  name: string,
  finalDocUrl: string,
  docToken: string | undefined,
  jar: Map<string, string>,
  destDir: string,
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  let hostSuffix = 'feishu.cn';
  let referer = 'https://my.feishu.cn/';
  try {
    const u = new URL(finalDocUrl);
    referer = `${u.origin}/`;
    const h = u.hostname.toLowerCase();
    if (h.endsWith('larksuite.com')) hostSuffix = 'larksuite.com';
    else if (h.endsWith('larkoffice.com')) hostSuffix = 'larkoffice.com';
  } catch { /* default */ }

  const params = new URLSearchParams();
  if (docToken) {
    params.set('mount_node_token', docToken);
    params.set('mount_point', 'docx_file');
  }
  const qs = params.toString();
  const downloadUrl = `https://internal-api-drive-stream.${hostSuffix}/space/api/box/stream/download/all/${encodeURIComponent(token)}/${qs ? `?${qs}` : ''}`;

  try {
    const res = await fetchWithCookies(downloadUrl, jar, {
      fetchImpl,
      referer,
      maxBytes: MAX_ARCHIVE_BYTES,
    });
    if (!res.ok || !isZipMagic(res.bytes)) return undefined;
    const finalPath = join(destDir, sanitizeZipFilename(name));
    await writeFile(finalPath, res.bytes);
    return finalPath;
  } catch {
    return undefined;
  }
}

async function hasManifestFile(dirPath: string): Promise<boolean> {
  try {
    const info = await stat(join(dirPath, 'vonvon-bot.json'));
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a remote template URL (public Feishu promo doc, GitHub repository, or direct `.vonvon.zip` link)
 * into a local `.vonvon.zip` file or cloned repository directory inside an empty `destDir`, ready for
 * `vonvon template inspect` and `vonvon template stage`.
 */
export async function fetchTemplateSource(
  rawUrl: string,
  destDir: string,
  options: {
    dataRoot?: string;
    fetchImpl?: typeof fetch;
    execLark?: (args: string[]) => Promise<string>;
    gitRunner?: (args: string[]) => Promise<void>;
    skipLarkCli?: boolean;
  } = {},
): Promise<FetchTemplateResult> {
  const url = rawUrl.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`不是有效的网址：${rawUrl}`);
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`配方链接仅支持 https://：${rawUrl}`);
  }

  const dest = await ensureEmptyDestDir(destDir);
  const dataRoot = options.dataRoot ?? paths.appDir;

  // 1. Direct GitHub repository URL
  if (parseGitHubRepoUrl(url)) {
    const cloned = await cloneGitHubRepo(url, dest, options.gitRunner);
    return {
      url,
      resolved: true,
      localPath: cloned.localPath,
      sourceKind: 'github',
      sourceUrl: cloned.sourceUrl,
      via: 'git-clone',
    };
  }

  // 2. Direct `.vonvon.zip` HTTPS download
  if (/\.vonvon\.zip$/i.test(parsedUrl.pathname)) {
    const jar = new Map<string, string>();
    const res = await fetchWithCookies(url, jar, {
      fetchImpl: options.fetchImpl,
      maxBytes: MAX_ARCHIVE_BYTES,
      allowAnyHttps: true,
    });
    if (!res.ok) {
      return {
        url,
        resolved: false,
        reason: res.reason,
        hint: `下载压缩包失败（${res.reason}），请确认链接可公开访问或手动下载 .vonvon.zip 后直接发给我。`,
      };
    }
    if (!isZipMagic(res.bytes)) {
      return {
        url,
        resolved: false,
        reason: 'not_a_zip',
        hint: '该链接返回的不是有效的 .vonvon.zip 压缩包（可能需要登录或跳转到了网页）。',
      };
    }
    const localPath = join(dest, sanitizeZipFilename(basename(parsedUrl.pathname)));
    await writeFile(localPath, res.bytes);
    return {
      url,
      resolved: true,
      localPath,
      sourceKind: 'zip',
      sourceUrl: url,
      via: 'direct-download',
    };
  }

  // 3. Feishu / Lark promo document URL
  if (isFeishuDocUrl(url)) {
    let hints: FeishuDocSourceHints = {
      repositories: [],
      embeddedZips: [],
      driveFileUrls: [],
      directZipUrls: [],
    };
    let via: FetchTemplateResult['via'] = 'feishu-public';
    let guestJar: Map<string, string> | undefined;
    let finalDocUrl = url;

    // Tier 1: local user-authenticated `lark-cli`
    if (!options.skipLarkCli) {
      const larkDoc = await tryLarkCliFetchDoc(url, dataRoot, options.execLark);
      if (larkDoc.ok) {
        hints = extractFeishuDocSourceHints(larkDoc.content);
        if (larkDoc.title && !hints.title) hints.title = larkDoc.title;
        if (larkDoc.docId && !hints.docToken) hints.docToken = larkDoc.docId;
        via = 'lark-cli';

        // Prefer embedded `.vonvon.zip` attachments first (author's exact signed final artifact)
        for (const att of hints.embeddedZips) {
          const downloaded = await tryLarkCliMediaDownload(att.token, att.name, dest, dataRoot, options.execLark);
          if (downloaded) {
            return {
              url,
              resolved: true,
              localPath: downloaded,
              sourceKind: 'zip',
              sourceUrl: url,
              docUrl: url,
              via: 'lark-cli',
              ...(hints.title ? { title: hints.title } : {}),
              attachmentName: att.name,
              attachmentToken: att.token,
              repositories: hints.repositories,
            };
          }
        }
        // Check standalone Drive `/file/` links
        for (const driveUrl of hints.driveFileUrls) {
          const downloaded = await tryLarkCliDriveDownload(driveUrl, dest, dataRoot, options.execLark);
          if (downloaded) {
            return {
              url,
              resolved: true,
              localPath: downloaded,
              sourceKind: 'zip',
              sourceUrl: driveUrl,
              docUrl: url,
              via: 'lark-cli',
              ...(hints.title ? { title: hints.title } : {}),
              repositories: hints.repositories,
            };
          }
        }
      }
    }

    // Tier 2: anonymous guest-cookie SSR fetch of public internet-readable Feishu doc
    if (hints.embeddedZips.length === 0 && hints.repositories.length === 0 && hints.directZipUrls.length === 0) {
      const jar = new Map<string, string>();
      const page = await fetchWithCookies(url, jar, {
        fetchImpl: options.fetchImpl,
        maxBytes: MAX_HTML_BYTES,
      });
      if (page.ok && !/accounts\.(?:feishu\.cn|larkoffice\.com|larksuite\.com)\/accounts\/page\/login/i.test(page.finalUrl)) {
        guestJar = jar;
        finalDocUrl = page.finalUrl;
        const publicHints = extractFeishuDocSourceHints(page.bytes.toString('utf8'));
        hints = publicHints;
        via = 'feishu-public';
      } else if (!page.ok) {
        return {
          url,
          resolved: false,
          docUrl: url,
          reason: page.reason,
          hint: '未能读取该飞书文档（可能未开启「互联网上获得链接的人可阅读」或需要登录）。请确认文档已公开，或直接把文档末尾的 .vonvon.zip 压缩包发给我安装。',
        };
      } else {
        return {
          url,
          resolved: false,
          docUrl: url,
          reason: 'login_required',
          hint: '该飞书文档需要登录查看，且当前本机未登录 lark-cli。你可以直接下载文档里的 .vonvon.zip 附件发给我，或把配方 GitHub 仓库链接发给我。',
        };
      }
    }

    // Try guest-cookie stream download if we have embedded `.vonvon.zip` tokens
    if (hints.embeddedZips.length > 0 && guestJar) {
      for (const att of hints.embeddedZips) {
        const downloaded = await tryGuestDownloadEmbeddedZip(
          att.token,
          att.name,
          finalDocUrl,
          hints.docToken,
          guestJar,
          dest,
          options.fetchImpl,
        );
        if (downloaded) {
          return {
            url,
            resolved: true,
            localPath: downloaded,
            sourceKind: 'zip',
            sourceUrl: url,
            docUrl: url,
            via: 'feishu-public',
            ...(hints.title ? { title: hints.title } : {}),
            attachmentName: att.name,
            attachmentToken: att.token,
            repositories: hints.repositories,
          };
        }
      }
    }

    // Try direct HTTPS `.vonvon.zip` links embedded in the doc
    for (const zipUrl of hints.directZipUrls) {
      try {
        const res = await fetchWithCookies(zipUrl, new Map(), {
          fetchImpl: options.fetchImpl,
          maxBytes: MAX_ARCHIVE_BYTES,
          allowAnyHttps: true,
        });
        if (res.ok && isZipMagic(res.bytes)) {
          const localPath = join(dest, sanitizeZipFilename(basename(new URL(zipUrl).pathname)));
          await writeFile(localPath, res.bytes);
          return {
            url,
            resolved: true,
            localPath,
            sourceKind: 'zip',
            sourceUrl: zipUrl,
            docUrl: url,
            via: 'direct-download',
            ...(hints.title ? { title: hints.title } : {}),
            repositories: hints.repositories,
          };
        }
      } catch { /* try next candidate */ }
    }

    // Try cloning GitHub repository links found in the doc (only keep ones that actually contain `vonvon-bot.json`)
    for (const repoUrl of hints.repositories) {
      const subDest = join(dest, `gh-${randomUUID().slice(0, 6)}`);
      await mkdir(subDest, { recursive: true });
      try {
        const cloned = await cloneGitHubRepo(repoUrl, subDest, options.gitRunner);
        if (await hasManifestFile(cloned.localPath)) {
          return {
            url,
            resolved: true,
            localPath: cloned.localPath,
            sourceKind: 'github',
            sourceUrl: cloned.sourceUrl,
            docUrl: url,
            via,
            ...(hints.title ? { title: hints.title } : {}),
            repositories: hints.repositories,
          };
        }
      } catch {
        // Non-template upstream repo (e.g. credit link) or unreachable; clean up and keep scanning.
      }
      await rm(subDest, { recursive: true, force: true }).catch(() => undefined);
    }

    // Clean, actionable fallback when embedded `.vonvon.zip` exists but Feishu gated attachment download behind login
    if (hints.embeddedZips.length > 0) {
      const first = hints.embeddedZips[0]!;
      return {
        url,
        resolved: false,
        docUrl: url,
        via,
        ...(hints.title ? { title: hints.title } : {}),
        attachmentName: first.name,
        attachmentToken: first.token,
        repositories: hints.repositories,
        reason: 'attachment_requires_login',
        hint: `已在飞书文档中识别到配方附件「${first.name}」，但当前环境无法自动下载飞书文档内嵌附件（需本机登录 lark-cli 或 Bot 具备云文档附件下载权限）。请点击该飞书文档文末的「${first.name}」下载后直接发给我，我马上校验并帮你建群！`,
      };
    }

    return {
      url,
      resolved: false,
      docUrl: url,
      via,
      ...(hints.title ? { title: hints.title } : {}),
      repositories: hints.repositories,
      reason: 'no_template_source_found',
      hint: '已读取该飞书文档，但未在正文中找到可直接安装的 .vonvon.zip 附件或含 vonvon-bot.json 的 GitHub 配方仓库。请确认文档文末已附上 .vonvon.zip，或直接把配方压缩包/仓库链接发给我。',
    };
  }

  throw new Error(`暂不支持从该链接自动拉取配方（支持飞书云文档链接、GitHub 仓库链接或 .vonvon.zip 直链）：${rawUrl}`);
}
