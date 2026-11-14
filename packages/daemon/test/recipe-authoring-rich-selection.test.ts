import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({row:{cwd:'/unused',bindingIncarnation:'binding',projectSettingsRevision:1,richRecipe:true}}));
vi.mock('../src/recipe/authoring-source',()=>({atSource:async(_c:unknown,_b:unknown,_g:unknown,fn:(r:unknown)=>unknown)=>fn(state.row)}));
vi.mock('../src/recipe/rich-file-helper',()=>({recipeFileIO:async()=>({skills:[]})}));
import {readRichSource,richSkillOptions,preparedRich} from '../src/recipe/authoring-rich-flow';
import type {RichNativeOptions} from '../src/recipe/authoring-rich-flow';
import type {ManagedSourceItem} from '../src/recipe/authoring-rich-managed';

it('requires explicit managed skill and filename choices while retaining provenance',async()=>{
 const account=randomUUID(),versionId=randomUUID(),entry=randomUUID(),ref=randomUUID(),skill=randomUUID(),setup=randomUUID();
 const item=(kind:ManagedSourceItem['kind'],itemId:string,value:Record<string,unknown>):ManagedSourceItem=>({kind,itemId,originId:randomUUID(),value,parents:[{versionId,itemId,baselineSha256:'1'.repeat(64)}],authorId:account,access:'direct'});
 const managed=[item('skills',skill,{name:'helper',entryFileId:entry,fileIds:[entry,ref]}),item('files',entry,{name:'SKILL.md',use:'skillDescription',text:'ENTRY_SENTINEL'}),item('files',ref,{name:'reference.md',use:'reference',text:'REFERENCE_SENTINEL'}),item('setup',setup,{kind:'tool',title:'确认工具',instructions:'SETUP_SENTINEL',required:true,action:{kind:'manual'}})];
 const native={bot:{appId:'test-rich-selection'},channel:{},managedSources:async()=>managed} as unknown as RichNativeOptions;
 const options={includeBotMemories:false,includeTasks:false,skills:[] as {skill:string;files:string[]}[]};
 const empty=await readRichSource(native,'scope',account,'group',options);
 expect(empty.content.skills).toEqual([]);expect(empty.content.files).toEqual([]);
 const choices=await richSkillOptions(native,'group');expect(choices).toHaveLength(1);expect(choices[0]!.files).toEqual(['SKILL.md','reference.md']);
 options.skills=[{skill:choices[0]!.name,files:['SKILL.md']}];
 const inventory=await readRichSource(native,'scope',account,'group',options);
 expect(inventory.content.skills[0]!.fileIds).toEqual([entry]);expect(inventory.content.files.map(f=>f.itemId)).toEqual([entry]);
 expect(inventory.evidence.get(skill)).toEqual({kind:'managed',parents:managed[0]!.parents});
 const attestations=[{versionId,authorId:account,access:'direct',items:managed.map(m=>m.parents[0])}];
 const prepared=preparedRich({type:'richPrepare',groupId:'group',selection:{options,selected:[skill,entry],reviewToken:inventory.lease,sourceAttested:true,public:{name:'',summary:'',overview:'',version:''},access:'direct',setup:[]},attestations} as Parameters<typeof preparedRich>[0],inventory,account);
 expect(JSON.stringify(prepared.request)).not.toContain('REFERENCE_SENTINEL');expect(JSON.stringify(prepared.request)).not.toContain('SETUP_SENTINEL');
 expect(prepared.members).toHaveLength(1);expect(prepared.request&&'content'in prepared.request&&prepared.request.origins.find(o=>o.itemId===skill)?.source).toEqual({kind:'releaseItem',...managed[0]!.parents[0]});
 managed.forEach(m=>{m.access='coded';m.authorId=randomUUID();});
 const coded=await readRichSource(native,'scope',account,'group',options);expect(coded.evidence.get(skill)).toEqual({kind:'unresolved'});
});
