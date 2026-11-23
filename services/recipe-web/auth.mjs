import { createHash, randomBytes } from 'node:crypto';

const minute = 60_000;
const providers = new Set(['github', 'google', 'apple']);
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const detailPath = new RegExp('^/recipes/' + uuid + '/versions/' + uuid + '$', 'i');

export function returnPath(value) {
  if (['/library', '/publications', '/studio', '/account'].includes(value) || (typeof value === 'string' && (detailPath.test(value) || /^\/release-code\/confirm\/[A-Za-z0-9_-]{8,128}$/.test(value) || /^\/authors\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)))) return value;
  return '/';
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

export function createLogin({ publicOrigin, supabaseOrigin, publishableKey, providerNames }) {
  const available = supabaseOrigin && publishableKey ? providerNames.filter(p => providers.has(p)) : [];
  const flows = new Map(), sessions = new Map();
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
  const purge = setInterval(() => {
    for (const map of [flows, sessions]) {
      for (const [key, value] of map) if (value.deadline <= Date.now()) map.delete(key);
    }
  }, minute);
  purge.unref();

  async function tokenRequest(grant, data) {
    const response = await fetch(supabaseOrigin + '/auth/v1/token?grant_type=' + grant, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(9000),
      headers: { 'Content-Type': 'application/json', apikey: publishableKey },
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new WebError([400, 401, 403].includes(response.status) ? 401 : 503, 'login_unavailable');
    const token = await response.json();
    if (typeof token.access_token !== 'string' || !token.access_token ||
        typeof token.refresh_token !== 'string' || !token.refresh_token ||
        !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
      throw new WebError(503, 'login_unavailable');
    }
    return { access: token.access_token, refresh: token.refresh_token,
      accessUntil: Date.now() + token.expires_in * 1000 };
  }

  return {
    stop() { clearInterval(purge); flows.clear(); sessions.clear(); },
    status(req) {
      const session = getSession(req);
      const continuation = session?.continuation;
      return { ...(continuation && { continuation }), signedIn: Boolean(session), ...(session && { displaySession: session.displaySession }), providers: available };
    },
    consumeContinuation(req, path, nonce) {
      const session = getSession(req);
      if (!session || req.headers['x-vonvon-session'] !== session.displaySession) throw new WebError(409, 'session_changed');
      if (!detailPath.test(path) || session.continuation !== path || session.continuationNonce !== nonce) return { consumed: false };
      delete session.continuation;
      delete session.continuationNonce;
      return { consumed: true };
    },
    start(req, res, form) {
      const provider = form.get('provider');
      if (!available.includes(provider)) throw new WebError(400, 'provider_unavailable');
      admit();
      if (flows.size >= 1024) throw new WebError(429, 'busy');
      const key = random(), verifier = random();
      flows.delete(cookieValue(req, flowName));
      const returnTo = returnPath(form.get('returnTo'));
      const continuationNonce = form.get('continuationNonce');
      const continuation = form.get('continuation') === 'acquire' && detailPath.test(returnTo) && /^[a-f0-9]{64}$/.test(continuationNonce || '') ? returnTo : undefined;
      flows.set(key, { verifier, returnTo, continuation, continuationNonce: continuation ? continuationNonce : undefined, deadline: Date.now() + 10 * minute });
      const authorize = new URL('/auth/v1/authorize', supabaseOrigin);
      authorize.searchParams.set('provider', provider);
      if (['github', 'google'].includes(provider)) authorize.searchParams.set('prompt', 'select_account');
      authorize.searchParams.set('redirect_to', publicOrigin + '/auth/callback');
      authorize.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      authorize.searchParams.set('code_challenge_method', 's256');
      res.writeHead(303, { Location: authorize.href, 'Set-Cookie': cookie(flowName, key, 600) });
      res.end();
    },
    async callback(req, res, url) {
      const key = cookieValue(req, flowName), flow = flows.get(key);
      const cookies = [];
      const consume = () => {
        if (flows.get(key) !== flow) return false;
        flows.delete(key); cookies.push(cookie(flowName, '', 0)); return true;
      };
      const code = url.searchParams.get('code');
      let location = (flow?.returnTo || '/') + '?auth=failed';
      if (flow?.deadline > Date.now() && !flow.exchanging && code && code.length <= 2048 && !url.searchParams.has('error')) {
        flow.exchanging = true;
        try {
          const token = await tokenRequest('pkce', { auth_code: code, code_verifier: flow.verifier });
          if (flow.deadline > Date.now() && consume() && sessions.size < 4096) {
            sessions.delete(cookieValue(req, sessionName));
            const id = random();
            sessions.set(id, { ...token, continuation: flow.continuation, continuationNonce: flow.continuationNonce, displaySession: random(), deadline: Date.now() + 8 * 60 * minute });
            cookies.push(cookie(sessionName, id, 8 * 3600));
            location = flow.returnTo;
          }
        } catch {} finally { consume(); }
      } else if (flow && !flow.exchanging) consume();
      res.writeHead(303, { Location: location, ...(cookies.length && { 'Set-Cookie': cookies }) }); res.end();
    },
    async access(req, { write = false } = {}) {
      const session = getSession(req);
      if (!session) return null;
      if (write && req.headers['x-vonvon-session'] !== session.displaySession) throw new WebError(409, 'session_changed');
      if (session.accessUntil > Date.now() + 15_000) return session.access;
      if (!session.refreshing) {
        session.refreshing = tokenRequest('refresh_token', { refresh_token: session.refresh })
          .then(values => {
            if (getSession(req) !== session) throw new WebError(409, 'session_changed');
            Object.assign(session, values); return session.access;
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
    logout(req, res) {
      const expected = req.headers['x-vonvon-session'];
      if (expected !== undefined && expected !== getSession(req)?.displaySession) throw new WebError(409, 'session_changed');
      sessions.delete(cookieValue(req, sessionName));
      flows.delete(cookieValue(req, flowName));
      res.writeHead(303, { Location: '/', 'Set-Cookie': [cookie(sessionName, '', 0), cookie(flowName, '', 0)] }); res.end();
    },
  };
}
