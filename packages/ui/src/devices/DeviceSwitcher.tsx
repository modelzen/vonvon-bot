import {useEffect, useRef, useState} from 'react';
import {ChevronDown} from 'lucide-react';
import type {DevicesState} from '@vonvon/protocol';
import {useDevicesState, useShellCapabilities} from '../client-context';
import {useDraftGuard} from '../settings/DraftGuard';
import {rowView} from './devices-presentation';
import {StatusDot, useNow} from './device-bits';

const reportSwitchFailure = (error: unknown) => console.error('Device switch failed', error);

export function DeviceSwitcherMenu({state, now, onPick, onManage}: {state: DevicesState; now: number; onPick: (id: string) => void; onManage: () => void}) {
  return <div className="device-switcher__menu" role="menu">
    {state.devices.map(row => <button type="button" role="menuitem" key={row.id} onClick={() => onPick(row.id)}>
      <StatusDot tone={rowView(row, now).tone}/><span>{rowView(row, now).title}</span>{row.current && <small>当前</small>}
    </button>)}
    <button type="button" role="menuitem" onClick={onManage}>管理设备…</button>
  </div>;
}

/** devices-ui-1b 4.4: beside the search button once another device was added. Switching goes through DraftGuard. */
export function DeviceSwitcher({onManage}: {onManage: () => void}) {
  const state = useDevicesState();
  const devices = useShellCapabilities()?.devices;
  const {navigate} = useDraftGuard();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const now = useNow(open ? 60_000 : undefined);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  if (!state || !devices || state.devices.length <= 1) return null;
  const current = state.devices.find(row => row.current) ?? state.devices[0]!;
  const view = rowView(current, now);
  return <div className="device-switcher" ref={root}>
    <button type="button" className="device-switcher__button" aria-haspopup="menu" aria-expanded={open} aria-label={`当前设备：${view.title}，点击切换`} onClick={() => setOpen(value => !value)}>
      <StatusDot tone={view.tone}/><span>{view.title}</span><ChevronDown size={13} aria-hidden="true"/>
    </button>
    {open && <DeviceSwitcherMenu state={state} now={now}
      onPick={id => { setOpen(false); if (id !== current.id) navigate(() => void devices.switchTo(id).catch(reportSwitchFailure)); }}
      onManage={() => { setOpen(false); onManage(); }}/>}
  </div>;
}
