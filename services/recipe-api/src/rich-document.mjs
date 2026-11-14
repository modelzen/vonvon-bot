import {createHmac,createHash} from 'node:crypto';
import {canonicalizeRichRecipeContent,recipeRichAuthoringPayloadSchema,recipeRichOriginEdgeSchema,validatePublishableRichRecipeContent} from '../../../packages/protocol/dist/index.js';
import {ApiError,badInput} from './errors.mjs';
import {canonicalJson} from './authoring-input.mjs';
import {objectKeys,uuid} from './input.mjs';
import {credentialField} from './credential-shapes.mjs';

const collections = {setting:'settings',rule:'rules',skill:'skills',file:'files',task:'tasks',memory:'memories',setup:'setup'};
const denies = () => new ApiError(403,'source_unavailable');
const digest = value => createHash('sha256').update(value).digest('hex');
export const richDigest = value => digest(canonicalJson(value));
export function document(value, published=false) {
  let result;
  try {result=(published ? validatePublishableRichRecipeContent : canonicalizeRichRecipeContent)(value);}
  catch {throw badInput();}
  if (credentialField({config:{role:result.canonical}})) throw new ApiError(422,'credential_detected');
  return result;
}
export function parseRichPayload(value) {
  const result=recipeRichAuthoringPayloadSchema.safeParse(value);
  if (!result.success) throw badInput();
  if (result.data.purpose==='prepareDraft') document(result.data.content);
  return result.data;
}
function entries(content) {
  const items=[];
  const add=(kind,item,parent,key) => items.push({kind,item,parent,key});
  for(const [field,item] of Object.entries(content.public)) add('publicText',item,content.public,field);
  for(const kind of ['role','finalLogo']) if(content[kind]) add(kind,content[kind],content,kind);
  for(const [kind,group] of Object.entries(collections)) {
    for(const item of content[group]) {
      add(kind,item,content[group]);
      if(kind==='setting' && item.field==='presentation.cardDisplay') {
        for(const block of item.value?.blocks ?? []) add('cardBlock',block,item.value.blocks);
      }
    }
  }
  return items;
}
function stableValue(content,entry) {
  const {itemId,originId,...value}=entry.item;
  const part=id=>{const p=content.parts.find(p=>p.objectId===id);if(!p)throw badInput();return p.sha256;};
  for(const key of ['text','instruction']) if(value[key]) {
    value[key]={sha256:value[key].kind==='part'?part(value[key].objectId):digest(value[key].value)};
  }
  if(entry.kind==='finalLogo') return {sha256:part(value.objectId)};
  if(entry.kind==='setting' && value.field==='presentation.cardDisplay' && value.value) value.value={...value.value,blocks:value.value.blocks.map(b=>b.kind)};
  if(entry.kind==='cardBlock') delete value.id;
  if(entry.kind==='file') delete value.name;
  if(entry.kind==='skill') return {files:value.fileIds.map(id=>stableValue(content,{kind:'file',item:content.files.find(f=>f.itemId===id)}))};
  if(entry.kind==='task') delete value.name;
  return value;
}
export function inventory(content) {
  return entries(content).map(e=>({kind:e.kind,itemId:e.item.itemId,originId:e.item.originId,
    baselineSha256:richDigest(stableValue(content,e)),...(e.kind==='publicText'?{field:e.key}:{})}));
}
function remap(content,ids) {
  for(const {item} of entries(content)) {const id=ids.get(item.itemId);if(!id)throw badInput();Object.assign(item,id);}
  for(const skill of content.skills) {skill.entryFileId=ids.get(skill.entryFileId).itemId;skill.fileIds=skill.fileIds.map(id=>ids.get(id).itemId);}
}
function allocator(seed) {
  let sequence=0;
  return ()=>{const bytes=createHmac('sha256',seed).update('rich-id:'+sequence++).digest().subarray(0,16);
    bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex');
    return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');};
}
export function freezeSnapshot(body,seed,prior=new Map()) {
  objectKeys(body,['format','content','origins','access'],['sourceVersionId','packageId']);
  if(body.format!=='rich-v2'||!['direct','coded'].includes(body.access))throw badInput();
  if(body.sourceVersionId)uuid(body.sourceVersionId);
  if(body.packageId)uuid(body.packageId);
  const randomUUID=allocator(seed);
  const content=document(body.content).content;
  const rows=inventory(content);
  if(!Array.isArray(body.origins)||body.origins.length!==rows.length)throw badInput();
  const origins=new Map();
  for(const origin of body.origins) {
    objectKeys(origin,['itemId','source']);const {itemId,source}=origin;
    if(origins.has(itemId)||!source)throw badInput();
    if(source.kind==='accountClaim')objectKeys(source,['kind']);
    else if(source.kind==='releaseItem') {
      objectKeys(source,['kind','versionId','itemId','baselineSha256']);
      if(!recipeRichOriginEdgeSchema.safeParse({versionId:source.versionId,itemId:source.itemId,baselineSha256:source.baselineSha256}).success)throw badInput();
    } else throw denies();
    origins.set(itemId,source);
  }
  const reused=new Set(), identities=new Map();
  for(const row of rows) {
    const src=origins.get(row.itemId),old=src?.kind==='releaseItem'&&src.versionId===body.sourceVersionId ? prior.get(src.itemId) : null;
    if(old) {
      if(old.kind!==row.kind||old.baselineSha256!==src.baselineSha256||reused.has(old.itemId))throw denies();
      reused.add(old.itemId);identities.set(row.itemId,{itemId:old.itemId,originId:old.originId});
    }else identities.set(row.itemId,{itemId:randomUUID(),originId:randomUUID()});
  }
  const records=rows.map(row=>{
    const source=origins.get(row.itemId);if(!source)throw badInput();
    return {...row,...identities.get(row.itemId),candidateId:row.itemId,source};
  });
  remap(content,identities);
  return {content:document(content).content,records:records.filter(r=>!reused.has(r.itemId))};
}
function stripParts(content,candidates) {
  const wanted=new Set();
  for(const {item,kind} of entries(content)) {
    if(kind==='finalLogo') wanted.add(item.objectId);
    for(const k of ['text','instruction']) if(item[k]?.kind==='part') wanted.add(item[k].objectId);
  }
  const pool=new Map([...content.parts,...candidates].map(p=>[p.objectId,p]));
  content.parts=[...pool.values()].filter(p=>wanted.has(p.objectId));
}
// Identity, file membership and nested block IDs never come from a change value.
export function applyChanges(original,changes,resolveCandidate,seed,newParts=[]) {
  const randomUUID=allocator(seed);
  const content=structuredClone(original),copies=[],parts=[...newParts];
  const find=(id,kind)=>{const entry=entries(content).find(e=>e.item.itemId===id);if(!entry||entry.kind!==kind)throw badInput();return entry;};
  function insert(kind,item,parent) {
    if(kind==='file'){find(parent,'skill').item.fileIds.push(item.itemId);content.files.push(item);}
    else if(kind==='cardBlock'){const target=find(parent,'setting').item;if(target.field!=='presentation.cardDisplay'||!target.value)throw badInput();target.value.blocks.push(item);}
    else if(kind in collections)content[collections[kind]].push(item);
    else {if(content[kind])throw badInput();content[kind]=item;}
  }
  function clone(kind,donor,sourceContent) {
    const item={...structuredClone(donor),itemId:randomUUID(),originId:randomUUID()};
    copies.push({itemId:item.itemId,originId:item.originId,donorOriginId:donor.originId,kind});
    if(kind==='skill') {
      const ids=new Map();
      for(const id of donor.fileIds){const f=sourceContent.files.find(f=>f.itemId===id);if(!f)throw denies();const copy=clone('file',f,sourceContent);content.files.push(copy);ids.set(id,copy.itemId);}
      item.fileIds=donor.fileIds.map(id=>ids.get(id));item.entryFileId=ids.get(donor.entryFileId);
    }
    if(kind==='setting'&&item.field==='presentation.cardDisplay'&&item.value)item.value.blocks=donor.value.blocks.map(b=>clone('cardBlock',b,sourceContent));
    if(kind==='cardBlock')item.id='b'+item.itemId.replaceAll('-','');
    return item;
  }
  for(const c of changes) {
    if(c.op==='copyItem'||c.op==='includeCandidate') {
      const ref=c.source??c.value;let donor,sourceContent;
      if(c.op==='copyItem'){donor=find(ref.itemId,ref.kind).item;sourceContent=content;}
      else {const candidate=resolveCandidate(ref.source);if(!candidate)throw denies();
        sourceContent=candidate.content;const entry=entries(sourceContent).find(e=>e.item.itemId===candidate.itemId&&e.kind===ref.kind);
        if(!entry)throw denies();donor=entry.item;parts.push(...sourceContent.parts);}
      insert(ref.kind,clone(ref.kind,donor,sourceContent),ref.parentItemId);continue;
    }
    if(c.op==='removeItem') {
      const e=find(c.itemId,c.kind);
      if(c.kind==='file')for(const skill of content.skills){if(skill.entryFileId===c.itemId)throw badInput();skill.fileIds=skill.fileIds.filter(id=>id!==c.itemId);}
      if(Array.isArray(e.parent))e.parent.splice(e.parent.indexOf(e.item),1);else delete e.parent[e.key];
      if(c.kind==='skill'){const kept=new Set(content.skills.flatMap(s=>s.fileIds));content.files=content.files.filter(f=>kept.has(f.itemId));}continue;
    }
    const kind={setPublicText:'publicText',setRoleText:'role',setSetting:'setting',setCardReply:'setting',setCardBlock:'cardBlock',
      setRule:'rule',setSkill:'skill',setFile:'file',setTask:'task',setSetup:'setup'}[c.op];
    const {item,key}=find(c.itemId,kind);
    if(c.op==='setPublicText'){if(c.field!==key)throw badInput();item.value=c.value;}
    else if(c.op==='setRoleText')item.text=c.value;
    else if(c.op==='setCardReply'){if(item.field!=='presentation.cardDisplay'||!item.value)throw badInput();item.value.reply=c.value;}
    else {if(c.op==='setSetting'&&item.field!==c.value.field)throw badInput();
      if(['setTask','setSetup','setCardBlock'].includes(c.op))for(const key of Object.keys(item))if(!['id','itemId','originId'].includes(key))delete item[key];
      Object.assign(item,c.value);}
  }
  stripParts(content,parts);
  return {doc:document(content),copies};
}
