import {ConnectionError, type VonvonClient} from '@vonvon/client/browser';
import {recentServiceFailure, serviceActionStartedMessage, serviceStep, type DesktopSnapshot} from '@vonvon/protocol';
import type {ShellCapabilities} from '../client-context';
import {SettingsRow} from '../reference/components/system-settings';
import {Toggle} from '../reference/components/ui';

type ServiceClient = Pick<VonvonClient, 'machine'>;

/**
 * Turns the login-time service on or off (3.10) and returns the notice. Turning it off also marks it skipped, so the
 * checklist does not ask again. The desktop waits for its own helper; the web page only gets the daemon's reply, then
 * loses the connection while the helper replaces that daemon, and the snapshot shows the result after it reconnects.
 */
export async function toggleService(enabled: boolean, client: ServiceClient, shell: ShellCapabilities | undefined): Promise<string> {
  await client.machine({type: 'setServiceSkipped', skipped: !enabled});
  if (shell?.setLoginItem) {
    await shell.setLoginItem(enabled);
    return enabled ? '已打开登录时启动。' : '已关闭登录时启动。Bot 改成单独启动的 daemon，这样崩溃后不会自动重启。';
  }
  const action = enabled ? 'install' : 'uninstall';
  try {
    const reply = await client.machine({type: 'service', action});
    if (reply.type === 'done') return reply.message;
  } catch (error) {
    // The daemon replies before its helper stops it, so losing the connection here is the handover.
    if (!(error instanceof ConnectionError)) throw error;
  }
  return serviceActionStartedMessage(action);
}

/** 跳过: the daemon the page talks to is already a detached one, so there is nothing to start. */
export async function skipService(client: ServiceClient): Promise<string> {
  await client.machine({type: 'setServiceSkipped', skipped: true});
  return '已跳过。Bot 跑在分离的 daemon 里，这样崩溃后不会自动重启。';
}

const DEVICE_TITLE: Record<DesktopSnapshot['application']['platform'], string> = {macos: '这台 Mac', linux: '这台 Linux 主机', windows: '这台 Windows 电脑', unsupported: '这台电脑'};
/** The 这台设备 row of the 应用与启动 page. */
export const deviceTitle = (platform: DesktopSnapshot['application']['platform']): string => DEVICE_TITLE[platform];

/** 登录电脑时启动 on the 应用与启动 page: macOS only (Linux uses vonvon service install), on while the service is installed. */
export function LoginServiceRow({application, busy, onToggle}: {application: DesktopSnapshot['application']; busy: boolean; onToggle: (enabled: boolean) => void}) {
  if (application.platform !== 'macos') return null;
  const service = application.service;
  const running = service?.action?.phase === 'running';
  // Turned off in System Settings stays clickable: installing then fails with the System Settings text, never overriding it.
  const value = running || service?.blocked || service?.state === 'disabled' ? serviceStep(application).status : undefined;
  return <SettingsRow title="登录电脑时启动" value={value} description={recentServiceFailure(service)}
    trailing={<Toggle className="settings-row-switch" aria-label="登录电脑时启动" label="登录电脑时启动" checked={application.loginItem}
      disabled={busy || !service || running || Boolean(service.blocked)} onChange={event => onToggle(event.target.checked)}/>}/>;
}
