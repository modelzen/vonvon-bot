import {ArrowUp, LoaderCircle, RotateCw} from 'lucide-react';
import {useShellCapabilities} from './client-context';
import {useDesktopUpdate, useDesktopUpdateOperation} from './desktop-update';
import {useDraftGuard} from './settings/DraftGuard';

/** A quiet action in the persistent toolbar. Downloading never navigates away or steals focus. */
export function DesktopUpdateButton() {
  const shell = useShellCapabilities();
  const store = useDesktopUpdate();
  const [update] = store;
  const {phase, error, run} = useDesktopUpdateOperation(store);
  const guard = useDraftGuard();
  if (!shell?.installDesktopUpdate || !update || !['available', 'downloaded'].includes(update.state)) return null;
  const downloaded = update.state === 'downloaded';
  const percent = update.downloadProgress ? Math.floor(update.downloadProgress.percent) : undefined;
  const busy = phase === 'downloading' || phase === 'installing';
  const label = phase === 'installing' ? '重启中' : phase === 'downloading' ? percent === undefined ? '下载中' : `下载 ${percent}%`
    : error ? '重试' : downloaded ? '重启更新' : '更新';
  const accessibleLabel = phase === 'installing' ? '正在安装并重启' : phase === 'downloading' ? percent === undefined ? '正在下载更新' : `正在下载更新，${percent}%`
    : error ? downloaded ? '重试安装' : '重试下载' : downloaded ? '安装并重启' : '下载更新';
  const version = update.latest ? `v${update.latest}` : '新版本';
  const title = error ? `${error} 点击${downloaded ? '重试安装' : '重试下载'}。`
    : phase === 'installing' ? '正在安装并重启应用，Bot 连接会短暂中断。'
      : phase === 'downloading' ? `正在下载 ${version}${percent === undefined ? '' : `，已完成 ${percent}%`}。下载期间可以继续使用。`
    : downloaded ? `${version} 已验证，点击安装并重启应用。Bot 连接会短暂中断。`
      : `发现新版本 ${version}，点击下载。下载期间可以继续使用。`;
  const install = () => {
    const action = shell.installDesktopUpdate!;
    if (downloaded) guard.navigate(() => void run(action, 'installing'));
    else void run(action, 'downloading');
  };
  const Icon = busy ? LoaderCircle : downloaded ? RotateCw : ArrowUp;
  return <div className="today-update-action" data-error={Boolean(error) || undefined}>
    <button type="button" className="today-update-button" disabled={Boolean(phase)} aria-label={accessibleLabel} aria-busy={busy || undefined}
      title={title} onClick={install}>
      <Icon size={12} strokeWidth={1.8} aria-hidden="true" className={busy ? 'ui-button__spinner' : undefined}/>
      <span>{label}</span>
    </button>
    {error && <span className="today-update-error" role="status">{error}</span>}
  </div>;
}
