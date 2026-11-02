import type {ReactNode} from 'react';
import {ChevronRight,ArrowUpRight} from 'lucide-react';
import {useState} from 'react';
import {useDesktopUpdate, useDesktopUpdateOperation} from '../desktop-update';
import {INTERRUPTS} from '../DesktopUpdateButton';
import {Button} from '../reference/components/ui';
import {useDraftGuard} from '../settings/DraftGuard';
import type {MachineRequestHandler} from '@vonvon/protocol';
import '../settings/settings.css';
import './application.css';
import {settingAnchor} from '../search';
import {LOCAL_ACTIVE_DEVICE, useShellCapabilities, type ActiveDevice} from '../client-context';
import {hostTitle} from '../device-copy';
import {ServerUpdateCard} from './ServerUpdateCard';
import {changelogUrl, downloadPageUrl, openExternalUrl} from '../url-actions';

export {canApplyCoreUpdate, coreStatusLine, coreUpdatable} from './ServerUpdateCard';

/** devices-ui-2 4.4.1: on a remote device the app card is this computer's app. The snapshot is the other device's, so its
 * version is not this app's; the shell's own version (`DevicesState.client.version`) is. */
export function appCardFor(device: Pick<ActiveDevice, 'isRemote'>, application: {platform: string; version: string}, clientVersion: string | undefined): {appTitle?: string; device: string; version: string} {
  return device.isRemote ? {appTitle: '这台电脑上的 Vonvon Bot 应用', device: '这台电脑', version: clientVersion ?? application.version}
    : {device: hostTitle(application.platform), version: application.version};
}

/** `attached` no longer gates anything (devices 6.5): a standalone daemon is never one the desktop app attached to.
 * devices-ui-2 4.4.1: on a remote device the app card is this computer's (`appTitle`, `device`, `version`) and `server`
 * is that device's `ServerUpdateCard`. */
export function UpdatePanel({request, externalCoreAvailable,version,device,children,advancedSettings,appTitle = 'Vonvon Bot',server}: {request: MachineRequestHandler; attached?: boolean; externalCoreAvailable:boolean; version:string;device:string;children:ReactNode;advancedSettings:ReactNode;appTitle?: string;server?: ReactNode}) {
  const shell = useShellCapabilities();
  const {navigate} = useDraftGuard();
  const desktopStore = useDesktopUpdate();
  const [desktop, setDesktop] = desktopStore;
  const desktopOperation = useDesktopUpdateOperation(desktopStore);
  const [desktopMessage, setDesktopMessage] = useState('');
  const busy = Boolean(desktopOperation.phase);
  const percent = desktop?.downloadProgress ? Math.floor(desktop.downloadProgress.percent) : undefined;
  const desktopState = desktopOperation.phase === 'downloading' ? percent === undefined ? '正在下载更新…' : `正在下载更新 · ${percent}%`
    : desktopOperation.phase === 'installing' ? '正在重启升级…'
    : desktop?.state === 'available' ? '有可用更新'
    : desktop?.state === 'downloaded' ? '已下载并验证'
      : desktop?.state === 'current' ? '已是最新版本'
        : desktop?.state === 'install-pending' ? '上次安装未生效'
          : desktop?.state === 'unavailable' ? '更新源不可用' : '尚未检查';
  const openPage = (url: string, kind: 'releases' | 'download', failure: string) =>
    void openExternalUrl(url, kind, shell).catch(error => setDesktopMessage(error instanceof Error ? error.message : failure));
  return <>
    <section className="application-update-card" aria-label="软件更新" id={settingAnchor('软件更新')}>
      <div className="application-update-main">
        <img className="application-app-icon" src="./vonvon-logo.png" alt=""/>
        <div className="application-app-copy"><strong>{appTitle}</strong><span>{device} · v{desktop?.current ?? version}</span></div>
        <Button size="sm" disabled={busy || !shell?.checkDesktopUpdate} onClick={() => {if(shell?.checkDesktopUpdate) void desktopOperation.run(shell.checkDesktopUpdate, 'checking');}}>检查更新</Button>
      </div>
      <div className="application-update-status">
        <span>{desktopState}{desktop?.latest && desktop.state !== 'current' ? ` · v${desktop.latest}` : ''}</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => openPage(changelogUrl,'releases','无法打开发布说明。')}>发布说明<ArrowUpRight size={12}/></Button>
      </div>
      {desktopOperation.phase === 'downloading' && <progress className="application-update-progress" max={100} value={percent} aria-label="更新下载进度"/>}
      {desktop?.message && <p className="application-update-message">{desktop.message}</p>}
      {desktop?.releaseNotes && <p className="application-update-message application-update-notes">{desktop.releaseNotes}</p>}
      {(desktop?.state === 'available' || desktop?.state === 'downloaded') && <div className="application-update-install"><span>{desktop.state === 'downloaded' ? `更新已下载。${INTERRUPTS}升级完自动重新打开应用。` : '下载期间可以继续使用，下载后由你决定何时重启升级。'}</span><Button size="sm" disabled={busy || !shell?.installDesktopUpdate} onClick={() => {const install=shell?.installDesktopUpdate;if(!install)return;if(desktop.state==='downloaded')navigate(()=>void desktopOperation.run(install, 'installing'));else void desktopOperation.run(install, 'downloading');}}>{desktopOperation.error ? desktop.state==='downloaded'?'重试安装':'重试下载' : desktop.state==='downloaded'?'重启升级':'下载更新'}</Button></div>}
      {desktop?.state === 'install-pending' && <div className="application-update-install"><span>可以重试，或者到官网重新下载安装。</span><div className="application-update-actions"><Button size="sm" disabled={busy || !shell?.retryDesktopUpdate} onClick={() => {if(shell?.retryDesktopUpdate) void desktopOperation.run(shell.retryDesktopUpdate, 'checking');}}>重试</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => openPage(downloadPageUrl,'download','无法打开下载页。')}>手动下载<ArrowUpRight size={12}/></Button></div></div>}
      {desktopOperation.error && <p className="application-update-error" role="status">{desktopOperation.error}</p>}
      {desktopMessage && <p className="application-update-error" role="status">{desktopMessage}</p>}
      {!shell?.checkDesktopUpdate && <p className="application-update-message">桌面更新由桌面版提供。</p>}
    </section>
    {!desktop && <p className="application-update-footnote">检查更新不会自动安装。</p>}
    {server}
    {children}
    <details className="today-advanced-settings application-advanced">
      <summary>高级运行设置<span>{externalCoreAvailable ? '外部程序更新、后台服务与执行程序' : '后台服务与执行程序'}</span><ChevronRight size={14}/></summary>
      <div>
    {externalCoreAvailable && <ServerUpdateCard variant="local-advanced" request={request} where={LOCAL_ACTIVE_DEVICE} disabled={busy}/>}
    {advancedSettings}
    </div></details>
  </>;
}
