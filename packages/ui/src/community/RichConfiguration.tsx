import type {RecipeBrowseDetail, RecipeRichContent, RecipeRichSetting, RecipeRichText} from '@vonvon/protocol';
import {recipeSkillDescription} from '@vonvon/protocol';
import {RecipeMarkdown} from './RecipeContent';
import {RecipeSkills} from './RecipeSkills';
import './recipe-configuration.css';

export type RichView = {content: RecipeRichContent; texts: Record<string,string>};
export const recipeSettingNames: Record<RecipeRichSetting['field'], string> = {
  sessionMode: '会话模式', 'response.noMention': '无需提及 Bot', 'run.pendingPolicy': '执行期间的新消息',
  'presentation.voiceEnabled': '语音转文字', 'presentation.showToolCalls': '展示工具调用', 'presentation.showModel': '模型标记',
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
type SettingGroup = {title: string; fields: RecipeRichSetting['field'][]; note: string};
const modelGroups: SettingGroup[] = [
  {title: '模型建议', fields: ['model.recommendation', 'modelAccess.recommendation', 'speed.recommendation', 'judge.recommendation'], note: '未指定的项目沿用目标群设置；新建群时由 Bot 与你核对。'},
  {title: '权限要求', fields: ['permission.requirement', 'permission.codex.requirement', 'permission.claude.requirement'], note: '这里展示配方的权限要求。未指定时沿用目标群设置，权限变更仍需你确认。'},
];
const communicationGroups: SettingGroup[] = [
  {title: '会话与回应', fields: ['sessionMode', 'response.noMention', 'run.pendingPolicy'], note: '未指定的项目沿用目标群设置；新建群时由 Bot 与你核对。'},
  {title: '回复与通知', fields: ['presentation.voiceEnabled', 'presentation.showToolCalls', 'presentation.showModel', 'presentation.completionMode', 'presentation.longTaskMinutes', 'presentation.completionTemplate', 'presentation.cardDisplay'], note: '未指定的项目保留目标群的回复与通知设置。'},
];
export function RecipeSettingsConfiguration({settings, section, omittedSettingCount = 0}: {settings: RecipeRichSetting[]; section: string; omittedSettingCount?: number}) {
  const groups = section === '模型与权限' ? modelGroups : section === '沟通方式' ? communicationGroups : undefined;
  if (!groups) return null;
  const incomplete = omittedSettingCount > 0;
  return <section className="community-config recipe-configuration"><h2>{section}</h2>{incomplete && <p className="recipe-configuration-summary">此概览省略了 {omittedSettingCount} 项配置，未提供的字段需在应用配方时核对。</p>}<div className="recipe-configuration-cards">{groups.map(group => <section className="recipe-configuration-card" key={group.title} aria-label={group.title}>
    <h3>{group.title}</h3><dl className="recipe-configuration-fields">{group.fields.map(field => {
      const item = settings.find(setting => setting.field === field);
      return <div key={field}><dt>{recipeSettingNames[field]}</dt><dd>{item ? item.value === null ? <span>{field === 'presentation.completionTemplate' ? '使用默认完成通知模板' : '使用默认消息卡片'}</span> : <SettingValue value={item.value} literal={field === 'presentation.completionTemplate'}/> : <span className="recipe-configuration-unset">{incomplete ? '概览未提供' : '未指定'}</span>}</dd></div>;
    })}</dl><p className="recipe-configuration-note">{incomplete ? group.title === '权限要求' ? '未提供不代表未配置；实际权限变更仍需你确认。' : '未提供不代表未配置，应用时再与 Bot 核对。' : group.note}</p>
  </section>)}</div></section>;
}
export function RecipeTaskSummary({count}: {count: number}) {
  return <section className="community-config recipe-configuration"><h2>任务</h2><section className="recipe-configuration-card recipe-task-summary" aria-label="定时任务">
    <h3>{count ? `包含 ${count} 项任务` : '未预设定时任务'}</h3>
    <p>{count ? '概览只展示任务数量。将配方应用到群聊时，再读取并核对具体任务安排。' : '这份配方没有预设定时任务。应用配方后，你可以在群聊中与 Bot 商定需要的任务。'}</p>
    <p className="recipe-configuration-note">{count ? '任务在应用后保持暂停，确认执行内容、时间和时区后再单独启用。' : '如需调整目标群已有任务，可在应用配方时与 Bot 一并核对。'}</p>
  </section></section>;
}
export function RecipeBrowseConfiguration({preview, section}: {preview: NonNullable<RecipeBrowseDetail['preview']>; section: string}) {
  if (section === '模型与权限' || section === '沟通方式') return <RecipeSettingsConfiguration settings={preview.settings} section={section} omittedSettingCount={preview.omittedSettingCount}/>;
  if (section === '能力') return <section className="community-config"><h2>技能</h2><RecipeSkills skills={preview.skills}/></section>;
  if (section === '任务') return <RecipeTaskSummary count={preview.taskCount}/>;
  return null;
}
export function RichConfiguration({view, section}: {view: RichView; section: string}) {
  const {content} = view;
  if (section === '模型与权限' || section === '沟通方式') return <RecipeSettingsConfiguration settings={content.settings} section={section}/>;
  if (section === '能力') {
    const skills = content.skills.map(skill => {
      const entry = content.files.find(file => file.itemId === skill.entryFileId);
      return {itemId: skill.itemId, name: skill.name, description: entry ? recipeSkillDescription(richText(entry.text, view)) : ''};
    });
    return <section className="community-config"><h2>角色</h2>{content.role ? <RecipeMarkdown text={richText(content.role.text, view)}/> : <p>未指定</p>}<h2>技能</h2><RecipeSkills skills={skills}/></section>;
  }
  if (section === '任务') return content.tasks.length ? <section className="community-config recipe-configuration"><h2>任务</h2><div className="recipe-configuration-cards">{content.tasks.map(task => <article className="recipe-configuration-card" key={task.itemId}><h3>{task.name}</h3><p>{task.spec.kind === 'every' ? `每 ${task.spec.minutes} 分钟` : task.spec.kind === 'once' ? new Date(task.spec.at).toLocaleString() : task.spec.kind === 'cron' ? task.spec.expr : task.spec.kind === 'daily' ? `每天 ${task.spec.time}` : `每周 ${task.spec.days.map(day=>['日','一','二','三','四','五','六'][day]).join('、')} ${task.spec.time}`} · {task.timeZone.kind === 'recommended' ? task.timeZone.iana : '安装时选择时区'} · {task.placement === 'follow' ? '跟随当前会话' : '新话题'}</p><RecipeMarkdown text={richText(task.instruction,view)}/><p className="recipe-configuration-note">安装后暂停，核对实际执行条件后单独启用。</p></article>)}</div></section> : <RecipeTaskSummary count={0}/>;
  return null;
}

export function RichChangeList({changes}: {changes: import('@vonvon/protocol').RecipeRichDraftChange[]}) {
  return <div className="community-config">{changes.map((change,index) => <article key={index}><h3>{change.op === 'setPublicText' ? {name:'名称',summary:'公开简介',overview:'公开概览',version:'版本'}[change.field] : change.op === 'setAccess' ? '获取方式' : change.op === 'setFinalLogo' ? 'Logo' : change.op === 'setRoleText' ? '角色' : change.op === 'setSetting' ? '配置' : change.op === 'setTask' ? '任务' : change.op === 'setSetup' || change.op === 'addSetup' ? '补充说明' : change.op === 'removeItem' ? '移除项目' : change.op === 'setFile' ? '文档' : change.op === 'setRule' ? '规则' : '所选配置变更'}</h3>{'value' in change ? <SettingValue value={change.value}/> : <p>{change.op === 'removeLegacyMemories' ? '记忆不会包含在配方中。' : change.op === 'setFinalLogo' ? '使用本次明确选择并通过归一化检查的 Logo。保存后可核对最终图片。' : change.op === 'removeItem' ? `移除 ${change.kind}` : '按已核对的来源加入所选内容'}</p>}</article>)}</div>;
}
