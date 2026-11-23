import {useEffect, useRef, useState, type KeyboardEvent, type RefObject} from 'react';
import {ChevronDown, ChevronRight, CircleUserRound, Plus, Settings2} from 'lucide-react';
import type {AccountStatus, DevicesState} from '@vonvon/protocol';
import {useActiveDevice, useDevicesState, useShellCapabilities} from '../client-context';
import {useDraftGuard} from '../settings/DraftGuard';
import {addBlockedReason, rowView} from './devices-presentation';
import {DeviceTile, platformIcon, StatusDot, useDismiss, useNow} from './device-bits';
import {AddDeviceDialog} from './AddDeviceDialog';
import {accountStatusText, useAccount} from '../account-context';
import {AccountAvatar} from '../accounts/AccountAvatar';

const reportSwitchFailure = (error: unknown) => console.error('Device switch failed', error);

type Focus = 'first' | 'last';
const enabledItems = (menu: HTMLElement | null) => [...menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []];
function focusItem(menu: HTMLElement | null, which: Focus) {
  const items = enabledItems(menu);
  (which === 'first' ? items[0] : items.at(-1))?.focus();
}

/**
 * Every device, then 添加设备… and 管理设备…. The items leave the Tab order (arrow keys move between them), so Tab leaves
 * the menu and closes it; Shift+Tab goes back to the trigger (`onLeave`). `autoFocus`: the item to focus once it opens,
 * when it was opened by keyboard.
 */
export function DeviceSwitcherMenu({state, now, onPick, onAdd, onManage, onLeave, menuRef, autoFocus, account}: {
  state: DevicesState; now: number; onPick: (id: string) => void; onAdd: () => void; onManage: () => void;
  onLeave?: () => void; menuRef?: RefObject<HTMLDivElement | null>; autoFocus?: Focus;
  account?: {status?: AccountStatus; supported: boolean; onLogin: () => void; onManage: () => void; error?: string};
}) {
  const own = useRef<HTMLDivElement>(null);
  const menu = menuRef ?? own;
  const blocked = addBlockedReason(state);
  // Once, as it opens.
  useEffect(() => { if (autoFocus) focusItem(menu.current, autoFocus); }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The trigger is inside the switcher, so focus landing there would not close the menu.
    if (event.key === 'Tab' && event.shiftKey && onLeave) {
      event.preventDefault();
      onLeave();
      return;
    }
    const items = enabledItems(menu.current);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = {
      ArrowDown: () => items[(at + 1) % items.length],
      ArrowUp: () => items[at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length],
      Home: () => items[0],
      End: () => items.at(-1),
    }[event.key];
    if (!next) return;
    event.preventDefault();
    next()?.focus();
  };
  return <div ref={menu} className="device-switcher__menu" role="menu" aria-label="切换设备" onKeyDown={onKeyDown}>
    <div className="device-switcher__list">{state.devices.map(row => {
      const view = rowView(row, now);
      return <button type="button" role="menuitem" tabIndex={-1} key={row.id} className="device-switcher__device" data-current={row.current || undefined} onClick={() => onPick(row.id)}>
        <DeviceTile icon={platformIcon(row.platform)} small/>
        <span className="device-switcher__copy">
          <span className="device-switcher__title" title={view.title}>{view.title}</span>
          <small className="device-switcher__status"><StatusDot tone={view.tone}/>{view.status}</small>
        </span>
        {row.current && <small className="device-tag">当前</small>}
      </button>;
    })}</div>
    <div role="separator" className="device-menu__separator"/>
    <button type="button" role="menuitem" tabIndex={-1} className="device-switcher__action" disabled={Boolean(blocked)} title={blocked} onClick={onAdd}><Plus size={14} aria-hidden="true"/><span>添加设备…</span></button>
    <button type="button" role="menuitem" tabIndex={-1} className="device-switcher__action" onClick={onManage}><Settings2 size={14} aria-hidden="true"/><span>管理设备…</span></button>
    {account && <div className="device-switcher__account">
      <button type="button" role="menuitem" tabIndex={-1} className="device-switcher__account-button"
        onClick={account.status?.kind === 'signedOut' ? account.onLogin : account.onManage}>
        {account.status?.kind === 'signedIn' ? <AccountAvatar identity={account.status}/> : <CircleUserRound size={22} strokeWidth={1.5} aria-hidden="true"/>}
        <span className="device-switcher__account-copy"><strong>{account.status?.kind === 'signedIn' ? account.status.displayName : account.status?.kind === 'signedOut' ? '登录 Vonvon' : '账号'}</strong>
          <small>{account.error ?? (account.status?.kind === 'signedIn' ? '账号管理' : accountStatusText(account.status, account.supported))}</small></span>
        <ChevronRight size={13} aria-hidden="true"/>
      </button>
    </div>}
  </div>;
}

/**
 * The desktop's top-left, in the brand's place, like a workspace switcher: which device the window shows and its state,
 * shown with this computer alone too, so 添加设备 can be found. Switching goes through DraftGuard.
 */
export function DeviceSwitcher({onManage, onAccount}: {onManage: () => void; onAccount?: () => void}) {
  const state = useDevicesState();
  const devices = useShellCapabilities()?.devices;
  const {isRemote} = useActiveDevice();
  const {navigate} = useDraftGuard();
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState<Focus>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const now = useNow(open ? 60_000 : undefined);
  useDismiss(root, open, () => setOpen(false));
  if (!state || !devices) return null;
  const current = state.devices.find(row => row.current) ?? state.devices[0]!;
  const view = rowView(current, now);
  const switchTo = (id: string) => navigate(() => void devices.switchTo(id).catch(reportSwitchFailure));
  const show = (focus?: Focus) => { setFocusOnOpen(focus); setOpen(true); };
  // The item goes away with the menu: the focus goes back to the trigger first, so the dialog an item opens returns it there.
  const choose = (action: () => void) => { trigger.current?.focus(); setOpen(false); action(); };
  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const which = event.key === 'ArrowDown' ? 'first' : 'last';
    if (open) focusItem(menu.current, which);
    else show(which);
  };
  return <div className="device-switcher" ref={root} data-remote={isRemote || undefined}>
    <button ref={trigger} type="button" className="device-switcher__button" aria-haspopup="menu" aria-expanded={open}
      aria-label={`当前设备：${view.title}，点击切换`} title={`${view.title} · ${view.status}`}
      onClick={event => { if (open) setOpen(false); else show(event.detail === 0 ? 'first' : undefined); }} onKeyDown={onTriggerKey}>
      {account.status?.kind === 'signedIn' ? <AccountAvatar identity={account.status}/> : <img className="device-switcher__logo" src="./vonvon-logo.png" alt=""/>}
      <StatusDot tone={view.tone}/>
      <span className="device-switcher__name">{view.title}</span>
      {view.tone !== 'green' && <span className="device-switcher__state">{` · ${view.status}`}</span>}
      <ChevronDown size={13} aria-hidden="true"/>
    </button>
    {open && <DeviceSwitcherMenu state={state} now={now} menuRef={menu} autoFocus={focusOnOpen}
      onPick={id => choose(() => { if (id !== current.id) switchTo(id); })}
      onAdd={() => choose(() => setAdding(true))}
      onManage={() => choose(onManage)} onLeave={() => { trigger.current?.focus(); setOpen(false); }}
      account={onAccount ? {...account, onLogin: () => choose(() => void account.login()), onManage: () => choose(onAccount)} : undefined}/>}
    {adding && <AddDeviceDialog onClose={() => setAdding(false)} onSwitch={switchTo}/>}
  </div>;
}
