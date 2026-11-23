const serviceOrigin = 'https://recipe-service.internal';
const upstream = 'https://account.vonvon.cc/internal-recipe-attachments';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const readObject = new RegExp(`^/v2/(?:drafts|versions)/${uuid}/objects/${uuid}$`, 'i');
const readLogo = new RegExp(`^/v2/versions/${uuid}/display-logo$`, 'i');
const readInstall = new RegExp(`^/v2/operations/${uuid}/objects/${uuid}$`, 'i');
const writeMember = new RegExp(`^/v2/objects/${uuid}/members/(?:0|[1-9][0-9]?)$`, 'i');
const requestHeaders = [
  'accept', 'authorization', 'content-encoding', 'content-type', 'idempotency-key',
  'if-match', 'if-modified-since', 'if-none-match', 'if-range', 'if-unmodified-since', 'range',
  'x-recipe-kind', 'x-recipe-sha256', 'x-vonvon-browse',
];
const responseHeaders = [
  'accept-ranges', 'allow', 'content-disposition', 'content-encoding', 'content-length',
  'content-range', 'content-type', 'etag', 'last-modified', 'retry-after',
  'vary', 'www-authenticate', 'x-content-type-options',
];
const safetyHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

function selectedHeaders(input, allowed) {
  const result = new Headers();
  const connectionOptions = new Set((input.get('connection') ?? '').toLowerCase().split(',').map(option => option.trim()));
  for (const name of allowed) {
    const value = input.get(name);
    if (value !== null && !connectionOptions.has(name)) result.set(name, value);
  }
  return result;
}

function problem(status, code) {
  return Response.json({ error: { code } }, { status, headers: safetyHeaders });
}

export default {
  async fetch(request, env) {
    const { origin, pathname, search } = new URL(request.url);
    const upload = request.method === 'PUT' && writeMember.test(pathname);
    const canForward = (request.method === 'GET' && (readObject.test(pathname) || readLogo.test(pathname))) ||
      (request.method === 'POST' && readInstall.test(pathname)) || upload;
    if (origin !== serviceOrigin || search || !canForward) return problem(404, 'not_found');
    if (!/^[0-9a-f]{64}$/.test(env.RECIPE_BROKER_RELAY_SECRET ?? '')) return problem(503, 'upstream_unavailable');

    const signal = AbortSignal.timeout(35_000);
    const headers = selectedHeaders(request.headers, requestHeaders);
    headers.set('X-Vonvon-Attachment-Relay', env.RECIPE_BROKER_RELAY_SECRET);
    let body = request.body;
    try {
      if (upload) {
        const length = request.headers.get('content-length');
        if (!/^\d{1,7}$/.test(length ?? '') || !body) return problem(411, 'length_required');
        // The upstream broker validates Content-Length before consuming the streamed member.
        const fixed = new FixedLengthStream(Number(length));
        void body.pipeTo(fixed.writable, { signal }).catch(() => {});
        body = fixed.readable;
      }
      const response = await fetch(upstream + pathname, {
        method: request.method, headers, body, signal,
        ...(body && { duplex: 'half' }),
        redirect: 'manual', cache: 'no-store',
      });
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        await response.body?.cancel().catch(() => {});
        return problem(502, 'upstream_redirect');
      }
      const safeHeaders = selectedHeaders(response.headers, responseHeaders);
      for (const [name, value] of Object.entries(safetyHeaders)) safeHeaders.set(name, value);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: safeHeaders,
        encodeBody: 'manual',
      });
    } catch {
      return problem(signal.aborted ? 504 : 502, signal.aborted ? 'upstream_timeout' : 'upstream_unavailable');
    }
  },
};
