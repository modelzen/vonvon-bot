import {Fragment, useEffect, useRef, useState, type ReactNode, type RefObject} from 'react';
import {Ellipsis, Globe, Laptop, Monitor, MonitorSmartphone, Server, Terminal, type LucideIcon} from 'lucide-react';
import {useShellCapabilities, type ShellCapabilities} from '../client-context';
import {openExternalUrl} from '../url-actions';
import {copy, TAILSCALE_DOWNLOAD_URL, type StatusTone} from './devices-presentation';

/** No animation (4.5). */
export const StatusDot = ({tone}: {tone: StatusTone}) => <span className="device-dot" data-tone={tone} aria-hidden="true"/>;

/** A row's state as a small tinted pill with its dot, as the Bot page's 已连接. */
export const StatusPill = ({tone, children}: {tone: StatusTone; children: ReactNode}) =>
  <span className="device-status" data-tone={tone}><i aria-hidden="true"/>{children}</span>;

/** The device's platform as an icon. */
export function platformIcon(platform?: string): LucideIcon {
  return ({macos: Laptop, windows: Monitor, linux: Server} as Record<string, LucideIcon>)[platform ?? ''] ?? MonitorSmartphone;
}
/** A paired client's kind as an icon. */
export function clientIcon(kind?: string): LucideIcon {
  return ({desktop: Laptop, cli: Terminal, web: Globe} as Record<string, LucideIcon>)[kind ?? ''] ?? MonitorSmartphone;
}
/** The square tile a device row starts with. */
export function DeviceTile({icon: Icon, large = false}: {icon: LucideIcon; large?: boolean}) {
  return <span className={large ? 'device-tile device-tile--lg' : 'device-tile'} aria-hidden="true"><Icon size={large ? 18 : 16} strokeWidth={1.7}/></span>;
}

/** The copy marks commands with backticks; they show as code. */
export function CopyText({text}: {text: string}) {
  return <>{text.split('`').map((part, index) => index % 2 ? <code key={index}>{part}</code> : part)}</>;
}

/** The clock, ticking every `interval` ms while it is given. */
export function useNow(interval?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!interval) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [interval]);
  return now;
}

/** While `open`, a click outside `ref` or Escape closes it (Escape gives the focus back to `ref`'s first button). */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) latest.current(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      latest.current();
      ref.current?.querySelector<HTMLElement>('button')?.focus();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [ref, open]);
}

export type RowMenuItem = {label: string; icon: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean};
/**
 * A row's rarer actions behind ⋯ (`groups`: separated by a line); the devices page and 已配对的设备 share it. A button with
 * `aria-expanded`, as the header's device switcher; the menu stays in the page, hidden while closed.
 */
export function RowMenu({label, groups, className}: {label: string; groups: RowMenuItem[][]; className?: string}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const shown = groups.filter(group => group.length);
  return <div ref={ref} className={className ? `device-menu ${className}` : 'device-menu'} data-open={open || undefined}>
    <button type="button" className="device-menu__button" aria-label={label} aria-haspopup="menu" aria-expanded={open} title="更多操作" onClick={() => setOpen(value => !value)}>
      <Ellipsis size={16} aria-hidden="true"/>
    </button>
    <div role="menu" aria-label={label} hidden={!open}>{shown.map((group, index) => <Fragment key={index}>
      {index > 0 && <div role="separator" className="device-menu__separator"/>}
      {group.map(({label: text, icon: Icon, onSelect, danger, disabled}) => <button key={text} type="button" role="menuitem" disabled={disabled} data-danger={danger || undefined}
        onClick={() => { setOpen(false); onSelect(); }}>
        <Icon size={14} aria-hidden="true"/><span>{text}</span>
      </button>)}
    </Fragment>)}</div>
  </div>;
}

export function TailscaleAdvice() {
  const shell = useShellCapabilities();
  const [error, setError] = useState<string>();
  return <aside className="device-tailscale">
    <p>{copy.tailscaleAdvice}<button type="button" className="device-link" onClick={() => void openExternalUrl(TAILSCALE_DOWNLOAD_URL, 'tailscale', shell).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))}>{copy.tailscaleDownload}</button></p>
    {error && <p className="device-tailscale__error" role="alert">{error}</p>}
  </aside>;
}

export const quitOutsideApp = (shell: ShellCapabilities | undefined, onError: (message: string) => void) => () =>
  void shell?.quit?.().catch(error => onError(error instanceof Error ? error.message : '后台服务尚未确认停止，请稍后再试。'));

/** Pages outside App: a title bar to drag the window by, and a quit that is not left pending. */
export function OutsideWindow({shell, children}: {shell?: ShellCapabilities; children: ReactNode}) {
  const [quitError, setQuitError] = useState<string>();
  useEffect(() => shell?.onQuitRequested?.(quitOutsideApp(shell, setQuitError)), [shell]);
  return <div className="device-outside-window">
    <div className="desktop-titlebar" aria-hidden="true"/>
    <div className="device-outside-scroll"><main className="app-connection-state device-outside-main">{children}{quitError && <p className="device-problem" role="alert">{quitError}</p>}</main></div>
  </div>;
}
