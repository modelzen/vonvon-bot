import type {ReactNode} from 'react';
import {ChevronRight,ArrowUpRight} from 'lucide-react';
import {useState} from 'react';
import {Button} from '../reference/components/ui';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {useDraftGuard} from '../settings/DraftGuard';
import type {MachineReply, MachineRequest, MachineRequestHandler, DesktopUpdate} from '@vonvon/protocol';
import '../settings/settings.css';
import './application.css';
import {settingAnchor} from '../search';
import {useShellCapabilities} from '../client-context';
import {openExternalUrl} from '../url-actions';

export function UpdatePanel({request, attached,externalCoreAvailable,version,device,children,advancedSettings}: {request: MachineRequestHandler; attached: boolean; externalCoreAvailable:boolean; version:string;device:string;children:ReactNode;advancedSettings:ReactNode}) {
  const shell = useShellCapabilities();
  const {navigate} = useDraftGuard();
  const [desktop, setDesktop] = useState<DesktopUpdate>();
  const [core, setCore] = useState<Extract<MachineReply, {type: 'coreUpdate'}>>();
  const [desktopMessage, setDesktopMessage] = useState('');
  const [coreMessage, setCoreMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (operation: MachineRequest, channel: 'desktop' | 'core') => {
    setBusy(true);
    const report = channel === 'desktop' ? setDesktopMessage : setCoreMessage;
    try {
      const reply = await request(operation);
      if (reply.type === 'desktopUpdate') setDesktop(reply.update);
      if (reply.type === 'coreUpdate') setCore(reply);
      if (reply.type === 'done') report(reply.message);
      if (reply.type === 'coreUpdateStatus')
        report(reply.status
          ? `${({installing: '正在安装', restarting: '正在重启', done: '更新完成', error: '更新失败'})[reply.status.phase]} ${reply.status.message ?? ''} ${reply.status.from ?? ''} → ${reply.status.to ?? ''}`
          : '尚无更新记录');
    } catch (error) {
      report(error instanceof Error ? error.message : '更新失败');
    } finally {
      setBusy(false);
    }
  };
  const runDesktop = async (operation: () => Promise<DesktopUpdate>) => {
    setBusy(true);
    try { setDesktop(await operation()); setDesktopMessage(''); }
    catch (error) { setDesktopMessage(error instanceof Error ? error.message : '更新失败'); }
    finally { setBusy(false); }
  };
  const desktopState = desktop?.state === 'available' ? '有可用更新'
    : desktop?.state === 'downloaded' ? '已下载，可安装'
      : desktop?.state === 'current' ? '已是最新版本'
        : desktop?.state === 'unavailable' ? '更新源不可用' : '尚未检查';
  return <>
    <section className="application-update-card" aria-label="软件更新" id={settingAnchor('软件更新')}>
      <div className="application-update-main">
        <img className="application-app-icon" src="./vonvon-logo.png" alt=""/>
        <div className="application-app-copy"><strong>Vonvon Bot</strong><span>{device} · v{desktop?.current ?? version}</span></div>
        <Button size="sm" disabled={busy || !shell?.checkDesktopUpdate} onClick={() => {if(shell?.checkDesktopUpdate) void runDesktop(shell.checkDesktopUpdate);}}>检查更新</Button>
      </div>
      <div className="application-update-status">
        <span>{desktopState}{desktop?.latest && desktop.state !== 'current' ? ` · v${desktop.latest}` : ''}</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void openExternalUrl('https://github.com/modelzen/vonvon-bot/releases','releases',shell).catch(error=>setDesktopMessage(error instanceof Error ? error.message : '无法打开发布说明。'))}>发布说明<ArrowUpRight size={12}/></Button>
      </div>
      {desktop?.message && <p className="application-update-message">{desktop.message}</p>}
      {(desktop?.state === 'available' || desktop?.state === 'downloaded') && <div className="application-update-install"><span>{desktop.state === 'downloaded' ? '更新已准备好，安装后将重新打开应用。' : '检查更新不会自动安装。'}</span><Button size="sm" disabled={busy || !shell?.installDesktopUpdate} onClick={() => {const install=shell?.installDesktopUpdate;if(!install)return;if(desktop.state==='downloaded')navigate(()=>void runDesktop(install));else void runDesktop(install);}}>{desktop.state==='downloaded'?'安装并重启':'下载更新'}</Button></div>}
      {desktopMessage && <p className="application-update-error" role="status">{desktopMessage}</p>}
      {!shell?.checkDesktopUpdate && <p className="application-update-message">桌面更新由桌面版提供。</p>}
    </section>
    {!desktop && <p className="application-update-footnote">检查更新不会自动安装。</p>}
    {children}
    <details className="today-advanced-settings application-advanced">
      <summary>高级运行设置<span>{externalCoreAvailable ? '外部程序更新、后台服务与执行程序' : '后台服务与执行程序'}</span><ChevronRight size={14}/></summary>
      <div>
    {externalCoreAvailable && <SettingsGroup id={settingAnchor('外部 Core / CLI')} label="外部 Core / CLI" footer="更新外部 Core 不会更改桌面版本。">
      <SettingsRow title="Core 来源" value={core ? (core.distribution.kind === 'global-npm' ? '全局 npm 安装' : '非全局 npm 安装') : '尚未检查'} />
      {core && <SettingsRow title="当前版本" value={core.current} />}
      {core && <SettingsRow title="可用版本" value={core.latest ?? '更新源不可用'} />}
      <SettingsRow title="检查 Core 更新" trailing={<Button size="sm" disabled={busy} onClick={() => void run({type: 'checkCoreUpdate'}, 'core')}>检查 Core 更新</Button>} />
      <SettingsRow title="更新外部 Core" trailing={<Button size="sm" disabled={busy || !attached || core?.distribution.kind !== 'global-npm' || !core?.hasUpdate} onClick={() => void run({type: 'applyCoreUpdate'}, 'core')}>更新外部 Core</Button>} />
      <SettingsRow title="更新进度" trailing={<Button size="sm" disabled={busy || !attached} onClick={() => void run({type: 'coreUpdateStatus'}, 'core')}>查看 Core 更新进度</Button>} />
      {coreMessage && <p className="settings-operation-message" role="status">{coreMessage}</p>}
    </SettingsGroup>}
    {advancedSettings}
    </div></details>
  </>;
}
