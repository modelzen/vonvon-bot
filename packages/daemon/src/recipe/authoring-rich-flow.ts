import {staticLogoFormat} from '../../../../services/recipe-api/src/logo-format.mjs';
import {createHash,randomUUID} from 'node:crypto';
import type {LarkChannel} from '@larksuiteoapi/node-sdk';
import {canonicalizeRichRecipeContent,decodeRichRecipeContent,type RecipeAuthoringRequest,type RecipeRichContent,type RecipeRichOriginEdge,type ScheduledTaskView, type RichFreezeInput} from '@vonvon/protocol';
import {botPaths} from '../config/paths';
import type {BotIdentity} from '../config/bots';
import {applyManagedInventory,type ManagedSourceItem} from './authoring-rich-managed';
import type {Project} from '../project/registry';
import {atSource} from './authoring-source';
import {nativeRichInventory,inventoryAlias} from './authoring-rich-inventory';
import {itemsOf,selectRichSnapshot,wireDigest,wireJson,type AttestedSourceItem,type RichOrigin} from './authoring-rich-snapshot';
import type {LocalOperation} from './authoring-journal';
import type {RichModelItem} from './authoring-rich-model';
import {proposeRich,type RichModelInput} from './authoring-rich-model';
import {safeEditValue} from '../../../../services/recipe-api/src/draft-model-text.mjs';

