import {useEffect, useRef, useState} from 'react';
import {ChevronDown, Settings2} from 'lucide-react';
import type {DevicesState} from '@vonvon/protocol';
import {useDevicesState, useShellCapabilities} from '../client-context';
import {useDraftGuard} from '../settings/DraftGuard';
import {rowView} from './devices-presentation';
import {StatusDot, useNow} from './device-bits';

const reportSwitchFailure = (error: unknown) => console.error('Device switch failed', error);

export function DeviceSwitcherMenu({state, now, onPick, onManage}: {state: DevicesState; now: number; onPick: (id: string) => void; onManage: () => void}) {
  return <div className="device-switcher__menu" role="menu">
    {state.devices.map(row => {
      const view = rowView(row, now);
      return <button type="button" role="menuitem" key={row.id} data-current={row.current || undefined} onClick={() => onPick(row.id)}>
        <StatusDot tone={view.tone}/><span title={view.title}>{view.title}</span>{row.current && <small>当前</small>}
      </button>;
    })}
    <div role="separator" className="device-menu__separator"/>
    <button type="button" role="menuitem" className="device-switcher__manage" onClick={onManage}><Settings2 size={14} aria-hidden="true"/><span>管理设备…</span></button>
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
    <button type="button" className="device-switcher__button" aria-haspopup="menu" aria-expanded={open} aria-label={`当前设备：${view.title}，点击切换`} title={view.title} onClick={() => setOpen(value => !value)}>
      <StatusDot tone={view.tone}/><span>{view.title}</span><ChevronDown size={13} aria-hidden="true"/>
    </button>
    {open && <DeviceSwitcherMenu state={state} now={now}
      onPick={id => { setOpen(false); if (id !== current.id) navigate(() => void devices.switchTo(id).catch(reportSwitchFailure)); }}
      onManage={() => { setOpen(false); onManage(); }}/>}
  </div>;
}
