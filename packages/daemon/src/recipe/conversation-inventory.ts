import {RECIPE_RICH_LIMITS,recipePublicSchema,type RecipePublic,type RecipeRichContent} from '@vonvon/protocol';
import {safeEditValue} from '../../../../services/recipe-api/src/draft-model-text.mjs';
import type {InventoryCategory} from '../agent/entry/recipe-creation-tools';
import {groupBackendId} from '../config/execution';
import {contentItems} from './authoring-handoff-menu';
import {isManagedRecipeSkillPath} from './group-skills';
import {digest} from './authoring-payload';
import {conversationSource} from './authoring-rich-flow';
import type {AuthoringOptions,Presence} from './authoring-service';
import type {RecipeRuntimeInventory} from './authoring-runtime-inventory';

type Description=Omit<RecipePublic,'access'>;
type Item={id:string;kind:string;label:string;detail:string;source?:'groupWorkspace'|'installedRecipe';parent?:string;entry?:string;requirement?:string};
export interface ConversationProposal {
  id:string;groupId:string;inventoryId:string;lease:string;selected:string[];public:Description;access:'direct'|'coded';
  binding:string;order:number;handoffId?:string;identity:string;threadId?:string;from:string;offeredAt:number;
  expiresAt:number;shownAt?:number;acceptedBy?:string;
}
const short=(v:unknown)=>{const s=typeof v==='string'?v:JSON.stringify(v)??'';return safeEditValue(s)?s.slice(0,360):'';};
const textOf=(v:RecipeRichContent['rules'][number]['text'])=>v.kind==='inline'?short(v.value):'已核对的文件内容';
const nameOf=(s:string)=>Boolean(s&&s.length<=160&&!s.includes('://')&&safeEditValue(s)&&!/[\r\n\p{Cc}\p{Cf}]/u.test(s));