type Preparation=Extract<RecipeAuthoringRequest,{type:'richPrepare'}>;
type InventoryOptions=Preparation['selection']['options'];
export interface RichLocalDraft {
  selectionDigest?:string;
  sourceRef?:string;
  source?:{groupId:string;options:InventoryOptions;token:string;selected:string[]};
  base?:{canonical:string;selected:string[];origins?:Record<string,RichOrigin>};
  request?:RichFreezeInput;
  members?: {itemId:string;kind:'text'|'finalLogo';bytes:string;sha256:string}[];
  boundRequest?:RichFreezeInput;
  destinationDraftId?:string;
}
export interface RichNativeOptions {bot:BotIdentity;channel:LarkChannel;tasks?:(chat:string)=>Promise<ScheduledTaskView[]>;managedSources?:(row:Project,root:string)=>Promise<ManagedSourceItem[]>}
export async function readRichSource(native:RichNativeOptions,scope:string,account:string,group:string,options:InventoryOptions){
  const row=await atSource(native.channel,native.bot,group,row=>structuredClone(row));
  const seed=wireDigest([scope,account,row.bindingIncarnation]);
  const inventory=await nativeRichInventory({seed,row,botRoot:botPaths(native.bot.appId).dir,botId:native.bot.appId,...options,
    tasks:options.includeTasks?await native.tasks?.(group):[]});
  if('richRecipe' in row && row.richRecipe){
    if(!native.managedSources)throw new Error('需要核对当前已安装配方的来源。');
    const managed=await native.managedSources(row,botPaths(native.bot.appId).dir);
    applyManagedInventory(inventory.content,inventory.evidence,managed,account);
    inventory.lease=wireDigest([inventory.lease,managed]);
  }
  const recheck=await atSource(native.channel,native.bot,group,live=>live.bindingIncarnation===row.bindingIncarnation&&live.projectSettingsRevision===row.projectSettingsRevision);
  if(!recheck)throw new Error('来源群已变化，请重新预览。');
  return inventory;
}
export function preparedRich(req:Preparation,inventory:Awaited<ReturnType<typeof readRichSource>>,account:string):RichLocalDraft {
  const selection=req.selection;
  if(selection.reviewToken!==inventory.lease)throw new Error('来源群已变化，请重新预览。');
  const original=structuredClone(inventory.content);
  for(const field of ['name','summary','overview','version'] as const)original.public[field].value=selection.public[field];
  const selected=[...selection.selected], evidence=new Map(inventory.evidence);
  for(const step of selection.setup){
    const id=inventoryAlias(inventory.lease,'setup:'+original.setup.length+':'+wireDigest(step));
    original.setup.push({...step,itemId:id,originId:inventoryAlias(inventory.lease,'origin:'+id)});selected.push(id);evidence.set(id,{kind:'native'});
  }
  const attested=new Map<string,AttestedSourceItem>();
  for(const version of req.attestations)for(const item of version.items)
    attested.set(version.versionId+':'+item.itemId,{...item,versionId:version.versionId,authorId:version.authorId,access:version.access});
  const request=selectRichSnapshot({inventory:original,selected,evidence,account,attested,ownershipClaim:selection.sourceAttested,
    access:selection.access,sourceVersionId:selection.sourceVersionId});
  if(!safeEditValue(request.content))throw new Error('选择内容中含敏感资料。');
  const members:NonNullable<RichLocalDraft['members']>=[];
  for(const file of request.content.files){
    if(file.text.kind!=='inline')throw new Error('所选文件尚未核对。');
    const bytes=Buffer.from(file.text.value);
    members.push({itemId:file.itemId,kind:'text',bytes:bytes.toString('base64url'),sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  if(selection.logo){
    const bytes=Buffer.from(selection.logo,'base64url');
    if(bytes.length>2097152||bytes.toString('base64url')!==selection.logo)throw new Error('Logo 无效。');
    staticLogoFormat(bytes);
    members.push({itemId:inventoryAlias(inventory.lease,'logo'),kind:'finalLogo',bytes:selection.logo,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  return {selectionDigest:wireDigest(selection),members,source:{groupId:req.groupId,options:selection.options,token:inventory.lease,selected:selection.selected},request};
}
export function richReviewDigest(rich:RichLocalDraft){
  if(!rich.request)throw new Error('缺少当前审核内容。');
  return rich.members?.length ? wireDigest({request:rich.request,members:rich.members.map(({itemId,kind,sha256})=>({itemId,kind,sha256}))}):wireDigest(rich.request);
}
export function bindRichMembers(rich:RichLocalDraft,descriptors:RecipeRichContent['parts']){
  if(!rich.request||!('content' in rich.request)||!rich.members||descriptors.length!==rich.members.length)throw new Error('附件核对失败。');
  const request=structuredClone(rich.request);
  for(const [index,m] of rich.members.entries()){
    const d=descriptors[index]!;
    if(d.kind!==m.kind)throw new Error('附件类型改变。');
    if(m.kind==='text'){
      const file=request.content.files.find(f=>f.itemId===m.itemId);
      if(file?.text.kind!=='inline'||d.sha256!==m.sha256||d.bytes!==Buffer.byteLength(file.text.value))throw new Error('所选附件内容改变。');
      file.text={kind:'part',objectId:d.objectId};
    }else{
      request.content.finalLogo={itemId:m.itemId,originId:m.itemId,objectId:d.objectId};
      request.origins.push({itemId:m.itemId,source:{kind:'accountClaim'}});
    }
    request.content.parts.push(d);
  }
  canonicalizeRichRecipeContent(request.content);
  if(rich.boundRequest&&wireDigest(rich.boundRequest)!==wireDigest(request))throw new Error('附件收据已变化。');
  return request;
}
export function richMemberCap(rich:RichLocalDraft){
  if(!rich.request||!('content' in rich.request))throw new Error('缺少核对过的来源。');
  const sizes=rich.members?.map(m=>({kind:m.kind,bytes:Buffer.from(m.bytes,'base64url').length}))??[];
  const text=sizes.filter(x=>x.kind==='text').reduce((sum,x)=>sum+x.bytes,0);
  const logo=sizes.find(x=>x.kind==='finalLogo');
  const manifestMax=Math.min(1048576,Buffer.byteLength(wireJson(rich.request.content))+512*(sizes.length+1));
  return Math.max(1,2*text+(logo?logo.bytes+131072:0),text+(logo?131072:0)+2*manifestMax);
}
export function richEditTargets(content:RecipeRichContent,selected:readonly string[]):RichModelItem[]{
  const items:RichModelItem[]=[];
  const add=(item: {itemId:string;originId:string}&Record<string,unknown>,kind:RichModelItem['kind'],field?:string)=>{
    if(!selected.includes(item.itemId))return;
    const {itemId,originId:_origin,...data}=item;
    const value=kind==='publicText'||kind==='setting'?data.value:kind==='role'?data.text:data;
    items.push({itemId,kind,value,...(field&&{field})});
  };
  for(const [name,item] of Object.entries(content.public))add(item,'publicText',name);
  if(content.role)add(content.role,'role');
  for(const item of content.settings){
    if(item.field==='presentation.cardDisplay'&&item.value){
      add({...item,value:{reply:item.value.reply??null}},'setting',item.field);
      for(const block of item.value.blocks)add(block,'cardBlock');
    }else add(item,'setting',item.field);
  }
  for(const [key,kind] of [['rules','rule'],['skills','skill'],['tasks','task'],['files','file'],['memories','memory'],['setup','setup']] as const)
    for(const item of content[key])add(item,kind);
  if(content.finalLogo)add(content.finalLogo,'finalLogo');
  if(items.length!==selected.length)throw new Error('选择的草稿条目不存在。');
  return items;
}
export function richCardReview(op:LocalOperation){
  const request=op.rich?.request;
  if(!request)return;
  const fields='content' in request ? [
    ...Object.entries(request.content.public).map(([field,v])=>({label:field,valueJson:JSON.stringify(v.value)})),
    ...request.content.setup.map((step,i)=>({label:'准备步骤 '+(i+1),valueJson:wireJson({title:step.title,instructions:step.instructions,
      kind:step.kind,required:step.required,action:step.action,...(step.check!==undefined&&{check:step.check})})})),
    {label:'已在 App 核对的来源',valueJson:'规则 '+request.content.rules.length+'、技能 '+request.content.skills.length+'、任务 '+request.content.tasks.length+'、记忆 '+request.content.memories.length+'、设置 '+request.content.settings.length+'。'},
  ] : request.payload.changes.map(c=>({label:c.op,valueJson:wireJson(c)}));
  return {draftId:op.view.draftId??op.view.operationId,revision:op.view.baseRevision??1,payloadDigest:richReviewDigest(op.rich!),fields};
}
export function verifyEditBase(raw:string,selected:readonly string[]){
  const bytes=Buffer.from(raw,'base64url');
  if(bytes.toString('base64url')!==raw)throw new Error('草稿快照无效。');
  const doc=decodeRichRecipeContent(bytes);
  richEditTargets(doc.content,selected);
  return doc.content;
}
export async function chatRichProposal(op:LocalOperation,instruction:string,signal:AbortSignal,parser:{
  proposeRich(input:RichModelInput,signal:AbortSignal):Promise<unknown>;
}){
  const rich=op.rich;
  if(!rich)throw new Error('找不到当前草稿。');
  const base=rich.base, original=rich.request&&'content' in rich.request?rich.request:undefined;
  const selected=base?.selected??(original?[...Object.values(original.content.public).map(i=>i.itemId),
    ...original.content.setup.map(i=>i.itemId),...(rich.source?.selected??[])]:[]);
  const content=base?verifyEditBase(base.canonical,selected):original?.content;
  if(!content)throw new Error('缺少本次草稿快照。');
  const presentIds=new Set(itemsOf(content).map(i=>i.itemId));
  const targets=richEditTargets(content,selected.filter(id=>presentIds.has(id)));
  const grounding=targets.map(t=>['memory','file','skill','finalLogo'].includes(t.kind)||Buffer.byteLength(wireJson(t.value))>4000?
    {...t,value:{selected:true}}:t);
  const parsed=await proposeRich({instruction,phase:original?'create':'edit',selected:grounding},signal,parser);
  if(parsed.kind!=='proposal')return parsed;
  const sourceById=original?Object.fromEntries(original.origins.map(o=>[o.itemId,o.source])):base?.origins;
  const parents=new Map<string,RecipeRichOriginEdge>();
  const unknownSources=grounding.some(t=>{
    const source=sourceById?.[t.itemId];
    if(!source)return true;
    for(const edge of source.kind==='releaseItem'?[source]:source.kind==='releaseItems'?source.parents:[]){
      const {versionId,itemId,baselineSha256}=edge;
      parents.set(versionId+':'+itemId,{versionId,itemId,baselineSha256});
    }
    return false;
  });
  if(parsed.setup.length&&unknownSources){
    // With no native ledger for a cross-device draft, generate a fresh suggestion using only the author's new instruction.
    const independent=await proposeRich({instruction,phase:'edit',selected:[]},signal,parser);
    if(independent.kind!=='proposal'||independent.changes.length||!independent.setup.length)throw new Error('请说明要新增的独立准备步骤。');
    parsed.setup.splice(0,parsed.setup.length,...independent.setup);
    parents.clear();
  }
  const source=parents.size?{kind:'releaseItems' as const,parents:[...parents.values()]}:{kind:'accountClaim' as const};
  if(original){
    const request=structuredClone(original);
    const omitted=new Set(parsed.omitted);
    if(request.content.role&&omitted.has(request.content.role.itemId))delete request.content.role;
    for(const key of ['skills','rules','settings','files','memories','tasks','setup'] as const){
      const remaining=request.content[key].filter(i=>!omitted.has(i.itemId));
      Object.assign(request.content,{[key]:remaining});
    }
    for(const skill of request.content.skills)skill.fileIds=skill.fileIds.filter(id=>!omitted.has(id));
    const keptFiles=new Set(request.content.skills.flatMap(s=>s.fileIds));
    request.content.files=request.content.files.filter(f=>keptFiles.has(f.itemId));
    for(const setting of request.content.settings)if(setting.field==='presentation.cardDisplay'&&setting.value)
      setting.value.blocks=setting.value.blocks.filter(b=>!omitted.has(b.itemId));
    const kept=new Set(itemsOf(request.content).map(i=>i.itemId));
    request.origins=request.origins.filter(o=>kept.has(o.itemId));
    for(const change of parsed.changes){
      if(change.op!=='setPublicText'||request.content.public[change.field].itemId!==change.itemId)throw new Error('创建时仅能填写公开介绍和使用前准备。');
      if(!instruction.includes(change.value))throw new Error('请提供要公开的实际文案。');
      request.content.public[change.field].value=change.value;
    }
    for(const step of parsed.setup){
      const itemId=randomUUID();
      request.content.setup.push({...step,itemId,originId:randomUUID()});
      request.origins.push({itemId,source});
    }
    canonicalizeRichRecipeContent(request.content);
    return {kind:'proposal',request} as const;
  }
  if(!op.view.draftId||!op.view.baseRevision||!base)throw new Error('缺少当前草稿修订。');
  for(const value of parsed.setup)parsed.changes.push({op:'addSetup',value,source});
  const request:RichFreezeInput={format:'rich-v2',baseCanonical:base.canonical,payload:{format:'rich-v2',purpose:'editDraft',draftId:op.view.draftId,
    baseRevision:op.view.baseRevision,requestId:randomUUID(),schemaVersion:2,changes:parsed.changes}};
  return {kind:'proposal',request} as const;
}
