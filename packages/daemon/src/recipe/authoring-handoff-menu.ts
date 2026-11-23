import {button,card,type CardElement} from '../card/cards';
import {z} from 'zod';
import {decodeRichRecipeContent,type AuthoringHandoff,type RecipeRichContent,type RecipeRichDraftChange,type RecipeAuthoringRequest} from '@vonvon/protocol';
import type {Recipient} from './authoring-journal';
import type {readRichSource} from './authoring-rich-flow';
import type {HandoffAttestation} from '@vonvon/protocol';

type Edit = Extract<RecipeAuthoringRequest,{type:'beginDraftHandoff'}>;
type SourceInventory = Awaited<ReturnType<typeof readRichSource>>;
type Options = Extract<RecipeAuthoringRequest,{type:'richInventory'}>['options'];
type TargetKind = 'publicText'|'role'|'setting'|'cardBlock'|'rule'|'skill'|'file'|'task'|'finalLogo';
type Item = {kind:TargetKind;id:string;label:string;parent?:string};
type Page = 'content'|'skills'|'files'|'saved';
type Choice = {action:'item'|'saved'|'skill'|'file';id:string;label:string;checked:boolean};
export type HandoffSelection = {
  page:Page;offset:number;skill?:string;options:Options;selected:string[];candidates:string[];
  lease:string;choices:Choice[];count:number;
};
export interface PrivateHandoff {
  retryId:string;groupId:AuthoringHandoff['groupId'];groupName:string;identity:string;account:string;scope:string;binding:string;recipient:Recipient;
  session:string;expiresAt:number;sourceVersionId?:string;inherited?:Extract<RecipeAuthoringRequest,{type:'beginHandoff'}>['inherited'];edit?:Pick<Edit,'draftId'|'baseRevision'|'canonical'|'source'>;
  draftId?:string;baseRevision?:number;ref:string;generation:number;cardId?:string;messageId?:string;sendUuid:string;sentAt?:number;cardDirty?:true;
  selection:HandoffSelection;
  phase:{state:'selecting'|'cancelled'|'expired'|'needsReview'|'deliveryUnknown'}|
    {state:'awaitingAttestations';request:HandoffAttestation}|{state:'prepared';operationId:string};
}
export const emptySelection=():HandoffSelection=>({page:'content',offset:0,options:{skills:[],includeBotMemories:false,includeTasks:false},
  selected:[],candidates:[],lease:'',choices:[],count:0});
export function viewHandoff(h:PrivateHandoff):AuthoringHandoff{
  return {retryId:h.retryId,groupId:h.groupId,...(h.draftId&&{draftId:h.draftId}),state:h.phase.state,
    ...(h.phase.state==='prepared'&&{operationId:h.phase.operationId})};
}
export const handoffClick=z.object({a:z.literal('recipe.authoring'),verb:z.literal('handoff'),ref:z.string().uuid(),generation:z.number().int().positive(),
  action:z.enum(['choice','next','prev','content','skills','saved','memories','tasks','finish','cancel']),index:z.number().int().min(0).max(5).optional()}).strict();
type Click=z.infer<typeof handoffClick>;
const PAGE=6;
export function contentItems(content:RecipeRichContent):Item[]{
  const items:Item[]=[];
  for(const [key,label] of [['name','名称'],['summary','简介'],['overview','概览'],['version','版本']] as const)
    items.push({kind:'publicText',id:content.public[key].itemId,label});
  if(content.role)items.push({kind:'role',id:content.role.itemId,label:'群角色'});
  const settings:Record<string,string>={sessionMode:'会话模式','response.noMention':'无需提及 Bot','run.pendingPolicy':'执行期间的新消息',
    'presentation.voiceEnabled':'语音回复','presentation.showToolCalls':'工具调用','presentation.showModel':'模型标记',
    'presentation.completionMode':'完成通知','presentation.longTaskMinutes':'长任务时长','presentation.completionTemplate':'完成通知模板',
    'presentation.cardDisplay':'消息卡片','model.recommendation':'推荐模型','modelAccess.recommendation':'可选模型','speed.recommendation':'速度建议',
    'judge.recommendation':'判断模型','permission.requirement':'权限要求','permission.codex.requirement':'Codex 权限','permission.claude.requirement':'Claude 权限'};
  for(const setting of content.settings){
    items.push({kind:'setting',id:setting.itemId,label:settings[setting.field]??setting.field});
    if(setting.field==='presentation.cardDisplay'&&setting.value)for(const b of setting.value.blocks)items.push({kind:'cardBlock',id:b.itemId,label:'卡片 · '+b.name,parent:setting.itemId});
  }
  for(const r of content.rules)items.push({kind:'rule',id:r.itemId,label:({work:'工作规则',smartRespond:'回应规则',smartNewTopic:'新话题规则'})[r.purpose]+(r.text.kind==='inline'?' · '+r.text.value.slice(0,30):'')});
  for(const s of content.skills){
    items.push({kind:'skill',id:s.itemId,label:'技能 · '+s.name});
    for(const f of content.files.filter(f=>s.fileIds.includes(f.itemId)))items.push({kind:'file',id:f.itemId,label:s.name+' / '+f.name,parent:s.itemId});
  }
  for(const t of content.tasks)items.push({kind:'task',id:t.itemId,label:'任务 · '+t.name});
  if(content.finalLogo)items.push({kind:'finalLogo',id:content.finalLogo.itemId,label:'配方 Logo'});
  return items;
}
const decode=(canonical:string)=>decodeRichRecipeContent(Buffer.from(canonical,'base64url')).content;
const memoryIds=(edit:NonNullable<PrivateHandoff['edit']>)=>new Set(
  [decode(edit.canonical),decode(edit.source.canonical)].flatMap(content=>content.memories.map(item=>item.itemId)));
