import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultCardDisplay} from '@vonvon/protocol';
import {presentationConfig} from '../src/bot/group-presentation';
import {prepareNewGroupSettings} from '../src/project/initial-settings';
import type {AppConfig} from '../src/config/schema';
import {cardDisplayPresentationDefaults,listProjectsIn,materializeCardDisplaySettings,mutateProject,type Project} from '../src/project/registry';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const row=(name:string,chatId:string):Project=>({name,chatId,cwd:'/tmp',blank:false,createdAt:1});

it('copies an old Bot style once into independent group and DM snapshots',async()=>{
  const root=await mkdtemp(join(tmpdir(),'card-display-scope-'));roots.push(root);
  const file=join(root,'projects.json'),target={file,dataRoot:root};
  const legacy=defaultCardDisplay();legacy.blocks.find(block=>block.kind==='context')!.template='旧 Bot 上下文 {{context.percent}}%';
  const cfg:AppConfig={accounts:{app:{id:'bot',secret:'unused',tenant:'feishu'}},preferences:{cardDisplay:legacy}};
  const defaults=cardDisplayPresentationDefaults(cfg);
  const local=defaultCardDisplay();local.blocks.find(block=>block.kind==='context')!.template='本群 {{context.percent}}%';
  await writeFile(file,JSON.stringify({version:1,projects:[
    row('群A','oc_a'),
    {...row('群B','oc_b'),presentation:{...defaults,cardDisplay:null}},
    {...row('群C','oc_c'),presentation:{...defaults,cardDisplay:local}},
    {...row('私聊','oc_dm_bot'),dm:{people:{}},presentation:{...defaults,cardDisplay:undefined}},
  ]}));
  expect(await materializeCardDisplaySettings({legacy,defaults,target})).toBe(2);
  const read=async()=>JSON.parse(await readFile(file,'utf8')) as {projects:Project[]};
  let rows=(await read()).projects;
  expect(rows[0]?.presentation?.cardDisplay).toEqual(legacy);
  expect(rows[1]?.presentation?.cardDisplay).toBeNull();
  expect(rows[2]?.presentation?.cardDisplay).toEqual(local);
  expect(rows[3]?.presentation?.cardDisplay).toEqual(legacy);
  await mutateProject('群A',project=>{project.presentation!.cardDisplay=null;},undefined,target);
  rows=(await read()).projects;
  expect(rows[0]?.presentation?.cardDisplay).toBeNull();
  expect(rows[3]?.presentation?.cardDisplay).toEqual(legacy);
  expect(await materializeCardDisplaySettings({legacy:defaultCardDisplay(),defaults,target})).toBe(0);
});

it('never reads the old Bot style at runtime; null and absent mean native default',()=>{
  const old=defaultCardDisplay();
  const cfg:AppConfig={accounts:{app:{id:'bot',secret:'unused',tenant:'feishu'}},preferences:{cardDisplay:old,showToolCalls:false,showModel:'off',voice:{enabled:true},completionReminder:{mode:'manual',longTaskMinutes:9}}};
  const defaults=cardDisplayPresentationDefaults(cfg);
  expect(presentationConfig(cfg).preferences).toMatchObject({showToolCalls:true,showModel:'running',voice:{enabled:true},completionReminder:{mode:'manual',longTaskMinutes:9}});
  expect(presentationConfig(cfg).preferences?.cardDisplay).toBeUndefined();
  expect(presentationConfig(cfg,{presentation:{...defaults,cardDisplay:null}}).preferences).toMatchObject({showToolCalls:true,showModel:'running',cardDisplay:undefined,voice:{enabled:true},completionReminder:{mode:'manual',longTaskMinutes:9}});
  const own=defaultCardDisplay();own.blocks.find(block=>block.kind==='context')!.template='本群 {{context.percent}}%';
  expect(presentationConfig(cfg,{presentation:{...defaults,cardDisplay:own}}).preferences?.cardDisplay).toEqual(own);
  expect(cfg.preferences?.cardDisplay).toEqual(old);
});

