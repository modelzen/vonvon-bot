import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {canonicalizeRichRecipeContent,type RecipeRichContent,type AccountStatus} from '@vonvon/protocol';
import {communityRequest} from '../src/community-api';
import type {NativeAccount} from '../src/account-session';
const accountId='11111111-1111-4111-8111-111111111111',recipeId='22222222-2222-4222-8222-222222222222',versionId='33333333-3333-4333-8333-333333333333',objectId='44444444-4444-4444-8444-444444444444';
function fixture() {
  const content=JSON.parse(readFileSync(new URL('../../protocol/test/fixtures/recipe-rich-v2.content.json',import.meta.url),'utf8')) as RecipeRichContent;
  content.parts=[];content.memories=[];delete content.finalLogo;
  const doc=canonicalizeRichRecipeContent(content),hash=createHash('sha256').update(doc.canonicalUTF8).digest('hex');
  const publicInfo={name:content.public.name.value,summary:content.public.summary.value,overview:content.public.overview.value,version:content.public.version.value,access:'direct' as const};
  const release={format:'rich-v2',recipeId,versionId,authorId:accountId,revision:1,access:'direct',logicalBytes:doc.logicalBytes,contentSha256:hash};
  const detail={format:'rich-v2',recipeId,versionId,revision:1,public:publicInfo,creator:{authorId:accountId,displayName:'公开作者'},state:'listed',visibility:'full',owned:false,acquired:false,hasDisplayLogo:false,
    manifest:{objectId,kind:'manifest',sha256:hash,bytes:doc.canonicalUTF8.length,mediaType:'application/json'},release};
  const request=vi.fn(async(path:string)=>path.endsWith('/objects/'+objectId)?new Response(doc.canonicalUTF8):Response.json(detail));
  const account:NativeAccount={status:()=>({kind:'signedOut'}),onStatus:()=>()=>{},login:async()=>({kind:'signedOut'}),logout:async()=>({kind:'signedOut'}),cancelLogin:async()=>({kind:'signedOut'}),dispose:async()=>{},request:async(_account,path)=>request(path),publicRequest:request};
  return {account,request,content,detail,doc};
}
it('loads exact rich release bytes, retains every portable field and exposes only public creator data',async()=>{
  const f=fixture(),value=await communityRequest(f.account,{type:'detail',recipeId,versionId});
  expect(value.rich?.content).toEqual(f.content);expect(value.config).toBeUndefined();expect(value.creator?.displayName).toBe('公开作者');
  expect(value.rich?.canonical).toBe(Buffer.from(f.doc.canonicalUTF8).toString('base64url'));
});
it('does not fetch any manifest or private content for coded introduction',async()=>{
  const f=fixture();const {manifest:_m,release:_r,...intro}=f.detail;
  f.request.mockResolvedValue(Response.json({...intro,public:{...intro.public,access:'coded'},visibility:'intro'}));
  const value=await communityRequest(f.account,{type:'detail',recipeId,versionId});expect(value.rich).toBeUndefined();expect(value.config).toBeUndefined();expect(f.request).toHaveBeenCalledOnce();
});
it('refuses tampered canonical bytes and redacts transport errors and malformed creator fields',async()=>{
  for(const mode of ['bytes','creator','transport']){
    const f=fixture();
    if(mode==='bytes')f.request.mockImplementation(async path=>path.includes('/objects/')?new Response('x'.repeat(f.doc.canonicalUTF8.length)):Response.json(f.detail));
    if(mode==='creator')f.request.mockResolvedValue(Response.json({...f.detail,creator:{...f.detail.creator,email:'private@example.com'}}));
    if(mode==='transport')f.request.mockRejectedValue(new Error('Bearer SECRET'));
    await expect(communityRequest(f.account,{type:'detail',recipeId,versionId})).rejects.toThrow('社区请求未完成');
  }
});
it('reads mixed account library without dropping existing role recipes',async()=>{
  const f=fixture();const state:AccountStatus={kind:'signedIn',accountId,provider:'github',displayName:'Owner',persistence:'memory'};f.account.status=()=>state;
  const legacy={recipeId,versionId,revision:1,format:'role-v1',public:f.detail.public};
  const rich={...legacy,versionId:objectId,format:'rich-v2',creator:f.detail.creator,hasDisplayLogo:false};
  f.request.mockResolvedValue(Response.json({items:[legacy,rich],nextCursor:null}));
  expect((await communityRequest(f.account,{type:'library',accountId})).items).toEqual([legacy,rich]);
  expect(f.request).toHaveBeenCalledWith('/v2/me/recipes');
});

