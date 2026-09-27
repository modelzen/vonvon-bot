import type {AgentId, DesktopSnapshot, GroupId, MembershipId} from '../shared/bridge';
import type {CollaborationView, Page} from './collaboration-model';

export type Selection = {kind: 'overview'} | {kind: 'agent'; id: AgentId} | {kind: 'group'; id: GroupId} | {kind: 'membership'; id: MembershipId};
export const agentCategories = [
  {id: 'general', label: '常规', description: '身份、启用状态与默认目录'},
  {id: 'interaction', label: '交互与通知', description: '任务卡片、提醒与飞书内容'},
  {id: 'cli', label: 'CLI 协作', description: '本机 CLI 活动与通知'},
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
export type Destination = {page: Page; view?: CollaborationView; selection?: Selection; detail?: DetailPane; section?: string};
export type SearchEntry = {id: string; title: string; context: string; terms: string; destination: Destination};
export const settingAnchor = (title: string) => `setting-${encodeURIComponent(title)}`;

const agentSettings = [
  ['任务卡片', '显示工具调用 显示模型', 'interaction'],
  ['运行策略', '最大并发任务 空闲超时 待处理消息策略 steer queue', 'interaction'],
  ['任务结束提醒', '提醒方式 长任务阈值', 'interaction'],
  ['语音转文字', '语音识别 权限', 'interaction'],
  ['CLI 协作', '转发本机 CLI 活动', 'cli'],
  ['CLI 通知设置', '转发 Claude Codex 离开时保活 权限审批 完成卡 续聊 在场检测', 'cli'],
  ['云文档评论', '评论执行工具 模型', 'interaction'],
  ['评论回复规则', '提示词 instructions', 'interaction'],
  ['新会话标题', '标题模型 推理强度', 'interaction'],
  ['管理员', '所有者 Open ID', 'access'],
  ['新项目默认目录', '根目录 文件夹', 'general'],
  ['允许的飞书群', '群范围 白名单', 'access'],
] as const;
const projectSettings = [
  ['群内响应', '不 @ 也能发起任务', 'behavior'],
  ['工作目录权限', '管理员 普通成员 允许网络访问', 'access'],
  ['会话压缩', '自动压缩上下文', 'behavior'],
  ['新会话默认模型', '推理强度 执行工具', 'behavior'],
  ['响应成员', 'Open ID 允许所有成员', 'access'],
  ['话题模型', '本话题模型', 'behavior'],
] as const;

export function searchEntries(snapshot: DesktopSnapshot): SearchEntry[] {
  const entries: SearchEntry[] = [
    {id: 'agents', title: 'Agent', context: '页面', terms: '机器人', destination: {page: 'collaboration', view: 'agents', selection: {kind: 'overview'}}},
    {id: 'groups', title: '群聊', context: '页面', terms: '飞书群 项目', destination: {page: 'collaboration', view: 'groups', selection: {kind: 'overview'}}},
    {id: 'usage', title: 'Codex 用量', context: '这台设备', terms: '账号 套餐 限额 活动 热力图', destination: {page: 'usage'}},
    {id: 'environment', title: '本机环境', context: '页面', terms: 'Codex Claude 飞书 CLI 工具 安装 登录 Profile', destination: {page: 'environment'}},
    {id: 'application', title: '应用与启动', context: '页面', terms: '版本 更新 后台服务 开机 重启 退出', destination: {page: 'application'}},
    {id: 'diagnostics', title: '状态与诊断', context: '页面', terms: '日志 数据目录 连接', destination: {page: 'diagnostics'}},
    {id: 'executable', title: 'Codex 可执行文件', context: '这台设备', terms: '路径 自动检测', destination: {page: 'application', section: 'Codex 可执行文件'}},
  ];
  for (const agent of snapshot.agents) {
    const destination: Destination = {page: 'collaboration', view: 'agents', selection: {kind: 'agent', id: agent.id}};
    entries.push({id: agent.id, title: agent.name, context: 'Agent', terms: agent.id, destination});
    entries.push({id: `${agent.id}-identity`, title: 'Agent 身份', context: agent.name, terms: '应用 ID 启用 停用 飞书凭据 重新授权 飞书权限 连接', destination: {...destination, detail: {kind: 'agent-settings', category: 'general'}, section: 'Agent 身份'}});
    entries.push({id: `${agent.id}-remove`, title: '移除 Agent', context: agent.name, terms: '删除 本地数据', destination: {...destination, detail: {kind: 'agent-settings', category: 'access'}, section: '移除 Agent'}});
    for (const [title, terms, category] of agentSettings) entries.push({id: `${agent.id}-${title}`, title, context: agent.name, terms, destination: {...destination, detail: {kind: 'agent-settings', category}, section: title}});
  }
  for (const group of snapshot.groups) entries.push({id: group.id, title: group.name, context: '飞书群', terms: group.id, destination: {page: 'collaboration', view: 'groups', selection: {kind: 'group', id: group.id}}});
  for (const member of snapshot.memberships) {
    const agent = snapshot.agents.find(item => item.id === member.agentId);
    const destination: Destination = {page: 'collaboration', view: 'groups', selection: {kind: 'membership', id: member.id}};
    const context = `${agent?.name ?? member.agentId} · ${member.name}`;
    entries.push({id: member.id, title: member.name, context: agent?.name ?? '项目', terms: `${member.directory} ${member.backend}`, destination});
    entries.push({id: `${member.id}-binding`, title: '群绑定', context, terms: '工作目录 会话方式 项目状态 解除绑定', destination: {...destination, detail: {kind: 'membership-settings', category: 'binding'}, section: '群绑定'}});
    for (const [title, terms, category] of projectSettings) entries.push({id: `${member.id}-${title}`, title, context, terms, destination: {...destination, detail: {kind: 'membership-settings', category}, section: title}});
  }
  return entries;
}
export function findEntries(entries: SearchEntry[], query: string): SearchEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? entries.filter(entry => terms.every(term => `${entry.title} ${entry.context} ${entry.terms}`.toLocaleLowerCase().includes(term))).slice(0, 40) : [];
}
