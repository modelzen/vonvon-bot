import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';
import {agentIdSchema, groupIdSchema, membershipIdSchema, projectIdSchema, type DesktopSnapshot} from '@vonvon/protocol';
import {decisionKeySection, decisionProviderSection, diagnosticsSection, findEntries, searchEntries, settingAnchor} from '../src/search';
import {groupTabForSection} from '../src/GroupWorkspace';
import {routeFromSearch} from '../src/collaboration-navigation';
import {scheduleTask} from './schedule-fixture';

const agentId = agentIdSchema.parse('cli_searchagent');
const groupId = groupIdSchema.parse('oc_searchgroup');
const membershipId = membershipIdSchema.parse('searchmember');
const projectId = projectIdSchema.parse('prj_0a0b0c0d');
const snapshot: DesktopSnapshot = {
  revision: 1, observedAt: Date.now(), stale: false,
  host: {kind: 'connected', ownership: 'owned', version: '0.7.0'},
  agents: [{id: agentId, name: '研发助手', enabled: true, running: true, connection: 'connected', activation: 'active'}],
  groups: [{id: groupId, name: '研发群'}],
  projects: [{id: projectId, name: '研发项目组', revision: 1, directory: '/tmp/research', bindings: [{agentId, groupId}]}],
  memberships: [{id: membershipId, projectId, agentId, groupId, name: '研发项目', directory: '/tmp/research', backend: 'codex-appserver', conversation: 'threads', response: 'mention', permission: {administrator: 'full', member: 'qa', network: false}, stale: false}],
  tools: [], jobs: [],
  application: {platform: 'macos', version: '0.7.0', loginItem: false, dataPath: '/tmp/test'},
};
const entries = searchEntries(snapshot);

test('every literal configuration row label in the current desktop UI is indexed', () => {
  const settings = readFileSync(new URL('../src/settings/SettingsPanel.tsx', import.meta.url), 'utf8');
  // The old monolithic ProjectPanel and SessionPicker remain as compatibility code.
  // Only Bot settings and the new five-page surface belong in the search catalog.
  const botSettings = settings.slice(settings.indexOf('function AgentPanel('), settings.indexOf('export function ProjectPanel('));
  const source = [
    'src/settings/GroupDesignSettings.tsx',
    'src/settings/BotModelSettings.tsx',
    'src/management/MachinePanel.tsx',
    'src/management/UpdatePanel.tsx',
    'src/management/ConversationPanel.tsx',
    'src/App.tsx',
  ].map(path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).join('\n') + botSettings;
  const labels = [...source.matchAll(/<SettingsRow\b[^<>]*?\btitle="([^"]+)"/gs)].map(match => match[1]!);
  const transient = new Set(['正在读取当前设置…', '正在读取项目', '正在读取群内设置', '没有匹配的会话', '群配置读取失败', '尚未绑定飞书群']);
  const allAvailableEntries = searchEntries(snapshot, {externalCoreAvailable: true});
  const missing = [...new Set(labels)].filter(label => !transient.has(label) && !allAvailableEntries.some(entry => entry.title === label || entry.aliases.includes(label)));
  assert.deepEqual(missing, []);
});

test('application search exposes external Core controls only for a supported installation', () => {
  for (const catalog of [entries, searchEntries(snapshot, {externalCoreAvailable: false})]) {
    assert.ok(!catalog.some(entry => entry.destination.section === '外部 Core / CLI'));
    assert.deepEqual(findEntries(catalog, '检查 Core 更新'), []);
  }
  const available = searchEntries(snapshot, {externalCoreAvailable: true});
  for (const query of ['Core 来源', '检查 Core 更新', '更新外部 Core', '查看 Core 更新进度']) {
    const result = findEntries(available, query)[0];
    assert.equal(result?.destination.page, 'application', query);
    assert.equal(result?.destination.section, '外部 Core / CLI', query);
  }
});

test('application search omits unsupported service controls and keeps real daemon actions', () => {
  for (const query of ['安装并启动', '安装并启动后台服务', '卸载后台服务', '停止后台服务并关闭自启']) {
    assert.deepEqual(findEntries(entries, query), [], query);
  }
  for (const query of ['启动 daemon', '停止 daemon']) {
    const result = findEntries(entries, query)[0];
    assert.equal(result?.destination.page, 'application', query);
    assert.equal(result?.destination.section, 'daemon 运行', query);
    assert.equal(result?.destination.field, 'daemon 服务', query);
  }
});

