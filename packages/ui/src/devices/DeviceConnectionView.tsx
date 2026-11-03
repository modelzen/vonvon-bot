import {useState, type ReactNode} from 'react';
import type {DeviceRow} from '@vonvon/protocol';
import {deviceCopyName, useActiveDevice, useDevicesState, useShellCapabilities} from '../client-context';
import {Button} from '../reference/components/ui';
import {addBlockedReason, failureCopy, rowView, routeHints} from './devices-presentation';
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
    {current && view && <p className="device-outside-head"><DeviceTile large icon={platformIcon(current.platform)}/><strong>{view.title}</strong><StatusPill tone={view.tone}>{view.status}</StatusPill></p>}
    <h1>{title}</h1>
    {children(repairOf => setDialog(repairOf ? {repairOf} : {}))}
    <footer className="device-outside-foot">
      <div className="device-actions">
        <Button onClick={() => switchTo('local')}>回到这台电脑</Button>
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
  const advice = failure && (failure.attempts.some(entry => entry.route.kind === 'tailscale') || ['refused', 'unreachable', 'timeout'].includes(failure.code));
  return <DeviceOutsideFrame title={failure ? `连不上${name}` : `正在连接${name}…`}>{openAdd => failure && <>
    <Problem><CopyText text={failureCopy(failure.code, name)}/></Problem>
    {failure.attempts.length > 0 && <ul className="device-hints">{routeHints(failure.attempts, name).map((hint, index) => <li key={index}><CopyText text={hint}/></li>)}</ul>}
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
