import {toolNames} from './management/environmentPresentation';
import type {AgentId, DesktopSnapshot, GroupId, MembershipId} from '@vonvon/protocol';
import type {CollaborationView, Page} from './collaboration-model';

export type Selection = {kind: 'overview'} | {kind: 'agent'; id: AgentId} | {kind: 'group'; id: GroupId} | {kind: 'membership'; id: MembershipId};
export type DetailPane = {kind: 'overview'} | {kind: 'agent-settings'} | {kind: 'membership-settings'};
export type SearchReveal = 'machine-advanced' | 'codex-tool' | 'claude-tool' | 'lark-tool' | 'profile-manager' | 'profile-add' | 'profile-create';
export type Destination = {page: Page; view?: CollaborationView; selection?: Selection; detail?: DetailPane; section?: string; field?: string; reveal?: SearchReveal; guide?: string};
export type SearchEntry = {id: string; title: string; context: string; aliases: readonly string[]; destination: Destination; kind: 'page' | 'setting' | 'action' | 'item'};
export const settingAnchor = (title: string) => `setting-${encodeURIComponent(title)}`;
/** One bot's section on the 状态与诊断 page. */
export const diagnosticsSection = (agentId: string) => `Bot 状态 ${agentId}`;

type Target = {title: string; aliases?: readonly string[]; reveal?: SearchReveal; guide?: string; field?: string};
type Group = {title: string; fields: readonly Target[]};
type AgentGroup = {title: string; aliases?: readonly string[]; fields: readonly Target[]};
const item = (title: string, aliases: readonly string[] = [], options: Omit<Target, 'title' | 'aliases'> = {}): Target => ({title, aliases, ...options});
const agentGroups: readonly AgentGroup[] = [
  {title: 'Bot 身份', fields: [item('启用 Bot', ['停用 Bot'])]},
  {title: '连接与权限', fields: [item('应用 ID', ['App ID']), item('首次运行清单', ['开权限', '事件订阅', '发布版本']), item('飞书权限', ['一键开权限']), item('刷新飞书凭据', ['重新扫码', '重新授权']), item('状态与诊断', ['检查连接', '没回的消息'])]},
  {title: '任务卡片', aliases: ['飞书任务卡片', '卡片显示'], fields: [item('显示工具调用'), item('显示模型')]},
  {title: '运行策略', aliases: ['任务行为与提醒'], fields: [item('最大并发任务'), item('当前运行并发'), item('空闲超时（秒，0 为关闭）', ['空闲超时']), item('运行中来了消息', ['运行中收到新消息', '待处理消息策略', '插话', '排队', 'steer', 'queue'])]},
  {title: '完成提醒', aliases: ['任务结束提醒'], fields: [item('什么时候提醒', ['提醒方式']), item('长任务阈值（分钟）', ['长任务阈值'], {guide: '先把「什么时候提醒」设为「长任务」，就能调阈值。'})]},
  {title: '语音转文字', fields: [item('启用语音', ['语音识别']), item('权限与测试'), item('重新检测'), item('测试语音', [], {field: '测试'})]},
  {title: '云文档评论', fields: [item('后端', ['执行工具']), item('模型'), item('推理强度', [], {guide: '先选择一个具体模型，再调整推理强度。'})]},
  {title: '评论回复规则', fields: [item('评论规则文本', ['提示词', 'instructions'], {field: '评论回复规则'}), item('保存规则', ['保存评论规则']), item('恢复默认', ['恢复默认评论规则'])]},
  {title: '新会话标题', aliases: ['会话标题'], fields: [item('后端', ['标题后端', '执行工具']), item('用模型生成标题'), item('自定义模型 ID', ['标题模型 ID'], {guide: '先打开「用模型生成标题」，即可设置模型 ID。'}), item('推理强度', ['标题推理强度'], {guide: '先打开「用模型生成标题」，即可设置推理强度。'})]},
  {title: '管理员', fields: [item('主人', ['所有者']), item('添加管理员 Open ID'), item('移除管理员', [], {field: '', guide: '在管理员列表中找到要移除的成员。'})]},
  {title: '工作区的默认位置', aliases: ['新项目默认目录'], fields: [item('文件夹', ['根目录', '新项目根目录'])]},
  {title: '允许的飞书群', fields: [item('群范围'), item('添加群 ID'), item('移除群 ID', [], {field: '', guide: '在允许的飞书群列表中找到要移除的群。'})]},
  {title: '移除 Bot', fields: [item('删除本地 Bot 数据', ['删除机器人'])]},
];
const membershipGroups: readonly Group[] = [
  {title: '群绑定', fields: [item('飞书群'), item('工作目录', ['更换目录']), item('会话方式'), item('项目状态')]},
  {title: '解除项目绑定', fields: [item('解除绑定')]},
  {title: '群内响应', fields: [item('不 @ 也能发起任务', ['免 @'])]},
  {title: '判断模型', fields: [item('判断模型', ['智能模式', '语言模型', '决策模型', 'Jev', 'TypeSafe'], {guide: '不是智能群的，先把会话方式改成「智能开话题」，才有这一项。'}), item('判断的推理强度', ['推理强度'], {field: '判断模型', guide: '先选一个语言模型。'}), item('判断的手填模型 id', [], {field: '判断模型', guide: '在「判断模型」里选「手填模型 id…」。'})]},
  {title: '运行中来了消息', fields: [item('运行中来了消息', ['插话', '排队', '跟着 Bot 默认'])]},
  {title: '工作目录权限', fields: [item('权限档'), item('允许网络访问')]},
  {title: '新会话默认模型', fields: [item('模型'), item('自定义模型 ID', ['手填模型 ID', '第三方模型'], {field: '模型', guide: '在「模型」里选「自定义模型 ID…」，再填写模型 ID。'}), item('推理强度', [], {guide: '先选择一个具体模型，再调整推理强度。'})]},
  {title: '响应成员', fields: [item('从群成员选择', ['选择响应成员']), item('添加成员 Open ID'), item('移除成员', [], {field: '', guide: '在响应成员列表中找到要移除的成员。'}), item('允许所有成员', ['清空白名单'], {guide: '设置了成员白名单后，会显示「清空白名单」。'})]},
  {title: '话题模型', fields: [item('选择话题'), item('话题身份', [], {field: '选择话题', guide: '选择话题后可以查看身份。'}), item('本话题模型', [], {field: '选择话题', guide: '先选择话题，再设置该话题的模型。'}), item('自定义模型 ID', ['话题手填模型 ID'], {field: '选择话题', guide: '先选择话题，再在「本话题模型」里选「自定义模型 ID…」。'}), item('推理强度', ['话题推理强度'], {field: '选择话题', guide: '先选择话题并选定具体模型，再调整推理强度。'})]},
];
/** What the 本机环境 fields were called before the 叫法表 (docs/v1-plan.md section 5), so the old words still find them. */
const formerly: Readonly<Record<string, string>> = {'后端状态': 'Host 状态', '后端版本': 'Host 版本', '当前账号配置': '当前 Profile'};
const globalGroups: readonly {page: Page; section: string; fields: readonly Target[]}[] = [
  {page: 'usage', section: '智能模式的判断次数', fields: [item('判断次数', ['判断', '按 Bot 看'], {field: ''})]},
  {page: 'application', section: '启动选项', fields: [item('运行状态'), item('重启 daemon'), item('登录电脑时启动', ['开机启动'])]},
  {page: 'application', section: '命令行工具', fields: [item('vonvon', ['CLI', '修复命令行工具'])]},
  {page: 'application', section: 'daemon 运行', fields: [item('运行方式'), item('daemon 服务', ['启动 daemon', '停止 daemon']), item('临时运行 Bot', [], {guide: '仅运行指定 Bot 时显示当前临时运行状态。'})]},
  {page: 'application', section: '后台服务', fields: [item('系统服务'), item('安装并启动', ['安装并启动后台服务']), item('服务运行', ['启动已安装服务', '停止后台服务并关闭自启']), item('卸载后台服务'), item('仅运行指定 Bot', [], {reveal: 'machine-advanced'}), ...['进程 PID', '上次退出', '服务定义', '标准输出', '错误日志'].map(title => item(title, [], {reveal: 'machine-advanced'}))]},
  {page: 'application', section: '软件更新', fields: [item('桌面版'), item('更新状态'), item('可用版本'), item('检查更新', ['检查桌面更新']), item('下载更新', [], {guide: '有可用更新时显示下载操作。'}), item('安装更新', [], {guide: '下载完成后显示安装操作。'}), item('发布说明')]},
  {page: 'application', section: '外部 Core / CLI', fields: [item('Core 来源'), item('当前版本'), item('可用版本'), item('检查 Core 更新'), item('更新外部 Core'), item('更新进度', ['查看 Core 更新进度'])]},
  {page: 'application', section: 'Codex 可执行文件', fields: [item('已保存路径'), item('当前路径配置'), item('本次所选'), item('选择文件'), item('保存路径'), item('恢复自动检测'), item('未绑定工作目录时的运行后备')]},
  {page: 'application', section: '窗口与退出', fields: [item('隐藏到托盘'), item('退出 Vonvon Bot', ['退出应用'])]},
  {page: 'environment', section: '本机环境', fields: [item('重新检测'), ...['安装后端', '检查后端版本', '更新后端', '卸载后端'].map(title => item(title, ['Claude Agent SDK', '托管后端'], {field: '', guide: '在本机环境的后端条目里操作；能用哪些按钮看安装状态。'}))]},
  ...(['Codex', 'Claude', '飞书 CLI'] as const).map((section, index) => ({page: 'environment' as const, section: toolNames[(['codex', 'claude', 'lark-cli'] as const)[index]!], fields: ['安装', '更新', '登录', '检查授权', '重新登录', '安装托管副本', '重新安装最新版', '停用托管副本', '安装来源', '安装位置', '当前版本', '托管版本', '最新版本', '授权状态', ...(section === 'Codex' ? ['后端状态', '后端版本'] : []), ...(section === '飞书 CLI' ? ['当前账号配置'] : [])].map(title => item(`${title} ${section}`, [title, ...(formerly[title] ? [formerly[title]] : [])], {field: title, reveal: (['codex-tool', 'claude-tool', 'lark-tool'] as const)[index], guide: ['安装来源', '安装位置', '当前版本', '托管版本', '最新版本', '授权状态', '后端状态', '后端版本', '当前账号配置'].includes(title) ? undefined : '此操作是否可用取决于本机工具的安装与授权状态。'}))})),
  {page: 'environment', section: '飞书 CLI 账号配置', fields: [item('管理飞书 CLI', ['管理账号配置', '切换账号配置', 'Profile'], {reveal: 'profile-manager'}), item('添加已有应用', ['添加账号配置', '添加 Profile'], {reveal: 'profile-add'}), item('创建新应用', ['创建账号配置', '创建 Profile'], {reveal: 'profile-create'}), ...['账号配置名称', 'App ID', 'App Secret', '平台', '添加后设为当前'].map(title => item(title, ['飞书应用'], {reveal: 'profile-add'})), item('设为当前', ['切换账号配置', '切换飞书 Profile'], {reveal: 'profile-manager'})]},
  {page: 'secrets', section: '决策模型', fields: [item('TypeSafe 的 key', ['填 key', '换 key', '删除 key', '试一次', 'Jev', 'typesafe-api-key']), item('谁在用')]},
  {page: 'diagnostics', section: '这台电脑', fields: [item('daemon 版本'), item('重新检查'), item('决策模型的 key', ['没填 key']), item('最近读取'), item('数据目录')]},
  {page: 'diagnostics', section: 'daemon 日志', fields: [item('刷新日志'), item('持续跟随'), item('daemon 日志')]},
];
function expand(id: string, context: string, base: Destination, groups: readonly Group[], pane: DetailPane): SearchEntry[] {
  return groups.flatMap(group => {
    const destination = {...base, detail: pane, section: group.title};
    return [
      {id: `${id}-${group.title}`, title: group.title, context, aliases: [], destination, kind: 'setting' as const},
      ...group.fields.map((field, index) => ({id: `${id}-${group.title}-${index}`, title: field.title, context: `${context} · ${group.title}`, aliases: field.aliases ?? [], destination: {...destination, field: field.field ?? field.title, reveal: field.reveal, guide: field.guide}, kind: 'setting' as const})),
    ];
  });
}
export function searchEntries(snapshot: DesktopSnapshot): SearchEntry[] {
  const pages: readonly {id: string; title: string; aliases: readonly string[]; page: Page; view?: CollaborationView}[] = [
    {id: 'agents', title: 'Bot', aliases: ['机器人', '注册 Bot', '添加 Bot', '加入飞书群并设置工作目录'], page: 'collaboration', view: 'agents'},
    {id: 'setup', title: '首次运行清单', aliases: ['后端', '准备执行工具', '扫码', '开权限', '一键开权限', '事件订阅', '卡片回调', '发布版本', '长连接'], page: 'setup'},
    {id: 'groups', title: '群聊', aliases: ['飞书群', '项目', '已连接飞书群'], page: 'collaboration', view: 'groups'},
    {id: 'usage', title: 'Codex 用量', aliases: ['账号', '套餐', '限额', '活动', '热力图', '判断次数', '智能模式'], page: 'usage'},
    {id: 'environment', title: '本机环境', aliases: ['工具', '安装', '授权'], page: 'environment'},
    {id: 'application', title: '应用与启动', aliases: ['版本', '更新', '后台服务'], page: 'application'},
    {id: 'secrets', title: '密钥', aliases: ['key', 'API key', 'TypeSafe', 'Jev', '决策模型'], page: 'secrets'},
    {id: 'diagnostics', title: '状态与诊断', aliases: ['日志', '数据目录', '连接', '没回的消息', '缺的权限'], page: 'diagnostics'},
  ];
  const entries: SearchEntry[] = pages.map(page => ({id: page.id, title: page.title, context: '页面', aliases: page.aliases, destination: {page: page.page, view: page.view, selection: page.view ? {kind: 'overview'} : undefined}, kind: 'page'}));
  for (const group of globalGroups) group.fields.forEach((field, index) => entries.push({
    id: `global-${group.page}-${group.section}-${index}`, title: field.title, context: group.section, aliases: field.aliases ?? [], destination: {page: group.page, section: group.section, field: field.field ?? field.title, reveal: field.reveal, guide: field.guide}, kind: 'setting',
  }));
  for (const agent of snapshot.agents) {
    const base: Destination = {page: 'collaboration', view: 'agents', selection: {kind: 'agent', id: agent.id}};
    entries.push({id: agent.id, title: agent.name, context: 'Bot', aliases: [agent.id], destination: base, kind: 'item'});
    entries.push({id: `${agent.id}-settings`, title: 'Bot 设置', context: agent.name, aliases: ['机器人设置', 'Bot 权限'], destination: {...base, detail: {kind: 'agent-settings'}}, kind: 'setting'});
    entries.push({id: `${agent.id}-diagnostics`, title: 'Bot 状态', context: `状态与诊断 · ${agent.name}`, aliases: ['连接', '缺的权限', '没回的消息'], destination: {page: 'diagnostics', section: diagnosticsSection(agent.id)}, kind: 'setting'});
    for (const group of agentGroups) {
      const destination: Destination = {...base, detail: {kind: 'agent-settings'}, section: group.title};
      entries.push({id: `${agent.id}-${group.title}`, title: group.title, context: `Bot 设置 · ${agent.name}`, aliases: group.aliases ?? [], destination, kind: 'setting'});
      group.fields.forEach((field, index) => entries.push({id: `${agent.id}-${group.title}-${index}`, title: field.title, context: `Bot 设置 · ${agent.name} · ${group.title}`, aliases: field.aliases ?? [], destination: {...destination, field: field.field ?? field.title, guide: field.guide}, kind: 'setting'}));
    }
  }
  for (const group of snapshot.groups) entries.push({id: group.id, title: group.name, context: '飞书群', aliases: [group.id], destination: {page: 'collaboration', view: 'groups', selection: {kind: 'group', id: group.id}}, kind: 'item'});
  const agents = new Map(snapshot.agents.map(agent => [agent.id, agent]));
  const groups = new Map(snapshot.groups.map(group => [group.id, group]));
  for (const member of snapshot.memberships) {
    const context = `群内设置 · ${groups.get(member.groupId)?.name ?? member.name} · ${agents.get(member.agentId)?.name ?? member.agentId} · 本地绑定 ${member.name} · ${member.directory}`;
    const base: Destination = {page: 'collaboration', view: 'groups', selection: {kind: 'membership', id: member.id}};
    entries.push({id: member.id, title: member.name, context, aliases: [member.directory, member.backend], destination: base, kind: 'item'});
    entries.push({id: `${member.id}-settings`, title: '群内设置', context, aliases: ['群内权限', '绑定', '行为', '权限'], destination: {...base, detail: {kind: 'membership-settings'}}, kind: 'setting'});
    entries.push({id: `${member.id}-history-link`, title: '会话与状态', context, aliases: ['历史会话'], destination: {...base, detail: {kind: 'membership-settings'}, section: '历史会话', field: '会话与状态'}, kind: 'setting'});
    entries.push(...expand(member.id, context, base, membershipGroups, {kind: 'membership-settings'}));
    ['搜索历史会话', '筛选历史会话', '恢复会话', '当前会话上下文', '刷新上下文', '清空会话', '压缩上下文', '自主任务目标', '停止当前任务', '结束目标', '完成时提醒'].forEach((title, index) => entries.push({id: `${member.id}-session-${index}`, title, context: `${context} · 当前会话`, aliases: ({'搜索历史会话': ['搜索'], '筛选历史会话': ['筛选'], '当前会话上下文': ['会话', '上下文'], '清空会话': ['会话操作'], '完成时提醒': ['正在运行']} as Record<string, string[]>)[title] ?? [], destination: {...base, section: '会话管理', field: ({'搜索历史会话': '搜索', '筛选历史会话': '筛选', '当前会话上下文': '上下文', '清空会话': '会话操作', '压缩上下文': '会话操作', '停止当前任务': '正在运行', '结束目标': '正在运行'} as Record<string, string>)[title] ?? title, guide: '进入「会话与状态」中的「会话管理」，可查看状态并操作当前会话。'}, kind: 'action'}));
    entries.push({id: `${member.id}-connection`, title: 'Bot 连接', context, aliases: [], destination: base, kind: 'item'});
  }
  entries.push({id: 'usage-share', title: '分享 Codex 用量', context: '用量', aliases: ['用量卡片'], destination: {page: 'usage', section: '分享 Codex 用量'}, kind: 'action'});
  return entries;
}
export function findEntries(entries: readonly SearchEntry[], query: string): SearchEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return ['agents', 'groups', 'usage', 'environment', 'application', 'secrets', 'diagnostics'].flatMap(id => entries.find(entry => entry.id === id) ?? []);
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
