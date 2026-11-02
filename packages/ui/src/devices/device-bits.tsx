import {useEffect, useState, type ReactNode} from 'react';
import {useShellCapabilities, type ShellCapabilities} from '../client-context';
import {openExternalUrl} from '../url-actions';
import {copy, TAILSCALE_DOWNLOAD_URL, type StatusTone} from './devices-presentation';

/** No animation (4.5). */
export const StatusDot = ({tone}: {tone: StatusTone}) => <span className="device-dot" data-tone={tone} aria-hidden="true"/>;

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

export function TailscaleAdvice() {
  const shell = useShellCapabilities();
  const [error, setError] = useState<string>();
  return <aside className="device-tailscale">
    <p>{copy.tailscaleAdvice}</p>
    <button type="button" className="device-link" onClick={() => void openExternalUrl(TAILSCALE_DOWNLOAD_URL, 'tailscale', shell).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))}>{copy.tailscaleDownload}</button>
    {error && <p role="alert">{error}</p>}
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
    <div className="device-outside-scroll"><main className="app-connection-state device-outside-main">{children}{quitError && <p role="alert">{quitError}</p>}</main></div>
  </div>;
}
