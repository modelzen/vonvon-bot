import type {RecipeConfig, RecipeRichContent, RecipeRichText} from '@vonvon/protocol';
import {recipeSettingNames, recipeFieldNames, recipeValueNames, recipeLiteralFields} from '../../ui/src/community/rich-configuration-values.js';

type Section = {title:string; text:string};
const extraFields:Record<string,string>={action:'操作方式'};
const extraValues:Record<string,string>={all:'全部',yellow:'黄色',orange:'橙色',red:'红色','actions-left':'操作区左侧','actions-right':'操作区右侧',
  response:'回复',conversation:'会话',run:'执行',smartRules:'智能规则',presentation:'展示',judge:'判断模型',speed:'速度',modelAccess:'可选模型',permission:'权限'};
const label=(key:string)=>extraFields[key]??recipeFieldNames[key]??key;
const valueName=(value:string)=>recipeValueNames[value]??extraValues[value]??value;

function settingValue(value:unknown,literal=false,field=''):string {
  if(value===null||value===undefined)return '未指定';
  if(typeof value==='boolean')return value?'开启':'关闭';
  if(typeof value==='string')return value===''?'（空）':literal?value:valueName(value);
  if(typeof value==='number')return String(value);
  if(Array.isArray(value))return value.length?value.map(item=>settingValue(item,literal)).join(value.some(item=>item!==null&&typeof item==='object')?'\n\n':'、'):'无';
  if(typeof value==='object')return Object.entries(value).filter(([key])=>!['itemId','originId','id'].includes(key)).map(([key,item])=>{
    const modelKey=field==='modelEfforts'||field==='modelServiceTiers';
    const text=settingValue(item,literal||(!modelKey&&(recipeLiteralFields.has(key)||key==='provider'))||field==='modelEfforts',modelKey?'':key);
    return `${modelKey?key:label(key)}：${text.includes('\n')?'\n'+text:text}`;
  }).join('\n');
  return '';
}

function schedule(spec:RecipeRichContent['tasks'][number]['spec']):string {
  switch(spec.kind){
    case 'once':return `单次 ${new Date(spec.at).toISOString()}（时间戳 ${spec.at}）`;
    case 'every':return `每 ${spec.minutes} 分钟`;
    case 'daily':return `每天 ${spec.time}`;
    case 'weekly':return `每周${spec.days.map(day=>['日','一','二','三','四','五','六'][day]).join('、')} ${spec.time}`;
    case 'cron':return `时间表达式 ${spec.expr}`;
  }
}

export function richCreatorPreview(content:RecipeRichContent,texts:Record<string,string>):Section[] {
  const partNames=new Map<string,string[]>();
  const namePart=(text:RecipeRichText,name:string)=>{
    if(text.kind!=='part')return;
    const names=partNames.get(text.objectId)??[];
    if(!names.includes(name))names.push(name);
    partNames.set(text.objectId,names);
  };
  if(content.role)namePart(content.role.text,'角色正文');
  content.rules.forEach(rule=>namePart(rule.text,valueName(rule.purpose)+'正文'));
  content.files.forEach(file=>namePart(file.text,file.name));
  content.tasks.forEach(task=>namePart(task.instruction,task.name+' · 任务内容'));
  const textOf=(text:RecipeRichText)=>text.kind==='inline'?text.value:texts[text.objectId]!;
  const blocks=(values:string[],empty:string)=>values.length?values.join('\n\n'):empty;
  const fileNames=new Map(content.files.map(file=>[file.itemId,file.name]));
  const fileText=(text:RecipeRichText)=>text.kind==='inline'?text.value:`完整正文见「${partNames.get(text.objectId)!.join('、')}」。`;
  const sections:Section[]=[
    {title:'角色',text:content.role?textOf(content.role.text):'未指定'},
    {title:'配置',text:blocks(content.settings.map(item=>`${recipeSettingNames[item.field]}\n${settingValue(item.value,item.field==='presentation.completionTemplate')}`),'未指定')},
    {title:'规则',text:blocks(content.rules.map(rule=>`${valueName(rule.purpose)}\n${textOf(rule.text)}`),'未选择规则')},
    {title:'技能',text:blocks(content.skills.map(skill=>`${skill.name}\n入口文档：${fileNames.get(skill.entryFileId)}\n包含文档：${skill.fileIds.map(id=>fileNames.get(id)).join('、')}`),'未选择技能')},
    {title:'文档',text:blocks(content.files.map(file=>`${file.name} · ${valueName(file.use)}\n${fileText(file.text)}`),'没有文档')},
    {title:'任务',text:blocks(content.tasks.map(task=>`${task.name}\n执行时间：${schedule(task.spec)}\n时区：${task.timeZone.kind==='recommended'?task.timeZone.iana:'安装时选择时区'}\n执行位置：${valueName(task.placement)}\n任务内容\n${textOf(task.instruction)}\n\n安装后暂停，核对实际执行条件后单独启用。`),'没有任务')},
    {title:'补充说明',text:blocks(content.setup.map(({itemId:_itemId,originId:_originId,...item})=>settingValue(item)),'没有补充说明')},
    {title:'文件与图片',text:blocks(content.parts.map(part=>`${part.kind==='text'?partNames.get(part.objectId)!.join('、'):'Logo'} · ${part.kind==='text'?'文本':'WebP 图片'} · ${part.bytes} 字节`),'没有附件')},
    {title:'Logo',text:content.finalLogo?'已选择本次发布的 Logo。':'未设置 Logo'},
  ];
  for(const part of content.parts)if(part.kind==='text'){
    const title=partNames.get(part.objectId)!.join('、');
    sections.push({title:title.length>128?title.slice(0,127)+'…':title,text:texts[part.objectId]!});
  }
  return sections;
}

export function legacyCreatorPreview(config:RecipeConfig):Section[] {
  return [{title:'角色',text:config.role},...(config.setup?[{title:'补充说明',text:config.setup.steps.map(step=>settingValue(step)).join('\n\n')}]:[])];
}
