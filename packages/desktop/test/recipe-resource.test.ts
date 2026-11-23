import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect, it, vi} from 'vitest';
import {canonicalizeRichRecipeContent, newAcquisitionKey, openResourceSnapshot, type RecipeRichContent} from '@vonvon/protocol';
import {recipeResourceReader} from '../src/recipe-resource.js';
import type {NativeAccount} from '../src/account-session.js';

const id = (i: number) => '70000000-0000-4000-8000-' + String(i).padStart(12, '0');
const accountId = id(1), target = {recipeId: id(2), versionId: id(3)}, later = {...target, versionId: id(4)};
const manifestId = id(5), partId = id(6), key = newAcquisitionKey();
const check = () => {};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const detailPath = (v = target) => `/v2/recipes/${v.recipeId}/versions/${v.versionId}`;
const browsePath = (v = target) => detailPath(v) + '/preview';
const browse = <T extends {manifest?:unknown;release?:unknown;visibility?:unknown}>(detail:T) => {
  const {manifest:_m,release:_r,visibility:_v,...preview}=detail;return preview;
};
const memberPath = (id: string) => `/v2/versions/${target.versionId}/objects/${id}`;
function fixture() {
  const content = JSON.parse(readFileSync(new URL('../../protocol/test/fixtures/recipe-rich-v2.content.json', import.meta.url), 'utf8')) as RecipeRichContent;
  const body = Buffer.from('角色说明😀');
  content.parts = [{kind: 'text', objectId: partId, sha256: hash(body), bytes: body.length, mediaType: 'text/plain;charset=utf-8'}];
  content.memories = [];
  content.role!.text = {kind:'part', objectId:partId};
  const doc = canonicalizeRichRecipeContent(content);
  const access: 'direct' | 'coded' = 'direct';
  const info = {name:content.public.name.value, summary:content.public.summary.value, overview:content.public.overview.value, version:content.public.version.value, access};
  const detail = {...target, format:'rich-v2', state:'listed', revision: 1, public: info, owned:false, acquired:true, hasDisplayLogo:false, visibility:'full',
    creator:{authorId:id(100),displayName:'作者'}, release:{...target, revision:1, format:'rich-v2', contentSha256:hash(doc.canonicalUTF8),
      authorId:id(100), access, logicalBytes:doc.logicalBytes},
    manifest: {objectId:manifestId, kind:'manifest', mediaType:'application/json', sha256:hash(doc.canonicalUTF8), bytes:doc.canonicalUTF8.length}};
  const dispatch = vi.fn(async (path: string, _init?: RequestInit): Promise<Response> => {
    if (path === browsePath()) return Response.json(browse(detail));
    if (path === detailPath()) return Response.json(detail);
    if (path === memberPath(manifestId)) return new Response(doc.canonicalUTF8);
    if (path === memberPath(partId)) return new Response(body);
    throw new Error('unexpected route');
  });
  let lease = new AbortController();
  const request = vi.fn<NativeAccount['request']>(async (actor, path, init, beforeSend) => {
    expect(actor).toBe(accountId);
    expect(init?.signal).toBe(lease.signal);
    expect(beforeSend).toBeTypeOf('function');
    await beforeSend!();
    return dispatch(path, init);
  });
  const account: NativeAccount = {lease: () => lease.signal,
    status: () => ({kind:'signedIn', accountId, displayName:'test', provider:'github', persistence:'memory'}),
    onStatus: () => () => {}, request, dispose: async () => {}, login: vi.fn(), cancelLogin: vi.fn(), logout: vi.fn()};
  const reader = recipeResourceReader(account);
  return {reader, detail, doc, body, dispatch, request, account, rotate: () => {lease = new AbortController();}};
}

it('checks exact entitlement before object reads, including public direct and coded introductions', async () => {
  for (const access of ['direct', 'coded']) {
    const f = fixture();
    const {manifest: _m, release, ...detail} = f.detail;
    f.dispatch.mockImplementation(async () => Response.json({...detail, acquired:false, owned:false, public:{...detail.public,access},
      ...(access === 'direct' ? {manifest: _m, release} : {visibility:'intro'})}));
    await expect(f.reader.readExact(accountId, target, check)).rejects.toMatchObject({code:'not_acquired'});
    expect(f.dispatch.mock.calls.map(c => c[0])).toEqual([detailPath()]);
  }
});

