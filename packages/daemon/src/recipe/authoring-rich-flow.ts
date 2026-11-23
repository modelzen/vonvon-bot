import {recipeFileIO} from './rich-file-helper';
import {groupBackendId} from '../config/execution';
import {staticLogoFormat} from '../../../../services/recipe-api/src/logo-format.mjs';
import {createHash,randomUUID} from 'node:crypto';
import type {LarkChannel} from '@larksuiteoapi/node-sdk';
import {canonicalizeRichRecipeContent,decodeRichRecipeContent,type RecipeAuthoringRequest,type RecipeRichContent,type RecipeRichOriginEdge,type ScheduledTaskView, type RichFreezeInput} from '@vonvon/protocol';
import {botPaths} from '../config/paths';
import type {BotIdentity} from '../config/bots';
import {applyManagedInventory,type ManagedSourceItem,type ManagedSourceSelection} from './authoring-rich-managed';
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
  newFields?:string[];
  sourceRef?:string;
  source?:{groupId:string;options:InventoryOptions;token:string;selected:string[]};
  base?:{canonical:string;selected:string[];origins?:Record<string,RichOrigin>};
  request?:RichFreezeInput;
  members?: {itemId:string;kind:'text'|'finalLogo';bytes:string;sha256:string}[];
  boundRequest?:RichFreezeInput;
  destinationDraftId?:string;
}
export interface RichNativeOptions {bot:BotIdentity;channel:LarkChannel;tasks?:(chat:string)=>Promise<ScheduledTaskView[]>;managedSources?:(row:Project,root:string,selection?:ManagedSourceSelection)=>Promise<ManagedSourceItem[]>}
function managedSkillHandle(item:ManagedSourceItem){return '已安装 · '+String(item.value.name).slice(0,28)+' · '+item.itemId;}
function managedSkillChoices(managed:ManagedSourceItem[]){
  return managed.filter(item=>item.kind==='skills').map(item=>({name:managedSkillHandle(item),files:managed.filter(file=>file.kind==='files'&&
    Array.isArray(item.value.fileIds)&&item.value.fileIds.includes(file.itemId)).sort((a,b)=>Number(b.itemId===item.value.entryFileId)-Number(a.itemId===item.value.entryFileId)).map(file=>String(file.value.name))}));
}
function selectManagedSources(managed:ManagedSourceItem[],options:InventoryOptions){
  const files=new Set<string>();
  const skills=new Map<string,ManagedSourceItem>();
  for(const item of managed.filter(item=>item.kind==='skills')){
    const choice=options.skills.find(choice=>choice.skill===managedSkillHandle(item));
    if(!choice)continue;
    const allowed=managed.filter(file=>file.kind==='files'&&Array.isArray(item.value.fileIds)&&item.value.fileIds.includes(file.itemId));
    const selected=allowed.filter(file=>choice.files.includes(String(file.value.name)));
    if(!selected.some(file=>file.itemId===item.value.entryFileId)||choice.files.some(name=>!allowed.some(file=>file.value.name===name)))throw new Error('请选择已安装技能的说明及实际参考资料。');
    selected.forEach(file=>files.add(file.itemId));
    skills.set(item.itemId,{...item,value:{...item.value,fileIds:selected.map(file=>file.itemId)}});
  }
  return managed.flatMap(item=>item.kind==='skills'?(skills.has(item.itemId)?[skills.get(item.itemId)!]:[]):
    item.kind==='files'?(files.has(item.itemId)?[item]:[]):
    item.kind==='memories'&&!options.includeBotMemories||item.kind==='tasks'&&!options.includeTasks?[]:[item]);
}
export async function richSkillOptions(native:RichNativeOptions,group:string){
  const row=await atSource(native.channel,native.bot,group,r=>structuredClone(r));
  const provider=groupBackendId(row)==='claude-agent'?'.claude':'.agents';
  const result=await recipeFileIO({operation:'skills',provider,root:row.cwd});
  const managed=row.richRecipe?await native.managedSources?.(row,botPaths(native.bot.appId).dir):[];
  if(row.richRecipe&&!managed)throw new Error('需要核对当前已安装配方的来源。');
  if(!await atSource(native.channel,native.bot,group,r=>r.bindingIncarnation===row.bindingIncarnation&&r.projectSettingsRevision===row.projectSettingsRevision&&r.cwd===row.cwd))throw new Error('来源群已变化。');
  return [...(result.skills??[]).map(skill=>({...skill,files:['SKILL.md',...skill.files.filter(name=>name!=='SKILL.md')]})),...managedSkillChoices(managed??[])];
}
export async function readRichSource(native:RichNativeOptions,scope:string,account:string,group:string,options:InventoryOptions){
  const row=await atSource(native.channel,native.bot,group,row=>structuredClone(row));
  const seed=wireDigest([scope,account,row.bindingIncarnation]);
  const metadata=row.richRecipe?await native.managedSources?.(row,botPaths(native.bot.appId).dir):[];
  if(row.richRecipe&&!metadata)throw new Error('需要核对当前已安装配方的来源。');
  const selected=selectManagedSources(metadata??[],options);
  const managed=row.richRecipe?await native.managedSources?.(row,botPaths(native.bot.appId).dir,{
    fileIds:selected.filter(item=>item.kind==='files').map(item=>item.itemId),includeBotMemories:options.includeBotMemories,includeTasks:options.includeTasks,
  }):[];
  if(row.richRecipe&&!managed)throw new Error('需要核对当前已安装配方的来源。');
  const handles=new Set(managedSkillChoices(metadata??[]).map(skill=>skill.name));
  const inventory=await nativeRichInventory({seed,row,botRoot:botPaths(native.bot.appId).dir,botId:native.bot.appId,...options,skills:options.skills.filter(choice=>!handles.has(choice.skill)),
    tasks:options.includeTasks?await native.tasks?.(group):[]});
  if('richRecipe' in row && row.richRecipe){
    const visible=selectManagedSources(managed!,options);
    applyManagedInventory(inventory.content,inventory.evidence,visible,account);
    inventory.lease=wireDigest([inventory.lease,metadata,managed,row.richRecipe.pointer,options]);
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
  return {newFields:[],selectionDigest:wireDigest(selection),members,source:{groupId:req.groupId,options:selection.options,token:inventory.lease,selected:selection.selected},request};
}
export function richReviewDigest(rich:RichLocalDraft){
  if(!rich.request)throw new Error('缺少当前审核内容。');
  return rich.members?.length ? wireDigest({request:rich.request,members:rich.members.map(({itemId,kind,sha256})=>({itemId,kind,sha256}))}):wireDigest(rich.request);
}
export function bindRichMembers(rich:RichLocalDraft,descriptors:RecipeRichContent['parts'],packageId:string){
  if(!rich.request||!rich.members||descriptors.length!==rich.members.length)throw new Error('附件核对失败。');
  const request=structuredClone(rich.request);
  for(const [index,m] of rich.members.entries()){
    const d=descriptors[index]!;
    if(d.kind!==m.kind)throw new Error('附件类型改变。');
    if(m.kind==='finalLogo')request.logoUpload={packageId,inputSha256:m.sha256};
    if(!('content' in request)){
      const set=request.payload.changes.find(c=>c.op==='setFinalLogo'&&c.objectId===m.itemId);
      if(!set||set.op!=='setFinalLogo'||m.kind!=='finalLogo'||request.newParts?.length)throw new Error('Logo 核对失败。');
      set.objectId=d.objectId;
      request.newParts=[d];
      continue;
    }
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
  if('content' in request)canonicalizeRichRecipeContent(request.content);
  if(rich.boundRequest&&wireDigest(rich.boundRequest)!==wireDigest(request))throw new Error('附件收据已变化。');
  return request;
}
export function richMemberCap(rich:RichLocalDraft){
  if(!rich.request)throw new Error('缺少核对过的来源。');
  const sizes=rich.members?.map(m=>({kind:m.kind,bytes:Buffer.from(m.bytes,'base64url').length}))??[];
  const text=sizes.filter(x=>x.kind==='text').reduce((sum,x)=>sum+x.bytes,0);
  const logo=sizes.find(x=>x.kind==='finalLogo');
  if(!('content' in rich.request)){
    if(!logo||sizes.length!==1)throw new Error('Logo 核对失败。');
    const base=Buffer.from(rich.request.baseCanonical,'base64url').length;
    return Math.max(logo.bytes+131072,131072+2*Math.min(1048576,base+Buffer.byteLength(wireJson(rich.request.payload))+2048));
  }
  const skeleton=structuredClone(rich.request.content);
  for(const m of rich.members??[]){
    const bytes=Buffer.from(m.bytes,'base64url').length;
    if(m.kind==='text'){
      const file=skeleton.files.find(f=>f.itemId===m.itemId)!;
      file.text={kind:'part',objectId:m.itemId};
      skeleton.parts.push({objectId:m.itemId,kind:'text',bytes,sha256:m.sha256,mediaType:'text/plain;charset=utf-8'});
    }else{
      skeleton.finalLogo={itemId:m.itemId,originId:m.itemId,objectId:m.itemId};
      skeleton.parts.push({objectId:m.itemId,kind:'finalLogo',bytes:131072,sha256:m.sha256,mediaType:'image/webp'});
    }
  }
  const manifestMax=Buffer.byteLength(wireJson(skeleton));
  const finalLogo=logo?131072:0;
  return Math.max(1,text+sizes.filter(x=>x.kind==='text').sort((a,b)=>b.bytes-a.bytes).slice(0,2).reduce((n,s)=>n+s.bytes,0),text+(logo?.bytes??0)+finalLogo,text+finalLogo+2*manifestMax);
}
export function typedRichEdit(req:Extract<RecipeAuthoringRequest,{type:'richEdit'}>):RichLocalDraft{
  const base={canonical:req.canonical,selected:req.selected};
  const content=verifyEditBase(req.canonical,req.selected);
  if(!req.changes&&!req.logo&&!req.access)return {base};
  const allowed=new Set(req.selected);
  const changes=[...(req.changes??[])];
  if(req.access&&!changes.length&&!req.logo)changes.push({op:'setAccess',value:req.access});
  for(const change of changes){
    if(change.op==='setAccess'){if(req.access!==change.value)throw new Error('获取方式不一致。');continue;}
    if(change.op==='setFinalLogo')throw new Error('请选择原始 Logo 文件。');
    if(!safeEditValue(change))throw new Error('所选编辑含敏感内容。');
    if(change.op==='addSetup'){
      if(change.source.kind!=='accountClaim')throw new Error('请在源设备选择需要继承的步骤。');
    }else if(change.op==='includeCandidate'){
      const ref=change.value.source;
      if(!req.source||ref.sourceIntentId!==req.source.sourceIntentId||ref.expectedRevision!==req.baseRevision||
        !itemsOf(decodeRichRecipeContent(Buffer.from(req.source.canonical,'base64url')).content).some(i=>i.itemId===ref.candidateId))throw new Error('候选来源已改变。');
      if('parentItemId' in change.value&&!allowed.has(change.value.parentItemId))throw new Error('需选择对应的父条目。');
    }else if(change.op==='copyItem'){
      if(!allowed.has(change.source.itemId)||'parentItemId' in change.source&&!allowed.has(change.source.parentItemId))throw new Error('需要选中复制来源和目标。');
    }else if(!allowed.has(change.itemId))throw new Error('编辑目标不在核对范围内。');
  }
  const members:NonNullable<RichLocalDraft['members']>=[];
  if(req.logo){
    if(content.finalLogo&&!allowed.has(content.finalLogo.itemId))throw new Error('请先选择要替换的 Logo。');
    const bytes=Buffer.from(req.logo,'base64url');
    if(bytes.length>2097152||bytes.toString('base64url')!==req.logo)throw new Error('Logo 无效。');
    staticLogoFormat(bytes);
    const objectId=randomUUID();
    changes.push({op:'setFinalLogo',...(content.finalLogo&&{itemId:content.finalLogo.itemId}),objectId});
    members.push({itemId:objectId,kind:'finalLogo',bytes:req.logo,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  canonicalizeRichRecipeContent(content);
  return {base,members,selectionDigest:wireDigest({draftId:req.draftId,revision:req.baseRevision,selected:req.selected,changes:req.changes??[],access:req.access??null,logo:members[0]?.sha256??null}),request:{format:'rich-v2',...(req.access&&{access:req.access}),baseCanonical:req.canonical,...(req.source&&{candidates:[req.source]}),payload:{
    format:'rich-v2',purpose:'editDraft',draftId:req.draftId,baseRevision:req.baseRevision,requestId:randomUUID(),schemaVersion:2,changes}}};
}
export function richEditTargets(content:RecipeRichContent,selected:readonly string[]):RichModelItem[]{
  const items:RichModelItem[]=[];
  const add=(item: {itemId:string;originId:string}&Record<string,unknown>,kind:RichModelItem['kind'],field?:string)=>{
    if(!selected.includes(item.itemId))return;
    const {itemId,originId:_origin,...data}=item;
    let value=kind==='publicText'||kind==='setting'?data.value:kind==='role'?data.text:data;
    if(kind==='skill')value={name:data.name};
    if(kind==='file')value={name:data.name,use:data.use};
    if(kind==='memory'||kind==='finalLogo')value={selected:true};
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
    ...Object.entries(request.content.public).filter(([,v])=>!op.rich?.newFields||op.rich.newFields.includes(v.itemId)).map(([field,v])=>({label:field,valueJson:JSON.stringify(v.value)})),
    ...request.content.setup.filter(v=>!op.rich?.newFields||op.rich.newFields.includes(v.itemId)).map((step,i)=>({label:'准备步骤 '+(i+1),valueJson:wireJson({title:step.title,instructions:step.instructions,
      kind:step.kind,required:step.required,action:step.action,...(step.check!==undefined&&{check:step.check})})})),
    {label:'已在 App 核对的来源',valueJson:'公开字段 4、准备步骤 '+request.content.setup.length+'、规则 '+request.content.rules.length+'、技能 '+request.content.skills.length+'、任务 '+request.content.tasks.length+'、记忆 '+request.content.memories.length+'、设置 '+request.content.settings.length+'。'},
  ] : [...request.payload.changes.map(c=>c.op==='setFinalLogo'?{label:'所选 Logo 原图 SHA-256',valueJson:op.rich?.members?.find(m=>m.kind==='finalLogo')?.sha256??''}:{label:c.op,valueJson:wireJson(c)}),...(request.access?[{label:'获取方式',valueJson:request.access==='coded'?'凭码获取':'直接获取'}]:[])];
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
  const selected=base?.selected??(original?[...new Set([...Object.values(original.content.public).map(i=>i.itemId),
    ...original.content.setup.map(i=>i.itemId),...(rich.source?.selected??[])])]:[]);
  const content=base?verifyEditBase(base.canonical,selected):original?.content;
  if(!content)throw new Error('缺少本次草稿快照。');
  const presentIds=new Set(itemsOf(content).map(i=>i.itemId));
  const targets=richEditTargets(content,selected.filter(id=>presentIds.has(id)));
  const named=targets.filter(t=>t.field&&({
    name:/名称|名字|标题|\bname\b/i, summary:/简介|摘要|\bsummary\b/i,overview:/概览|概述|\boverview\b/i,version:/版本|\bversion\b/i,
  } as Record<string,RegExp>)[t.field]?.test(instruction));
  const scoped=named.length&&!/步骤|准备|setup|角色|技能|任务|规则|权限/i.test(instruction)?named:targets;
  const grounding=scoped.map(t=>['memory','file','skill','finalLogo'].includes(t.kind)||Buffer.byteLength(wireJson(t.value))>4000?
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
    const newFields=[...new Set([...(rich.newFields??[]),...parsed.changes.flatMap(c=>'itemId' in c&&c.itemId?[c.itemId]:[]),
      ...request.content.setup.filter(step=>!original.content.setup.some(s=>s.itemId===step.itemId)).map(s=>s.itemId)])];
    return {kind:'proposal',request,newFields} as const;
  }
  if(!op.view.draftId||!op.view.baseRevision||!base)throw new Error('缺少当前草稿修订。');
  for(const value of parsed.setup)parsed.changes.push({op:'addSetup',value,source});
  const request:RichFreezeInput={format:'rich-v2',baseCanonical:base.canonical,payload:{format:'rich-v2',purpose:'editDraft',draftId:op.view.draftId,
    baseRevision:op.view.baseRevision,requestId:randomUUID(),schemaVersion:2,changes:parsed.changes}};
  return {kind:'proposal',request} as const;
}
