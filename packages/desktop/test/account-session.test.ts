import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {communityRequest} from '../src/community-api.js';
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
  user_metadata: { full_name: 'Example User', avatar_url: 'https://avatars.githubusercontent.com/u/123?v=4', email: 'private@example.com' },
};
const access = 'access-test-value', refresh = 'refresh-test-value', code = 'one-use-code';
const random = () => randomBytes(32).toString('base64url');
const sessionReply = (rotated = false) => ({
  user, token_type: 'bearer', access_token: access, refresh_token: rotated ? 'rotated-refresh-token' : refresh, expires_in: 3600,
});
const sessions = new Set<NativeAccount>();
afterEach(async () => { for (const session of sessions) await session.dispose(); sessions.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

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
    expect([...url.searchParams.keys()].sort()).toEqual(['code_challenge', 'code_challenge_method', 'prompt', 'provider', 'redirect_to']);
    expect(url.searchParams.get('prompt')).toBe('select_account');
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
  const avatar = vi.fn(async () => new Response(null, { status: 404 }));
  const logout = vi.fn(async () => new Response(null, { status: 204 }));
  const profile = vi.fn(async () => new Response(null, {status: 404}));
  const transport = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    if (url.hostname === 'avatars.githubusercontent.com') {
      expect(url.href).toBe(user.user_metadata.avatar_url);
      expect(init.redirect).toBe('manual');
      expect(init.credentials).toBe('omit');
      expect(headers.has('Authorization') || headers.has('apikey') || headers.has('Cookie')).toBe(false);
      return avatar();
    }
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
      if (url.pathname === '/auth/v1/logout') {
        expect(init.method).toBe('POST');
        expect(url.searchParams.get('scope')).toBe('local');
        expect(headers.get('Authorization')).toBe('Bearer ' + access);
        return logout();
      }
      if (url.pathname === '/auth/v1/user') { expect(headers.get('Authorization')).toBe('Bearer ' + access); return verifyUser(); }
      if (url.searchParams.get('grant_type') === 'refresh_token') return rotate();
      if (url.searchParams.get('grant_type') === 'pkce') return exchange(body);
    }
    if (url.origin === api && url.pathname.startsWith('/v1/')) {
      expect(headers.get('Authorization')).toBe('Bearer ' + access);
      return url.pathname === '/v1/me' ? me() : Response.json({ items: [] });
    }
    if (url.origin === api && url.pathname === '/v2/me/account-profile') return profile();
    throw new Error('Unexpected fixture request');
  });
  const openBrowser = vi.fn(async (_url: string) => {});
  const store = memoryStore();
  function create(records: AccountStore = store) {
    const session = createAccountSession({ deployment, store: records, transport, openBrowser, pollMs: 2 });
    sessions.add(session);
    return session;
  }
  return { create, store, transport, issued, openBrowser, poll, ack, cancel, rotate, authorize, exchange, verifyUser, me, avatar, logout, profile };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const waitFor = (assertion: () => void) => vi.waitFor(assertion, { interval: 5, timeout: 2500 });

