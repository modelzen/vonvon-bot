import type {RecipeRichContent, RecipeRichSetting, RecipeRichText} from '@vonvon/protocol';
import {RecipeMarkdown} from './RecipeContent';
import {recipeSettingNames, recipeFieldNames as fieldNames, recipeValueNames as values, recipeLiteralFields as literalFields} from './rich-configuration-values';
export {recipeSettingNames} from './rich-configuration-values';

export type RichView = {content: RecipeRichContent; texts: Record<string,string>};
export function richText(text: RecipeRichText, view: RichView) {
  return text.kind === 'inline' ? text.value : view.texts[text.objectId] ?? '内容尚未读取，请重新打开此版本。';
}

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
export function RichConfiguration({view, section}: {view: RichView; section: string}) {
  const {content} = view;
  if (section === '模型与权限') {
    const settings = content.settings.filter(item => /^(model|modelAccess|speed|judge|permission)[.]/.test(item.field));
    return <section className="community-config"><h2>模型与权限</h2>{!settings.some(item => item.field === 'model.recommendation') && <p>推荐模型：未指定</p>}<RichSettings items={settings}/></section>;
  }
  if (section === '沟通方式') return <section className="community-config"><h2>沟通方式</h2><RichSettings items={content.settings.filter(item => !/^(model|modelAccess|speed|judge|permission)[.]/.test(item.field))}/></section>;
  if (section === '能力') return <section className="community-config"><h2>角色</h2>{content.role ? <RecipeMarkdown text={richText(content.role.text, view)}/> : <p>未指定</p>}<h2>规则</h2>{content.rules.map(rule => <article key={rule.itemId}><h3>{{work:'工作规则',smartRespond:'智能回复规则',smartNewTopic:'智能新话题规则'}[rule.purpose]}</h3><RecipeMarkdown text={richText(rule.text,view)}/></article>)}<h2>技能</h2>{!content.skills.length && <p className="community-muted">未选择技能</p>}{content.skills.map(skill => <article key={skill.itemId}><h3>{skill.name}</h3>{skill.fileIds.map(id => content.files.find(file => file.itemId === id)).map(file => file && <details key={file.itemId} open={file.itemId === skill.entryFileId}><summary>{file.name} · {{skillDescription:'技能说明',reference:'参考资料',declaration:'能力声明'}[file.use]}</summary><RecipeMarkdown text={richText(file.text,view)}/></details>)}</article>)}</section>;
  if (section === '任务') return <section className="community-config"><h2>任务</h2>{!content.tasks.length && <p className="community-muted">没有任务</p>}{content.tasks.map(task => <article key={task.itemId}><h3>{task.name}</h3><p>{task.spec.kind === 'every' ? `每 ${task.spec.minutes} 分钟` : task.spec.kind === 'once' ? new Date(task.spec.at).toLocaleString() : task.spec.kind === 'cron' ? task.spec.expr : task.spec.kind === 'daily' ? `每天 ${task.spec.time}` : `每周 ${task.spec.days.map(day=>['日','一','二','三','四','五','六'][day]).join('、')} ${task.spec.time}`} · {task.timeZone.kind === 'recommended' ? task.timeZone.iana : '安装时选择时区'} · {task.placement === 'follow' ? '跟随当前会话' : '新话题'}</p><RecipeMarkdown text={richText(task.instruction,view)}/><p className="community-muted">安装后暂停，核对实际执行条件后单独启用。</p></article>)}</section>;
  return null;
}

export function RichChangeList({changes}: {changes: import('@vonvon/protocol').RecipeRichDraftChange[]}) {
  return <div className="community-config">{changes.map((change,index) => <article key={index}><h3>{change.op === 'setPublicText' ? {name:'名称',summary:'公开简介',overview:'公开概览',version:'版本'}[change.field] : change.op === 'setAccess' ? '获取方式' : change.op === 'setFinalLogo' ? 'Logo' : change.op === 'setRoleText' ? '角色' : change.op === 'setSetting' ? '配置' : change.op === 'setTask' ? '任务' : change.op === 'setSetup' || change.op === 'addSetup' ? '补充说明' : change.op === 'removeItem' ? '移除项目' : change.op === 'setFile' ? '文档' : change.op === 'setRule' ? '规则' : '所选配置变更'}</h3>{'value' in change ? <SettingValue value={change.value}/> : <p>{change.op === 'removeLegacyMemories' ? '记忆不会包含在配方中。' : change.op === 'setFinalLogo' ? '使用本次明确选择并通过归一化检查的 Logo。保存后可核对最终图片。' : change.op === 'removeItem' ? `移除 ${change.kind}` : '按已核对的来源加入所选内容'}</p>}</article>)}</div>;
}
