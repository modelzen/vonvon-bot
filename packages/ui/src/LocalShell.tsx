import type {ReactNode} from 'react';
import {ArrowLeft, Search, Settings} from 'lucide-react';
import type {CollaborationView, Page} from './collaboration-model';
import {uiFeatures} from './features';

// One compact toolbar at every window size; first use only exposes useful destinations.
export function AppShell(props: {page: Page; view: CollaborationView; title: string; children: ReactNode; firstUse?: boolean; onNavigate: (page: Page) => void; onOpenList: (view: CollaborationView) => void; onBack?: () => void; backLabel?: string; onSearch?: () => void; selectedFeature?: string; onFeatureNavigate?: (id: string) => void}) {
  const isSettings = !['home', 'collaboration'].includes(props.page) || Boolean(props.selectedFeature);
  return <div className="settings-window collaboration-window today-window" data-first-use={props.firstUse || undefined}>
    <header className="today-app-header">
      <button type="button" className="today-brand" onClick={() => props.onNavigate('home')} aria-label="Vonvon Bot 概览" title="Vonvon Bot">
        <img src="./vonvon-logo.png" alt=""/><strong>Vonvon Bot</strong>
      </button>
      {!props.firstUse && <nav className="today-primary-nav" aria-label="主要导航">
        <button type="button" aria-current={props.page === 'home' ? 'page' : undefined} onClick={() => props.onNavigate('home')}>概览</button>
        <button type="button" aria-current={props.page === 'collaboration' && props.view === 'agents' ? 'page' : undefined} onClick={() => props.onOpenList('agents')}>Bot</button>
        <button type="button" aria-current={props.page === 'collaboration' && props.view === 'projects' ? 'page' : undefined} onClick={() => props.onOpenList('projects')}>项目</button>
      </nav>}
      <div className="today-header-actions">
        <button type="button" className="today-icon-button" aria-label="搜索设置、Bot 或项目" title="搜索 · ⌘K" onClick={props.onSearch}><Search size={17} strokeWidth={1.7}/></button>
        <button type="button" className="today-icon-button" aria-label="设置" title="设置" aria-current={isSettings ? 'page' : undefined} onClick={() => props.onNavigate('settings')}><Settings size={17} strokeWidth={1.7}/></button>
      </div>
    </header>
    <main className="settings-main-pane" aria-label={props.title}>
      {props.onBack ? <div className="today-back"><button type="button" onClick={props.onBack} aria-label={props.backLabel}><ArrowLeft size={14}/><span>{props.backLabel?.replace(/^返回\s*/, '') ?? '返回'}</span></button></div> : isSettings && props.page !== 'settings' ? <div className="today-back"><button type="button" onClick={() => props.onNavigate('settings')}><ArrowLeft size={14}/>设置</button></div> : null}
      {uiFeatures.filter(item => item.slot === 'toolbar').map(item => {const Feature = item.component;return <Feature key={item.id}/>;})}
      <div className="settings-content-scroll" id="main-content"><div className="settings-content-page">{props.children}</div></div>
    </main>
  </div>;
}
