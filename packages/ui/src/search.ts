import {toolNames} from './management/environmentPresentation';
import {DECISION_API_PROVIDERS, decisionApiProviderLabel} from '@vonvon/protocol';
import type {AgentId, DesktopSnapshot, GroupId, MembershipId, ProjectId, ScheduledTaskView} from '@vonvon/protocol';
import type {CollaborationView, Page} from './collaboration-model';

export type Selection = {kind: 'overview'} | {kind: 'agent'; id: AgentId} | {kind: 'group'; id: GroupId} | {kind: 'project'; id: ProjectId} | {kind: 'membership'; id: MembershipId};
export type DetailPane = {kind: 'overview'} | {kind: 'agent-settings'} | {kind: 'membership-settings'};
export type SearchReveal = 'machine-advanced' | 'codex' | 'claude' | 'codex-tool' | 'claude-tool' | 'lark-tool' | 'profile-manager' | 'profile-add' | 'profile-create' | 'agent-profile' | 'group-history' | 'dm-response';
export type Destination = {page: Page; view?: CollaborationView; selection?: Selection; detail?: DetailPane; section?: string; field?: string; reveal?: SearchReveal; guide?: string};
export type SearchEntry = {id: string; title: string; context: string; aliases: readonly string[]; destination: Destination; kind: 'page' | 'setting' | 'action' | 'item'};
export const settingAnchor = (title: string) => `setting-${encodeURIComponent(title)}`;
/** A window event asking the page to open a setting (`detail`: a Destination), from outside App (devices-ui-3's paired toast). */
export const OPEN_SETTING_EVENT = 'vonvon:open-setting';
/** One bot's section on the 状态与诊断 page. */
export const diagnosticsSection = (agentId: string) => `Bot 状态 ${agentId}`;
/** Shared model configuration opened from a group's decision Provider. */
export const decisionProviderSection = (provider?: string) =>
  provider && ['codex-appserver', 'claude-agent', ...DECISION_API_PROVIDERS].includes(provider) ? `决策配置 ${provider}` : 'Provider 配置';
/** Custom connection fields and its key have distinct search anchors. */
export const decisionKeySection = (provider: string) => provider === 'custom' ? '决策密钥 custom' : decisionProviderSection(provider);

