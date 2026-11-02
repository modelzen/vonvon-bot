import {useEffect, useState, type ReactNode} from 'react';
import {RpcError} from '@vonvon/client/browser';
import {coreUpdateStatusText, type CoreUpdateStatus, type MachineReply, type MachineRequest, type MachineRequestHandler} from '@vonvon/protocol';
import {Button} from '../reference/components/ui';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {settingAnchor} from '../search';
import type {ActiveDevice} from '../client-context';
import {whereName} from '../device-copy';

export type CoreUpdate = Extract<MachineReply, {type: 'coreUpdate'}>;
/** Installs whose daemon updates itself (devices 6.5): the standalone server and the global npm package. `bundled` is U4's. */
export const coreUpdatable = (kind: string | undefined): boolean => kind === 'standalone' || kind === 'global-npm';
export const canApplyCoreUpdate = (core: CoreUpdate | undefined): boolean => Boolean(core && coreUpdatable(core.distribution.kind) && core.hasUpdate);
/** A rollback that its message does not mention says where it went back to, as `vonvon update` does. */
const wentBack = (status: CoreUpdateStatus): string =>
  status.phase === 'error' && status.rolledBack && status.previous && !status.message?.includes('已切回') ? `（已切回 ${status.previous}）` : '';
export const coreStatusLine = (status: CoreUpdateStatus | null): string =>
  status ? `${coreUpdateStatusText(status)}${wentBack(status)}${status.from && status.to ? ` · ${status.from} → ${status.to}` : ''}` : '尚无更新记录';
const ended = (status: CoreUpdateStatus | null | undefined): boolean => status?.phase === 'done' || status?.phase === 'error';
// No record is nothing to follow: following it would keep the update button off for good (review 207).
const running = (status: CoreUpdateStatus | null): boolean => status !== null && !ended(status);

/** How the device's server was installed (devices-ui-2 4.4.2). */
export const DISTRIBUTION_LABEL: Record<string, string> = {standalone: '独立安装的服务端', 'global-npm': '全局 npm 安装', bundled: '桌面端自带'};
export const distributionLabel = (kind: string): string => DISTRIBUTION_LABEL[kind] ?? '其他安装方式';
/** A daemon from before I3 does not know `checkCoreUpdate`. */
const unknownRequest = (error: unknown): boolean => error instanceof RpcError && (error.code === 'unsupported' || error.code === 'invalid_request');

export const bundledServerText = (name: string): string => `${name}的服务端是桌面端自带的，在那台电脑上的 Vonvon Bot 里更新。`;
export const remoteUpdateUnsupportedText = (name: string): string => `${name}上的 Vonvon Bot 不支持远程更新，请在那台设备上升级一次。`;

/** The server's update, moved out of I3's `UpdatePanel`: in 高级运行设置 on this computer, and as 「X」的服务端 on the
 * 应用与启动 page and the maintenance view of a remote device. */
