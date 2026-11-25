import { createServer } from 'node:http';
import { readFile, unlink } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constantTimeEqual, sha256Hex, verifyCoverSignature, verifyPromoSignature, verifyUnpublishSignature } from './crypto.mjs';
import { fetchFeishuCoverViaLarkCli, saveCoverBytes } from './covers.mjs';
import { ANON_KEY_REGEX, isFeishuDocUrl, MAX_COVER_UPLOAD_BYTES, MAX_JSON_BODY_BYTES, RateLimiter, TEMPLATE_ID_REGEX, validatePromoPayload } from './validate.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_PUBLIC_DIR = resolve(HERE, '../public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

function isLoopbackAddress(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function clientIp(req) {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (isLoopbackAddress(remote)) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const parts = xff.split(',').map(p => p.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1];
    }
  }
  return remote;
}

function matchesIfNoneMatch(header, etag) {
  if (typeof header !== 'string' || !header.trim()) return false;
  const trimmed = header.trim();
  if (trimmed === '*') return true;
  const stripWeak = tag => tag.trim().replace(/^W\//i, '');
  const target = stripWeak(etag);
  return trimmed.split(',').some(candidate => stripWeak(candidate) === target);
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('无效的 JSON 请求体'), { status: 400 });
  }
}

function verifyAdmin(req, adminToken) {
  if (!adminToken) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return constantTimeEqual(header.slice('Bearer '.length).trim(), adminToken);
}

/**
 * Create the HTTP server for 「Vonvon 灵感 Club」 (`club.vonvon.cc`).
 */
