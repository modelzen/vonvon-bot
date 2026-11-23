import {z} from 'zod';
import {communityResponseSchemas,recipeDraftSchema,recipePublicSchema,richMetadataInputDigest,richMetadataReceiptSchema,type RichMetadataRequest,type CreatorAnswer,type CreatorVersion} from '@vonvon/protocol';
import type {NativeAccount} from './account-session.js';
import {boundedJson} from './community-response.js';
import {richCommunity,MissingRichRecipe} from './community-rich.js';
import {creatorSha,type CreatorCommandRecord} from './recipe-creator-journal.js';

const uuid=z.string().uuid(),positive=z.number().int().positive().max(2147483647);
const publication=z.object({status:z.literal('committed'),receipt:z.object({requestId:uuid,format:z.enum(['role-v1','rich-v2']),draftId:uuid,
  draftRevision:positive,recipeId:uuid,versionId:uuid,revision:positive,public:recipePublicSchema,firstCodeId:uuid.nullable()}).strict()}).strict();
const issuance=z.object({status:z.literal('committed'),receipt:z.object({requestId:uuid,versionId:uuid,count:z.number().int().min(1).max(100),codeIds:uuid.array().min(1).max(100)}).strict()}).strict();
const unknown=z.object({status:z.literal('unknown')}).strict();
export class CreatorCloudRejected extends Error {constructor(readonly code:string){super('配方操作未获云端接受');}}
export async function creatorJson(account:NativeAccount,accountId:string,path:string,init:RequestInit={},cap=2*1024*1024){
  const response=await account.request(accountId,path,init);
  const value=await boundedJson(response,cap);
  if(!response.ok){const failure=z.object({error:z.object({code:z.string()})}).safeParse(value);
    if(response.status>=400&&response.status<500&&failure.success)throw new CreatorCloudRejected(failure.data.error.code);
    throw new Error('配方结果尚未确认');}
  return value;
}
export async function creatorDraft(account:NativeAccount,accountId:string,draftId:string,check:()=>void){
  try{return await richCommunity(account,accountId,check).draft(draftId);}
  catch(error){if(!(error instanceof MissingRichRecipe))throw error;}
  return recipeDraftSchema.parse(await creatorJson(account,accountId,'/v1/drafts/'+uuid.parse(draftId)));
}
export async function publicationReceipt(account:NativeAccount,row:CreatorCommandRecord):Promise<CreatorAnswer|undefined>{
  const r=row.request;if(r.type!=='publishDraft'||row.command.kind!=='publish')throw new Error('发布请求不一致');
  const snapshot=row.command.snapshot;
  const query=new URLSearchParams({draftId:r.draftId,revision:String(r.revision)});
  if(snapshot.format==='rich-v2')query.set('contentSha256',snapshot.contentSha256);
  const raw=await creatorJson(account,r.accountId,`/${snapshot.format==='rich-v2'?'v2':'v1'}/receipts/publications/${row.id}?${query}`);
  if(unknown.safeParse(raw).success)return;
  const {receipt}=publication.parse(raw);
  if(receipt.requestId!==row.id||receipt.format!==snapshot.format||receipt.draftId!==r.draftId||receipt.draftRevision!==r.revision||
    JSON.stringify(receipt.public)!==JSON.stringify(snapshot.public)||(snapshot.recipeId&&snapshot.recipeId!==receipt.recipeId)||
    (snapshot.public.access==='coded')!==(receipt.firstCodeId!==null))throw new Error('发布回执与原请求不一致');
  return {kind:'published',target:{recipeId:receipt.recipeId,versionId:receipt.versionId},draftId:r.draftId,draftRevision:r.revision,
    revision:receipt.revision,firstCodeId:receipt.firstCodeId,url:z.string().url().parse(account.recipeLink?.(receipt.recipeId,receipt.versionId))};
}
export async function issueReceipt(account:NativeAccount,row:CreatorCommandRecord):Promise<CreatorAnswer|undefined>{
  const r=row.request;if(r.type!=='issueCodes'||row.command.kind!=='issue')throw new Error('发码请求不一致');
  const raw=await creatorJson(account,r.accountId,`/v1/receipts/code-issuance/${row.id}?`+new URLSearchParams({versionId:r.versionId,count:String(r.count)}));
  if(unknown.safeParse(raw).success)return;
  const {receipt}=issuance.parse(raw);
  if(receipt.requestId!==row.id||receipt.versionId!==r.versionId||receipt.count!==r.count||receipt.codeIds.length!==r.count||
    new Set(receipt.codeIds).size!==r.count)throw new Error('发码回执与原请求不一致');
  return {kind:'issued',target:row.command.target,codeIds:receipt.codeIds};
}
export async function creatorCodes(account:NativeAccount,accountId:string,target:CreatorVersion,cursor?:string){
  return communityResponseSchemas.codes.parse(await creatorJson(account,accountId,`/v1/versions/${target.versionId}/codes`+(cursor?'?cursor='+cursor:'')));
}

export function verifyMetadataReceipt(request:RichMetadataRequest,receipt:z.infer<typeof richMetadataReceiptSchema>){
  if(receipt.requestId!==request.requestId||receipt.draftId!==request.draftId||receipt.revision!==request.revision+1)
    throw new Error('保存回执与原请求不一致');
  return receipt;
}
export async function metadataReceipt(account:NativeAccount,r:RichMetadataRequest){
  const input={transformVersion:1 as const,baseManifestSha256:r.baseManifestSha256,public:r.public,
    logo:r.logo.kind==='replace'?{kind:'replace' as const,inputSha256:creatorSha(Buffer.from(r.logo.base64,'base64'))}:r.logo};
  const query=new URLSearchParams({draftId:r.draftId,revision:String(r.revision),baseManifestSha256:r.baseManifestSha256,
    transformVersion:'1',inputSha256:await richMetadataInputDigest(input)});
  const raw=await creatorJson(account,r.accountId,`/v2/receipts/metadata/${r.requestId}?${query}`);
  if(unknown.safeParse(raw).success)return;
  const {receipt}=z.object({status:z.literal('committed'),receipt:richMetadataReceiptSchema}).strict().parse(raw);
  return verifyMetadataReceipt(r,receipt);
}
