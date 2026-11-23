import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLoginAdmission, WebError } from './auth.mjs';
import {oauthCallback, oauthProviders, validOAuthAuthorizeUrl} from './oauth-provider.mjs';

const minute = 60_000;
const maxCodeBytes = 2048, ivBytes = 12, tagBytes = 16;
const maxReceiptChars = Math.ceil((ivBytes + 1 + maxCodeBytes + tagBytes) * 4 / 3);
const receiptScope = flow => Buffer.from('vonvon/native/callback-receipt/v1:' + flow.id + ':' + flow.expiresAt);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const flowRoute = /^\/auth\/native\/flows\/([A-Za-z0-9_-]{43})(?:\/(authorize|ack|identity))?$/;
const browserRoutes = new Set(['/auth/native/launch', '/auth/native/browser', '/auth/native/select', '/auth/native/complete', '/auth/native/cancel', '/auth/native/confirm', '/auth/native/switch']);
const nativeStatus = { issued: 'waiting', choosing: 'waiting', selected: 'provider', authorized: 'provider',
  ready: 'code', confirming: 'confirming', confirmed: 'confirmed', switching: 'switching', acknowledged: 'completed', cancelled: 'cancelled', expired: 'expired', failed: 'failed' };
const terminal = new Set(['acknowledged', 'cancelled', 'expired', 'failed', 'switching']);
const random = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest();
const canonicalToken = value => typeof value === 'string' && tokenPattern.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
const same = (value, expected) => typeof value === 'string' && expected && timingSafeEqual(digest(value), expected);

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function object(req, required, optional = [], limit = 4096) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) throw new WebError(415, 'invalid_body');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new WebError(413, 'too_large');
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

