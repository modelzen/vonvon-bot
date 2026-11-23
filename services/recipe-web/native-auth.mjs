import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLoginAdmission, WebError } from './auth.mjs';

const minute = 60_000;
const providerSet = new Set(['github', 'google', 'apple']);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const flowRoute = /^\/auth\/native\/flows\/([A-Za-z0-9_-]{43})(?:\/(authorize|ack))?$/;
const browserRoutes = new Set(['/auth/native/launch', '/auth/native/browser', '/auth/native/select', '/auth/native/complete', '/auth/native/cancel']);
const nativeStatus = { issued: 'waiting', choosing: 'waiting', selected: 'provider', authorized: 'provider',
  ready: 'code', acknowledged: 'completed', cancelled: 'cancelled', expired: 'expired', failed: 'failed' };
const terminal = new Set(['acknowledged', 'cancelled', 'expired', 'failed']);
const random = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest();
const canonicalToken = value => typeof value === 'string' && tokenPattern.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
const same = (value, expected) => typeof value === 'string' && expected && timingSafeEqual(digest(value), expected);

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function object(req, required, optional = []) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) throw new WebError(415, 'invalid_body');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new WebError(413, 'too_large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new WebError(400, 'invalid_body'); }
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) {
    throw new WebError(400, 'invalid_body');
  }
  return value;
}

