import type {ReactNode} from 'react';
import {ArrowLeft, Search, Settings} from 'lucide-react';
import type {CollaborationView, Page} from './collaboration-model';
import {uiFeatures} from './features';
import {NavigationIndicator} from './NavigationIndicator';

// One compact toolbar at every window size; first use only exposes useful destinations.
export function AppShell(props: {page: Page; view: CollaborationView; title: string; children: ReactNode; firstUse?: boolean; newCounts?: {bots: number; projects: number}; updateVersion?: string; onNavigate: (page: Page) => void; onOpenList: (view: CollaborationView) => void; onBack?: () => void; backLabel?: string; onSearch?: () => void; selectedFeature?: string; onFeatureNavigate?: (id: string) => void}) {
  const isSettings = !['home', 'collaboration'].includes(props.page) || Boolean(props.selectedFeature);
  return <div className="settings-window collaboration-window today-window" data-first-use={props.firstUse || undefined}>
    <div className="desktop-titlebar" aria-hidden="true"/>
    <header className="today-app-header">
      <button type="button" className="today-brand" onClick={() => props.onNavigate('home')} aria-label="Vonvon Bot 此刻" title="Vonvon Bot">
        <img src="./vonvon-logo.png" alt=""/><strong>Vonvon Bot</strong>
      </button>
      {!props.firstUse && <nav className="today-primary-nav gooey-tabs" aria-label="主要导航">
        <NavigationIndicator activeIndex={props.page === 'home' ? 0 : props.page === 'collaboration' ? props.view === 'agents' ? 1 : 2 : null}/>
        <button type="button" aria-current={props.page === 'home' ? 'page' : undefined} onClick={() => props.onNavigate('home')}>此刻</button>
        <button type="button" aria-current={props.page === 'collaboration' && props.view === 'agents' ? 'page' : undefined} onClick={() => props.onOpenList('agents')}>Bot{props.newCounts?.bots ? <small className="today-nav-count" title={`新记忆 ${props.newCounts.bots} 条`} aria-label={`新记忆 ${props.newCounts.bots} 条`}>{props.newCounts.bots > 99 ? '99+' : props.newCounts.bots}</small> : null}</button>
        <button type="button" aria-current={props.page === 'collaboration' && props.view !== 'agents' ? 'page' : undefined} onClick={() => props.onOpenList('groups')}>群组{props.newCounts?.projects ? <small className="today-nav-count" title={`新记忆 ${props.newCounts.projects} 条`} aria-label={`新记忆 ${props.newCounts.projects} 条`}>{props.newCounts.projects > 99 ? '99+' : props.newCounts.projects}</small> : null}</button>
      </nav>}
      <div className="today-header-actions">
        <button type="button" className="today-icon-button" aria-label="搜索设置、Bot 或群组" title="搜索 · ⌘K" onClick={props.onSearch}><Search size={17} strokeWidth={1.7}/></button>
        <button type="button" className="today-icon-button" aria-label={props.updateVersion ? `设置，有新版本 ${props.updateVersion}` : '设置'} title={props.updateVersion ? `设置 · 有新版本 ${props.updateVersion}` : '设置'} aria-current={isSettings ? 'page' : undefined} onClick={() => props.onNavigate('settings')}><Settings size={17} strokeWidth={1.7}/>{props.updateVersion && <span className="today-update-dot" aria-hidden="true"/>}</button>
      </div>
    </header>
    <main className="settings-main-pane" aria-label={props.title}>
      {props.onBack ? <div className="today-back"><button type="button" onClick={props.onBack} aria-label={props.backLabel}><ArrowLeft size={14}/><span>{props.backLabel?.replace(/^返回\s*/, '') ?? '返回'}</span></button></div> : isSettings && props.page !== 'settings' ? <div className="today-back"><button type="button" onClick={() => props.onNavigate('settings')}><ArrowLeft size={14}/>设置</button></div> : null}
      {uiFeatures.filter(item => item.slot === 'toolbar').map(item => {const Feature = item.component;return <Feature key={item.id}/>;})}
      <div className="settings-content-scroll" id="main-content"><div className="settings-content-page">{props.children}</div></div>
    </main>
  </div>;
}
