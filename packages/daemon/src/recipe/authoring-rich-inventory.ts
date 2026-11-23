import {createHmac} from 'node:crypto';
import {join} from 'node:path';
import {recipeRichContentSchema as schema,recipeRichSettingSchema,type RecipeRichContent,type ScheduledTaskView} from '@vonvon/protocol';
import {groupBackendId,groupPermission} from '../config/execution';
import type {Project} from '../project/registry';
import {supplementOf} from '../bot/context-assembly';
import {safeEditValue} from '../../../../services/recipe-api/src/draft-model-text.mjs';
import {readSelectedRecipeFiles,type RecipeFileSnapshot} from './rich-source-files';
import {itemsOf,type SourceEvidence,wireDigest} from './authoring-rich-snapshot';

export interface SkillFileChoice {skill:string;files:string[]}
export interface InventoryOptions {
  seed:string;row:Project;botRoot:string;botId:string;
  unavailable?:string[];skillRoots?:Map<string,string>;skills:readonly SkillFileChoice[];includeBotMemories:boolean;
  tasks?:readonly ScheduledTaskView[];expectedFiles?:Record<string,RecipeFileSnapshot>;
}
export function inventoryAlias(seed:string,key:string){
  const bytes=createHmac('sha256',seed).update(key).digest().subarray(0,16);
  bytes[6]=(bytes[6]!&15)|0x40;bytes[8]=(bytes[8]!&63)|0x80;
  const hex=bytes.toString('hex');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
export async function nativeRichInventory(options:InventoryOptions){
  const {row,seed}=options;
  if(row.dm||!row.bindingIncarnation)throw new Error('所选群绑定无效。');
  const identity=(key:string)=>({itemId:inventoryAlias(seed,'item:'+key),originId:inventoryAlias(seed,'origin:'+key)});
  const publicField=(key:string)=>({...identity('public:'+key),value:''});
  const content:RecipeRichContent={format:'rich-v2',schemaVersion:2,public:{name:publicField('name'),overview:publicField('overview'),summary:publicField('summary'),version:publicField('version')},
    settings:[],rules:[],skills:[],files:[],memories:[],setup:[],tasks:[],parts:[]};
  const omit=(label:string)=>{
    if(!options.unavailable)return false;
    const name=safeEditValue(label)?label:'一个来源项目';
    if(!options.unavailable.includes(name))options.unavailable.push(name);
    return true;
  };
  const shareable=(value:unknown,label:string)=>{
    const safe=safeEditValue(value);
    if(!safe&&!omit(label)&&options.skillRoots)throw new Error('群配置包含敏感信息，无法完整导出。');
    return safe;
  };
  function setting(field:string,value:unknown) {
    if(value===undefined||!shareable(value,field))return;
    const parsed=recipeRichSettingSchema.safeParse({field,value,...identity(field)});
    if(parsed.success)content.settings.push(parsed.data);
    else if(!omit(field)&&options.skillRoots)throw new Error('群设置超出配方支持的范围。');
  }
  const role=supplementOf(row);
  if(role&&shareable(role,'群角色'))content.role={...identity('role'),text:{kind:'inline',value:role}};
  if(row.kind||row.smart!==undefined)setting('sessionMode',row.smart?'smart':row.kind);
  setting('response.noMention',row.noMention);
  setting('run.pendingPolicy',row.pendingPolicy);
  const presentation=row.presentation;
  if(presentation){
    for(const key of ['voiceEnabled','showToolCalls','showModel','completionMode','longTaskMinutes','completionTemplate'] as const)
      setting('presentation.'+key,presentation[key]);
    const card=presentation.cardDisplay;
    if(card===null)setting('presentation.cardDisplay',null);
    else if(card)setting('presentation.cardDisplay',{version:card.version,...(card.reply&&{reply:card.reply}),blocks:card.blocks.flatMap(block=>{
      if(block.source!=='builtin'||block.script)return [];
      const {source:_s,script:_c,language:_l,sample:_p,...portable}=block;
      return shareable(portable,'卡片区块')?[{...portable,...identity('block:'+block.id)}]:[];
    })});
  }
  const backend=groupBackendId(row);
  if(row.backend||row.defaultModel)setting('model.recommendation',{backend,selection:row.defaultModel?
    {kind:'explicit',model:row.defaultModel,effort:row.defaultEffort??'default',...(row.defaultModelCustom&&{custom:true})}:{kind:'default'}});
  setting('modelAccess.recommendation',row.modelAccess);
  if(row.serviceTier)setting('speed.recommendation',{tier:row.serviceTier});
  setting('judge.recommendation',row.judge);
  if(row.mode||row.custom||row.network!==undefined){
    const p=groupPermission(row);
    if(!p.invalid){
      setting('permission.requirement',{mode:p.effect.mode});
      if(p.custom&&backend==='codex-appserver')setting('permission.codex.requirement',{sandbox:p.custom.sandbox,network:p.custom.network});
      if(p.custom&&backend==='claude-agent'&&p.custom.network!=='domains')setting('permission.claude.requirement',{
        permissionMode:p.custom.permissionMode,sandbox:p.custom.sandbox,network:p.custom.network,
      });
    }
  }
  if(row.workRules&&shareable(row.workRules,'工作规则'))content.rules.push({...identity('work'),purpose:'work',text:{kind:'inline',value:row.workRules}});
  for(const [key,purpose] of [['respond','smartRespond'],['newTopic','smartNewTopic']] as const){
    const value=row.smartRules?.[key];
    if(value&&shareable(value,key==='respond'?'回应规则':'新话题规则'))content.rules.push({...identity(purpose),purpose,text:{kind:'inline',value}});
  }
  for(const task of options.tasks??[]){
    if(task.id.startsWith('rt_')||task.chatId!==row.chatId||task.botId!==options.botId||task.dm||task.placement.kind==='topic')continue;
    const spec=task.spec.kind==='every'?{kind:'every',minutes:task.spec.minutes}:task.spec;
    const parsed=schema.shape.tasks.element.safeParse({...identity('task:'+task.id),name:task.name,instruction:{kind:'inline',value:task.instruction},
      timeZone:{kind:'recommended',iana:task.timeZone},placement:task.placement.kind,spec});
    if(parsed.success){if(shareable(parsed.data,'定时任务 · '+task.name))content.tasks.push(parsed.data);}
    else if(!omit('定时任务 · '+task.name)&&options.skillRoots)throw new Error('群任务超出配方支持的范围。');
  }
  const files:Record<string,RecipeFileSnapshot>=Object.create(null);
  if(!options.skillRoots&&options.skills.length>16)throw new Error('所选技能过多。');
  for(const choice of options.skills){
    if((options.skillRoots?!options.skillRoots.has(choice.skill):!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,79}$/u.test(choice.skill))||Object.hasOwn(files,choice.skill)||!choice.files.includes('SKILL.md'))throw new Error('请选择实际的工作区技能及其说明。');
    const folder=backend==='claude-agent'?'.claude':'.agents';
    const root=options.skillRoots?.get(choice.skill)??join(row.cwd,folder,'skills',choice.skill);
    let snap:RecipeFileSnapshot;
    try{snap=await readSelectedRecipeFiles(root,choice.files,options.expectedFiles?.[choice.skill]);}
    catch(error){if(omit('技能 · '+choice.skill))continue;throw error;}
    files[choice.skill]=snap;
    const selected=snap.files.flatMap(f=>{
      if(!safeEditValue(f.text)){
        if(omit('技能文件 · '+choice.skill+' / '+f.name))return [];
        throw new Error('所选技能文件含敏感信息。');
      }
      return [{...identity('file:'+choice.skill+'/'+f.name),name:f.name,use:f.name==='SKILL.md'?'skillDescription' as const:'reference' as const,text:{kind:'inline' as const,value:f.text}}];
    });
    const entry=selected.find(f=>f.name==='SKILL.md');
    if(!entry){omit('技能 · '+choice.skill);continue;}
    content.files.push(...selected);
    content.skills.push({...identity('skill:'+choice.skill),name:choice.skill,entryFileId:entry.itemId,fileIds:selected.map(i=>i.itemId)});
  }
  const evidence=new Map<string,SourceEvidence>(itemsOf(content).map(i=>[i.itemId,{kind:'native'}]));
  if(row.recipeInstall&&content.role)evidence.set(content.role.itemId,{kind:'unresolved'});
  return {content,evidence,files,lease:wireDigest({binding:row.bindingIncarnation,revision:row.projectSettingsRevision??0,content,
    files:Object.entries(files).map(([skill,s])=>[skill,s.rootIdentity,s.files.map(f=>[f.identity,f.sha256])])})};
}