test('application search points old startup and update labels to the compact controls', () => {
  for (const query of ['运行状态', '重启后台服务', '重启 daemon']) {
    const destination = findEntries(entries, query)[0]?.destination;
    assert.equal(destination?.page, 'application', query);
    assert.equal(destination?.section, '启动选项', query);
    assert.equal(destination?.field, '后台运行', query);
  }
  for (const query of ['桌面版', '更新状态', '可用版本']) {
    const destination = findEntries(entries, query)[0]?.destination;
    assert.equal(destination?.page, 'application', query);
    assert.equal(destination?.section, '软件更新', query);
    assert.equal(destination?.field, '', query);
  }
  for (const query of ['检查更新', '下载更新', '发布说明']) {
    const destination = findEntries(entries, query)[0]?.destination;
    assert.equal(destination?.page, 'application', query);
    assert.equal(destination?.section, '软件更新', query);
    assert.equal(destination?.field, query, query);
  }
  const install = findEntries(entries, '安装更新')[0]?.destination;
  assert.equal(install?.page, 'application');
  assert.equal(install?.section, '软件更新');
  assert.equal(install?.field, '重启升级');
});

test('s53: application owner and scanner search reveal their administrator rows', () => {
  for (const [query, field] of [
    ['飞书应用拥有者', '飞书应用拥有者'], ['飞书应用所有者', '飞书应用拥有者'],
    ['主人', '飞书应用拥有者'], ['扫码注册者', '扫码注册者'], ['扫码人', '扫码注册者'],
  ]) {
    const result = findEntries(entries, query!)[0];
    assert.equal(result?.destination.section, '管理员');
    assert.equal(result?.destination.detail?.kind, 'agent-settings');
    assert.equal(result?.destination.field, field);
    assert.deepEqual(result?.destination.selection, {kind: 'agent', id: agentId});
  }
});

test('rare field, aliases, and multi-term scope queries resolve to their real category', () => {
  assert.equal(findEntries(entries, '清空白名单')[0]?.destination.detail?.kind, 'membership-settings');
  assert.equal(findEntries(entries, 'App Secret')[0]?.destination.reveal, 'profile-add');
  assert.equal(findEntries(entries, '修复命令行工具').length, 0);
});

test('s02b: 咖啡一下 and its Hook settings are gone from search', () => {
  for (const query of ['咖啡一下', '启用咖啡一下', '本机 Hook', 'Codex Hook', '通知偏好', '审批超时', '在场检测']) assert.deepEqual(findEntries(entries, query), []);
  assert.ok(!findEntries(entries, '').some(entry => entry.title === '咖啡一下'));
});

test('usage sharing has one global result even without a group binding', () => {
  for (const state of [snapshot, {...snapshot, memberships: [], groups: []}]) {
    const matches = searchEntries(state).filter(entry => entry.title === '分享 Codex 用量');
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.destination.page, 'usage');
    assert.equal(matches[0]?.destination.section, '分享 Codex 用量');
    assert.equal(matches[0]?.destination.selection, undefined);
    assert.equal(findEntries(searchEntries(state), '分享 Codex 用量')[0]?.id, 'usage-share');
  }
});

test('diagnostics search points to disclosures that can open for log and Bot details', () => {
  for (const query of ['daemon 版本', '重新检查', '最近读取']) {
    const overview = findEntries(entries, query).find(entry => entry.destination.page === 'diagnostics');
    assert.equal(overview?.destination.section, '诊断概况', query);
  }
  const directory = findEntries(entries, '数据目录').find(entry => entry.destination.page === 'diagnostics');
  assert.equal(directory?.destination.section, '这台电脑');
  const log = findEntries(entries, '后台日志').find(entry => entry.destination.section === 'daemon 日志');
  assert.equal(log?.destination.page, 'diagnostics');
  assert.equal(log?.destination.field, '后台日志');
  assert.equal(settingAnchor(log!.destination.section!), settingAnchor('daemon 日志'));
  const bot = findEntries(entries, '没回的消息').find(entry => entry.id === `${agentId}-diagnostics`);
  assert.deepEqual(bot?.destination, {page: 'diagnostics', section: diagnosticsSection(agentId)});
});

