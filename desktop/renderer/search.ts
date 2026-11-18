import {toolNames} from './management/environmentPresentation';
import type {AgentId, DesktopSnapshot, GroupId, MembershipId} from '../shared/bridge';
import type {CollaborationView, Page} from './collaboration-model';

export type Selection = {kind: 'overview'} | {kind: 'agent'; id: AgentId} | {kind: 'group'; id: GroupId} | {kind: 'membership'; id: MembershipId};
export const agentCategories = [
  {id: 'general', label: '常规', description: '身份、启用状态与默认目录'},
  {id: 'interaction', label: '交互与通知', description: '任务卡片、提醒与飞书内容'},
  {id: 'access', label: '权限', description: '管理员与允许的飞书群'},
] as const;
export const membershipCategories = [
  {id: 'binding', label: '绑定', description: '工作目录、会话方式与项目状态'},
  {id: 'behavior', label: '行为', description: '群内响应、模型与会话'},
  {id: 'access', label: '权限', description: '成员与工作目录权限'},
] as const;
export type AgentCategory = typeof agentCategories[number]['id'];
export type MembershipCategory = typeof membershipCategories[number]['id'];
export type DetailPane = {kind: 'overview'} | {kind: 'agent-settings'; category: AgentCategory} | {kind: 'membership-settings'; category: MembershipCategory};
export type SearchReveal = 'cli-advanced' | 'machine-advanced' | 'codex-tool' | 'claude-tool' | 'lark-tool' | 'profile-manager' | 'profile-add' | 'profile-create';
export type Destination = {page: Page; view?: CollaborationView; selection?: Selection; detail?: DetailPane; section?: string; field?: string; reveal?: SearchReveal; guide?: string};
export type SearchEntry = {id: string; title: string; context: string; aliases: readonly string[]; destination: Destination; kind: 'page' | 'setting' | 'action' | 'item'};
export const settingAnchor = (title: string) => `setting-${encodeURIComponent(title)}`;

