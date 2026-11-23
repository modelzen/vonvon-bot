import { randomBytes } from 'node:crypto';
import { AuthClient } from '@supabase/auth-js';
import { createAuthMap } from './auth-state.mjs';
import {oauthCallback, oauthProviders, validOAuthAuthorizeUrl} from './oauth-provider.mjs';

const minute = 60_000;
const tokenRequestTimeout = 9_000;
const providers = new Set(['github', 'google', 'apple']);
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const detailPath = new RegExp('^/recipes/' + uuid + '/versions/' + uuid + '$', 'i');

export function returnPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.isWellFormed() ||
      !value.startsWith('/') || value.startsWith('//') || /[\\#\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value) || /%(?![a-f0-9]{2})/i.test(value)) return '/';
  const url = new URL(value, 'https://return.invalid');
  if (url.origin !== 'https://return.invalid' || value.split('?')[0] !== url.pathname) return '/';
  const params = url.searchParams;
  for (const [key, item] of params) {
    if (params.getAll(key).length !== 1 || /[\\\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(item)) return '/';
  }
  if (/^\/release-code\/confirm\/[A-Za-z0-9_-]{8,128}$/.test(url.pathname)) return value === url.pathname ? url.pathname : '/';
  const query = new URLSearchParams();
  if (url.pathname === '/') {
    if ([...params.keys()].some(key => key !== 'q')) return '/';
    const q = params.get('q');
    if (q !== null) {
      if ([...q].length > 120) return '/';
      query.set('q', q);
    }
  } else if (url.pathname === '/library') {
    if ([...params.keys()].some(key => key !== 'state')) return '/';
    const state = params.get('state');
    if (state !== null) {
      if (!['all','acquired','drafts','published'].includes(state)) return '/';
      query.set('state',state);
    }
  } else if (detailPath.test(url.pathname)) {
    if ([...params.keys()].some(key => !['from', 'author'].includes(key))) return '/';
    const from = params.get('from'), author = params.get('author');
    if (from !== null) {
      if (!['library', 'library-all', 'published', 'author', 'creator'].includes(from)) return '/';
      query.set('from', from);
    }
    if (from === 'author') {
      if (!new RegExp('^' + uuid + '$', 'i').test(author ?? '')) return '/';
      query.set('author', author.toLowerCase());
    } else if (author !== null) return '/';
  } else {
    const allowed = ['/library', '/publications', '/studio', '/account', '/creators', '/create'].includes(url.pathname) ||
      new RegExp('^/authors/' + uuid + '$', 'i').test(url.pathname);
    if (!allowed || params.size) return '/';
  }
  const path = url.pathname.toLowerCase();
  return path + (query.size ? '?' + query.toString() : '');
}

function cookieValue(req, name) {
  const prefix = name + '=';
  return String(req.headers.cookie || '').split(';').map(s => s.trim())
    .find(s => s.startsWith(prefix))?.slice(prefix.length);
}

export class WebError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

export function createLoginAdmission({ now = Date.now } = {}) {
  let tokens = 32, updated = now();
  return () => {
    const current = now();
    tokens = Math.min(32, tokens + Math.max(0, current - updated) / 1000);
    updated = current;
    if (tokens < 1) throw new WebError(429, 'busy');
    tokens--;
  };
}

export function createLogin({ publicOrigin, accountOrigin, supabaseOrigin, publishableKey, providerNames, verifyIdentity, authStorage, authFetch = globalThis.fetch }) {
  const available = supabaseOrigin && publishableKey ? oauthProviders(providerNames) : [];
  const flows = createAuthMap('web-flows', authStorage, value => value.deadline);
  const sessions = createAuthMap('web-sessions', authStorage, value => value.deadline, {
    encode: ({refreshing: _refreshing, ...session}) => session,
  });
  const links = createAuthMap('account-links', authStorage, value => value.deadline);
  const admit = createLoginAdmission();
  const secure = new URL(publicOrigin).protocol === 'https:';
  const flowName = secure ? '__Host-vv-flow' : 'vv-local-flow';
  const sessionName = secure ? '__Host-vv-session' : 'vv-local-session';
  const random = () => randomBytes(32).toString('base64url');
  const cookie = (name, value, seconds) => name + '=' + value + '; Max-Age=' + seconds + '; Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
  const getSession = req => {
    const key = cookieValue(req, sessionName);
    const session = sessions.get(key);
    if (session && session.deadline > Date.now()) return session;
    sessions.delete(key);
  };
  const prune = () => {
    const now = Date.now();
    for (const map of [flows, sessions, links]) map.prune(now);
  };
  const purge = authStorage ? null : setInterval(prune, minute);
  purge?.unref();

  function authClient(deadline, sdkValues, storageKey) {
    const storage = sdkValues && {
      getItem: key => sdkValues[key] ?? null,
      setItem: (key, value) => { sdkValues[key] = value; },
      removeItem: key => { delete sdkValues[key]; },
    };
    return new AuthClient({
      url: supabaseOrigin + '/auth/v1', headers: {apikey: publishableKey},
      flowType: 'pkce', persistSession: Boolean(storage), ...(storage && {storage, storageKey}),
      detectSessionInUrl: false, autoRefreshToken: false, skipAutoInitialize: true,
      fetch: (url, options) => {
        // A timed-out refresh may still be in the SDK's retry delay. Don't send it again.
        if (deadline?.aborted) return Promise.resolve(Response.json({message: 'Login request timed out'}, {status: 408}));
        return authFetch(url, {...options, redirect: 'error', credentials: 'omit', cache: 'no-store',
          signal: deadline ?? AbortSignal.timeout(tokenRequestTimeout)});
      },
    });
  }

  function sessionTokens({ data, error }) {
    if (error) throw new WebError([400, 401, 403].includes(error.status) ? 401 : 503, 'login_unavailable');
    const token = data?.session;
    if (typeof token?.access_token !== 'string' || !token.access_token ||
        typeof token.refresh_token !== 'string' || !token.refresh_token ||
        !Number.isFinite(token.expires_in) || token.expires_in <= 0 ||
        !Number.isFinite(token.expires_at) || token.expires_at <= 0) {
      throw new WebError(503, 'login_unavailable');
    }
    return { access: token.access_token, refresh: token.refresh_token, accessUntil: token.expires_at * 1000 };
  }

  async function refreshSession(refresh) {
    const deadline = AbortSignal.timeout(tokenRequestTimeout);
    const auth = authClient(deadline);
    let onTimeout;
    const timeout = new Promise((_, reject) => {
      onTimeout = () => reject(new WebError(503, 'login_unavailable'));
      deadline.addEventListener('abort', onTimeout, {once: true});
    });
    try {
      return sessionTokens(await Promise.race([auth.refreshSession({refresh_token: refresh}), timeout]));
    } finally {
      deadline.removeEventListener('abort', onTimeout);
    }
  }

  function verifiedExpiry(access) {
    const expiry = JSON.parse(Buffer.from(access.split('.')[1], 'base64url')).exp * 1000;
    if (!Number.isFinite(expiry) || expiry <= Date.now() + 15000) throw new WebError(401, 'login_required');
    return expiry;
  }

  function attachSession(req, res, access, identity, accessUntil, provider) {
    const previous = getSession(req);
    if (previous?.accountId === identity.accountId && previous.deadline >= accessUntil - 15000) return;
    if (authStorage && sessions.size >= 4096) prune();
    if (sessions.size >= 4096) throw new WebError(429, 'busy');
    const id = random(), deadline = accessUntil - 15000;
    sessions.delete(cookieValue(req, sessionName));
    sessions.set(id, {accountId: identity.accountId, provider, access, accessUntil, displaySession: random(), deadline});
    res.setHeader('Set-Cookie', cookie(sessionName, id, Math.floor((deadline - Date.now()) / 1000)));
  }

  return {
    stop() { clearInterval(purge); flows.clear(); sessions.clear(); links.clear(); },
    status(req) {
      const session = getSession(req);
      const continuation = session?.continuation;
      return { ...(continuation && { continuation }), signedIn: Boolean(session), ...(session && { displaySession: session.displaySession, ...(providers.has(session.provider) && { provider: session.provider }) }), providers: available };
    },
    confirmNative(req, res, access, identity, provider) {
      attachSession(req, res, access, identity, Math.min(verifiedExpiry(access), Date.now() + 8 * 60 * minute), provider);
    },
    accountLink(access, identity) {
      admit();
      if (authStorage) prune();
      if (links.size >= 1024) throw new WebError(429, 'busy');
      // The API verified this JWT before the link was issued. Its expiry also bounds the browser session.
      const accessUntil = Math.min(verifiedExpiry(access), Date.now() + 15 * minute);
      const ticket = random();
      links.set(ticket, {access, identity, accessUntil, deadline: Math.min(accessUntil, Date.now() + minute)});
      return {ticket, accountId: identity.accountId};
    },
    async consumeAccountLink(req, res, input, verifyIdentity) {
      const item = links.get(input?.ticket);
      if (!item || item.deadline <= Date.now()) throw new WebError(410, 'link_expired');
      const previous = getSession(req);
      if (!input.confirm) return {displayName: item.identity.displayName, accountId: item.identity.accountId,
        displaySession: previous?.displaySession ?? null};
      if (input.displaySession !== (previous?.displaySession ?? null)) throw new WebError(409, 'session_changed');
      if (authStorage && sessions.size >= 4096) prune();
      if (sessions.size >= 4096) throw new WebError(429, 'busy');
      const identity = await verifyIdentity(item.access);
      if (identity.accountId !== item.identity.accountId || links.get(input.ticket) !== item ||
          item.deadline <= Date.now() || getSession(req) !== previous) throw new WebError(409, 'session_changed');
      links.delete(input.ticket);
      attachSession(req, res, item.access, identity, item.accessUntil);
      return {accountId: identity.accountId};
    },
    consumeContinuation(req, path, nonce) {
      const session = getSession(req);
      if (!session || req.headers['x-vonvon-session'] !== session.displaySession) throw new WebError(409, 'session_changed');
      if (!detailPath.test(path) || session.continuation !== path || session.continuationNonce !== nonce) return { consumed: false };
      delete session.continuation;
      delete session.continuationNonce;
      sessions.save(cookieValue(req, sessionName), session);
      return { consumed: true };
    },
    async start(req, res, form) {
      const provider = form.get('provider');
      if (!available.includes(provider)) throw new WebError(400, 'provider_unavailable');
      admit();
      if (authStorage) prune();
      if (flows.size >= 1024) throw new WebError(429, 'busy');
      const key = random();
      flows.delete(cookieValue(req, flowName));
      const returnTo = returnPath(form.get('returnTo'));
      const backTo = returnPath(form.get('backTo') || returnTo);
      const continuationNonce = form.get('continuationNonce');
      const destinationPath = new URL(returnTo, publicOrigin).pathname;
      const continuation = form.get('continuation') === 'acquire' && detailPath.test(destinationPath) && /^[a-f0-9]{64}$/.test(continuationNonce || '') ? destinationPath : undefined;
      // Persist the SDK verifier slots with their one-time flow, never in the cookie.
      const sdkValues = Object.create(null);
      const auth = authClient(undefined, sdkValues, key);
      const flow = {sdkValues, provider, returnTo, backTo, continuation, continuationNonce: continuation ? continuationNonce : undefined, deadline: Date.now() + 10 * minute};
      flows.set(key, flow);
      try {
        const callbackUrl = publicOrigin + '/auth/callback';
        const {data, error} = await auth.signInWithOAuth({provider, options: {
          redirectTo: callbackUrl,
          skipBrowserRedirect: true,
          ...(['github', 'google'].includes(provider) && {queryParams: {prompt: 'select_account'}}),
        }});
        if (error || !data?.flowId || !validOAuthAuthorizeUrl(data.url, {provider, supabaseOrigin, callbackUrl}) || flows.get(key) !== flow) {
          throw new WebError(503, 'login_unavailable');
        }
        flow.sdkFlowId = data.flowId;
        flows.save(key, flow);
        res.writeHead(303, { Location: data.url, 'Set-Cookie': cookie(flowName, key, 600) });
        res.end();
      } catch (error) {
        flows.delete(key);
        throw error;
      }
    },
    async callback(req, res, url) {
      const key = cookieValue(req, flowName), flow = flows.get(key);
      const cookies = [];
      const consume = () => {
        if (flows.get(key) !== flow) return false;
        flows.delete(key); cookies.push(cookie(flowName, '', 0)); return true;
      };
      const result = oauthCallback(url);
      let location = '/login?' + new URLSearchParams({ returnTo: returnPath(flow?.returnTo), ...(flow?.backTo && flow.backTo !== flow.returnTo && {backTo: flow.backTo}), auth: 'failed' });
      if (flow?.deadline > Date.now() && !flow.exchanging && result.kind === 'code') {
        flow.exchanging = true;
        flows.save(key, flow);
        try {
          const auth = authClient(undefined, flow.sdkValues, key);
          const token = sessionTokens(await auth.exchangeCodeForSession(result.code, {flowId: flow.sdkFlowId}));
          if (authStorage && sessions.size >= 4096) prune();
          if (flow.deadline > Date.now() && consume() && sessions.size < 4096) {
            sessions.delete(cookieValue(req, sessionName));
            const id = random();
            sessions.set(id, { ...token, provider: flow.provider, continuation: flow.continuation, continuationNonce: flow.continuationNonce, displaySession: random(), deadline: Date.now() + 8 * 60 * minute });
            cookies.push(cookie(sessionName, id, 8 * 3600));
            location = flow.returnTo;
            if (verifyIdentity && !location.startsWith('/release-code/')) {
              try {
                const profile = await verifyIdentity(token.access, AbortSignal.timeout(9000));
                const session = sessions.get(id);
                if (session) {
                  session.accountId = profile.accountId;
                  sessions.save(id, session);
                }
                if (profile.revision === 0) {
                  location = '/account?' + new URLSearchParams({after: flow.returnTo});
                }
              } catch { /* The authenticated destination can retry a temporary profile outage. */ }
            }
          }
        } catch {} finally { consume(); }
      } else if (flow && !flow.exchanging) {
        if (flow.deadline > Date.now() && result.kind === 'cancelled') location = '/login?' + new URLSearchParams({returnTo: flow.returnTo, ...(flow.backTo !== flow.returnTo && {backTo: flow.backTo}), auth: 'cancelled'});
        consume();
      }
      const loginPage = location.startsWith('/login?');
      const websiteOrigin = (loginPage || location === '/account' || location.startsWith('/account?')) ? accountOrigin || '' : '';
      const fragment = accountOrigin && loginPage && flow?.continuationNonce ? '#acquire=' + flow.continuationNonce : '#';
      res.writeHead(303, { Location: websiteOrigin + location + fragment, ...(cookies.length && { 'Set-Cookie': cookies }) }); res.end();
    },
    async access(req, { write = false } = {}) {
      const session = getSession(req);
      if (!session) return null;
      if (write && req.headers['x-vonvon-session'] !== session.displaySession) throw new WebError(409, 'session_changed');
      if (session.accessUntil > Date.now() + 15_000) return session.access;
      if (!session.refresh) throw new WebError(401, 'login_required');
      if (!session.refreshing) {
        session.refreshing = refreshSession(session.refresh)
          .then(values => {
            if (getSession(req) !== session) throw new WebError(409, 'session_changed');
            Object.assign(session, values);
            sessions.save(cookieValue(req, sessionName), session);
            return session.access;
          })
          .catch(error => {
            if (error.status === 401 && getSession(req) === session) sessions.delete(cookieValue(req, sessionName));
            throw error;
          }).finally(() => { delete session.refreshing; });
      }
      const access = await session.refreshing;
      if (getSession(req) !== session) throw new WebError(409, 'session_changed');
      return access;
    },
    assertAccess(req, access, { write = false } = {}) {
      if (!access) return;
      const session = getSession(req);
      if (!session || session.access !== access || (write && req.headers['x-vonvon-session'] !== session.displaySession)) {
        throw new WebError(409, 'session_changed');
      }
    },
    logout(req, res, crossOrigin = false) {
      const expected = req.headers['x-vonvon-session'];
      if ((crossOrigin || expected !== undefined) && (!expected || expected !== getSession(req)?.displaySession)) {
        throw new WebError(409, 'session_changed');
      }
      sessions.delete(cookieValue(req, sessionName));
      flows.delete(cookieValue(req, flowName));
      res.writeHead(crossOrigin ? 204 : 303, {
        ...(!crossOrigin && { Location: '/' }),
        'Set-Cookie': [cookie(sessionName, '', 0), cookie(flowName, '', 0)],
      });
      res.end();
    },
  };
}