test('results are complete, ranked, uniquely identified, and have valid destinations', () => {
  const many: DesktopSnapshot = {...snapshot, agents: Array.from({length: 70}, (_, index) => ({...snapshot.agents[0]!, id: agentIdSchema.parse(`cli_search${index}`), name: `Agent ${index}`}))};
  const catalog = searchEntries(many);
  const matches = findEntries(catalog, '最大并发任务');
  assert.equal(matches.length, 70);
  assert.equal(matches[0]?.title, '同时处理的任务');
  assert.equal(new Set(catalog.map(entry => entry.id)).size, catalog.length);
  assert.ok(catalog.every(entry => !entry.destination.section || settingAnchor(entry.destination.section).startsWith('setting-')));
  assert.equal(findEntries(entries, '')[0]?.id, 'agents');
  for (const query of ['此刻', '首页', '概览']) {
    const home = findEntries(entries, query)[0];
    assert.equal(home?.title, '此刻', query);
    assert.equal(home?.destination.page, 'home', query);
  }
});

test('conditional settings lead to existing parent controls', () => {
  const threshold = findEntries(entries, '长任务阈值')[0];
  assert.equal(threshold?.destination.section, '消息与提醒');
  assert.equal(threshold?.destination.field, '完成提醒');
  assert.equal(threshold?.destination.detail?.kind, 'membership-settings');
  assert.match(threshold?.destination.guide ?? '', /长任务/);
  assert.equal(groupTabForSection(threshold?.destination.section), 'response');
});

test('Provider searches open Provider details while Feishu CLI stays in tools', () => {
  for (const [query, section, reveal, page] of [
    ['安装位置 Codex', 'Codex', 'codex', 'providers'],
    ['安装位置 Claude', 'Claude', 'claude', 'providers'],
    ['安装位置 飞书 CLI', '飞书 CLI', 'lark-tool', 'environment'],
  ]) {
    const result = findEntries(entries, query!)[0];
    assert.equal(result?.destination.section, section);
    assert.equal(result?.destination.page, page);
    assert.equal(result?.destination.field, page === 'providers' ? '' : '安装位置');
    assert.equal(result?.destination.reveal, reveal);
    assert.equal(result?.destination.guide, page === 'providers' ? '在 Provider 详情查看状态和可用操作。' : undefined);
  }
  assert.equal(findEntries(entries, 'Claude Agent SDK')[0]?.destination.page, 'providers');
});

test('Codex executable path editing searches open the application control', () => {
  for (const [query, field] of [
    ['Codex 可执行文件', ''],
    ['已保存路径', '已保存路径'],
    ['当前路径配置', '当前路径配置'],
    ['选择 Codex 可执行文件', '本次所选'],
    ['保存路径', '本次所选'],
    ['恢复自动检测', '恢复自动检测'],
    ['未绑定工作目录时的运行后备', '未绑定工作目录时的运行后备'],
  ]) {
    const destination = findEntries(entries, query!)[0]?.destination;
    assert.equal(destination?.page, 'application', query);
    assert.equal(destination?.section, 'Codex 可执行文件', query);
    assert.equal(destination?.field, field, query);
  }
  assert.equal(findEntries(entries, '安装位置 Codex')[0]?.destination.page, 'providers');
});

test('adding a Bot and the legacy registration wording still find the Bot list', () => {
  assert.equal(findEntries(entries, '添加 Bot')[0]?.id, 'agents');
  assert.equal(findEntries(entries, '注册 Bot')[0]?.id, 'agents');
  const empty = searchEntries({...snapshot, agents: [], memberships: []});
  assert.ok(!JSON.stringify(empty).includes('添加 Bot。'));
  const grant = findEntries(entries, '飞书权限')[0];
  assert.equal(grant?.destination.section, '连接与权限');
  assert.equal(grant?.destination.field, '飞书权限');
  assert.equal(findEntries(entries, '一键开权限').some(entry => entry.title === '飞书权限'), true);
  assert.equal(findEntries(entries, '重新扫码')[0]?.title, '刷新飞书凭据');
});

test('words the 叫法表 retired still find the renamed fields', () => {
  assert.equal(findEntries(entries, '待处理消息策略')[0]?.title, '运行中来了消息');
  assert.equal(findEntries(entries, 'Host 状态')[0]?.title, '后端状态 Codex');
  assert.equal(findEntries(entries, 'Host 版本')[0]?.title, '后端版本 Codex');
  assert.equal(findEntries(entries, '当前 Profile')[0]?.title, '当前账号配置 飞书 CLI');
  assert.ok(findEntries(entries, '机器人').some(entry => entry.id === 'agents'));
});

