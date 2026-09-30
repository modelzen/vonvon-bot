import type {ReactNode} from 'react';
import {Activity,Coffee,Bot,MessageSquare,MonitorCog,Search,Stethoscope,Wrench} from 'lucide-react';
import {SettingsToolbar} from './reference/components/system-settings';
import type {CollaborationView,Page} from './collaboration-model';

export function AppShell(props:{page:Page;view:CollaborationView;title:string;children:ReactNode;onNavigate:(page:Page)=>void;onOpenList:(view:CollaborationView)=>void;onBack?:()=>void;backLabel?:string;onSearch?:()=>void}){
  const lists=[{id:'agents',label:'Agent',icon:Bot},{id:'groups',label:'群聊',icon:MessageSquare}] as const;
  const settings=[{id:'coffee',label:'咖啡一下',icon:Coffee},{id:'usage',label:'用量',icon:Activity},{id:'environment',label:'本机环境',icon:Wrench},{id:'application',label:'应用与启动',icon:MonitorCog},{id:'diagnostics',label:'状态与诊断',icon:Stethoscope}] as const;
  return <div className="settings-window collaboration-window">
    <aside aria-label="应用侧栏" className="settings-sidebar">
      <div className="settings-sidebar-drag-region" aria-hidden="true"/>
      <button className="settings-account-row" aria-label="查看这台设备" onClick={()=>props.onNavigate('application')}><span className="settings-account-row__avatar"><img alt="" src="./vonvon-logo.png"/></span><span className="settings-account-row__copy"><strong>Vonvon Bot</strong><small>本地使用 · 无需登录</small></span></button>
      <button className="settings-sidebar-item" onClick={props.onSearch} aria-label="搜索设置、Agent 或项目"><Search size={14}/><span>搜索</span><small>⌘K</small></button>
      <nav aria-label="主要导航" className="collaboration-primary-nav">
        {lists.map(item=>{const Icon=item.icon;const selected=props.page==='collaboration'&&props.view===item.id;return <button key={item.id} className={`settings-sidebar-item ${selected?'is-selected':''}`} aria-current={selected?'page':undefined} onClick={()=>props.onOpenList(item.id)}><span className={`settings-sidebar-icon settings-sidebar-icon--${item.id}`}><Icon size={14}/></span><span>{item.label}</span></button>})}
      </nav>
      <nav aria-label="这台设备" className="collaboration-device-nav">{settings.map(item=>{const Icon=item.icon;return <button key={item.id} className={`settings-sidebar-item ${props.page===item.id?'is-selected':''}`} aria-current={props.page===item.id?'page':undefined} onClick={()=>props.onNavigate(item.id)}><span className={`settings-sidebar-icon settings-sidebar-icon--${item.id}`}><Icon size={14}/></span><span>{item.label}</span></button>})}</nav>
    </aside>
    <main className="settings-main-pane" aria-label={props.title}><SettingsToolbar className="settings-toolbar" title={props.title} onBack={props.onBack} backLabel={props.backLabel}/><div className="settings-content-scroll" id="main-content"><div className="settings-content-page">{props.children}</div></div></main>
  </div>;
}
