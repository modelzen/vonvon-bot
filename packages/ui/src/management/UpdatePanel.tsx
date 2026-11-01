import type {ReactNode} from 'react';
import {ChevronRight,ArrowUpRight} from 'lucide-react';
import {useEffect, useState} from 'react';
import {useDesktopUpdate, useDesktopUpdateOperation} from '../desktop-update';
import {Button} from '../reference/components/ui';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {useDraftGuard} from '../settings/DraftGuard';
import {coreUpdateStatusText, type CoreUpdateStatus, type MachineReply, type MachineRequest, type MachineRequestHandler} from '@vonvon/protocol';
import '../settings/settings.css';
import './application.css';
import {settingAnchor} from '../search';
import {useShellCapabilities} from '../client-context';
import {changelogUrl, downloadPageUrl, openExternalUrl} from '../url-actions';

type CoreUpdate = Extract<MachineReply, {type: 'coreUpdate'}>;
/** Installs whose daemon updates itself (devices 6.5): the standalone server and the global npm package. `bundled` is U4's. */
export const coreUpdatable = (kind: string | undefined): boolean => kind === 'standalone' || kind === 'global-npm';
export const canApplyCoreUpdate = (core: CoreUpdate | undefined): boolean => Boolean(core && coreUpdatable(core.distribution.kind) && core.hasUpdate);
export const coreStatusLine = (status: CoreUpdateStatus | null): string =>
  status ? `${coreUpdateStatusText(status)}${status.from && status.to ? ` · ${status.from} → ${status.to}` : ''}` : '尚无更新记录';
const ended = (status: CoreUpdateStatus | null | undefined): boolean => status?.phase === 'done' || status?.phase === 'error';

