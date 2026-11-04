// Self-contained Cloudflare Worker. Bind the private R2 bucket as LINUX_RELEASES.
// No fetch proxy, public bucket listing, credentials, or Cache API is involved.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const MUTABLE = 'no-store';

export function releaseRoute(pathname) {
  if (pathname === '/bot/server/stable/manifest.json') return { key: pathname.slice(1), type: 'application/json', mutable: true };
  if (/^\/bot\/server\/(?:install|uninstall)\.sh$/.test(pathname)) return { key: pathname.slice(1), type: 'text/plain; charset=utf-8', mutable: true };
  const match = /^\/bot\/server\/(\d+\.\d+\.\d+)\/(.+)$/.exec(pathname);
  if (!match) return null;
  if (match[2] === 'manifest.json') return { key: pathname.slice(1), type: 'application/json', mutable: false };
  if (match[2] !== `vonvon-server-${match[1]}-linux-x64.tar.gz` && match[2] !== `vonvon-server-${match[1]}-linux-arm64.tar.gz`) return null;
  return { key: pathname.slice(1), type: 'application/gzip', mutable: false };
}

/** A single byte range. Ranges spanning EOF are clamped, never buffered. */
export function byteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const safe = text => /^\d+$/.test(text) && Number.isSafeInteger(Number(text));
  if ((match[1] && !safe(match[1])) || (match[2] && !safe(match[2]))) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix > 0 ? { offset: Math.max(0, size - suffix), length: Math.min(size, suffix) } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || end < start) return null;
  return { offset: start, length: end - start + 1 };
}

function errorResponse(status, method, extra = {}) {
  const headers = new Headers({ 'Cache-Control': MUTABLE, 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...extra });
  // Deliberately do not expose object keys, account IDs, SDK errors, or stack traces.
  return new Response(method === 'HEAD' ? null : `${status}\n`, { status, headers });
}

function etagOf(object) {
  return object.httpEtag || `"${object.etag}"`;
}

function matchesIfRange(value, object) {
  if (!value) return true;
  if (value.startsWith('"')) return value === etagOf(object);
  if (value.startsWith('W/')) return false;
  // HTTP dates have one-second resolution; accept only actual HTTP-date strings.
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === value && Math.floor(object.uploaded.getTime() / 1000) <= Math.floor(timestamp / 1000);
}

export async function serveLinuxRelease(request, env) {
  const { method } = request;
  if (method !== 'GET' && method !== 'HEAD') return errorResponse(405, method, { Allow: 'GET, HEAD' });
  const route = releaseRoute(new URL(request.url).pathname);
  if (!route) return errorResponse(404, method);
  try {
    const object = await env.LINUX_RELEASES.head(route.key);
    if (!object) return errorResponse(404, method);
    if (!Number.isSafeInteger(object.size) || object.size < 0 || typeof object.etag !== 'string' || !(object.uploaded instanceof Date)) return errorResponse(502, method);
    const headers = new Headers({
      'Content-Type': route.type,
      'Content-Length': String(object.size),
      'Cache-Control': route.mutable ? MUTABLE : IMMUTABLE,
      'Accept-Ranges': 'bytes',
      ETag: etagOf(object),
      'Last-Modified': object.uploaded.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
    });
    // RFC 9110: Range modifies GET only. HEAD describes the full representation.
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    let range;
    const requested = request.headers.get('Range');
    if (requested !== null && matchesIfRange(request.headers.get('If-Range'), object)) {
      range = byteRange(requested, object.size);
      if (!range) return errorResponse(416, method, { 'Content-Range': `bytes */${object.size}`, 'Accept-Ranges': 'bytes' });
      headers.set('Content-Length', String(range.length));
      headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    }
    // Prevent metadata/body mixing if a mutable script changes between head and get.
    const result = await env.LINUX_RELEASES.get(route.key, { onlyIf: { etagMatches: object.etag }, ...(range ? { range } : {}) });
    if (!result) return errorResponse(404, method);
    if (!result.body || result.etag !== object.etag || result.size !== object.size) {
      await result.body?.cancel();
      return errorResponse(503, method, { 'Retry-After': '1' });
    }
    return new Response(result.body, { status: range ? 206 : 200, headers });
  } catch {
    return errorResponse(502, method);
  }
}

export default { fetch: serveLinuxRelease };