describe('native desktop account', () => {
  it('allows anonymous public author pages and valid cursors without sending account credentials', async () => {
    const f = fixture(), a = f.create(), authorId = randomUUID(), cursor = randomUUID();
    f.transport.mockResolvedValue(Response.json({items: []}));
    for (const path of [`/v2/authors/${authorId}/recipes`, `/v2/authors/${authorId}/recipes?cursor=${cursor}`]) {
      await a.publicRequest!(path);
      const [url, init] = f.transport.mock.calls.at(-1)!;
      expect(String(url)).toBe(api + path);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      expect(init?.credentials).toBe('omit');
    }
    const sent = f.transport.mock.calls.length;
    for (const path of [`/v2/authors/invalid/recipes`, `/v2/authors/${authorId}/recipes?cursor=invalid`,
      `/v2/authors/${authorId}/recipes?cursor=${cursor}&cursor=${cursor}`, `/v2/authors/${authorId}/recipes?private=1`]) {
      await expect(a.publicRequest!(path)).rejects.toThrow();
    }
    expect(f.transport).toHaveBeenCalledTimes(sent);
  });

  it('opens only the configured website account settings for the current account', async () => {
    const f = fixture(), a = f.create();
    await expect(a.manage!()).rejects.toThrow();
    expect(f.openBrowser).not.toHaveBeenCalled();
    await a.login(); await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    await a.manage!();
    expect(f.openBrowser).toHaveBeenLastCalledWith(web + '/account#account=' + business);
    await a.logout();
    await expect(a.manage!()).rejects.toThrow();
    expect(f.openBrowser).toHaveBeenCalledTimes(2);
  });

  it('deduplicates profile refreshes and updates website edits without another OAuth flow', async () => {
    const f = fixture(), a = f.create(); await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    const held = deferred<Response>(); f.profile.mockReturnValueOnce(held.promise);
    const first = a.refresh!(), second = a.refresh!();
    expect(first).toBe(second);
    held.resolve(Response.json({authorId: business, displayName: '网站修改的昵称', revision: 4, avatarDataUrl: 'data:image/png;base64,YQ=='}));
    await Promise.all([first, second]);
    expect(a.status()).toMatchObject({accountId: business, displayName: '网站修改的昵称', profileRevision: 4, avatarDataUrl: 'data:image/png;base64,YQ=='});
    expect(f.openBrowser).toHaveBeenCalledOnce();
    expect(f.rotate).not.toHaveBeenCalled();
    expect(f.profile).toHaveBeenCalledTimes(2);
  });

  it('keeps the signed-in account when refreshing website profile fails', async () => {
    const f = fixture(), a = f.create(); await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    f.profile.mockRejectedValueOnce(new TypeError('offline'));
    await expect(a.refresh!()).rejects.toThrow();
    expect(a.status()).toMatchObject({kind: 'signedIn', accountId: business});
    expect((await f.store.read())?.accountId).toBe(business);
    f.profile.mockResolvedValueOnce(Response.json({authorId: business, displayName: '已恢复', revision: 5}));
    await a.refresh!();
    expect(a.status()).toMatchObject({displayName: '已恢复'});
  });

  it('discards a website profile refresh that completes after the account switches', async () => {
    const f = fixture(), a = f.create(); await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    const held = deferred<Response>(); f.profile.mockReturnValueOnce(held.promise);
    const pending = a.refresh!(); const rejected = expect(pending).rejects.toThrow();
    await a.logout();
    const nextAccount = randomUUID(); f.me.mockResolvedValueOnce(Response.json({accountId: nextAccount}));
    await a.login(); await waitFor(() => expect(a.status()).toMatchObject({kind: 'signedIn', accountId: nextAccount}));
    held.resolve(Response.json({authorId: business, displayName: '旧账号的网站昵称', revision: 20}));
    await rejected;
    expect(a.status()).toMatchObject({accountId: nextAccount, displayName: 'Example User'});
  });

  it('restores the saved nickname and custom avatar while keeping the same account ID', async () => {
    const f = fixture(), avatarDataUrl = 'data:image/webp;base64,YQ==';
    f.profile.mockResolvedValueOnce(Response.json({authorId: business, displayName: '自选昵称', avatarDataUrl, revision: 2}));
    const a = f.create(); await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    expect(a.status()).toMatchObject({accountId: business, displayName: '自选昵称', avatarDataUrl, profileRevision: 2});
    expect(f.avatar).not.toHaveBeenCalled();
  });

  it('applies profile saves immediately, ignores older revisions and restores the provider avatar on removal', async () => {
    const f = fixture(), a = f.create(); await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    a.applyProfile!(business, {authorId: business, displayName: '新昵称', avatarDataUrl: 'data:image/png;base64,YQ==', revision: 2});
    expect(a.status()).toMatchObject({accountId: business, displayName: '新昵称', profileRevision: 2, avatarDataUrl: 'data:image/png;base64,YQ=='});
    a.applyProfile!(business, {authorId: business, displayName: '旧昵称', revision: 1});
    expect(a.status()).toMatchObject({displayName: '新昵称', profileRevision: 2});
    a.applyProfile!(business, {authorId: business, displayName: '新昵称', revision: 3});
    expect(a.status()).not.toHaveProperty('avatarDataUrl');
    expect(a.status()).toMatchObject({avatarUrl: user.user_metadata.avatar_url, profileRevision: 3});
    await a.logout();
    a.applyProfile!(business, {authorId: business, displayName: '迟到的资料', revision: 4});
    expect(a.status()).toEqual({kind: 'signedOut'});
  });

  it('does not let an earlier token refresh overwrite a newer saved profile', async () => {
    const f = fixture(), a = f.create(); await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    const held = deferred<Response>(); f.profile.mockReturnValueOnce(held.promise);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_590_000);
    const refreshing = a.request(business, '/v1/me/recipes');
    await waitFor(() => expect(f.profile).toHaveBeenCalledTimes(2));
    a.applyProfile!(business, {authorId: business, displayName: '更新的昵称', revision: 8});
    held.resolve(Response.json({authorId: business, displayName: '刷新中的旧昵称', revision: 7}));
    await refreshing;
    expect(a.status()).toMatchObject({accountId: business, displayName: '更新的昵称', profileRevision: 8});
  });

  it('clears local credentials and revokes only the outgoing session without blocking the next login', async () => {
    const f = fixture(), a = f.create();
    await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    const held = deferred<Response>();
    f.logout.mockReturnValueOnce(held.promise);
    const loggingOut = a.logout();
    expect(a.status()).toEqual({kind: 'signedOut'});
    await waitFor(() => expect(f.store.clear).toHaveBeenCalledTimes(2));
    await expect(a.request(business, '/v1/me/recipes')).rejects.toThrow();
    const nextAccount = randomUUID();
    f.me.mockResolvedValueOnce(Response.json({accountId: nextAccount}));
    await a.login();
    await waitFor(() => expect(a.status()).toMatchObject({kind: 'signedIn', accountId: nextAccount}));
    held.resolve(new Response(null, {status: 204}));
    await loggingOut;
    expect(a.status()).toMatchObject({kind: 'signedIn', accountId: nextAccount});
    expect((await f.store.read())?.accountId).toBe(nextAccount);
    expect(f.logout).toHaveBeenCalledOnce();
  });

  it('still removes local credentials when remote logout is offline', async () => {
    const f = fixture(), a = f.create();
    await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    f.logout.mockRejectedValueOnce(new TypeError('offline'));
    expect(await a.logout()).toEqual({kind: 'signedOut'});
    expect(await f.store.read()).toBeUndefined();
    expect(f.logout).toHaveBeenCalledOnce();
  });

  it('revokes an outgoing session after its access token expires during sleep', async () => {
    const f = fixture(), a = f.create(); await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_610_000);
    expect(await a.logout()).toEqual({kind: 'signedOut'});
    expect(f.rotate).toHaveBeenCalledOnce();
    expect(f.logout).toHaveBeenCalledOnce();
    expect(await f.store.read()).toBeUndefined();
    expect(f.store.save).toHaveBeenCalledOnce();
  });

  it('retries remote logout with only the outgoing refresh token when its JWT is rejected', async () => {
    const f = fixture(), a = f.create(); await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    f.logout.mockResolvedValueOnce(Response.json({msg: 'JWT expired'}, {status: 401}));
    expect(await a.logout()).toEqual({kind: 'signedOut'});
    expect(f.rotate).toHaveBeenCalledOnce();
    expect(f.logout).toHaveBeenCalledTimes(2);
    expect(await f.store.read()).toBeUndefined();
    expect(f.store.save).toHaveBeenCalledOnce();
  });

  it('recovers a failed avatar in the background without waiting for token refresh', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4w8AARAwQCgAfjgPxzzTeXgAAAABJRU5ErkJggg==', 'base64');
    f.avatar.mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
    const a = f.create();
    await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    expect(a.status()).toMatchObject({ kind: 'signedIn', accountId: business });
    expect(a.status()).not.toHaveProperty('avatarDataUrl');
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.avatar).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.avatar).toHaveBeenCalledTimes(2);
    expect(a.status()).toMatchObject({ avatarDataUrl: 'data:image/png;base64,' + bytes.toString('base64') });
    expect(f.rotate).not.toHaveBeenCalled();
    expect(f.store.save).toHaveBeenCalledOnce();
  });

  it('bounds automatic avatar retries while keeping the verified account usable', async () => {
    vi.useFakeTimers();
    const f = fixture(), a = f.create();
    await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.avatar).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.avatar).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.avatar).toHaveBeenCalledTimes(3);
    expect(a.status()).toMatchObject({ kind: 'signedIn', accountId: business });
    expect(a.status()).not.toHaveProperty('avatarDataUrl');
    expect(f.rotate).not.toHaveBeenCalled();
    expect(await (await a.request(business, '/v1/me/recipes')).json()).toEqual({ items: [] });
  });

  it.each(['logout', 'dispose'] as const)('cancels queued avatar retries at %s', async action => {
    vi.useFakeTimers();
    const f = fixture(), a = f.create();
    await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    expect(f.avatar).toHaveBeenCalledOnce();
    const statuses: unknown[] = [];
    a.onStatus(value => statuses.push(value));
    await a[action]();
    const published = statuses.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.avatar).toHaveBeenCalledOnce();
    expect(statuses).toHaveLength(published);
  });

  it('cancels queued work when verified metadata no longer has an avatar URL', async () => {
    vi.useFakeTimers();
    const f = fixture(), a = f.create();
    await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    f.verifyUser.mockResolvedValueOnce(Response.json({ ...user, user_metadata: { full_name: 'Example User' } }));
    vi.setSystemTime(Date.now() + 3_590_000);
    await a.request(business, '/v1/me/recipes');
    expect(a.status()).not.toHaveProperty('avatarUrl');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.avatar).toHaveBeenCalledOnce();
    expect(a.status()).not.toHaveProperty('avatarDataUrl');
  });

  it('replaces the retry queue when the verified avatar URL changes', async () => {
    vi.useFakeTimers();
    const f = fixture(), a = f.create();
    await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    const nextUrl = 'https://avatars.githubusercontent.com/u/456?v=4';
    const held = deferred<Response>();
    const base = f.transport.getMockImplementation()!;
    f.transport.mockImplementation((url, init) => String(url) === nextUrl ? held.promise : base(url, init));
    f.verifyUser.mockResolvedValueOnce(Response.json({ ...user,
      user_metadata: { ...user.user_metadata, avatar_url: nextUrl } }));
    vi.setSystemTime(Date.now() + 3_590_000);
    await a.request(business, '/v1/me/recipes');
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.avatar).toHaveBeenCalledOnce();
    expect(f.transport.mock.calls.filter(([url]) => String(url) === nextUrl)).toHaveLength(1);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4w8AARAwQCgAfjgPxzzTeXgAAAABJRU5ErkJggg==', 'base64');
    held.resolve(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
    await vi.advanceTimersByTimeAsync(1);
    expect(a.status()).toMatchObject({ avatarUrl: nextUrl, avatarDataUrl: 'data:image/png;base64,' + bytes.toString('base64') });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.avatar).toHaveBeenCalledOnce();
    expect(f.transport.mock.calls.filter(([url]) => String(url) === nextUrl)).toHaveLength(1);
  });

  it('does not use the previous account retry timer during the next account avatar request', async () => {
    vi.useFakeTimers();
    const f = fixture(), a = f.create();
    await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    await a.logout();
    const held = deferred<Response>(), nextAccount = randomUUID();
    f.me.mockResolvedValueOnce(Response.json({ accountId: nextAccount }));
    f.avatar.mockReturnValueOnce(held.promise);
    await a.login();
    await waitFor(() => expect(a.status()).toMatchObject({ kind: 'signedIn', accountId: nextAccount }));
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.avatar).toHaveBeenCalledTimes(2);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4w8AARAwQCgAfjgPxzzTeXgAAAABJRU5ErkJggg==', 'base64');
    held.resolve(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
    await vi.advanceTimersByTimeAsync(1);
    expect(a.status()).toMatchObject({ kind: 'signedIn', accountId: nextAccount,
      avatarDataUrl: 'data:image/png;base64,' + bytes.toString('base64') });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.avatar).toHaveBeenCalledTimes(2);
  });

  it('publishes sign-in before the avatar, then keeps that bounded avatar across token refresh', async () => {
    const f = fixture();
    const held = deferred<Response>();
    f.avatar.mockReturnValueOnce(held.promise);
    const a = f.create();
    await a.login();
    await waitFor(() => expect(f.avatar).toHaveBeenCalledOnce());
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    expect(a.status()).toMatchObject({ kind: 'signedIn', accountId: business });
    expect(a.status()).not.toHaveProperty('avatarDataUrl');
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4w8AARAwQCgAfjgPxzzTeXgAAAABJRU5ErkJggg==', 'base64');
    held.resolve(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
    const avatarDataUrl = 'data:image/png;base64,' + bytes.toString('base64');
    await waitFor(() => expect(a.status()).toMatchObject({ avatarDataUrl }));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_590_000);
    await a.request(business, '/v1/me/recipes');
    expect(f.rotate).toHaveBeenCalledOnce();
    expect(f.avatar).toHaveBeenCalledOnce();
    expect(a.status()).toMatchObject({ kind: 'signedIn', accountId: business, avatarDataUrl });
  });

  it('keeps an avatar completed during a temporary outage for the next verified sign-in', async () => {
    const f = fixture();
    const held = deferred<Response>();
    f.avatar.mockReturnValueOnce(held.promise);
    const a = f.create();
    const statuses: unknown[] = [];
    a.onStatus(value => statuses.push(value));
    await a.login();
    await waitFor(() => expect(f.avatar).toHaveBeenCalledOnce());
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_590_000);
    f.me.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(a.request(business, '/v1/me/recipes')).rejects.toThrow();
    expect(a.status()).toEqual({ kind: 'unavailable', reason: 'offline' });
    const published = statuses.length;
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4w8AARAwQCgAfjgPxzzTeXgAAAABJRU5ErkJggg==', 'base64');
    held.resolve(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
    await new Promise(resolve => setImmediate(resolve));
    expect(a.status()).toEqual({ kind: 'unavailable', reason: 'offline' });
    expect(statuses).toHaveLength(published);
    expect(await a.login()).toMatchObject({ kind: 'signedIn', accountId: business,
      avatarDataUrl: 'data:image/png;base64,' + bytes.toString('base64') });
    expect(f.avatar).toHaveBeenCalledOnce();
  });

  it('discards a late avatar after verified metadata no longer names it', async () => {
    const f = fixture();
    const held = deferred<Response>();
    f.avatar.mockReturnValueOnce(held.promise);
    const a = f.create();
    const statuses: unknown[] = [];
    a.onStatus(value => statuses.push(value));
    await a.login();
    await waitFor(() => expect(f.avatar).toHaveBeenCalledOnce());
    f.verifyUser.mockResolvedValueOnce(Response.json({ ...user, user_metadata: { full_name: 'Example User' } }));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_590_000);
    await a.request(business, '/v1/me/recipes');
    expect(a.status()).not.toHaveProperty('avatarUrl');
    const request = f.transport.mock.calls.find(([input]) => String(input) === user.user_metadata.avatar_url);
    expect(request?.[1]?.signal?.aborted).toBe(true);
    const published = statuses.length;
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4w8AARAwQCgAfjgPxzzTeXgAAAABJRU5ErkJggg==', 'base64');
    held.resolve(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
    await new Promise(resolve => setImmediate(resolve));
    expect(a.status()).toMatchObject({ kind: 'signedIn', accountId: business });
    expect(a.status()).not.toHaveProperty('avatarDataUrl');
    expect(statuses).toHaveLength(published);
  });

  it('aborts avatar work at logout and never gives its late image to a subsequent account', async () => {
    const f = fixture();
    const held = deferred<Response>();
    f.avatar.mockReturnValueOnce(held.promise);
    const a = f.create();
    const statuses: unknown[] = [];
    a.onStatus(value => statuses.push(value));
    await a.login();
    await waitFor(() => expect(f.avatar).toHaveBeenCalledOnce());
    expect(a.status().kind).toBe('signedIn');
    const request = f.transport.mock.calls.find(([input]) => String(input) === user.user_metadata.avatar_url);
    expect(request?.[1]?.signal?.aborted).toBe(false);
    expect(await a.logout()).toEqual({ kind: 'signedOut' });
    expect(request?.[1]?.signal?.aborted).toBe(true);
    const nextAccount = randomUUID();
    f.me.mockResolvedValueOnce(Response.json({ accountId: nextAccount }));
    await a.login();
    await waitFor(() => expect(a.status()).toMatchObject({ kind: 'signedIn', accountId: nextAccount }));
    expect(f.avatar).toHaveBeenCalledTimes(2);
    const published = statuses.length;
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4w8AARAwQCgAfjgPxzzTeXgAAAABJRU5ErkJggg==', 'base64');
    held.resolve(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
    await new Promise(resolve => setImmediate(resolve));
    expect(a.status()).toMatchObject({ kind: 'signedIn', accountId: nextAccount });
    expect(a.status()).not.toHaveProperty('avatarDataUrl');
    expect(statuses).toHaveLength(published);
  });

  it('retries failed avatars on verified refresh after a cooldown and clears the cache on logout', async () => {
    const f = fixture();
    f.exchange.mockResolvedValueOnce(Response.json({ ...sessionReply(), expires_in: 1 }));
    f.rotate.mockImplementation(async () => Response.json({ ...sessionReply(true), expires_in: 1 }));
    const a = f.create();
    await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    await new Promise(resolve => setImmediate(resolve));
    expect(a.status()).toMatchObject({ kind: 'signedIn', accountId: business });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await a.request(business, '/v1/me/recipes');
    expect(f.avatar).toHaveBeenCalledOnce();
    expect(a.status()).not.toHaveProperty('avatarDataUrl');
    clock.mockReturnValue(now + 60_001);
    await a.request(business, '/v1/me/recipes');
    await new Promise(resolve => setImmediate(resolve));
    expect(f.avatar).toHaveBeenCalledTimes(2);
    expect(a.status()).not.toHaveProperty('avatarDataUrl');
    await a.request(business, '/v1/me/recipes');
    expect(f.avatar).toHaveBeenCalledTimes(2);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4w8AARAwQCgAfjgPxzzTeXgAAAABJRU5ErkJggg==', 'base64');
    f.avatar.mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
    clock.mockReturnValue(now + 120_002);
    await a.request(business, '/v1/me/recipes');
    await waitFor(() => expect(a.status()).toMatchObject({ avatarDataUrl: 'data:image/png;base64,' + bytes.toString('base64') }));
    expect(f.avatar).toHaveBeenCalledTimes(3);
    await a.request(business, '/v1/me/recipes');
    expect(f.avatar).toHaveBeenCalledTimes(3);
    await a.logout();
    await a.login();
    await waitFor(() => expect(f.avatar).toHaveBeenCalledTimes(4));
    expect(a.status()).toMatchObject({ kind: 'signedIn', accountId: business });
    expect(a.status()).not.toHaveProperty('avatarDataUrl');
  });

  it('drops unsafe profile avatar metadata without failing verified sign-in', async () => {
    const f = fixture();
    f.verifyUser.mockResolvedValueOnce(Response.json({ ...user, user_metadata: { ...user.user_metadata,
      avatar_url: 'https://avatars.githubusercontent.com/u/123?access_token=private' } }));
    const a = f.create();
    await a.login();
    await waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    expect(a.status()).toEqual({ kind: 'signedIn', accountId: business, displayName: 'Example User', provider, persistence: 'secure' });
    expect(f.avatar).not.toHaveBeenCalled();
  });

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

it('invalidates a fully buffered private community response immediately when logout begins, before secure storage acknowledges it', async () => {
  const f = fixture(); const a = f.create();
  await a.login(); await waitFor(() => expect(a.status().kind).toBe('signedIn'));
  const lease=a.lease?.(business);expect(lease?.aborted).toBe(false);
  const cleared = deferred<void>();
  f.store.clear.mockImplementationOnce(() => cleared.promise);
  const base = f.transport.getMockImplementation()!;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  f.transport.mockImplementation((url, init) => /\/v[12]\/me\/drafts$/.test(String(url))
    ? Promise.resolve(new Response(new ReadableStream<Uint8Array>({start(value) {controller = value;}}))) : base(url, init));
  const pending = communityRequest(a, {type: 'drafts', accountId: business});
  const result = pending.then(() => 'leaked', () => 'rejected');
  let loggingOut: ReturnType<typeof a.logout> | undefined;
  try {
    await waitFor(() => expect(controller).toBeDefined());
    loggingOut = a.logout();
    expect(lease?.aborted).toBe(true);expect(a.lease?.(business)).toBeUndefined();
    controller.enqueue(new TextEncoder().encode(JSON.stringify({items: []}))); controller.close();
    expect(await result).toBe('rejected');
  } finally {
    cleared.resolve();
    try {controller?.close();} catch {}
    await loggingOut;
    await result;
  }
});

it('checks the captured device again after a credential refresh and before sending an authorization', async () => {
  const f=fixture(), a=f.create();
  await a.login();await waitFor(()=>expect(a.status().kind).toBe('signedIn'));
  vi.spyOn(Date,'now').mockReturnValue(Date.now()+3_590_000);
  const held=deferred<Response>();
  f.rotate.mockReturnValueOnce(held.promise);
  let valid=true;
  const path='/v1/operations/'+randomUUID()+'/authorize';
  const send=a.request(business,path,{method:'POST'},()=>{if(!valid)throw Error('device switched');});
  await waitFor(()=>expect(f.rotate).toHaveBeenCalled());
  valid=false;held.resolve(Response.json(sessionReply(true)));
  await expect(send).rejects.toThrow('device switched');
  expect(f.transport.mock.calls.some(([url])=>String(url).endsWith(path))).toBe(false);
});

it('routes canonical API paths, keeps public previews anonymous and rejects anonymous full objects', async()=>{
  const f=fixture(),a=f.create(),version=randomUUID(),object=randomUUID();
  await a.login();await waitFor(()=>expect(a.status().kind).toBe('signedIn'));
  f.transport.mockResolvedValue(Response.json({}));
  const seen: (string|null)[]=[];
  for(const path of ['/v1/me/recipes','/v2/versions/'+version+'/source-items']){
    await a.request(business,path);
    seen.push(new Headers(f.transport.mock.lastCall?.[1]?.headers).get('Authorization'));
  }
  for(const path of ['/v2/community/recipes?q=%E7%BE%A4','/v2/recipes/'+object+'/versions/'+version,'/v2/versions/'+version+'/display-logo','/v2/recipes/'+object+'/versions/'+version+'/preview']){
    await a.publicRequest!(path);
    seen.push(new Headers(f.transport.mock.lastCall?.[1]?.headers).get('Authorization'));
  }
  expect(seen).toEqual(['Bearer '+access,'Bearer '+access,null,null,null,null]);
  const prior=f.transport.mock.calls.length;
  for(const path of ['https://wrong.example/v2/me','//wrong.example/v2/me','/v3/me','/v2/a/../me','/v2/%2e%2e/v1/me','/v2/a%2fb','/v2/a%252fb','/v2/me#','/v2/me?x=1#x','/v2//me','/v2/\\me']){
    await expect(a.request(business,path)).rejects.toThrow();
  }
  for(const path of ['/v2/me/drafts','/v2/drafts/'+version+'/objects/'+object,'/v2/versions/'+version+'/objects/'+object,'/v2/versions/'+version+'/source-items','/v2/versions/'+version+'/display-logo?token=x'])
    await expect(a.publicRequest!(path)).rejects.toThrow();
  expect(f.transport.mock.calls).toHaveLength(prior);
  await a.logout();
  await expect(a.request(business,'/v2/authoring/'+version+'/authorize')).rejects.toThrow();
});

it('awaits final asynchronous creator approval after token refresh and never dispatches a changed card',async()=>{
  const f=fixture(),account=f.create();await account.login();await waitFor(()=>expect(f.ack).toHaveBeenCalledOnce());
  const refreshGate=deferred<Response>(),originalTime=Date.now();
  f.rotate.mockImplementationOnce(()=>refreshGate.promise);
  vi.spyOn(Date,'now').mockReturnValue(originalTime+3600_000);
  let approved=true;
  const creatorCheck=vi.fn(async()=>{await Promise.resolve();if(!approved)throw Error('creator approval changed');});
  const operation=account.request(business,'/v1/creator-guard-test',{method:'POST',body:'{}'},creatorCheck);
  const rejected=expect(operation).rejects.toThrow('creator approval changed');
  await waitFor(()=>expect(f.rotate).toHaveBeenCalledOnce());expect(creatorCheck).not.toHaveBeenCalled();
  approved=false;refreshGate.resolve(Response.json(sessionReply(true)));await rejected;
  expect(creatorCheck).toHaveBeenCalledOnce();
  expect(f.transport.mock.calls.filter(([url])=>new URL(String(url)).pathname==='/v1/creator-guard-test')).toEqual([]);
});

it('rechecks account ownership after an asynchronous final authorization callback',async()=>{
  const f=fixture(),account=f.create();await account.login();await waitFor(()=>expect(f.ack).toHaveBeenCalledOnce());
  const gate=deferred<void>(),entered=deferred<void>();
  const operation=account.request(business,'/v1/creator-account-test',{method:'POST',body:'{}'},async()=>{entered.resolve();await gate.promise;});
  const rejected=expect(operation).rejects.toThrow();await entered.promise;await account.logout();gate.resolve();await rejected;
  expect(f.transport.mock.calls.filter(([url])=>new URL(String(url)).pathname==='/v1/creator-account-test')).toEqual([]);
});
