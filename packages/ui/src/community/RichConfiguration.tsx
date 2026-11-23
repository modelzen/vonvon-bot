import type {RecipeBrowseDetail, RecipeRichContent, RecipeRichSetting, RecipeRichText} from '@vonvon/protocol';
import {recipeSkillDescription} from '@vonvon/protocol';
import {RecipeMarkdown} from './RecipeContent';
import {RecipeSkills} from './RecipeSkills';

export type RichView = {content: RecipeRichContent; texts: Record<string,string>};
export const recipeSettingNames: Record<RecipeRichSetting['field'], string> = {
  sessionMode: '会话模式', 'response.noMention': '无需提及 Bot', 'run.pendingPolicy': '执行期间的新消息',
  'presentation.voiceEnabled': '语音回复', 'presentation.showToolCalls': '展示工具调用', 'presentation.showModel': '模型标记',
  'presentation.completionMode': '完成通知', 'presentation.longTaskMinutes': '长任务分钟数', 'presentation.completionTemplate': '完成通知模板',
  'presentation.cardDisplay': '消息卡片', 'model.recommendation': '推荐模型', 'modelAccess.recommendation': '可选模型建议',
  'speed.recommendation': '速度建议', 'judge.recommendation': '判断模型建议', 'permission.requirement': '权限要求',
  'permission.codex.requirement': 'Codex 权限要求', 'permission.claude.requirement': 'Claude 权限要求',
};
const fieldNames:Record<string,string>={text:'内容',instruction:'任务内容',instructions:'说明',purpose:'用途',field:'设置项',backend:'执行工具',selection:'模型选择',kind:'类型',model:'模型',effort:'思考强度',custom:'自定义',models:'可用模型',efforts:'可用思考强度',modelEfforts:'各模型思考强度',modelServiceTiers:'各模型速度',defaultModel:'默认模型',defaultEffort:'默认思考强度',tier:'速度',provider:'判断服务',mode:'启用时机',sandbox:'文件访问范围',network:'网络访问',permissionMode:'权限模式',version:'配置版本',blocks:'卡片内容',reply:'回复显示',streamText:'流式回复',collapseAfterRun:'完成后折叠',name:'名称',slot:'位置',appearance:'显示形式',template:'显示模板',requestedTemplate:'请求模板',size:'字号',color:'颜色',warning:'阈值提醒',warningAt:'提醒阈值',title:'标题',use:'文档用途',spec:'执行时间',timeZone:'时区',placement:'执行位置',check:'检查方式',required:'必需',action:'准备方式',entry:'设置入口',at:'执行时间',minutes:'间隔分钟',time:'时间',days:'星期',expr:'时间表达式',iana:'时区',contextRules:'上下文提醒',yellowAt:'黄色阈值',orangeAt:'橙色阈值',redAt:'红色阈值',showFrom:'开始显示阈值',enabledColors:'启用颜色'};
const values: Record<string,string> = {multi:'多会话',single:'单会话',smart:'智能会话',default:'默认',steer:'引导当前执行',queue:'排队',
  direct:'直接获取',coded:'凭分享码获取',explicit:'指定模型',llm:'模型',decision:'判断模型',provider:'内置判断服务',context:'上下文',model:'模型',time:'用时',status:'状态',tools:'工具',thinking:'思考',stop:'停止',reminder:'提醒',custom:'自定义',off:'关闭',running:'运行时展示',always:'始终',done:'完成后展示',manual:'手动',long:'仅长任务',failures:'仅失败',
  'read-only':'只读','workspace-write':'工作区可写','danger-full-access':'完全访问',acceptEdits:'自动接受编辑',plan:'计划',auto:'自动',bypassPermissions:'跳过权限确认',text:'文字',percent:'百分比',bar:'进度条',icon:'图标','top-left':'顶部左侧','top-right':'顶部右侧',top:'顶部',process:'执行过程','bottom-left':'底部左侧','bottom-right':'底部右侧',bottom:'底部',notation:'小字',normal:'正常',grey:'灰色',blue:'蓝色',qa:'问答',write:'允许写入',full:'完整权限',inherit:'跟随默认',standard:'标准',fast:'快速',ultrafast:'极速',work:'工作规则',smartRespond:'智能回复规则',smartNewTopic:'智能新话题规则',skillDescription:'技能说明',reference:'参考资料',declaration:'能力声明',follow:'跟随当前会话',newTopic:'新话题',every:'定时间隔',once:'单次',daily:'每天',weekly:'每周',cron:'时间表达式',recommended:'推荐时区',targetChoice:'安装时选择时区',config:'配置',tool:'工具',nativeSettings:'打开设置'};