export function ServerUpdateCard({request, variant, where, bundled, disabled = false}: {
  request: MachineRequestHandler;
  variant: 'local-advanced' | 'remote';
  where: Pick<ActiveDevice, 'isRemote' | 'name' | 'version'>;
  /** U4: the button for a server the desktop app carries. Without it a bundled server gets the words only. */
  bundled?: (core: CoreUpdate, run: (operation: MachineRequest) => Promise<void>) => ReactNode;
  /** The desktop app's own update is running. */
  disabled?: boolean;
}) {
  const [core, setCore] = useState<CoreUpdate>();
  const [status, setStatus] = useState<CoreUpdateStatus | null>();
  const [following, setFollowing] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  // An update answers at once and runs on; its progress is read until it ends.
  useEffect(() => {
    if (!following) return;
    let active = true;
    const timer = setInterval(() => void request({type: 'coreUpdateStatus'}).then(reply => {
      if (!active || reply.type !== 'coreUpdateStatus') return;
      setStatus(reply.status);
      if (!running(reply.status)) setFollowing(false);
    }, () => undefined), 1000);
    return () => {active = false; clearInterval(timer);};
  }, [following, request]);
  const run = async (operation: MachineRequest): Promise<void> => {
    setBusy(true);
    try {
      const reply = await request(operation);
      if (reply.type === 'coreUpdate') setCore(reply);
      if (reply.type === 'done') setMessage(reply.message);
      // U4's bundled update is followed the same way, so this no longer asks for standalone.
      if (reply.type === 'done' && operation.type === 'applyCoreUpdate') setFollowing(true);
      if (reply.type === 'coreUpdateStatus') { setStatus(reply.status); setMessage(''); if (running(reply.status)) setFollowing(true); }
    } catch (error) {
      if (variant === 'remote' && operation.type === 'checkCoreUpdate' && unknownRequest(error)) setUnsupported(true);
      else setMessage(error instanceof Error ? error.message : '更新失败');
    } finally {
      setBusy(false);
    }
  };
  // The remote card reads the device's daily check once, without asking the update source again, and the update the
  // device is on (review 246-1): one started before this card opened, from this page or another client, is followed again
  // with its button off; one that ended shows how (the new version, or why it failed or went back).
  useEffect(() => {
    if (variant !== 'remote') return;
    let open = true;
    void run({type: 'checkCoreUpdate', fresh: false});
    void request({type: 'coreUpdateStatus'}).then(reply => {
      if (!open || reply.type !== 'coreUpdateStatus' || !reply.status) return;
      setStatus(current => current === undefined ? reply.status : current);
      if (running(reply.status)) setFollowing(true);
    }, () => undefined);
    return () => { open = false; };
  }, []);
  const off = busy || disabled;
  const progress = status?.progress && !ended(status) && <progress className="application-update-progress" max={status.progress.total} value={status.progress.transferred} aria-label="Core 更新下载进度"/>;
  const statusLine = status !== undefined && <p className="settings-operation-message" role="status">{coreStatusLine(status)}</p>;
  const messageLine = message && <p className="settings-operation-message" role="status">{message}</p>;

  if (variant === 'local-advanced') return <SettingsGroup id={settingAnchor('外部 Core / CLI')} label="外部 Core / CLI" footer="更新外部 Core 不会更改桌面版本。">
    <SettingsRow title="Core 来源" value={core ? (core.distribution.kind === 'global-npm' ? '全局 npm 安装' : core.distribution.kind === 'standalone' ? '独立安装的服务端' : '非全局 npm 安装') : '尚未检查'} />
    {core && <SettingsRow title="当前版本" value={core.current} />}
    {core && <SettingsRow title="可用版本" value={core.latest ?? '更新源不可用'} />}
    <SettingsRow title="检查 Core 更新" trailing={<Button size="sm" disabled={off} onClick={() => void run({type: 'checkCoreUpdate'})}>检查 Core 更新</Button>} />
    <SettingsRow title="更新外部 Core" trailing={<Button size="sm" disabled={off || following || !canApplyCoreUpdate(core)} onClick={() => void run({type: 'applyCoreUpdate'})}>更新外部 Core</Button>} />
    <SettingsRow title="更新进度" trailing={<Button size="sm" disabled={off} onClick={() => void run({type: 'coreUpdateStatus'})}>查看 Core 更新进度</Button>} />
    {progress}{statusLine}{messageLine}
  </SettingsGroup>;

  const name = whereName(where);
  const isBundled = core?.distribution.kind === 'bundled';
  return <SettingsGroup id={settingAnchor('服务端')} label={`${name}的服务端`}>
    <SettingsRow title="版本" value={core?.current ?? where.version ?? '未知'} />
    {!unsupported && <SettingsRow title="安装方式" value={core ? distributionLabel(core.distribution.kind) : '尚未检查'} />}
    {core && !unsupported && <SettingsRow title="可用版本" value={core.latest ?? '更新源不可用'} />}
    {unsupported ? <p className="settings-operation-message" role="note">{remoteUpdateUnsupportedText(name)}</p>
      : <SettingsRow title="更新" trailing={<span className="settings-inline-actions">
        <Button size="sm" disabled={off} onClick={() => void run({type: 'checkCoreUpdate'})}>检查更新</Button>
        {canApplyCoreUpdate(core) && <Button size="sm" variant="primary" disabled={off || following} onClick={() => void run({type: 'applyCoreUpdate'})}>更新{name}</Button>}
      </span>} />}
    {!unsupported && isBundled && core && (bundled ? bundled(core, run) : <p className="settings-operation-message" role="note">{bundledServerText(name)}</p>)}
    {progress}{statusLine}{messageLine}
  </SettingsGroup>;
}
