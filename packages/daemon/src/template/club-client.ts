import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveLarkCliBin } from '../platform/lark-cli';
import { binChildEnv } from '../platform/tool-path';
import { paths } from '../config/paths';
import { scanPromoForSecrets } from './redact';
import type { PublicPromoPayload } from './schema';

const execFileAsync = promisify(execFile);

export const DEFAULT_CLUB_API_URL = 'https://club.vonvon.cc';
const TELEMETRY_SALT_FILENAME = 'template-telemetry-id';
const INSTALL_REPORT_TIMEOUT_MS = 2_000;
const PUBLISH_TIMEOUT_MS = 10_000;
const COVER_FETCH_TIMEOUT_MS = 12_000;
const MAX_COVER_BYTES = 2 * 1024 * 1024;

export type TemplateSourceKind = 'zip' | 'github' | 'dir';

export interface PublishResult {
  attempted: boolean;
  ok: boolean;
  status?: 'published' | 'pending_author_trust' | 'updated';
  url?: string;
  coverUploaded?: boolean;
  error?: string;
}

function isFeishuDocUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && /(?:^|\.)(?:feishu\.cn|larkoffice\.com|larksuite\.com)$/i.test(url.hostname)
      && /^\/(?:docx|wiki|docs)\/[A-Za-z0-9_-]+/.test(url.pathname);
  } catch {
    return false;
  }
}

function isSupportedCoverImage(buf: Buffer): boolean {
  if (buf.length < 12 || buf.length > MAX_COVER_BYTES) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return true; // WebP
  return false;
}

/**
 * Best-effort local fetch of the public Feishu doc cover image via the user's own `lark-cli`
 * during `pack --publish`. Silently returns `undefined` if `lark-cli` is unavailable, unsigned,
 * timed out, or the doc has no cover (Club then renders the Plan A miniature doc preview).
 */
export async function fetchLocalFeishuCover(
  docUrl: string | undefined,
  dataRoot: string = paths.appDir,
): Promise<Buffer | undefined> {
  if (!isFeishuDocUrl(docUrl)) return undefined;
  const bin = resolveLarkCliBin({ dataRoot }) ?? 'lark-cli';
  // lark-cli restricts --output to cwd, /tmp, or ~/files; use a unique stem in /tmp on POSIX.
  const baseTmp = process.platform === 'win32' ? tmpdir() : '/tmp';
  const stem = join(baseTmp, `vonvon-cover-${process.pid}-${randomUUID().slice(0, 8)}`);
  let savedPath: string | undefined;
  try {
    const { stdout } = await execFileAsync(bin, [
      'docs', '+resource-download', '--as', 'user', '--doc', docUrl!, '--type', 'cover', '--output', stem, '--overwrite', '--json',
    ], {
      timeout: COVER_FETCH_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
      ...(process.platform !== 'win32' && bin !== 'lark-cli' ? { env: binChildEnv(bin) } : {}),
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; data?: { saved_path?: string } };
    if (!parsed?.ok || typeof parsed.data?.saved_path !== 'string') return undefined;
    savedPath = parsed.data.saved_path;
    const bytes = await readFile(savedPath);
    return isSupportedCoverImage(bytes) ? bytes : undefined;
  } catch {
    return undefined;
  } finally {
    if (savedPath) await rm(savedPath, { force: true }).catch(() => undefined);
    await rm(stem, { force: true }).catch(() => undefined);
  }
}

export interface InstallReportResult {
  attempted: boolean;
  ok: boolean;
  reason?: string;
}

export function resolveClubBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.VONVON_CLUB_API_URL?.trim();
  const base = raw && /^https?:\/\//i.test(raw) ? raw : DEFAULT_CLUB_API_URL;
  return base.replace(/\/+$/, '');
}

export function telemetryDisabled(env: NodeJS.ProcessEnv = process.env, flagDisabled = false): boolean {
  if (flagDisabled) return true;
  const val = env.VONVON_NO_TELEMETRY?.trim().toLowerCase();
  return val === '1' || val === 'true' || val === 'yes';
}

/**
 * Load or create a non-secret random salt for per-template deduplicated anonymous install keys.
 * Stored with mode 0644 (not a secret, so it does not contain credentials or user identity).
 */
export async function loadOrCreateTelemetrySalt(dataRoot: string = paths.appDir): Promise<string> {
  const file = join(dataRoot, TELEMETRY_SALT_FILENAME);
  try {
    const text = (await readFile(file, 'utf8')).trim();
    if (text.length >= 16 && text.length <= 128) return text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  const salt = randomUUID();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, `${salt}\n`, { encoding: 'utf8', mode: 0o644 });
  await rename(tmp, file);
  return salt;
}

export function computeAnonInstallKey(salt: string, templateId: string, authorPublicKey: string): string {
  return createHash('sha256').update(`${salt}:${templateId}:${authorPublicKey}`).digest('hex');
}

