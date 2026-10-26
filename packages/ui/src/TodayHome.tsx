import {Activity, ArrowRight, ChartNoAxesColumn, ChevronRight, Cpu, Download, Link, Settings2, Wrench, type LucideIcon} from 'lucide-react';
import type {DesktopSnapshot} from '@vonvon/protocol';
import {NowBotList} from './NowBotList';
import {NowActivity} from './NowActivity';
import {NowUsage} from './NowUsage';
import {uiFeatures} from './features';
import type {Page} from './collaboration-model';

export function TodayHome({snapshot, onSetup, onRegister, onOpenUsage, disabled}: {snapshot: DesktopSnapshot; onSetup: () => void; onRegister: () => void; onOpenUsage: () => void; disabled: boolean}) {
  const attention = snapshot.agents.filter(bot => bot.readError || (bot.enabled && (!bot.running || bot.connection !== 'connected')));
  const connected = snapshot.host.kind === 'connected' && !snapshot.stale;
  return <div className="today-home">
    <header className="today-intro"><h1>此刻</h1>{snapshot.stale && <span role="status">正在更新…</span>}</header>
    {!snapshot.stale && attention.length > 0 && <button type="button" className="today-connection-note" onClick={onSetup}><span className="today-state-dot"/><span>{attention.length} 个 Bot 需要检查连接</span><ArrowRight size={14}/></button>}
    <NowBotList snapshot={snapshot} connected={connected} onRegister={onRegister} disabled={disabled}/>
    <NowActivity snapshot={snapshot}/>
    <NowUsage disabled={!connected} onOpenUsage={onOpenUsage}/>
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
export function SettingsHome({onNavigate, onFeature, updateNotice}: {onNavigate: (page: Page) => void; onFeature: (id: string) => void; updateNotice?: string}) {
  return <section className="today-settings-home"><header className="today-page-heading"><h1>设置</h1></header>
    {[{label: '模型与工具', entries: settingsEntries.slice(0, 4)}, {label: '连接与应用', entries: settingsEntries.slice(4)}].map(section => <section className="today-settings-section" aria-label={section.label} key={section.label}><h2>{section.label}</h2><div className="today-list-surface">{section.entries.map(item => <button type="button" className="today-settings-row" key={item.page} onClick={() => onNavigate(item.page)}>
      <span className="today-setting-icon" data-page={item.page}><item.icon size={17} strokeWidth={1.7}/></span><span className="today-entity-copy"><strong>{item.title}</strong><small>{item.page === 'application' && updateNotice ? updateNotice : item.description}</small></span>{item.page === 'application' && updateNotice && <span className="today-update-dot" aria-hidden="true"/>}<ChevronRight size={14}/>
    </button>)}</div></section>)}
    {uiFeatures.filter(item => item.slot === 'page').length > 0 && <div className="today-list-surface">{uiFeatures.filter(item => item.slot === 'page').map(item => <button type="button" className="today-settings-row" key={item.id} onClick={() => onFeature(item.id)}><span className="today-entity-copy"><strong>{item.label}</strong></span><ChevronRight size={14}/></button>)}</div>}
  </section>;
}
