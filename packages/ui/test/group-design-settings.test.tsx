import {permissionValue} from './permission-fixture';
import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {DEFAULT_SMART_RULES, agentIdSchema, defaultCardDisplay, type ModelCatalog, type ProjectSettingsView} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {DirectoryPickerProvider} from '../src/directory-picker';
import {GroupSettingsContent, ModelAccessChoices, modelAccessProblem, WorkspaceFields, type GroupSettingsTab} from '../src/settings/GroupDesignSettings';
import {groupDesignTabs, groupTabForSection} from '../src/GroupWorkspace';
import {PersonaEditor} from '../src/settings/PersonaEditor';

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const section = <const T,>(stored: T) => ({stored, effective: stored, revision: 'r', access: {kind: 'writable' as const}, apply: []});
const fixture = (): ProjectSettingsView => ({
  scope: {kind: 'project', botId: agentIdSchema.parse('cli_example'), projectName: '真实群'},
  identity: {chatId: 'oc_actual', backend: 'codex-appserver', cwd: '/Users/example/project', kind: 'smart'},
  botProfile: {persona: 'Bot 的个性原文', memory: 'Bot 的记忆原文'},
  skills: [{name: '实际技能', description: '从 Provider 发现', path: 'claude:actual', source: 'provider', enabled: true}],
  sections: {
    permission: section(permissionValue()), response: section({noMention: false}), model: section({selection: {kind: 'default'}}),
    profile: section({persona: '本群补充', memory: '本群记忆', inheritPersona: true, inheritMemory: false}),
    role: section({supplement: '本项目里多做发版检查'}),
    modelAccess: section({backend: 'codex-appserver', models: ['actual-a'], efforts: ['low']}),
    workspace: section({primary: '/one', directories: ['/one', '/two'], repositories: ['/repo-a', '/repo-b']}),
    skills: section({disabledPaths: []}),
    presentation: section({voiceEnabled: false, showToolCalls: true, showModel: 'running', completionMode: 'failures', longTaskMinutes: 3}),
    smartRules: section({respond: '响应规则原文', newTopic: '新话题规则原文'}),
    judge: section({selection: {kind: 'llm', backend: 'codex-appserver', model: 'actual-a'}}),
    run: {...section({pendingPolicy: 'default'}), effective: {pendingPolicy: 'queue'}},
  }, members: {openIds: [], revision: 'm'},
});
const render = (tab: GroupSettingsTab, view = fixture()) => renderToStaticMarkup(<ClientProvider client={client}><DirectoryPickerProvider>
  <GroupSettingsContent tab={tab} view={view} refresh={async () => {}} botName="测试 Bot" onOpenTools={() => {}}/>
</DirectoryPickerProvider></ClientProvider>);
const catalog: ModelCatalog = {backend: 'codex-appserver', state: 'ready', source: 'backend-provided', observedAt: 1, titleEfforts: ['low', 'high'], models: [
  {id: 'actual-a', displayName: '实际模型 A', description: '', isDefault: true, hidden: false, supportedEfforts: ['low'], defaultEffort: 'low'},
  {id: 'actual-b', displayName: '实际模型 B', description: '', isDefault: false, hidden: false, supportedEfforts: ['high'], defaultEffort: 'high'},
  {id: 'no-effort', displayName: '无 Effort 模型', description: '', isDefault: false, hidden: false, supportedEfforts: [], defaultEffort: 'none'},
]};
it('keeps the group role editor separate from stored memories', () => {
  const html = render('role');
  expect(html).toContain('aria-label="本群角色"');
  expect(html).toContain('本项目里多做发版检查');
  expect(html).toContain('留空时使用 Bot 页的角色设定');
  expect(html).not.toContain('智能判断会优先看这一段');
  expect(html).not.toContain('继承');
  expect(html).not.toContain('Bot 的个性原文');
  expect(html).not.toContain('Bot 的记忆原文');
  const missing = fixture(); delete missing.sections.role;
  expect(render('role', missing)).toContain('这项设置暂不可用');
  const bot = renderToStaticMarkup(<PersonaEditor label="个性" value="源内容" onChange={() => {}}/>);
  expect(bot).toContain('aria-label="Bot 个性"');
  expect(bot).not.toContain('继承');
  // the Bot's role editor is the two sections of SOUL.md, nothing else
  const role = renderToStaticMarkup(<><PersonaEditor label="身份与职责" value="助手" onChange={() => {}} maxLength={500}/><PersonaEditor label="其他说明" value="" onChange={() => {}}/></>);
  expect(role).toContain('aria-label="Bot 身份与职责"');
  expect(role).toContain('aria-label="Bot 其他说明"');
  expect(role.match(/<textarea/g)).toHaveLength(2);
});
it('shows discovered skills and no fabricated tool authorization state', () => {
  const html = render('capabilities');
  expect(html).toContain('实际技能');
  expect(html).toContain('aria-label="使用 实际技能"');
  expect(html).not.toContain('添加技能');
  expect(html).toContain('重新读取');
  expect(html).toContain('工具');
  expect(html).not.toContain('待安装');
  expect(html).not.toContain('待授权');
  const empty = fixture(); empty.skills = [];
  expect(render('capabilities', empty)).toContain('尚未发现技能');
  expect(render('capabilities', empty)).not.toContain('实际技能');
  const failed = fixture(); delete failed.skills; failed.skillsError = '启动 Bot 后可读取 Provider 的技能目录';
  expect(render('capabilities', failed)).toContain(failed.skillsError);
  expect(render('capabilities', failed)).not.toContain('尚未发现技能');
});
it('orders the group tabs with sharing, keeps compact model and permission settings together, and preserves legacy routes', () => {
  expect(groupDesignTabs.map(([, label]) => label)).toEqual(['模型与权限', '能力', '沟通方式', '记忆', '任务', '分享']);
  for (const section of ['任务', '定时任务']) expect(groupTabForSection(section)).toBe('schedule');
  expect(groupDesignTabs.map(([value]) => value)).not.toContain('workspace');
  for (const section of ['权限', '执行模型', '执行权限', '能挡到什么', '高级设置', '工作目录权限']) expect(groupTabForSection(section)).toBe('model');
  expect(groupTabForSection()).toBe('model');
  for (const section of ['沟通方式', '回复规则', '聊天方式']) expect(groupTabForSection(section)).toBe('response');
  for (const section of ['记忆', '项目记忆']) expect(groupTabForSection(section)).toBe('memory');
  const html = render('model');
  expect(html).toContain('模型设置'); expect(html).toContain('执行权限');
  expect(html).toContain('aria-label="配置可用模型"');
  expect(html).toContain('aria-label="配置可用思考强度"');
  expect(html).not.toContain('<summary>话题模型</summary>');
  expect(html).toContain('修改权限');
  expect(html).not.toContain('role="radiogroup" aria-label="权限"');
  expect(html).not.toContain('<h3>代码仓库</h3>');
  expect(render('permission')).toContain('执行权限');
  for (const tab of ['capabilities', 'role', 'response'] as const) {
    expect(render(tab)).not.toContain('能挡到什么');
    expect(render(tab)).not.toContain('<h3>代码仓库</h3>');
  }
});
it('does not show a group speed setting for either Provider', () => {
  const oldView = fixture();
  expect(render('model', oldView)).not.toContain('响应速度');
  const current = fixture();
  current.sections.speed = section({tier: 'inherit' as const});
  expect(render('model', current)).not.toContain('响应速度');
  current.identity.backend = 'claude-agent';
  expect(render('model', current)).not.toContain('响应速度');
});
it('keeps one primary among peer directories and no primary repository', () => {
  const html = renderToStaticMarkup(<ClientProvider client={client}><DirectoryPickerProvider>
    <WorkspaceFields value={{primary: '/one', directories: ['/one', '/two'], repositories: ['/repo-a', '/repo-b']}} onChange={() => {}} disabled={false}/>
  </DirectoryPickerProvider></ClientProvider>);
  expect(html).toContain('/one'); expect(html).toContain('/two');
  expect(html.match(/class="gd-primary-label"/g)).toHaveLength(1);
  expect(html).toContain('请先选择其他主目录');
  const repositories = html.slice(html.indexOf('<h3>代码仓库</h3>'));
  expect(repositories).toContain('/repo-a'); expect(repositories).toContain('/repo-b');
  expect(repositories).not.toContain('gd-primary-label');
  expect(repositories).not.toContain('设为主目录');
  expect(html).not.toContain('附加目录');
});
it('shows matching model and Effort count triggers without inline option lists', () => {
  const html = renderToStaticMarkup(<ModelAccessChoices value={{backend: catalog.backend, models: ['actual-a', 'actual-b'], efforts: ['low']}} catalog={catalog} disabled={false} onChange={() => {}}/>);
  expect(html).toContain('思考强度');
  expect(html).toContain('aria-label="配置可用模型"'); expect(html).toContain('aria-label="配置可用思考强度"');
  expect(html).toContain('2 个模型');
  expect(html).toContain('已自定义 · 2 组');
  expect(html.match(/gd-model-selection-control/g)).toHaveLength(2);
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain('>实际模型 A<'); expect(html).not.toContain('>实际模型 B<');
  expect(html).not.toContain('无 Effort 模型');
  expect(html).toContain('请选择 实际模型 B 支持的思考强度');
  const valid = renderToStaticMarkup(<ModelAccessChoices value={{backend: catalog.backend, models: ['actual-a'], efforts: ['low']}} catalog={catalog} disabled={false} onChange={() => {}}/>);
  expect(valid).toContain('群内通过 /model 切换；新话题默认：实际模型 A · low。');
  expect(valid).not.toContain('<small>'); expect(valid).not.toContain('普通速度');
});
it('rejects missing catalogs and model/Effort combinations with no intersection', () => {
  const value = {backend: catalog.backend, models: ['actual-a', 'actual-b'], efforts: ['low'] as ('low' | 'high')[]};
  expect(modelAccessProblem(value, catalog)).toContain('实际模型 B');
  expect(modelAccessProblem({...value, efforts: ['low', 'high']}, catalog)).toBeUndefined();
  // Old global allowsets can contain a native effort used only by an unselected model.
  expect(modelAccessProblem({...value, models: ['actual-a'], efforts: ['low', 'high']}, catalog)).toBeUndefined();
  expect(modelAccessProblem({...value, models: ['actual-a'], modelEfforts: {'actual-a': ['low', 'high']}}, catalog)).toContain('已不可用');
  expect(modelAccessProblem({...value, models: ['no-effort'], efforts: []}, catalog)).toBeUndefined();
  expect(modelAccessProblem({...value, models: []}, catalog)).toContain('至少');
  expect(modelAccessProblem(value)).toContain('暂不可用');
  expect(modelAccessProblem({...value, models: ['unknown']}, catalog)).toContain('unknown');
  expect(modelAccessProblem(value, {...catalog, backend: 'other'})).toContain('暂不可用');
});
it('combines legacy smart prompts in one editor without losing either custom rule', () => {
  const html = render('response');
  expect(html.indexOf('决策模型')).toBeLessThan(html.indexOf('判断规则'));
  expect(html).toContain('aria-label="选择决策模型"');
  expect(html).toContain('响应规则原文'); expect(html).toContain('新话题规则原文');
  expect(html.match(/role="textbox"/g)).toHaveLength(1);
  expect(html).toContain('contentEditable="true"');
  expect(html).toContain('回应谁'); expect(html).toContain('回复卡片样式'); expect(html).toContain('完成提醒');
  expect(html).not.toContain('显示模型');
  expect(html).not.toContain('跟着 Bot 默认');
  expect(html).not.toContain('查看合成');
  expect(html).not.toContain('不 @ 也能发起任务');
});
it('announces shared readonly reasons once but preserves independent safety reasons', () => {
  const view = fixture();
  for (const value of Object.values(view.sections)) if (value) value.access = {kind: 'readonly', reason: 'offline', message: '共同不可编辑原因'};
  view.sections.permission.access = {kind: 'readonly', reason: 'policy', message: '独有权限限制'};
  const html = render('response', view);
  expect(html.match(/共同不可编辑原因/g)).toHaveLength(1);
  expect(html.match(/独有权限限制/g)).toHaveLength(1);
});

