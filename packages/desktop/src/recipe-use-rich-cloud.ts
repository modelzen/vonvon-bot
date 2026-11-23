import {richCloudDetailSchema} from './community-rich.js';
import {createHash} from 'node:crypto';
import {recipeRichInstallPreviewSchema,recipeRichInstallAuthorizationSchema,verifyRichRecipeRelease} from '@vonvon/protocol';
import type {NativeAccount} from './account-session.js';
import type {RecipeAccountLease} from './recipe-use-cloud.js';
import {RecipeUseError,Unredeemable} from './recipe-use-cloud.js';
import type {RecipeJournalRow} from './recipe-use-journal.js';
const invalid = () => new RecipeUseError('富配方资料与目标版本不一致，请重新核对。');
export function richUseCloud(account:NativeAccount,lease:RecipeAccountLease) {
  async function read(path:string, cap:number, body?:object) {
    lease.check();
    let res:Response;
    try {res=await account.request(lease.accountId,path,{signal:lease.signal,...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})},lease.check);}
    catch {lease.check();throw new RecipeUseError('云端尚未确认本次富配方操作，请稍后恢复原操作。');}
    lease.check();
    if (!res.ok) {await res.body?.cancel(); if ([404,409,410].includes(res.status)) throw new Unredeemable(); throw new RecipeUseError('云端尚未确认本次富配方操作，请稍后恢复原操作。');}
    if(!res.body)throw invalid();
    const chunks:Uint8Array[]=[];let bytes=0;const reader=res.body.getReader();
    try {for(;;){const {done,value}=await reader.read();lease.check();if(done)break;if((bytes+=value.byteLength)>cap)throw invalid();chunks.push(value);}}
    finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    return Buffer.concat(chunks);
  }
  async function json(path:string,body?:object){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await read(path,2097152,body))) as unknown;}
  return {
    async preview(recipeId:string,versionId:string){
      let preview;let authority:'exactVersion'|'directUpdate'='exactVersion';
      try {preview=recipeRichInstallPreviewSchema.parse(await json(`/v2/versions/${versionId}/install-preview`));}
      catch {lease.check();authority='directUpdate';const detail=richCloudDetailSchema.parse(await json(`/v2/recipes/${recipeId}/versions/${versionId}`));if(detail.visibility!=='full'||detail.public.access!=='direct'||!detail.release||!detail.manifest)throw invalid();preview={accountId:lease.accountId,release:detail.release,manifest:detail.manifest};}
      if(preview.accountId!==lease.accountId||preview.release.recipeId!==recipeId||preview.release.versionId!==versionId)throw invalid();
      const object=async(descriptor:{objectId:string;sha256:string;bytes:number})=>{const value=await read(`/v2/versions/${versionId}/objects/${descriptor.objectId}`,descriptor.bytes);if(value.byteLength!==descriptor.bytes||createHash('sha256').update(value).digest('hex')!==descriptor.sha256)throw invalid();return value;};
      const bytes=await object(preview.manifest),doc=await verifyRichRecipeRelease(preview.release,bytes),parts:Record<string,string>={};
      for(const part of doc.content.parts)parts[part.objectId]=(await object(part)).toString('base64url');
      lease.check();return {preview,canonical:bytes.toString('utf8'),parts,authority};
    },
    async authorize(row:Extract<RecipeJournalRow,{stage:'operation'}>){
      if(!row.richIntent)throw invalid();
      const value=recipeRichInstallAuthorizationSchema.parse(await json(`/v2/operations/${row.operation.id}/authorize`,row.richIntent));
      if(!Object.entries(row.richIntent).every(([key,expected])=>Object.hasOwn(value,key)&&Reflect.get(value,key)===expected)||value.operationId!==row.operation.id||value.accountId!==lease.accountId||value.versionId!==row.versionId||value.manifestSha256!==row.operation.sha||value.targetPublicKey!==row.pk||value.nonceCommitment!==row.operation.commitment)throw invalid();
      return value;
    },
    async cancel(row:Extract<RecipeJournalRow,{stage:'operation'}>){await json(`/v2/operations/${row.operation.id}/cancel`,{});},
  };
}
