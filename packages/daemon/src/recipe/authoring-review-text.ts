import type {RecipeRichContent,RecipeRichDraftChange,RecipeRichSetting,RecipeRichText} from '@vonvon/protocol';
import {fieldLabels,type CandidateCardDetails} from './draft-instruction';

type Field=CandidateCardDetails['fields'][number];
type ItemKind=Extract<RecipeRichDraftChange,{op:'removeItem'}>['kind'];
const field=(label:string,text:string):Field=>({label,text,valueJson:JSON.stringify(text),separate:true});
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
  name:'名称',slot:'位置',appearance:'样式',template:'显示文案',requestedTemplate:'请求文案',size:'字号',color:'颜色',
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
function valueFields(value:unknown,label:string,key?:string):Field[]{
  if(value===null)return [field(label+'模式','使用默认')];
  if(typeof value!=='object')return [field(label,values(value,key))];
  if(Array.isArray(value))return [field(label+'数量',String(value.length)),...value.flatMap((v,index)=>valueFields(v,label+'第 '+(index+1)+' 项',key))];
  return Object.entries(value).flatMap(([key,v])=>{
    const name=labels[key];if(!name)throw new Error('无法准确展示字段');
    if(key==='modelEfforts'||key==='modelServiceTiers'){
      if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('模型建议无效');
      return Object.entries(v).flatMap(([model,setting])=>[field('模型名称',model),...valueFields(setting,name)]);
    }
    return valueFields(v,label+' · '+name,key);
  });
}
export function reviewPositions(states:readonly RecipeRichContent[]){
  const positions=new Map<string,number>();
  const groups=['settings','rules','skills','files','tasks','memories','setup','blocks'] as const;
  for(const key of groups){
    const seen=new Set<string>();
    for(const content of states){
      const items=key==='blocks'?content.settings.flatMap(s=>s.field==='presentation.cardDisplay'&&s.value?s.value.blocks:[]):content[key];
      for(const item of items)if(!seen.has(item.itemId)){seen.add(item.itemId);positions.set(item.itemId,seen.size);}
    }
  }
  return positions;
}
type Positions=ReadonlyMap<string,number>;
function position(items:readonly {itemId:string}[],itemId:string,positions?:Positions){
  const index=items.findIndex(item=>item.itemId===itemId);
  if(index<0)throw new Error('修改目标不存在');
  return '第 '+(positions?.get(itemId)??index+1)+' 项';
}
function fileIdentity(file:RecipeRichContent['files'][number],content:RecipeRichContent,positions?:Positions):Field[]{
  return [field('文件位置',position(content.files,file.itemId,positions)),
    ...content.skills.filter(skill=>skill.fileIds.includes(file.itemId)).flatMap(skill=>[
      field('所属技能位置',position(content.skills,skill.itemId,positions)),field('所属技能名称',skill.name),
    ]),field('文件相对路径',file.name)];
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
function settingFields(setting:RecipeRichSetting):Field[]{
  const name=labels[setting.field]!;
  if(setting.field==='presentation.completionTemplate')return [field('设置项',name),
    field('通知文案模式',setting.value===null?'使用默认':'自定义文案'),...(setting.value===null?[]:[field('完成通知文案',setting.value)])];
  if(setting.field==='presentation.cardDisplay'&&setting.value){
    const blocks=setting.value.blocks.map(({itemId:_item,originId:_origin,id:_id,...block})=>block);
    return [field('设置项',name),...valueFields({...setting.value,blocks},name)];
  }
  return [field('设置项',name),...valueFields(setting.value,name,setting.field)];
}
function taskFields(task:RecipeRichContent['tasks'][number]):Field[]{
  const spec=task.spec;
  let cadence:string;
  switch(spec.kind){
    case 'once':cadence='单次执行，Unix 毫秒时间 '+spec.at;break;
    case 'every':cadence='每 '+spec.minutes+' 分钟';break;
    case 'daily':cadence='每天 '+spec.time;break;
    case 'weekly':cadence='每周 '+spec.days.map(day=>['日','一','二','三','四','五','六'][day]).join('、')+' '+spec.time;break;
    case 'cron':cadence='Cron '+spec.expr;break;
  }
  return [field('任务名称',task.name),field('任务说明',text(task.instruction)),field('执行时间',cadence),
    field('时区模式',task.timeZone.kind==='targetChoice'?'由使用者选择':'建议时区'),
    ...(task.timeZone.kind==='recommended'?[field('建议时区',task.timeZone.iana)]:[]),
    field('发布位置',task.placement==='follow'?'当前话题':'新话题')];
}
function sourceFields(content:RecipeRichContent):Field[]{
  const fields:Field[]=[];
  if(content.role)fields.push(field('角色','已选本地角色 · '+Buffer.byteLength(text(content.role.text))+' 字节'));
  if(content.settings.length)fields.push(field('设置来源清单',content.settings.map(setting=>{
    const name=labels[setting.field]!;
    if(setting.field!=='presentation.cardDisplay')return name+' → 已选本地配置';
    if(!setting.value)return name+' → 使用默认';
    const {blocks,reply}=setting.value;
    return [name,'显示项数量 → '+blocks.length,...blocks.map((block,index)=>'显示项 '+(index+1)+' → '+JSON.stringify(block.name)),
      '回复显示 → '+(reply?'已包含':'未包含'),...(reply?['流式文字 → '+values(reply.streamText),'完成后折叠 → '+values(reply.collapseAfterRun)]:[])].join('\n');
  }).join('\n\n')));
  if(content.rules.length)fields.push(field('规则来源清单',content.rules.map((rule,index)=>
    '规则 '+(index+1)+' → '+purposes[rule.purpose]+' · '+Buffer.byteLength(text(rule.text))+' 字节').join('\n')));
  if(content.skills.length)fields.push(field('技能来源清单',content.skills.map((skill,index)=>{
    const {files,entry}=skillFiles(skill,content);
    return ['技能 '+(index+1),'名称 → '+JSON.stringify(skill.name),'说明文件相对路径 → '+JSON.stringify(entry.name),'包含文件数量 → '+files.length,
      ...files.map((file,index)=>'文件 '+(index+1)+' → '+JSON.stringify(file.name)+' · '+Buffer.byteLength(text(file.text))+' 字节')].join('\n');
  }).join('\n\n')));
  const unowned=content.files.filter(file=>!content.skills.some(skill=>skill.fileIds.includes(file.itemId)));
  if(unowned.length)fields.push(field('独立文件来源清单',unowned.map(file=>
    position(content.files,file.itemId)+' → '+JSON.stringify(file.name)+' · '+uses[file.use]+' · '+Buffer.byteLength(text(file.text))+' 字节').join('\n')));
  if(content.tasks.length)fields.push(field('任务来源清单',content.tasks.map((task,index)=>
    '任务 '+(index+1)+' → '+JSON.stringify(task.name)+' · '+Buffer.byteLength(text(task.instruction))+' 字节').join('\n')));
  if(content.memories.length)fields.push(field('记忆来源清单',content.memories.map((memory,index)=>
    '记忆 '+(index+1)+' → '+Buffer.byteLength(text(memory.text))+' 字节').join('\n')));
  return fields;
}
function itemFields(content:RecipeRichContent,summary:boolean):Field[]{
  const fields:Field[]=[];
  if(summary)fields.push(...sourceFields(content));
  else{
    if(content.role)fields.push(field('角色',text(content.role.text)));
    for(const setting of content.settings)fields.push(...settingFields(setting));
    for(const rule of content.rules)fields.push(field('规则位置',position(content.rules,rule.itemId)),field('规则用途',purposes[rule.purpose]),
      field('规则正文',text(rule.text)));
    for(const skill of content.skills){
      const {files,entry}=skillFiles(skill,content);
      fields.push(field('技能位置',position(content.skills,skill.itemId)),field('技能名称',skill.name),field('说明文件相对路径',entry.name),
        ...files.map(f=>field('包含文件相对路径',f.name)));
    }
    for(const file of content.files)fields.push(...fileIdentity(file,content),field('文件用途',uses[file.use]),field('完整内容',text(file.text)));
    for(const task of content.tasks)fields.push(field('任务位置',position(content.tasks,task.itemId)),...taskFields(task));
    for(const memory of content.memories)fields.push(field('记忆',text(memory.text)));
  }
  for(const step of content.setup){
    const {itemId:_id,originId:_origin,...value}=step;
    fields.push({...field('旧补充说明',values(value)),valueJson:JSON.stringify(value)});
  }
  if(content.finalLogo)throw new Error('Logo 需要图片核对');
  return fields;
}
export function contentReviewFields(content:RecipeRichContent,summary:boolean,inheritedVersionId?:string,newFields:readonly string[]=[]){
  const unchanged=(key:keyof RecipeRichContent['public'])=>!newFields.includes(content.public[key].itemId);
  const inheritedText=(['summary','overview'] as const).filter(unchanged).map(key=>
    fieldLabels[key]+' '+Buffer.byteLength(content.public[key].value)+' 字节').join(' · ');
  const publicFields=inheritedVersionId?[field('继承来源版本',inheritedVersionId),
    ...(unchanged('name')?[field('配方名称',content.public.name.value)]:[]),
    ...(inheritedText?[field('已继承发布文案',inheritedText+'。完整发布信息在 App 核对。')]:[])]:
    Object.entries(content.public).filter(([,v])=>!summary||v.value!=='').map(([key,v])=>field(fieldLabels[key as keyof typeof fieldLabels],v.value));
  const changed=inheritedVersionId?Object.entries(content.public).filter(([,item])=>newFields.includes(item.itemId))
    .map(([key,item])=>field(fieldLabels[key as keyof typeof fieldLabels],item.value)):[];
  return [...publicFields,...changed,...itemFields(content,summary)];
}
function selectedItemReview(content:RecipeRichContent,itemId:string,kind:ItemKind,positions:Positions):Field[]{
  const subset:RecipeRichContent={...content,role:undefined,skills:[],files:[],settings:[],rules:[],tasks:[],memories:[],setup:[],finalLogo:undefined};
  switch(kind){
    case 'role':if(content.role?.itemId===itemId)subset.role=content.role;break;
    case 'skill':{
      const skill=content.skills.find(s=>s.itemId===itemId);
      if(skill){
        const {files,entry}=skillFiles(skill,content);
        return [field('技能位置',position(content.skills,itemId,positions)),field('技能名称',skill.name),field('说明文件相对路径',entry.name),
          ...files.flatMap(file=>[...fileIdentity(file,content,positions),field('文件用途',uses[file.use]),field('完整内容',text(file.text))])];
      }
      break;
    }
    case 'setting':{
      const setting=content.settings.find(i=>i.itemId===itemId);
      if(setting)return [field('设置位置',position(content.settings,itemId,positions)),...settingFields(setting)];break;
    }
    case 'file':{
      const file=content.files.find(i=>i.itemId===itemId);
      if(file)return [...fileIdentity(file,content,positions),field('文件用途',uses[file.use]),field('完整内容',text(file.text))];break;
    }
    case 'rule':{
      const rule=content.rules.find(i=>i.itemId===itemId);
      if(rule)return [field('规则位置',position(content.rules,itemId,positions)),field('规则用途',purposes[rule.purpose]),field('规则正文',text(rule.text))];break;
    }
    case 'task':{
      const task=content.tasks.find(i=>i.itemId===itemId);
      if(task)return [field('任务位置',position(content.tasks,itemId,positions)),...taskFields(task)];break;
    }
    case 'memory':subset.memories=content.memories.filter(i=>i.itemId===itemId);break;
    case 'setup':subset.setup=content.setup.filter(i=>i.itemId===itemId);break;
    case 'cardBlock':{
      for(const setting of content.settings)if(setting.field==='presentation.cardDisplay'&&setting.value){
        const block=setting.value.blocks.find(i=>i.itemId===itemId);
        if(block){const {itemId:_item,originId:_origin,id:_id,...value}=block;
          return [field('显示项位置',position(setting.value.blocks,itemId,positions)),...valueFields(value,'消息显示项')];}
      }
      break;
    }
  }
  const fields=itemFields(subset,false);
  if(!fields.length)throw new Error('来源条目无法展示');
  return fields;
}
function reviewTargetFields(content:RecipeRichContent,itemId:string,positions:Positions):Field[]{
  for(const [key,item] of Object.entries(content.public))if(item.itemId===itemId)return [field('目标字段',fieldLabels[key as keyof typeof fieldLabels])];
  if(content.role?.itemId===itemId)return [field('目标项目','角色')];
  for(const skill of content.skills)if(skill.itemId===itemId)return [field('技能位置',position(content.skills,itemId,positions)),field('技能名称',skill.name)];
  for(const file of content.files)if(file.itemId===itemId)return fileIdentity(file,content,positions);
  for(const task of content.tasks)if(task.itemId===itemId)return [field('任务位置',position(content.tasks,itemId,positions)),field('任务名称',task.name)];
  for(const setting of content.settings){
    if(setting.itemId===itemId)return [field('设置位置',position(content.settings,itemId,positions)),field('设置项',labels[setting.field]!)];
    if(setting.field==='presentation.cardDisplay'&&setting.value){
      const block=setting.value.blocks.find(b=>b.itemId===itemId);if(block)return [field('设置位置',position(content.settings,setting.itemId,positions)),
        field('显示项位置',position(setting.value.blocks,itemId,positions)),field('显示项名称',block.name)];
    }
  }
  const rule=content.rules.find(r=>r.itemId===itemId);if(rule)return [field('规则位置',position(content.rules,itemId,positions)),field('规则用途',purposes[rule.purpose])];
  const memory=content.memories.find(m=>m.itemId===itemId);if(memory)return [field('记忆位置',position(content.memories,itemId,positions))];
  throw new Error('修改目标不存在');
}
function addedItemId(before:RecipeRichContent,after:RecipeRichContent,kind:ItemKind){
  const ids=(content:RecipeRichContent)=>{
    switch(kind){
      case 'role':return content.role?[content.role]:[];
      case 'setting':return content.settings;
      case 'rule':return content.rules;
      case 'skill':return content.skills;
      case 'file':return content.files;
      case 'task':return content.tasks;
      case 'memory':return content.memories;
      case 'cardBlock':return content.settings.flatMap(s=>s.field==='presentation.cardDisplay'&&s.value?s.value.blocks:[]);
      default:throw new Error('此类改动需要额外核对');
    }
  };
  const prior=new Set(ids(before).map(item=>item.itemId)),added=ids(after).filter(item=>!prior.has(item.itemId));
  if(added.length!==1)throw new Error('无法准确核对新增条目');
  return added[0]!.itemId;
}
export function changeReviewFields(change:RecipeRichDraftChange,before:RecipeRichContent,after:RecipeRichContent,positions:Positions):Field[]{
  if(change.op==='setAccess')return [field('获取方式',change.value==='coded'?'凭码获取':'直接获取')];
  if(change.op==='setFinalLogo'||change.op==='addSetup'||change.op==='setSetup')throw new Error('此类改动需要额外核对');
  if(change.op==='copyItem'||change.op==='includeCandidate'){
    const kind=change.op==='copyItem'?change.source.kind:change.value.kind;
    return [field('操作',change.op==='copyItem'?'复制':'恢复原始条目'),
      ...(change.op==='copyItem'?reviewTargetFields(before,change.source.itemId,positions).map(f=>({...f,label:'复制来源 · '+f.label})):[]),
      ...selectedItemReview(after,addedItemId(before,after,kind),kind,positions)];
  }
  const target=reviewTargetFields(before,change.itemId,positions).map(f=>({...f,label:'修改目标 · '+f.label}));
  switch(change.op){
    case 'setPublicText':
      if(after.public[change.field].itemId!==change.itemId)throw new Error('公开字段不匹配');
      return [field(fieldLabels[change.field],after.public[change.field].value)];
    case 'setSkill':{
      const skill=after.skills.find(s=>s.itemId===change.itemId);if(!skill)throw new Error('技能不存在');
      return [...target,field('技能新名称',skill.name)];
    }
    case 'setRoleText':return [...target,...selectedItemReview(after,change.itemId,'role',positions)];
    case 'setFile':return [...target,...selectedItemReview(after,change.itemId,'file',positions)];
    case 'setRule':return [...target,...selectedItemReview(after,change.itemId,'rule',positions)];
    case 'setTask':return [...target,...selectedItemReview(after,change.itemId,'task',positions)];
    case 'setSetting':return [...target,...selectedItemReview(after,change.itemId,'setting',positions)];
    case 'setCardReply':{
      const setting=after.settings.find(s=>s.itemId===change.itemId);
      if(setting?.field!=='presentation.cardDisplay'||!setting.value?.reply)throw new Error('回复显示不存在');
      return [...target,...valueFields(setting.value.reply,'回复显示')];
    }
    case 'setCardBlock':return [...target,...selectedItemReview(after,change.itemId,'cardBlock',positions)];
    case 'removeItem':return [field('操作','移除'),...target];
  }
}