it('shows a fixed local default and restores a group override to that default', () => {
  const initial = render('response');
  expect(initial).toContain('此群聊使用旧版默认展示');
  expect(initial).not.toContain('继承 Bot');
  const view = fixture();
  view.sections.presentation = {...view.sections.presentation!, stored: {...view.sections.presentation!.stored, cardDisplay: defaultCardDisplay()}};
  const overridden = render('response', view);
  expect(overridden).toContain('已自定义');
  expect(overridden).not.toContain('恢复默认展示');
  expect(overridden).not.toContain('aria-label="完成提醒"');
  const reminderOnly = fixture();
  reminderOnly.sections.presentation!.effective.completionMode = 'always';
  expect(render('response', reminderOnly)).toContain('已自定义');
  expect(render('response', reminderOnly)).not.toContain('恢复默认展示');
});

it('shows the actual default in one writing surface with four removable headings and restore', () => {
  const view = fixture();
  view.sections.smartRules = section({...DEFAULT_SMART_RULES});
  const html = render('response', view);
  for (const title of ['什么时候回应', '什么时候不回应', '消息在群主区时', '消息已经在话题里时']) expect(html).toContain(title);
  expect(html.match(/data-rule-heading/g)).toHaveLength(4);
  expect(html.match(/data-remove-heading/g)).toHaveLength(4);
  expect(html).toContain('话题内只判断是否回应');
  expect(html).toContain('恢复默认');
});

