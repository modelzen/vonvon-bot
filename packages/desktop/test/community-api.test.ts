import {describe, expect, it, vi} from 'vitest';
import type {AccountStatus} from '@vonvon/protocol';
import {communityRequest} from '../src/community-api.js';
import {createAccountSession} from '../src/account-session.js';
import {accountDeployment} from '../src/account-auth.js';
import type {NativeAccount} from '../src/account-session.js';
import {createDesktopFacades} from '../src/facade.js';
import {desktopChannels} from '../src/ipc-contract.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const recipeId = '22222222-2222-4222-8222-222222222222';
const versionId = '33333333-3333-4333-8333-333333333333';
const draftId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const meta = {name: '示例', summary: '公开简介', overview: '# 配方', version: '1.0', access: 'direct' as const};
const summary = {recipeId, versionId, revision: 1, public: meta};
const draft = {draftId, recipeId: null, revision: 1, public: meta, config: {role: '只对所选群生效'}};
function fixture() {
  let state: AccountStatus = {kind: 'signedIn', accountId, displayName: 'Example', provider: 'github', persistence: 'memory'};
  const listeners = new Set<(s: AccountStatus) => void>();
  const account: NativeAccount = {
    status: () => state, onStatus: listener => {listeners.add(listener); return () => {listeners.delete(listener);};},
    login: async () => state, cancelLogin: async () => state, logout: async () => state, dispose: async () => {},
    request: vi.fn(async () => Response.json(draft)),
    publicRequest: vi.fn(async () => Response.json({hero: summary, items: [], nextCursor: null})),
    recipeLink: () => `https://community.example/recipes/${recipeId}/versions/${versionId}`,
  };
  return {account, emit: (next: AccountStatus) => {state = next; listeners.forEach(listener => listener(next));}, listeners};
}

