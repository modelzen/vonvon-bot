import type {RecipeRichContent,RecipeRichDraftChange,RecipeRichSetting,RecipeRichText} from '@vonvon/protocol';
import {fieldLabels,type CandidateCardDetails} from './draft-instruction';

type Field=CandidateCardDetails['fields'][number];
const field=(label:string,text:string):Field=>({label,text,valueJson:JSON.stringify(text)});
const labels:Record<string,string>={
  sessionMode:'会话模式','response.noMention':'无需提及 Bot','run.pendingPolicy':'执行期间的新消息',
  'presentation.voiceEnabled':'语音回复','presentation.showToolCalls':'展示工具调用','presentation.showModel':'模型标记',
  'presentation.completionMode':'完成通知','presentation.longTaskMinutes':'长任务分钟数','presentation.completionTemplate':'完成通知文案',
  'presentation.cardDisplay':'消息卡片','model.recommendation':'推荐模型','modelAccess.recommendation':'可用模型建议',
  'speed.recommendation':'推荐速度','judge.recommendation':'推荐判断方式','permission.requirement':'权限要求',
  'permission.codex.requirement':'Codex 权限要求','permission.claude.requirement':'Claude 权限要求',
  backend:'执行工具',selection:'模型选择',kind:'类型',model:'模型',effort:'思考强度',custom:'自定义',models:'可用模型',efforts:'可用思考强度',
  modelEfforts:'各模型思考程度',modelServiceTiers:'各模型服务速度',defaultModel:'默认模型',defaultEffort:'默认思考程度',
  tier:'速度',provider:'提供方',mode:'模式',sandbox:'沙盒',network:'网络',permissionMode:'权限模式',
  version:'配置版本',blocks:'显示项',reply:'回复显示',streamText:'流式文字',collapseAfterRun:'完成后折叠',
  id:'显示项标识',name:'名称',slot:'位置',appearance:'样式',template:'显示文案',requestedTemplate:'请求文案',size:'字号',color:'颜色',
  warning:'警告',warningAt:'警告阈值',contextRules:'上下文提示',yellowAt:'黄色阈值',orangeAt:'橙色阈值',redAt:'红色阈值',showFrom:'开始显示阈值',enabledColors:'启用颜色',
  title:'标题',instructions:'说明',required:'必须完成',action:'操作',entry:'设置入口',check:'核对说明',
};
const enumNames:Record<string,string>={multi:'多会话',single:'单会话',smart:'智能会话',default:'默认',steer:'引导当前执行',queue:'排队',
  explicit:'指定模型',llm:'模型',decision:'判断模型',provider:'内置判断服务',context:'上下文',model:'模型',time:'用时',status:'状态',tools:'工具',thinking:'思考',stop:'停止',reminder:'提醒',custom:'自定义',off:'关闭',running:'运行时展示',always:'始终',done:'完成后展示',manual:'手动',long:'仅长任务',failures:'仅失败',
  'read-only':'只读','workspace-write':'工作区可写','danger-full-access':'完全访问',acceptEdits:'自动接受编辑',plan:'计划',auto:'自动',bypassPermissions:'跳过权限确认',text:'文字',percent:'百分比',bar:'进度条',icon:'图标','top-left':'顶部左侧','top-right':'顶部右侧',top:'顶部',process:'执行过程','bottom-left':'底部左侧','bottom-right':'底部右侧',bottom:'底部','actions-left':'操作区左侧','actions-right':'操作区右侧',notation:'小字',normal:'正常',grey:'灰色',blue:'蓝色',qa:'问答',write:'允许写入',full:'完整权限',inherit:'跟随默认',standard:'标准',fast:'快速',ultrafast:'极速',all:'允许',config:'配置',tool:'工具',nativeSettings:'打开设置'};
