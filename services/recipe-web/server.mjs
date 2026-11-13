import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createLogin, detailPath, WebError } from './auth.mjs';
import { createNativeLogin } from './native-auth.mjs';

function origin(value, name, loopbackOnly = false) {
  const url = new URL(value);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.href !== url.origin + '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || (loopbackOnly && !local)) {
    throw new Error('Invalid ' + name);
  }
  return url.origin;
}

const assets = new Map([
  ['/auth/native', ['native.html', 'text/html; charset=utf-8']],
  ['/auth/native/complete', ['native.html', 'text/html; charset=utf-8']],
  ['/native.mjs', ['native.mjs', 'text/javascript; charset=utf-8']],
  ['/native.css', ['native.css', 'text/css; charset=utf-8']],
  ['/studio', ['studio.html', 'text/html; charset=utf-8']],
  ['/studio.html', ['studio.html', 'text/html; charset=utf-8']],
  ['/studio.css', ['studio.css', 'text/css; charset=utf-8']],
  ['/studio.mjs', ['studio.mjs', 'text/javascript; charset=utf-8']],
  ['/setup.mjs', ['setup.mjs', 'text/javascript; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/markdown-it.mjs', ['../node_modules/markdown-it/dist/browser/markdown-it.esm.min.mjs', 'text/javascript; charset=utf-8']],
  ['/credential-shapes.mjs', ['../../recipe-api/src/credential-shapes.mjs', 'text/javascript; charset=utf-8']],
  ['/markdown.mjs', ['markdown.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/mark.png', ['mark.png', 'image/png']],
]);
const idPattern = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const versionRead = new RegExp('^/v1/recipes/' + idPattern + '/versions/' + idPattern + '$', 'i');
const claimPath = new RegExp('^/v1/versions/' + idPattern + '/(redeem|acquire)$', 'i');

const draftPath = new RegExp('^/v1/drafts/' + idPattern + '$', 'i');
const publishPath = new RegExp('^/v1/drafts/' + idPattern + '/publish$', 'i');
const codesPath = new RegExp('^/v1/versions/' + idPattern + '/codes$', 'i');
const disableCode = new RegExp('^/v1/codes/' + idPattern + '/(?:disable|reveal)$', 'i');

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
}
async function body(req, limit) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new WebError(413, 'too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createRecipeWeb(env = process.env) {
  const port = Number(env.RECIPE_WEB_PORT || 49151);
  const publicOrigin = origin(env.RECIPE_WEB_ORIGIN || 'http://127.0.0.1:' + port, 'RECIPE_WEB_ORIGIN');
  const apiOrigin = origin(env.RECIPE_API_ORIGIN || 'http://127.0.0.1:4317', 'RECIPE_API_ORIGIN', true);
  const supabaseOrigin = env.SUPABASE_URL ? origin(env.SUPABASE_URL, 'SUPABASE_URL') : null;
  const authConfig = { publicOrigin, supabaseOrigin, publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
    providerNames: (env.RECIPE_WEB_PROVIDERS || 'github,google,apple').split(',').map(x => x.trim()) };
  const login = createLogin(authConfig), native = createNativeLogin(authConfig);

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', /^\/auth\/(?:callback|native)/.test(req.url || '') ? 'no-referrer' : 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const url = new URL(req.url, publicOrigin);
    if (url.origin !== publicOrigin) throw new WebError(400, 'invalid_path');
    if (await native.handle(req, res, url)) return;
    if (['POST', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin !== publicOrigin) throw new WebError(403, 'invalid_origin');
    if (req.method === 'GET' && url.pathname === '/auth/session') return json(res, 200, login.status(req));
    if (req.method === 'POST' && url.pathname === '/auth/start') {
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new WebError(415, 'invalid_body');
      return login.start(req, res, new URLSearchParams(await body(req, 4096)));
    }
    if (req.method === 'GET' && url.pathname === '/auth/callback') return login.callback(req, res, url);
    if (req.method === 'POST' && url.pathname === '/auth/logout') return login.logout(req, res);
    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice(4);
      const read = req.method === 'GET' && (versionRead.test(path) || ['/v1/community/recipes', '/v1/me/recipes'].includes(path));
      const claim = req.method === 'POST' && claimPath.test(path);
      const creatorRead = req.method === 'GET' && (['/v1/me/drafts', '/v1/me/publications'].includes(path) || draftPath.test(path) || codesPath.test(path));
      const creatorWrite = (req.method === 'POST' && (path === '/v1/drafts' || publishPath.test(path) || codesPath.test(path) || disableCode.test(path))) || (['PATCH', 'DELETE'].includes(req.method) && draftPath.test(path));
      if (!read && !claim && !creatorRead && !creatorWrite) throw new WebError(404, 'not_found');
      const access = await login.access(req, { write: claim || creatorWrite });
      if ((claim || creatorRead || creatorWrite || path === '/v1/me/recipes') && !access) throw new WebError(401, 'login_required');
      const headers = { Accept: 'application/json' };
      if (access) headers.Authorization = 'Bearer ' + access;
      let payload;
      if (claim || creatorWrite) {
        if (req.method !== 'DELETE' && !req.headers['content-type']?.startsWith('application/json')) throw new WebError(415, 'invalid_body');
        headers['Content-Type'] = 'application/json';
        headers['Idempotency-Key'] = String(req.headers['idempotency-key'] || '');
        if (req.headers['if-match']) headers['If-Match'] = req.headers['if-match'];
        payload = await body(req, creatorWrite ? 448 * 1024 : 4096);
      }
      login.assertAccess(req, access, { write: claim || creatorWrite });
      const response = await fetch(apiOrigin + path + url.search, {
        method: req.method, headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(12_000),
      });
      const data = await response.json();
      if (response.headers.has('retry-after')) res.setHeader('Retry-After', response.headers.get('retry-after'));
      return json(res, response.status, data);
    }
    if (req.method === 'GET') {
      const asset = assets.get(url.pathname) || ((['/', '/library'].includes(url.pathname) || detailPath.test(url.pathname)) && ['index.html', 'text/html; charset=utf-8']);
      if (asset) {
        const file = await readFile(new URL('public/' + asset[0], import.meta.url));
        res.writeHead(200, { 'Content-Type': asset[1] }); res.end(file); return;
      }
    }
    throw new WebError(404, 'not_found');
  }
  const server = createServer((req, res) => handle(req, res).catch(error => {
    if (!res.headersSent) json(res, error instanceof WebError ? error.status : 503,
      { error: { code: error instanceof WebError ? error.message : 'unavailable' } });
    else res.end();
  }));
  server.on('close', () => { login.stop(); native.stop(); });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.RECIPE_WEB_PORT || 49151);
  createRecipeWeb().listen(port, '127.0.0.1', () => console.log('Recipe web listening on 127.0.0.1:' + port));
}
