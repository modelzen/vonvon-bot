import {useState, type ReactNode} from 'react';
import type {DeviceRow} from '@vonvon/protocol';
import {deviceCopyName, useActiveDevice, useDevicesState, useShellCapabilities} from '../client-context';
import {Button} from '../reference/components/ui';
import {addBlockedReason, failureCopy, networkFailure, rowView, routeHints} from './devices-presentation';
import {CopyText, DeviceTile, OutsideWindow, platformIcon, StatusDot, StatusPill, TailscaleAdvice, useNow} from './device-bits';
import {AddDeviceDialog, Problem} from './AddDeviceDialog';

const reportSwitchFailure = (error: unknown) => console.error('Device switch failed', error);

/** devices-ui-1b 4.7: outside App there are no drafts, so switching here does not go through DraftGuard. */
export function DeviceOutsideFrame({title, children}: {title: string; children: (openAdd: (repairOf?: DeviceRow) => void) => ReactNode}) {
  const shell = useShellCapabilities();
  const state = useDevicesState();
  const [dialog, setDialog] = useState<{repairOf?: DeviceRow}>();
  const now = useNow(60_000);
  const switchTo = (id: string) => void shell?.devices?.switchTo(id).catch(reportSwitchFailure);
  const current = state?.devices.find(row => row.current);
  const view = current && rowView(current, now);
  const others = state?.devices.filter(row => row.id !== 'local' && !row.current) ?? [];
  const blocked = state && addBlockedReason(state);
  return <OutsideWindow shell={shell}>
    {current && view && <div className="device-outside-head"><DeviceTile large icon={platformIcon(current.platform)}/>
      <span className="device-outside-head__copy"><strong title={view.title}>{view.title}</strong><StatusPill tone={view.tone}>{view.status}</StatusPill></span>
    </div>}
    <h1>{title}</h1>
    {children(repairOf => setDialog(repairOf ? {repairOf} : {}))}
    <footer className="device-outside-foot">
      <div className="device-actions">
        {current?.id !== 'local' && <Button onClick={() => switchTo('local')}>回到这台电脑</Button>}
        <Button variant="ghost" disabled={Boolean(blocked)} title={blocked} onClick={() => setDialog({})}>添加设备</Button>
      </div>
      {others.length > 0 && <section aria-label="其他设备"><h2>其他设备</h2>
        <ul className="device-compact-list">{others.map(row => <li key={row.id}>
          <button type="button" title={row.name} onClick={() => switchTo(row.id)}><StatusDot tone={rowView(row, now).tone}/><span>{row.name}</span></button>
        </li>)}</ul>
      </section>}
    </footer>
    {dialog && <AddDeviceDialog repairOf={dialog.repairOf} onClose={() => setDialog(undefined)} onSwitch={switchTo}/>}
  </OutsideWindow>;
}

/** Connecting, cannot connect, or stopped on a problem only pairing again fixes. */
export function DeviceConnectionView() {
  const state = useDevicesState();
  const device = useActiveDevice();
  const devices = useShellCapabilities()?.devices;
  const active = state?.active;
  const failure = active?.failure;
  const now = useNow(active?.phase === 'connecting' && failure && active.retryAt !== undefined ? 1000 : undefined);
  if (!state || !active) return null;
  const name = deviceCopyName(device);
  const row = state.devices.find(item => item.id === active.id);
  const retry = () => void devices?.retry().catch(reportSwitchFailure);
  const seconds = active.retryAt === undefined ? 0 : Math.ceil((active.retryAt - now) / 1000);
  const advice = failure && networkFailure(failure.code) &&
    (failure.attempts.some(entry => entry.route.kind === 'tailscale') || ['refused', 'unreachable', 'timeout'].includes(failure.code));
  const hints = failure ? routeHints(failure.attempts, name) : [];
  return <DeviceOutsideFrame title={failure ? `连不上${name}` : `正在连接${name}…`}>{openAdd => failure && <>
    <Problem><CopyText text={failureCopy(failure.code, name)}/></Problem>
    {hints.length > 0 && <ul className="device-hints">{hints.map((hint, index) => <li key={index}><CopyText text={hint}/></li>)}</ul>}
    {active.phase === 'failed'
      ? <div className="device-actions">
        <Button variant="primary" onClick={() => openAdd(row)}>重新配对</Button>
        {(failure.code === 'key_unreadable' || failure.code === 'identity_changed') && <Button onClick={retry}>再试一次</Button>}
      </div>
      : <div className="device-actions">
        <Button variant="primary" onClick={retry}>现在重试</Button>
        {seconds > 0 && <span className="device-muted" role="status">{seconds} 秒后再试一次</span>}
      </div>}
    {advice && <TailscaleAdvice/>}
  </>}</DeviceOutsideFrame>;
}

/** App before its first snapshot. On the desktop a remote device whose snapshot is slow to come, or this computer's daemon
 * that is not connected, keeps the way to the other devices and to 启动 daemon (0.9.0 Mac 验收 B-1, S-4). */
export function SnapshotPendingView() {
  const state = useDevicesState();
  const device = useActiveDevice();
  const shell = useShellCapabilities();
  const local = state?.devices.find(row => row.id === 'local');
  if (!state || !shell?.devices || (!device.isRemote && local?.status === 'online'))
    return <div className="desktop-loading" role="status">正在打开 Vonvon Bot…</div>;
  const name = deviceCopyName(device);
  const retry = () => void shell.devices?.retry().catch(reportSwitchFailure);
  if (device.isRemote) return <DeviceOutsideFrame title={`正在打开${name}…`}>{() => <>
    <p className="device-muted" role="status">还在读取{name}上的数据，网络慢时要多等一会儿。也可以先回到这台电脑。</p>
    {state.active.phase === 'reconnecting' && <div className="device-actions"><Button onClick={retry}>现在重试</Button></div>}
  </>}</DeviceOutsideFrame>;
  return <DeviceOutsideFrame title={local?.status === 'connecting' ? '正在重新连接这台电脑的 daemon…' : '这台电脑的 daemon 没有连上'}>{() => <StartDaemon/>}</DeviceOutsideFrame>;
}

function StartDaemon() {
  const startHost = useShellCapabilities()?.startHost;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (!startHost) return null;
  const start = () => {
    setBusy(true);
    setMessage('');
    void startHost().then(reply => setMessage(reply.type === 'done' ? reply.message : ''),
      error => setMessage(error instanceof Error ? error.message : '没能启动 daemon。')).finally(() => setBusy(false));
  };
  return <>
    <div className="device-actions"><Button variant="primary" disabled={busy} onClick={start}>启动 daemon</Button></div>
    {message && <p className="device-muted" role="status">{message}</p>}
  </>;
}