it('retries the exact reviewed rich publication without rereading a draft already retired by the first commit',async()=>{
  const f=fixture();f.account.status=()=>({kind:'signedIn',accountId,displayName:'Owner',provider:'github',persistence:'memory'});
  const request=vi.fn(async(_id:string,path:string,init?:RequestInit)=>{expect(path).toBe('/v2/drafts/'+objectId+'/publish');expect(init?.body).toBe(JSON.stringify({canonical:Buffer.from(f.doc.canonicalUTF8).toString('base64url')}));return Response.json({format:'rich-v2',recipeId,versionId,revision:1,public:f.detail.public});});
  f.account.request=request;
  const input={type:'publishDraft' as const,format:'rich-v2' as const,canonical:Buffer.from(f.doc.canonicalUTF8).toString('base64url'),accountId,draftId:objectId,revision:1,requestId:objectId};
  await communityRequest(f.account,input);await communityRequest(f.account,input);expect(request).toHaveBeenCalledTimes(2);expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
});
it('rejects metadata that disagrees with the verified content and reports lifecycle refusals distinctly',async()=>{
  const f=fixture();f.request.mockImplementation(async path=>path.includes('/objects/')?new Response(f.doc.canonicalUTF8):Response.json({...f.detail,public:{...f.detail.public,name:'Wrong title'}}));
  await expect(communityRequest(f.account,{type:'detail',recipeId,versionId})).rejects.toThrow('社区请求未完成');
  for(const state of ['withdrawn','blocked']){f.request.mockResolvedValue(Response.json({state,versionId}));await expect(communityRequest(f.account,{type:'detail',recipeId,versionId})).rejects.toThrow(state==='withdrawn'?'作者已撤下':'平台停止分发');}
});

it.each(['library','publications'] as const)('loads bounded public logos for %s without losing entries when the image is unavailable',async type=>{
  const f=fixture();f.account.status=()=>({kind:'signedIn',accountId,displayName:'Owner',provider:'github',persistence:'memory'});
  const item={format:'rich-v2',recipeId,versionId,revision:1,public:f.detail.public,hasDisplayLogo:true};let missing=false;
  f.request.mockImplementation(async path=>path.endsWith('/display-logo')?missing?new Response(null,{status:404}):new Response(new Uint8Array([1,2,3])):Response.json({items:[item],...(type==='library'?{nextCursor:null}:{})}));
  expect((await communityRequest(f.account,{type,accountId})).items[0]?.logo).toBe('data:image/webp;base64,AQID');
  missing=true;expect((await communityRequest(f.account,{type,accountId})).items[0]).toEqual(item);
});

it.each(['🦉'.repeat(31), '🦉'.repeat(60), '\u3000作者\u3000'])('preserves a valid saved public name through the actual rich detail boundary', async displayName => {
  const f = fixture();
  f.account.status = () => ({kind: 'signedIn', accountId, displayName: 'Login', provider: 'github', persistence: 'memory'});
  const creator = {authorId: accountId, displayName};
  f.account.request = async (_id, path) => path === '/v2/me/profile' ? Response.json(creator) : f.request(path);
  const saved = await communityRequest(f.account, {type: 'saveProfile', accountId, requestId: objectId, displayName});
  f.detail.creator = saved;
  expect((await communityRequest(f.account, {type: 'profile', accountId})).displayName).toBe(displayName);
  expect((await communityRequest(f.account, {type: 'detail', recipeId, versionId})).creator).toEqual(creator);
});
it.each(['🦉'.repeat(60), '\u3000作者\u3000'])('uses the same public name rule for catalog, library, publications and legacy detail', async displayName => {
  const f = fixture();
  f.account.status = () => ({kind: 'signedIn', accountId, displayName: 'Login', provider: 'github', persistence: 'memory'});
  const creator = {authorId: accountId, displayName};
  const item = {recipeId, versionId, revision: 1, public: f.detail.public, creator};
  f.request.mockImplementation(async path => {
    if (path.startsWith('/v2/community/recipes')) return Response.json({heroKind: 'latest', hero: item, items: [item], nextCursor: null});
    if (path === '/v2/me/recipes') return Response.json({items: [item], nextCursor: null});
    if (path === '/v2/me/publications') return Response.json({items: [item]});
    if (path.startsWith('/v2/recipes/')) return new Response(null, {status: 404});
    return Response.json({...item, owned: false, acquired: false, public: {...item.public, access: 'coded'}});
  });
  expect((await communityRequest(f.account, {type: 'catalog'})).items[0]?.creator).toEqual(creator);
  expect((await communityRequest(f.account, {type: 'library', accountId})).items[0]?.creator).toEqual(creator);
  expect((await communityRequest(f.account, {type: 'publications', accountId})).items[0]?.creator).toEqual(creator);
  expect((await communityRequest(f.account, {type: 'detail', recipeId, versionId})).creator).toEqual(creator);
});

it('retains author withdrawal state while verifying the retained full release', async () => {
  const f=fixture();
  f.request.mockImplementation(async path=>path.includes('/objects/')?new Response(f.doc.canonicalUTF8):Response.json({...f.detail,state:'withdrawn',owned:true}));
  const value=await communityRequest(f.account,{type:'detail',recipeId,versionId});
  expect(value.state).toBe('withdrawn');expect(value.owned).toBe(true);expect(value.rich?.content).toEqual(f.content);
});
it('withdraws only through the authenticated v2 author endpoint and validates the void receipt', async () => {
  const f=fixture();f.account.status=()=>({kind:'signedIn',accountId,displayName:'Owner',provider:'github',persistence:'memory'});
  const request=vi.fn(async()=>Response.json(''));f.account.request=request;
  expect(await communityRequest(f.account,{type:'withdraw',accountId,versionId})).toBe('');
  expect(request).toHaveBeenCalledWith(accountId,`/v2/versions/${versionId}/withdraw`,expect.objectContaining({method:'POST',body:'{}'}));
  request.mockResolvedValue(Response.json({success:true}));
  await expect(communityRequest(f.account,{type:'withdraw',accountId,versionId})).rejects.toThrow('社区请求未完成');
});
