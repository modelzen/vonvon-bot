import {deviceCopyName, type ActiveDevice} from './client-context';

/** devices-ui-2 4.1: the words that say which device a page acts on. Remote: 「X」; this computer: as before. */
type Where = Pick<ActiveDevice, 'isRemote' | 'name'>;
const PROVIDER_NAME = {codex: 'Codex', claude: 'Claude'} as const;

/** Remote: "在「X」上安装"; this computer: the action as it is. */
export function onDevice(where: Where, action: string): string {
  return where.isRemote ? `在${deviceCopyName(where)}上${action}` : action;
}
/** devices 第 15 节"在远程设备上配 Provider"; this computer leaves out "在 … 上". */
export function configureProvider(where: Where, provider: 'codex' | 'claude'): string {
  return `${onDevice(where, `把 ${PROVIDER_NAME[provider]} 配置好`)}（账号或自定义 API 都行），然后点「重新检测」。`;
}
/** What a Provider's check says, in place of signed in / signed out. */
export const CONFIG_STATE: Record<'signedIn' | 'signedOut' | 'notRequired' | 'unknown', string> = {signedIn: '可用', signedOut: '没配置好', notRequired: '可用', unknown: '无法确认'};
export const CHECK_CONFIG = '检查配置';
/** The 这台设备 row of the 应用与启动 page. */
export function hostTitle(platform: string | undefined): string {
  return ({macos: '这台 Mac', linux: '这台 Linux 主机', windows: '这台 Windows 电脑'} as Record<string, string>)[platform ?? ''] ?? '这台电脑';
}
/** 「X」 for a remote device, 这台电脑 for this one. */
export const whereName = (where: Where): string => deviceCopyName(where);
/** The Provider and tools pages while another device is shown. */
export const remoteToolsNote = (where: Where): string => `这里装的、检查的都是${whereName(where)}上的 Codex、Claude 和 lark-cli。`;
/** devices 第 15 节"远程停止确认". */
export const remoteStopConfirm = (where: Where): string =>
  `停止${whereName(where)}的后台服务？停止后它不会自动重启，只能在那台设备上重新启动。要重新加载请用"重启"。`;
/** devices 第 15 节"远程设备的后台服务". */
export const remoteServiceFooter = (where: Where): string => `退出这台电脑上的 Vonvon Bot 不影响${whereName(where)}。`;
/** devices 第 15 节"退出桌面端不停另外装的后台服务"; the page shows `command` as code. */
export const QUIT_KEEPS_DAEMON = {lead: '退出桌面应用不会停止后台：它是另外装的、注册成后台服务的 Vonvon Bot。要停请运行 ', command: 'vonvon daemon stop', tail: '。'} as const;
