import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {desktopUpdateNotice, type DesktopUpdate, type MachineRequestHandler} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider, type ShellCapabilities} from '../src/client-context';
import {DesktopUpdateContext} from '../src/desktop-update';
import type {UpdatePhase} from '../src/desktop-update';
import {AppShell} from '../src/LocalShell';
import {SettingsHome} from '../src/TodayHome';
import {canApplyCoreUpdate, coreStatusLine, coreUpdatable, UpdatePanel} from '../src/management/UpdatePanel';
import {DraftGuardProvider} from '../src/settings/DraftGuard';

const client = createClient({
  isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {},
  send: () => {}, close: async () => {},
});
const request: MachineRequestHandler = async () => { throw new Error('Unexpected machine request'); };
const render = (externalCoreAvailable: boolean, attached = false) => renderToStaticMarkup(
  <ClientProvider client={client}>
    <DraftGuardProvider>
      <UpdatePanel request={request} attached={attached} externalCoreAvailable={externalCoreAvailable}
        version="0.7.0" device="这台 Mac" advancedSettings={<p>测试高级运行选项</p>}>
        <p>测试启动选项</p>
      </UpdatePanel>
    </DraftGuardProvider>
  </ClientProvider>,
);

it('shows the installed desktop version before checking for updates', () => {
  const html = render(false);
  expect(html).toContain('0.7.0');
  expect(html).toContain('这台 Mac');
  expect(html).toContain('尚未检查');
  expect(html).toContain('检查更新');
  expect(html).toContain('测试启动选项');
  expect(html).toContain('测试高级运行选项');
});

it.each([false, true])('hides external Core controls without installation support, even with attached=%s', attached => {
  const html = render(false, attached);
  for (const label of ['外部 Core / CLI', 'Core 来源', '检查 Core 更新', '更新外部 Core', '查看 Core 更新进度']) {
    expect(html).not.toContain(label);
  }
});

it('keeps external Core controls available when the installation supports them', () => {
  const html = render(true, true);
  expect(html).toContain('外部 Core / CLI');
  expect(html).toContain('检查 Core 更新');
  expect(html).toContain('更新外部 Core');
  expect(html).toContain('更新会重启服务端，正在进行的对话会被中断。');
  expect(html).toContain('查看 Core 更新进度');
});

// main 必败: the panel offered the Core update to global npm only, and only when attached (server-3 4.9)
it('offers the Core update to a standalone server too, and follows its steps in words', () => {
  const core = (kind: string, hasUpdate: boolean) => ({type: 'coreUpdate' as const, distribution: {kind, cliPath: '/x'}, current: '1.0.0', latest: hasUpdate ? '1.0.1' : '1.0.0', hasUpdate, dev: false});
  expect([coreUpdatable('standalone'), coreUpdatable('global-npm'), coreUpdatable('bundled'), coreUpdatable(undefined)]).toEqual([true, true, false, false]);
  expect(canApplyCoreUpdate(core('standalone', true))).toBe(true);
  expect(canApplyCoreUpdate(core('standalone', false))).toBe(false);
  expect(canApplyCoreUpdate(core('bundled', true))).toBe(false);
  expect(canApplyCoreUpdate(undefined)).toBe(false);
  expect(coreStatusLine({phase: 'restarting', from: '1.0.0', to: '1.0.1', at: 1, detail: 'draining'})).toBe('正在中断进行中的对话 · 1.0.0 → 1.0.1');
  expect(coreStatusLine({phase: 'installing', from: '1.0.0', at: 1, detail: 'downloading', progress: {transferred: 3, total: 4}})).toBe('下载中 75%');
  expect(coreStatusLine({phase: 'error', ok: false, from: '1.0.0', to: '1.0.1', at: 1, detail: 'waiting', rolledBack: true, message: '新版本 1.0.1 没有起来，已切回 1.0.0'})).toBe('更新失败：新版本 1.0.1 没有起来，已切回 1.0.0 · 1.0.0 → 1.0.1');
  expect(coreStatusLine({phase: 'a-phase-from-a-newer-daemon', at: 1})).toBe('进行中');
  expect(coreStatusLine(null)).toBe('尚无更新记录');
});

const renderWith = (update?: DesktopUpdate, shell: ShellCapabilities = {checkDesktopUpdate: async () => ({state: 'current', current: '0.7.0', message: ''}), retryDesktopUpdate: async () => ({state: 'current', current: '0.7.0', message: ''}), installDesktopUpdate: async () => ({state: 'downloaded', current: '0.7.0', message: ''})}, phase?: UpdatePhase) => renderToStaticMarkup(
  <ClientProvider client={client} shell={shell}>
    <DraftGuardProvider>
      <DesktopUpdateContext.Provider value={[update, () => {}, {phase, run: async () => {}}]}>
        <UpdatePanel request={request} attached={false} externalCoreAvailable={false} version="0.7.0" device="这台 Mac" advancedSettings={null}>{null}</UpdatePanel>
      </DesktopUpdateContext.Provider>
    </DraftGuardProvider>
  </ClientProvider>,
);

it('shows an update the app found on its own, without a manual check', () => {
  const html = renderWith({state: 'available', current: '0.7.0', latest: '0.7.1', message: '可下载并安装桌面更新'});
  expect(html).toContain('有可用更新 · v0.7.1');
  expect(html).toContain('下载更新');
  expect(html).not.toContain('尚未检查');
});

