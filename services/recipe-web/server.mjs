import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createLogin, detailPath, returnPath, WebError } from './auth.mjs';
import { createReleaseCodeAuth } from './release-code-oauth.mjs';
import { createNativeLogin } from './native-auth.mjs';
import { recipeCreationUrl, recipeDraftsUrl } from './public/app-links.mjs';
import { browseDetail, displayLogoLimit, verifiedDisplayLogo } from './dist/rich-detail.mjs';

function origin(value, name, loopbackOnly = false) {
  const url = new URL(value);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.href !== url.origin + '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || (loopbackOnly && !local)) {
    throw new Error('Invalid ' + name);
  }
  return url.origin;
}

const accountPages = new Map([
  ['/login', ['login.html', 'text/html; charset=utf-8']],
  ['/account', ['account.html', 'text/html; charset=utf-8']],
  ['/auth/native', ['login.html', 'text/html; charset=utf-8']],
  ['/auth/native/complete', ['login.html', 'text/html; charset=utf-8']],
]);
const accountAssets = new Map([
  ...accountPages,
  ['/login.mjs', ['login.mjs', 'text/javascript; charset=utf-8']],
  ['/login-promo.mjs', ['login-promo.mjs', 'text/javascript; charset=utf-8']],
  ['/login-join.webp', ['login-join.webp', 'image/webp']],
  ['/login-provider.webp', ['login-provider.webp', 'image/webp']],
  ['/login-product.webp', ['login-product.webp', 'image/webp']],
  ['/login.css', ['login.css', 'text/css; charset=utf-8']],
  ['/account.mjs', ['account.mjs', 'text/javascript; charset=utf-8']],
  ['/account.css', ['account.css', 'text/css; charset=utf-8']],
  ['/native.mjs', ['native.mjs', 'text/javascript; charset=utf-8']],
  ['/native.css', ['native.css', 'text/css; charset=utf-8']],
  ['/avatar-format.mjs', ['../../recipe-api/src/logo-format.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/mark.png', ['mark.png', 'image/png']],
  ['/community-logo.webp', ['community-logo.webp', 'image/webp']],
]);
const assets = new Map([
  ...accountAssets,
  ['/studio', ['studio.html', 'text/html; charset=utf-8']],
  ['/studio.html', ['studio.html', 'text/html; charset=utf-8']],
  ['/studio.css', ['studio.css', 'text/css; charset=utf-8']],
  ['/studio.mjs', ['studio.mjs', 'text/javascript; charset=utf-8']],
  ['/setup.mjs', ['setup.mjs', 'text/javascript; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/header.mjs', ['header.mjs', 'text/javascript; charset=utf-8']],
  ['/create.mjs', ['create.mjs', 'text/javascript; charset=utf-8']],
  ['/app-links.mjs', ['app-links.mjs', 'text/javascript; charset=utf-8']],
  ['/viewer.mjs', ['../dist/viewer.mjs', 'text/javascript; charset=utf-8']],
  ['/viewer.css', ['../dist/viewer.css', 'text/css; charset=utf-8']],
  ['/vendor/markdown-it.mjs', ['../node_modules/markdown-it/dist/browser/markdown-it.esm.min.mjs', 'text/javascript; charset=utf-8']],
  ['/credential-shapes.mjs', ['../../recipe-api/src/credential-shapes.mjs', 'text/javascript; charset=utf-8']],
  ['/markdown.mjs', ['markdown.mjs', 'text/javascript; charset=utf-8']],
]);
const accountRequests = new Map([
  ['GET /auth/session', []],
  ['POST /auth/start', ['content-type']],
  ['POST /auth/logout', ['x-vonvon-session']],
  ['POST /auth/account-link/consume', ['content-type']],
  ['GET /api/v2/me/account-profile', ['x-vonvon-session']],
  ['POST /api/v2/me/account-profile', ['content-type', 'idempotency-key', 'if-match', 'x-vonvon-session']],
  ['POST /api/v2/me/account-profile/initialize', ['content-type', 'idempotency-key', 'x-vonvon-session']],
  ['GET /auth/native/browser', ['content-type', 'x-vonvon-native-tab']],
  ...['launch', 'select', 'complete', 'confirm', 'switch', 'cancel'].map(path =>
    ['POST /auth/native/' + path, ['content-type', 'x-vonvon-native-tab']]),
]);

function allowAccountRequest(req, res, path, accountOrigin) {
  if (!accountOrigin) return false;
  const preflight = req.method === 'OPTIONS';
  const method = preflight ? req.headers['access-control-request-method'] : req.method;
  const allowedHeaders = accountRequests.get(method + ' ' + path);
  if (allowedHeaders) res.setHeader('Vary', preflight ? 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' : 'Origin');
  if (req.headers.origin !== accountOrigin) return false;
  if (!allowedHeaders) {
    if (preflight) throw new WebError(403, 'invalid_origin');
    return false;
  }
  if (preflight) {
    const requestedHeaders = req.headers['access-control-request-headers'];
    if (requestedHeaders && requestedHeaders.toLowerCase().split(',').some(header => !allowedHeaders.includes(header.trim()))) {
      throw new WebError(403, 'invalid_origin');
    }
    res.setHeader('Access-Control-Allow-Methods', method);
    if (allowedHeaders.length) res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '));
  }
  res.setHeader('Access-Control-Allow-Origin', accountOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  return true;
}
const idPattern = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const displayLogoPath = new RegExp('^/media/versions/(' + idPattern + ')/logo[.]webp$', 'i');
const versionRead = new RegExp('^/v[12]/recipes/(' + idPattern + ')/versions/(' + idPattern + ')(?:/preview)?$', 'i');
const authorRead = new RegExp('^/v2/authors/' + idPattern + '/recipes$', 'i');
const authorPage = new RegExp('^/authors/' + idPattern + '$', 'i');
const recipeGroupVersions = new RegExp('^/v2/me/recipe-groups/' + idPattern + '/versions$', 'i');
const claimPath = new RegExp('^/v[12]/versions/' + idPattern + '/(redeem|acquire)$', 'i');

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
async function limitedMember(response, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new WebError(503, 'content_unavailable');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createRecipeWeb(env = process.env) {
  const siteKind = env.RECIPE_SITE_KIND || 'community';
  if (!['community', 'creators', 'account'].includes(siteKind)) throw new Error('Invalid RECIPE_SITE_KIND');
  const communityUrl = env.RECIPE_COMMUNITY_ORIGIN ? origin(env.RECIPE_COMMUNITY_ORIGIN, 'RECIPE_COMMUNITY_ORIGIN') + '/' : '/';
  const creatorsUrl = env.RECIPE_CREATORS_ORIGIN ? origin(env.RECIPE_CREATORS_ORIGIN, 'RECIPE_CREATORS_ORIGIN') + '/' : '/creators';
  const libraryUrl = communityUrl === '/' ? '/library' : new URL('library',communityUrl).href;
  const configuredAccountOrigin = env.RECIPE_ACCOUNT_ORIGIN ? origin(env.RECIPE_ACCOUNT_ORIGIN, 'RECIPE_ACCOUNT_ORIGIN') : '';
  const accountUrl = configuredAccountOrigin ? configuredAccountOrigin + '/account' : '/account';
  const desktopChannel = env.RECIPE_DESKTOP_CHANNEL || 'preview';
  if (!['preview', 'stable'].includes(desktopChannel)) throw new Error('Invalid RECIPE_DESKTOP_CHANNEL');
  const port = Number(env.RECIPE_WEB_PORT || 49151);
  const publicOrigin = origin(env.RECIPE_WEB_ORIGIN || 'http://127.0.0.1:' + port, 'RECIPE_WEB_ORIGIN');
  const accountOrigin = configuredAccountOrigin !== publicOrigin ? configuredAccountOrigin : '';
  const accountHost = accountOrigin ? new URL(accountOrigin).host : '';
  const apiOrigin = origin(env.RECIPE_API_ORIGIN || 'http://127.0.0.1:4317', 'RECIPE_API_ORIGIN', true);
  const brokerOrigin = origin(env.RECIPE_BROKER_ORIGIN || 'http://127.0.0.1:4318', 'RECIPE_BROKER_ORIGIN', true);
  const supabaseOrigin = env.SUPABASE_URL ? origin(env.SUPABASE_URL, 'SUPABASE_URL') : null;
  const authConfig = { publicOrigin, accountOrigin, supabaseOrigin, publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
    providerNames: (env.RECIPE_WEB_PROVIDERS || 'github,google').split(',').map(x => x.trim()) };
  async function verifyIdentity(accessToken, signal = AbortSignal.timeout(9000)) {
    const response = await fetch(apiOrigin + '/v2/me/account-profile', {headers: {Authorization: 'Bearer ' + accessToken},
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(9000)])});
    if (!response.ok) throw new WebError([401, 403].includes(response.status) ? 401 : 503, 'identity_unavailable');
    const profile = JSON.parse((await limitedMember(response, 200_000)).toString('utf8'));
    if (!new RegExp('^' + idPattern + '$', 'i').test(profile.authorId || '') || typeof profile.displayName !== 'string' || !profile.displayName || Array.from(profile.displayName).length > 60) throw new WebError(503, 'identity_unavailable');
    if (profile.avatarDataUrl !== undefined && (typeof profile.avatarDataUrl !== 'string' || profile.avatarDataUrl.length > 174787 || !/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(profile.avatarDataUrl))) throw new WebError(503, 'identity_unavailable');
    return {accountId: profile.authorId.toLowerCase(), displayName: profile.displayName, revision:profile.revision, ...(profile.avatarDataUrl && {avatarDataUrl: profile.avatarDataUrl})};
  }
  const login = createLogin({...authConfig, verifyIdentity}), native = createNativeLogin({...authConfig, verifyIdentity, confirmWebSession: login.confirmNative});
  const releaseCode = createReleaseCodeAuth({ env, publicOrigin, apiOrigin, login });

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', /^\/auth\/(?:callback|native)/.test(req.url || '') ? 'no-referrer' : 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const accountSite = Boolean(accountHost && req.headers.host?.toLowerCase() === accountHost);
    const siteOrigin = accountSite ? accountOrigin : publicOrigin;
    const connectSource = accountSite ? "'self' " + publicOrigin : "'self'";
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src " + connectSource + "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const url = new URL(req.url, siteOrigin);
    if (url.origin !== siteOrigin) throw new WebError(400, 'invalid_path');
    const appLogin = ['/auth/native','/auth/native/complete'].includes(url.pathname) || url.pathname === '/login' && url.searchParams.get('mode') === 'app';
    const loginReferrer = appLogin ? 'no-referrer' : accountSite ? 'strict-origin-when-cross-origin' : 'same-origin';
    if (appLogin || accountSite && url.pathname === '/login') res.setHeader('Referrer-Policy', loginReferrer);
    if (!accountSite && accountOrigin && req.method === 'GET' && accountPages.has(url.pathname)) {
      res.writeHead(303, { Location: accountOrigin + url.pathname + url.search }); res.end(); return;
    }
    if (accountSite && (req.method !== 'GET' || (url.pathname !== '/' && !accountAssets.has(url.pathname)))) {
      throw new WebError(404, 'not_found');
    }
    const fromAccount = !accountSite && allowAccountRequest(req, res, url.pathname, accountOrigin);
    if (fromAccount && req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (['/open/draft', '/open-draft.mjs', '/open-draft.css'].includes(url.pathname)) {
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      if (req.method !== 'GET' || url.search) throw new WebError(400, 'invalid_path');
      const asset = url.pathname === '/open/draft' ? ['open-draft.html', 'text/html; charset=utf-8']
        : url.pathname === '/open-draft.mjs' ? ['open-draft.mjs', 'text/javascript; charset=utf-8']
          : ['open-draft.css', 'text/css; charset=utf-8'];
      const file = await readFile(new URL('public/' + asset[0], import.meta.url), 'utf8');
      res.writeHead(200, {'Content-Type': asset[1]});
      res.end(url.pathname === '/open/draft' ? file.replace('__DESKTOP_CHANNEL__', desktopChannel) : file);
      return;
    }
    if (releaseCode && await releaseCode.handle(req, res, url)) return;
    if (!accountSite && await native.handle(req, res, url, fromAccount)) return;
    const logo = req.method === 'GET' && displayLogoPath.exec(url.pathname);
    if (logo) {
      const response = await fetch(brokerOrigin + '/v2/versions/' + logo[1].toLowerCase() + '/display-logo', {
        redirect: 'error', signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new WebError(response.status === 404 ? 404 : 503, 'content_unavailable');
      const bytes = verifiedDisplayLogo(await limitedMember(response, displayLogoLimit));
      res.writeHead(200, {'Content-Type': 'image/webp'}); res.end(bytes); return;
    }
    if (req.method === 'POST' && url.pathname === '/auth/account-link') {
      if (req.headers.origin || req.headers.cookie) throw new WebError(403, 'invalid_origin');
      const match = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/.exec(req.headers.authorization || '');
      if (!match) throw new WebError(401, 'login_required');
      const token = match[1];
      const identity = await verifyIdentity(token);
      return json(res, 201, login.accountLink(token, identity));
    }
    if (['POST', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin !== publicOrigin && !fromAccount) throw new WebError(403, 'invalid_origin');
    if (req.method === 'POST' && url.pathname === '/auth/account-link/consume') {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new WebError(415, 'invalid_body');
      const data = JSON.parse(await body(req, 2048));
      return json(res, 200, await login.consumeAccountLink(req, res, data, verifyIdentity));
    }
    if (req.method === 'GET' && url.pathname === '/auth/session') return json(res, 200, login.status(req));
    if (req.method === 'POST' && url.pathname === '/auth/continuation') {
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new WebError(415, 'invalid_body');
      const form = new URLSearchParams(await body(req, 4096));
      return json(res, 200, login.consumeContinuation(req, form.get('returnTo'), form.get('continuationNonce')));
    }
    if (req.method === 'POST' && url.pathname === '/auth/start') {
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new WebError(415, 'invalid_body');
      return login.start(req, res, new URLSearchParams(await body(req, 4096)));
    }
    if (req.method === 'GET' && url.pathname === '/auth/callback') return login.callback(req, res, url);
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      const current = login.status(req).displaySession;
      login.logout(req, res, fromAccount);
      if (current && releaseCode) releaseCode.logout(current);
      return;
    }
    if (req.method === 'GET' && (['/publications','/creators'].includes(url.pathname) || url.pathname === '/' && siteKind === 'creators')) {res.writeHead(303, {Location: libraryUrl + '?state=published'}); res.end(); return;}
    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice(4);
      const accountProfile = path === '/v2/me/account-profile';
      const profileInitialize = path === '/v2/me/account-profile/initialize';
      if ((accountProfile || profileInitialize) && url.search) throw new WebError(400, 'invalid_path');
      const profileRead = accountProfile && req.method === 'GET';
      const profileWrite = (accountProfile || profileInitialize) && req.method === 'POST';
      const read = req.method === 'GET' && (versionRead.test(path) || authorRead.test(path) || recipeGroupVersions.test(path) || ['/v1/community/recipes', '/v1/me/recipes', '/v2/community/recipes', '/v2/me/recipes', '/v2/me/publications', '/v2/me/recipe-groups'].includes(path));
      const claim = req.method === 'POST' && claimPath.test(path);
      const creatorRead = req.method === 'GET' && (path === '/v1/me/publications' || codesPath.test(path));
      const publicationWrite = req.method === 'POST' && new RegExp('^/v2/versions/' + idPattern + '/(withdraw|delete)$', 'i').test(path);
      const creatorWrite = publicationWrite || req.method === 'POST' && (codesPath.test(path) || disableCode.test(path));
      if (!read && !claim && !creatorRead && !creatorWrite && !profileRead && !profileWrite) throw new WebError(404, 'not_found');
      const privateRead = req.method === 'GET' && /^\/v[12]\/me\//.test(path);
      const guardedRead = req.method === 'GET' && (privateRead || (versionRead.test(path) && req.headers['x-vonvon-session'] !== undefined));
      const guarded = claim || creatorWrite || guardedRead || profileRead || profileWrite;
      const access = await login.access(req, { write: guarded });
      if (guardedRead && !access) throw new WebError(privateRead ? 401 : 409, privateRead ? 'login_required' : 'session_changed');
      if ((claim || creatorRead || creatorWrite || profileRead || profileWrite || /^\/v[12]\/me\//.test(path)) && !access) throw new WebError(401, 'login_required');
      const headers = { Accept: 'application/json' };
      if (access) headers.Authorization = 'Bearer ' + access;
      let payload;
      if (claim || creatorWrite || profileWrite) {
        if (req.method !== 'DELETE' && !req.headers['content-type']?.startsWith('application/json')) throw new WebError(415, 'invalid_body');
        headers['Content-Type'] = 'application/json';
        headers['Idempotency-Key'] = String(req.headers['idempotency-key'] || '');
        if (req.headers['if-match']) headers['If-Match'] = req.headers['if-match'];
        payload = await body(req, profileWrite ? (profileInitialize ? 4096 : 3 * 1024 * 1024) : creatorWrite ? 448 * 1024 : 4096);
      }
      login.assertAccess(req, access, { write: guarded });
      const browseRead = req.method === 'GET' && path.startsWith('/v2/recipes/') && versionRead.test(path);
      const upstreamPath = browseRead && !path.endsWith('/preview') ? path + '/preview' : path;
      if (browseRead) headers['X-Vonvon-Browse'] = 'public-v2';
      const response = await fetch(apiOrigin + upstreamPath + url.search, {
        method: req.method, headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(12_000),
      });
      let data = await response.json();
      login.assertAccess(req, access, { write: guarded });
      if (response.ok && browseRead) {
        if (data.state === 'blocked' || data.state === 'withdrawn' && !data.recipeId) throw new WebError(404, 'not_found');
        const [, recipeId, versionId] = versionRead.exec(path.toLowerCase());
        data = browseDetail(data, recipeId, versionId);
        login.assertAccess(req, access, { write: guarded });
      }
      if (response.headers.has('retry-after')) res.setHeader('Retry-After', response.headers.get('retry-after'));
      return json(res, response.status, data);
    }
    if (req.method === 'GET' && url.pathname === '/create' && !await login.access(req)) {
      const backTo = returnPath(url.searchParams.get('from'));
      res.writeHead(303, {Location: '/login?' + new URLSearchParams({returnTo: '/create', backTo})});
      res.end(); return;
    }
    if (req.method === 'GET') {
      const asset = url.pathname === '/create' ? ['studio.html', 'text/html; charset=utf-8'] : url.pathname === '/' && (accountSite || siteKind === 'account') ? accountPages.get('/account')
        : assets.get(url.pathname) || ((['/', '/library', '/publications'].includes(url.pathname) || authorPage.test(url.pathname) || detailPath.test(url.pathname)) && ['index.html', 'text/html; charset=utf-8']);
      if (asset) {
        const file = await readFile(new URL('public/' + asset[0], import.meta.url));
        const content = asset[1].startsWith('text/html') ? file.toString('utf8')
          .replaceAll('__DESKTOP_CHANNEL__', desktopChannel).replaceAll('__RECIPE_CREATE_URL__', recipeCreationUrl(desktopChannel))
          .replaceAll('__RECIPE_DRAFTS_URL__', recipeDraftsUrl(desktopChannel))
          .replaceAll('__COMMUNITY_URL__', accountSite && communityUrl === '/' ? publicOrigin + '/' : communityUrl)
          .replaceAll('__CREATORS_URL__', creatorsUrl).replaceAll('__LIBRARY_URL__', accountSite && libraryUrl === '/library' ? publicOrigin + '/library' : libraryUrl)
          .replaceAll('__ACCOUNT_URL__', accountUrl).replaceAll('__AUTH_ORIGIN__', accountSite ? publicOrigin : '')
          .replaceAll('__CREATE_READY__', String(url.pathname === '/create'))
          .replaceAll('__GUARDED_CREATE_URL__','/create?from=' + encodeURIComponent(returnPath(url.pathname + url.search)))
          .replaceAll('__STUDIO_CREATE_URL__',url.pathname === '/create' ? recipeCreationUrl(desktopChannel) : '/create?from=%2Fstudio')
          .replaceAll('__STUDIO_ACTION__',url.pathname === '/create' ? 'data-create-recipe' : 'data-create-site')
          .replaceAll('__ACCOUNT_AFTER__',url.searchParams.has('after') ? encodeURIComponent(returnPath(url.searchParams.get('after'))) : '')
          .replaceAll('__LOGIN_BACK_TO__', encodeURIComponent(returnPath(url.searchParams.get('backTo') ?? url.searchParams.get('returnTo'))))
          .replaceAll('__LOGIN_RETURN_TO__', encodeURIComponent(returnPath(url.searchParams.get('returnTo'))))
          .replaceAll('__LOGIN_ERROR__', ['failed','cancelled'].includes(url.searchParams.get('auth')) ? url.searchParams.get('auth') : 'false')
          .replaceAll('__LOGIN_MODE__', appLogin ? 'app' : 'web').replaceAll('__LOGIN_REFERRER__', loginReferrer) : file;
        res.writeHead(200, { 'Content-Type': asset[1] }); res.end(content); return;
      }
    }
    throw new WebError(404, 'not_found');
  }
  const server = createServer((req, res) => handle(req, res).catch(error => {
    if (!res.headersSent) json(res, error instanceof WebError ? error.status : 503,
      { error: { code: error instanceof WebError ? error.message : 'unavailable' } });
    else res.end();
  }));
  server.on('close', () => { login.stop(); native.stop(); void releaseCode?.close(); });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.RECIPE_WEB_PORT || 49151);
  createRecipeWeb().listen(port, '127.0.0.1', () => console.log('Recipe web listening on 127.0.0.1:' + port));
}