it('materializes a fixed native default when the old Bot had no custom style',async()=>{
  const root=await mkdtemp(join(tmpdir(),'card-display-native-'));roots.push(root);
  const file=join(root,'projects.json'),target={file,dataRoot:root};
  await writeFile(file,JSON.stringify({version:1,projects:[row('群A','oc_a')]}));
  const cfg:AppConfig={accounts:{app:{id:'bot',secret:'unused',tenant:'feishu'}},preferences:{}};
  expect(await materializeCardDisplaySettings({defaults:cardDisplayPresentationDefaults(cfg),target})).toBe(1);
  const stored=JSON.parse(await readFile(file,'utf8')) as {projects:Project[]};
  expect(stored.projects[0]?.presentation?.cardDisplay).toBeNull();
  expect(await materializeCardDisplaySettings({legacy:defaultCardDisplay(),defaults:cardDisplayPresentationDefaults(cfg),target})).toBe(0);
});

it('snapshots old per-chat tool and model choices once, then reset uses the fixed native default',async()=>{
  const root=await mkdtemp(join(tmpdir(),'card-display-reset-'));roots.push(root);
  const file=join(root,'projects.json'),target={file,dataRoot:root};
  const cfg:AppConfig={accounts:{app:{id:'bot',secret:'unused',tenant:'feishu'}},preferences:{showToolCalls:false,showModel:'off'}};
  const defaults=cardDisplayPresentationDefaults(cfg);
  await writeFile(file,JSON.stringify({version:1,projects:[
    {...row('群A','oc_a'),presentation:{...defaults,showToolCalls:false,showModel:'off',cardDisplay:undefined}},
    {...row('群B','oc_b'),presentation:{...defaults,showToolCalls:false,showModel:'off',cardDisplay:null}},
  ]}));
  expect(await materializeCardDisplaySettings({defaults,target})).toBe(1);
  const rows=(JSON.parse(await readFile(file,'utf8')) as {projects:Project[]}).projects;
  const migrated=rows[0]?.presentation?.cardDisplay;
  expect(migrated).toBeTruthy();
  expect(migrated?.blocks.find(block=>block.kind==='tools')?.mode).toBe('off');
  expect(migrated?.blocks.find(block=>block.kind==='model')?.mode).toBe('off');
  expect(rows[1]?.presentation?.cardDisplay).toBeNull();
  expect(presentationConfig(cfg,rows[1]).preferences).toMatchObject({showToolCalls:true,showModel:'running',cardDisplay:undefined});
  await mutateProject('群A',project=>{project.presentation!.cardDisplay=null;},undefined,target);
  const reset=(JSON.parse(await readFile(file,'utf8')) as {projects:Project[]}).projects[0]!;
  expect(presentationConfig(cfg,reset).preferences).toMatchObject({showToolCalls:true,showModel:'running',cardDisplay:undefined});
  expect(await materializeCardDisplaySettings({defaults,target})).toBe(0);
});

it('does not migrate a newly created explicit default after restart or stopped-Bot settings read',async()=>{
  const root=await mkdtemp(join(tmpdir(),'card-display-new-'));roots.push(root);
  const file=join(root,'projects.json'),target={file,dataRoot:root};
  const oldBot=defaultCardDisplay();oldBot.blocks.find(block=>block.kind==='context')!.template='旧 Bot 文字';
  const cfg:AppConfig={accounts:{app:{id:'bot',secret:'unused',tenant:'feishu'}},preferences:{cardDisplay:oldBot,showToolCalls:false,showModel:'off'}};
  const model={id:'work-model',displayName:'Work',description:'',isDefault:true,hidden:false,supportedEfforts:['low' as const],defaultEffort:'low' as const};
  const prepared=await prepareNewGroupSettings({backend:'codex-appserver',kind:'multi',judge:{kind:'llm',backend:'codex-appserver',model:'work-model'}},{backendFor:()=>({peekModels:()=>[model],listModels:async()=>[model]})});
  const fresh=prepared.presentation!;
  await writeFile(file,JSON.stringify({version:1,projects:[{...row('新群','oc_new'),presentation:fresh},{...row('新私聊','oc_dm_new'),dm:{people:{}},presentation:fresh}]}));
  const before=await readFile(file,'utf8');
  expect(await materializeCardDisplaySettings({legacy:oldBot,defaults:cardDisplayPresentationDefaults(cfg),target})).toBe(0);
  expect(await readFile(file,'utf8')).toBe(before);
  const rows=(JSON.parse(before) as {projects:Project[]}).projects;
  for(const project of rows) expect(presentationConfig(cfg,project).preferences).toMatchObject({showToolCalls:true,showModel:'running',cardDisplay:undefined});
});