export async function publishTemplatePromo(
  promo: PublicPromoPayload,
  signature: string,
  options: {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    cover?: { bytes: Uint8Array; signature: string };
  } = {},
): Promise<PublishResult> {
  const secretFindings = scanPromoForSecrets(promo);
  if (secretFindings.length > 0) {
    return { attempted: false, ok: false, error: `宣传名片包含疑似敏感信息，已拦截上报（${secretFindings[0]!.rule}）` };
  }
  const baseUrl = (options.baseUrl ?? resolveClubBaseUrl()).replace(/\/+$/, '');
  const fetchFn = options.fetchImpl ?? fetch;
  try {
    const payload: Record<string, unknown> = { promo, signature };
    if (options.cover) {
      payload.coverBase64 = Buffer.from(options.cover.bytes).toString('base64');
      payload.coverSignature = options.cover.signature;
    }
    const response = await fetchFn(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? PUBLISH_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({})) as {
      status?: PublishResult['status']; url?: string; coverUrl?: string | null; error?: string;
    };
    if (!response.ok) {
      return { attempted: true, ok: false, error: body.error ?? `HTTP ${response.status}` };
    }
    return {
      attempted: true,
      ok: true,
      status: body.status ?? 'published',
      url: body.url ?? `${baseUrl}/`,
      ...(body.coverUrl ? { coverUploaded: true } : {}),
    };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function reportTemplateInstall(
  promo: PublicPromoPayload,
  signature: string | undefined,
  sourceKind: TemplateSourceKind,
  options: {
    dataRoot?: string;
    env?: NodeJS.ProcessEnv;
    noTelemetry?: boolean;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<InstallReportResult> {
  const env = options.env ?? process.env;
  if (telemetryDisabled(env, options.noTelemetry)) {
    return { attempted: false, ok: false, reason: 'telemetry_disabled' };
  }
  if (scanPromoForSecrets(promo).length > 0) {
    return { attempted: false, ok: false, reason: 'redaction_failed' };
  }
  const baseUrl = (options.baseUrl ?? resolveClubBaseUrl(env)).replace(/\/+$/, '');
  const fetchFn = options.fetchImpl ?? fetch;
  try {
    const salt = await loadOrCreateTelemetrySalt(options.dataRoot);
    const anonInstallKey = computeAnonInstallKey(salt, promo.id, promo.author.publicKey);
    const response = await fetchFn(`${baseUrl}/api/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        promo,
        ...(signature ? { signature } : {}),
        sourceKind,
        anonInstallKey,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? INSTALL_REPORT_TIMEOUT_MS),
    });
    return response.ok
      ? { attempted: true, ok: true }
      : { attempted: true, ok: false, reason: `http_${response.status}` };
  } catch (err) {
    return { attempted: true, ok: false, reason: err instanceof Error ? err.name : 'network_error' };
  }
}

export interface PublishedTemplateSummary {
  id: string;
  version: string;
  name: string;
  summary: string;
  docUrl: string;
  coverUrl: string | null;
  installCount: number;
  docLikeCount: number | null;
  createdAt: number;
  updatedAt: number;
}

export async function listMyPublishedTemplates(
  authorPublicKey: string,
  options: {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<PublishedTemplateSummary[]> {
  const baseUrl = (options.baseUrl ?? resolveClubBaseUrl()).replace(/\/+$/, '');
  const fetchFn = options.fetchImpl ?? fetch;
  const params = new URLSearchParams({ sort: 'new', authorPublicKey });
  const response = await fetchFn(`${baseUrl}/api/list?${params}`, {
    method: 'GET',
    signal: AbortSignal.timeout(options.timeoutMs ?? PUBLISH_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    items?: PublishedTemplateSummary[];
    error?: string;
  };
  if (!response.ok || !body.ok) {
    throw new Error(body.error ?? `查询已发布配方失败（HTTP ${response.status}）`);
  }
  return Array.isArray(body.items) ? body.items : [];
}

export interface UnpublishResult {
  id: string;
  authorPublicKey: string;
  deleted: true;
  url: string;
}

export async function unpublishTemplatePromo(
  templateId: string,
  authorPublicKey: string,
  timestamp: number,
  signature: string,
  options: {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<UnpublishResult> {
  const baseUrl = (options.baseUrl ?? resolveClubBaseUrl()).replace(/\/+$/, '');
  const fetchFn = options.fetchImpl ?? fetch;
  const response = await fetchFn(`${baseUrl}/api/unpublish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: templateId, authorPublicKey, timestamp, signature }),
    signal: AbortSignal.timeout(options.timeoutMs ?? PUBLISH_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    deleted?: boolean;
    error?: string;
  };
  if (!response.ok || !body.ok) {
    throw new Error(body.error ?? `下架失败（HTTP ${response.status}）`);
  }
  return {
    id: templateId,
    authorPublicKey,
    deleted: true,
    url: `${baseUrl}/`,
  };
}