it('shows measured download progress and signed notes, then warns before an explicit install', () => {
  const update: DesktopUpdate = {state: 'available', current: '0.7.0', latest: '0.7.1', message: '', releaseNotes: '修复连接\n改进升级', downloadProgress: {percent: 42.9, transferred: 429, total: 1000}};
  const html = renderWith(update, undefined, 'downloading');
  expect(html).toContain('正在下载更新 · 42%');
  expect(html).toContain('<progress');
  expect(html).toContain('value="42"');
  expect(html).toContain('aria-label="更新下载进度"');
  expect(html).toContain('修复连接\n改进升级');
  const ready = renderWith({...update, state: 'downloaded', downloadProgress: undefined});
  expect(ready).toContain('已下载并验证');
  expect(ready).toContain('重启时正在进行的对话会被中断');
  expect(ready).toContain('>重启升级<');
  expect(ready).not.toContain('稍后');
  expect(ready).not.toContain('<progress');
});

it('does not invent a percentage before the updater reports download progress', () => {
  const html = renderWith({state: 'available', current: '0.7.0', latest: '0.7.1', message: ''}, undefined, 'downloading');
  expect(html).toContain('正在下载更新…');
  expect(html.match(/<progress[^>]+>/)?.[0]).not.toContain('value=');
});

it('offers a retry and a manual download when the last install did not take effect', () => {
  const html = renderWith({state: 'install-pending', current: '0.7.0', latest: '0.7.1', message: '上次安装尚未生效，预期 0.7.1，当前 0.7.0'});
  expect(html).toContain('上次安装未生效');
  expect(html).toContain('上次安装尚未生效，预期 0.7.1，当前 0.7.0');
  expect(html).toContain('重试');
  expect(html).toContain('手动下载');
  const none = renderWith({state: 'current', current: '0.7.0', latest: '0.7.0', message: '桌面应用已是最新版本'});
  expect(none).not.toContain('手动下载');
});

it('disables the retry when the shell cannot retry', () => {
  const html = renderWith({state: 'install-pending', current: '0.7.0', latest: '0.7.1', message: 'x'}, {checkDesktopUpdate: async () => ({state: 'current', current: '0.7.0', message: ''})});
  expect(html.match(/<button[^>]*>(?:(?!<\/button>).)*重试<\/span><\/button>/)?.[0]).toContain('disabled');
  const withRetry = renderWith({state: 'install-pending', current: '0.7.0', latest: '0.7.1', message: 'x'});
  expect(withRetry.match(/<button[^>]*>(?:(?!<\/button>).)*重试<\/span><\/button>/)?.[0]).not.toContain('disabled');
});

it('marks the settings entry for a waiting update and for an install that did not take effect, and for nothing else', () => {
  const update = (state: DesktopUpdate['state']): DesktopUpdate => ({state, current: '0.7.0', latest: '0.7.1', message: ''});
  expect(desktopUpdateNotice(update('available'))).toBe('有新版本 0.7.1');
  expect(desktopUpdateNotice(update('downloaded'))).toBe('有新版本 0.7.1');
  expect(desktopUpdateNotice(update('install-pending'))).toBe('上次更新没装上');
  for (const state of ['current', 'unavailable'] as const) expect(desktopUpdateNotice(update(state))).toBeUndefined();
  expect(desktopUpdateNotice(undefined)).toBeUndefined();
});

const shell = (props: {updateNotice?: string}) => renderToStaticMarkup(
  <AppShell page="home" view="agents" title="此刻" onNavigate={() => {}} onOpenList={() => {}} {...props}><p>内容</p></AppShell>,
);

it('marks the settings button, and only it, when a new version is waiting', () => {
  const marked = shell({updateNotice: '有新版本 0.7.1'});
  expect(marked).toContain('aria-label="设置，有新版本 0.7.1"');
  expect(marked).toContain('today-update-dot');
  expect(shell({updateNotice: '上次更新没装上'})).toContain('aria-label="设置，上次更新没装上"');
  const plain = shell({});
  expect(plain).toContain('aria-label="设置"');
  expect(plain).not.toContain('today-update-dot');
});

it('says on the settings home which entry holds the new version', () => {
  const home = (updateNotice?: string) => renderToStaticMarkup(<SettingsHome onNavigate={() => {}} onFeature={() => {}} updateNotice={updateNotice}/>);
  expect(home('有新版本 0.7.1')).toContain('有新版本 0.7.1');
  expect(home('上次更新没装上')).toContain('上次更新没装上');
  expect(home()).not.toContain('有新版本');
  expect(home()).toContain('后台运行与更新');
});

// devices-ui-1b; owner 2026-11-03 moved 允许别的设备连接 to 设备, so the web page has the page too (main 必败: it had none).
it('puts 设备 first in 连接与应用, on the web page with only 允许别的设备连接', () => {
  const home = (devices?: boolean) => renderToStaticMarkup(<SettingsHome devices={devices} onNavigate={() => {}} onFeature={() => {}}/>);
  const sections = (devices?: boolean) => home(devices)
    .split('<section class="today-settings-section"').slice(1).map(section => [...section.matchAll(/<strong>([^<]+)<\/strong>/g)].map(match => match[1]));
  const both = [['Provider', '工具与连接', '决策模型', '用量'], ['设备', '飞书连接', '导入 Bridge', '应用与启动', '状态与诊断']];
  expect(sections()).toEqual(both);
  expect(sections(true)).toEqual(both);
  const desktop = home(true).split('<strong>设备</strong>')[1]!;
  expect(desktop.slice(0, desktop.indexOf('</small>'))).toContain('加别的设备、切换着管理，允许别的设备连接');
  const web = home().split('<strong>设备</strong>')[1]!;
  expect(web.slice(0, web.indexOf('</small>'))).toBe('<small>允许别的设备连接');
});