export function createClubServer({
  store,
  coversDir,
  publicDir = DEFAULT_PUBLIC_DIR,
  adminToken = '',
  publicBaseUrl = 'https://club.vonvon.cc',
  writeLimiter = new RateLimiter({ windowMs: 60_000, maxHits: 60 }),
  coverFetcher = fetchFeishuCoverViaLarkCli,
  feishuPublicFetcher = null,
} = {}) {
  const cleanBase = publicBaseUrl.replace(/\/+$/, '');
  const cleanupOrphanCover = async (coverUrl) => {
    if (!coversDir || !coverUrl || !/^\/covers\/[a-f0-9]{16,64}\.(?:png|jpg|webp)$/.test(coverUrl)) return;
    if (store.isCoverReferenced(coverUrl)) return;
    await unlink(join(coversDir, coverUrl.slice('/covers/'.length))).catch(() => undefined);
  };

  /**
   * Best-effort sync of a public Feishu document's real like_count and (when missing) cover image.
   * Never throws and never blocks callers.
   */
  const syncOneFeishuDoc = async (templateId, authorPublicKey, docUrl, { needCover = false } = {}) => {
    if (!feishuPublicFetcher || !isFeishuDocUrl(docUrl)) return { ok: false, reason: 'skipped' };
    try {
      const fetched = await feishuPublicFetcher(docUrl, { fetchCover: needCover });
      if (!fetched?.ok) {
        store.updateDocStats(templateId, authorPublicKey, { docLikeCount: undefined });
        return { ok: false, reason: fetched?.reason ?? 'fetch_failed' };
      }
      store.updateDocStats(templateId, authorPublicKey, { docLikeCount: fetched.docLikeCount });
      let coverUrl = null;
      if (needCover && coversDir && fetched.coverBytes) {
        const saved = await saveCoverBytes(coversDir, fetched.coverBytes);
        const applied = store.setCoverUrlIfMissing(templateId, authorPublicKey, saved.url);
        if (applied) coverUrl = saved.url;
        else await cleanupOrphanCover(saved.url);
      }
      return { ok: true, docLikeCount: fetched.docLikeCount ?? null, ...(coverUrl ? { coverUrl } : {}) };
    } catch {
      return { ok: false, reason: 'sync_error' };
    }
  };

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';
    const ip = clientIp(req);

    try {
      let url;
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1');
      } catch {
        return sendJson(res, 400, { ok: false, error: '无效的请求路径' });
      }
      const pathname = url.pathname;

      if (isRead && pathname === '/api/health') {
        const body = Buffer.from(JSON.stringify({ ok: true, service: 'vonvon-club' }), 'utf8');
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': 'application/json; charset=utf-8',
          'content-length': body.length,
        });
        return res.end(method === 'HEAD' ? undefined : body);
      }

      if (method === 'GET' && pathname === '/api/list') {
        const data = store.listPublic({
          sort: url.searchParams.get('sort') ?? 'hot',
          q: url.searchParams.get('q') ?? '',
          tag: url.searchParams.get('tag') ?? '',
          author: url.searchParams.get('author') ?? '',
          authorPublicKey: url.searchParams.get('authorPublicKey') ?? '',
        });
        return sendJson(res, 200, { ok: true, ...data }, { 'cache-control': 'no-store' });
      }

      if (method === 'GET' && pathname.startsWith('/api/templates/')) {
        const id = decodeURIComponent(pathname.slice('/api/templates/'.length));
        const pubKey = url.searchParams.get('authorPublicKey') ?? undefined;
        const matches = store.getById(id, pubKey);
        if (!matches.length) return sendJson(res, 404, { ok: false, error: '未找到该配方' });
        return sendJson(res, 200, { ok: true, items: matches });
      }

      if (method === 'POST' && pathname === '/api/publish') {
        if (!writeLimiter.allow(`pub:${ip}`)) return sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        const body = await readJsonBody(req, Math.ceil(MAX_COVER_UPLOAD_BYTES * 1.5) + MAX_JSON_BODY_BYTES);
        const checked = validatePromoPayload(body.promo);
        if (!checked.ok) return sendJson(res, 400, { ok: false, error: checked.error });
        if (!checked.promo.author.publicKey) {
          return sendJson(res, 400, { ok: false, error: '发布配方必须包含 author.publicKey 与 Ed25519 签名' });
        }
        if (!verifyPromoSignature(checked.promo, body.signature)) {
          return sendJson(res, 403, { ok: false, error: 'Ed25519 签名校验失败' });
        }
        const saved = store.publish(checked.promo, body.signature);
        if (saved.blocked) return sendJson(res, 403, { ok: false, error: '该作者已被禁用' });
        if (saved.downgrade) {
          return sendJson(res, 409, { ok: false, error: `不允许用旧版本（${checked.promo.version}）覆盖当前版本（${saved.currentVersion}）` });
        }

        // Persist author-signed cover for trusted authors, and for pending authors up to a strict global cap
        // (20 pending covers max) so a brand-new creator's first card appears with its cover as soon as trusted.
        // `/covers/*` still refuses untrusted authors with 404 until approved.
        const MAX_PENDING_COVERS = 20;
        let coverUrl = null;
        const targetDocUrl = checked.promo.docUrl ?? checked.promo.repository ?? '';
        const canAcceptCover = saved.trusted || store.countPendingCovers() < MAX_PENDING_COVERS;
        if (canAcceptCover && coversDir && typeof body.coverBase64 === 'string' && body.coverBase64.trim() && typeof body.coverSignature === 'string') {
          try {
            const coverBytes = Buffer.from(body.coverBase64, 'base64');
            if (verifyCoverSignature(saved.id, checked.promo.version, targetDocUrl, saved.authorPublicKey, coverBytes, body.coverSignature)) {
              const storedCover = await saveCoverBytes(coversDir, coverBytes);
              const { previousCoverUrl } = store.setCoverUrl(saved.id, saved.authorPublicKey, storedCover.url);
              await cleanupOrphanCover(previousCoverUrl);
              coverUrl = storedCover.url;
            }
          } catch {
            // Invalid optional cover must never block a valid template publish.
          }
        }

        // Best-effort guest fetch of public Feishu doc like_count (and cover if author did not upload one).
        if (feishuPublicFetcher && isFeishuDocUrl(targetDocUrl)) {
          const synced = await syncOneFeishuDoc(saved.id, saved.authorPublicKey, targetDocUrl, {
            needCover: !coverUrl && canAcceptCover,
          });
          if (!coverUrl && synced.coverUrl) coverUrl = synced.coverUrl;
        }

        return sendJson(res, 200, {
          ok: true,
          status: saved.status,
          id: saved.id,
          authorPublicKey: saved.authorPublicKey,
          url: `${cleanBase}/`,
          ...(coverUrl ? { coverUrl } : {}),
        });
      }

      if (method === 'POST' && pathname === '/api/unpublish') {
        if (!writeLimiter.allow(`unpub:${ip}`)) return sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        const body = await readJsonBody(req);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        const authorPublicKey = typeof body.authorPublicKey === 'string' ? body.authorPublicKey.trim() : '';
        const timestamp = body.timestamp;
        const signature = body.signature;
        if (!id || !TEMPLATE_ID_REGEX.test(id) || !authorPublicKey) {
          return sendJson(res, 400, { ok: false, error: '缺少合法的配方标识或作者公钥' });
        }
        if (!verifyUnpublishSignature(id, authorPublicKey, timestamp, signature)) {
          return sendJson(res, 403, { ok: false, error: 'Ed25519 下架签名校验失败或请求已过期' });
        }
        const { deleted, previousCoverUrl } = store.deleteTemplate(id, authorPublicKey);
        if (!deleted) return sendJson(res, 404, { ok: false, error: '未找到属于你的该公开配方' });
        await cleanupOrphanCover(previousCoverUrl);
        return sendJson(res, 200, { ok: true, id, authorPublicKey, deleted: true });
      }

      if (method === 'POST' && pathname === '/api/install') {
        if (!writeLimiter.allow(`inst:${ip}`)) return sendJson(res, 429, { ok: false, error: '请求过于频繁' });
        const body = await readJsonBody(req);
        const checked = validatePromoPayload(body.promo);
        if (!checked.ok) return sendJson(res, 400, { ok: false, error: checked.error });
        if (typeof body.anonInstallKey !== 'string' || !ANON_KEY_REGEX.test(body.anonInstallKey)) {
          return sendJson(res, 400, { ok: false, error: 'anonInstallKey 格式不合法' });
        }
        const sourceKind = ['zip', 'github', 'dir'].includes(body.sourceKind) ? body.sourceKind : 'zip';
        if (checked.promo.author.publicKey) {
          if (!verifyPromoSignature(checked.promo, body.signature)) {
            return sendJson(res, 403, { ok: false, error: 'Ed25519 签名校验失败' });
          }
        }
        const result = store.recordInstall(checked.promo, body.signature, {
          sourceKind,
          anonInstallKey: body.anonInstallKey,
        });
        if (result.blocked) return sendJson(res, 403, { ok: false, error: '该作者已被禁用' });
        return sendJson(res, 200, { ok: true, id: result.id, deduplicated: result.deduplicated });
      }

      // Admin endpoints (protected by CLUB_ADMIN_TOKEN)
      if (pathname.startsWith('/api/admin/')) {
        if (!verifyAdmin(req, adminToken)) return sendJson(res, 401, { ok: false, error: '未授权' });

        if (method === 'GET' && pathname === '/api/admin/templates') {
          return sendJson(res, 200, { ok: true, items: store.listAllForAdmin() });
        }

        if (method === 'GET' && pathname === '/api/admin/pending') {
          return sendJson(res, 200, { ok: true, items: store.listPending() });
        }

        if (method === 'POST' && pathname === '/api/admin/sync-feishu') {
          const body = await readJsonBody(req);
          const id = typeof body.id === 'string' ? body.id.trim() : '';
          const authorPublicKey = typeof body.authorPublicKey === 'string' ? body.authorPublicKey.trim() : '';
          const targets = id
            ? store.getById(id, authorPublicKey || undefined, { includeUntrusted: true })
            : store.listFeishuSyncCandidates(Date.now() + 1, 50);
          const results = [];
          for (const t of targets) {
            const r = await syncOneFeishuDoc(t.id, t.authorPublicKey, t.docUrl, { needCover: !t.coverUrl });
            results.push({ id: t.id, authorPublicKey: t.authorPublicKey, ...r });
          }
          return sendJson(res, 200, { ok: true, synced: results.length, results });
        }

        if (method === 'POST' && pathname === '/api/admin/authors/trust') {
          const body = await readJsonBody(req);
          const publicKey = typeof body.publicKey === 'string' ? body.publicKey.trim() : '';
          if (!publicKey) return sendJson(res, 400, { ok: false, error: '缺少 publicKey' });
          store.setAuthorTrust(publicKey, body.trusted !== false, typeof body.note === 'string' ? body.note : '');
          return sendJson(res, 200, { ok: true, publicKey, trusted: body.trusted !== false });
        }

        if (method === 'POST' && pathname === '/api/admin/authors/block') {
          const body = await readJsonBody(req);
          const publicKey = typeof body.publicKey === 'string' ? body.publicKey.trim() : '';
          if (!publicKey) return sendJson(res, 400, { ok: false, error: '缺少 publicKey' });
          const blocked = body.blocked !== false;
          const updated = store.setAuthorBlocked(publicKey, blocked, typeof body.note === 'string' ? body.note : '');
          if (!updated) return sendJson(res, 404, { ok: false, error: '作者不存在' });
          if (blocked) {
            const removedCovers = store.clearCoversForAuthor(publicKey);
            for (const url of removedCovers) await cleanupOrphanCover(url);
          }
          return sendJson(res, 200, { ok: true, publicKey, blocked });
        }

        if (method === 'POST' && pathname === '/api/admin/templates/delete') {
          const body = await readJsonBody(req);
          const id = typeof body.id === 'string' ? body.id.trim() : '';
          const authorPublicKey = typeof body.authorPublicKey === 'string' ? body.authorPublicKey.trim() : '';
          if (!id || !authorPublicKey) return sendJson(res, 400, { ok: false, error: '缺少配方标识' });
          const { deleted, previousCoverUrl } = store.deleteTemplate(id, authorPublicKey);
          if (!deleted) return sendJson(res, 404, { ok: false, error: '未找到目标配方' });
          await cleanupOrphanCover(previousCoverUrl);
          return sendJson(res, 200, { ok: true, id, authorPublicKey, deleted: true });
        }

        if (method === 'POST' && pathname === '/api/admin/cover') {
          const body = await readJsonBody(req, MAX_COVER_UPLOAD_BYTES * 2);
          const id = typeof body.id === 'string' ? body.id.trim() : '';
          const authorPublicKey = typeof body.authorPublicKey === 'string' ? body.authorPublicKey.trim() : '';
          if (!id || !authorPublicKey) return sendJson(res, 400, { ok: false, error: '缺少配方标识' });
          if (!coversDir) return sendJson(res, 500, { ok: false, error: '未配置封面目录' });

          if (typeof body.imageBase64 === 'string' && body.imageBase64.trim()) {
            const bytes = Buffer.from(body.imageBase64, 'base64');
            const saved = await saveCoverBytes(coversDir, bytes);
            const { updated, previousCoverUrl } = store.setCoverUrl(id, authorPublicKey, saved.url);
            if (!updated) {
              await cleanupOrphanCover(saved.url);
              return sendJson(res, 404, { ok: false, error: '未找到目标配方' });
            }
            await cleanupOrphanCover(previousCoverUrl);
            return sendJson(res, 200, { ok: true, coverUrl: saved.url, bytes: saved.bytes });
          }
          if (body.fetchFeishuCover === true) {
            const matches = store.getById(id, authorPublicKey, { includeUntrusted: true });
            if (!matches.length) return sendJson(res, 404, { ok: false, error: '未找到目标配方' });
            const fetched = await coverFetcher(matches[0].docUrl, coversDir);
            if (!fetched.ok) return sendJson(res, 200, { ok: false, reason: fetched.reason });
            const { previousCoverUrl } = store.setCoverUrl(id, authorPublicKey, fetched.url);
            await cleanupOrphanCover(previousCoverUrl);
            return sendJson(res, 200, { ok: true, coverUrl: fetched.url, bytes: fetched.bytes });
          }
          return sendJson(res, 400, { ok: false, error: '请提供 imageBase64 或 fetchFeishuCover=true' });
        }

        return sendJson(res, 404, { ok: false, error: '未知管理接口' });
      }

      if (isRead && pathname === '/robots.txt') {
        const body = Buffer.from('User-agent: *\nAllow: /\nDisallow: /api/admin/\n', 'utf8');
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=86400',
          'content-length': body.length,
        });
        return res.end(method === 'HEAD' ? undefined : body);
      }

      // Static cached covers: /covers/<hash>.(png|jpg|webp) — only served while referenced by a trusted non-blocked template.
      if (isRead && pathname.startsWith('/covers/') && coversDir) {
        const name = pathname.slice('/covers/'.length);
        if (!/^[a-f0-9]{16,64}\.(?:png|jpg|webp)$/.test(name) || !store.isCoverPublic(pathname)) {
          return sendJson(res, 404, { ok: false, error: '封面不存在' });
        }
        try {
          const data = await readFile(join(coversDir, name));
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'content-type': MIME_TYPES[extname(name)] ?? 'application/octet-stream',
            'cache-control': 'public, max-age=2592000, immutable',
            'content-length': data.length,
          });
          return res.end(method === 'HEAD' ? undefined : data);
        } catch {
          return sendJson(res, 404, { ok: false, error: '封面不存在' });
        }
      }

      // Static frontend files
      if (isRead) {
        const rel = pathname === '/' || pathname === '/index.html' ? 'index.html' : pathname.replace(/^\/+/, '');
        if (!/^[a-zA-Z0-9._/-]+$/.test(rel) || rel.includes('..')) {
          return sendJson(res, 404, { ok: false, error: 'Not Found' });
        }
        const target = resolve(publicDir, rel);
        if (!target.startsWith(publicDir)) return sendJson(res, 404, { ok: false, error: 'Not Found' });
        try {
          const data = await readFile(target);
          const etag = `"${sha256Hex(data).slice(0, 16)}"`;
          if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
            res.writeHead(304, { ...SECURITY_HEADERS, etag, 'cache-control': 'no-cache' });
            return res.end();
          }
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'content-type': MIME_TYPES[extname(target)] ?? 'application/octet-stream',
            'cache-control': 'no-cache',
            etag,
            'content-length': data.length,
          });
          return res.end(method === 'HEAD' ? undefined : data);
        } catch {
          return sendJson(res, 404, { ok: false, error: 'Not Found' });
        }
      }

      return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      return sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : '服务内部错误' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