export type InventoryOptions=Pick<AuthoringOptions,'channel'|'bot'|'groupSkills'|'tasks'|'managedSources'|'runtimeInventory'>;
export async function conversationInventory(opts:InventoryOptions,p:Pick<Presence,'scope'|'account'>,groupId:string) {
  const {inventory,row,catalog,unavailable}=await conversationSource(opts,p.scope,p.account,groupId);
  const actual:RecipeRuntimeInventory=await opts.runtimeInventory?.(row)??{
    provider:groupBackendId(row),model:row.defaultModel??null,tools:[],mcp:[],mcpStatus:'unavailable',
  };
  const runtime:RecipeRuntimeInventory={provider:nameOf(actual.provider)?actual.provider:groupBackendId(row),
    model:actual.model&&nameOf(actual.model)?actual.model:null,tools:[...new Set(actual.tools.filter(nameOf))].sort(),
    mcp:actual.mcp.filter(m=>nameOf(m.name)).sort((a,b)=>a.name.localeCompare(b.name)),mcpStatus:actual.mcpStatus,
    ...(actual.modelProvider&&nameOf(actual.modelProvider)&&{modelProvider:actual.modelProvider})};
  const content=inventory.content,items:Item[]=[];
  for(const item of contentItems(content)){
    const evidence=inventory.evidence.get(item.id);
    if(item.kind==='publicText'||evidence?.kind==='unresolved'||!safeEditValue(item.label))continue;
    let detail='',entry:string|undefined;
    if(item.kind==='role'&&content.role)detail=textOf(content.role.text);
    if(item.kind==='rule')detail=textOf(content.rules.find(r=>r.itemId===item.id)!.text);
    if(item.kind==='setting'){
      const s=content.settings.find(s=>s.itemId===item.id)!;
      detail=s.field==='presentation.cardDisplay'?'可逐项选择消息卡片区块':short(s.value);
    }
    if(item.kind==='task'){
      const t=content.tasks.find(t=>t.itemId===item.id)!;
      detail=[textOf(t.instruction),short(t.spec),short(t.timeZone),t.placement].join(' · ');
    }
    if(item.kind==='skill'){
      entry=content.skills.find(s=>s.itemId===item.id)!.entryFileId;
      detail='可选择附带的参考文件。';
    }
    const source=evidence?.kind==='managed'?'installedRecipe' as const:
      evidence?.kind==='native'&&['skill','file'].includes(item.kind)?'groupWorkspace' as const:undefined;
    items.push({...item,detail,...(source&&{source}),...(entry&&{entry})});
  }
  function requirement(kind:string,label:string,name:string){
    if(!nameOf(name))return;
    const requirement=label+' '+name;
    items.push({id:kind+'-'+digest(name).slice(0,24),kind,label:requirement,detail:'在配方概览中列为使用前需准备的依赖。',requirement});
  }
  requirement('provider','执行后端',runtime.provider);
  if(runtime.modelProvider)requirement('modelProvider','模型服务商',runtime.modelProvider);
  if(runtime.model)requirement('model','模型',runtime.model);
  for(const name of runtime.tools)requirement('tool','工具',name);
  for(const m of runtime.mcp.filter(m=>m.enabled))requirement('mcp','MCP',m.name);
  const disabled=new Set(row.skills?.disabledPaths??[]);
  const skills=catalog.filter(s=>s.enabled&&!disabled.has(s.path)&&nameOf(s.name)).map(({source,name,path})=>({source,name,...(source==='workspace'&&{location:isManagedRecipeSkillPath(path)?'已安装配方':'群工作区'})})).sort((a,b)=>a.name.localeCompare(b.name));
  for(const s of skills.filter(s=>s.source!=='workspace'))requirement('externalSkill','运行环境技能',s.name);
  const inventoryId=digest(JSON.stringify([inventory.lease,runtime,skills,items,unavailable]));
  return {inventoryId,groupId,groupName:row.name,lease:inventory.lease,skills,unavailable,...runtime,items};
}
type Inventory=Awaited<ReturnType<typeof conversationInventory>>;
export function inventoryPage(inv:Inventory,category:InventoryCategory='all',offset=0){
  const types:Record<Exclude<InventoryCategory,'all'>,string[]>={group:['role','rule','skill','file','task','setting','cardBlock','finalLogo'],skills:['skill','file'],
    tasks:['task'],rules:['role','rule'],settings:['setting','cardBlock'],runtime:['provider','modelProvider','model'],tools:['tool'],mcp:['mcp'],externalSkills:['externalSkill']};
  const count=(kinds:string[])=>inv.items.filter(i=>kinds.includes(i.kind)).length;
  const counts=Object.fromEntries(Object.entries(types).map(([key,kinds])=>[key,count(kinds)]));
  const order=['role','rule','skill','task','file','provider','modelProvider','model','setting','cardBlock','finalLogo','mcp','tool','externalSkill'];
  const items=inv.items.filter(i=>category==='all'||types[category].includes(i.kind)).sort((a,b)=>order.indexOf(a.kind)-order.indexOf(b.kind));
  const limit=16;
  const page=items.slice(offset,offset+limit).map(({requirement:_note,...item})=>item);
  return {state:'ready' as const,groupId:inv.groupId,groupName:inv.groupName,inventoryId:inv.inventoryId,
    provider:inv.provider,modelProvider:inv.modelProvider,model:inv.model,mcpStatus:inv.mcpStatus,
    summary:inventorySummary(inv),counts,skills:inv.skills.filter(s=>s.source==='workspace').slice(0,8),
    tools:inv.tools.slice(0,8),mcp:inv.mcp.slice(0,8),unavailable:inv.unavailable.slice(0,8),category,items:page,
    ...(offset+page.length<items.length&&{nextOffset:offset+page.length})};
}
export function inventorySummary(inv:Awaited<ReturnType<typeof conversationInventory>>){
  function names(values:string[]){
    if(!values.length)return '无';
    return values.slice(0,8).join('、')+(values.length>8?' 等 '+values.length+' 项':'');
  }
  const settings=inv.items.filter(i=>i.kind==='rule'||i.kind==='setting'&&['会话模式','无需提及 Bot','执行期间的新消息'].includes(i.label));
  const backend=inv.provider==='codex-appserver'?'Codex':inv.provider==='claude-agent'?'Claude':inv.provider;
  return ['执行后端：'+backend+' · 模型服务商：'+(inv.modelProvider??'未标明')+' · 模型：'+(inv.model??'未指定'),
    '群内已启用技能：'+names(inv.skills.filter(s=>s.source==='workspace').map(s=>s.name+'（'+s.location+'）')),
    '工具：'+names(inv.tools)+'；已配置启用的 MCP：'+(inv.mcpStatus==='unavailable'?'暂时无法核对':(inv.mcp.some(m=>m.enabled)?names(inv.mcp.filter(m=>m.enabled).map(m=>m.name))+'（连通性未检测）':'无')),
    '沟通规则：'+names(settings.map(i=>i.label+(i.kind==='setting'?' '+i.detail:''))),
    '任务配置：'+names(inv.items.filter(i=>i.kind==='task').map(i=>i.label)),...(inv.unavailable.length?['本次无法分享：'+names(inv.unavailable)]:[])].join('\n');
}
export function chooseScope(inv:Awaited<ReturnType<typeof conversationInventory>>,ids:string[],input:Description,access:RecipePublic['access']){
  const selected=new Set(ids);
  if(ids.some(id=>!inv.items.some(item=>item.id===id)))throw new Error('选择包含当前盘点中没有的项目，请重新核对。');
  // A file requires its skill and SKILL.md. An inert card block requires its card.
  for(const item of inv.items)if(selected.has(item.id)&&item.parent)selected.add(item.parent);
  for(const item of inv.items)if(selected.has(item.id)&&item.entry)selected.add(item.entry);
  const included=inv.items.filter(item=>selected.has(item.id));
  if(included.length!==selected.size)throw new Error('选择缺少可分享的父项目。');
  for(const [kind,limit] of [['skill',RECIPE_RICH_LIMITS.skills],['file',RECIPE_RICH_LIMITS.files],['task',RECIPE_RICH_LIMITS.tasks],['rule',RECIPE_RICH_LIMITS.rules]] as const){
    if(included.filter(i=>i.kind===kind).length>limit)throw new Error('所选'+({skill:'技能',file:'文件',task:'任务',rule:'规则'})[kind]+'超过单份配方的 '+limit+' 项上限。请缩小范围后再确认。');
  }
  const deps=included.flatMap(item=>item.requirement?[item.requirement]:[]);
  const overview=deps.length?[input.overview,'使用前请在目标环境准备以下依赖：\n'+deps.map(s=>'• '+s).join('\n')].filter(Boolean).join('\n\n'):input.overview;
  const description={...input,overview};
  recipePublicSchema.parse({...description,access});
  if(!safeEditValue(description))throw new Error('配方介绍含有私密字段或本机路径，请修改后再确认。');
  return {selected:included.filter(item=>!item.requirement).map(item=>item.id),included,public:description,access};
}

