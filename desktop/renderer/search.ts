import type {AgentId, DesktopSnapshot, GroupId, MembershipId} from '../shared/bridge';
import type {CollaborationView, Page} from './collaboration-model';

export type Selection = {kind: 'overview'} | {kind: 'agent'; id: AgentId} | {kind: 'group'; id: GroupId} | {kind: 'membership'; id: MembershipId};
export type Destination = {page: Page; view?: CollaborationView; selection?: Selection; section?: string};
export type SearchEntry = {id: string; title: string; context: string; terms: string; destination: Destination};
export const settingAnchor = (title: string) => `setting-${encodeURIComponent(title)}`;

const agentSettings = [
  ['任务卡片', '显示工具调用 显示模型'],
  ['运行策略', '最大并发任务 空闲超时 待处理消息策略 steer queue'],
  ['任务结束提醒', '提醒方式 长任务阈值'],
  ['语音转文字', '语音识别 权限'],
  ['CLI 协作', '转发本机 CLI 活动'],
  ['CLI 通知设置', '转发 Claude Codex 离开时保活 权限审批 完成卡 续聊 在场检测'],
  ['云文档评论', '评论执行工具 模型'],
  ['评论回复规则', '提示词 instructions'],
  ['新会话标题', '标题模型 推理强度'],
  ['管理员', '所有者 Open ID'],
  ['新项目默认目录', '根目录 文件夹'],
  ['允许的飞书群', '群范围 白名单'],
] as const;
const projectSettings = [
  ['群内响应', '不 @ 也能发起任务'],
  ['工作目录权限', '管理员 普通成员 允许网络访问'],
  ['会话压缩', '自动压缩上下文'],
  ['新会话默认模型', '推理强度 执行工具'],
  ['响应成员', 'Open ID 允许所有成员'],
  ['话题模型', '本话题模型'],
] as const;

export function searchEntries(snapshot: DesktopSnapshot): SearchEntry[] {
  const entries: SearchEntry[] = [
    {id: 'agents', title: 'Agent', context: '页面', terms: '机器人', destination: {page: 'collaboration', view: 'agents', selection: {kind: 'overview'}}},
    {id: 'groups', title: '群聊', context: '页面', terms: '飞书群 项目', destination: {page: 'collaboration', view: 'groups', selection: {kind: 'overview'}}},
    {id: 'environment', title: '本机环境', context: '页面', terms: 'Codex Claude 飞书 CLI 工具 安装 登录 Profile', destination: {page: 'environment'}},
    {id: 'application', title: '应用与启动', context: '页面', terms: '版本 更新 后台服务 开机 重启 退出', destination: {page: 'application'}},
    {id: 'diagnostics', title: '状态与诊断', context: '页面', terms: '日志 数据目录 连接', destination: {page: 'diagnostics'}},
    {id: 'executable', title: 'Codex 可执行文件', context: '这台设备', terms: '路径 自动检测', destination: {page: 'application', section: 'Codex 可执行文件'}},
  ];
  for (const agent of snapshot.agents) {
    const destination: Destination = {page: 'collaboration', view: 'agents', selection: {kind: 'agent', id: agent.id}};
    entries.push({id: agent.id, title: agent.name, context: 'Agent', terms: agent.id, destination});
    for (const [title, terms] of agentSettings) entries.push({id: `${agent.id}-${title}`, title, context: agent.name, terms, destination: {...destination, section: title}});
  }
  for (const group of snapshot.groups) entries.push({id: group.id, title: group.name, context: '飞书群', terms: group.id, destination: {page: 'collaboration', view: 'groups', selection: {kind: 'group', id: group.id}}});
  for (const member of snapshot.memberships) {
    const agent = snapshot.agents.find(item => item.id === member.agentId);
    const destination: Destination = {page: 'collaboration', view: 'groups', selection: {kind: 'membership', id: member.id}};
    const context = `${agent?.name ?? member.agentId} · ${member.name}`;
    entries.push({id: member.id, title: member.name, context: agent?.name ?? '项目', terms: `${member.directory} ${member.backend}`, destination});
    for (const [title, terms] of projectSettings) entries.push({id: `${member.id}-${title}`, title, context, terms, destination: {...destination, section: title}});
  }
  return entries;
}
export function findEntries(entries: SearchEntry[], query: string): SearchEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? entries.filter(entry => terms.every(term => `${entry.title} ${entry.context} ${entry.terms}`.toLocaleLowerCase().includes(term))).slice(0, 40) : [];
}
