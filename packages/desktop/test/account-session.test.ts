import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountDeployment, type AccountCredential } from '../src/account-auth.js';
import { createAccountSession, type NativeAccount } from '../src/account-session.js';
import { accountStore, type AccountStore } from '../src/account-store.js';

const web = 'https://community.example', api = 'https://api.example', issuer = 'https://identity.example';
const deployment = accountDeployment(web, api, false)!;
const subject = randomUUID(), business = randomUUID();
const provider = 'github';
const user = {
  id: subject, is_anonymous: false,
  app_metadata: { provider: 'google' },
  identities: [{ provider, user_id: subject }],
  user_metadata: { full_name: 'Example User', avatar_url: 'https://avatars.example/user.png', email: 'private@example.com' },
};
const access = 'access-test-value', refresh = 'refresh-test-value', code = 'one-use-code';
const random = () => randomBytes(32).toString('base64url');
const sessionReply = (rotated = false) => ({
  user, token_type: 'bearer', access_token: access, refresh_token: rotated ? 'rotated-refresh-token' : refresh, expires_in: 3600,
});
const sessions = new Set<NativeAccount>();
afterEach(async () => { for (const session of sessions) await session.dispose(); sessions.clear(); });

function memoryStore() {
  let record: AccountCredential | undefined;
  return {
    read: vi.fn(async () => record),
    save: vi.fn(async (value: AccountCredential) => { record = value; return 'secure' as const; }),
    clear: vi.fn(async () => { record = undefined; }),
  };
}

function fixture() {
  const ticket = random(), flowId = random(), pollToken = random();
  const issued = { flowId, pollToken, launchUrl: web + '/auth/native#ticket=' + ticket, expiresAt: Date.now() + 260_000,
    supabaseUrl: issuer, publishableKey: 'sb_publishable_demo' };
  const base = web + '/auth/native/flows';
  let state = '', challenge = '';
  const poll = vi.fn(async () => Response.json({ state, expiresAt: issued.expiresAt, provider,
    ...(challenge ? { status: 'code', code } : { status: 'provider' }) }));
  const exchange = vi.fn(async (body: Record<string, string>) => {
    expect(body.auth_code).toBe(code);
    expect(createHash('sha256').update(body.code_verifier!).digest('base64url')).toBe(challenge);
    return Response.json(sessionReply());
  });
  const authorize = vi.fn(async (url: URL) => {
    expect(url.origin + url.pathname).toBe(issuer + '/auth/v1/authorize');
    expect([...url.searchParams.keys()].sort()).toEqual(['code_challenge', 'code_challenge_method', 'provider', 'redirect_to']);
    expect(url.searchParams.get('provider')).toBe(provider);
    expect(url.searchParams.get('redirect_to')).toBe(web + '/auth/native/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
    challenge = url.searchParams.get('code_challenge')!;
    return Response.json({});
  });
  const verifyUser = vi.fn(async () => Response.json(user));
  const me = vi.fn(async () => Response.json({ accountId: business }));
  const rotate = vi.fn(async () => Response.json(sessionReply(true)));
  const ack = vi.fn(async () => Response.json({ status: 'completed' }));
  const cancel = vi.fn(async () => Response.json({ status: 'cancelled' }));
  const transport = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect(headers.has('Cookie') || headers.has('Origin')).toBe(false);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.href === base) { state = body.state; challenge = ''; return Response.json(issued, { status: 201 }); }
    if (url.href.startsWith(base + '/' + flowId)) {
      expect(headers.get('Authorization')).toBe('Bearer ' + pollToken);
      if (url.pathname.endsWith('/authorize')) return authorize(new URL(body.url));
      if (url.pathname.endsWith('/ack')) return ack();
      if (init.method === 'DELETE') return cancel();
      return poll();
    }
    if (url.origin === issuer) {
      expect(headers.get('apikey')).toBe(issued.publishableKey);
      if (url.pathname === '/auth/v1/user') { expect(headers.get('Authorization')).toBe('Bearer ' + access); return verifyUser(); }
      if (url.searchParams.get('grant_type') === 'refresh_token') return rotate();
      if (url.searchParams.get('grant_type') === 'pkce') return exchange(body);
    }
    if (url.origin === api && url.pathname.startsWith('/v1/')) {
      expect(headers.get('Authorization')).toBe('Bearer ' + access);
      return url.pathname === '/v1/me' ? me() : Response.json({ items: [] });
    }
    throw new Error('Unexpected fixture request');
  });
  const openBrowser = vi.fn(async (_url: string) => {});
  const store = memoryStore();
  function create(records: AccountStore = store) {
    const session = createAccountSession({ deployment, store: records, transport, openBrowser, pollMs: 2 });
    sessions.add(session);
    return session;
  }
  return { create, store, transport, issued, openBrowser, poll, ack, cancel, rotate, authorize, exchange, verifyUser, me };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const waitFor = (assertion: () => void) => vi.waitFor(assertion, { interval: 5, timeout: 2500 });

