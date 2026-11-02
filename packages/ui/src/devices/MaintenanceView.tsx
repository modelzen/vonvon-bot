import {deviceCopyName, useActiveDevice, useDevicesState, useShellCapabilities} from '../client-context';
import {DesktopUpdateButton} from '../DesktopUpdateButton';
import {DesktopUpdateProvider, useDesktopUpdate, useDesktopUpdateOperation} from '../desktop-update';
import {Button} from '../reference/components/ui';
import {DraftGuardProvider} from '../settings/DraftGuard';
import {cannotUpgradeRemotely, versionNotice} from './devices-presentation';
import {DeviceOutsideFrame} from './DeviceConnectionView';

function ClientUpdateAction() {
  const shell = useShellCapabilities();
  const {phase, error, run} = useDesktopUpdateOperation(useDesktopUpdate());
  return <div className="device-actions">
    <DesktopUpdateButton/>
    {shell?.checkDesktopUpdate && <Button disabled={Boolean(phase)} onClick={() => void run(shell.checkDesktopUpdate!, 'checking')}>检查更新</Button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}

/** devices-ui-1b 4.7: another protocol, so only the device list and the upgrade stay. The server's own upgrade card is
 * U2's (`ServerUpdateCard`, with `maintenanceRequest`); until then an old server gets the words only. */
export function MaintenanceView() {
  const state = useDevicesState();
  const device = useActiveDevice();
  const name = deviceCopyName(device);
  const info = state?.active.serverInfo;
  const notice = state && info ? versionNotice({
    serverVersion: info.version, serverProtocol: info.protocolVersion, clientVersion: state.client.version, clientProtocol: state.client.protocolVersion,
    ...(info.capabilities ? {capabilities: info.capabilities} : {}), name,
  }) : null;
  return <DeviceOutsideFrame title={`${name}和这台电脑的版本不能一起工作`}>{() => notice && <>
    <p>{notice.text}</p>
    {notice.side === 'client' && <DraftGuardProvider><DesktopUpdateProvider><ClientUpdateAction/></DesktopUpdateProvider></DraftGuardProvider>}
    {notice.side === 'server' && info?.capabilities && !notice.action && <p>{cannotUpgradeRemotely(name)}</p>}
  </>}</DeviceOutsideFrame>;
}