export function createNativeLogin({ publicOrigin, supabaseOrigin, publishableKey, providerNames, verifyIdentity, confirmWebSession, now = Date.now }) {
  const available = supabaseOrigin && /^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey || '')
    ? oauthProviders(providerNames) : [];
  const flows = new Map(), tickets = new Map(), browsers = new Map();
  const admit = createLoginAdmission({ now });
  const key = randomBytes(32);
  const secure = new URL(publicOrigin).protocol === 'https:';
  const cookieName = secure ? '__Host-vv-native' : 'vv-local-native';
  const cookie = value => cookieName + '=' + value + '; Max-Age=300; Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
  const browserKey = req => String(req.headers.cookie || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);

  function clearSecrets(flow) {
    tickets.delete(flow.ticket);
    delete flow.ticket; delete flow.webAccess;
    delete flow.authorizeUrl;
    delete flow.confirmedReceipt; delete flow.receiptDigest; delete flow.identity; delete flow.tokenDigest;
    flow.verifying?.controller.abort(); delete flow.verifying;
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
  }
  const purge = setInterval(prune, minute);
  purge.unref();

  function sealReceipt(outcome, flow) {
    const iv = randomBytes(ivBytes), cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: tagBytes });
    cipher.setAAD(receiptScope(flow));
    const payload = outcome.kind === 'code' ? Buffer.concat([Buffer.from([0]), Buffer.from(outcome.code, 'utf8')]) : Buffer.from([outcome.kind === 'cancelled' ? 1 : 2]);
    return Buffer.concat([iv, cipher.update(payload), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  }

  function openReceipt(receipt, flow) {
    if (typeof receipt !== 'string' || receipt.length > maxReceiptChars) throw new WebError(400, 'invalid_body');
    const bytes = Buffer.from(receipt, 'base64url');
    if (bytes.length <= ivBytes + tagBytes || bytes.toString('base64url') !== receipt) throw new WebError(400, 'invalid_body');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, ivBytes), { authTagLength: tagBytes });
    decipher.setAAD(receiptScope(flow)); decipher.setAuthTag(bytes.subarray(-tagBytes));
    try {
      const payload = Buffer.concat([decipher.update(bytes.subarray(ivBytes, -tagBytes)), decipher.final()]);
      if (payload[0] === 0 && payload.length > 1 && payload.length <= maxCodeBytes + 1) return {kind: 'code', code: payload.subarray(1).toString('utf8')};
      if (payload.length === 1 && [1, 2].includes(payload[0])) return {kind: payload[0] === 1 ? 'cancelled' : 'failed'};
      throw new Error('invalid_outcome');
    } catch { throw new WebError(401, 'invalid_receipt'); }
  }

  function view(flow) {
    expire(flow);
    return { status: nativeStatus[flow.status], state: flow.state, expiresAt: flow.expiresAt,
      ...(flow.provider && { provider: flow.provider }),
      ...(['confirming','confirmed'].includes(flow.status) && {identity:flow.identity}), ...(flow.status === 'ready' && { code: openReceipt(flow.confirmedReceipt, flow).code }) };
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
      ...(flow.status === 'acknowledged' && flow.firstProfile && {firstProfile:true}),
      ...(flow.provider && { provider: flow.provider }),
      ...(['confirming','confirmed'].includes(flow.status) && {identity:flow.identity}), ...(flow.status === 'authorized' && { authorizeUrl: flow.authorizeUrl }) };
  }

  function authorize(flow, value) {
    if (!validOAuthAuthorizeUrl(value, {provider: flow.provider, supabaseOrigin, callbackUrl: publicOrigin + '/auth/native/callback'})) {
      throw new WebError(400, 'invalid_authorize_url');
    }
    if (flow.authorizeUrl === value) return;
    live(flow);
    if (flow.status !== 'selected') throw new WebError(409, 'flow_conflict');
    flow.authorizeUrl = value; flow.status = 'authorized';
  }

  return {
    stop() { clearInterval(purge); for(const flow of flows.values()){flow.status='cancelled';clearSecrets(flow);} flows.clear(); tickets.clear(); browsers.clear(); key.fill(0); },
    async handle(req, res, url) {
      const route = flowRoute.exec(url.pathname), create = url.pathname === '/auth/native/flows';
      if (route || create) {
        if (req.headers.origin !== undefined || req.headers.cookie !== undefined) throw new WebError(403, 'invalid_native_request');
        if (url.search) throw new WebError(400, 'invalid_body');
        if (create && req.method === 'POST') {
          const data = await object(req, ['state'], ['pendingActionRef','confirmation']);
          if (data.confirmation !== 'identity-v1') throw new WebError(503, 'native_login_upgrade_required');
          if (!canonicalToken(data.state) || (data.pendingActionRef !== undefined &&
              (typeof data.pendingActionRef !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.pendingActionRef)))) {
            throw new WebError(400, 'invalid_state');
          }
          if (!available.length || typeof verifyIdentity !== 'function') throw new WebError(503, 'native_login_unavailable');
          admit(); prune();
          if (flows.size >= 1024) throw new WebError(429, 'busy');
          const id = random(), ticket = random(), pollToken = random(), ticketHash = digest(ticket).toString('hex');
          const flow = { id, state: data.state, status: 'issued', pollDigest: digest(pollToken), ticket: ticketHash, expiresAt: now() + 5 * minute };
          flows.set(id, flow); tickets.set(ticketHash, id);
          const loginPage = req.headers['x-vonvon-login-page'] === 'unified-v1' ? '/login?mode=app' : '/auth/native';
          json(res, { flowId: id, launchUrl: publicOrigin + loginPage + '#ticket=' + ticket, pollToken,
            expiresAt: flow.expiresAt, confirmation: 'identity-v1', supabaseUrl: supabaseOrigin, publishableKey }, 201);
          return true;
        }
        if (!route) throw new WebError(404, 'not_found');
        const flow = nativeFlow(req, route[1]), action = route[2];
        if (req.method === 'GET' && !action) { json(res, view(flow)); return true; }
        if (req.method === 'PUT' && action === 'authorize') {
          const data = await object(req, ['url']);
          authorize(flow, data.url); json(res, view(flow)); return true;
        }
        if (['PUT','POST'].includes(req.method) && action === 'identity') {
          const input = await object(req, ['accessToken','accountId'], [], 18000);
          if (typeof input.accessToken !== 'string' || !input.accessToken || input.accessToken.length > 16384 ||
              !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.accountId || '')) throw new WebError(400, 'invalid_identity');
          live(flow);
          const tokenDigest = digest(input.accessToken), accountId = input.accountId.toLowerCase();
          if (['confirming','confirmed'].includes(flow.status)) {
            if (!same(input.accessToken,flow.tokenDigest) || flow.identity.accountId !== accountId) throw new WebError(409,'flow_conflict');
            json(res,view(flow)); return true;
          }
          if (flow.status !== 'ready') throw new WebError(409,'flow_conflict');
          if (flow.verifying) {
            const pending = flow.verifying;
            if (!same(input.accessToken,pending.tokenDigest) || pending.accountId !== accountId) throw new WebError(409,'flow_conflict');
            await pending.promise; live(flow); json(res,view(flow)); return true;
          }
          const controller = new AbortController(), attempt = {controller,tokenDigest,accountId}; flow.verifying = attempt;
          attempt.promise = (async () => {
            let timer;
            try {
              const timeout = new Promise((_,reject) => {timer = setTimeout(() => {controller.abort(); reject(new WebError(503,'identity_unavailable'));},9000);timer.unref();});
              let verified;
              try {verified = await Promise.race([Promise.resolve().then(()=>verifyIdentity(input.accessToken,controller.signal)),timeout]);}
              catch (error) {
                live(flow);
                if (flow.status !== 'ready' || flow.verifying !== attempt) throw new WebError(409,'flow_conflict');
                if ([401,403].includes(error?.status)) {
                  flow.status = 'failed'; clearSecrets(flow);
                  throw new WebError(error.status,'identity_rejected');
                }
                throw new WebError(503,'identity_unavailable');
              }
              live(flow);
              if (flow.status !== 'ready' || flow.verifying !== attempt) throw new WebError(409,'flow_conflict');
              if (!verified || typeof verified.accountId !== 'string' || verified.accountId.toLowerCase() !== accountId ||
                  typeof verified.displayName !== 'string' || !verified.displayName.trim() || [...verified.displayName].length > 60 ||
                  /[\x00-\x1f\x7f-\x9f]/.test(verified.displayName)) throw new WebError(403,'identity_mismatch');
              const identity = {accountId,displayName:verified.displayName};
              if (typeof verified.avatarDataUrl === 'string' && verified.avatarDataUrl.length <= 174787 &&
                  /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(verified.avatarDataUrl)) identity.avatarDataUrl = verified.avatarDataUrl;
              flow.firstProfile = verified.revision === 0;
              if (confirmWebSession) flow.webAccess = input.accessToken;
              flow.identity = identity; flow.tokenDigest = tokenDigest; flow.status = 'confirming';
              delete flow.confirmedReceipt; delete flow.authorizeUrl;
            } finally {clearTimeout(timer);controller.abort();if(flow.verifying===attempt)delete flow.verifying;}
          })();
          await attempt.promise; live(flow); json(res,view(flow)); return true;
        }

        if (req.method === 'POST' && action === 'ack') {
          await object(req, []);
          if (flow.status !== 'acknowledged') {
            live(flow);
            if (flow.status !== 'confirmed') throw new WebError(409, 'flow_conflict');
            flow.status = 'acknowledged'; clearSecrets(flow);
          }
          json(res, view(flow)); return true;
        }
        if (req.method === 'DELETE' && !action) {
          if (!terminal.has(flow.status)) { flow.status = 'cancelled'; clearSecrets(flow); }
          json(res, view(flow)); return true;
        }
        throw new WebError(404, 'not_found');
      }
      if (req.method === 'GET' && url.pathname === '/auth/native/callback') {
        const flow = flows.get(browsers.get(browserKey(req)));
        const result = oauthCallback(url);
        let location = '/login?mode=app&complete=1#';
        if (flow?.status === 'authorized' && flow.expiresAt > now()) {
          if (result.kind === 'code' || url.searchParams.has('error')) location = '/login?mode=app#receipt=' + sealReceipt(result, flow);
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
        const { receipt } = await object(req, ['receipt']);
        if (expire(flow).status === 'authorized') {
          const outcome = openReceipt(receipt, flow);
          if (outcome.kind === 'code') {
            flow.confirmedReceipt = receipt; flow.receiptDigest = digest(receipt); flow.status = 'ready';
          } else {
            flow.status = outcome.kind; clearSecrets(flow); flow.terminalReceiptDigest = digest(receipt);
          }
        } else if (!(['ready','confirming','confirmed'].includes(flow.status) && same(receipt,flow.receiptDigest)) &&
            !(['cancelled','failed'].includes(flow.status) && same(receipt,flow.terminalReceiptDigest))) throw new WebError(401, 'invalid_receipt');
        json(res, browserView(flow)); return true;
      }
      if (url.pathname === '/auth/native/confirm' && req.method === 'POST') {
        await object(req, []); live(flow);
        if (!['confirming','confirmed'].includes(flow.status)) throw new WebError(409,'flow_conflict');
        if (flow.status === 'confirming' && flow.webAccess) {
          confirmWebSession(req, res, flow.webAccess, flow.identity, flow.provider);
          delete flow.webAccess;
        }
        flow.status = 'confirmed'; json(res,browserView(flow)); return true;
      }
      if (url.pathname === '/auth/native/switch' && req.method === 'POST') {
        await object(req, []); live(flow);
        if (flow.status !== 'confirming') throw new WebError(409,'flow_conflict');
        flow.status = 'switching'; clearSecrets(flow); json(res,browserView(flow)); return true;
      }
      if (url.pathname === '/auth/native/cancel' && req.method === 'POST') {
        await object(req, []);
        expire(flow);
        if (['confirmed','acknowledged'].includes(flow.status)) throw new WebError(409,'flow_conflict');
        if (!terminal.has(flow.status)) { flow.status = 'cancelled'; clearSecrets(flow); }
        json(res, browserView(flow)); return true;
      }
      throw new WebError(404, 'not_found');
    },
  };
}
