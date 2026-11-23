import {createHash,randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {canonicalizeRichRecipeContent,type RecipeRichContent} from '@vonvon/protocol';
import type {NativeAccount} from '../src/account-session';
import {inheritedPublication} from '../src/recipe-publication-inheritance';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
  const accountId=randomUUID(),recipeId=randomUUID(),versionId=randomUUID(),manifestId=randomUUID(),logoId=randomUUID();
  const field=(value:string)=>({itemId:randomUUID(),originId:randomUUID(),value});
  const logo=Buffer.from('524946460e000000574542505650384c020000002f00','hex');
  const content:RecipeRichContent={format:'rich-v2',schemaVersion:2,public:{name:field('帮助反馈'),summary:field('摘要'),overview:field('# 介绍\n完整说明'),version:field('第一版')},
    finalLogo:{itemId:randomUUID(),originId:randomUUID(),objectId:logoId},parts:[{objectId:logoId,kind:'finalLogo',mediaType:'image/webp',bytes:logo.length,sha256:sha(logo)}],settings:[],skills:[],files:[],tasks:[],memories:[],rules:[],setup:[]};
  const doc=canonicalizeRichRecipeContent(content),publicInfo={name:content.public.name.value,summary:content.public.summary.value,overview:content.public.overview.value,version:'第一版',access:'coded' as const};
  const detail={format:'rich-v2',recipeId,versionId,revision:4,public:publicInfo,creator:{authorId:accountId,displayName:'本人'},state:'listed',visibility:'full',owned:true,acquired:true,hasDisplayLogo:true,
    manifest:{objectId:manifestId,kind:'manifest',sha256:sha(doc.canonicalUTF8),bytes:doc.canonicalUTF8.length,mediaType:'application/json'},
    release:{format:'rich-v2',recipeId,versionId,authorId:accountId,revision:4,access:'coded',logicalBytes:doc.logicalBytes,contentSha256:sha(doc.canonicalUTF8)}};
  let member=logo,authorId=accountId;
  const request=vi.fn(async(id:string,path:string)=>{
    expect(id).toBe(accountId);
    if(path.endsWith('/source-items'))return Response.json({versionId,authorId,access:'coded',items:[]});
    if(path==='/v2/me/publications')return Response.json({items:[{recipeId,versionId,revision:4,public:publicInfo}]});
    if(path.endsWith('/objects/'+manifestId))return new Response(doc.canonicalUTF8);
    if(path.endsWith('/objects/'+logoId))return new Response(member);
    if(path===`/v2/recipes/${recipeId}/versions/${versionId}`)return Response.json(detail);
    throw Error(path);
  });
  const account={lease:()=>new AbortController().signal,request} as unknown as NativeAccount;
  return {account,accountId,recipeId,versionId,content,logo,detail,request,tamper:()=>{member=Buffer.from('wrong');},other:()=>{authorId=randomUUID();}};
}
it('inherits verified owned public fields, coded access and exact logo bytes while clearing display version',async()=>{
  const f=fixture(),before=JSON.stringify(f.content);
  const inherited=await inheritedPublication(f.account,f.accountId,f.recipeId,f.versionId,()=>{});
  expect(inherited).toEqual({accountId:f.accountId,versionId:f.versionId,public:{name:'帮助反馈',summary:'摘要',overview:'# 介绍\n完整说明',version:''},access:'coded',logo:f.logo.toString('base64url')});
  expect(JSON.stringify(f.content)).toBe(before);
});
it('refuses other authors, stale accounts, unowned snapshots and corrupted logo bytes',async()=>{
  const other=fixture();other.other();await expect(inheritedPublication(other.account,other.accountId,other.recipeId,other.versionId,()=>{})).rejects.toThrow('本人');
  expect(other.request).toHaveBeenCalledOnce();
  const stale=fixture();stale.account.lease=()=>undefined;await expect(inheritedPublication(stale.account,stale.accountId,stale.recipeId,stale.versionId,()=>{})).rejects.toThrow('账号');
  const unowned=fixture();unowned.detail.owned=false;await expect(inheritedPublication(unowned.account,unowned.accountId,unowned.recipeId,unowned.versionId,()=>{})).rejects.toThrow('来源版本');
  const corrupt=fixture();corrupt.tamper();await expect(inheritedPublication(corrupt.account,corrupt.accountId,corrupt.recipeId,corrupt.versionId,()=>{})).rejects.toThrow();
});

it('does not read unrelated publication history when preparing a known version',async()=>{
 const f=fixture();
 await inheritedPublication(f.account,f.accountId,f.recipeId,f.versionId,()=>{});
 expect(f.request.mock.calls.some(([,path])=>path==='/v2/me/publications')).toBe(false);
});

it('strictly requires recipe and version IDs together for a renderer parent',async()=>{
 const {desktopAuthoringRequestSchema}=await import('@vonvon/protocol');
 const f=fixture(),request={type:'beginHandoff',handle:randomUUID(),retryId:randomUUID(),groupId:'oc_test',source:{recipeId:f.recipeId,versionId:f.versionId}};
 expect(desktopAuthoringRequestSchema.safeParse(request).success).toBe(true);
 expect(desktopAuthoringRequestSchema.safeParse({...request,source:{versionId:f.versionId}}).success).toBe(false);
 expect(desktopAuthoringRequestSchema.safeParse({...request,sourceVersionId:f.versionId}).success).toBe(false);
 await expect(inheritedPublication(f.account,f.accountId,randomUUID(),f.versionId,()=>{})).rejects.toThrow();
});
