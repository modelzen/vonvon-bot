import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {agentIdSchema,canonicalizeRichRecipeContent,groupIdSchema,type RecipeRichContent} from '@vonvon/protocol';
import {nativeRichInventory} from '../src/recipe/authoring-rich-inventory';
import {applyManagedInventory} from '../src/recipe/authoring-rich-managed';
import {itemsOf,selectRichSnapshot,wireDigest,wireJson,type SourceEvidence} from '../src/recipe/authoring-rich-snapshot';
import {recipeSnapshot,mergeRecipeItems,type LocalRecipeItem} from '../src/recipe/rich-merge';
import {localRecipeItems} from '../src/recipe/rich-settings';
import {contentItems,emptySelection,setChoices,toggleChoice,handoffCard,candidateChanges,hasLegacyMemoryChoices,type PrivateHandoff} from '../src/recipe/authoring-handoff-menu';
import {typedRichEdit,richCardReview,richEditTargets,chatRichProposal,validateRichProposal} from '../src/recipe/authoring-rich-flow';
import {checkedRichInput} from '../src/recipe/authoring-rich-model';
import {verifyFrozenRich} from '../src/recipe/authoring-rich-proof';
import {applyChanges} from '../../../services/recipe-api/src/rich-document.mjs';
import {assemble,loadContextSources,openingInstructions} from '../src/bot/context-assembly';
import {MemoryStore,botMemoryLocation} from '../src/bot/memory-store';
import type {Project} from '../src/project/registry';