it('treats a future card style as explicit and falls back to native without reviving Bot style',async()=>{
  const root=await mkdtemp(join(tmpdir(),'card-display-future-'));roots.push(root);
  const file=join(root,'projects.json'),target={file,dataRoot:root};
  const oldBot=defaultCardDisplay();
  const cfg:AppConfig={accounts:{app:{id:'bot',secret:'unused',tenant:'feishu'}},preferences:{cardDisplay:oldBot}};
  await writeFile(file,JSON.stringify({version:1,projects:[{...row('未来群','oc_future'),presentation:{cardDisplay:{version:999},completionTemplate:'{{futureVariable}}'}}]}));
  expect(await materializeCardDisplaySettings({legacy:oldBot,defaults:cardDisplayPresentationDefaults(cfg),target})).toBe(0);
  const stored=(await listProjectsIn(file))[0]!;
  expect(stored.presentation?.cardDisplay).toBeNull();
  expect(stored.presentation?.completionTemplate).toBeNull();
  expect(presentationConfig(cfg,stored).preferences?.cardDisplay).toBeUndefined();
  expect(presentationConfig(cfg,stored).preferences?.completionReminder?.template).toBeUndefined();
});

it('card-only migration retains live Bot voice and reminder preferences',async()=>{
  const root=await mkdtemp(join(tmpdir(),'card-display-sparse-'));roots.push(root);
  const file=join(root,'projects.json'),target={file,dataRoot:root};
  await writeFile(file,JSON.stringify({version:1,projects:[row('旧群','oc_old')]}));
  const cfg:AppConfig={accounts:{app:{id:'bot',secret:'unused',tenant:'feishu'}},preferences:{showToolCalls:false,voice:{enabled:true},completionReminder:{mode:'long',longTaskMinutes:11}}};
  expect(await materializeCardDisplaySettings({defaults:cardDisplayPresentationDefaults(cfg),target})).toBe(1);
  const stored=(await listProjectsIn(file))[0]!;
  expect(Object.keys(stored.presentation!)).toEqual(['cardDisplay']);
  expect(stored.presentation?.cardDisplay?.blocks.find(block=>block.kind==='tools')?.mode).toBe('off');
  const changed={...cfg,preferences:{...cfg.preferences,voice:{enabled:false},completionReminder:{mode:'always' as const,longTaskMinutes:2}}};
  expect(presentationConfig(changed,stored).preferences).toMatchObject({voice:{enabled:false},completionReminder:{mode:'always',longTaskMinutes:2}});
});

it('projects only a valid local reminder template, never an old Bot template',()=>{
  const cfg:AppConfig={accounts:{app:{id:'bot',secret:'unused',tenant:'feishu'}},preferences:{completionReminder:{mode:'long',longTaskMinutes:7,template:'旧 Bot 模板'}}};
  const absent=presentationConfig(cfg,{presentation:{cardDisplay:null}});
  expect(absent.preferences?.completionReminder).toEqual({mode:'long',longTaskMinutes:7});
  const local=presentationConfig(cfg,{presentation:{cardDisplay:null,completionTemplate:'{{task}}\n{{detail}}'}});
  expect(local.preferences?.completionReminder).toEqual({mode:'long',longTaskMinutes:7,template:'{{task}}\n{{detail}}'});
  const reset=presentationConfig(cfg,{presentation:{cardDisplay:null,completionTemplate:null}});
  expect(reset.preferences?.completionReminder).toEqual({mode:'long',longTaskMinutes:7});
});
