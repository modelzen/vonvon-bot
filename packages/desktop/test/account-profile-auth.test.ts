import {expect, it, vi} from 'vitest';
import {accountAuth, AccountFault, verifyAccount} from '../src/account-auth.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const subject = '22222222-2222-4222-8222-222222222222';
const deployment = {webOrigin: 'https://web.invalid', apiOrigin: 'https://api.invalid', allowLoopback: false};
const project = {supabaseUrl: 'https://identity.invalid', publishableKey: 'sb_publishable_test'};
async function verify(response: Response, proof = Response.json({accountId}), initialize = vi.fn(() => Response.json({authorId: accountId, displayName: 'OAuth name', revision: 1}))) {
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({id: subject, is_anonymous: false, identities: [{provider: 'github', user_id: subject}], user_metadata: {full_name: 'OAuth name'}});
    if (url.endsWith('/v1/me')) return proof;
    if (url.endsWith('/v2/me/account-profile')) return response;
    if (url.endsWith('/v2/me/account-profile/initialize')) {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({displayName: 'OAuth name'});
      return initialize();
    }
    throw new Error('unexpected_request');
  };
  const signal = new AbortController().signal;
  const auth = accountAuth(project, signal, transport);
  try {return await verifyAccount(deployment, auth, 'access', subject, 'github', signal, transport);}
  finally {await auth.dispose();}
}
it('keeps a profile response stream failure retryable without treating it as invalid identity', async () => {
  const stream = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new TextEncoder().encode('{"displayName":')); controller.error(new TypeError('connection closed'));}});
  await expect(verify(new Response(stream))).rejects.toMatchObject({reason: 'offline'} satisfies Partial<AccountFault>);
});
it('rejects malformed or mismatched profiles while allowing old servers without the endpoint', async () => {
  for (const response of [Response.json({authorId: subject, displayName: 'Wrong account'}), new Response('{invalid')])
    await expect(verify(response)).rejects.toMatchObject({reason: 'invalid'} satisfies Partial<AccountFault>);
  await expect(verify(new Response(null, {status: 404}))).resolves.toMatchObject({accountId, displayName: 'OAuth name'});
  await expect(verify(new Response(null, {status: 401}))).rejects.toMatchObject({reason: 'invalid'} satisfies Partial<AccountFault>);
});
it('initializes one account nickname on first login and restores saved profile on later logins', async () => {
  await expect(verify(Response.json({authorId: accountId, displayName: '配方作者', revision: 0}))).resolves.toMatchObject({displayName: 'OAuth name', profileRevision: 1});
  await expect(verify(Response.json({authorId: accountId, displayName: '公开昵称', revision: 3, avatarDataUrl: 'data:image/webp;base64,YWJj'})))
    .resolves.toMatchObject({accountId, displayName: '公开昵称', profileRevision: 3, avatarDataUrl: 'data:image/webp;base64,YWJj'});
});

it('accepts the unique nickname assigned by the server and never overwrites an existing nickname', async () => {
  const initialize = vi.fn(() => Response.json({authorId: accountId, displayName: 'OAuth name-11111111', revision: 1}));
  await expect(verify(Response.json({authorId: accountId, displayName: '配方作者', revision: 0}), Response.json({accountId}), initialize))
    .resolves.toMatchObject({displayName: 'OAuth name-11111111', profileRevision: 1});
  expect(initialize).toHaveBeenCalledOnce();
  const alreadySaved = vi.fn(() => {throw new Error('must not initialize an existing profile');});
  await expect(verify(Response.json({authorId: accountId, displayName: '现有昵称', revision: 8}), Response.json({accountId}), alreadySaved))
    .resolves.toMatchObject({displayName: '现有昵称', profileRevision: 8});
  expect(alreadySaved).not.toHaveBeenCalled();
});

it('keeps the account proof response stream failure retryable', async () => {
  const stream = new ReadableStream<Uint8Array>({start(controller) {controller.error(new TypeError('connection closed'));}});
  await expect(verify(new Response(null, {status: 404}), new Response(stream))).rejects.toMatchObject({reason: 'offline'} satisfies Partial<AccountFault>);
});