test('判断次数 searches lead to the usage section', () => {
  const result = findEntries(entries, '判断次数')[0];
  assert.equal(result?.destination.page, 'usage');
  assert.equal(result?.destination.section, '智能模式的判断次数');
  assert.equal(result?.destination.field, '');
});

test('smart-only settings are indexed only for smart groups, alongside the mode entry', () => {
  const smart = searchEntries({...snapshot, memberships: [{...snapshot.memberships[0]!, conversation: 'smart'}]});
  const judge = findEntries(smart, '判断模型')[0];
  assert.equal(judge?.destination.detail?.kind, 'membership-settings');
  assert.equal(judge?.destination.section, '决策模型');
  assert.equal(groupTabForSection(judge?.destination.section), 'response');
  assert.equal(findEntries(entries, '判断模型').length, 0);
  assert.equal(findEntries(entries, '智能模式').find(entry => entry.title === '聊天方式')?.destination.section, '聊天方式');
  assert.ok(findEntries(entries, '插话').some(entry => entry.destination.detail?.kind === 'membership-settings' && entry.destination.section === '运行中来了消息'));
  assert.equal(findEntries(smart, '免 @').length, 0);
  const custom = findEntries(smart, '判断的手填模型 id')[0];
  assert.equal(custom?.title, '自定义决策模型 ID');
  assert.equal(custom?.destination.section, '决策模型');
  assert.match(custom?.destination.guide ?? '', /自定义模型 ID/);
});

test('s28c: member picker label and alias navigate to the bound group response-member row', () => {
  for (const query of ['从群成员选择', '选择响应成员']) {
    const result = findEntries(entries, query)[0];
    assert.equal(result?.title, '从群成员选择');
    assert.deepEqual(result?.destination, {
      page: 'collaboration', view: 'groups', selection: {kind: 'membership', id: membershipId},
      detail: {kind: 'membership-settings'}, section: '响应成员', field: '从群成员选择',
      reveal: undefined, guide: undefined,
    });
  }
});

test('s28c: the manual Open ID entry remains searchable alongside the picker', () => {
  for (const query of ['添加成员 Open ID', '成员 Open ID']) {
    const result = findEntries(entries, query)[0];
    assert.equal(result?.title, '添加成员 Open ID');
    assert.equal(result?.destination.section, '响应成员');
    assert.equal(result?.destination.field, '添加成员 Open ID');
    assert.deepEqual(result?.destination.selection, {kind: 'membership', id: membershipId});
    assert.deepEqual(result?.destination.detail, {kind: 'membership-settings'});
  }
});


test('each group setting belongs to its visible page or expandable editor, including compact model and permission summaries', () => {
  for (const [query, tab, section] of [
    ['使用技能', 'capabilities', '技能'], ['语音转文字', 'capabilities', '语音'],
    ['补充职责', 'role', '本群角色'], ['本群个性', 'role', '本群角色'],
    ['项目记忆', 'memory', '记忆'],
    ['模型 Provider', 'model', '可用模型'], ['可用 Effort', 'model', '可用模型'],
    ['权限', 'model', '权限'], ['能挡到什么', 'model', '权限'], ['高级设置', 'model', '权限'],
    ['沟通方式', 'response', '聊天方式'], ['回复规则', 'response', '聊天方式'], ['聊天方式', 'response', '聊天方式'], ['显示模型', 'response', '消息与提醒'],
    ['显示工具调用', 'response', '消息与提醒'], ['从群成员选择', 'response', '响应成员'],
  ]) {
    const entry = findEntries(entries, query!).find(item => item.destination.selection?.kind === 'membership');
    assert.equal(entry?.destination.section, section, query);
    assert.equal(groupTabForSection(entry?.destination.section), tab, query);
  }
  const smart = searchEntries({...snapshot, memberships: [{...snapshot.memberships[0]!, conversation: 'smart'}]});
  for (const query of ['什么时候回复', '什么时候创建新话题', '什么时候回应', '什么时候不回应', '消息在群主区时', '消息已经在话题里时']) {
    const entry = findEntries(smart, query)[0];
    assert.equal(entry?.destination.section, '判断规则');
    assert.equal(groupTabForSection(entry?.destination.section), 'response');
  }
});