/** `attached` no longer gates anything (devices 6.5): a standalone daemon is never one the desktop app attached to. */
export function UpdatePanel({request, externalCoreAvailable,version,device,children,advancedSettings}: {request: MachineRequestHandler; attached?: boolean; externalCoreAvailable:boolean; version:string;device:string;children:ReactNode;advancedSettings:ReactNode}) {
  const shell = useShellCapabilities();
  const {navigate} = useDraftGuard();
  const desktopStore = useDesktopUpdate();
  const [desktop, setDesktop] = desktopStore;
  const desktopOperation = useDesktopUpdateOperation(desktopStore);
  const [core, setCore] = useState<CoreUpdate>();
  const [coreStatus, setCoreStatus] = useState<CoreUpdateStatus | null>();
  const [following, setFollowing] = useState(false);
  // A standalone update answers at once and runs on; its progress is read until it ends.
  useEffect(() => {
    if (!following) return;
    let active = true;
    const timer = setInterval(() => void request({type: 'coreUpdateStatus'}).then(reply => {
      if (!active || reply.type !== 'coreUpdateStatus') return;
      setCoreStatus(reply.status);
      if (ended(reply.status)) setFollowing(false);
    }, () => undefined), 1000);
    return () => {active = false; clearInterval(timer);};
  }, [following, request]);
  const [desktopMessage, setDesktopMessage] = useState('');
  const [coreMessage, setCoreMessage] = useState('');
  const [coreBusy, setBusy] = useState(false);
  const busy = coreBusy || Boolean(desktopOperation.phase);
  const run = async (operation: MachineRequest, channel: 'desktop' | 'core') => {
    setBusy(true);
    const report = channel === 'desktop' ? setDesktopMessage : setCoreMessage;
    try {
      const reply = await request(operation);
      if (reply.type === 'desktopUpdate') setDesktop(reply.update);
      if (reply.type === 'coreUpdate') setCore(reply);
      if (reply.type === 'done') report(reply.message);
      if (reply.type === 'done' && operation.type === 'applyCoreUpdate' && core?.distribution.kind === 'standalone') setFollowing(true);
      if (reply.type === 'coreUpdateStatus') { setCoreStatus(reply.status); report(''); if (!ended(reply.status)) setFollowing(true); }
    } catch (error) {
      report(error instanceof Error ? error.message : '更新失败');
    } finally {
      setBusy(false);
    }
  };
  const percent = desktop?.downloadProgress ? Math.floor(desktop.downloadProgress.percent) : undefined;
  const desktopState = desktopOperation.phase === 'downloading' ? percent === undefined ? '正在下载更新…' : `正在下载更新 · ${percent}%`
    : desktopOperation.phase === 'installing' ? '正在安装并重启…'
    : desktop?.state === 'available' ? '有可用更新'
    : desktop?.state === 'downloaded' ? '已验证，可安装'
      : desktop?.state === 'current' ? '已是最新版本'
        : desktop?.state === 'install-pending' ? '上次安装未生效'
          : desktop?.state === 'unavailable' ? '更新源不可用' : '尚未检查';
  const openPage = (url: string, kind: 'releases' | 'download', failure: string) =>
    void openExternalUrl(url, kind, shell).catch(error => setDesktopMessage(error instanceof Error ? error.message : failure));
  return <>
    <section className="application-update-card" aria-label="软件更新" id={settingAnchor('软件更新')}>
      <div className="application-update-main">
        <img className="application-app-icon" src="./vonvon-logo.png" alt=""/>
        <div className="application-app-copy"><strong>Vonvon Bot</strong><span>{device} · v{desktop?.current ?? version}</span></div>
        <Button size="sm" disabled={busy || !shell?.checkDesktopUpdate} onClick={() => {if(shell?.checkDesktopUpdate) void desktopOperation.run(shell.checkDesktopUpdate, 'checking');}}>检查更新</Button>
      </div>
      <div className="application-update-status">
        <span>{desktopState}{desktop?.latest && desktop.state !== 'current' ? ` · v${desktop.latest}` : ''}</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => openPage(changelogUrl,'releases','无法打开发布说明。')}>发布说明<ArrowUpRight size={12}/></Button>
      </div>
      {desktopOperation.phase === 'downloading' && <progress className="application-update-progress" max={100} value={percent} aria-label="更新下载进度"/>}
      {desktop?.message && <p className="application-update-message">{desktop.message}</p>}
      {desktop?.releaseNotes && <p className="application-update-message application-update-notes">{desktop.releaseNotes}</p>}
      {(desktop?.state === 'available' || desktop?.state === 'downloaded') && <div className="application-update-install"><span>{desktop.state === 'downloaded' ? '更新已验证。安装会短暂中断 Bot 连接，完成后自动重新打开应用；也可以稍后安装。' : '下载期间可以继续使用，下载后由你决定何时安装。'}</span><Button size="sm" disabled={busy || !shell?.installDesktopUpdate} onClick={() => {const install=shell?.installDesktopUpdate;if(!install)return;if(desktop.state==='downloaded')navigate(()=>void desktopOperation.run(install, 'installing'));else void desktopOperation.run(install, 'downloading');}}>{desktopOperation.error ? desktop.state==='downloaded'?'重试安装':'重试下载' : desktop.state==='downloaded'?'安装并重启':'下载更新'}</Button></div>}
      {desktop?.state === 'install-pending' && <div className="application-update-install"><span>可以重试，或者到官网重新下载安装。</span><div className="application-update-actions"><Button size="sm" disabled={busy || !shell?.retryDesktopUpdate} onClick={() => {if(shell?.retryDesktopUpdate) void desktopOperation.run(shell.retryDesktopUpdate, 'checking');}}>重试</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => openPage(downloadPageUrl,'download','无法打开下载页。')}>手动下载<ArrowUpRight size={12}/></Button></div></div>}
      {desktopOperation.error && <p className="application-update-error" role="status">{desktopOperation.error}</p>}
      {desktopMessage && <p className="application-update-error" role="status">{desktopMessage}</p>}
      {!shell?.checkDesktopUpdate && <p className="application-update-message">桌面更新由桌面版提供。</p>}
    </section>
    {!desktop && <p className="application-update-footnote">检查更新不会自动安装。</p>}
    {children}
    <details className="today-advanced-settings application-advanced">
      <summary>高级运行设置<span>{externalCoreAvailable ? '外部程序更新、后台服务与执行程序' : '后台服务与执行程序'}</span><ChevronRight size={14}/></summary>
      <div>
    {externalCoreAvailable && <SettingsGroup id={settingAnchor('外部 Core / CLI')} label="外部 Core / CLI" footer="更新外部 Core 不会更改桌面版本。">
      <SettingsRow title="Core 来源" value={core ? (core.distribution.kind === 'global-npm' ? '全局 npm 安装' : core.distribution.kind === 'standalone' ? '独立安装的服务端' : '非全局 npm 安装') : '尚未检查'} />
      {core && <SettingsRow title="当前版本" value={core.current} />}
      {core && <SettingsRow title="可用版本" value={core.latest ?? '更新源不可用'} />}
      <SettingsRow title="检查 Core 更新" trailing={<Button size="sm" disabled={busy} onClick={() => void run({type: 'checkCoreUpdate'}, 'core')}>检查 Core 更新</Button>} />
      <SettingsRow title="更新外部 Core" trailing={<Button size="sm" disabled={busy || following || !canApplyCoreUpdate(core)} onClick={() => void run({type: 'applyCoreUpdate'}, 'core')}>更新外部 Core</Button>} />
      <SettingsRow title="更新进度" trailing={<Button size="sm" disabled={busy} onClick={() => void run({type: 'coreUpdateStatus'}, 'core')}>查看 Core 更新进度</Button>} />
      {coreStatus?.progress && !ended(coreStatus) && <progress className="application-update-progress" max={coreStatus.progress.total} value={coreStatus.progress.transferred} aria-label="Core 更新下载进度"/>}
      {coreStatus !== undefined && <p className="settings-operation-message" role="status">{coreStatusLine(coreStatus)}</p>}
      {coreMessage && <p className="settings-operation-message" role="status">{coreMessage}</p>}
    </SettingsGroup>}
    {advancedSettings}
    </div></details>
  </>;
}
