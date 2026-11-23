import {createHash} from 'node:crypto';
import type {InheritedPublication} from '@vonvon/protocol';
import type {NativeAccount} from './account-session.js';
import {richCommunity} from './community-rich.js';
import {communityRequest} from './community-api.js';
import {AuthoringError} from './recipe-authoring-cloud.js';
import {richAuthoringCloud,UnavailableSourceItems} from './recipe-authoring-rich-cloud.js';

export class UnsupportedLegacyPublication extends AuthoringError {
  constructor(action:'parent'|'withdraw'){super(action==='parent'?'这个旧格式版本暂不支持直接准备新版。可继续管理原版本，或从群配置创建一份独立配方。':'这个旧格式版本暂不支持撤下。请继续使用原版本的分享码管理。');}
}

export async function inheritedPublication(account:NativeAccount,accountId:string,recipeId:string,versionId:string,check:()=>void):Promise<InheritedPublication>{
  const signal=account.lease?.(accountId);
  if(!signal)throw new Error('请重新核对当前账号。');
  let attested;
  try{attested=await richAuthoringCloud(account,accountId,signal,check).sourceItems(versionId);}
  catch(error){
    if(error instanceof UnavailableSourceItems){
      const legacy=await communityRequest(account,{type:'detail',accountId,recipeId,versionId});check();
      if(legacy.owned&&legacy.format!=='rich-v2')throw new UnsupportedLegacyPublication('parent');
    }
    throw error;
  }
  if(attested.authorId!==accountId)throw new Error('只能从本人发布的版本准备新版。');
  const community=richCommunity(account,accountId,check);
  const detail=await community.detail(recipeId,versionId);
  check();
  if(!detail.owned||detail.creator?.authorId!==accountId||!detail.rich||detail.public.access!==attested.access)
    throw new Error('来源版本无法核对，请重新准备。');
  const finalLogo=detail.rich.content.finalLogo;
  let logo:string|undefined;
  if(finalLogo){
    const descriptor=detail.rich.content.parts.find(part=>part.objectId===finalLogo.objectId&&part.kind==='finalLogo');
    if(!descriptor||!detail.logo?.startsWith('data:image/webp;base64,'))
      throw new Error('来源 Logo 无法核对。');
    const encoded=detail.logo.slice('data:image/webp;base64,'.length),bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded||bytes.length!==descriptor.bytes||bytes.length>131072||createHash('sha256').update(bytes).digest('hex')!==descriptor.sha256)
      throw new Error('来源 Logo 无法核对。');
    logo=bytes.toString('base64url');
  }
  const {name,summary,overview,access}=detail.public;
  return {accountId,versionId,public:{name,summary,overview,version:''},access,...(logo&&{logo})};
}
