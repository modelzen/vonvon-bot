import {createHash} from 'node:crypto';
import {communityRequestSchema,type CommunityRequest,type CommunityResponses} from '@vonvon/protocol';
import type {NativeAccount} from './account-session.js';
import {LocalRecipeDraftError,LocalRecipeDrafts} from './local-recipe-drafts.js';
import {applyLocalMetadata} from './local-recipe-content.js';

type LocalType='drafts'|'draft'|'saveDraft'|'deleteDraft'|'publishDraft'|'saveRichDraftMetadata'|'recoverRichDraftMetadata';
export type LocalRecipeCommunityRequest=Extract<CommunityRequest,{type:LocalType}>;
export function localRecipeRequestSha256(request:LocalRecipeCommunityRequest){
  return createHash('sha256').update(JSON.stringify(communityRequestSchema.parse(request))).digest('hex');
}
export function isLocalRecipeCommunityRequest(request:CommunityRequest):request is LocalRecipeCommunityRequest{
  return ['drafts','draft','saveDraft','deleteDraft','publishDraft','saveRichDraftMetadata','recoverRichDraftMetadata'].includes(request.type);
}
export function localRecipeCommunity<T extends LocalType>(account:NativeAccount,drafts:LocalRecipeDrafts,
  request:Extract<LocalRecipeCommunityRequest,{type:T}>,normalizeLogo?:(bytes:Buffer)=>Promise<Buffer>):Promise<CommunityResponses[T]>;
export async function localRecipeCommunity(account:NativeAccount,drafts:LocalRecipeDrafts,
  request:LocalRecipeCommunityRequest,normalizeLogo?:(bytes:Buffer)=>Promise<Buffer>):Promise<CommunityResponses[LocalType]>{
  const lease=account.lease?.(request.accountId);
  const check=()=>{const status=account.status();if(!lease||lease.aborted||account.lease?.(request.accountId)!==lease||status.kind!=='signedIn'||status.accountId!==request.accountId)
    throw new LocalRecipeDraftError('invalid_input','账号已切换，请重新打开本地草稿。');};
  check();
  const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
  if(request.type==='drafts')return {items:drafts.list(request.accountId).map(row=>row.draft)} as CommunityResponses[LocalType];
  if(request.type==='publishDraft')throw new LocalRecipeDraftError('invalid_input','请在 Bot 核对本地草稿并明确确认发布。');
  const draftId=request.type==='saveDraft'?(request.target.kind==='existing'?request.target.draftId:undefined):request.draftId;
  if(!draftId)throw new LocalRecipeDraftError('invalid_input','请从 Bot 的创作入口开始本地草稿。');
  if(request.type==='deleteDraft'){
    drafts.discard({accountId:request.accountId,draftId,requestId:request.requestId,expectedRevision:request.revision});
    return {draftId,deleted:true} as CommunityResponses[LocalType];
  }
  const record=drafts.read(request.accountId,draftId);
  if(!record)throw new LocalRecipeDraftError('not_found','这份本地草稿不存在，旧云草稿不会自动导入。');
  if(request.type==='draft')return record.draft as CommunityResponses[LocalType];
  if(request.type==='recoverRichDraftMetadata'){
    if(record.draft.format!=='rich-v2')return {status:'rejected',code:'not_found'} as CommunityResponses[LocalType];
    return {status:'current',draft:record.draft} as CommunityResponses[LocalType];
  }
  const requestSha256=localRecipeRequestSha256(request),receipt=drafts.receipt(request.accountId,draftId,request.requestId);
  if(receipt&&receipt.requestSha256!==requestSha256){
    if(request.type==='saveRichDraftMetadata')return {status:'rejected',code:'conflict'} as CommunityResponses[LocalType];
    throw new LocalRecipeDraftError('conflict','同一次保存请求不能替换内容。');
  }
  if(request.type==='saveRichDraftMetadata'){
    try{
      if(!receipt&&(record.draft.format!=='rich-v2'||record.draft.revision!==request.revision||
        sha(Buffer.from(record.draft.rich.canonical,'base64url'))!==request.baseManifestSha256))
        throw new LocalRecipeDraftError('conflict','本地草稿已有后续修改。');
      let committed=receipt;
      if(!committed){
        const next=await applyLocalMetadata(record,request,async bytes=>{check();if(!normalizeLogo)throw new Error('本地图片处理不可用。');const result=await normalizeLogo(bytes);check();return result;});
        check();committed=drafts.commit({requestId:request.requestId,requestSha256,expectedRevision:request.revision,record:next});
      }
      check();const current=drafts.read(request.accountId,draftId);
      return {status:'committed',receipt:{requestId:request.requestId,draftId,revision:committed.revision,manifestSha256:committed.contentSha256},
        ...(current?.draft.format==='rich-v2'&&current.draft.revision===committed.revision?{draft:current.draft}:{})} as CommunityResponses[LocalType];
    }catch(error){
      if(error instanceof LocalRecipeDraftError&&['conflict','not_found','invalid_input'].includes(error.code))return {status:'rejected',code:error.code} as CommunityResponses[LocalType];
      throw error;
    }
  }
  if(record.draft.format==='rich-v2'||request.target.kind!=='existing')throw new LocalRecipeDraftError('invalid_input','草稿格式不匹配。');
  if(receipt){if(record.draft.revision!==receipt.revision)throw new LocalRecipeDraftError('conflict','草稿已有后续修改，请重新读取。');return record.draft as CommunityResponses[LocalType];}
  const next={...record,draft:{...record.draft,revision:request.target.revision+1,public:request.public,config:request.config}};
  check();drafts.commit({requestId:request.requestId,requestSha256,expectedRevision:request.target.revision,record:next});
  return next.draft as CommunityResponses[LocalType];
}
