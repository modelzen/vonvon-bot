import {useState} from 'react';
import {conversationTime} from './conversation-time';
import {useShellCapabilities} from './client-context';
import {botChatUrl,groupUrl,openExternalUrl} from './url-actions';
import {Activity, ArrowUpRight, ArrowRight, ChartNoAxesColumn, ChevronRight, Settings, Cpu, Download, Link, Settings2, Wrench, type LucideIcon} from 'lucide-react';
import type {AgentId, DesktopSnapshot, GroupId} from '@vonvon/protocol';
import {AgentAvatar} from './AgentAvatar';
import {GlowButton} from './GlowButton';
import {IconButton} from './reference/components/ui';
import {uiFeatures} from './features';
import type {Page} from './collaboration-model';

export function TodayHome({snapshot, onAgent, onGroup, onSetup, onRegister, disabled}: {snapshot: DesktopSnapshot; onAgent: (id: AgentId) => void; onGroup: (id: GroupId) => void; onSetup: () => void; onRegister: () => void; disabled: boolean}) {
  const shell=useShellCapabilities();
  const [error,setError]=useState('');
  const attention = snapshot.agents.filter(bot => bot.readError || (bot.enabled && (!bot.running || bot.connection !== 'connected')));
  const recent=snapshot.recentConversations;
  const groupCount = (id: AgentId) => new Set(snapshot.memberships.filter(member => member.agentId === id).map(member => member.groupId)).size;
  async function open(url:string,kind:'bot-chat'|'group') {try {await openExternalUrl(url,kind,shell); setError('');} catch (error) {setError(error instanceof Error ? error.message : '无法打开飞书。');}}
  return <div className="today-home">
    <header className="today-intro"><h1>此刻</h1>{snapshot.stale && <span role="status">正在更新…</span>}</header>
    {!snapshot.stale && attention.length > 0 && <button type="button" className="today-connection-note" onClick={onSetup}><span className="today-state-dot"/><span>{attention.length} 个 Bot 需要检查连接</span><ArrowRight size={14}/></button>}
    {error && <p role="alert" className="gd-note gd-warning">{error}</p>}
    <section className="today-home-section" aria-label="你的 Bot">
      <header><h2>你的 Bot</h2><GlowButton disabled={disabled} onClick={onRegister}>添加 Bot</GlowButton></header>
      <div className="today-list-surface">{snapshot.agents.map(bot => <div className="today-entity-row today-bot-row" key={bot.id}>
        <button type="button" className="today-bot-info" onClick={() => onAgent(bot.id)} aria-label={`查看 ${bot.name}`}><AgentAvatar agent={bot}/><span className="today-entity-copy"><strong title={bot.name}>{bot.name}</strong></span><small className="overview-bot-meta">{groupCount(bot.id)} 个群聊{(bot.readError || !bot.enabled || bot.connection !== 'connected') && <><span aria-hidden="true">·</span>{bot.readError ? '配置读取失败' : !bot.enabled ? '已停用' : bot.connection === 'connecting' || bot.connection === 'reconnecting' ? '正在连接' : '未连接'}</>}</small></button>
        <IconButton type="button" variant="ghost" className="today-icon-button" label={`在飞书打开 ${bot.name}`} title="在飞书打开" onClick={()=>void open(botChatUrl(bot.id),'bot-chat')}><ArrowUpRight size={17}/></IconButton>
      </div>)}</div>
    </section>
    <section className="today-home-section" aria-label="最近对话">
      <header><h2>最近对话</h2></header>
      {recent?.items.length ? <div className="today-list-surface">{recent.items.map(item => {const group=snapshot.groups.find(group=>group.id===item.groupId);const bot=snapshot.agents.find(bot=>bot.id===item.agentId);const time=conversationTime(item.updatedAt);return <div className="today-entity-row today-recent-row" key={`${item.agentId}:${item.threadId}`}>
        <button type="button" className="today-recent-open" aria-label={`在飞书打开 ${group?.name ?? '群聊'} 的对话：${item.summary || '查看对话'}`} onClick={()=>void open(groupUrl(item.groupId,item.threadId),'group')}><span className="today-entity-copy"><strong className="overview-summary" title={item.summary || '查看对话'}>{item.summary || '查看对话'}</strong><small className="overview-context"><span title={group?.name}>{group?.name ?? '群聊'}</span>{bot && <><span aria-hidden="true">·</span><span title={bot.name}>{bot.name}</span></>}</small></span><time className="overview-time" dateTime={time?.dateTime} title={time?.title}>{time?.label}</time><ArrowUpRight className="overview-open-icon" size={15}/></button>
        <IconButton type="button" variant="ghost" className="today-icon-button" title="群设置" label={`设置 ${group?.name ?? '群聊'}`} onClick={()=>onGroup(item.groupId)}><Settings size={15} strokeWidth={1.7}/></IconButton>
      </div>;})}</div> : <p className="today-recent-empty">{recent?.unavailableBots ? '暂时无法读取对话记录。' : '在飞书开始对话，最近的内容会显示在这里。'}</p>}
      {!!recent?.items.length && !!recent.unavailableBots && <p className="gd-note">部分 Bot 的记录暂时无法读取。</p>}
    </section>
  </div>;
}

const settingsEntries: {page: Page; title: string; description: string; icon: LucideIcon}[] = [
  {page: 'providers', title: 'Provider', description: 'Codex 与 Claude 的安装、登录和模型', icon: Cpu},
  {page: 'environment', title: '工具与连接', description: '飞书 CLI 与 MCP 连接', icon: Wrench},
  {page: 'secrets', title: '决策模型', description: '模型服务与密钥', icon: Cpu},
  {page: 'usage', title: '用量', description: '额度与使用记录', icon: ChartNoAxesColumn},
  {page: 'setup', title: '飞书连接', description: '应用权限与连接状态', icon: Link},
  {page: 'bridgeImport', title: '导入 Bridge', description: '迁移已有的 Bot、群聊和设置', icon: Download},
  {page: 'application', title: '应用与启动', description: '后台运行与更新', icon: Settings2},
  {page: 'diagnostics', title: '状态与诊断', description: '连接、日志与恢复', icon: Activity},
];
export function SettingsHome({onNavigate, onFeature}: {onNavigate: (page: Page) => void; onFeature: (id: string) => void}) {
  return <section className="today-settings-home"><header className="today-page-heading"><h1>设置</h1></header>
    {[{label: '模型与工具', entries: settingsEntries.slice(0, 4)}, {label: '连接与应用', entries: settingsEntries.slice(4)}].map(section => <section className="today-settings-section" aria-label={section.label} key={section.label}><h2>{section.label}</h2><div className="today-list-surface">{section.entries.map(item => <button type="button" className="today-settings-row" key={item.page} onClick={() => onNavigate(item.page)}>
      <span className="today-setting-icon" data-page={item.page}><item.icon size={17} strokeWidth={1.7}/></span><span className="today-entity-copy"><strong>{item.title}</strong><small>{item.description}</small></span><ChevronRight size={14}/>
    </button>)}</div></section>)}
    {uiFeatures.filter(item => item.slot === 'page').length > 0 && <div className="today-list-surface">{uiFeatures.filter(item => item.slot === 'page').map(item => <button type="button" className="today-settings-row" key={item.id} onClick={() => onFeature(item.id)}><span className="today-entity-copy"><strong>{item.label}</strong></span><ChevronRight size={14}/></button>)}</div>}
  </section>;
}