export function richText(text: RecipeRichText, view: RichView) {
  return text.kind === 'inline' ? text.value : view.texts[text.objectId] ?? '内容尚未读取，请重新打开此版本。';
}
const literalFields = new Set(['text', 'instruction', 'instructions', 'name', 'title', 'template', 'requestedTemplate', 'model', 'models', 'effort', 'efforts', 'defaultModel', 'defaultEffort', 'backend', 'check', 'expr', 'iana']);
export function SettingValue({value, literal = false}: {value: unknown; literal?: boolean}) {
  if (value === null) return <span>未指定</span>;
  if (typeof value === 'boolean') return <span>{value ? '开启' : '关闭'}</span>;
  if (typeof value === 'string') return <span>{!literal && Object.hasOwn(values, value) ? values[value] : value}</span>;
  if (typeof value === 'number') return <span>{value}</span>;
  if (Array.isArray(value)) return <ul>{value.map((item, index) => <li key={index}><SettingValue value={item} literal={literal}/></li>)}</ul>;
  if (typeof value === 'object') return <dl>{Object.entries(value).filter(([key])=>!['itemId','originId','id'].includes(key)).map(([key,item]) => <div key={key}><dt>{Object.hasOwn(fieldNames, key) ? fieldNames[key] : key}</dt><dd><SettingValue literal={literal || literalFields.has(key)} value={key === 'field' && typeof item === 'string' ? Object.entries(recipeSettingNames).find(([field]) => field === item)?.[1] ?? item : item}/></dd></div>)}</dl>;
  return null;
}
export function RichSettings({items}: {items: RecipeRichSetting[]}) {
  return <dl className="community-rich-settings">{items.map(item => <div key={item.itemId}><dt>{recipeSettingNames[item.field]}</dt><dd><SettingValue value={item.value} literal={item.field === 'presentation.completionTemplate'}/></dd></div>)}</dl>;
}
export function RecipeBrowseConfiguration({preview, section}: {preview: NonNullable<RecipeBrowseDetail['preview']>; section: string}) {
  if (section === '模型与权限') {
    const settings = preview.settings.filter(item => /^(model|modelAccess|speed|judge|permission)[.]/.test(item.field));
    return <section className="community-config"><h2>模型与权限</h2>{!settings.some(item => item.field === 'model.recommendation') && <p>推荐模型：未指定</p>}<RichSettings items={settings}/></section>;
  }
  if (section === '沟通方式') return <section className="community-config"><h2>沟通方式</h2><RichSettings items={preview.settings.filter(item => !/^(model|modelAccess|speed|judge|permission)[.]/.test(item.field))}/></section>;
  if (section === '能力') return <section className="community-config"><h2>技能</h2><RecipeSkills skills={preview.skills}/><h2>规则</h2><p>{preview.ruleCount ? `包含 ${preview.ruleCount} 条规则，使用配方时应用。` : '没有规则'}</p></section>;
  if (section === '任务') return <section className="community-config"><h2>任务</h2><p>{preview.taskCount ? `包含 ${preview.taskCount} 项任务，添加到群后可查看并单独启用。` : '没有任务'}</p></section>;
  return null;
}
export function RichConfiguration({view, section}: {view: RichView; section: string}) {
  const {content} = view;
  if (section === '模型与权限') {
    const settings = content.settings.filter(item => /^(model|modelAccess|speed|judge|permission)[.]/.test(item.field));
    return <section className="community-config"><h2>模型与权限</h2>{!settings.some(item => item.field === 'model.recommendation') && <p>推荐模型：未指定</p>}<RichSettings items={settings}/></section>;
  }
  if (section === '沟通方式') return <section className="community-config"><h2>沟通方式</h2><RichSettings items={content.settings.filter(item => !/^(model|modelAccess|speed|judge|permission)[.]/.test(item.field))}/></section>;
  if (section === '能力') {
    const skills = content.skills.map(skill => {
      const entry = content.files.find(file => file.itemId === skill.entryFileId);
      return {itemId: skill.itemId, name: skill.name, description: entry ? recipeSkillDescription(richText(entry.text, view)) : ''};
    });
    return <section className="community-config"><h2>角色</h2>{content.role ? <RecipeMarkdown text={richText(content.role.text, view)}/> : <p>未指定</p>}<h2>规则</h2>{content.rules.map(rule => <article key={rule.itemId}><h3>{{work:'工作规则',smartRespond:'智能回复规则',smartNewTopic:'智能新话题规则'}[rule.purpose]}</h3><RecipeMarkdown text={richText(rule.text,view)}/></article>)}<h2>技能</h2><RecipeSkills skills={skills}/></section>;
  }
  if (section === '任务') return <section className="community-config"><h2>任务</h2>{!content.tasks.length && <p className="community-muted">没有任务</p>}{content.tasks.map(task => <article key={task.itemId}><h3>{task.name}</h3><p>{task.spec.kind === 'every' ? `每 ${task.spec.minutes} 分钟` : task.spec.kind === 'once' ? new Date(task.spec.at).toLocaleString() : task.spec.kind === 'cron' ? task.spec.expr : task.spec.kind === 'daily' ? `每天 ${task.spec.time}` : `每周 ${task.spec.days.map(day=>['日','一','二','三','四','五','六'][day]).join('、')} ${task.spec.time}`} · {task.timeZone.kind === 'recommended' ? task.timeZone.iana : '安装时选择时区'} · {task.placement === 'follow' ? '跟随当前会话' : '新话题'}</p><RecipeMarkdown text={richText(task.instruction,view)}/><p className="community-muted">安装后暂停，核对实际执行条件后单独启用。</p></article>)}</section>;
  return null;
}

export function RichChangeList({changes}: {changes: import('@vonvon/protocol').RecipeRichDraftChange[]}) {
  return <div className="community-config">{changes.map((change,index) => <article key={index}><h3>{change.op === 'setPublicText' ? {name:'名称',summary:'公开简介',overview:'公开概览',version:'版本'}[change.field] : change.op === 'setAccess' ? '获取方式' : change.op === 'setFinalLogo' ? 'Logo' : change.op === 'setRoleText' ? '角色' : change.op === 'setSetting' ? '配置' : change.op === 'setTask' ? '任务' : change.op === 'setSetup' || change.op === 'addSetup' ? '补充说明' : change.op === 'removeItem' ? '移除项目' : change.op === 'setFile' ? '文档' : change.op === 'setRule' ? '规则' : '所选配置变更'}</h3>{'value' in change ? <SettingValue value={change.value}/> : <p>{change.op === 'removeLegacyMemories' ? '记忆不会包含在配方中。' : change.op === 'setFinalLogo' ? '使用本次明确选择并通过归一化检查的 Logo。保存后可核对最终图片。' : change.op === 'removeItem' ? `移除 ${change.kind}` : '按已核对的来源加入所选内容'}</p>}</article>)}</div>;
}