type Target = {title: string; aliases?: readonly string[]; reveal?: SearchReveal; guide?: string; field?: string};
type Group = {title: string; aliases?: readonly string[]; fields: readonly Target[]; smartOnly?: boolean; ordinaryOnly?: boolean};
type AgentGroup = Group & {reveal?: SearchReveal};
const item = (title: string, aliases: readonly string[] = [], options: Omit<Target, 'title' | 'aliases'> = {}): Target => ({title, aliases, ...options});
const agentGroups: readonly AgentGroup[] = [
  {title: 'Bot 身份', fields: [item('启用 Bot', ['停用 Bot'])]},
  {title: '连接与权限', fields: [item('应用 ID', ['App ID']), item('连接与设置', ['首次运行清单', '开权限', '事件订阅', '发布版本']), item('飞书权限', ['一键开权限']), item('刷新飞书凭据', ['重新扫码', '重新授权']), item('状态与诊断', ['检查连接', '没回的消息'])]},
  {title: '个性与记忆', reveal: 'agent-profile', fields: [item('Bot 个性', ['通用个性']), item('Bot 记忆', ['公共记忆'])]},
  {title: '运行上限', aliases: ['运行策略'], fields: [item('同时处理的任务', ['最大并发任务']), item('当前运行上限', ['当前运行并发'], {field: '', guide: '重启前后上限不同时，会显示当前运行上限。'}), item('空闲超时', ['空闲超时（秒，0 为关闭）'])]},
  {title: '完成提醒', fields: [item('提醒方式', ['什么时候提醒']), item('超过几分钟提醒', ['长任务阈值'], {field: '提醒方式', guide: '先选择「长任务」，再设置分钟数。'})]},
  {title: '语音转文字', fields: [item('飞书语音权限'), item('权限与测试'), item('重新检测'), item('测试语音', [], {field: '测试'})]},
  {title: '云文档评论', fields: [item('评论模型', ['后端', '评论后端', '模型', '执行工具'], {field: '选择评论模型'}), item('评论思考强度', ['推理强度'], {field: '评论模型思考强度', guide: '先选择一个具体模型，再调整思考强度。'})]},
  {title: '评论回复规则', fields: [item('评论规则文本', ['提示词', 'instructions'], {field: '评论回复规则'}), item('保存规则', ['保存评论规则']), item('恢复默认', ['恢复默认评论规则'])]},
  {title: '新会话标题', aliases: ['会话标题'], fields: [item('标题模型', ['Codex 标题模型', 'Claude 标题模型', '标题后端', '执行工具'], {field: '', guide: '开启会话标题后，选择生成标题的模型。'}), item('用模型生成标题', ['自动生成会话标题'], {field: '自动生成会话标题'}), item('自定义模型 ID', ['标题模型 ID'], {field: '', guide: '开启会话标题，打开模型菜单并选择「自定义模型 ID」。'}), item('推理强度', ['标题推理强度'], {field: '', guide: '选择标题模型后，在旁边调整思考强度。'})]},
  {title: '允许的飞书群', fields: [item('群范围'), item('添加群 ID'), item('移除群 ID', [], {field: '', guide: '在允许的飞书群列表中找到要移除的群。'})]},
  {title: '移除 Bot', fields: [item('删除本地 Bot 数据', ['删除机器人'])]},
];
/** Project-owned settings: the workspace is the project's, shared by every group that uses it (memory design §5.3). */
const projectGroups: readonly Group[] = [
  {title: '工作区', aliases: ['工作目录', '文件夹'], fields: [item('目录', ['工作目录', '更换目录', '文件夹'], {field: ''}), item('添加目录'), item('主目录', ['设为主目录'], {field: ''}), item('代码仓库', [], {field: ''}), item('添加仓库')]},
];
const membershipGroups: readonly Group[] = [
  {title: '群设置', aliases: ['群绑定'], fields: [item('在本群使用', ['启用', '停用', '在这个群中使用 Bot'], {field: ''})]},
  {title: '技能', aliases: ['能力', 'Skill'], fields: [item('使用技能', ['启用技能', '关闭技能'], {field: ''})]},
  {title: '语音', fields: [item('语音转文字', ['启用语音', '语音识别'])]},
  {title: '本群角色', aliases: ['本群职责', '角色补充', '补充职责', '本群个性'], fields: [item('本群角色', ['本群个性', '补充职责'], {field: ''})]},
  {title: '记忆', aliases: ['思维导图'], fields: [item('项目记忆', ['群记忆', '记忆导图'], {field: ''})]},
  {title: '任务', aliases: ['定时任务', '周期任务', '新建任务'], fields: []},
  {title: '可用模型', aliases: ['执行模型', '模型', '模型与权限', '执行工具'], fields: [item('模型 Provider', ['执行后端'], {field: ''}), item('允许使用的模型', ['模型多选'], {field: '', guide: '点击「选择模型」查看并多选；完成后在页面保存。'}), item('可用 Effort', ['思考强度', '推理强度', 'Effort 多选'], {field: '', guide: '点击「选择强度」调整 Effort；与模型独立多选。'})]},
  {title: '权限', aliases: ['工作目录权限', '执行权限'], fields: [item('权限', [], {field: '修改权限'}), item('能挡到什么', [], {field: '修改权限', guide: '点击「修改权限」，可比较各档范围与实际约束。'}), item('自定义权限', ['高级设置', '自定义设置'], {field: '修改权限', guide: '点击「修改权限」，选择「自定义」后调整 Provider 原生字段并保存。'})]},
  {title: '聊天方式', aliases: ['沟通方式', '回复规则'], fields: [item('聊天方式', ['会话方式', '智能模式', '智能开话题'], {field: ''})]},
  {title: '决策模型', smartOnly: true, aliases: ['判断模型'], fields: [item('决策 Provider', ['判断模型', 'Jev', 'System One', 'TypeSafe', 'OpenRouter', 'Vercel', '自定义接口'], {field: ''}), item('决策 Effort', ['判断的推理强度'], {field: '', guide: '先选择语言模型，再设置 Effort。'}), item('自定义决策模型 ID', ['判断的手填模型 id'], {field: '', guide: '选择语言模型 Provider，再点「自定义模型 ID」。'})]},
  {title: '判断规则', smartOnly: true, fields: [item('判断规则', ['什么时候回应', '什么时候不回应', '消息在群主区时', '消息已经在话题里时', '什么时候回复', '什么时候创建新话题', '响应提示词', '新话题提示词'])]},
  {title: '群内响应', ordinaryOnly: true, fields: [item('不 @ 也能发起任务', ['免 @'])]},
  {title: '新消息处理', aliases:['运行中来了消息'], fields: [item('新消息处理', ['运行中来了消息', '运行中收到新消息', '待处理消息策略', '插话', '排队', '立即插话', '排队等待', 'steer', 'queue'])]},
  {title: '回应谁', aliases:['响应范围','响应成员'], fields: [item('指定成员', ['添加成员', '从群成员选择', '选择响应成员'], {field:'指定成员'}), item('移除成员', [], {field: '', guide: '在响应成员列表中选择要移除的成员。'}), item('恢复所有成员', ['所有成员', '允许所有成员', '清空白名单'], {field:'所有成员',guide:'指定了成员后，可恢复为回应所有群成员。'})]},
  {title: '回复样式', aliases: ['消息卡片', '任务卡片', '卡片显示', '消息与提醒'], fields: [item('回复卡片样式', ['显示工具调用', '显示模型'], {guide: '打开「自定义」，在卡片上点选或拖动内容。每个群聊、私聊单独保存。'}), item('恢复默认展示', ['恢复默认卡片', '恢复默认样式'], {field:'回复卡片样式',guide:'打开「自定义」，在回复样式编辑页底部选择「恢复默认」。'}), item('完成提醒', ['什么时候提醒', '提醒方式'], {field:'回复卡片样式', guide:'打开「自定义」，在左侧「回复行为」中设置完成提醒。'}), item('提醒内容', ['提醒格式', '提醒模板', '自定义提醒文字'], {field:'回复卡片样式', guide:'打开「自定义」，在左侧「完成提醒」下编辑「提醒内容」。'}), item('超过几分钟提醒', ['长任务阈值', '长任务阈值（分钟）'], {field:'回复卡片样式', guide:'打开「自定义」，将「完成提醒」设为「长任务」，再调整分钟数。'})]},
];
/** What the 本机环境 fields were called before the 叫法表 (docs/v1-plan.md section 5), so the old words still find them. */
const formerly: Readonly<Record<string, string>> = {'后端状态': 'Host 状态', '后端版本': 'Host 版本', '当前账号配置': '当前 Profile'};
const globalGroups: readonly {page: Page; section: string; fields: readonly Target[]}[] = [
  {page: 'usage', section: '智能模式的判断次数', fields: [item('判断次数', ['判断', '按 Bot 看'], {field: ''})]},
  {page: 'application', section: '启动选项', fields: [item('后台运行', ['运行状态', '重启后台服务', '重启后台', '重启 daemon']), item('登录电脑时启动', ['开机启动'])]},
  {page: 'application', section: 'daemon 运行', fields: [item('运行方式'), item('daemon 服务', ['启动 daemon', '停止 daemon']), item('临时运行 Bot', [], {guide: '仅运行指定 Bot 时显示当前临时运行状态。'})]},
  {page: 'application', section: '后台服务', fields: [item('系统服务'), item('服务运行', ['启动已安装服务']), item('仅运行指定 Bot', [], {reveal: 'machine-advanced'}), ...['进程 PID', '上次退出', '服务定义', '标准输出', '错误日志'].map(title => item(title, [], {reveal: 'machine-advanced'}))]},
  // devices-ui-3: 允许别的设备连接, on every device shown (the desktop and the web page alike); on 设备 since owner 2026-11-03.
  // Its own name lands on the block, not the page's top: on the desktop it is under the device list (审查 P3).
  {page: 'devices', section: '允许别的设备连接', fields: [item('允许别的设备连接', [], {field: ''}), item('设备名字', ['这台设备的名字', '改设备名']), item('地址', ['远程连接', 'Tailscale', '局域网', '组网', '开启远程', '关闭远程连接'], {field: ''}), item('端口', ['改端口'])]},
  // The link is in its own group next to it, which App looks in (Codex 审查 269-2): its row, or the link once made
  {page: 'devices', section: '连接链接', fields: [item('连接链接', ['生成连接链接', '配对链接', '配对'])]},
  {page: 'devices', section: '已配对的设备', fields: [item('已配对的设备', ['已配对的客户端', '撤销', '撤销设备', '客户端', '谁连着这台'], {field: ''})]},
  {page: 'application', section: '软件更新', fields: [item('桌面版', [], {field: ''}), item('更新状态', [], {field: ''}), item('可用版本', [], {field: ''}), item('检查更新', ['检查桌面更新']), item('下载更新', [], {guide: '有可用更新时显示下载操作。'}), item('重启升级', ['安装更新'], {field: '重启升级', guide: '下载完成后显示重启升级，会中断正在进行的对话。'}), item('发布说明')]},
  {page: 'application', section: '外部 Core / CLI', fields: [item('Core 来源'), item('当前版本'), item('可用版本'), item('检查 Core 更新'), item('更新外部 Core'), item('更新进度', ['查看 Core 更新进度'])]},
  {page: 'providers', section: 'Codex 可执行文件', fields: [item('Codex 可执行文件', ['执行文件路径', '执行程序'], {field: ''}), item('已保存路径', ['Codex 路径']), item('当前路径配置'), item('本次所选', ['选择 Codex 可执行文件', '选择文件', '更改路径']), item('恢复自动检测'), item('保存路径', ['Codex 可执行文件路径'], {field: '本次所选', guide: '更改路径后，在弹窗中保存。'})].map(field => ({...field, reveal: 'codex' as const}))},
  {page: 'application', section: '运行后备', fields: [item('未绑定工作目录时的运行后备')]},
  // The section is the page's own name: 本机环境 would be wrong while a remote device is shown (owner 2026-11-02).
  {page: 'environment', section: '工具与连接', fields: [item('重新检测', ['本机环境'])]},
  ...(['Codex', 'Claude'] as const).map(section => ({page: 'providers' as const, section, fields: ['安装', '更新', '配置', '检查配置', '安装托管副本', '重新安装最新版', '停用托管副本', '安装来源', '安装位置', '当前版本', '托管版本', '最新版本', '授权状态', ...(section === 'Codex' ? ['后端状态', '后端版本'] : ['Claude Agent SDK', '安装后端', '检查后端版本', '更新后端', '卸载后端'])].map(title => item(`${title} ${section}`, [title, ...(formerly[title] ? [formerly[title]] : [])], {field: '', reveal: section === 'Codex' ? 'codex' : 'claude', guide: '在 Provider 详情查看状态和可用操作。'}))})),
  {page: 'environment', section: toolNames['lark-cli'], fields: ['安装', '更新', '登录', '检查授权', '重新登录', '安装托管副本', '重新安装最新版', '停用托管副本', '安装来源', '安装位置', '当前版本', '托管版本', '最新版本', '授权状态', '当前账号配置'].map(title => item(`${title} 飞书 CLI`, [title, ...(formerly[title] ? [formerly[title]] : [])], {field: title, reveal: 'lark-tool', guide: ['安装来源', '安装位置', '当前版本', '托管版本', '最新版本', '授权状态', '当前账号配置'].includes(title) ? undefined : '此操作是否可用取决于飞书 CLI 的安装与授权状态。'}))},
  {page: 'environment', section: 'MCP', fields: [item('MCP', ['MCP 连接', '连接器'], {field: ''}), item('添加 MCP', [], {field: '添加'}), item('MCP 授权', [], {field: '', guide: '选择连接的「授权」，在终端完成。'}), item('移除 MCP', [], {field: '', guide: '选择连接的「移除」。'})]},
  {page: 'environment', section: '飞书 CLI 账号配置', fields: [item('管理飞书 CLI', ['管理账号配置', '切换账号配置', 'Profile'], {reveal: 'profile-manager'}), item('添加已有应用', ['添加账号配置', '添加 Profile'], {reveal: 'profile-add'}), item('创建新应用', ['创建账号配置', '创建 Profile'], {reveal: 'profile-create'}), ...['账号配置名称', 'App ID', 'App Secret', '平台', '添加后设为当前'].map(title => item(title, ['飞书应用'], {reveal: 'profile-add'})), item('设为当前', ['切换账号配置', '切换飞书 Profile'], {reveal: 'profile-manager'})]},
  ...DECISION_API_PROVIDERS.map(provider => ({page: 'secrets' as const, section: decisionKeySection(provider), fields: [item(`${decisionApiProviderLabel(provider)} 密钥`, [provider, `${provider}-api-key`, '添加密钥', '更换密钥', '验证', '填 key', '换 key', '删除 key', '试一次', 'Jev', ...(provider === 'custom' ? ['System One', 'custom-decision-api-key', '自定义接口'] : [])], {field: 'API 密钥'}), item(`${decisionApiProviderLabel(provider)} 使用范围`, ['谁在用'], {field: '使用范围'})]})),
  {page: 'secrets', section: decisionProviderSection('custom'), fields: [item('自定义决策请求地址', ['自定义接口', 'System One', 'endpoint', 'URL'], {field: '接口地址'}), item('自定义接口模型 ID', ['自定义 Jev', 'System One', '模型名称'], {field: '模型 ID'})]},
  {page: 'diagnostics', section: '诊断概况', fields: [item('daemon 版本', ['后台版本']), item('重新检查'), item('最近读取')]},
  {page: 'diagnostics', section: '这台电脑', fields: [item('决策模型密钥', ['决策模型的 key', '没填 key']), item('数据目录')]},
  {page: 'diagnostics', section: 'daemon 日志', fields: [item('刷新日志'), item('持续跟随', ['自动刷新']), item('后台日志', ['daemon 日志'])]},
];
function expand(id: string, context: string, base: Destination, groups: readonly Group[], pane: DetailPane): SearchEntry[] {
  return groups.flatMap(group => {
    const destination = {...base, detail: pane, section: group.title};
    return [
      {id: `${id}-${group.title}`, title: group.title, context, aliases: group.aliases ?? [], destination, kind: 'setting' as const},
      ...group.fields.map((field, index) => ({id: `${id}-${group.title}-${index}`, title: field.title, context: `${context} · ${group.title}`, aliases: field.aliases ?? [], destination: {...destination, field: field.field ?? field.title, reveal: field.reveal, guide: field.guide}, kind: 'setting' as const})),
    ];
  });
}
/** `schedules`: the tasks the running Bots answered with when search opened; each is found by name on its group's 任务 tab. */
export function searchEntries(snapshot: DesktopSnapshot, capabilities: {externalCoreAvailable?: boolean; schedules?: readonly ScheduledTaskView[]; devices?: boolean} = {}): SearchEntry[] {
  const pages: readonly {id: string; title: string; aliases: readonly string[]; page: Page; view?: CollaborationView}[] = [
    {id: 'home', title: '此刻', aliases: ['首页', '概览'], page: 'home'},
    {id: 'agents', title: 'Bot', aliases: ['机器人', '注册 Bot', '添加 Bot', '加入飞书群并设置工作目录'], page: 'collaboration', view: 'agents'},
    {id: 'bridgeImport', title: 'Bridge 导入', aliases: ['导入 Bridge', 'feishu-codex-bridge', 'Feishu Codex Bridge', '迁移', '旧版导入', '恢复导入'], page: 'bridgeImport'},
    {id: 'setup', title: '飞书连接', aliases: ['连接与设置', '首次运行清单', '后端', '准备执行工具', '扫码', '开权限', '一键开权限', '事件订阅', '卡片回调', '发布版本', '长连接'], page: 'setup'},
    {id: 'groups', title: '群组', aliases: ['飞书群', '群聊', '已连接飞书群', '群设置'], page: 'collaboration', view: 'groups'},
    {id: 'projects', title: '项目管理', aliases: ['项目', '共享项目'], page: 'collaboration', view: 'projects'},
    {id: 'usage', title: '用量', aliases: ['Codex 用量', '账号', '套餐', '限额', '活动', '热力图', '判断次数', '智能模式'], page: 'usage'},
    {id: 'providers', title: 'Provider', aliases: ['Codex', 'Claude', '模型来源', '安装', '登录', '授权'], page: 'providers'},
    {id: 'environment', title: '工具', aliases: ['工具与连接', '本机环境', '飞书 CLI', 'MCP'], page: 'environment'},
    {id: 'application', title: '应用与启动', aliases: ['版本', '更新', '后台服务'], page: 'application'},
    {id: 'secrets', title: '决策模型', aliases: ['key', 'API key', 'TypeSafe', 'OpenRouter', 'Vercel', '自定义接口', 'Jev', 'System One', '密钥'], page: 'secrets'},
    {id: 'diagnostics', title: '诊断', aliases: ['状态与诊断', '日志', '数据目录', '连接', '没回的消息', '缺的权限'], page: 'diagnostics'},
    // Only the desktop adds and switches devices; every page has 允许别的设备连接 there (found by its own entry, above). 服务器 is a
    // search word only, never on the page.
    {id: 'devices', title: '设备连接', aliases: ['设备', '多设备', ...capabilities.devices ? ['添加设备', '切换设备'] : [], '远程', '连接链接', '配对', 'Tailscale', '服务器'], page: 'devices'},
    {id: 'account', title: '账号', aliases: ['账户', '登录', '退出登录', 'GitHub', 'Google', 'Apple'], page: 'account'},
  ];
  const entries: SearchEntry[] = pages.map(page => ({id: page.id, title: page.title, context: '页面', aliases: page.aliases, destination: {page: page.page, view: page.view, selection: page.view ? {kind: 'overview'} : undefined}, kind: 'page'}));
  for (const group of globalGroups.filter(group => group.section !== '外部 Core / CLI' || capabilities.externalCoreAvailable)) group.fields.forEach((field, index) => entries.push({
    id: `global-${group.page}-${group.section}-${index}`, title: field.title, context: group.section, aliases: field.aliases ?? [], destination: {page: group.page, section: group.section, field: field.field ?? field.title, reveal: field.reveal, guide: field.guide}, kind: 'setting',
  }));
  for (const agent of snapshot.agents) {
    const base: Destination = {page: 'collaboration', view: 'agents', selection: {kind: 'agent', id: agent.id}};
    entries.push({id: agent.id, title: agent.name, context: 'Bot', aliases: [agent.id], destination: base, kind: 'item'});
    if (agent.dm) {
      const destination: Destination = {...base, reveal:'dm-response', section:'回应谁'};
      entries.push({id:`${agent.id}-dm-administrators`,title:'管理员',context:`和 ${agent.name} 的私聊 · 回应谁`,aliases:['谁能私聊','候选人','创建者','私聊权限','被拒的人','响应范围','响应成员','回应谁'],destination,kind:'setting'});
      for (const title of ['添加管理员','移除管理员']) entries.push({id:`${agent.id}-dm-${title}`,title,context:`和 ${agent.name} 的私聊`,aliases:[],destination:{...destination,field:title === '添加管理员' ? title : '',guide:title === '移除管理员' ? '在「回应谁」的管理员名单中选择要移除的人。' : undefined},kind:'setting'});
    }
    entries.push({id: `${agent.id}-settings`, title: 'Bot 设置', context: agent.name, aliases: ['机器人设置', 'Bot 权限'], destination: {...base, detail: {kind: 'agent-settings'}}, kind: 'setting'});
    entries.push({id: `${agent.id}-diagnostics`, title: 'Bot 状态', context: `诊断 · ${agent.name}`, aliases: ['连接', '缺的权限', '没回的消息'], destination: {page: 'diagnostics', section: diagnosticsSection(agent.id)}, kind: 'setting'});
    for (const title of ['智能群注意力', '自定义智能提示词']) entries.push({id: `${agent.id}-${title}`, title, context: `诊断 · ${agent.name}`, aliases: [], destination: {page: 'diagnostics', section: diagnosticsSection(agent.id), field: title}, kind: 'setting'});
    for (const group of agentGroups) {
      const destination: Destination = {...base, detail: {kind: 'agent-settings'}, section: group.title, reveal: group.reveal};
      entries.push({id: `${agent.id}-${group.title}`, title: group.title, context: `Bot 设置 · ${agent.name}`, aliases: group.aliases ?? [], destination, kind: 'setting'});
      group.fields.forEach((field, index) => entries.push({id: `${agent.id}-${group.title}-${index}`, title: field.title, context: `Bot 设置 · ${agent.name} · ${group.title}`, aliases: field.aliases ?? [], destination: {...destination, field: field.field ?? field.title, guide: field.guide}, kind: 'setting'}));
    }
  }
  const groupNames = new Map(snapshot.groups.map(group => [group.id as string, group.name]));
  for (const project of snapshot.projects ?? []) {
    const base: Destination = {page: 'collaboration', view: 'projects', selection: {kind: 'project', id: project.id}};
    const groups = project.bindings.map(binding => groupNames.get(binding.groupId) ?? '').filter(Boolean);
    entries.push({id: project.id, title: project.name, context: '项目', aliases: [...new Set(groups)], destination: base, kind: 'item'});
    entries.push(...expand(project.id, `项目 · ${project.name}`, base, projectGroups, {kind: 'overview'}));
  }
  for (const group of snapshot.groups) {
    entries.push({id: group.id, title: group.name, context: '飞书群', aliases: [group.id], destination: {page: 'collaboration', view: 'groups', selection: {kind: 'group', id: group.id}}, kind: 'item'});
  }
  const agents = new Map(snapshot.agents.map(agent => [agent.id, agent]));
  const groups = new Map(snapshot.groups.map(group => [group.id, group]));
  for (const member of snapshot.memberships) {
    const context = `群设置 · ${groups.get(member.groupId)?.name ?? member.name} · ${agents.get(member.agentId)?.name ?? member.agentId}`;
    const base: Destination = {page: 'collaboration', view: 'groups', selection: {kind: 'membership', id: member.id}};
    entries.push({id: member.id, title: member.name, context, aliases: [member.directory, member.backend], destination: base, kind: 'item'});
    entries.push({id: `${member.id}-settings`, title: '群设置', context, aliases: ['群内设置', '群内权限', '绑定', '行为', '权限'], destination: {...base, detail: {kind: 'membership-settings'}}, kind: 'setting'});
    entries.push({id: `${member.id}-history-link`, title: '对话记录', context, aliases: ['历史会话', '会话与状态', '会话管理'], destination: {...base, detail: {kind: 'overview'}, section: '会话管理', reveal: 'group-history'}, kind: 'setting'});
    entries.push(...expand(member.id, context, base, membershipGroups.filter(group => (!group.smartOnly || member.conversation === 'smart') && (!group.ordinaryOnly || member.conversation !== 'smart')), {kind: 'membership-settings'}));
    ['搜索历史会话', '筛选历史会话', '恢复会话', '当前会话上下文', '刷新上下文', '清空会话', '压缩上下文', '停止当前任务', '结束目标', '完成时提醒'].forEach((title, index) => entries.push({id: `${member.id}-session-${index}`, title, context: `${context} · 当前会话`, aliases: ({'搜索历史会话': ['搜索'], '筛选历史会话': ['筛选'], '当前会话上下文': ['会话', '上下文'], '清空会话': ['会话操作'], '完成时提醒': ['正在运行']} as Record<string, string[]>)[title] ?? [], destination: {...base, section: '会话管理', reveal: 'group-history', field: ({'搜索历史会话': '搜索', '筛选历史会话': '筛选', '恢复会话': '', '刷新上下文': '上下文', '当前会话上下文': '上下文', '清空会话': '会话操作', '压缩上下文': '会话操作', '停止当前任务': '正在运行', '结束目标': '正在运行'} as Record<string, string>)[title] ?? title, guide: '对话记录中可查看历史与当前任务；部分操作需要有会话或运行中的任务。'}, kind: 'action'}));
    for (const task of capabilities.schedules ?? []) if (task.botId === member.agentId && task.chatId === member.groupId) {
      entries.push({id: `${member.id}-schedule-${task.id}`, title: task.name, context: `${context} · 任务`, aliases: [task.describe], destination: {...base, detail: {kind: 'membership-settings'}, section: '任务', field: task.name}, kind: 'item'});
    }
    entries.push({id: `${member.id}-remove`, title: '解除群绑定', context, aliases: ['解除绑定', '解除项目绑定'], destination: {...base, detail: {kind: 'membership-settings'}, section: '群设置', field: '', guide: '打开右上角群操作，选择「解除群绑定」。'}, kind: 'action'});
  }
  entries.push({id: 'usage-share', title: '分享 Codex 用量', context: '用量', aliases: ['用量卡片'], destination: {page: 'usage', section: '分享 Codex 用量'}, kind: 'action'});
  return entries;
}
export function findEntries(entries: readonly SearchEntry[], query: string): SearchEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return ['agents', 'groups', 'usage', 'providers', 'environment', 'application', 'secrets', 'diagnostics'].flatMap(id => entries.find(entry => entry.id === id) ?? []);
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
