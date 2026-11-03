import {useState} from 'react';
import {X} from 'lucide-react';
import {deviceCopyName, useActiveDevice, useDevicesState, useShellCapabilities} from '../client-context';
import {Button, IconButton, InlineNotice} from '../reference/components/ui';
import {bannerCopy, versionNotice} from './devices-presentation';
import {CopyText, useNow} from './device-bits';

/** devices-ui-1b 4.8: on top of App's page while a remote device is shown, one line about its connection. */
export function DeviceStatusBanner() {
  const state = useDevicesState();
  const device = useActiveDevice();
  const devices = useShellCapabilities()?.devices;
  const [dismissed, setDismissed] = useState<number>();
  const active = state?.active;
  const now = useNow(device.isRemote && active?.phase === 'reconnecting' && active.retryAt !== undefined ? 1000 : undefined);
  if (!device.isRemote || !active) return null;
  const banner = bannerCopy(active, deviceCopyName(device), now);
  if (!banner || (banner.noticeAt !== undefined && banner.noticeAt === dismissed)) return null;
  return <InlineNotice className="device-banner" title={banner.retry ? '连接断了' : '已重新连上'} tone={banner.retry ? 'warning' : 'info'} actions={banner.retry
    ? <Button size="sm" onClick={() => void devices?.retry().catch(error => console.error('Device retry failed', error))}>现在重试</Button>
    : <IconButton label="关闭提示" onClick={() => setDismissed(banner.noticeAt)}><X size={14}/></IconButton>}>
    <CopyText text={banner.text}/>
    {banner.hints.map((hint, index) => <span key={index} className="device-hint"><CopyText text={hint}/></span>)}
  </InlineNotice>;
}

/** Closed for this run, per device and the two versions. */
const dismissedVersions = new Set<string>();
/** Another version with the same protocol: said, never in the way (devices 4.6). */
export function DeviceVersionNotice({onUpgrade}: {onUpgrade: () => void}) {
  const state = useDevicesState();
  const device = useActiveDevice();
  const [, setClosed] = useState(0);
  const info = state?.active.serverInfo;
  if (!device.isRemote || !state || !info || state.active.phase !== 'ready' || state.active.mode !== 'full') return null;
  const key = `${device.id}|${info.version}|${state.client.version}`;
  const name = deviceCopyName(device);
  const notice = versionNotice({
    serverVersion: info.version, serverProtocol: info.protocolVersion, clientVersion: state.client.version, clientProtocol: state.client.protocolVersion,
    ...(info.capabilities ? {capabilities: info.capabilities} : {}), name,
  });
  if (!notice || dismissedVersions.has(key)) return null;
  return <InlineNotice className="device-banner" title="版本不一致" tone="info" actions={<>
    {notice.action && <Button size="sm" onClick={onUpgrade}>{notice.action === 'upgrade-server' ? `升级${name}` : '去更新'}</Button>}
    <IconButton label="关闭提示" onClick={() => { dismissedVersions.add(key); setClosed(count => count + 1); }}><X size={14}/></IconButton>
  </>}>{notice.text}</InlineNotice>;
}