export function scopeReview(group:string,review:ReturnType<typeof chooseScope>,overview:string){
  const items=review.included;
  const sections=['新建私人草稿 · 待确认',[
    '拟用名称：'+(review.public.name||'未命名配方'),'来源群：'+group,
    review.public.version&&'显示版本：'+review.public.version,
    '获取方式：'+(review.access==='coded'?'凭码':'直接获取'),
    review.public.summary&&'简介：'+review.public.summary,overview&&'概览：'+overview,
  ].filter(Boolean).join('\n')];
  const config=items.filter(i=>!i.requirement&&!['skill','file'].includes(i.kind)).map(i=>{
    const label=i.kind==='rule'?i.label.split(' · ')[0]:i.label;
    const detail=i.kind==='setting'&&i.detail==='true'?'开启':i.kind==='setting'&&i.detail==='false'?'关闭':i.detail;
    return '• '+label+(i.source==='installedRecipe'?'（已安装配方）':'')+(detail?'：'+detail:'');
  });
  if(config.length)sections.push('群配置\n'+config.join('\n'));
  const skills=items.filter(i=>i.kind==='skill').map(skill=>{
    const name=skill.label.replace(/^技能 · /u,'');
    const files=items.filter(i=>i.kind==='file'&&i.parent===skill.id).map(i=>i.label.replace(name+' / ',''));
    return '• '+name+(skill.source==='installedRecipe'?'（已安装配方）':skill.source==='groupWorkspace'?'（群工作区）':'')+(files.length?'\n  '+files.join('\n  '):'');
  });
  if(skills.length)sections.push('技能与文件\n'+skills.join('\n'));
  const deps=items.filter(i=>i.requirement).map(i=>'• '+i.requirement);
  if(deps.length)sections.push('目标环境需准备\n'+deps.join('\n'));
  if(!items.length)sections.push('本次仅保存配方介绍。');
  sections.push('确认后将新建一份私人草稿。请回复“确认这个范围，保存草稿”，或告诉我需要调整哪些内容。');
  return sections.join('\n\n');
}