const identity=()=>({itemId:randomUUID(),originId:randomUUID()});
function content():RecipeRichContent{
  const field=()=>({...identity(),value:'review'});
  return {format:'rich-v2',schemaVersion:2,public:{name:field(),summary:field(),overview:field(),version:field()},
    settings:[],rules:[{...identity(),purpose:'work',text:{kind:'inline',value:'KEEP_WORK_RULE'}}],skills:[],files:[],tasks:[],setup:[],parts:[],
    memories:[{...identity(),text:{kind:'inline',value:'LEGACY_RECIPE_MEMORY_SENTINEL'}}]};
}
function project(resolved:LocalRecipeItem[]=[],cwd='/unused'):Project{
  const bindingIncarnation=randomUUID();
  return {name:'fixture',chatId:'oc_no_memory',bindingIncarnation,blank:true,createdAt:1,cwd,
    richRecipe:{bindingIncarnation,pointer:{format:'recipe-generation-1',installationId:randomUUID(),generationId:randomUUID(),selection:'effective',
      rootIdentity:'root',resolvedSha256:'a'.repeat(64),release:{format:'rich-v2',recipeId:randomUUID(),versionId:randomUUID(),authorId:randomUUID(),revision:1,
        access:'direct',contentSha256:'b'.repeat(64),logicalBytes:1}},choices:{},sources:{},setup:{},resolved,receipt:'receipt',installedAt:1}};
}
it('never reads native memory for recipe capture, even with the old option enabled',async()=>{
  const read=vi.spyOn(MemoryStore.prototype,'read').mockRejectedValue(new Error('recipe capture must not read native memory'));
  try{
    const inventory=await nativeRichInventory({seed:'fixture',row:project(),botRoot:'/unused',botId:'cli_fixture',skills:[],includeBotMemories:true});
    expect(inventory.content.memories).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  }finally{read.mockRestore();}
});
it('rejects explicit memory selections and omits unselected legacy memory without changing historical identities',()=>{
  const old=content(),before=canonicalizeRichRecipeContent(old).canonical;
  const evidence=new Map<string,SourceEvidence>(itemsOf(old).map(i=>[i.itemId,{kind:'native'}]));
  const args={inventory:old,selected:[old.rules[0]!.itemId],evidence,account:randomUUID(),attested:new Map(),ownershipClaim:true,access:'direct' as const};
  const result=selectRichSnapshot(args);
  expect(result.content.memories).toEqual([]);
  expect(result.content.rules).toEqual(old.rules);
  expect(()=>selectRichSnapshot({...args,selected:[old.memories[0]!.itemId]})).toThrow('不包含记忆');
  expect(itemsOf(old).some(i=>i.itemId===old.memories[0]!.itemId)).toBe(true);
  expect(canonicalizeRichRecipeContent(old).canonical).toBe(before);
  expect(JSON.stringify(contentItems(old))).not.toContain('LEGACY_RECIPE_MEMORY_SENTINEL');
  expect(contentItems(old).some(i=>i.id===old.memories[0]!.itemId)).toBe(false);
});
it('does not admit managed memories or produce memory conflicts from base, local, or incoming projections',()=>{
  const old=content(),memory=old.memories[0]!,incoming=structuredClone(old);
  incoming.memories[0]!.text={kind:'inline',value:'NEW_RECIPE_MEMORY_SENTINEL'};
  const snapshot=recipeSnapshot(old,t=>t.kind==='inline'?t.value:'unreachable');
  const legacy:LocalRecipeItem={kind:'memories',itemId:memory.itemId,originId:memory.originId,value:{text:'LOCAL_RECIPE_MEMORY_SENTINEL'}};
  const row=project([...snapshot,legacy]);
  const merged=mergeRecipeItems(snapshot,localRecipeItems(row,[]),recipeSnapshot(incoming,t=>t.kind==='inline'?t.value:'unreachable'));
  expect(merged.conflicts).toEqual([]);
  expect(merged.resolved.map(i=>i.kind)).toEqual(['rules']);
  const target=content();target.memories=[];
  const evidence=new Map<string,SourceEvidence>();
  applyManagedInventory(target,evidence,[{...legacy,parents:[],authorId:randomUUID(),access:'direct'}],randomUUID());
  expect(target.memories).toEqual([]);expect(evidence.has(memory.itemId)).toBe(false);
});
it('immediately ignores an old installed memory overlay while preserving native memory bytes and work rules',async()=>{
  const root=await mkdtemp(join(process.env.VONVON_HOME!,'memory-boundary-'));
  const store=new MemoryStore(botMemoryLocation(root));
  await store.add({text:'REAL_BOT_MEMORY_SENTINEL',branch:'合作方式',trust:'trusted',source:{via:'ui',botId:'cli_memory',actorRole:'desktop'},actor:{role:'desktop'}});
  const bytes=async()=>Object.fromEntries(await Promise.all((await readdir(store.location.dir)).sort().map(async name=>[name,(await readFile(join(store.location.dir,name))).toString('base64')])));
  const before=await bytes(),old=content(),memory=old.memories[0]!;
  const resolved:LocalRecipeItem[]=[...recipeSnapshot(old,t=>t.kind==='inline'?t.value:'unreachable'),
    {kind:'memories',itemId:memory.itemId,originId:memory.originId,value:{text:'LEGACY_RECIPE_MEMORY_SENTINEL'}}];
  const row=project(resolved,root),frozen=wireDigest(row.richRecipe);
  const loaded=await loadContextSources({appId:'cli_memory',botDirectory:root,place:{kind:'group',chatId:row.chatId,chatName:row.name},row});
  const text=openingInstructions(assemble(loaded),'fixture');
  expect(text).toContain('REAL_BOT_MEMORY_SENTINEL');expect(text).toContain('KEEP_WORK_RULE');
  expect(text).not.toContain('LEGACY_RECIPE_MEMORY_SENTINEL');
  expect(await bytes()).toEqual(before);expect(wireDigest(row.richRecipe)).toBe(frozen);
});
it('cleans 64 old memories in one reviewed operation and prunes only orphaned parts',()=>{
  const old=content(),shared=Buffer.from('KEEP_SHARED_ROLE_TEXT'),orphan=Buffer.from('REMOVE_MEMORY_PART_SENTINEL');
  const parts=[shared,orphan].map(bytes=>({objectId:randomUUID(),kind:'text' as const,bytes:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex'),mediaType:'text/plain;charset=utf-8' as const}));
  old.role={...identity(),text:{kind:'part',objectId:parts[0]!.objectId}};old.parts=parts;
  old.memories=Array.from({length:64},(_,index)=>({...identity(),text:{kind:'part' as const,objectId:parts[index%2]!.objectId}}));
  const canonical=Buffer.from(canonicalizeRichRecipeContent(old).canonicalUTF8).toString('base64url');
  const draftId=randomUUID(),operationId=randomUUID();
  const rich=typedRichEdit({type:'richEdit',botId:agentIdSchema.parse('cli_fixture'),session:'fixture',draftId,baseRevision:4,canonical,selected:[old.public.name.itemId]});
  if(!rich.request||!('payload'in rich.request))throw new Error('cleanup request missing');
  const edit=rich.request;
  expect(edit.payload.changes).toEqual([{op:'removeLegacyMemories'}]);
  const review=richCardReview({view:{operationId,draftId,baseRevision:4},rich});
  expect(review?.fields).toEqual(expect.arrayContaining([expect.objectContaining({label:'配方内容',text:'本次修订排除旧配方中的记忆。群和 Bot 原有记忆不变。'})]));
  expect(JSON.stringify(review)).not.toMatch(/REMOVE_MEMORY_PART_SENTINEL|LEGACY_RECIPE_MEMORY_SENTINEL/);
  for(const memory of old.memories)expect(JSON.stringify(review)).not.toContain(memory.itemId);
  const applied=applyChanges(old,edit.payload.changes,()=>{throw new Error('no donor required');},Buffer.alloc(32)).doc.content;
  expect(applied.memories).toEqual([]);expect(applied.parts).toEqual([parts[0]]);
  expect(applied.role).toEqual(old.role);expect(applied.rules).toEqual(old.rules);expect(applied.public).toEqual(old.public);
  const final=canonicalizeRichRecipeContent(applied),stablePayload=Buffer.from(wireJson(edit.payload));
  const frozen={format:'rich-v2',destinationDraftId:draftId,sourceReviewSha256:wireDigest(rich.request),canonical:Buffer.from(final.canonicalUTF8).toString('base64url'),
    contentSha256:createHash('sha256').update(final.canonicalUTF8).digest('hex'),logicalBytes:final.logicalBytes,payload:stablePayload.toString('base64url'),payloadDigest:createHash('sha256').update(stablePayload).digest('hex')};
  expect(verifyFrozenRich(operationId,draftId,edit,frozen)).toEqual(frozen);
  expect(()=>verifyFrozenRich(operationId,draftId,{...edit,payload:{...edit.payload,baseRevision:3}},frozen)).toThrow();
  expect(Buffer.from(canonical,'base64url').toString()).toBe(canonicalizeRichRecipeContent(old).canonical);
});
it('keeps memory out of typed and model proposals, including copy or restore followed by cleanup',async()=>{
  const old=content(),canonical=Buffer.from(canonicalizeRichRecipeContent(old).canonicalUTF8).toString('base64url');
  const memory=old.memories[0]!,selected=[old.public.name.itemId],sourceIntentId=randomUUID();
  const request={type:'richEdit' as const,botId:agentIdSchema.parse('cli_fixture'),session:'fixture',draftId:randomUUID(),baseRevision:1,canonical,selected,source:{sourceIntentId,canonical}};
  expect(()=>typedRichEdit({...request,selected:[memory.itemId]})).toThrow('不包含记忆');
  for(const change of [{op:'copyItem',source:{kind:'memory',itemId:memory.itemId}},
    {op:'includeCandidate',value:{kind:'memory',source:{sourceIntentId,candidateId:memory.itemId,expectedRevision:1}}}])
    expect(()=>typedRichEdit({...request,changes:[change]} as Parameters<typeof typedRichEdit>[0])).toThrow('不包含记忆');
  expect(()=>checkedRichInput({phase:'edit',instruction:'复制内容',selected:[{kind:'memory',itemId:memory.itemId,value:{selected:true}}]})).toThrow('不包含记忆');
  const targets=richEditTargets(old,[...selected,memory.itemId]);expect(targets.map(t=>t.kind)).toEqual(['publicText']);
  expect(()=>richEditTargets(old,[...selected,randomUUID()])).toThrow('不存在');
  const parser={proposeRich:vi.fn().mockResolvedValue({kind:'proposal',commands:[{action:'setPublicText',target:'T1',text:'新名称'}]})};
  const op={view:{operationId:randomUUID(),draftId:request.draftId,baseRevision:1},rich:{base:{canonical,selected:[...selected,memory.itemId]}}};
  const result=await chatRichProposal(op as Parameters<typeof chatRichProposal>[0],'把名称改为新名称',new AbortController().signal,parser);
  expect(result.kind).toBe('proposal');
  expect(JSON.stringify(parser.proposeRich.mock.calls)).not.toMatch(/LEGACY_RECIPE_MEMORY_SENTINEL|"kind":"memory"/);
  if(result.kind!=='proposal'||!('payload'in result.request))throw new Error('proposal missing');
  const edit=result.request;
  expect(edit.payload.changes.map(c=>c.op)).toEqual(['removeLegacyMemories','setPublicText']);
  expect(()=>validateRichProposal({...edit,payload:{...edit.payload,changes:[{op:'copyItem',source:{kind:'memory',itemId:memory.itemId}},{op:'removeLegacyMemories'}]}})).toThrow('不包含记忆');
});
it('restores only verified legacy memory selections and rejects stale callbacks and unknown candidates',()=>{
  const old=content(),canonical=Buffer.from(canonicalizeRichRecipeContent(old).canonicalUTF8).toString('base64url'),memory=old.memories[0]!,unknown=randomUUID();
  const h:PrivateHandoff={retryId:randomUUID(),groupId:groupIdSchema.parse('oc_no_memory'),groupName:'fixture',identity:'fixture',account:randomUUID(),scope:'fixture',binding:'fixture',
    recipient:{chatId:'oc_private',openId:'ou_fixture',tenantKey:'fixture'},session:'fixture',expiresAt:1,ref:randomUUID(),generation:1,sendUuid:randomUUID(),phase:{state:'selecting'},
    selection:{...emptySelection(),options:{skills:[],includeBotMemories:true,includeTasks:false},selected:[old.public.name.itemId,memory.itemId,unknown],candidates:[memory.itemId,unknown]},
    edit:{draftId:randomUUID(),baseRevision:1,canonical,source:{sourceIntentId:randomUUID(),canonical}}};
  expect(hasLegacyMemoryChoices(h)).toBe(true);setChoices(h);
  expect(h.selection.selected).toEqual([old.public.name.itemId,unknown]);expect(h.selection.candidates).toEqual([unknown]);
  expect(h.selection.options.includeBotMemories).toBe(false);expect(JSON.stringify(handoffCard(h))).not.toContain('LEGACY_RECIPE_MEMORY_SENTINEL');
  expect(()=>candidateChanges(h)).toThrow('候选已变化');
  expect(()=>toggleChoice(h,{a:'recipe.authoring',verb:'handoff',ref:h.ref,generation:1,action:'memories'})).toThrow('不包含记忆');
  h.selection.choices=[{action:'item',id:memory.itemId,label:'LEGACY_RECIPE_MEMORY_SENTINEL',checked:false}];
  expect(()=>toggleChoice(h,{a:'recipe.authoring',verb:'handoff',ref:h.ref,generation:1,action:'choice',index:0})).toThrow('不包含记忆');
});
it('combines cleanup with 15 edits and rejects 16 unchanged, allowing a cleanup-only retry before the original edits',()=>{
  const old=content(),canonical=Buffer.from(canonicalizeRichRecipeContent(old).canonicalUTF8).toString('base64url'),selected=[old.public.name.itemId];
  const edits=Array.from({length:16},(_,index)=>({op:'setPublicText' as const,field:'name' as const,itemId:selected[0]!,value:'name'+index}));
  const request={type:'richEdit' as const,botId:agentIdSchema.parse('cli_fixture'),session:'fixture',draftId:randomUUID(),baseRevision:1,canonical,selected};
  const merged=typedRichEdit({...request,changes:edits.slice(0,15)});
  expect(merged.request&&'payload'in merged.request&&merged.request.payload.changes).toHaveLength(16);
  expect(()=>typedRichEdit({...request,changes:edits})).toThrow('原草稿尚未改变');
  expect(Buffer.from(canonical,'base64url').toString()).toBe(canonicalizeRichRecipeContent(old).canonical);
  const cleanup=typedRichEdit({...request,selected:[]});
  if(!cleanup.request||!('payload'in cleanup.request))throw new Error('cleanup request missing');
  expect(cleanup.request.payload.changes).toEqual([{op:'removeLegacyMemories'}]);
  const cleaned=applyChanges(old,cleanup.request.payload.changes,()=>{throw new Error('no donor');},Buffer.alloc(32)).doc.content;
  const retried=typedRichEdit({...request,baseRevision:2,canonical:Buffer.from(canonicalizeRichRecipeContent(cleaned).canonicalUTF8).toString('base64url'),changes:edits});
  expect(retried.request&&'payload'in retried.request&&retried.request.payload.changes).toEqual(edits);
});
it('verifies exact historical memory-bearing proof bytes while refusing the same content as a new proposal',()=>{
  const old=content(),operationId=randomUUID(),destinationDraftId=randomUUID(),doc=canonicalizeRichRecipeContent(old);
  const reviewed={format:'rich-v2' as const,content:old,access:'direct' as const,
    origins:itemsOf(old).map(item=>({itemId:item.itemId,source:{kind:'accountClaim' as const}}))};
  const payload=Buffer.from(wireJson({format:'rich-v2',purpose:'prepareDraft',sourceIntentId:operationId,content:old}));
  const frozen={format:'rich-v2',destinationDraftId,sourceReviewSha256:wireDigest(reviewed),canonical:Buffer.from(doc.canonicalUTF8).toString('base64url'),
    contentSha256:createHash('sha256').update(doc.canonicalUTF8).digest('hex'),logicalBytes:doc.logicalBytes,payload:payload.toString('base64url'),payloadDigest:createHash('sha256').update(payload).digest('hex')};
  expect(verifyFrozenRich(operationId,destinationDraftId,reviewed,frozen)).toEqual(frozen);
  expect(()=>validateRichProposal(reviewed)).toThrow();
  expect(richCardReview({view:{operationId},rich:{request:reviewed}})).toBeUndefined();
  expect(canonicalizeRichRecipeContent(old).canonical).toBe(doc.canonical);
});
