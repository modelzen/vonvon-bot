import { httpServerHandler } from 'cloudflare:node';
import { DurableObject } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { createWebServer } from './web-server.mjs';

const assetRoot = 'https://worker-assets.invalid/recipe-web/public/';
const brokerPath = /^\/v2\/(?:objects\/[^/]+\/members\/\d+|(?:drafts|versions)\/[^/]+\/objects\/[^/]+|operations\/[^/]+\/objects\/[^/]+|versions\/[^/]+\/display-logo)$/;
const accountPages = new Set(['/account', '/login', '/auth/native', '/auth/native/complete']);

function legacyRedirect(response, url, accountOrigin) {
  const location = response.headers.get('Location');
  if (response.status !== 303 || !location) return response;
  let destination = new URL(location, url.origin);
  if (url.pathname === '/auth/callback' && destination.origin === url.origin) {
    // The completed session cookie belongs to the original host.
    const after = destination.pathname + destination.search;
    destination = new URL('/account', accountOrigin);
    destination.searchParams.set('after', after);
    destination.hash = '#';
  }
  if (destination.origin !== accountOrigin || !accountPages.has(destination.pathname)) return response;
  destination.searchParams.set('legacy', '1');
  const rewritten = new Response(response.body, response);
  rewritten.headers.set('Location', destination.href);
  rewritten.headers.set('Referrer-Policy', 'no-referrer');
  return rewritten;
}

function storageFor(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS auth_state (
    kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER,
    PRIMARY KEY (kind, key)
  )`);
  sql.exec('CREATE INDEX IF NOT EXISTS auth_state_expiry ON auth_state (expires_at)');
  return {
    get(kind, key) {
      const row = sql.exec('SELECT payload FROM auth_state WHERE kind = ? AND key = ?', kind, key).toArray()[0];
      return row ? JSON.parse(row.payload) : undefined;
    },
    set(kind, key, value, expiresAt) {
      sql.exec(`INSERT INTO auth_state (kind, key, payload, expires_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (kind, key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
      kind, key, JSON.stringify(value), expiresAt ?? null);
    },
    delete(kind, key) {
      sql.exec('DELETE FROM auth_state WHERE kind = ? AND key = ?', kind, key);
    },
    count(kind) {
      return sql.exec('SELECT count(*) AS count FROM auth_state WHERE kind = ?', kind).one().count;
    },
    prune(kind, now) {
      sql.exec('DELETE FROM auth_state WHERE kind = ? AND expires_at <= ?', kind, now);
    },
  };
}

async function checkedFetch(fetcher, url, options) {
  const response = await fetcher(url, {...options, redirect: 'manual'});
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error('unexpected_upstream_redirect');
  }
  return response;
}

function serviceFetch(service) {
  return (url, options) => {
    if (!service) return Response.json({error: {code: 'unavailable'}}, {status: 503});
    const { pathname, search } = new URL(url);
    return checkedFetch(service.fetch.bind(service), 'https://recipe-service.internal' + pathname + search, options);
  };
}

export class CommunityAuth extends DurableObject {
  #handler;

  constructor(ctx, env) {
    super(ctx, env);
    // Keep the original coordinator, including its receipt key and live tokens.
    const legacyOrigin = env.RECIPE_LEGACY_WEB_ORIGIN;
    const siteEnv = legacyOrigin && ctx.id.equals(env.COMMUNITY_AUTH.idFromName('site'))
      ? { ...env, RECIPE_WEB_ORIGIN: legacyOrigin } : env;
    const server = createWebServer(siteEnv, {
      authStorage: storageFor(ctx.storage.sql),
      readAsset: async (name, encoding) => {
        const response = await env.ASSETS.fetch(new Request(new URL(name, assetRoot), {redirect: 'manual'}));
        if (!response.ok) throw new Error('asset_unavailable');
        return encoding ? response.text() : Buffer.from(await response.arrayBuffer());
      },
      authFetch: (url, options) => checkedFetch(globalThis.fetch, url, options),
      apiFetch: serviceFetch(env.RECIPE_API),
      brokerFetch: serviceFetch(env.RECIPE_BROKER),
    });
    this.#handler = httpServerHandler(server);
  }

  async #scheduleCleanup() {
    const current = await this.ctx.storage.getAlarm();
    const next = this.ctx.storage.sql.exec('SELECT min(expires_at) AS next FROM auth_state').one().next;
    if (next !== null && (current === null || next < current)) {
      await this.ctx.storage.setAlarm(Math.max(Date.now(), next));
    }
  }

  async fetch(request) {
    const response = await this.#handler.fetch(request);
    await this.#scheduleCleanup();
    return response;
  }

  async alarm() {
    this.ctx.storage.sql.exec('DELETE FROM auth_state WHERE expires_at <= ?', Date.now());
    await this.#scheduleCleanup();
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const oldCommunity = url.origin === env.RECIPE_LEGACY_WEB_ORIGIN;
    const account = url.origin === env.RECIPE_ACCOUNT_ORIGIN;
    if (!oldCommunity && !account && url.origin !== env.RECIPE_WEB_ORIGIN) {
      return Response.json({error: {code: 'not_found'}}, {status: 404});
    }
    const headers = new Headers(request.headers);
    if (!account && /^\/v[12]\//.test(url.pathname)) {
      headers.delete('Cookie');
      headers.delete('Host');
      const target = brokerPath.test(url.pathname) ? env.RECIPE_BROKER : env.RECIPE_API;
      return serviceFetch(target)(url, {
        method: request.method,
        headers,
        body: request.body,
      });
    }
    const legacyAccount = account && accountPages.has(url.pathname) &&
      url.searchParams.getAll('legacy').length === 1 && url.searchParams.get('legacy') === '1';
    const appLogin = url.pathname === '/login' && url.searchParams.get('mode') === 'app';
    if (oldCommunity && ['GET', 'HEAD'].includes(request.method) &&
        url.pathname !== '/account' && !appLogin && !/^\/(?:auth|api)\//.test(url.pathname)) {
      return new Response(null, {
        status: 308,
        headers: { Location: env.RECIPE_WEB_ORIGIN + url.pathname + url.search, 'Cache-Control': 'no-store' },
      });
    }
    const isLegacy = oldCommunity || legacyAccount;
    const coordinator = env.RECIPE_LEGACY_WEB_ORIGIN && !isLegacy ? 'market' : 'site';
    headers.set('Host', url.host);
    const response = env.COMMUNITY_AUTH.getByName(coordinator).fetch(new Request(request, {
      headers, redirect: 'manual',
    }));
    return oldCommunity ? response.then(result => legacyRedirect(result, url, env.RECIPE_ACCOUNT_ORIGIN)) : response;
  },
};
