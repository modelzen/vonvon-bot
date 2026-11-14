import {createHash,randomUUID} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({files:new Map<string,string>(),loads:[] as string[][],verifies:0,afterLoad:undefined as (()=>void)|undefined,workspace:[] as {name:string;files:string[]}[],row:undefined as unknown}));
vi.mock('../src/recipe/authoring-source',()=>({atSource:async(_c:unknown,_b:unknown,_g:unknown,fn:(r:unknown)=>unknown)=>fn(io.row)}));
vi.mock('../src/recipe/rich-file-helper',()=>({recipeFileIO:async(req:{operation:string;names?:string[];entries?:{name:string;data:string}[]})=>{
  const root='a'.repeat(64);
  if(req.operation==='skills')return {root,skills:io.workspace};
  if(req.operation==='identity')return {root};
  if(req.operation==='verify'){io.verifies++;return {root};}
  if(req.operation==='stage'){for(const e of req.entries!)io.files.set(e.name,e.data);return {root};}
  if(req.operation==='load'){io.loads.push(req.names!);io.afterLoad?.();return {root,files:req.names!.map(name=>({name,identity:'held',data:io.files.get(name)}))};}
  throw Error('unexpected operation '+req.operation);
}}));
import {agentIdSchema,canonicalizeRichRecipeContent,digestRichRecipeContent,groupIdSchema,recipeAuthoringReplySchema,type RecipeRichContent} from '@vonvon/protocol';
import {stageRichRecipeGeneration} from '../src/recipe/rich-generation';
import {nativeRichSourceItems} from '../src/recipe/rich-source-lineage';
import {preparedRich,readRichSource,richSkillOptions,type RichNativeOptions} from '../src/recipe/authoring-rich-flow';
import type {Project} from '../src/project/registry';

