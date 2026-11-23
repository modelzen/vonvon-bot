import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {draftScopeHeadSchema,validateWritableRichRecipeContent,type DraftScopeApply,type DraftScopeHead,type RecipeRichContent} from '@vonvon/protocol';
import {contentItems} from '../../daemon/src/recipe/authoring-handoff-menu.js';
import {itemsOf,selectRichSnapshot,type AttestedSourceItem} from '../../daemon/src/recipe/authoring-rich-snapshot.js';
import type {LocalRecipeDraftRecord} from './local-recipe-drafts.js';

const changed=()=>new Error('私人草稿的修订、所选范围或来源已变化，请重新盘点。');
export function draftScopeHead(record:LocalRecipeDraftRecord):DraftScopeHead{
  const {draft}=record;
  if(draft.format!=='rich-v2')throw changed();
  const entries=new Set(draft.rich.content.skills.map(s=>s.entryFileId));
  const items=contentItems(draft.rich.content).filter(i=>['role','setting','rule','skill','task'].includes(i.kind)||i.kind==='file'&&!entries.has(i.id))
    .map(({id,kind,label,parent})=>({id,kind,label,...(parent&&{parent})}));
  return draftScopeHeadSchema.parse({revision:draft.revision,baseSha256:createHash('sha256').update(Buffer.from(draft.rich.canonical,'base64url')).digest('hex'),items});
}
function references(content:RecipeRichContent){
  const ids=new Set<string>();
  for(const r of [...content.files,...content.rules,...content.memories,...content.tasks,...(content.role?[content.role]:[])]){
    const text='instruction'in r?r.instruction:r.text;if(text.kind==='part')ids.add(text.objectId);
  }
  if(content.finalLogo)ids.add(content.finalLogo.objectId);
  return ids;
}
export function editLocalDraftScope(record:LocalRecipeDraftRecord,input:DraftScopeApply,attested:Map<string,AttestedSourceItem>){
  const {draft}=record,head=draftScopeHead(record);
  if(!isDeepStrictEqual(record.work,input.work)||draft.format!=='rich-v2'||draft.draftId!==input.work.draftId||draft.revision!==input.revision||head.baseSha256!==input.baseSha256)throw changed();
  const remove=new Set(input.removeIds),existing=new Set(head.items.map(i=>i.id));
  if(remove.size!==input.removeIds.length||input.removeIds.some(id=>!existing.has(id)))throw changed();
  const donor=input.donor,donorIds=itemsOf(donor).map(i=>i.itemId);
  const approved=selectRichSnapshot({inventory:donor,selected:donorIds,evidence:new Map(Object.entries(input.evidence)),
    account:record.association.accountId,ownershipClaim:true,access:draft.public.access,attested});
  if(donor.finalLogo||donor.memories.length||donor.setup.length||donor.parts.length||donor.files.some(f=>f.text.kind!=='inline'))throw changed();
  const content=structuredClone(draft.rich.content),baseItems=new Set(itemsOf(content).map(i=>i.itemId));
  const extraOrigins=new Map(approved.origins.map(i=>[i.itemId,i.source])),adds=new Set(input.addIds);
  const top=[...(donor.role?[donor.role]:[]),...donor.settings,...donor.rules,...donor.skills,...donor.tasks];
  const candidates=new Set([...top,...donor.files].map(i=>i.itemId));
  if([...adds].some(id=>!candidates.has(id)||baseItems.has(id)||remove.has(id)))throw changed();
  for(const item of [...(donor.role?[donor.role]:[]),...donor.settings,...donor.rules,...donor.tasks])if(!adds.has(item.itemId))throw changed();
  if(content.role&&remove.has(content.role.itemId))delete content.role;
  if(donor.role){if(content.role)throw changed();content.role=structuredClone(donor.role);}
  content.settings=[...content.settings.filter(s=>!remove.has(s.itemId)),...donor.settings];
  content.rules=[...content.rules.filter(r=>!remove.has(r.itemId)),...donor.rules];
  content.tasks=[...content.tasks.filter(t=>!remove.has(t.itemId)),...donor.tasks];
  content.skills=content.skills.filter(s=>!remove.has(s.itemId));
  for(const skill of content.skills)skill.fileIds=skill.fileIds.filter(id=>!remove.has(id));
  for(const incoming of donor.skills){
    if(adds.has(incoming.itemId)){content.skills.push(structuredClone(incoming));continue;}
    const previous=content.skills.find(s=>s.itemId===incoming.itemId);
    const added=incoming.fileIds.filter(id=>adds.has(id));
    if(!previous||!added.length||previous.originId!==incoming.originId||previous.entryFileId!==incoming.entryFileId||
      incoming.fileIds.some(id=>id!==incoming.entryFileId&&!adds.has(id)))throw changed();
    previous.fileIds=[...new Set([...previous.fileIds,...added])];
  }
  const usedFiles=new Set(content.skills.flatMap(s=>s.fileIds));
  content.files=[...content.files.filter(f=>usedFiles.has(f.itemId)),...donor.files.filter(f=>usedFiles.has(f.itemId)&&!baseItems.has(f.itemId))];
  const retainedParts=references(content);
  content.parts=content.parts.filter(p=>retainedParts.has(p.objectId));
  const doc=validateWritableRichRecipeContent(content),current=itemsOf(doc.content).map(i=>i.itemId);
  const prior=new Map(record.origins?.map(row=>[row.itemId,row.source]));
  const origins=current.map(itemId=>{const source=prior.get(itemId)??extraOrigins.get(itemId);if(!source)throw changed();return {itemId,source};});
  const texts=Object.fromEntries(Object.entries(draft.rich.texts).filter(([id])=>retainedParts.has(id)));
  return {...record,origins,selected:current.filter(id=>!baseItems.has(id)||(record.selected??current).includes(id)),
    draft:{...draft,revision:draft.revision+1,rich:{content:doc.content,canonical:Buffer.from(doc.canonicalUTF8).toString('base64url'),texts}}};
}