export function hasLegacyMemoryChoices(h:PrivateHandoff){
  if(h.selection.options.includeBotMemories)return true;
  if(!h.edit)return false;
  const memories=memoryIds(h.edit);
  return [...h.selection.selected,...h.selection.candidates,...h.selection.choices.map(choice=>choice.id)].some(id=>memories.has(id));
}
function savedItems(edit:NonNullable<PrivateHandoff['edit']>){
  const current=decode(edit.canonical),source=decode(edit.source.canonical),present=new Set(contentItems(current).map(i=>i.id));
  return contentItems(source).filter(i=>i.kind!=='publicText'&&!present.has(i.id)&&(!i.parent||present.has(i.parent))&&
    (i.kind!=='role'||!current.role)&&(i.kind!=='finalLogo'||!current.finalLogo)&&
    (i.kind!=='setting'||!current.settings.some(s=>s.field===source.settings.find(s=>s.itemId===i.id)?.field)));
}
export function candidateChanges(h:PrivateHandoff):RecipeRichDraftChange[]{
  if(!h.edit)return [];
  const edit=h.edit;
  const items=savedItems(edit);
  return h.selection.candidates.map(id=>{
    const item=items.find(i=>i.id===id);
    if(!item||item.kind==='publicText')throw new Error('原始候选已变化。');
    const source={sourceIntentId:edit.source.sourceIntentId,candidateId:id,expectedRevision:edit.baseRevision};
    if(item.kind==='cardBlock'||item.kind==='file'){
      if(!item.parent||!h.selection.selected.includes(item.parent))throw new Error('请先勾选候选所属的技能或卡片。');
      return {op:'includeCandidate',value:{kind:item.kind,source,parentItemId:item.parent}};
    }
    return {op:'includeCandidate',value:{kind:item.kind,source}};
  });
}
export function setChoices(h:PrivateHandoff,inventory?:SourceInventory,skills?:{name:string;files:string[]}[]){
  const s=h.selection;
  s.options.includeBotMemories=false;
  if(h.edit){
    const memories=memoryIds(h.edit);
    s.selected=s.selected.filter(id=>!memories.has(id));
    s.candidates=s.candidates.filter(id=>!memories.has(id));
  }
  let choices:Choice[];
  if(s.page==='skills')choices=(skills??[]).map(k=>({action:'skill',id:k.name,label:k.name.replace(/ · [a-f0-9-]{36}$/i,''),checked:s.options.skills.some(x=>x.skill===k.name)}));
  else if(s.page==='files'){
    const skill=skills?.find(k=>k.name===s.skill);
    if(!skill)throw new Error('工作区技能已变化。');
    choices=skill.files.map(file=>({action:'file',id:file,label:file,checked:!!s.options.skills.find(x=>x.skill===skill.name)?.files.includes(file)}));
  }else{
    const saved=s.page==='saved'&&h.edit;
    const items=saved?savedItems(saved):contentItems(h.edit?decode(h.edit.canonical):inventory!.content);
    choices=items.filter(item=>h.edit||item.kind!=='publicText'&&item.kind!=='file'&&item.kind!=='skill'&&inventory!.evidence.get(item.id)?.kind!=='unresolved')
      .map(item=>({action:saved?'saved':'item',id:item.id,label:item.label,checked:(saved?s.candidates:s.selected).includes(item.id)}));
  }
  s.count=choices.length;
  s.offset=Math.max(0,Math.min(s.offset,Math.floor(Math.max(0,choices.length-1)/PAGE)*PAGE));
  s.choices=choices.slice(s.offset,s.offset+PAGE);
}
export function toggleChoice(h:PrivateHandoff,click:Click){
  const s=h.selection;
  if(click.action==='memories')throw new Error('请选择当前卡片中的内容，配方不包含记忆。');
  if(click.action==='tasks'){
    if(h.edit)throw new Error('草稿没有新的来源读取授权。');
    s.options.includeTasks=!s.options.includeTasks;s.page='content';s.offset=0;
  }else if(click.action==='next'||click.action==='prev')s.offset+=(click.action==='next'?1:-1)*PAGE;
  else if(click.action==='content'||click.action==='skills'||click.action==='saved'){
    if(click.action==='skills'&&h.edit||click.action==='saved'&&!h.edit)throw new Error('请选择当前卡片中的内容。');
    s.page=click.action;s.offset=0;
  }else if(click.action==='choice'){
    const choice=s.choices[click.index??-1];
    if(!choice)throw new Error('请选择当前卡片中的内容。');
    if(h.edit&&memoryIds(h.edit).has(choice.id))
      throw new Error('请选择当前卡片中的内容，配方不包含记忆。');
    if(choice.action==='skill'){s.page='files';s.skill=choice.id;s.offset=0;return;}
    if(choice.action==='file'){
      const name=s.skill!,group=s.options.skills.find(k=>k.skill===name);
      if(!group){
        if(choice.id!=='SKILL.md')throw new Error('请先选择这个技能的 SKILL.md。');
        if(s.options.skills.length>=16)throw new Error('每次最多选择 16 个技能。');
        s.options.skills.push({skill:name,files:[choice.id]});
      }else if(choice.id==='SKILL.md'&&choice.checked)s.options.skills=s.options.skills.filter(g=>g!==group);
      else group.files=choice.checked?group.files.filter(f=>f!==choice.id):[...group.files,choice.id];
    }else{
      const key=choice.action==='saved'?'candidates':'selected';
      if(!choice.checked&&h.edit&&s[key].length>=(key==='candidates'?16:32))throw new Error('本次选择已到上限，请减少修改目标。');
      s[key]=choice.checked?s[key].filter(id=>id!==choice.id):[...s[key],choice.id];
    }
  }
}
export function selectedSource(h:PrivateHandoff,inventory:SourceInventory){
  const s=h.selection,items=contentItems(inventory.content);
  const selected=items.filter(i=>i.kind!=='publicText'&&(i.kind==='skill'||i.kind==='file'||s.selected.includes(i.id)));
  if(selected.some(i=>inventory.evidence.get(i.id)?.kind==='unresolved'||i.parent&&!selected.some(p=>p.id===i.parent)))throw new Error('请先选择对应的父条目，并核对来源。');
  const needed=[...selected.map(i=>i.id),...Object.values(inventory.content.public).map(i=>i.itemId)];
  const parents=new Map<string,Set<string>>();
  for(const id of needed){
    const evidence=inventory.evidence.get(id);
    if(evidence?.kind!=='managed')continue;
    for(const edge of evidence.parents){
      const ids=parents.get(edge.versionId)??new Set<string>();
      ids.add(edge.itemId);parents.set(edge.versionId,ids);
    }
  }
  const versions=[...parents.keys()].sort();
  const requiredItems=versions.map(versionId=>({versionId,itemIds:[...parents.get(versionId)!].sort()}));
  return {selected:selected.map(i=>i.id),versions,items:requiredItems};
}
export function handoffCard(h:PrivateHandoff){
  const s=h.selection, elements:CardElement[]=[];
  const plain=(content:string)=>({tag:'div',text:{tag:'plain_text',content}});
  const add=(label:string,action:Click['action'],index?:number,primary=false)=>elements.push(button(label,{a:'recipe.authoring',verb:'handoff',ref:h.ref,generation:h.generation,action,...(index!==undefined&&{index})},primary?'primary':'default'));
  elements.push(plain(h.groupName));
  if(h.inherited)elements.push(plain('沿用本人已发布版本的名称、简介、概览、Logo 和获取方式；请为新版填写新的显示版本。群配置只包含本次勾选内容。'));
  if(h.phase.state==='selecting'||h.phase.state==='deliveryUnknown'){
    elements.push(plain(h.edit?'选择这次要修改的草稿内容，然后告诉我想怎么改。':'勾选你有权分享的内容。技能文件和任务由你单独选择。'));
    for(const [i,c] of s.choices.entries())add((c.action==='skill'?'› ':c.checked?'☑ ':'☐ ')+c.label.slice(0,100),'choice',i);
    if(!s.choices.length)elements.push(plain('这里暂时没有可选内容。'));
    if(s.offset>0)add('上一页','prev');
    if(s.offset+PAGE<s.count)add('下一页','next');
    if(s.page!=='content')add('返回草稿内容','content');
    if(h.edit&&s.page==='content')add('从原始草稿恢复内容','saved');
    if(!h.edit){
      if(s.page!=='skills')add('选择技能和文件','skills');
      if(s.page==='content'){
        add(s.options.includeTasks?'收起并排除任务':'查看可分享的群任务','tasks');
      }
    }
    add(h.edit?'确认本次修改范围':'确认所选来源，查看草稿候选','finish',undefined,true);
    add('取消','cancel');
  }else elements.push(plain(({awaitingAttestations:'正在核对所选来源。',prepared:'已交给草稿编辑。',cancelled:'已取消。',expired:'本次选择已过期。',needsReview:'来源已变化，请回到 App 重新准备。'})[h.phase.state]));
  return card(elements,{header:{title:h.edit?'编辑私人草稿':'准备群配方'},forward:false});
}