test('model and permission search targets reach visible compact summaries with their edit entry points', () => {
  for (const query of ['模型 Provider', '允许使用的模型', '可用 Effort']) {
    const entry = findEntries(entries, query).find(item => item.destination.selection?.kind === 'membership');
    assert.equal(entry?.destination.section, '可用模型', query);
    assert.equal(entry?.destination.field, '', query);
    assert.equal(groupTabForSection(entry?.destination.section), 'model', query);
  }
  for (const query of ['权限', '能挡到什么', '自定义权限', '高级设置']) {
    const entry = findEntries(entries, query).find(item => item.destination.selection?.kind === 'membership' && item.destination.field === '修改权限');
    assert.equal(entry?.destination.section, '权限', query);
    assert.equal(entry?.destination.field, '修改权限', query);
    assert.equal(groupTabForSection(entry?.destination.section), 'model', query);
  }
});

test('P6: the workspace is the project\'s: its settings open the project page, not a group', () => {
  for (const query of ['主目录', '代码仓库']) {
    const entry = findEntries(entries, query).find(item => item.destination.selection?.kind === 'project');
    assert.deepEqual(entry?.destination.selection, {kind: 'project', id: projectId}, query);
    assert.equal(entry?.destination.section, '工作区');
    assert.equal(routeFromSearch(entry!.destination, snapshot)?.route.kind, 'project');
    assert.deepEqual(routeFromSearch(entry!.destination, snapshot)?.route, {kind: 'project', id: projectId, pane: {kind: 'workspace'}});
  }
  // no group-level entry for it any more
  assert.ok(!entries.some(entry => entry.destination.selection?.kind === 'membership' && entry.destination.section === '工作区'));
  for (const section of ['权限', '能挡到什么', '高级设置', '工作目录权限']) assert.equal(groupTabForSection(section), 'model', section);
  assert.equal(groupTabForSection('个性与记忆'), 'capabilities');
});

test('P6: the project is a search target by its name and by its groups', () => {
  for (const query of ['研发项目组', '研发群']) {
    const entry = findEntries(entries, query).find(item => item.id === projectId);
    assert.equal(entry?.context, '项目', query);
    assert.deepEqual(entry?.destination, {page: 'collaboration', view: 'projects', selection: {kind: 'project', id: projectId}});
  }
  // Every group remains its own search target, even when projects are available.
  const unlinked = searchEntries({...snapshot, projects: [], memberships: [{...snapshot.memberships[0]!, projectId: undefined}]});
  assert.deepEqual(findEntries(unlinked, '研发群').find(item => item.id === groupId)?.destination.selection, {kind: 'group', id: groupId});
  assert.deepEqual(findEntries(entries, '研发群').find(item => item.id === groupId)?.destination.selection, {kind: 'group', id: groupId});
  assert.equal(findEntries(entries, '').find(item => item.id === 'groups')?.title, '群组');
  assert.equal(findEntries(entries, '项目管理')[0]?.destination.view, 'projects');
});

test('Bot profile has its own route and former Bot-only group settings no longer point there', () => {
  for (const field of ['Bot 个性', 'Bot 记忆']) {
    const result = findEntries(entries, field)[0];
    assert.equal(result?.destination.reveal, 'agent-profile');
    assert.deepEqual(result?.destination.selection, {kind: 'agent', id: agentId});
    assert.equal(result?.destination.field, field);
  }
  for (const label of ['显示工具调用', '显示模型', '完成提醒', '运行中来了消息']) {
    const matches = entries.filter(entry => entry.title === label);
    assert.ok(matches.length > 0);
    assert.ok(matches.every(entry => entry.destination.selection?.kind === 'membership'), label);
  }
  for (const oldSection of ['任务卡片', '完成提醒', '运行策略', '工作区的默认位置', '群绑定', '新会话默认模型', '话题模型', '判断模型']) {
    assert.ok(!entries.some(entry => entry.destination.section === oldSection), oldSection);
  }
  assert.equal(findEntries(entries, '本话题模型').length, 0);
});

test('history actions explicitly reveal the contextual history panel and preserve their target', () => {
  for (const removed of ['自主任务目标']) assert.equal(findEntries(entries, removed).length, 0);
  for (const query of ['历史会话', '搜索历史会话', '恢复会话', '清空会话', '压缩上下文']) {
    const result = findEntries(entries, query)[0];
    assert.equal(result?.destination.reveal, 'group-history', query);
    assert.equal(result?.destination.section, '会话管理', query);
    assert.deepEqual(result?.destination.selection, {kind: 'membership', id: membershipId});
  }
});

