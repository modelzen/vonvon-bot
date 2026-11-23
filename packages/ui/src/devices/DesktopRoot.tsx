import {useEffect, useMemo, useState, type ReactNode} from 'react';
import type {VonvonClient} from '@vonvon/client/browser';
import type {DevicesState} from '@vonvon/protocol';
import {App} from '../App';
import {DirectoryPickerProvider} from '../directory-picker';
import {activeDeviceFrom, ClientProvider, LOCAL_ACTIVE_DEVICE, shellForDevice, type ShellCapabilities} from '../client-context';
import {desktopPlatformMark} from './devices-presentation';
import {DeviceConnectionView, DeviceOutsideFrame} from './DeviceConnectionView';
import {MaintenanceView} from './MaintenanceView';
import {PairedToasts} from './PairedToasts';
import {CommunityWindow} from '../community/CommunityWindow';
import {CommunityProvider, useCommunity} from '../community/community-context';
import {AccountProvider} from '../account-context';
import {AccountPageProvider} from '../accounts/account-page';
import './devices.css';

export {desktopPlatformMark, shouldMarkPlatform} from './devices-presentation';
export {OutsideWindow, quitOutsideApp} from './device-bits';

/** devices-ui-1b 4.1: the desktop page, showing one device at a time. */
export function DesktopRoot({fallback, shell, renderApp = () => <App/>}: {fallback: VonvonClient; shell?: ShellCapabilities; renderApp?: () => ReactNode}) {
  const devicesShell = shell?.devices;
  const [state, setState] = useState<DevicesState>();
  useEffect(() => devicesShell?.onState(setState), [devicesShell]);
  const localPlatform = desktopPlatformMark(state);
  useEffect(() => { if (localPlatform) document.documentElement.dataset.desktopPlatform = localPlatform; }, [localPlatform]);
  return <DesktopRootView state={state} fallback={fallback} shell={shell} renderApp={renderApp}/>;
}

/** No effects: tests give it the state. */
export function DesktopRootView({state, fallback, shell, renderApp}: {state?: DevicesState; fallback: VonvonClient; shell?: ShellCapabilities; renderApp: () => ReactNode}) {
  return <AccountProvider account={shell?.account}><AccountPageProvider><CommunityProvider shell={shell?.community}><DesktopDeviceView state={state} fallback={fallback} shell={shell} renderApp={renderApp}/></CommunityProvider></AccountPageProvider></AccountProvider>;
}

function DesktopDeviceView({state, fallback, shell, renderApp}: {state?: DevicesState; fallback: VonvonClient; shell?: ShellCapabilities; renderApp: () => ReactNode}) {
  const devicesShell = shell?.devices;
  const community = useCommunity();
  const device = state ? activeDeviceFrom(state) : LOCAL_ACTIVE_DEVICE;
  const client = useMemo(() => devicesShell ? devicesShell.clientFor(device.id) : fallback, [devicesShell, device.id, fallback]);
  // Kept while the same device stays remote or local, so subscriptions to the shell are not renewed on every state.
  const deviceShell = useMemo(() => shellForDevice(shell, device), [shell, device.isRemote]);
  if (!devicesShell) return <ClientProvider client={fallback} shell={shell}><DirectoryPickerProvider>{renderApp()}</DirectoryPickerProvider></ClientProvider>;
  return <ClientProvider client={client} shell={deviceShell} device={device} devices={state}>
    {community?.isOpen ? <DirectoryPickerProvider><CommunityWindow/></DirectoryPickerProvider> : <DeviceGate key={device.id} state={state} renderApp={renderApp}/>}
    {/* devices-ui-3 4.5: beside the gate, so a pairing with this computer shows whichever device is looked at */}
    <PairedToasts shell={shell} local={!device.isRemote}/>
  </ClientProvider>;
}

export function DeviceGate({state, renderApp}: {state?: DevicesState; renderApp: () => ReactNode}) {
  if (!state) return <DeviceOutsideFrame title="正在打开 Vonvon Bot…">{() => null}</DeviceOutsideFrame>;
  const active = state.active;
  if (active.id !== 'local') {
    if (active.phase === 'connecting' || active.phase === 'failed') return <DeviceConnectionView/>;
    // Ready, or reconnecting after it was: the last mode stays.
    if (active.mode === 'maintenance') return <MaintenanceView/>;
  }
  return <DirectoryPickerProvider>{renderApp()}</DirectoryPickerProvider>;
}
