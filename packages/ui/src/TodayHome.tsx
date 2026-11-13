import {Activity, ArrowRight, ChartNoAxesColumn, ChevronRight, CircleUserRound, Cpu, Download, Link, MonitorSmartphone, Power, Wrench, type LucideIcon} from 'lucide-react';
import type {AgentId, DesktopSnapshot} from '@vonvon/protocol';
import {NowBotList} from './NowBotList';
import {NowActivity} from './NowActivity';
import {NowUsage} from './NowUsage';
import {GlowButton} from './GlowButton';
import {uiFeatures} from './features';
import type {Page} from './collaboration-model';
import {useActiveDevice, useClient} from './client-context';
import {whereName} from './device-copy';
import {accountStatusText, useAccount} from './account-context';
import {AccountAvatar} from './accounts/AccountAvatar';

export function TodayHome({snapshot, onSetup, onRegister, onOpenUsage, disabled}: {snapshot: DesktopSnapshot; onSetup: () => void; onRegister: () => void; onOpenUsage: () => void; disabled: boolean}) {
  const client = useClient();
  async function changeNumber(agentId: AgentId, badgeNumber: string) {
    const result = await client.run({type: 'setAgentBadgeNumber', agentId, badgeNumber});
    if (result.kind === 'applied') return;
    if (result.kind === 'refused' || result.kind === 'outcomeUnknown') return result.message;
    return '工号未能保存，请重试。';
  }
  const attention = snapshot.agents.filter(bot => bot.readError || (bot.enabled && (!bot.running || bot.connection !== 'connected')));
  const connected = snapshot.host.kind === 'connected' && !snapshot.stale;
  return <div className="today-home">
    <header className="today-intro">
      <div className="today-intro-title"><h1>此刻</h1>{snapshot.stale && <span role="status">正在更新…</span>}</div>
      <div className="today-intro-actions">
        <GlowButton disabled={disabled} onClick={onRegister}>添加 Bot</GlowButton>
      </div>
    </header>
    {!snapshot.stale && attention.length > 0 && <button type="button" className="today-connection-note" onClick={onSetup}><span className="today-state-dot"/><span>{attention.length} 个 Bot 需要检查连接</span><ArrowRight size={14}/></button>}
    <NowBotList snapshot={snapshot} connected={connected} onChangeNumber={changeNumber} disabled={disabled}/>
    <NowUsage disabled={!connected} agents={snapshot.agents} onOpenUsage={onOpenUsage}/>
    <NowActivity snapshot={snapshot}/>
  </div>;
}

function DecisionBranchIcon({size = 17, strokeWidth = 1.7}: {size?: number; strokeWidth?: number}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m0-4c7 0 12-1 12-5"/></svg>;
}
const settingsEntries: {page: Page; title: string; description: string; icon: LucideIcon | typeof DecisionBranchIcon}[] = [
  {page: 'providers', title: 'Provider', description: '执行任务的服务、运行组件与模型', icon: Cpu},
  {page: 'environment', title: '工具', description: '飞书 CLI 账号授权与 MCP 连接', icon: Wrench},
  {page: 'secrets', title: '决策模型', description: '智能群的回应、回复位置与新话题判断', icon: DecisionBranchIcon},
  {page: 'usage', title: '用量', description: '额度、使用记录与智能判断次数', icon: ChartNoAxesColumn},
  {page: 'devices', title: '设备连接', description: '连接其他设备，管理对当前设备的访问', icon: MonitorSmartphone},
  {page: 'setup', title: '飞书连接', description: 'Bot 的应用权限、事件与连接检查', icon: Link},
  {page: 'bridgeImport', title: 'Bridge 导入', description: '迁移旧 Bridge 数据，查看进度与结果', icon: Download},
  {page: 'application', title: '应用与启动', description: '软件更新、后台运行与启动设置', icon: Power},
  {page: 'diagnostics', title: '诊断', description: '运行状态、未回复原因、日志与恢复', icon: Activity},
];
/** `devices`: the desktop's devices page also adds and switches devices; the web page's has only 允许别的设备连接 (owner
 * 2026-11-03 moved it there from 应用与启动). */
export function SettingsHome({onNavigate, onFeature, updateNotice, devices}: {onNavigate: (page: Page) => void; onFeature: (id: string) => void; updateNotice?: string; devices?: boolean}) {
  const where = useActiveDevice();
  const account = useAccount();
  const identity = account.status?.kind === 'signedIn' ? account.status : undefined;
  // The Provider page is the shown device's: 「X」's configuration on a remote one.
  const entries = settingsEntries
    .map(item => item.page === 'devices' && !devices ? {...item, description: '管理对当前设备的访问'} : item)
    .map(item => item.page === 'providers' && where.isRemote ? {...item, description: `执行任务的服务、${whereName(where)}上的组件与模型`} : item);
  return <section className="today-settings-home"><header className="today-page-heading"><h1>设置</h1></header>
    <div className="today-list-surface"><button type="button" className="today-settings-row" onClick={() => onNavigate('account')}>
      {identity ? <AccountAvatar identity={identity}/> : <span className="today-setting-icon" data-page="account"><CircleUserRound size={19} strokeWidth={1.7}/></span>}
      <span className="today-entity-copy"><strong>{identity?.displayName ?? '账号'}</strong><small>{accountStatusText(account.status, account.supported)}</small></span><ChevronRight size={14}/>
    </button></div>
    {[{label: '模型与工具', entries: entries.slice(0, 4)}, {label: '连接与应用', entries: entries.slice(4)}].map(section => <section className="today-settings-section" aria-label={section.label} key={section.label}><h2>{section.label}</h2><div className="today-list-surface">{section.entries.map(item => <button type="button" className="today-settings-row" key={item.page} onClick={() => onNavigate(item.page)}>
      <span className="today-setting-icon" data-page={item.page}><item.icon size={17} strokeWidth={1.7}/></span><span className="today-entity-copy"><strong>{item.title}</strong><small>{item.page === 'application' && updateNotice ? updateNotice : item.description}</small></span>{item.page === 'application' && updateNotice && <span className="today-update-dot" aria-hidden="true"/>}<ChevronRight size={14}/>
    </button>)}</div></section>)}
    {uiFeatures.filter(item => item.slot === 'page').length > 0 && <div className="today-list-surface">{uiFeatures.filter(item => item.slot === 'page').map(item => <button type="button" className="today-settings-row" key={item.id} onClick={() => onFeature(item.id)}><span className="today-entity-copy"><strong>{item.label}</strong></span><ChevronRight size={14}/></button>)}</div>}
  </section>;
}
