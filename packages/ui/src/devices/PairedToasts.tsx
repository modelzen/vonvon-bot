import {useEffect, useState} from 'react';
import {X} from 'lucide-react';
import type {DeviceEventPayload} from '@vonvon/protocol';
import type {ShellCapabilities} from '../client-context';
import {Button, IconButton, InlineNotice} from '../reference/components/ui';
import {OPEN_SETTING_EVENT, type Destination} from '../search';
import {PAIRED_SECTION, PAIRED_TOAST_TITLE, pairedToastText} from '../settings/remote-access-presentation';
import '../settings/remote-access.css';

export const PAIRED_TOAST_LIMIT = 2;
/** 查看 opens 设备 → 已配对的设备 (on 应用与启动 until owner 2026-11-03 moved 允许别的设备连接). */
export const PAIRED_DESTINATION: Destination = {page: 'devices', section: PAIRED_SECTION};
/** The newest pairing of each client, newest first, at most two; a revocation is not shown. */
export function pairedToasts(events: readonly DeviceEventPayload[], closed: ReadonlySet<string>): DeviceEventPayload[] {
  const seen = new Set<string>();
  return [...events].reverse().filter(event => {
    if (event.change !== 'client-paired' || closed.has(event.clientId) || seen.has(event.clientId)) return false;
    seen.add(event.clientId);
    return true;
  }).slice(0, PAIRED_TOAST_LIMIT);
}

/**
 * devices-ui-3 4.5: a device paired with this computer, whichever device the window shows (it sits beside DeviceGate).
 * It stays until closed; 查看 only while this computer is shown. The web page has no `onLocalDeviceEvent`: no toast.
 */
export function PairedToasts({shell, local}: {shell?: ShellCapabilities; local: boolean}) {
  const [events, setEvents] = useState<DeviceEventPayload[]>([]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => shell?.onLocalDeviceEvent?.(event => {
    if (event.change !== 'client-paired') return;
    setEvents(previous => [...previous.filter(each => each.clientId !== event.clientId), event]);
    setClosed(previous => { const next = new Set(previous); next.delete(event.clientId); return next; });
  }), [shell]);
  return <PairedToastsView shown={pairedToasts(events, closed)} local={local} onClose={id => setClosed(previous => new Set([...previous, id]))}/>;
}

export function PairedToastsView({shown, local, onClose}: {shown: readonly DeviceEventPayload[]; local: boolean; onClose: (clientId: string) => void}) {
  if (!shown.length) return null;
  return <aside className="paired-toasts" aria-label="新配对的设备" aria-live="polite">
    {shown.map(event => <InlineNotice key={event.clientId} title={PAIRED_TOAST_TITLE} tone="info" actions={<>
      {local && <Button size="sm" onClick={() => {
        window.dispatchEvent(new CustomEvent(OPEN_SETTING_EVENT, {detail: PAIRED_DESTINATION}));
        onClose(event.clientId);
      }}>查看</Button>}
      <IconButton label={`关闭「${event.name}」的配对提示`} onClick={() => onClose(event.clientId)}><X size={14}/></IconButton>
    </>}>{pairedToastText(event)}</InlineNotice>)}
  </aside>;
}