it('shows the server-resolved group model without migration or follow-global actions', () => {
  const view = fixture();
  view.sections.judge = {...section({selection: {kind: 'default'} as const}), effective: {selection: {kind: 'llm', backend: 'codex-appserver', model: 'legacy-group-model', effort: 'high'}}};
  for (const flag of [false, true]) {
    view.judgeInheritsHostDefault = flag;
    const html = render('response', view);
    expect(html).toContain('legacy-group-model');
    expect(html).toContain('high');
    expect(html).toContain('aria-label="选择决策模型"');
    expect(html).not.toContain('使用统一配置');
    expect(html).not.toContain('跟随全局默认');
    expect(html).not.toContain('正在读取默认决策模型');
  }
});


it('keeps new-message handling visible within chat settings while advanced smart rules start folded', () => {
  const smart = render('response');
  expect(smart).toContain('<details class="gd-disclosure"><summary>智能回应设置</summary>');
  expect(smart.indexOf('新消息处理')).toBeLessThan(smart.indexOf('回应谁'));
  expect(smart.indexOf('回应谁')).toBeLessThan(smart.indexOf('回复样式'));
  const claude = fixture(); claude.identity.backend = 'claude-agent';
  const html = render('response',claude);
  expect(html).toContain('新消息处理');
  expect(html).toContain('排队等待');
  expect(html).toContain('Claude 暂不支持立即插话');
  expect(html).not.toContain('aria-label="新消息处理"');
});