const enumFields=new Set(['sessionMode','run.pendingPolicy','presentation.showModel','presentation.completionMode','kind','tier','mode','sandbox','permissionMode','slot','appearance','size','color','network','enabledColors']);
function values(value:unknown,key?:string):string{
  if(value===null)return '无';
  if(typeof value==='string')return key&&enumFields.has(key)?enumNames[value]??value:value;
  if(typeof value==='boolean')return value?'开启':'关闭';
  if(typeof value==='number')return String(value);
  if(Array.isArray(value))return value.length?value.map(v=>values(v,key)).join('\n'):'（无）';
  if(typeof value!=='object')throw new Error('无法完整展示');
  return Object.entries(value).map(([key,v])=>{
    if(!labels[key])throw new Error('无法准确展示字段');
    if(key==='modelEfforts'||key==='modelServiceTiers'){
      if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('模型建议无效');
      return labels[key]+'\n'+Object.entries(v).map(([name,setting])=>name+' → '+values(setting)).join('\n');
    }
    return labels[key]+' → '+values(v,key);
  }).join('\n');
}
function text(value:RecipeRichText):string{
  if(value.kind!=='inline')throw new Error('文件完整内容未载入');
  return value.value;
}
function skillFiles(skill:RecipeRichContent['skills'][number],content:RecipeRichContent){
  const files=skill.fileIds.map(id=>{
    const f=content.files.find(f=>f.itemId===id);if(!f)throw new Error('技能文件不存在');return f;
  });
  const entry=files.find(f=>f.itemId===skill.entryFileId);if(!entry)throw new Error('技能说明不存在');
  return {files,entry};
}
const uses={skillDescription:'技能说明',reference:'参考资料',declaration:'声明'};
const purposes={work:'工作规则',smartRespond:'智能回复规则',smartNewTopic:'智能话题规则'};
function settingValue(setting:RecipeRichSetting){
  if(setting.field==='presentation.cardDisplay'&&setting.value){
    const blocks=setting.value.blocks.map(({itemId:_id,originId:_origin,...block})=>block);
    return values({...setting.value,blocks});
  }
  return values(setting.value,setting.field);
}
function taskValue(task:RecipeRichContent['tasks'][number]){
  const spec=task.spec;
  let cadence:string;
  switch(spec.kind){
    case 'once':cadence='单次执行，Unix 毫秒时间 '+spec.at;break;
    case 'every':cadence='每 '+spec.minutes+' 分钟';break;
    case 'daily':cadence='每天 '+spec.time;break;
    case 'weekly':cadence='每周 '+spec.days.map(day=>['日','一','二','三','四','五','六'][day]).join('、')+' '+spec.time;break;
    case 'cron':cadence='Cron '+spec.expr;break;
  }
  return '名称 → '+task.name+'\n任务说明 → '+text(task.instruction)+'\n时间 → '+cadence+'\n时区 → '+
    (task.timeZone.kind==='targetChoice'?'由使用者选择':task.timeZone.iana)+'\n发布位置 → '+(task.placement==='follow'?'当前话题':'新话题');
}
function itemFields(content:RecipeRichContent,summary:boolean):Field[]{
  const fields:Field[]=[];
  if(content.role)fields.push(field('角色',summary?'已选本地角色 · '+Buffer.byteLength(text(content.role.text))+' 字节':text(content.role.text)));
  for(const setting of content.settings)fields.push(field(labels[setting.field]!,summary?'已选本地配置':settingValue(setting)));
  for(const rule of content.rules)fields.push(field(purposes[rule.purpose],summary?'已选 · '+Buffer.byteLength(text(rule.text))+' 字节':text(rule.text)));
  for(const skill of content.skills){
    const {files,entry}=skillFiles(skill,content);
    fields.push(field('技能',skill.name+'\n说明文件 → '+entry.name+'\n包含文件\n'+files.map(f=>f.name+(summary?' · '+Buffer.byteLength(text(f.text))+' 字节':'')).join('\n')));
  }
  for(const file of content.files)if(!summary||!content.skills.some(s=>s.fileIds.includes(file.itemId)))
    fields.push(field('文件',file.name+'\n用途 → '+uses[file.use]+(summary?'\n'+Buffer.byteLength(text(file.text))+' 字节':'\n完整内容\n'+text(file.text))));
  for(const task of content.tasks)fields.push(field('任务',summary?task.name+' · '+Buffer.byteLength(text(task.instruction))+' 字节':taskValue(task)));
  for(const memory of content.memories)fields.push(field('记忆',summary?'已选 · '+Buffer.byteLength(text(memory.text))+' 字节':text(memory.text)));
  for(const step of content.setup){
    const {itemId:_id,originId:_origin,...value}=step;
    fields.push({...field('旧补充说明',values(value)),valueJson:JSON.stringify(value)});
  }
  if(content.finalLogo)throw new Error('Logo 需要图片核对');
  return fields;
}
export function contentReviewFields(content:RecipeRichContent,summary:boolean){
  return [...Object.entries(content.public).filter(([,v])=>!summary||v.value!=='').map(([key,v])=>field(fieldLabels[key as keyof typeof fieldLabels],v.value)),...itemFields(content,summary)];
}
export function selectedItemReview(content:RecipeRichContent,itemId:string,kind:string):Field[]{
  const subset:RecipeRichContent={...content,role:undefined,skills:[],files:[],settings:[],rules:[],tasks:[],memories:[],setup:[],finalLogo:undefined};
  switch(kind){
    case 'role':if(content.role?.itemId===itemId)subset.role=content.role;break;
    case 'skill':{
      const skill=content.skills.find(s=>s.itemId===itemId);
      if(skill){subset.skills=[skill];subset.files=skillFiles(skill,content).files;}
      break;
    }
    case 'setting':subset.settings=content.settings.filter(i=>i.itemId===itemId);break;
    case 'file':subset.files=content.files.filter(i=>i.itemId===itemId);break;
    case 'rule':subset.rules=content.rules.filter(i=>i.itemId===itemId);break;
    case 'task':subset.tasks=content.tasks.filter(i=>i.itemId===itemId);break;
    case 'memory':subset.memories=content.memories.filter(i=>i.itemId===itemId);break;
    case 'setup':subset.setup=content.setup.filter(i=>i.itemId===itemId);break;
    case 'cardBlock':{
      for(const setting of content.settings)if(setting.field==='presentation.cardDisplay'&&setting.value){
        const block=setting.value.blocks.find(i=>i.itemId===itemId);
        if(block){const {itemId:_id,originId:_origin,...value}=block;return [field('消息显示项',values(value))];}
      }
      break;
    }
  }
  const fields=itemFields(subset,false);
  if(!fields.length)throw new Error('来源条目无法展示');
  return fields;
}
export function reviewTarget(content:RecipeRichContent,itemId:string){
  for(const [key,item] of Object.entries(content.public))if(item.itemId===itemId)return fieldLabels[key as keyof typeof fieldLabels];
  if(content.role?.itemId===itemId)return '角色';
  for(const skill of content.skills)if(skill.itemId===itemId)return '技能“'+skill.name+'”';
  for(const file of content.files)if(file.itemId===itemId)return '文件“'+file.name+'”';
  for(const task of content.tasks)if(task.itemId===itemId)return '任务“'+task.name+'”';
  for(const setting of content.settings){
    if(setting.itemId===itemId)return labels[setting.field]!;
    if(setting.field==='presentation.cardDisplay'&&setting.value){
      const block=setting.value.blocks.find(b=>b.itemId===itemId);if(block)return '显示项“'+block.name+'”';
    }
  }
  const rule=content.rules.find(r=>r.itemId===itemId);if(rule)return purposes[rule.purpose]+'第 '+(content.rules.indexOf(rule)+1)+' 项';
  const memory=content.memories.find(m=>m.itemId===itemId);if(memory)return '记忆第 '+(content.memories.indexOf(memory)+1)+' 项';
  throw new Error('修改目标不存在');
}
export function changeReviewFields(change:RecipeRichDraftChange,content:RecipeRichContent):Field[]{
  if(change.op==='setAccess')return [field('获取方式',change.value==='coded'?'凭码获取':'直接获取')];
  if(change.op==='setFinalLogo'||change.op==='includeCandidate'||change.op==='addSetup'||change.op==='setSetup')throw new Error('此类改动需要额外核对');
  if(change.op==='copyItem')return [field('复制',reviewTarget(content,change.source.itemId)),
    ...('parentItemId'in change.source?[field('添加到',reviewTarget(content,change.source.parentItemId))]:[]),
    ...selectedItemReview(content,change.source.itemId,change.source.kind)];
  const name=reviewTarget(content,change.itemId);
  switch(change.op){
    case 'setPublicText':
      if(content.public[change.field].itemId!==change.itemId)throw new Error('公开字段不匹配');
      return [field(fieldLabels[change.field],change.value)];
    case 'setRoleText':return [field(name,text(change.value))];
    case 'setSkill':return [field(name+'名称',change.value.name)];
    case 'setFile':return [field(name,'名称 → '+change.value.name+'\n完整内容\n'+text(change.value.text))];
    case 'setRule':return [field(name,'用途 → '+purposes[change.value.purpose]+'\n'+text(change.value.text))];
    case 'setTask':return [field(name,taskValue({...change.value,itemId:change.itemId,originId:change.itemId}))];
    case 'setSetting':return [field(name,'设置项 → '+labels[change.value.field]+'\n'+values(change.value.value,change.value.field))];
    case 'setCardReply':case 'setCardBlock':return [field(name,values(change.value))];
    case 'removeItem':return [field('移除',name)];
  }
}