const ident=()=>({itemId:randomUUID(),originId:randomUUID()});
const options={includeBotMemories:false,includeTasks:false,skills:[] as {skill:string;files:string[]}[]};
const native={bot:{appId:'managed-metadata-test'},channel:{},managedSources:nativeRichSourceItems} as unknown as RichNativeOptions;
beforeEach(()=>{io.files.clear();io.loads=[];io.verifies=0;io.afterLoad=undefined;io.workspace=[];});
async function fixture(count=1,effective=false){
  const bytes=[Buffer.from('SELECTED_ENTRY_BODY'),Buffer.from('UNSELECTED_FILE_BODY')];
  const parts=bytes.map(data=>({objectId:randomUUID(),kind:'text' as const,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),mediaType:'text/plain;charset=utf-8' as const}));
  const entry={...ident(),name:'SKILL.md',use:'skillDescription' as const,text:{kind:'part' as const,objectId:parts[0]!.objectId}};
  const reference={...ident(),name:'unselected.txt',use:'reference' as const,text:{kind:'part' as const,objectId:parts[1]!.objectId}};
  const skills=Array.from({length:count},(_,i)=>({...ident(),name:'helper'+i,entryFileId:entry.itemId,fileIds:[entry.itemId,reference.itemId]}));
  const field=()=>({...ident(),value:'review'});
  const content:RecipeRichContent={format:'rich-v2',schemaVersion:2,public:{name:field(),summary:field(),overview:field(),version:field()},settings:[],rules:[],tasks:[],setup:[],memories:[],files:[entry,reference],skills,parts};
  const canonical=canonicalizeRichRecipeContent(content);
  const release={format:'rich-v2' as const,recipeId:randomUUID(),versionId:randomUUID(),authorId:randomUUID(),revision:1,access:'direct' as const,contentSha256:await digestRichRecipeContent(canonical),logicalBytes:canonical.logicalBytes};
  const slot={botDataRoot:'/synthetic',installationId:randomUUID(),generationId:randomUUID()};
  const files=content.files.map((file,i)=>({...file,text:{kind:'inline' as const,value:bytes[i]!.toString()}}));
  const staged=await stageRichRecipeGeneration({...slot,release,canonicalUTF8:canonical.canonicalUTF8,readMember:async(_,part)=>bytes[parts.findIndex(p=>p.objectId===part.objectId)]!,...(effective&&{effectiveSkills:{skills,files}})});
  const resolved=[...skills.map(skill=>({kind:'skills' as const,...skill,value:{name:skill.name,entryFileId:entry.itemId,fileIds:skill.fileIds}})),...files.map(file=>({kind:'files' as const,...file,value:{name:file.name,use:file.use,text:file.text.value}}))];
  const row={cwd:'/unused',bindingIncarnation:'binding',projectSettingsRevision:1,richRecipe:{bindingIncarnation:'binding',pointer:staged.pointer,resolved,sources:Object.fromEntries(resolved.map(x=>[x.itemId,{parents:[{versionId:release.versionId,itemId:x.itemId,baselineSha256:'b'.repeat(64)}],authorId:release.authorId,access:'direct'}]))}} as unknown as Project;
  io.row=row;io.loads=[];
  return {row,entry,reference,parts,staged};
}
it.each([false,true])('lists managed filenames and previews an empty selection without reading text members, effective=%s',async effective=>{
  const x=await fixture(1,effective);
  const choices=await richSkillOptions(native,'group');
  expect(choices[0]!.files).toEqual(['SKILL.md','unselected.txt']);
  expect(JSON.stringify(choices)).not.toMatch(/SELECTED_ENTRY_BODY|UNSELECTED_FILE_BODY/);
  expect(io.loads.flat().filter(name=>name.startsWith('parts/')||name.startsWith('effective/'))).toEqual([]);
  expect(io.verifies).toBe(0);
  io.loads=[];
  const inventory=await readRichSource(native,'scope',randomUUID(),'group',options);
  expect(inventory.content.skills).toEqual([]);expect(inventory.content.files).toEqual([]);
  expect(io.loads.flat().filter(name=>name.startsWith('parts/')||name.startsWith('effective/'))).toEqual([]);
  expect(io.verifies).toBe(0);
  const account=randomUUID();
  const selectedOptions={...options,skills:[{skill:choices[0]!.name,files:['SKILL.md']}]};
  const selected=await readRichSource(native,'scope',account,'group',selectedOptions);
  expect(selected.content.files.map(file=>file.itemId)).toEqual([x.entry.itemId]);
  expect(selected.content.files[0]!.text).toEqual({kind:'inline',value:'SELECTED_ENTRY_BODY'});
  expect(selected.content.skills[0]!.fileIds).toEqual([x.entry.itemId]);
  expect(io.loads.flat().filter(name=>name.startsWith('parts/')||name.startsWith('effective/'))).toHaveLength(1);
  expect(JSON.stringify(selected.content)).not.toContain('UNSELECTED_FILE_BODY');
  const skill=selected.content.skills[0]!;
  const source=x.row.richRecipe!.sources[skill.itemId]!;
  const draft=preparedRich({
    type:'richPrepare',botId:agentIdSchema.parse('cli_managed'),session:'managed',groupId:groupIdSchema.parse('oc_managed'),
    selection:{options:selectedOptions,selected:[skill.itemId,x.entry.itemId],reviewToken:selected.lease,sourceAttested:true,
      public:{name:'',summary:'',overview:'',version:''},access:'direct',setup:[]},
    attestations:[{versionId:source.parents[0]!.versionId,authorId:source.authorId,access:source.access,
      items:[{...source.parents[0]!,kind:'skill'},{...x.row.richRecipe!.sources[x.entry.itemId]!.parents[0]!,kind:'file'}]}],
  },selected,account);
  expect(draft.members).toHaveLength(1);
  expect(Buffer.from(draft.members![0]!.bytes,'base64url').toString()).toBe('SELECTED_ENTRY_BODY');
  expect(draft.request&&'content' in draft.request&&draft.request.origins.find(origin=>origin.itemId===skill.itemId)?.source).toEqual({kind:'releaseItem',...source.parents[0]});
});
it('rejects changed manifests, active inventory digests, file bytes, lineage, and source revisions',async()=>{
  const x=await fixture();
  const pointer=x.row.richRecipe!.pointer;
  const receipt=io.files.get('receipt.json')!;
  x.row.richRecipe!.pointer={...pointer,resolvedSha256:'0'.repeat(64)};
  io.files.set('receipt.json',Buffer.from(JSON.stringify(x.row.richRecipe!.pointer)).toString('base64'));
  await expect(richSkillOptions(native,'group')).rejects.toThrow('digest');
  x.row.richRecipe!.pointer=pointer;io.files.set('receipt.json',receipt);
  const manifest=io.files.get('manifest.json')!;
  const changed=JSON.parse(Buffer.from(manifest,'base64').toString());changed.skills[0].name='changed';
  io.files.set('manifest.json',Buffer.from(canonicalizeRichRecipeContent(changed).canonicalUTF8).toString('base64'));
  await expect(richSkillOptions(native,'group')).rejects.toThrow();
  io.files.set('manifest.json',manifest);
  const choices=await richSkillOptions(native,'group');
  const selected={...options,skills:[{skill:choices[0]!.name,files:['SKILL.md']}]};
  const member='parts/'+x.parts[0]!.objectId;
  const body=io.files.get(member)!;io.files.set(member,Buffer.from('changed').toString('base64'));
  await expect(readRichSource(native,'scope',randomUUID(),'group',selected)).rejects.toThrow('file');
  io.files.set(member,body);
  const source=x.row.richRecipe!.sources[x.entry.itemId]!;delete x.row.richRecipe!.sources[x.entry.itemId];
  await expect(richSkillOptions(native,'group')).rejects.toThrow('来源');
  x.row.richRecipe!.sources[x.entry.itemId]=source;
  io.afterLoad=()=>{x.row.projectSettingsRevision=(x.row.projectSettingsRevision??0)+1;};
  await expect(richSkillOptions(native,'group')).rejects.toThrow('变化');
  await expect(readRichSource(native,'scope',randomUUID(),'group',selected)).rejects.toThrow('变化');
});
it('accepts the complete local and single installed-generation option domain without truncation',async()=>{
  await fixture(16);
  io.workspace=Array.from({length:128},(_,i)=>({name:'workspace'+i,files:['SKILL.md']}));
  const skills=await richSkillOptions(native,'group');
  expect(skills).toHaveLength(144);
  expect(recipeAuthoringReplySchema.safeParse({kind:'richSourceOptions',skills}).success).toBe(true);
  expect(recipeAuthoringReplySchema.safeParse({kind:'richSourceOptions',skills:[...skills,skills[0]]}).success).toBe(false);
});
