import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {canonicalizeRichRecipeContent, newRichMetadataRequestId, type RecipeRichContent, type RichMetadataRequest} from '@vonvon/protocol';
import {createAccountSession} from '../src/account-session';
import type {AccountCredential} from '../src/account-auth';
import {saveRichMetadata} from '../src/community-metadata';
import {MetadataJournal} from '../src/community-metadata-journal';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
const deadlines = new Set<AbortSignal>();
beforeEach(() => {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const signal = nativeTimeout(ms);
    deadlines.add(signal);
    return signal;
  });
});
afterEach(() => {deadlines.clear(); vi.restoreAllMocks();});

async function backend(handle: (req: IncomingMessage, res: ServerResponse, signal: AbortSignal) => Promise<void>) {
  const lifetime = new AbortController();
  const server = createServer(async (req, res) => {
    try {await handle(req, res, lifetime.signal);}
    catch {if (!res.destroyed) {res.statusCode = 503; res.end('{}');}}
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = 'http://127.0.0.1:' + address.port;
  const accountId = randomUUID(), subject = randomUUID(), issuer = 'http://127.0.0.1:1';
  const provider = 'github';
  const user = {id: subject, is_anonymous: false, identities: [{provider, user_id: subject}], user_metadata: {name: 'Fixture'}};
  const credential: AccountCredential = {webOrigin: origin, apiOrigin: origin, supabaseUrl: issuer, publishableKey: 'sb_publishable_fixture',
    subject, accountId, provider, refreshToken: 'fixture-refresh'};
  const account = createAccountSession({deployment: {webOrigin: origin, apiOrigin: origin, allowLoopback: true},
    store: {read: async () => credential, save: async () => 'memory', clear: async () => {}}, openBrowser: async () => {},
    transport: async (url, init) => {
      const target = new URL(String(url));
      if (target.origin === issuer) return target.pathname === '/auth/v1/user' ? Response.json(user) : Response.json({
        user, token_type: 'bearer', access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600,
      });
      if (target.pathname === '/v1/me') return Response.json({accountId});
      return fetch(url, init);
    }});
  await vi.waitFor(() => expect(account.status()).toMatchObject({kind: 'signedIn', accountId}));
  return {account, accountId, async close() {
    await account.dispose(); lifetime.abort(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }};
}

it('commits replacement Logo metadata on its first save when the normal member reply takes ten seconds', async () => {
  const raw: RecipeRichContent = JSON.parse(readFileSync(new URL('../../protocol/test/fixtures/recipe-rich-v2.content.json', import.meta.url), 'utf8'));
  delete raw.finalLogo; raw.parts = []; raw.memories = [];
  const base = canonicalizeRichRecipeContent(raw), draftId = randomUUID(), sourceIntentId = randomUUID(), baseId = randomUUID();
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQYlWOwq9z5Hx9mGBkKAARYm8F/mqTrAAAAAElFTkSuQmCC', 'base64');
  const logo = Buffer.from('UklGRowAAABXRUJQVlA4IIAAAABwCwCdASrAAMAAPlEokkcjoqGhIEgAcAoJaW7hdrEe3AfgAAAnteirhBkENVSa7bRcIMghqqTXbaLhBkENVSa7bRcIMghqqTXbaLhBkENVSa7bRcIMghqqTXbaLhBkENVSa6AAAP7/KBP//8s+fw2ce///4s5GI7LwAAAAAAAAAA==', 'base64');
  const descriptor = {objectId: randomUUID(), kind: 'finalLogo', bytes: logo.length, sha256: sha(logo), mediaType: 'image/webp'};
  const objects = new Map<string, Uint8Array>([[baseId, base.canonicalUTF8], [descriptor.objectId, logo]]);
  let manifest = {objectId: baseId, kind: 'manifest', bytes: base.canonicalUTF8.length, sha256: sha(base.canonicalUTF8), mediaType: 'application/json'};
  let receipt: {requestId: string; draftId: string; revision: number; manifestSha256: string} | undefined;
  const calls: string[] = [];
  const f = await backend(async (req, res, signal) => {
    const path = req.url!; calls.push(path);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    let result: unknown;
    if (path.endsWith('/metadata')) {
      const body = JSON.parse(bytes.toString()) as {baseCanonical?: string};
      if (body.baseCanonical) receipt = {requestId: String(req.headers['idempotency-key']), draftId, revision: 2, manifestSha256: manifest.sha256};
      result = receipt ? {status: 'committed', receipt} : {status: 'pending'};
    } else if (path.endsWith('/reserve')) result = {};
    else if (path.endsWith('/members/64')) {await delay(10_000, undefined, {signal}); result = descriptor;}
    else if (path.endsWith('/members/65')) {
      manifest = {objectId: randomUUID(), kind: 'manifest', bytes: bytes.length, sha256: sha(bytes), mediaType: 'application/json'};
      objects.set(manifest.objectId, bytes); result = manifest;
    } else if (path.includes('/objects/')) {
      const value = objects.get(path.split('/').at(-1)!); assert.ok(value); res.end(value); return;
    } else if (path === '/v2/drafts/' + draftId) result = {format: 'rich-v2', draftId, recipeId: null, revision: receipt ? 2 : 1,
      access: receipt ? 'coded' : 'direct', sourceIntentId, manifest, logicalBytes: manifest.bytes + (receipt ? logo.length : 0),
      retainedCandidateBytes: 0, sourceManifest: null};
    else throw new Error('Unexpected fixture route ' + path);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
  });
  try {
    const request: RichMetadataRequest = {type: 'saveRichDraftMetadata', accountId: f.accountId, requestId: newRichMetadataRequestId(),
      draftId, revision: 1, baseManifestSha256: sha(base.canonicalUTF8), public: {name: '替换 Logo', summary: '介绍', overview: '完整说明', version: '1', access: 'coded'},
      logo: {kind: 'replace', base64: original.toString('base64')}};
    const journal = new MetadataJournal();
    expect(await saveRichMetadata(f.account, request, journal)).toMatchObject({status: 'committed', draft: {revision: 2, logo: 'data:image/webp;base64,' + logo.toString('base64')}});
    expect(calls.filter(path => path.endsWith('/members/64'))).toHaveLength(1);
    expect(calls.filter(path => path.endsWith('/members/65'))).toHaveLength(1);
    expect(journal.read(journal.key(f.accountId, draftId))).toBeUndefined();
  } finally {await f.close();}
}, 15_000);

it('extends only exact member PUT routes while ordinary and malformed routes keep the nine-second deadline', async () => {
  const f = await backend(async (_req, res, signal) => {await delay(11_000, undefined, {signal}); res.end('{}');});
  const member = '/v2/objects/' + randomUUID() + '/members/';
  const ordinary = [
    {path: '/v2/drafts/' + randomUUID(), method: 'GET'}, {path: member + '64', method: 'GET'},
    {path: member + '64', method: 'POST'}, {path: member + '66', method: 'PUT'},
    {path: member + '00', method: 'PUT'}, {path: member + '064', method: 'PUT'},
    {path: member + '64?query=1', method: 'PUT'}, {path: '/v2/objects/not-a-uuid/members/64', method: 'PUT'},
    {path: member + '64/extra', method: 'PUT'},
  ];
  try {
    await Promise.all([
      ...ordinary.map(async route => {await expect(f.account.request(f.accountId, route.path, {method: route.method})).rejects.toMatchObject({name: 'TimeoutError'});}),
      ...[0, 64, 65].map(async ordinal => {expect((await f.account.request(f.accountId, member + ordinal, {method: 'PUT'})).ok).toBe(true);}),
    ]);
  } finally {await f.close();}
}, 15_000);

it.each(['caller abort', 'logout'] as const)('cancels a member upload immediately at %s', async action => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const f = await backend(async (_req, _res, signal) => {entered(); await delay(11_000, undefined, {signal});});
  try {
    const controller = new AbortController();
    const result = f.account.request(f.accountId, '/v2/objects/' + randomUUID() + '/members/64', {method: 'PUT', signal: controller.signal});
    const rejected = expect(result).rejects.toMatchObject({name: 'AbortError'});
    await started;
    if (action === 'caller abort') controller.abort(); else await f.account.logout();
    await rejected;
  } finally {await f.close();}
});