type Target = {title: string; aliases?: readonly string[]; reveal?: SearchReveal; guide?: string; field?: string};
type Group<Category extends string> = {title: string; category: Category; fields: readonly Target[]};
const item = (title: string, aliases: readonly string[] = [], options: Omit<Target, 'title' | 'aliases'> = {}): Target => ({title, aliases, ...options});
const agentGroups: readonly Group<AgentCategory>[] = [
  {title: 'Agent 身份', category: 'general', fields: [item('应用 ID', ['App ID']), item('启用 Agent', ['停用 Agent']), item('刷新飞书凭据', ['重新授权']), item('飞书权限与连接', ['检查连接'])]},
  {title: '任务卡片', category: 'interaction', fields: [item('显示工具调用'), item('显示模型')]},
  {title: '运行策略', category: 'interaction', fields: [item('最大并发任务'), item('当前运行并发'), item('空闲超时（秒，0 为关闭）', ['空闲超时']), item('运行中收到新消息', ['待处理消息策略', 'steer', 'queue'])]},
  {title: '任务结束提醒', category: 'interaction', fields: [item('提醒方式'), item('长任务阈值（分钟）', ['长任务阈值'], {guide: '先将提醒方式设为「长任务」，即可调整阈值。'})]},
  {title: '语音转文字', category: 'interaction', fields: [item('启用语音', ['语音识别']), item('权限与测试'), item('重新检测'), item('测试语音', [], {field: '测试'})]},
  {title: '云文档评论', category: 'interaction', fields: [item('执行工具'), item('模型'), item('推理强度', [], {guide: '先选择一个具体模型，再调整推理强度。'})]},
  {title: '评论回复规则', category: 'interaction', fields: [item('评论规则文本', ['提示词', 'instructions'], {field: '评论回复规则'}), item('保存规则', ['保存评论规则']), item('恢复默认', ['恢复默认评论规则'])]},
  {title: '新会话标题', category: 'interaction', fields: [item('执行工具', ['标题执行工具']), item('用模型生成标题'), item('自定义模型 ID', ['标题模型 ID'], {guide: '先打开「用模型生成标题」，即可设置模型 ID。'}), item('推理强度', ['标题推理强度'], {guide: '先打开「用模型生成标题」，即可设置推理强度。'})]},
  {title: '管理员', category: 'access', fields: [item('所有者'), item('添加管理员 Open ID'), item('移除管理员', [], {field: '', guide: '在管理员列表中找到要移除的成员。'})]},
  {title: '新项目默认目录', category: 'general', fields: [item('根目录', ['新项目根目录', '文件夹'])]},
  {title: '允许的飞书群', category: 'access', fields: [item('群范围'), item('添加群 ID'), item('移除群 ID', [], {field: '', guide: '在允许的飞书群列表中找到要移除的群。'})]},
  {title: '移除 Agent', category: 'access', fields: [item('删除本地 Agent 数据', ['删除机器人'])]},
];
const membershipGroups: readonly Group<MembershipCategory>[] = [
  {title: '群绑定', category: 'binding', fields: [item('飞书群'), item('工作目录', ['更换目录']), item('会话方式'), item('项目状态')]},
  {title: '解除项目绑定', category: 'binding', fields: [item('解除绑定')]},
  {title: '群内响应', category: 'behavior', fields: [item('不 @ 也能发起任务', ['免 @'])]},
  {title: '工作目录权限', category: 'access', fields: [item('管理员权限'), item('普通成员权限'), item('允许网络访问')]},
  {title: '会话压缩', category: 'behavior', fields: [item('自动压缩上下文')]},
  {title: '新会话默认模型', category: 'behavior', fields: [item('模型'), item('推理强度', [], {guide: '先选择一个具体模型，再调整推理强度。'})]},
  {title: '响应成员', category: 'access', fields: [item('添加成员 Open ID'), item('移除成员', [], {field: '', guide: '在响应成员列表中找到要移除的成员。'}), item('允许所有成员', ['清空白名单'], {guide: '设置了成员白名单后，会显示「清空白名单」。'})]},
  {title: '话题模型', category: 'behavior', fields: [item('选择话题'), item('话题身份', [], {field: '选择话题', guide: '选择话题后可以查看身份。'}), item('本话题模型', [], {field: '选择话题', guide: '先选择话题，再设置该话题的模型。'}), item('推理强度', ['话题推理强度'], {field: '选择话题', guide: '先选择话题并选定具体模型，再调整推理强度。'})]},
];
const globalGroups: readonly {page: Page; section: string; fields: readonly Target[]}[] = [
  {page: 'coffee', section: '咖啡一下', fields: [item('通知 Agent'), item('通知状态'), item('查看通知规则'), item('Hook 配置')]},
  {page: 'coffee', section: '本机 Hook', fields: [item('本机 Hook', [], {field: 'Codex Hook'}), item('Codex Hook', ['修复 Codex Hook']), item('Claude Hook', ['修复 Claude Hook'])]},
  {page: 'coffee', section: '接力设置', fields: [item('接力设置', ['CLI 转发'], {field: '启用咖啡一下', guide: '没有 Agent 时，请先添加 Agent。'}), item('启用咖啡一下', [], {guide: '没有 Agent 时，请先添加 Agent。'})]},
  {page: 'coffee', section: '通知偏好', fields: [item('通知偏好', ['CLI 通知设置'], {field: '通知范围', guide: '没有 Agent 时，请先添加 Agent。'}), ...['通知范围', '转发 Claude', '转发 Codex', '离开时保活'].map(title => item(title, [], {guide: '没有 Agent 时，请先添加 Agent。'})), ...['转发权限审批', '审批超时（秒）', '发送任务完成卡', '允许从完成卡续聊', '续聊等待（秒）', '本会话放行缓存', '在场检测', '在场检测平台', '离开判定（秒）'].map(title => item(title, [], {reveal: 'cli-advanced', guide: '没有 Agent 时，请先添加 Agent。'}))]},
  {page: 'application', section: '启动选项', fields: [item('运行状态'), item('重启 Bridge'), item('登录电脑时启动', ['开机启动'])]},
  {page: 'application', section: '命令行工具', fields: [item('vonvon-bot', ['CLI', '修复命令行工具'])]},
  {page: 'application', section: 'Bridge 运行', fields: [item('运行方式'), item('Bridge 服务', ['启动 Bridge', '停止 Bridge']), item('临时运行 Agent', [], {guide: '仅运行指定 Agent 时显示当前临时运行状态。'})]},
  {page: 'application', section: '后台服务', fields: [item('系统服务'), item('安装并启动', ['安装并启动后台服务']), item('服务运行', ['启动已安装服务', '停止后台服务并关闭自启']), item('卸载后台服务'), item('仅运行指定 Agent', [], {reveal: 'machine-advanced'}), ...['进程 PID', '上次退出码', '服务定义', '标准输出', '错误日志'].map(title => item(title, [], {reveal: 'machine-advanced'}))]},
  {page: 'application', section: '软件更新', fields: [item('桌面版'), item('更新状态'), item('可用版本'), item('检查更新', ['检查桌面更新']), item('下载更新', [], {guide: '有可用更新时显示下载操作。'}), item('安装更新', [], {guide: '下载完成后显示安装操作。'}), item('发布说明')]},
  {page: 'application', section: '外部 Core / CLI', fields: [item('Core 来源'), item('当前版本'), item('可用版本'), item('检查 Core 更新'), item('更新外部 Core'), item('更新进度', ['查看 Core 更新进度'])]},
  {page: 'application', section: 'Codex 可执行文件', fields: [item('已保存路径'), item('当前路径配置'), item('本次所选'), item('选择文件'), item('保存路径'), item('恢复自动检测'), item('未绑定工作目录时的运行后备')]},
  {page: 'application', section: '窗口与退出', fields: [item('隐藏到托盘'), item('退出 Vonvon Bot', ['退出应用'])]},
  {page: 'environment', section: '本机环境', fields: [item('重新检测'), ...['安装执行后端', '检查后端版本', '更新执行后端', '卸载执行后端'].map(title => item(title, ['Claude Agent SDK', '托管后端'], {field: '', guide: '在本机环境的执行后端条目中操作；可用按钮取决于已安装状态。'}))]},
  ...(['Codex', 'Claude', '飞书 CLI'] as const).map((section, index) => ({page: 'environment' as const, section: toolNames[(['codex', 'claude', 'lark-cli'] as const)[index]!], fields: ['安装', '更新', '登录', '检查授权', '重新登录', '安装托管副本', '重新安装最新版', '停用托管副本', '安装来源', '安装位置', '当前版本', '托管版本', '最新版本', '授权状态', ...(section === 'Codex' ? ['Host 状态', 'Host 版本'] : []), ...(section === '飞书 CLI' ? ['当前 Profile'] : [])].map(title => item(`${title} ${section}`, [title], {field: title, reveal: (['codex-tool', 'claude-tool', 'lark-tool'] as const)[index], guide: ['安装来源', '安装位置', '当前版本', '托管版本', '最新版本', '授权状态', 'Host 状态', 'Host 版本', '当前 Profile'].includes(title) ? undefined : '此操作是否可用取决于本机工具的安装与授权状态。'}))})),
  {page: 'environment', section: '飞书 Profile', fields: [item('管理飞书 CLI', ['管理 Profile', '切换 Profile'], {reveal: 'profile-manager'}), item('添加已有应用', ['添加 Profile'], {reveal: 'profile-add'}), item('创建新应用', ['创建 Profile'], {reveal: 'profile-create'}), ...['Profile 名称', 'App ID', 'App Secret', '平台', '添加后设为当前'].map(title => item(title, ['飞书应用'], {reveal: 'profile-add'})), item('设为当前', ['切换飞书 Profile'], {reveal: 'profile-manager'})]},
  {page: 'diagnostics', section: '当前状态', fields: [item('Bridge 版本'), item('已注册 Agent'), item('已连接飞书群'), item('最近读取'), item('数据目录')]},
  {page: 'diagnostics', section: '诊断操作', fields: [item('重新检查'), item('打开事件设置', [], {guide: '出现飞书事件配置诊断时，可打开对应设置。'})]},
  {page: 'diagnostics', section: 'Bridge 日志', fields: [item('刷新日志'), item('持续跟随'), item('Bridge 日志')]},
];
function expand<Category extends string>(id: string, context: string, base: Destination, groups: readonly Group<Category>[], pane: (category: Category) => DetailPane): SearchEntry[] {
  return groups.flatMap(group => {
    const destination = {...base, detail: pane(group.category), section: group.title};
    return [
      {id: `${id}-${group.title}`, title: group.title, context, aliases: [], destination, kind: 'setting' as const},
      ...group.fields.map((field, index) => ({id: `${id}-${group.title}-${index}`, title: field.title, context: `${context} · ${group.title}`, aliases: field.aliases ?? [], destination: {...destination, field: field.field ?? field.title, reveal: field.reveal, guide: field.guide}, kind: 'setting' as const})),
    ];
  });
}
export function searchEntries(snapshot: DesktopSnapshot): SearchEntry[] {
  const pages: readonly {id: string; title: string; aliases: readonly string[]; page: Page; view?: CollaborationView}[] = [
    {id: 'agents', title: 'Agent', aliases: ['机器人', '准备执行工具', '注册 Agent', '加入飞书群并设置工作目录'], page: 'collaboration', view: 'agents'},
    {id: 'groups', title: '群聊', aliases: ['飞书群', '项目', '已连接飞书群'], page: 'collaboration', view: 'groups'},
    {id: 'usage', title: 'Codex 用量', aliases: ['账号', '套餐', '限额', '活动', '热力图'], page: 'usage'},
    {id: 'coffee', title: '咖啡一下', aliases: ['Hook', '通知', '离开电脑'], page: 'coffee'},
    {id: 'environment', title: '本机环境', aliases: ['工具', '安装', '授权'], page: 'environment'},
    {id: 'application', title: '应用与启动', aliases: ['版本', '更新', '后台服务'], page: 'application'},
    {id: 'diagnostics', title: '状态与诊断', aliases: ['日志', '数据目录', '连接'], page: 'diagnostics'},
  ];
  const entries: SearchEntry[] = pages.map(page => ({id: page.id, title: page.title, context: '页面', aliases: page.aliases, destination: {page: page.page, view: page.view, selection: page.view ? {kind: 'overview'} : undefined}, kind: 'page'}));
  for (const group of globalGroups) group.fields.forEach((field, index) => entries.push({
    id: `global-${group.page}-${group.section}-${index}`, title: field.title, context: ['本机 Hook', '接力设置', '通知偏好'].includes(group.section) ? `咖啡一下 · ${group.section}` : group.section, aliases: field.aliases ?? [], destination: {page: group.page, section: group.section, field: field.field ?? field.title, reveal: field.reveal, guide: group.page === 'coffee' && snapshot.agents.length > 0 ? undefined : field.guide}, kind: 'setting',
  }));
  for (const agent of snapshot.agents) {
    const base: Destination = {page: 'collaboration', view: 'agents', selection: {kind: 'agent', id: agent.id}};
    entries.push({id: agent.id, title: agent.name, context: 'Agent', aliases: [agent.id], destination: base, kind: 'item'});
    entries.push(...agentCategories.map(category => ({id: `${agent.id}-category-${category.id}`, title: category.id === 'access' ? 'Agent 权限' : `Agent 设置 · ${category.label}`, context: `Agent 设置 · ${agent.name}`, aliases: [category.label], destination: {...base, detail: {kind: 'agent-settings' as const, category: category.id}}, kind: 'setting' as const})));
    entries.push(...expand(agent.id, `Agent 设置 · ${agent.name}`, base, agentGroups, category => ({kind: 'agent-settings', category})));
  }
  for (const group of snapshot.groups) entries.push({id: group.id, title: group.name, context: '飞书群', aliases: [group.id], destination: {page: 'collaboration', view: 'groups', selection: {kind: 'group', id: group.id}}, kind: 'item'});
  const agents = new Map(snapshot.agents.map(agent => [agent.id, agent]));
  const groups = new Map(snapshot.groups.map(group => [group.id, group]));
  for (const member of snapshot.memberships) {
    const context = `群内设置 · ${groups.get(member.groupId)?.name ?? member.name} · ${agents.get(member.agentId)?.name ?? member.agentId} · 本地绑定 ${member.name} · ${member.directory}`;
    const base: Destination = {page: 'collaboration', view: 'groups', selection: {kind: 'membership', id: member.id}};
    entries.push({id: member.id, title: member.name, context, aliases: [member.directory, member.backend], destination: base, kind: 'item'});
    entries.push(...membershipCategories.map(category => ({id: `${member.id}-category-${category.id}`, title: category.id === 'access' ? '群内权限' : `群内设置 · ${category.label}`, context, aliases: [category.label], destination: {...base, detail: {kind: 'membership-settings' as const, category: category.id}}, kind: 'setting' as const})));
    entries.push(...expand(member.id, context, base, membershipGroups, category => ({kind: 'membership-settings', category})));
    ['搜索历史会话', '筛选历史会话', '恢复会话', '当前会话上下文', '刷新上下文', '清空会话', '压缩上下文', '自主任务目标', '停止当前任务', '结束目标', '完成时提醒'].forEach((title, index) => entries.push({id: `${member.id}-session-${index}`, title, context: `${context} · 当前会话`, aliases: ({'搜索历史会话': ['搜索'], '筛选历史会话': ['筛选'], '当前会话上下文': ['会话', '上下文'], '清空会话': ['会话操作'], '完成时提醒': ['正在运行']} as Record<string, string[]>)[title] ?? [], destination: {...base, section: '会话管理', field: ({'搜索历史会话': '搜索', '筛选历史会话': '筛选', '当前会话上下文': '上下文', '清空会话': '会话操作', '压缩上下文': '会话操作', '停止当前任务': '正在运行', '结束目标': '正在运行'} as Record<string, string>)[title] ?? title, guide: '进入「会话与状态」中的「会话管理」，选择会话后可执行此操作。'}, kind: 'action'}));
    entries.push({id: `${member.id}-connection`, title: 'Agent 连接', context, aliases: [], destination: base, kind: 'item'});
    entries.push({id: `${member.id}-share-usage`, title: '分享 Codex 用量', context, aliases: [], destination: base, kind: 'action'});
  }
  return entries;
}
export function findEntries(entries: readonly SearchEntry[], query: string): SearchEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return ['agents', 'groups', 'usage', 'coffee', 'environment', 'application', 'diagnostics'].flatMap(id => entries.find(entry => entry.id === id) ?? []);
  const rank = (entry: SearchEntry) => {
    const title = entry.title.toLocaleLowerCase();
    const needle = terms.join(' ');
    if (title === needle) return 0;
    if (title.startsWith(needle)) return 1;
    if (terms.every(term => title.includes(term))) return 2;
    if (terms.every(term => entry.aliases.some(alias => alias.toLocaleLowerCase().includes(term)))) return 3;
    return 4;
  };
  return entries.filter(entry => {
    const corpus = [entry.title, entry.context, ...entry.aliases].join(' ').toLocaleLowerCase();
    return terms.every(term => corpus.includes(term));
  }).sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title, 'zh-Hans') || a.context.localeCompare(b.context, 'zh-Hans') || a.id.localeCompare(b.id));
}
