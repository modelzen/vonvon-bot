import {richMetadataInputSchema,richMetadataCommitSchema,decodeRichRecipeContent,recipeRichPartDescriptorSchema,recipeRichInstallIntentSchema} from '../../../packages/protocol/dist/index.js';
import {authoringInput} from './authoring-input.mjs';
import {ApiError,badInput} from './errors.mjs';
import {bodyJson,expectedRevision,objectKeys,queryParams,requestKey,uuid} from './input.mjs';
import {binary32} from './install-proof.mjs';
import {operationId} from './operation-input.mjs';
import {richWireBytes,parseRichPayload} from './rich-document.mjs';

const routes=[
 ['GET','versions/:v/install-preview','richInstallPreview'],['POST','operations/:o/authorize','richInstallAuthorize'],
 ['POST','operations/:o/unredeemable','richUnredeemable','possession'],
 ['GET','operations/:o/recovery','richInstallRecover'],['POST','operations/:o/cancel','richInstallCancel'],
 ['POST','operations/:o/redeem','richInstallRedeem','possession'],['POST','operations/:o/complete','richInstallComplete','possession'],
 ['POST','authoring/:o/register','richRegister'],['POST','authoring/:o/authorize','richAuthorize'],
 ['POST','authoring/:o/dispatch','richDispatch','possession'],['POST','authoring/:o/accept','richAccept','possession'],
 ['POST','authoring/:o/freeze','richFreeze'],['GET','authoring/:o','richGet'],['GET','authoring/:o/recovery','richRecover'],['POST','authoring/:o/cancel','richCancel'],
 ['PATCH','drafts/:d/metadata','richMetadata'],['GET','drafts/:d','richDraft'],['GET','me/drafts','richDraftList'],['DELETE','drafts/:d','richDelete'],['POST','drafts/:d/publish','richPublish'],
 ['GET','versions/:v/source-items','richSourceItems'],['GET','recipes/:r/versions/:v','richDetail',true],['GET','community/recipes','richCatalog',true],['POST','versions/:v/withdraw','richWithdraw'],
 ['POST','me/profile','richProfile'],['POST','objects/:o/reserve','richReserve'],['POST','objects/:o/cancel','richCancelPackage'],['GET','me/object-capacity','richCapacity'],
].map(([method,path,action,isPublic=false])=>({method,action,isPublic,regex:new RegExp('^(?:/api)?/v2/'+path.replace(/:[odrv]/g,'([^/]+)')+'$')}));
export function richRoute(method,path,admit) {
  const matches=routes.filter(r=>r.regex.test(path));
  if(!matches.length)throw new ApiError(404,'not_found');
  const r=matches.find(r=>r.method===method);if(!r)throw new ApiError(405,'method_not_allowed');
  if(method!=='GET'&&!admit)throw new ApiError(503,'rich_writes_disabled');
  return {...r,ids:r.regex.exec(path).slice(1).map(uuid)};
}
function wireBytes(raw,max=1048576) {
  if(typeof raw!=='string'||raw.length>Math.ceil(max*4/3)||!/^[A-Za-z0-9_-]+$/.test(raw))throw badInput();
  const b=Buffer.from(raw,'base64url');if(b.toString('base64url')!==raw||b.length>max)throw badInput();return b;
}
export function readDocument(raw) {
  try{return decodeRichRecipeContent(wireBytes(raw));}catch{throw badInput();}
}
export async function richInput(req,url,{action,ids:[id,...other]}) {
  if(action==='richCatalog'){
    const copy=new URL(url);const cursors=copy.searchParams.getAll('cursor'),access=copy.searchParams.getAll('access');
    if(cursors.length>1||access.length>1||cursors.some(x=>x.length>1600)||access.some(x=>!['coded','direct'].includes(x)))throw badInput();
    copy.searchParams.delete('cursor');copy.searchParams.delete('access');
    const {q}=queryParams(copy,['q']);return [action,[q,cursors[0]??null,access[0]??null]];
  }
  queryParams(url,[]);
  if(req.method==='GET')return [action,id?[id,...other]:[]];
  const b=await bodyJson(req,['richFreeze','richAccept','richPublish','richMetadata'].includes(action)?4*1048576:action==='richReserve'?262144:2048);
  if(action==='richUnredeemable'){objectKeys(b,['accountId']);return [action,[operationId(id),uuid(b.accountId)]];}
  if(action==='richInstallAuthorize'){const result=recipeRichInstallIntentSchema.safeParse(b);if(!result.success)throw badInput();return [action,[operationId(id),result.data]];}
  if(action==='richInstallRedeem'||action==='richInstallComplete'){
    const complete=action==='richInstallComplete';objectKeys(b,['ticket','nonce','proof',...(complete?['outcome']:[])]);
    if(complete&&!['applied','rejected'].includes(b.outcome))throw badInput();
    return [action,[operationId(id),...['ticket','nonce','proof'].map(k=>binary32(b[k])),b.outcome??null]];
  }
  if(action==='richRegister') {
    const {format,...rest}=b;if(format!=='rich-v2')throw badInput();authoringInput('registerAuthoring',id,rest);return [action,[id,b]];
  }
  if(action==='richAuthorize')return [action,authoringInput('authorizeAuthoring',id,b)];
  if(action==='richDispatch'){objectKeys(b,['ticket','nonce','proof']);return [action,[operationId(id),...['ticket','nonce','proof'].map(k=>binary32(b[k]))]];}
  if(action==='richAccept'){
    objectKeys(b,['ticket','nonce','proof','payload','canonical','manifestId','packageId']);
    const p=wireBytes(b.payload,1049600);let parsed;
    try{parsed=parseRichPayload(JSON.parse(p.toString('utf8')));}catch{throw badInput();}
    if(!p.equals(richWireBytes(parsed)))throw badInput();
    const doc=readDocument(b.canonical);
    return [action,[operationId(id),...['ticket','nonce','proof'].map(k=>binary32(b[k])),p,Buffer.from(doc.canonicalUTF8),uuid(b.manifestId),operationId(b.packageId)]];
  }
  if(action==='richFreeze')return [action,[operationId(id),b]];
  if(action==='richPublish'){objectKeys(b,['canonical']);const doc=readDocument(b.canonical);return [action,[id,expectedRevision(req),requestKey(req),Buffer.from(doc.canonicalUTF8)]];}
  if(action==='richMetadata'){
    const requestId=operationId(requestKey(req)), revision=expectedRevision(req);
    const parsed='baseCanonical' in (b??{}) ? richMetadataCommitSchema.safeParse(b) : richMetadataInputSchema.safeParse(b?.input);
    if(!parsed.success)throw badInput();
    if(!('baseCanonical' in b)){
      objectKeys(b,['input'],['close']);
      if('close' in b && b.close!==true)throw badInput();
    }
    else if((b.input.logo.kind==='replace')!==Object.hasOwn(b,'logoDescriptor'))throw badInput();
    return [action,[requestId,id,revision,b]];
  }
  if(action==='richReserve'){
    if(b?.metadata!==undefined){
      objectKeys(b,['draftId','cap','revision','metadata']);
      const parsed=richMetadataInputSchema.safeParse(b.metadata);
      if(!parsed.success||!Number.isInteger(b.cap)||b.cap<1||b.cap>4194304||
        !Number.isInteger(b.revision)||b.revision<1||b.revision>2147483647)throw badInput();
      return ['richReserveMetadata',[operationId(id),uuid(b.draftId),b.cap,b.revision,parsed.data]];
    }
    objectKeys(b,['draftId','cap']);if(!Number.isInteger(b.cap)||b.cap<1||b.cap>4194304)throw badInput();return [action,[operationId(id),uuid(b.draftId),b.cap]];
  }
  if(action==='richProfile'){objectKeys(b,['displayName']);if(typeof b.displayName!=='string')throw badInput();return [action,[b.displayName]];}
  objectKeys(b,[]);
  if(action==='richDelete')return [action,[id,expectedRevision(req),requestKey(req)]];
  return [action,[id]];
}
export function parseEditFreeze(b,id,revision) {
  objectKeys(b,['format','payload','baseCanonical'],['newParts','candidates','access','logoUpload']);
  if(b.format!=='rich-v2'||(b.access!==undefined&&!['direct','coded'].includes(b.access)))throw badInput();
  const payload=parseRichPayload(b.payload);
  if(payload.purpose!=='editDraft'||payload.draftId!==id||payload.baseRevision!==revision)throw new ApiError(409,'conflict');
  const accessChanges=payload.changes.filter(c=>c.op==='setAccess');
  if(accessChanges.length>1||accessChanges.length&&accessChanges[0].value!==b.access)throw badInput();
  const base=readDocument(b.baseCanonical);
  if(!Array.isArray(b.newParts??[])||(b.newParts?.length??0)>65)throw badInput();
  const parts=(b.newParts??[]).map(p=>{if(!recipeRichPartDescriptorSchema.safeParse(p).success)throw badInput();return p;});
  if(!Array.isArray(b.candidates??[])||(b.candidates?.length??0)>16)throw badInput();
  return {payload,base,parts,candidates:b.candidates??[]};
}