describe('native desktop account', () => {
  it('uses one SDK verifier, validates linked identity and reads the mapped business account before acknowledging', async () => {
    const f = fixture();
    f.authorize.mockRejectedValueOnce(new TypeError('lost response'));
    f.poll.mockRejectedValueOnce(new TypeError('disconnected'));
    f.ack.mockRejectedValueOnce(new TypeError('lost ack'));
    const a = f.create();
    const statuses: unknown[] = [];
    a.onStatus(value => statuses.push(value));
    expect((await Promise.all([a.login(), a.login()])).map(s => s.kind)).toEqual(['signingIn', 'signingIn']);
    await waitFor(() => expect(f.ack).toHaveBeenCalledTimes(2));
    expect(a.status()).toEqual({ kind: 'signedIn', accountId: business, displayName: 'Example User',
      avatarUrl: user.user_metadata.avatar_url, provider, persistence: 'secure' });
    expect(f.authorize.mock.calls.map(args => args[0].href)[0]).toBe(f.authorize.mock.calls[1]![0].href);
    expect(f.openBrowser).toHaveBeenCalledExactlyOnceWith(f.issued.launchUrl);
    expect(f.exchange).toHaveBeenCalledTimes(1);
    expect(f.store.save.mock.invocationCallOrder[0]).toBeLessThan(f.ack.mock.invocationCallOrder[0]!);
    const credential = await f.store.read();
    expect(credential).toMatchObject({ accountId: business, subject, provider, refreshToken: refresh });
    expect(JSON.stringify(credential)).not.toContain(access);
    for (const value of [subject, access, refresh, code, f.issued.pollToken, f.issued.launchUrl, user.user_metadata.email]) {
      expect(JSON.stringify(statuses)).not.toContain(value);
    }
    expect(await (await a.request(business, '/v1/me/recipes')).json()).toEqual({ items: [] });
    await expect(a.request(subject, '/v1/me/recipes')).rejects.toThrow();
    await expect(a.request(business, '/v1/../../untrusted')).rejects.toThrow();
    await a.dispose();
    const b = f.create();
    await waitFor(() => expect(b.status()).toMatchObject({ kind: 'signedIn', accountId: business }));
    expect(f.rotate).toHaveBeenCalledTimes(1);
    expect((await f.store.read())?.refreshToken).toBe('rotated-refresh-token');
    await b.logout();
    expect(await f.store.read()).toBeUndefined();
  });

  it.each(['mixed state', 'unknown exchange', 'untrusted identity', 'disabled account', 'offline API'] as const)(
    'keeps credentials private and does not acknowledge %s', async failure => {
      const f = fixture();
      if (failure === 'mixed state') f.poll.mockResolvedValue(Response.json({ state: random(), status: 'code', code, provider, expiresAt: f.issued.expiresAt }));
      if (failure === 'unknown exchange') f.exchange.mockRejectedValue(new TypeError('unknown result'));
      if (failure === 'untrusted identity') f.verifyUser.mockResolvedValue(Response.json({ ...user, id: randomUUID() }));
      if (failure === 'disabled account') f.me.mockResolvedValue(Response.json({ code: 'account_disabled' }, { status: 403 }));
      if (failure === 'offline API') f.me.mockResolvedValue(Response.json({}, { status: 503 }));
      const a = f.create();
      await a.login();
      await waitFor(() => expect(a.status().kind).toBe(failure === 'offline API' ? 'unavailable' : 'signedOut'));
      expect(f.store.save).not.toHaveBeenCalled();
      expect(f.ack).not.toHaveBeenCalled();
      expect(f.exchange.mock.calls.length).toBeLessThanOrEqual(1);
      expect(f.cancel).toHaveBeenCalledTimes(1);
    });

  it('refuses cross-origin browser launch, insecure deployments and a forged path', async () => {
    expect(accountDeployment('http://127.0.0.1:12000', api, false)).toBeUndefined();
    expect(accountDeployment('http://127.0.0.1:12000', api, true)?.webOrigin).toBe('http://127.0.0.1:12000');
    expect(accountDeployment('https://user@host.example', api, false)).toBeUndefined();
    const f = fixture();
    f.issued.launchUrl = f.issued.launchUrl.replace(web, web + '.evil.example');
    const a = f.create();
    await a.login();
    await waitFor(() => expect(a.status()).toEqual({ kind: 'signedOut', reason: 'failed' }));
    expect(f.openBrowser).not.toHaveBeenCalled();
  });

  it('cancels during exchange and discards the late reply', async () => {
    const f = fixture();
    const held = deferred<Response>();
    f.exchange.mockReturnValueOnce(held.promise);
    const a = f.create();
    await a.login();
    await waitFor(() => expect(f.exchange).toHaveBeenCalledOnce());
    expect(await a.cancelLogin()).toEqual({ kind: 'signedOut', reason: 'cancelled' });
    held.resolve(Response.json(sessionReply()));
    await waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    expect(f.store.save).not.toHaveBeenCalled();
    expect(f.ack).not.toHaveBeenCalled();
  });

  it('discards a refresh after logout and does not overwrite the signed-out file', async () => {
    const f = fixture();
    const a = f.create();
    await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    await a.dispose();
    const held = deferred<Response>();
    f.rotate.mockReturnValueOnce(held.promise);
    const b = f.create();
    await waitFor(() => expect(f.rotate).toHaveBeenCalledOnce());
    expect(await b.logout()).toEqual({ kind: 'signedOut' });
    held.resolve(Response.json(sessionReply(true)));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await f.store.read()).toBeUndefined();
    expect(f.store.save).toHaveBeenCalledTimes(1);
    expect(b.status()).toEqual({ kind: 'signedOut' });
  });

  it('refreshes with the rotated credential after a temporary API outage', async () => {
    const f = fixture();
    const a = f.create();
    await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    await a.dispose();
    f.me.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    const b = f.create();
    await waitFor(() => expect(b.status()).toEqual({ kind: 'unavailable', reason: 'offline' }));
    expect((await f.store.read())?.refreshToken).toBe('rotated-refresh-token');
    expect(await b.login()).toMatchObject({ kind: 'signedIn', accountId: business });
    expect(f.openBrowser).toHaveBeenCalledTimes(1);
  });

  it('serializes logout after an in-flight save and never acknowledges that login', async () => {
    const f = fixture();
    const held = deferred<'secure'>();
    f.store.save.mockReturnValueOnce(held.promise);
    const a = f.create();
    await a.login();
    await waitFor(() => expect(f.store.save).toHaveBeenCalledOnce());
    const logout = a.logout();
    held.resolve('secure');
    expect(await logout).toEqual({ kind: 'signedOut' });
    await waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    expect(await f.store.read()).toBeUndefined();
    expect(f.ack).not.toHaveBeenCalled();
  });

  it('reports a storage error when old credentials cannot be cleared', async () => {
    const f = fixture();
    f.store.clear.mockRejectedValue(new Error('file unavailable'));
    const a = f.create();
    await a.login();
    await waitFor(() => expect(a.status()).toEqual({ kind: 'unavailable', reason: 'storage' }));
    expect(f.openBrowser).not.toHaveBeenCalled();
    expect(f.ack).not.toHaveBeenCalled();
    expect(await a.logout()).toEqual({ kind: 'unavailable', reason: 'storage' });
  });

  it('rejects an expired flow before opening the browser', async () => {
    const f = fixture();
    f.issued.expiresAt = Date.now() - 10;
    const a = f.create();
    await a.login();
    await waitFor(() => expect(a.status()).toEqual({ kind: 'signedOut', reason: 'expired' }));
    expect(f.openBrowser).not.toHaveBeenCalled();
  });

  it('writes only sealed credentials and falls back to memory on keychain denial', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vv-account-'));
    const path = join(dir, 'account.session');
    const keyring = new Map<string, string>();
    const box = {
      available: vi.fn(() => true),
      seal: (value: string) => { const key = random(); keyring.set(key, value); return key; },
      open: (value: string) => keyring.get(value)!,
    };
    const file = accountStore(path, box), f = fixture();
    const a = f.create(file);
    await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledTimes(1));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toMatch(/^[\w-]{43}$/);
    await a.dispose();
    const b = f.create(file);
    await waitFor(() => expect(b.status().kind).toBe('signedIn'));
    await b.logout();
    box.available.mockReturnValue(false);
    await b.login();
    await waitFor(() => expect(b.status()).toMatchObject({ kind: 'signedIn', persistence: 'memory' }));
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await b.dispose();
    await writeFile(path, 'unreadable ciphertext');
    const c = f.create(file);
    await waitFor(() => expect(c.status()).toEqual({ kind: 'unavailable', reason: 'storage' }));
    expect(await c.logout()).toEqual({ kind: 'signedOut' });
    await rmdir(dir);
  });
});
