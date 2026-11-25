import { detectImageExtension, isFeishuDocUrl, MAX_COVER_UPLOAD_BYTES } from './validate.mjs';

const FEISHU_FETCH_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 8;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function isAllowedFeishuHost(hostname) {
  return /(?:^|\.)(?:feishu\.cn|larkoffice\.com|larksuite\.com|feishucdn\.com|larksuitecdn\.com)$/i.test(hostname);
}

function isAllowedFeishuUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && isAllowedFeishuHost(u.hostname);
  } catch {
    return false;
  }
}

function mergeCookies(jar, response) {
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

function formatCookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function readBoundedBytes(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error('response_too_large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function fetchWithGuestCookies(initialUrl, jar, { fetchImpl = fetch, referer, maxBytes = MAX_HTML_BYTES } = {}) {
  let current = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedFeishuUrl(current)) {
      return { ok: false, reason: 'disallowed_redirect_host' };
    }
    const headers = {
      'user-agent': BROWSER_UA,
      'accept-language': 'zh-CN,zh;q=0.9',
      ...(referer ? { referer } : {}),
    };
    const cookie = formatCookieHeader(jar);
    if (cookie) headers.cookie = cookie;

    const res = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(FEISHU_FETCH_TIMEOUT_MS),
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

    if (!res.ok) {
      return { ok: false, reason: `http_${res.status}` };
    }
    const bytes = await readBoundedBytes(res, maxBytes);
    return { ok: true, finalUrl: current, contentType: res.headers.get('content-type') ?? '', bytes };
  }
  return { ok: false, reason: 'too_many_redirects' };
}

/**
 * Parse public Feishu document statistics and optional cover candidate URLs from SSR HTML.
 * Exported for unit testing.
 */
export function parsePublicFeishuHtml(html, finalUrl = 'https://my.feishu.cn/') {
  let docLikeCount = null;
  let docPv = null;
  let docUv = null;

  const encodedLike = html.match(/%22like_count%22%3A(\d+)/);
  const plainLike = encodedLike ? null : html.match(/"like_count"\s*:\s*(\d+)/);
  const likeMatch = encodedLike ?? plainLike;
  if (likeMatch) {
    const n = Number(likeMatch[1]);
    if (Number.isSafeInteger(n) && n >= 0) docLikeCount = n;
  }

  const pvMatch = html.match(/%22pv%22%3A(\d+)/) ?? html.match(/"pv"\s*:\s*(\d+)/);
  if (pvMatch) {
    const n = Number(pvMatch[1]);
    if (Number.isSafeInteger(n) && n >= 0) docPv = n;
  }

  const uvMatch = html.match(/%22uv%22%3A(\d+)/) ?? html.match(/"uv"\s*:\s*(\d+)/);
  if (uvMatch) {
    const n = Number(uvMatch[1]);
    if (Number.isSafeInteger(n) && n >= 0) docUv = n;
  }

  const coverUrls = [];
  const decodeAttr = s => s
    .replace(/&amp;/g, '&')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/');

  // 1. Direct stream download URLs embedded in SSR JSON/attributes (preferred, already carry mount_node_token)
  const directRe = /https:\/\/internal-api-drive-stream\.(?:feishu\.cn|larkoffice\.com|larksuite\.com)\/space\/api\/box\/stream\/download\/(?:v2\/cover|preview)\/[A-Za-z0-9_-]+\/[^"'<>\s\\]*/g;
  for (const m of html.matchAll(directRe)) {
    const candidate = decodeAttr(m[0]).replace(/&quot;.*$/, '');
    if (isAllowedFeishuUrl(candidate) && !coverUrls.includes(candidate)) {
      coverUrls.push(candidate);
    }
  }

  // 2. Fallback: synthesize cover download URL from embedded cover token + document token
  const coverTokenMatch = html.match(/"cover"\s*:\s*\{[^{}]{0,240}"token"\s*:\s*"([A-Za-z0-9_-]{12,64})"/);
  const docTokenMatch = html.match(/window\.SERVER_DATA\s*=\s*Object\(\{"meta":\{[^{}]{0,500}"token"\s*:\s*"([A-Za-z0-9_-]{12,64})"/);
  if (coverTokenMatch) {
    const coverToken = coverTokenMatch[1];
    const docToken = docTokenMatch?.[1] ?? '';
    let hostSuffix = 'feishu.cn';
    try {
      const h = new URL(finalUrl).hostname.toLowerCase();
      if (h.endsWith('larksuite.com')) hostSuffix = 'larksuite.com';
      else if (h.endsWith('larkoffice.com')) hostSuffix = 'larkoffice.com';
    } catch { /* default feishu.cn */ }
    const params = new URLSearchParams({
      fallback_source: '1',
      height: '1280',
      ...(docToken ? { mount_node_token: docToken, mount_point: 'docx_image' } : {}),
      policy: 'equal',
      width: '1280',
    });
    const synthesized = `https://internal-api-drive-stream.${hostSuffix}/space/api/box/stream/download/v2/cover/${coverToken}/?${params}`;
    if (!coverUrls.includes(synthesized)) coverUrls.push(synthesized);
  }

  return { docLikeCount, docPv, docUv, coverUrls };
}

/**
 * Best-effort anonymous guest fetch of a public internet-readable Feishu/Lark document.
 * Extracts real Feishu `like_count` and (optionally) downloads the document's cover image.
 * Never throws; returns `{ ok: false, reason }` on login-gated, private, or unreachable docs.
 */
export async function fetchPublicFeishuDoc(docUrl, { fetchCover = false, fetchImpl = fetch } = {}) {
  if (!isFeishuDocUrl(docUrl)) return { ok: false, reason: 'not_feishu_doc' };
  const jar = new Map();
  try {
    const page = await fetchWithGuestCookies(docUrl, jar, { fetchImpl, maxBytes: MAX_HTML_BYTES });
    if (!page.ok) return page;
    if (/accounts\.(?:feishu\.cn|larkoffice\.com|larksuite\.com)\/accounts\/page\/login/i.test(page.finalUrl)) {
      return { ok: false, reason: 'login_required' };
    }
    const html = page.bytes.toString('utf8');
    const parsed = parsePublicFeishuHtml(html, page.finalUrl);

    let coverBytes;
    if (fetchCover && parsed.coverUrls.length > 0) {
      let referer = 'https://my.feishu.cn/';
      try {
        referer = `${new URL(page.finalUrl).origin}/`;
      } catch { /* keep default */ }

      for (const coverUrl of parsed.coverUrls.slice(0, 3)) {
        try {
          const img = await fetchWithGuestCookies(coverUrl, jar, {
            fetchImpl,
            referer,
            maxBytes: MAX_COVER_UPLOAD_BYTES,
          });
          if (img.ok && detectImageExtension(img.bytes)) {
            coverBytes = img.bytes;
            break;
          }
        } catch {
          // Try next candidate URL
        }
      }
    }

    if (parsed.docLikeCount === null && !coverBytes) {
      return { ok: false, reason: 'no_public_metadata' };
    }
    return {
      ok: true,
      ...(parsed.docLikeCount !== null ? { docLikeCount: parsed.docLikeCount } : {}),
      ...(parsed.docPv !== null ? { docPv: parsed.docPv } : {}),
      ...(parsed.docUv !== null ? { docUv: parsed.docUv } : {}),
      ...(coverBytes ? { coverBytes } : {}),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'fetch_error' };
  }
}
