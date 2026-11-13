import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {toolSteps, type ToolState} from '@vonvon/protocol';
import {LOCAL_ACTIVE_DEVICE} from '../src/client-context';
import {configureProvider, diagnosticsToolsFooter, hostTitle, onDevice, onDeviceText, placeOf, remoteServiceFooter, remoteStopConfirm, remoteToolsNote, toolStepsOn, updateServerText, whereName} from '../src/device-copy';
import {looksLikePath} from '../src/directory-picker';
import {browseQuery} from '../src/DirectorySearchStep';

const remote = {isRemote: true, name: 'Linux 主机'};

// main 必败: device-copy is new (devices-ui-2 4.1)
// owner 2026-11-02: this computer's pages say 本机 too
it('names the remote device in Provider words, and this computer as 本机', () => {
  expect(configureProvider(LOCAL_ACTIVE_DEVICE, 'codex')).toBe('在本机上把 Codex 配置好（账号或自定义 API 都行），然后点「重新检测」。');
  expect(configureProvider(remote, 'codex')).toContain('在「Linux 主机」上把 Codex 配置好（账号或自定义 API 都行）');
  expect(configureProvider(remote, 'claude')).toContain('在「Linux 主机」上把 Claude 配置好');
  expect(onDevice(remote, '安装')).toBe('在「Linux 主机」上安装');
  expect(onDevice(LOCAL_ACTIVE_DEVICE, '安装')).toBe('在本机上安装');
  expect(remoteToolsNote(remote)).toBe('这里装的、检查的都是「Linux 主机」上的 Codex、Claude 和 lark-cli。');
  expect(whereName(LOCAL_ACTIVE_DEVICE)).toBe('本机');
  expect(whereName(remote)).toBe('「Linux 主机」');
  expect(placeOf(LOCAL_ACTIVE_DEVICE)).toBe('本机');
  expect(placeOf(remote)).toBe('「Linux 主机」上');
  expect(updateServerText(LOCAL_ACTIVE_DEVICE)).toBe('请更新并重新连接本机服务。');
  expect(updateServerText(remote)).toBe('请更新并重新连接「Linux 主机」上的服务。');
  expect(diagnosticsToolsFooter(LOCAL_ACTIVE_DEVICE)).toBe('本机上的 Provider 每分钟检查一次；Claude 的配置可以单独检查。');
});

it('titles the device by platform, Windows included (devices 第 19 节)', () => {
  expect(hostTitle('windows')).toBe('这台 Windows 电脑');
  expect(hostTitle('macos')).toBe('这台 Mac');
  expect(hostTitle('linux')).toBe('这台 Linux 主机');
  expect(hostTitle('unsupported')).toBe('这台电脑');
});

it('uses the design 第 15 节 words for the remote service', () => {
  expect(remoteStopConfirm(remote)).toBe('停止「Linux 主机」的后台服务？停止后它不会自动重启，只能在那台设备上重新启动。要重新加载请用"重启"。');
  expect(remoteServiceFooter(remote)).toBe('退出这台电脑上的 Vonvon Bot 不影响「Linux 主机」。');
});

// Codex review 244: toolSteps speaks of this computer whichever device is shown; the page says each step of 「X」
it('names the inspected device and Provider settings without changing tool status', () => {
  const installs = ['missing', 'installed', 'unknown'] as const;
  const auths = ['signedOut', 'signedIn', 'notRequired', 'unknown'] as const;
  const tool = (name: 'codex' | 'claude', installation: ToolState['installation'], authentication: ToolState['authentication'], old: boolean): ToolState =>
    ({tool: name, installation, authentication, version: '1.0.0', ...(old ? {compatibility: {status: 'tooOld', minimum: '2.0.0', verified: '2.1.0'}} : {})});
  let instructions = 0;
  for (const installation of installs) for (const authentication of auths) for (const old of [false, true]) for (const claudeChecking of [false, true]) {
    const steps = toolSteps([tool('codex', installation, authentication, old), tool('claude', installation, authentication, false)], {claudeChecking}).steps;
    toolStepsOn(LOCAL_ACTIVE_DEVICE, steps).forEach((shown, index) => {
      const original = steps[index]!;
      expect(shown).toMatchObject({id: original.id, title: original.title, status: original.status, tone: original.tone, done: original.done});
      expect(shown.detail ?? '').not.toContain('本机环境');
      for (const action of shown.actions) if (action.kind === 'environment') expect(action.label).toBe('打开「Provider」设置');
    });
    for (const step of toolStepsOn(remote, steps)) {
      const words = [step.detail ?? '', ...step.actions.map(action => action.label)].join(' ');
      expect(words, `${step.id} ${installation} ${authentication} ${old}`).not.toContain('本机');
      if (/终端|工具|Provider/.test(words)) { instructions++; expect(words).toContain('「Linux 主机」'); }
    }
  }
  expect(instructions).toBeGreaterThan(0);
  // one pass: a device whose name has 本机 in it keeps its name
  expect(onDeviceText({isRemote: true, name: '本机房'}, '在本机环境里装，要用本机的 npm')).toBe('在「本机房」的「工具」里装，要用「本机房」上的 npm');
  expect(onDeviceText({isRemote: true, name: '本机房'}, '在本机环境里装，要用本机的 npm', 'providers')).toBe('在「本机房」的 Provider 设置里装，要用「本机房」上的 npm');
  expect(onDeviceText(LOCAL_ACTIVE_DEVICE, '请在终端运行 brew upgrade codex')).toBe('请在终端运行 brew upgrade codex');
  expect(onDeviceText(remote, '请在终端运行 brew upgrade codex')).toBe('请在「Linux 主机」的终端运行 brew upgrade codex');
});

// main 必败: Windows and remote paths were not recognized (devices-ui-2 4.3)
it('tells paths from search words, Windows paths included', () => {
  for (const path of ['/srv', '~/a', '~', 'C:\\x', 'c:/x', '\\\\host\\share']) expect(looksLikePath(path), path).toBe(true);
  for (const word of ['srv', '~a', 'C:']) expect(looksLikePath(word), word).toBe(false);
  expect(browseQuery('/srv/')).toBe('/srv/');
  expect(browseQuery('C:\\work')).toBe('C:\\work\\');
});

const UI = join(__dirname, '..', 'src');
/** The files of devices-ui-2 4.2's first table. Lines about Feishu sign-in, and the OS login item, keep 登录. */
const PROVIDER_FILES = ['JoinGroupDialog.tsx', 'settings/useProviderDiscovery.ts', 'settings/DecisionFields.tsx', 'settings/GroupDesignSettings.tsx',
  'management/EnvironmentPanel.tsx', 'management/environmentPresentation.ts', 'setup/ProviderSetup.tsx', 'setup/useClaudeLoginCheck.ts',
  'management/UsagePanel.tsx', 'management/DiagnosticsPanel.tsx'];
const loginLines = (file: string) => readFileSync(join(UI, file), 'utf8').split('\n')
  .filter(line => line.includes('登录') && !/lark|飞书|登录电脑时启动/.test(line));

// main 必败: Provider pages said 登录 for what is an account or a custom API (devices 6.4)
it('says 配置 rather than 登录 for Codex and Claude on every Provider page', () => {
  for (const file of PROVIDER_FILES) expect(loginLines(file), file).toEqual([]);
  // Provider search aliases retain 登录; the Vonvon account has its own login action.
  const search = loginLines('search.ts').filter(line => !line.includes("page: 'account'"));
  expect(search).toHaveLength(1);
  expect(search[0]).toContain('aliases');
});