it('handoff reads only compact exact entitlement and never downloads a manifest or member',async()=>{
  const f=fixture();
  expect(await f.reader.previewExact(accountId,target,check)).toMatchObject({...target,acquired:true});
  expect(f.dispatch.mock.calls.map(([path])=>path)).toEqual([browsePath()]);
  f.detail.acquired=false;
  await expect(f.reader.previewExact(accountId,target,check)).rejects.toMatchObject({code:'not_acquired'});
  expect(f.dispatch.mock.calls.map(([path])=>path)).toEqual([browsePath(),browsePath()]);
});
it('abandons the compact handoff response when the native account lease changes',async()=>{
  const f=fixture(),original=f.dispatch.getMockImplementation()!;
  f.dispatch.mockImplementation(async(path,init)=>{const response=await original(path,init);f.rotate();return response;});
  await expect(f.reader.previewExact(accountId,target,check)).rejects.toMatchObject({code:'session_changed'});
  expect(f.dispatch.mock.calls.map(([path])=>path)).toEqual([browsePath()]);
});

it.each(['acquired', 'owned'] as const)('delivers an exactly %s, withdrawn coded release with only three private GETs', async grant => {
  const f = fixture();
  Object.assign(f.detail, {state:'withdrawn', acquired: false, owned:false, [grant]:true});
  Object.assign(f.detail.public, {access:'coded'}); Object.assign(f.detail.release, {access:'coded'});
  const snapshot = await f.reader.readExact(accountId, target, check);
  expect(snapshot).toMatchObject({target, format:'rich-v2', members:{[partId]: f.body.toString('base64url')}});
  const docs = await openResourceSnapshot(snapshot), page = docs.readPage({kind:'index'});
  if (page.kind !== 'index') throw new Error('index expected');
  expect(docs.readPage({kind:'text', documentId:page.entries.find(e => e.kind === 'role')!.documentId})).toMatchObject({text:'角色说明😀'});
  expect(f.dispatch.mock.calls.map(([path, init]) => [path, init?.method ?? 'GET'])).toEqual([
    [detailPath(), 'GET'], [memberPath(manifestId), 'GET'], [memberPath(partId), 'GET'],
  ]);
});
it.each(['withdrawn','blocked'])('preserves cloud %s refusal without loading or falling back', async state => {
  const f = fixture();
  f.dispatch.mockImplementation(async () => Response.json({state, versionId:target.versionId}));
  await expect(f.reader.readExact(accountId, target, check)).rejects.toMatchObject({code:state});
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});
it.each(['missingMember','corruptManifest','badMember','privateField','transport','wrongRelease'])('fails closed on %s and never probes v1', async mode => {
  const f = fixture(), original = f.dispatch.getMockImplementation()!;
  f.dispatch.mockImplementation(async (path, init) => {
    if (mode === 'transport') throw new Error('Bearer SECRET');
    if (mode === 'privateField' && path === detailPath()) return Response.json({...f.detail, privateUrl:'https://secret.invalid'});
    if (mode === 'wrongRelease' && path === detailPath()) return Response.json({...f.detail, release:{...f.detail.release, revision:9}});
    if (mode === 'missingMember' && path === memberPath(partId)) return new Response(null, {status:404});
    if (mode === 'corruptManifest' && path === memberPath(manifestId)) return new Response('bad');
    if (mode === 'badMember' && path === memberPath(partId)) return new Response(Buffer.alloc(f.body.length));
    return original(path, init);
  });
  await expect(f.reader.readExact(accountId, target, check)).rejects.toThrow('完整性核对');
  expect(f.dispatch.mock.calls.every(([path]) => path.startsWith('/v2/'))).toBe(true);
});
it('reads a legacy role only after an exact rich metadata 404 and requires its grant', async () => {
  const f = fixture();
  const role = {...target, public:f.detail.public, config:{role:'精确旧版本'}, revision:1, owned:false, acquired:false};
  f.dispatch.mockImplementation(async path => path === detailPath() ? new Response(null, {status:404}) : Response.json(role));
  await expect(f.reader.readExact(accountId, target, check)).rejects.toMatchObject({code:'not_acquired'});
  role.acquired = true;
  const snapshot = await f.reader.readExact(accountId, target, check);
  expect(snapshot).toMatchObject({format:'role-v1', config:role.config});
  expect(f.dispatch.mock.calls.map(c => c[0]).slice(-2)).toEqual([detailPath(), detailPath().replace('/v2/', '/v1/')]);
  await openResourceSnapshot(snapshot);
});
it('old ownership can read the old exact version; the legacy latest entitlement grants no right to a new release', async () => {
  const f = fixture(), original = f.dispatch.getMockImplementation()!;
  const newest = {...later, revision:2, format:'rich-v2', access:'direct', version:'v2', entitled:true};
  f.dispatch.mockImplementation(async (path, init) => {
    if (path.endsWith('latest-install-version')) return Response.json(newest);
    if (path === detailPath(later)) return Response.json({...f.detail, ...later, revision:2, acquired:false, release:{...f.detail.release,...later,revision:2}});
    return original(path, init);
  });
  expect(await f.reader.latest(accountId, target, 1, check)).toEqual({status:'newer', target:later, revision:2, format:'rich-v2', access:'direct', version:'v2'});
  expect(await f.reader.latest(accountId, later, 2, check)).toMatchObject({status:'current'});
  expect(await f.reader.latest(accountId, later, 3, check)).toEqual({status:'unknown'});
  await expect(f.reader.readExact(accountId, later, check)).rejects.toMatchObject({code:'not_acquired'});
  expect((await f.reader.readExact(accountId, target, check)).target).toEqual(target);
});
it('never dispatches a cross-recipe claim or a coded claim without a code', async () => {
  const f = fixture();
  f.dispatch.mockImplementation(async () => Response.json({...f.detail, recipeId:id(999)}));
  expect(await f.reader.acquireExact(accountId, target, key, check)).toEqual({ok:false, error:{code:'unavailable'}});
  const {manifest: _m, release: _r, ...intro} = f.detail;
  f.dispatch.mockImplementation(async () => Response.json({...browse(intro), public:{...intro.public, access:'coded'}, acquired:false}));
  expect(await f.reader.acquireExact(accountId, target, key, check)).toEqual({ok:false, error:{code:'invalid_code'}});
  expect(f.dispatch.mock.calls.map(c => c[0])).toEqual([browsePath(),browsePath()]);
});
it('replays exactly the same acquisition key after unknown post outcome; validates response identity and retryAfter', async () => {
  const f = fixture();
  f.detail.acquired = false;
  const writes: string[] = [];
  const value = {...target, owned:false, acquired:true};
  f.dispatch.mockImplementation(async (path, init) => {
    if (path === browsePath()) return Response.json(browse(f.detail));
    expect(path).toBe('/v2/versions/' + target.versionId + '/acquire');
    expect(init?.method).toBe('POST'); expect(init?.body).toBe('{}');
    writes.push(new Headers(init?.headers).get('Idempotency-Key')!);
    if (writes.length === 1) {f.detail.acquired = true; throw new Error('response lost');}
    if (writes.length === 3) return Response.json({error:{code:'rate_limited'}}, {status:429, headers:{'retry-after':'23'}});
    if (writes.length === 4) return Response.json({...value, recipeId:id(999)});
    return Response.json(value);
  });
  expect(await f.reader.acquireExact(accountId, target, key, check)).toEqual({ok:false,error:{code:'unavailable'}});
  expect(await f.reader.acquireExact(accountId, target, key, check)).toEqual({ok:true,value});
  expect(await f.reader.acquireExact(accountId, target, key, check)).toEqual({ok:false,error:{code:'rate_limited',retryAfter:23}});
  expect(await f.reader.acquireExact(accountId, target, key, check)).toEqual({ok:false,error:{code:'unavailable'}});
  expect(writes).toEqual([key,key,key,key]);
});
it.each([detailPath(),memberPath(manifestId),memberPath(partId)])('rechecks lease identity after the response for %s, even on same-account re-entry', async at => {
  const f = fixture(), original = f.dispatch.getMockImplementation()!;
  f.dispatch.mockImplementation(async (path, init) => {
    const data = await original(path, init);
    if (path === at) f.rotate();
    return data;
  });
  await expect(f.reader.readExact(accountId, target, check)).rejects.toMatchObject({code:'session_changed'});
  expect(f.dispatch.mock.calls.at(-1)![0]).toBe(at);
});
it('checks the exact live connection after token refresh and before sending an account write', async () => {
  const f = fixture();
  let connected = true;
  f.request.mockImplementation(async (_actor, path, init, beforeSend) => {
    if (init?.method === 'POST') connected = false;
    await beforeSend!();
    return f.dispatch(path, init);
  });
  await expect(f.reader.acquireExact(accountId, target, key, () => {if (!connected) throw new Error('connection changed');}))
    .rejects.toMatchObject({code:'session_changed'});
  expect(f.dispatch.mock.calls.map(c => c[0])).toEqual([browsePath()]);
});
it('checks connection changes during the body stream and same-account lease replacement after a submitted claim', async () => {
  const f = fixture(), original = f.dispatch.getMockImplementation()!;
  f.dispatch.mockImplementation(async (path, init) => {
    if (path !== memberPath(partId)) return original(path, init);
    let first = true;
    return new Response(new ReadableStream<Uint8Array>({pull(controller) {
      if (first) {first = false; controller.enqueue(f.body.subarray(0, 3));}
      else {f.rotate(); controller.enqueue(f.body.subarray(3)); controller.close();}
    }}));
  });
  await expect(f.reader.readExact(accountId, target, check)).rejects.toMatchObject({code:'session_changed'});
  f.dispatch.mockImplementation(async (path, init) => {
    if (init?.method !== 'POST') return original(path, init);
    f.rotate();
    return Response.json({...target, acquired:true, owned:false});
  });
  await expect(f.reader.acquireExact(accountId, target, key, check)).rejects.toMatchObject({code:'session_changed'});
});
