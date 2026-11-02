import {ArrowUp, LoaderCircle, RotateCw} from 'lucide-react';
import {useShellCapabilities} from './client-context';
import {useDesktopUpdate, useDesktopUpdateOperation} from './desktop-update';
import {useDraftGuard} from './settings/DraftGuard';

/** What the restart does to the Bots (owner 2026-11-02): it does not wait for them, and there is no question before it. */
export const INTERRUPTS = '重启时正在进行的对话会被中断，卡片上会请发消息的人再发一次。';

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
    : error ? '重试' : downloaded ? '重启升级' : '更新';
  const accessibleLabel = phase === 'installing' ? '正在重启升级' : phase === 'downloading' ? percent === undefined ? '正在下载更新' : `正在下载更新，${percent}%`
    : error ? downloaded ? '重试安装' : '重试下载' : downloaded ? '重启升级' : '下载更新';
  const version = update.latest ? `v${update.latest}` : '新版本';
  const title = error ? `${error} 点击${downloaded ? '重试安装' : '重试下载'}。`
    : phase === 'installing' ? `正在重启升级，${INTERRUPTS}`
      : phase === 'downloading' ? `正在下载 ${version}${percent === undefined ? '' : `，已完成 ${percent}%`}。下载期间可以继续使用。`
    : downloaded ? `${version} 已下载并验证，点击重启升级。${INTERRUPTS}`
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