export function createNativeLogin({ publicOrigin, supabaseOrigin, publishableKey, providerNames, now = Date.now }) {
  const available = supabaseOrigin && /^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey || '')
    ? [...new Set(providerNames.filter(provider => providerSet.has(provider)))] : [];
  const flows = new Map(), tickets = new Map(), browsers = new Map(), receipts = new Map();
  const admit = createLoginAdmission({ now });
  const key = randomBytes(32);
  const secure = new URL(publicOrigin).protocol === 'https:';
  const cookieName = secure ? '__Host-vv-native' : 'vv-local-native';
  const cookie = value => cookieName + '=' + value + '; Max-Age=300; Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
  const browserKey = req => String(req.headers.cookie || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);

  function clearSecrets(flow) {
    tickets.delete(flow.ticket);
    delete flow.ticket;
    delete flow.authorizeUrl;
    delete flow.code;
    delete flow.receiptCount;
    for (const [id, receipt] of receipts) if (receipt.flowId === flow.id) receipts.delete(id);
  }

  function expire(flow) {
    if (flow.expiresAt <= now() && !terminal.has(flow.status)) {
      flow.status = 'expired'; clearSecrets(flow);
    }
    return flow;
  }

  function prune() {
    for (const [id, flow] of flows) {
      expire(flow);
      if (flow.expiresAt + 5 * minute <= now()) {
        clearSecrets(flow); browsers.delete(flow.browser); flows.delete(id);
      }
    }
    for (const [id, receipt] of receipts) if (receipt.expiresAt <= now()) receipts.delete(id);
  }
  const purge = setInterval(prune, minute);
  purge.unref();

  function seal(code, flowId) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(flowId));
    return { iv, bytes: Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]), tag: cipher.getAuthTag() };
  }

  function unseal(code, flowId) {
    const decipher = createDecipheriv('aes-256-gcm', key, code.iv);
    decipher.setAAD(Buffer.from(flowId)); decipher.setAuthTag(code.tag);
    return Buffer.concat([decipher.update(code.bytes), decipher.final()]).toString('utf8');
  }

  function view(flow) {
    expire(flow);
    return { status: nativeStatus[flow.status], state: flow.state, expiresAt: flow.expiresAt,
      ...(flow.provider && { provider: flow.provider }), ...(flow.status === 'ready' && { code: unseal(flow.code, flow.id) }) };
  }

  function live(flow) {
    expire(flow);
    if (flow.status === 'expired') throw new WebError(410, 'flow_expired');
    if (terminal.has(flow.status)) throw new WebError(409, 'flow_conflict');
  }

  function nativeFlow(req, id) {
    const flow = flows.get(id);
    if (!flow) throw new WebError(404, 'flow_not_found');
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    if (!same(token, flow.pollDigest)) throw new WebError(401, 'invalid_poll_token');
    return expire(flow);
  }

  function browserFlow(req, binding = req.headers['x-vonvon-native-tab']) {
    const browser = browserKey(req), flow = flows.get(browsers.get(browser));
    if (!flow || !same(browser, flow.browserDigest) || !canonicalToken(binding) || !same(binding, flow.tabDigest)) {
      throw new WebError(401, 'invalid_browser_flow');
    }
    return expire(flow);
  }

  function browserView(flow) {
    return { status: flow.status, providers: available, expiresAt: flow.expiresAt,
      ...(flow.provider && { provider: flow.provider }), ...(flow.status === 'authorized' && { authorizeUrl: flow.authorizeUrl }) };
  }

  function authorize(flow, value) {
    if (typeof value !== 'string' || value.length > 2048) throw new WebError(400, 'invalid_authorize_url');
    let url;
    try { url = new URL(value); } catch { throw new WebError(400, 'invalid_authorize_url'); }
    const params = url.searchParams, expected = ['provider', 'redirect_to', 'code_challenge', 'code_challenge_method'];
    if (url.origin !== supabaseOrigin || url.pathname !== '/auth/v1/authorize' || url.username || url.password || url.hash ||
        [...params].length !== 4 || expected.some(name => params.getAll(name).length !== 1) ||
        params.get('provider') !== flow.provider || params.get('redirect_to') !== publicOrigin + '/auth/native/callback' ||
        !canonicalToken(params.get('code_challenge')) || !['s256', 'S256'].includes(params.get('code_challenge_method'))) {
      throw new WebError(400, 'invalid_authorize_url');
    }
    if (flow.authorizeUrl === value) return;
    live(flow);
    if (flow.status !== 'selected') throw new WebError(409, 'flow_conflict');
    flow.authorizeUrl = value; flow.status = 'authorized';
  }

  return {
    stop() { clearInterval(purge); flows.clear(); tickets.clear(); browsers.clear(); receipts.clear(); key.fill(0); },
    async handle(req, res, url) {
      const route = flowRoute.exec(url.pathname), create = url.pathname === '/auth/native/flows';
      if (route || create) {
        if (req.headers.origin !== undefined || req.headers.cookie !== undefined) throw new WebError(403, 'invalid_native_request');
        if (url.search) throw new WebError(400, 'invalid_body');
        if (create && req.method === 'POST') {
          const data = await object(req, ['state'], ['pendingActionRef']);
          if (!canonicalToken(data.state) || (data.pendingActionRef !== undefined &&
              (typeof data.pendingActionRef !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.pendingActionRef)))) {
            throw new WebError(400, 'invalid_state');
          }
          if (!available.length) throw new WebError(503, 'native_login_unavailable');
          admit(); prune();
          if (flows.size >= 1024) throw new WebError(429, 'busy');
          const id = random(), ticket = random(), pollToken = random(), ticketHash = digest(ticket).toString('hex');
          const flow = { id, state: data.state, status: 'issued', pollDigest: digest(pollToken), ticket: ticketHash, expiresAt: now() + 5 * minute };
          flows.set(id, flow); tickets.set(ticketHash, id);
          json(res, { flowId: id, launchUrl: publicOrigin + '/auth/native#ticket=' + ticket, pollToken,
            expiresAt: flow.expiresAt, supabaseUrl: supabaseOrigin, publishableKey }, 201);
          return true;
        }
        if (!route) throw new WebError(404, 'not_found');
        const flow = nativeFlow(req, route[1]), action = route[2];
        if (req.method === 'GET' && !action) { json(res, view(flow)); return true; }
        if (req.method === 'PUT' && action === 'authorize') {
          const data = await object(req, ['url']);
          authorize(flow, data.url); json(res, view(flow)); return true;
        }
        if (req.method === 'POST' && action === 'ack') {
          await object(req, []);
          if (flow.status !== 'acknowledged') {
            live(flow);
            if (flow.status !== 'ready') throw new WebError(409, 'flow_conflict');
            flow.status = 'acknowledged'; clearSecrets(flow);
          }
          json(res, view(flow)); return true;
        }
        if (req.method === 'DELETE' && !action) {
          if (flow.status !== 'expired') { flow.status = 'cancelled'; clearSecrets(flow); }
          json(res, view(flow)); return true;
        }
        throw new WebError(404, 'not_found');
      }
      if (req.method === 'GET' && url.pathname === '/auth/native/callback') {
        const flow = flows.get(browsers.get(browserKey(req)));
        const code = url.searchParams.get('code');
        let location = '/auth/native/complete';
        if (flow && expire(flow).status === 'authorized' && url.searchParams.size === 1 &&
            url.searchParams.getAll('code').length === 1 && code && code.length <= 2048 &&
            (flow.receiptCount || 0) < 4 && receipts.size < 2048) {
          const receipt = random();
          flow.receiptCount = (flow.receiptCount || 0) + 1;
          receipts.set(digest(receipt).toString('hex'), { flowId: flow.id, code: seal(code, flow.id), expiresAt: flow.expiresAt });
          location += '#receipt=' + receipt;
        }
        res.writeHead(303, { Location: location }); res.end(); return true;
      }
      if (!browserRoutes.has(url.pathname) || req.method === 'GET' && url.pathname === '/auth/native/complete') return false;
      if (req.method === 'POST' && req.headers.origin !== publicOrigin) throw new WebError(403, 'invalid_origin');
      if (url.pathname === '/auth/native/launch' && req.method === 'POST') {
        const data = await object(req, ['ticket', 'binding']);
        if (!canonicalToken(data.ticket) || !canonicalToken(data.binding)) throw new WebError(400, 'invalid_body');
        const hash = digest(data.ticket).toString('hex'), flow = flows.get(tickets.get(hash));
        if (!flow) throw new WebError(401, 'invalid_launch_ticket');
        live(flow);
        if (flow.status !== 'issued') throw new WebError(409, 'flow_conflict');
        tickets.delete(hash); delete flow.ticket;
        const browser = random();
        flow.browser = browser; flow.browserDigest = digest(browser); flow.tabDigest = digest(data.binding); flow.status = 'choosing';
        browsers.set(browser, flow.id); res.setHeader('Set-Cookie', cookie(browser));
        json(res, browserView(flow)); return true;
      }
      const flow = browserFlow(req);
      if (url.pathname === '/auth/native/browser' && req.method === 'GET') { json(res, browserView(flow)); return true; }
      if (url.pathname === '/auth/native/select' && req.method === 'POST') {
        const data = await object(req, ['provider']);
        live(flow);
        if (!available.includes(data.provider)) throw new WebError(400, 'provider_unavailable');
        if (flow.provider && flow.provider !== data.provider) throw new WebError(409, 'flow_conflict');
        if (flow.status === 'choosing') { flow.provider = data.provider; flow.status = 'selected'; }
        json(res, browserView(flow)); return true;
      }
      if (url.pathname === '/auth/native/complete' && req.method === 'POST') {
        const data = await object(req, ['receipt']);
        if (!canonicalToken(data.receipt)) throw new WebError(400, 'invalid_body');
        const receipt = receipts.get(digest(data.receipt).toString('hex'));
        if (!receipt || receipt.flowId !== flow.id || receipt.expiresAt <= now()) throw new WebError(401, 'invalid_receipt');
        if (flow.status === 'authorized') {
          flow.code = receipt.code; delete receipt.code; receipt.confirmed = true; flow.status = 'ready';
        } else if (!receipt.confirmed || flow.status !== 'ready') throw new WebError(409, 'flow_conflict');
        json(res, browserView(flow)); return true;
      }
      if (url.pathname === '/auth/native/cancel' && req.method === 'POST') {
        await object(req, []);
        if (!terminal.has(flow.status)) { flow.status = 'cancelled'; clearSecrets(flow); }
        json(res, browserView(flow)); return true;
      }
      throw new WebError(404, 'not_found');
    },
  };
}