describe('native community boundary', () => {
  it('keeps anonymous catalog requests on the public route and encodes search as query data', async () => {
    const f = fixture(); f.emit({kind: 'signedOut'});
    expect(await communityRequest(f.account, {type: 'catalog', query: '文字 & cursor=bad'})).toEqual({hero: summary, items: [], nextCursor: null});
    expect(f.account.publicRequest).toHaveBeenCalledWith('/v1/community/recipes?q=%E6%96%87%E5%AD%97+%26+cursor%3Dbad');
    expect(f.account.request).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(0);
  });
  it('saves only typed draft contents and sends revision and the same retry key', async () => {
    const f = fixture();
    const request = {type: 'saveDraft' as const, accountId, requestId, target: {kind: 'existing' as const, draftId, revision: 7}, public: meta, config: draft.config};
    await communityRequest(f.account, request); await communityRequest(f.account, request);
    expect(f.account.request).toHaveBeenCalledTimes(2);
    expect(f.account.request).toHaveBeenLastCalledWith(accountId, '/v1/drafts/' + draftId, {
      method: 'PATCH', headers: {'Idempotency-Key': requestId, 'Content-Type': 'application/json', 'If-Match': '"7"'}, body: JSON.stringify({public: meta, config: draft.config}),
    });
  });
  it('rejects arbitrary paths, request headers, unknown config and a mismatched account before sending', async () => {
    const f = fixture();
    for (const extra of [{path: '/v1/me'}, {headers: {authorization: 'secret'}}, {url: 'https://attacker.example'}]) {
      await expect(communityRequest(f.account, {type: 'catalog', ...extra} as never)).rejects.toThrow();
    }
    await expect(communityRequest(f.account, {type: 'saveDraft', accountId, requestId, target: {kind: 'new'}, public: meta, config: {...draft.config, token: 'secret'}} as never)).rejects.toThrow();
    await expect(communityRequest(f.account, {type: 'drafts', accountId: versionId})).rejects.toThrow('账号已切换');
    expect(f.account.request).not.toHaveBeenCalled(); expect(f.account.publicRequest).not.toHaveBeenCalled();
  });
  it('does not return a private response whose body arrives after logout and same-account login', async () => {
    const f = fixture();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({start(c) {controller = c;}});
    vi.mocked(f.account.request).mockResolvedValue(new Response(body));
    const pending = communityRequest(f.account, {type: 'draft', accountId, draftId});
    await Promise.resolve();
    f.emit({kind: 'signedOut'});
    f.emit({kind: 'signedIn', accountId, displayName: 'Example', provider: 'github', persistence: 'memory'});
    controller.enqueue(new TextEncoder().encode(JSON.stringify(draft))); controller.close();
    await expect(pending).rejects.toThrow('账号已切换');
    expect(f.listeners.size).toBe(0);
  });
  it('rejects overlong bodies, secret response fields and gated configuration before the renderer sees them', async () => {
    const f = fixture();
    for (const value of [{...draft, access_token: 'secret'}, {...draft, config: {...draft.config, hostPath: '/private'}}]) {
      vi.mocked(f.account.request).mockResolvedValueOnce(Response.json(value));
      await expect(communityRequest(f.account, {type: 'draft', accountId, draftId})).rejects.toThrow('社区请求未完成');
    }
    vi.mocked(f.account.publicRequest!).mockResolvedValueOnce(Response.json({...summary, public: {...meta, access: 'coded'}, owned: false, acquired: false, config: draft.config}));
    await expect(communityRequest(f.account, {type: 'detail', recipeId, versionId})).rejects.toThrow('社区请求未完成');
    vi.mocked(f.account.request).mockResolvedValueOnce(new Response('a'.repeat(16 * 1024 * 1024 + 1)));
    await expect(communityRequest(f.account, {type: 'draft', accountId, draftId})).rejects.toThrow('社区请求未完成');
  });
  it('uses only known error text and never forwards a service error payload or request code', async () => {
    const f = fixture();
    vi.mocked(f.account.request).mockResolvedValueOnce(Response.json({error: {code: 'invalid_code', message: 'secret'}}, {status: 422}));
    await expect(communityRequest(f.account, {type: 'acquire', accountId, versionId, requestId, code: 'TOP-SECRET'})).rejects.toThrow('分享码不可用');
    vi.mocked(f.account.request).mockRejectedValueOnce(new Error('Bearer private-token'));
    await expect(communityRequest(f.account, {type: 'draft', accountId, draftId})).rejects.toThrow('社区请求未完成');
  });
  it('returns a public version link from native deployment configuration without accessing a daemon or cloud token', async () => {
    const f = fixture(); f.emit({kind: 'signedOut'});
    expect(await communityRequest(f.account, {type: 'shareLink', recipeId, versionId})).toEqual({url: `https://community.example/recipes/${recipeId}/versions/${versionId}`});
    expect(f.account.request).not.toHaveBeenCalled(); expect(f.account.publicRequest).not.toHaveBeenCalled();
  });
  it('exposes only the typed shell request, validates both boundaries and never adds a selected-device argument', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ({ok: true, value: {hero: summary, items: [], nextCursor: null}}));
    const {shell} = createDesktopFacades({invoke, receive: () => () => {}});
    expect(Object.keys(shell.community)).toEqual(['request']);
    const request = {type: 'catalog' as const, query: 'test'};
    await shell.community.request(request);
    expect(invoke).toHaveBeenCalledWith(desktopChannels.community, request);
    invoke.mockResolvedValueOnce({ok: true, value: {...{hero: summary, items: [], nextCursor: null}, refresh_token: 'secret'}});
    await expect(shell.community.request(request)).rejects.toThrow();
    expect(() => shell.community.request({type: 'catalog', origin: 'https://attacker.example'} as never)).toThrow();
  });
});

it('uses the configured public API origin without auth, cookies or redirects and rejects every nonpublic path', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({items: []}));
  const account = createAccountSession({deployment: accountDeployment('https://community.example', 'https://api.example', false),
    store: {read: async () => undefined, save: async () => 'memory', clear: async () => {}}, transport, openBrowser: async () => {}});
  try {
    await account.publicRequest!('/v1/community/recipes?q=test');
    const [url, init] = transport.mock.calls[0]!;
    expect(String(url)).toBe('https://api.example/v1/community/recipes?q=test');
    expect(init).toMatchObject({credentials: 'omit', redirect: 'error', cache: 'no-store'});
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    for (const path of ['/v1/me', '/v1/drafts', '//attacker.example/v1/community/recipes', 'https://attacker.example/v1/community/recipes', '/v1/community/recipes#token']) {
      await expect(account.publicRequest!(path)).rejects.toThrow();
    }
    expect(transport).toHaveBeenCalledOnce();
  } finally {await account.dispose();}
});
