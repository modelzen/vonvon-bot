import {LINGER_OFF_WARNING, serviceStep, type DesktopSnapshot} from '@vonvon/protocol';
import type {ActiveDevice} from '../client-context';
import {remoteServiceFooter, whereName} from '../device-copy';
import {Button} from '../reference/components/ui';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {settingAnchor} from '../search';
import {LoginServiceRow} from '../setup/service-toggle';

type Application = DesktopSnapshot['application'];
type Where = Pick<ActiveDevice, 'isRemote' | 'name'>;

export const WINDOWS_LOGIN_TEXT = '这一批 Windows 不做登录自启，那台电脑上的 Vonvon Bot 开着时才在线。';
/** 后台运行's restart, here and on this computer's 启动选项: since R1 (#657) it interrupts the conversations directly. */
export const RESTART_HOST_TEXT = '重新加载已保存的 Bot 设置，会中断正在进行的对话';

/** devices-ui-2 4.4.3: 登录时启动 on another device, by that device's platform. */
export function RemoteLoginRow({application, busy, onToggle}: {application: Application; busy: boolean; onToggle: (enabled: boolean) => void}) {
  if (application.platform === 'macos') return <LoginServiceRow application={application} busy={busy} onToggle={onToggle}/>;
  if (application.platform === 'linux') {
    const service = application.service;
    return <SettingsRow title="登录时启动" value={serviceStep(application).status}
      description={<>在那台设备的终端运行 <code>vonvon service install</code>{service?.linger === 'off' ? <>。{service.hint ?? LINGER_OFF_WARNING}</> : null}</>}/>;
  }
  if (application.platform === 'windows') return <SettingsRow title="登录时启动" value="不支持" description={WINDOWS_LOGIN_TEXT}/>;
  return null;
}

/** devices-ui-2 4.4.3: the 启动选项 group while another device is shown. Restarting is `restartHost`, a command the page
 * sends (`onRestart`); the desktop's bridge already expects the restart, so the banner says 正在重启. */
export function RemoteServiceGroup({application, where, busy, onRestart, onToggle}: {application: Application; where: Where; busy: boolean; onRestart: () => void; onToggle: (enabled: boolean) => void}) {
  return <SettingsGroup label={`${whereName(where)}的后台服务`} id={settingAnchor('启动选项')} footer={remoteServiceFooter(where)}>
    <SettingsRow title="后台运行" description={RESTART_HOST_TEXT} trailing={<Button size="sm" disabled={busy} onClick={onRestart}>重启</Button>}/>
    <RemoteLoginRow application={application} busy={busy} onToggle={onToggle}/>
  </SettingsGroup>;
}
