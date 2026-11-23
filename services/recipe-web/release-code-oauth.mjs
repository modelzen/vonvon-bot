import { readFileSync, statSync } from 'node:fs';
import Provider, { errors } from 'oidc-provider';
import { createReleaseCodeStore } from './release-code-store.mjs';
import { WebError } from './auth.mjs';

const prefix = '/release-code/oauth';
const interactionPath = /^\/release-code\/confirm\/([A-Za-z0-9_-]{8,128})$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const clientId = 'vonvon-feedback-bot';
const readScope = 'release-code:read';
const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code';
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const page = (title, content) =>
  `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><main><h1>${title}</h1>${content}</main></html>`;

function readConfig(file) {
  const stat = statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65536)
    throw new Error('Invalid RELEASE_CODE_AUTH_KEYS_FILE permissions or size');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !config.jwks?.keys?.length ||
    !config.jwks.keys.every((k) => k.crv === 'P-256' && k.kty === 'EC' && k.alg === 'ES256' && k.kid && k.d) ||
    !Array.isArray(config.cookies) ||
    !config.cookies.length ||
    !config.cookies.every((k) => typeof k === 'string' && k.length >= 43)
  ) {
    throw new Error('Invalid release-code authorization keys');
  }
  return config;
}

export function createReleaseCodeAuth({ env, publicOrigin, apiOrigin, login }, overrides = {}) {
  const issuer = env.RELEASE_CODE_ISSUER;
  if (!issuer) return null;
  if (issuer !== publicOrigin + prefix) throw new Error('Invalid RELEASE_CODE_ISSUER');
  const resource = env.RELEASE_CODE_RESOURCE;
  const endpoint = new URL(resource);
  if (
    endpoint.pathname !== '/mcp' ||
    endpoint.href !== endpoint.origin + '/mcp' ||
    (endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))
  )
    throw new Error('Invalid RELEASE_CODE_RESOURCE');
  const config = overrides.config ?? readConfig(env.RELEASE_CODE_AUTH_KEYS_FILE);
  if (!overrides.store && !env.RELEASE_CODE_AUTH_DATABASE_URL)
    throw new Error('Missing RELEASE_CODE_AUTH_DATABASE_URL');
  const store =
    overrides.store ??
    createReleaseCodeStore(env.RELEASE_CODE_AUTH_DATABASE_URL, env.RELEASE_CODE_AUTH_LOGOUT_DIR);
  const account =
    overrides.account ??
    (async (req) => {
      const access = await login.access(req);
      if (!access) return null;
      const result = await fetch(apiOrigin + '/v1/me', {
        headers: { authorization: 'Bearer ' + access },
        redirect: 'error',
        signal: AbortSignal.timeout(9000)
      });
      if ([401, 403].includes(result.status)) return null;
      if (!result.ok) throw new WebError(503, 'account_unavailable');
      const { accountId } = await result.json();
      // recipe-api has verified this exact JWT and mapped its issuer and subject.
      const { session_id: sessionId } = JSON.parse(Buffer.from(access.split('.')[1], 'base64url'));
      login.assertAccess(req, access);
      if (!uuid.test(accountId) || !uuid.test(sessionId)) throw new WebError(401, 'invalid_account_session');
      return { accountId, sessionId, webSession: login.status(req).displaySession };
    });

  const application = new Provider(issuer, {
    adapter: store.Adapter,
    clients: [
      {
        client_id: clientId,
        client_name: 'VonVon 帮助与反馈',
        application_type: 'native',
        redirect_uris: ['http://127.0.0.1/vonvon/oauth/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token', deviceGrant],
        response_types: ['code'],
        id_token_signed_response_alg: 'ES256'
      }
    ],
    jwks: config.jwks,
    cookies: { keys: config.cookies },
    pkce: { required: () => true },
    rotateRefreshToken: true,
    ttl: {
      Session: 8 * 3600,
      AccessToken: 600,
      AuthorizationCode: 60,
      DeviceCode: 600,
      RefreshToken: 30 * 86400,
      Grant: 30 * 86400,
      Interaction: 600
    },
    clientBasedCORS: (_ctx, origin) => origin === publicOrigin,
    scopes: ['offline_access'],
    responseTypes: ['code'],
    clientDefaults: { id_token_signed_response_alg: 'ES256' },
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      revocation: { enabled: true },
      deviceFlow: {
        enabled: true,
        deviceInfo: () => ({}),
        userCodeInputSource(ctx, form, _out, error) {
          ctx.body = page(
            '输入设备授权码',
            `<p>${error ? '验证码无效或已过期。' : ''}请填写本人 Bot 私聊中显示的授权码。</p>${form}<button type="submit" form="op.deviceInputForm">继续</button>`
          );
        },
        userCodeConfirmSource(ctx, form, _client, _device, code) {
          ctx.body = page(
            '核对授权码',
            `<p>请核对本人 Bot 私聊中显示的代码 <strong>${escape(code)}</strong>。</p>${form}<button type="submit" form="op.deviceConfirmForm">代码一致，继续</button><button form="op.deviceConfirmForm" name="abort" value="yes">取消</button>`
          );
        },
        successSource(ctx) {
          ctx.body = page('授权操作已完成', '<p>请返回本人 Bot 私聊查看结果。</p>');
        }
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        getResourceServerInfo(_ctx, requested) {
          if (requested !== resource) throw new errors.InvalidTarget();
          return {
            scope: readScope,
            audience: resource,
            accessTokenTTL: 600,
            accessTokenFormat: 'jwt',
            jwt: { sign: { alg: 'ES256' } }
          };
        }
      }
    },
    interactions: { url: (_ctx, interaction) => publicOrigin + '/release-code/confirm/' + interaction.uid },
    async loadExistingGrant(ctx) {
      // A fresh user request always shows its own explicit consent screen.
      const id = ctx.oidc.result?.consent?.grantId;
      return id ? ctx.oidc.provider.Grant.find(id) : undefined;
    },
    async findAccount(ctx, id, token) {
      const valid = token?.grantId
        ? await store.validGrant(token.grantId, id)
        : (await account(ctx.req))?.accountId === id;
      return valid ? { accountId: id, claims: async () => ({ sub: id }) } : undefined;
    }
  });

  const callback = application.callback();
  function canonicalHeaders(req) {
    // Only the configured public origin shapes OAuth redirects and cookie security.
    const base = new URL(publicOrigin);
    req.headers.host = base.host;
    req.headers['x-forwarded-host'] = base.host;
    req.headers['x-forwarded-proto'] = base.protocol.slice(0, -1);
    delete req.headers['x-forwarded-for'];
  }
  application.proxy = true;

  async function interaction(req, res, url) {
    const { uid, prompt, params, session } = await application.interactionDetails(req, res);
    if (
      url.pathname !== '/release-code/confirm/' + uid ||
      params.client_id !== clientId ||
      !params.scope?.split(' ').includes(readScope)
    )
      throw new WebError(400, 'invalid_code_interaction');
    const status = login.status(req);
    if (req.method === 'GET') {
      let content;
      if (status.signedIn) {
        const active = await account(req);
        if (!active || active.webSession !== status.displaySession) throw new WebError(401, 'login_required');
        content = `<p>当前 VonVon 账号 <code>${escape(active.accountId)}</code> 将允许本人 Bot 搜索和读取最新正式版代码。请仅批准你刚刚发起的请求。</p><form method="post"><input type="hidden" name="session" value="${escape(status.displaySession)}"><button name="action" value="accept">允许查阅</button><button name="action" value="cancel">取消</button></form>`;
      } else {
        content =
          '<p>先登录你的 VonVon 账号。</p>' +
          status.providers
            .map(
              (p) =>
                `<form action="/auth/start" method="post"><input type="hidden" name="provider" value="${escape(p)}"><input type="hidden" name="returnTo" value="${escape(url.pathname)}"><button>用 ${escape(p)} 登录</button></form>`
            )
            .join('');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('VonVon 发布版代码查阅', content));
      return;
    }
    if (
      req.method !== 'POST' ||
      req.headers.origin !== publicOrigin ||
      !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')
    )
      throw new WebError(403, 'invalid_origin');
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1024) throw new WebError(413, 'too_large');
    }
    const form = new URLSearchParams(raw);
    if (!status.signedIn || status.displaySession !== form.get('session'))
      throw new WebError(409, 'session_changed');
    if (form.get('action') === 'cancel')
      return application.interactionFinished(
        req,
        res,
        { error: 'access_denied' },
        { mergeWithLastSubmission: false }
      );
    if (form.get('action') !== 'accept') throw new WebError(400, 'invalid_action');
    const active = await account(req);
    if (!active || active.webSession !== status.displaySession) throw new WebError(401, 'login_required');
    if (prompt.name === 'consent' && session?.accountId !== active.accountId)
      throw new WebError(409, 'session_changed');
    if (!['login', 'consent'].includes(prompt.name)) throw new WebError(400, 'invalid_code_interaction');
    const grant = new application.Grant({ clientId, accountId: active.accountId });
    grant.addResourceScope(resource, readScope);
    if (params.scope.split(' ').includes('offline_access')) grant.addOIDCScope('offline_access');
    const grantId = await grant.save();
    await store.bind(grantId, active.accountId, active.sessionId, active.webSession);
    if (login.status(req).displaySession !== active.webSession) throw new WebError(409, 'session_changed');
    return application.interactionFinished(
      req,
      res,
      { login: { accountId: active.accountId, remember: false }, consent: { grantId } },
      { mergeWithLastSubmission: false }
    );
  }

  return {
    async handle(req, res, url) {
      const confirm = interactionPath.test(url.pathname);
      const discover = url.pathname === '/.well-known/oauth-authorization-server' + prefix;
      if (!discover && !confirm && !url.pathname.startsWith(prefix + '/')) return false;
      res.setHeader('Referrer-Policy', 'no-referrer');
      canonicalHeaders(req);
      if (confirm) await interaction(req, res, url);
      else {
        req.baseUrl = prefix;
        req.url = discover ? '/.well-known/oauth-authorization-server' : req.url.slice(prefix.length);
        await callback(req, res);
      }
      return true;
    },
    logout: store.logout,
    close: () => store.close()
  };
}
