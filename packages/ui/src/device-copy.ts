import type {SetupStep} from '@vonvon/protocol';
import {deviceCopyName, type ActiveDevice} from './client-context';

/** devices-ui-2 4.1: the words that say which device a page acts on. Remote: 「X」; this computer: 本机 (owner 2026-11-02:
 * a page of this computer says so too, not only a remote one). */
type Where = Pick<ActiveDevice, 'isRemote' | 'name'>;
const PROVIDER_NAME = {codex: 'Codex', claude: 'Claude'} as const;

/** Remote: "在「X」上安装"; this computer: "在本机上安装". */
export function onDevice(where: Where, action: string): string {
  return `在${whereName(where)}上${action}`;
}
/** devices 第 15 节"在远程设备上配 Provider"; this computer: "在本机上把 … 配置好". */
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
/** 「X」 for a remote device, 本机 for this one. The device list still calls this one 这台电脑 (`deviceCopyName`). */
export function whereName(where: Where): string {
  return where.isRemote ? deviceCopyName(where) : '本机';
}
/** Where something is kept or done: 「X」上 for a remote device, 本机 for this one ("密钥仅保存在本机"). */
export const placeOf = (where: Where): string => where.isRemote ? `${whereName(where)}上` : '本机';
/** A setting the server does not know yet: the words of a page that needs a newer server. */
export const updateServerText = (where: Where): string => `请更新并重新连接${where.isRemote ? `${whereName(where)}上的` : '本机'}服务。`;
/** The Provider and tools pages while another device is shown. */
export const remoteToolsNote = (where: Where): string => `这里装的、检查的都是${whereName(where)}上的 Codex、Claude 和 lark-cli。`;
/** devices 第 15 节"远程停止确认". */
export const remoteStopConfirm = (where: Where): string =>
  `停止${whereName(where)}的后台服务？停止后它不会自动重启，只能在那台设备上重新启动。要重新加载请用"重启"。`;
/** devices 第 15 节"远程设备的后台服务". */
export const remoteServiceFooter = (where: Where): string => `退出这台电脑上的 Vonvon Bot 不影响${whereName(where)}。`;
/** devices 第 15 节"退出桌面端不停另外装的后台服务"; the page shows `command` as code. */
export const QUIT_KEEPS_DAEMON = {lead: '退出桌面应用不会停止后台：它是另外装的、注册成后台服务的 Vonvon Bot。要停请运行 ', command: 'vonvon daemon stop', tail: '。'} as const;

/**
 * Review 244 (devices-ui-2 第 8 节第 1 条): a tool sentence of `toolSteps` (protocol) or of the daemon, said of 「X」 while a
 * remote device is shown. Both stay the same whichever device is looked at, so they speak of 本机 and 在终端运行; this
 * computer keeps them as they are.
 */
export function onDeviceText(where: Where, text: string): string {
  if (!where.isRemote) return text;
  const name = whereName(where);
  // One pass, so a device whose name has 本机 in it is not rewritten again.
  const said: Record<string, string> = {本机环境: `${name}的「工具与连接」`, 本机的: `${name}上的`, 本机: name, 在终端运行: `在${name}的终端运行`, 在终端里运行: `在${name}的终端运行`,
    '没装 Node.js 的话，装': '没装 Node.js 的话，在那台设备上装'};
  return text.replace(/本机环境|本机的|本机|在终端里?运行|没装 Node\.js 的话，装/g, words => said[words] ?? words);
}
/** The 状态与诊断 page's tool steps on 「X」: each instruction and the button to its tools page name it (review 244). */
export function toolStepsOn(where: Where, steps: readonly SetupStep[]): SetupStep[] {
  if (!where.isRemote) return [...steps];
  return steps.map(step => ({
    ...step,
    ...(step.detail ? {detail: onDeviceText(where, step.detail)} : {}),
    actions: step.actions.map(action => action.kind === 'environment' ? {...action, label: `查看${whereName(where)}的工具`} : action),
  }));
}
/** The footer of the 状态与诊断 page's group of the device's tools. */
export const diagnosticsToolsFooter = (where: Where): string =>
  `${whereName(where)}上的 Provider 每分钟检查一次；Claude 的配置可以单独检查。`;
