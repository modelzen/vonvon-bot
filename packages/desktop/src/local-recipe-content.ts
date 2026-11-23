import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {creatorWorkSchema,decodeRichRecipeContent,recipeRichPartDescriptorSchema,richFreezeInputSchema,
  richMetadataRequestSchema,validateWritableRichRecipeContent,type RecipeRichContent,type RecipeRichPartDescriptor,type RichFreezeInput,
  type RichFrozenResponse,type RichMetadataRequest} from '@vonvon/protocol';
import {applyChanges,richWireBytes} from '../../../services/recipe-api/src/rich-document.mjs';
import {staticLogoFormat} from '../../../services/recipe-api/src/logo-format.mjs';
import {verifyFrozenRich} from '../../daemon/src/recipe/authoring-rich-proof.js';
import {localRecipeDraftRecordSchema,type LocalRecipeDraftRecord} from './local-recipe-drafts.js';
import {creatorAssociationSchema} from './recipe-creator-journal.js';

type Member=LocalRecipeDraftRecord['members'][number];
type Origin=NonNullable<LocalRecipeDraftRecord['origins']>[number];
type NormalizeLogo=(bytes:Buffer)=>Promise<Buffer>;
const uuid=z.string().uuid(),revisionSchema=z.number().int().positive().max(2147483647);
const originSchema=localRecipeDraftRecordSchema.shape.origins.unwrap().element;
const fail=()=>new Error('本地配方内容、来源或修订不一致。');
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function id(...parts:unknown[]){
  const bytes=createHash('sha256').update(richWireBytes(parts)).digest().subarray(0,16);
  bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
  const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function encoded(value:string,encoding:'base64'|'base64url'){
  const bytes=Buffer.from(value,encoding);if(bytes.toString(encoding)!==value)throw fail();return bytes;
}
function contentOf(canonical:string){return decodeRichRecipeContent(encoded(canonical,'base64url')).content;}
function items(content:RecipeRichContent){
  const result:Array<{itemId:string;originId:string}>=Object.values(content.public);
  if(content.role)result.push(content.role);if(content.finalLogo)result.push(content.finalLogo);
  for(const list of [content.settings,content.rules,content.skills,content.files,content.tasks,content.memories,content.setup])result.push(...list);
  for(const setting of content.settings)if(setting.field==='presentation.cardDisplay'&&setting.value)result.push(...setting.value.blocks);
  return result;
}
async function logo(bytes:Buffer,normalize?:NormalizeLogo){
  if(!normalize||!bytes.length||bytes.length>2097152)throw fail();
  staticLogoFormat(bytes);
  const result=await normalize(Buffer.from(bytes));
  if(!Buffer.isBuffer(result)||!result.length||result.length>131072)throw fail();
  staticLogoFormat(result,true);return result;
}
function mergeMembers(...lists:Member[][]){
  const result=new Map<string,Member>();
  for(const member of lists.flat()){
    const descriptor=recipeRichPartDescriptorSchema.parse(member.descriptor),bytes=encoded(member.base64,'base64');
    if(bytes.length!==descriptor.bytes||sha(bytes)!==descriptor.sha256)throw fail();
    if(descriptor.kind==='text')new TextDecoder('utf-8',{fatal:true}).decode(bytes);else staticLogoFormat(bytes,true);
    const previous=result.get(descriptor.objectId);
    if(previous&&!isDeepStrictEqual(previous,member))throw fail();
    result.set(descriptor.objectId,{descriptor,base64:member.base64});
  }
  return [...result.values()];
}
function view(content:RecipeRichContent,members:Member[]){
  const byId=new Map(members.map(member=>[member.descriptor.objectId,member]));
  const texts:Record<string,string>={};let image:string|undefined;
  for(const part of content.parts){
    const member=byId.get(part.objectId);if(!member||!isDeepStrictEqual(member.descriptor,part))throw fail();
    if(part.kind==='text')texts[part.objectId]=new TextDecoder('utf-8',{fatal:true}).decode(encoded(member.base64,'base64'));
    if(content.finalLogo?.objectId===part.objectId)image='data:image/webp;base64,'+member.base64;
  }
  return {texts,image};
}

export async function bindLocalRichMembers(operationId:string,raw:RichFreezeInput,
  members:{kind:'text'|'finalLogo';sha256:string;bytes:string}[],normalizeLogo?:NormalizeLogo):Promise<{descriptors:RecipeRichPartDescriptor[];members:Member[]}>{
  uuid.parse(operationId);const request=richFreezeInputSchema.parse(raw),result:Member[]=[];
  const texts='content'in request?request.content.files.filter(file=>file.text.kind==='inline'):[];
  let textIndex=0,logos=0;
  for(const [index,member] of members.entries()){
    const input=encoded(member.bytes,'base64url');if(sha(input)!==member.sha256)throw fail();
    let bytes:Buffer;
    if(member.kind==='text'){
      const file=texts[textIndex++];
      if(!file||file.text.kind!=='inline'||new TextDecoder('utf-8',{fatal:true}).decode(input)!==file.text.value)throw fail();
      bytes=input;
    }else{if(++logos>1)throw fail();bytes=await logo(input,normalizeLogo);}
    const descriptor=recipeRichPartDescriptorSchema.parse({objectId:id(operationId,index,member.sha256,sha(bytes)),kind:member.kind,
      sha256:sha(bytes),bytes:bytes.length,mediaType:member.kind==='text'?'text/plain;charset=utf-8':'image/webp'});
    result.push({descriptor,base64:bytes.toString('base64')});
  }
  if(textIndex!==texts.length)throw fail();
  return {descriptors:result.map(member=>member.descriptor),members:result};
}

function edit(request:Extract<RichFreezeInput,{payload:unknown}>){
  const original=contentOf(request.baseCanonical);
  for(const change of request.payload.changes)if(change.op==='includeCandidate'&&change.value.source.expectedRevision!==request.payload.baseRevision)throw fail();
  return applyChanges(original,request.payload.changes,ref=>{
    const donor=request.candidates?.find(candidate=>candidate.sourceIntentId===ref.sourceIntentId);
    return {content:donor?contentOf(donor.canonical):original,itemId:ref.candidateId};
  },createHash('sha256').update(richWireBytes(request)).digest(),request.newParts);
}
export function freezeLocalRich(operationId:string,draftId:string,raw:RichFreezeInput):RichFrozenResponse{
  uuid.parse(operationId);uuid.parse(draftId);const request=richFreezeInputSchema.parse(raw);
  if('payload'in request&&request.payload.draftId!==draftId)throw fail();
  const content='content'in request?request.content:edit(request).doc.content;
  const doc=validateWritableRichRecipeContent(content),bytes=Buffer.from(doc.canonicalUTF8);
  const payload=richWireBytes('content'in request?{format:'rich-v2',purpose:'prepareDraft',sourceIntentId:operationId,content:doc.content}:request.payload);
  return verifyFrozenRich(operationId,draftId,request,{format:'rich-v2',destinationDraftId:draftId,canonical:bytes.toString('base64url'),
    contentSha256:sha(bytes),logicalBytes:doc.logicalBytes,payload:payload.toString('base64url'),payloadDigest:sha(payload),sourceReviewSha256:sha(richWireBytes(request))});
}

export function buildLocalRichRecord(input:{association:LocalRecipeDraftRecord['association'];work:LocalRecipeDraftRecord['work'];revision:number;
  request:RichFreezeInput;frozen:RichFrozenResponse;members:Member[];sourceCanonical?:string;sourceOrigins?:Origin[];selected?:string[];
  parent?:LocalRecipeDraftRecord['parent'];base?:LocalRecipeDraftRecord}):LocalRecipeDraftRecord{
  const association=creatorAssociationSchema.parse(input.association),work=creatorWorkSchema.parse(input.work),revision=revisionSchema.parse(input.revision);
  if(!work.source)throw fail();
  const request=richFreezeInputSchema.parse(input.request),base=input.base&&localRecipeDraftRecordSchema.parse(input.base);
  if(base&&(!isDeepStrictEqual(base.association,association)||!isDeepStrictEqual(base.work,work)||base.draft.format!=='rich-v2'))throw fail();
  if('payload'in request){
    if(!base||request.payload.draftId!==work.draftId||request.payload.baseRevision!==base.draft.revision||revision!==base.draft.revision+1||
      base.draft.format!=='rich-v2'||request.baseCanonical!==base.draft.rich.canonical)throw fail();
  }else if(base||revision!==1)throw fail();
  const frozen=verifyFrozenRich(work.source.preparationId,work.draftId,request,input.frozen),content=contentOf(frozen.canonical);
  validateWritableRichRecipeContent(content);
  const members=mergeMembers(base?.members??[],input.members);
  const current=view(content,members);
  const sourceCanonical=input.sourceCanonical??base?.sourceCanonical??frozen.canonical;
  if(base?.sourceCanonical&&sourceCanonical!==base.sourceCanonical)throw fail();
  if(!base&&sourceCanonical!==frozen.canonical)throw fail();
  const sourceContent=contentOf(sourceCanonical);view(sourceContent,members);
  const sourceOrigins=input.sourceOrigins??base?.sourceOrigins??('content'in request?request.origins:undefined);
  if(base?.sourceOrigins&&!isDeepStrictEqual(sourceOrigins,base.sourceOrigins))throw fail();
  if('content'in request&&!isDeepStrictEqual(sourceOrigins,request.origins))throw fail();
  let origins:Origin[];
  if('content'in request)origins=request.origins;
  else{
    const known=new Map((base?.origins??[]).map(origin=>[origin.itemId,origin.source]));
    const donors=new Map<string,Origin['source']>();
    for(const doc of [contentOf(request.baseCanonical),sourceContent])for(const item of items(doc)){
      const origin=(base?.origins??[]).find(o=>o.itemId===item.itemId)??sourceOrigins?.find(o=>o.itemId===item.itemId);
      if(origin)donors.set(item.originId,origin.source);
    }
    const copies=z.object({copies:z.array(z.object({itemId:uuid,donorOriginId:uuid.optional(),source:originSchema.shape.source.optional()}).passthrough())}).passthrough().parse(edit(request)).copies;
    for(const copy of copies){
      const source=copy.source??(copy.donorOriginId?donors.get(copy.donorOriginId):undefined);if(!source)throw fail();
      known.set(copy.itemId,source.kind==='releaseItem'?{kind:'releaseItems',parents:[{
        versionId:source.versionId,itemId:source.itemId,baselineSha256:source.baselineSha256,
      }]}:source);
    }
    origins=items(content).map(item=>{const source=known.get(item.itemId);if(!source)throw fail();return {itemId:item.itemId,source};});
  }
  const ids=items(content).map(item=>item.itemId);
  if(origins.length!==ids.length||new Set(origins.map(o=>o.itemId)).size!==ids.length||ids.some(itemId=>!origins.some(o=>o.itemId===itemId)))throw fail();
  const baseIds=new Set(base?.draft.format==='rich-v2'?items(base.draft.rich.content).map(item=>item.itemId):[]);
  const selected=input.selected??(base?.selected?[...base.selected,...ids.filter(itemId=>!baseIds.has(itemId))]:ids);
  const parent=input.parent===undefined?base?.parent:input.parent;
  if(base&&!isDeepStrictEqual(parent??null,base.parent??null))throw fail();
  if('content'in request&&request.sourceVersionId&&parent?.versionId!==request.sourceVersionId)throw fail();
  return localRecipeDraftRecordSchema.parse({association,work,sourceCanonical,sourceOrigins,origins,selected:selected.filter(itemId=>ids.includes(itemId)),members,
    ...(parent!==undefined&&{parent}),draft:{format:'rich-v2',draftId:work.draftId,recipeId:base?.draft.recipeId??parent?.recipeId??null,revision,sourceIntentId:work.source.preparationId,
      public:{name:content.public.name.value,summary:content.public.summary.value,overview:content.public.overview.value,version:content.public.version.value,
        access:request.access??base?.draft.public.access??'direct'},rich:{content,canonical:frozen.canonical,texts:current.texts},...(current.image&&{logo:current.image})}});
}

export async function applyLocalMetadata(raw:LocalRecipeDraftRecord,input:RichMetadataRequest,normalizeLogo?:NormalizeLogo):Promise<LocalRecipeDraftRecord>{
  const record=localRecipeDraftRecordSchema.parse(raw),request=richMetadataRequestSchema.parse(input),draft=record.draft;
  if(draft.format!=='rich-v2'||record.association.accountId!==request.accountId||draft.draftId!==request.draftId||draft.revision!==request.revision||
    sha(encoded(draft.rich.canonical,'base64url'))!==request.baseManifestSha256)throw fail();
  const content=contentOf(draft.rich.canonical);
  for(const field of ['name','summary','overview','version'] as const)content.public[field].value=request.public[field];
  let members=mergeMembers(record.members),origins=[...(record.origins??[])];
  if(request.logo.kind==='remove')delete content.finalLogo;
  if(request.logo.kind==='replace'){
    const bytes=await logo(encoded(request.logo.base64,'base64'),normalizeLogo),objectId=id(request.requestId,'logo',sha(bytes));
    const descriptor=recipeRichPartDescriptorSchema.parse({kind:'finalLogo',objectId,sha256:sha(bytes),bytes:bytes.length,mediaType:'image/webp'});
    members=mergeMembers(members,[{descriptor,base64:bytes.toString('base64')}]);content.parts.push(descriptor);
    content.finalLogo=content.finalLogo?{...content.finalLogo,objectId}:{itemId:id(request.requestId,'logo-item'),originId:id(request.requestId,'logo-origin'),objectId};
    origins=origins.filter(origin=>origin.itemId!==content.finalLogo!.itemId);
    origins.push({itemId:content.finalLogo.itemId,source:{kind:'accountClaim'}});
  }
  const referenced=new Set<string>();
  for(const item of [...content.files,...content.rules,...content.memories,...content.tasks,...(content.role?[content.role]:[])]){
    if('text'in item&&item.text.kind==='part')referenced.add(item.text.objectId);
    if('instruction'in item&&item.instruction.kind==='part')referenced.add(item.instruction.objectId);
  }
  if(content.finalLogo)referenced.add(content.finalLogo.objectId);
  content.parts=content.parts.filter(part=>referenced.has(part.objectId));
  const doc=validateWritableRichRecipeContent(content),current=view(doc.content,members),ids=items(doc.content).map(item=>item.itemId);
  return localRecipeDraftRecordSchema.parse({...record,origins:origins.filter(origin=>ids.includes(origin.itemId)),selected:[...new Set([...(record.selected??ids),...ids.filter(itemId=>!items(draft.rich.content).some(item=>item.itemId===itemId))])].filter(itemId=>ids.includes(itemId)),members,
    draft:{...draft,revision:revisionSchema.parse(draft.revision+1),public:request.public,rich:{content:doc.content,canonical:Buffer.from(doc.canonicalUTF8).toString('base64url'),texts:current.texts},logo:current.image}});
}