test('MCP search stays in central tool management', () => {
  for (const query of ['MCP', '添加 MCP', 'MCP 授权', '移除 MCP']) {
    const result = findEntries(entries, query)[0];
    assert.equal(result?.destination.page, 'environment');
    assert.equal(result?.destination.section, 'MCP');
    assert.equal(result?.destination.selection, undefined);
  }
});


test('project memory search opens the group memory tab directly', () => {
  const entry = findEntries(entries, '项目记忆')[0]!;
  assert.deepEqual(entry.destination.selection, {kind: 'membership', id: membershipId});
  assert.equal(entry.destination.view, 'groups');
  assert.equal(groupTabForSection(entry.destination.section), 'memory');
  assert.equal(findEntries(entries, '模型看到什么').length, 0);
});

test('Bot title and comment model search targets the unified model pickers', () => {
  for (const [title, section, field] of [
    ['标题模型', '新会话标题', ''],
    ['评论模型', '云文档评论', '选择评论模型'],
  ]) {
    const entry = entries.find(item => item.title === title && item.destination.selection?.kind === 'agent');
    assert.equal(entry?.destination.section, section);
    assert.equal(entry?.destination.field, field);
  }
  assert.ok(findEntries(entries, '评论后端').some(entry => entry.title === '评论模型'));
});

test('decision service searches keep their own key and connection destinations', () => {
  for (const [provider, query] of [['openrouter', 'OpenRouter 密钥'], ['vercel', 'Vercel 密钥'], ['custom', '自定义 Jev 密钥']] as const) {
    const match = findEntries(entries, query)[0];
    assert.equal(match?.destination.page, 'secrets');
    assert.equal(match?.destination.section, decisionKeySection(provider));
    assert.equal(match?.destination.field, 'API 密钥');
  }
  assert.equal(findEntries(entries, '自定义决策请求地址')[0]?.destination.field, '接口地址');
  assert.equal(findEntries(entries, '自定义接口模型 ID')[0]?.destination.field, '模型 ID');
  assert.equal(decisionProviderSection('unknown'), 'Provider 配置');
});

test('任务 opens the group 任务 tab, and a task the Bot answered with is found by name on its row', () => {
  const tab = findEntries(entries, '定时任务').find(entry => entry.destination.selection?.kind === 'membership');
  assert.equal(tab?.destination.section, '任务');
  assert.equal(groupTabForSection(tab?.destination.section), 'schedule');
  const withTasks = searchEntries(snapshot, {schedules: [
    scheduleTask({botId: agentId, chatId: groupId, name: '每日站会提醒'}), scheduleTask({id: 'st_elsewhere', botId: agentId, chatId: 'oc_elsewhere', name: '别处的提醒'}),
  ]});
  assert.deepEqual(findEntries(withTasks, '站会').map(entry => [entry.title, entry.destination.selection, entry.destination.detail, entry.destination.section, entry.destination.field]),
    [['每日站会提醒', {kind: 'membership', id: membershipId}, {kind: 'membership-settings'}, '任务', '每日站会提醒']]);
  assert.deepEqual(findEntries(withTasks, '别处的提醒'), []);
});

test('devices-ui-1b: the devices page is found on the desktop only', () => {
  const desktop = searchEntries(snapshot, {devices: true}).find(entry => entry.id === 'devices');
  assert.deepEqual(desktop?.destination, {page: 'devices', view: undefined, selection: undefined});
  assert.ok(findEntries(searchEntries(snapshot, {devices: true}), 'Tailscale').some(entry => entry.id === 'devices'));
  assert.equal(searchEntries(snapshot).some(entry => entry.id === 'devices'), false);
});

// devices-ui-3: 允许别的设备连接 and its paired devices are found on 应用与启动. main 必败
test('finds 允许别的设备连接 and the paired devices on 应用与启动', () => {
  const link = findEntries(entries, '连接链接').find(entry => entry.destination.section === '允许别的设备连接');
  assert.deepEqual(link?.destination, {page: 'application', section: '允许别的设备连接', field: '连接链接', reveal: undefined, guide: undefined});
  assert.equal(findEntries(entries, '撤销')[0]?.destination.section, '已配对的设备');
  assert.equal(findEntries(entries, '设备名字')[0]?.destination.section, '允许别的设备连接');
});
