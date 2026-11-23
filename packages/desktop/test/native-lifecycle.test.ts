import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellActions } from '../src/ipc-contract.js';
import type { Registration, VerifiedDaemon } from '../src/daemon-manager.js';

const fake = vi.hoisted(() => ({
  app: undefined as unknown,
  window: undefined as unknown,
  // deferLocalLost: false while the page shows this computer, as in the real bridge (devices-ui-1a 4.5).
  bridge: { requestQuit: vi.fn(), publishUpdate: vi.fn(), replaceOwner: vi.fn(async () => {}), dispose: vi.fn(async () => {}), deferLocalLost: vi.fn(() => false),
    // devices-ui-4: this computer's daemon connection, which the remote update listens on, and the window's line
    localOwner: vi.fn((): unknown => null), onLocalOwner: vi.fn((_listener: (owner: unknown) => void) => () => {}), sendRemoteUpdate: vi.fn() },
  owner: { dispose: vi.fn(async () => {}) },
  attach: vi.fn(),
  ready: vi.fn(async (): Promise<VerifiedDaemon> => ({ pid: 42, startedAt: 'initial', listen: '127.0.0.1:42345' })),
  install: vi.fn(),
  cliRegister: vi.fn(async () => ({ kind: 'ready' as const, bin: '/tmp/vonvon', message: 'installed' })),
  cliObserve: vi.fn(async () => ({ kind: 'error' as const, message: 'absent' })),
  readRegistration: vi.fn(async (): Promise<Registration> => ({ kind: 'absent' })),
  verified: vi.fn(async (): Promise<VerifiedDaemon | null> => null),
  running: vi.fn(async (_previous: { pid: number; startedAt: string }) => false),
  stopDaemonForQuit: vi.fn(async () => {}),
  tray: { destroy: vi.fn(), setUpdate: vi.fn(), setNotice: vi.fn() },
  dock: {
    visible: true,
    isVisible: vi.fn(() => fake.dock.visible),
    show: vi.fn(async () => { fake.dock.visible = true; }),
    hide: vi.fn(() => { fake.dock.visible = false; }),
    setIcon: vi.fn(),
  },
  openExternal: vi.fn(async () => {}),
  loadPage: vi.fn(async () => {}),
  updateStops: [] as Array<() => void>,
  updateConfiguration: vi.fn(async () => ({ signed: true, manifestURL: 'https://updates.example.test/manifest.json' })),
  root: '/tmp/vonvon-native-test-root',
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const { pathToFileURL } = await import('node:url');
  class MockWebContents extends EventEmitter {
    mainFrame = { url: '' };
    session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
    windowOpenHandler: ((details: { url: string }) => { action: string }) | undefined;
    isDestroyed = () => false;
    send = vi.fn();
    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) { this.windowOpenHandler = handler; }
  }
  class MockWindow extends EventEmitter {
    webContents = new MockWebContents();
    visible = false;
    destroyed = false;
    show = vi.fn(() => { this.visible = true; });
    hide = vi.fn(() => { this.visible = false; });
    focus = vi.fn();
    restore = vi.fn();
    isMinimized = () => false;
    isFullScreen = () => false;
    isDestroyed = () => this.destroyed;
    destroy = vi.fn(() => { this.destroyed = true; });
    loadFile = vi.fn(async (path: string) => {
      await fake.loadPage();
      this.webContents.mainFrame.url = pathToFileURL(path).href;
      this.emit('ready-to-show');
    });
    constructor(readonly options: unknown) { super(); fake.window = this; }
  }
  class MockApp extends EventEmitter {
    dock: typeof fake.dock | undefined = fake.dock;
    requestSingleInstanceLock = vi.fn(() => false);
    quit = vi.fn();
    whenReady = vi.fn(async () => {});
    getAppPath = vi.fn(() => fake.root);
    getVersion = vi.fn(() => '0.1.0');
    getPath = vi.fn(() => fake.root);
    isPackaged = false;
  }
  const app = new MockApp();
  class MockUpdater extends EventEmitter {
    setFeedURL = vi.fn();
    checkForUpdates = vi.fn();
    quitAndInstall = vi.fn();
  }
  fake.app = app;
  return {
    app,
    autoUpdater: new MockUpdater(),
    // devices-ui-1a 4.8: main.ts seals device keys with safeStorage and wakes remote connections on resume.
    powerMonitor: new EventEmitter(),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from(`sealed:${plain}`),
      decryptString: (sealed: Buffer) => sealed.toString().replace(/^sealed:/, ''),
    },
    BrowserWindow: MockWindow,
    dialog: { showErrorBox: vi.fn(), showMessageBoxSync: vi.fn(), showMessageBox: vi.fn(async () => ({ response: 0 })) },
    Menu: { buildFromTemplate: vi.fn((items: unknown) => items), setApplicationMenu: vi.fn() },
    net: { fetch: vi.fn() },
  };
});

vi.mock('../src/attach.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/attach.js')>(), attachExisting: fake.attach,
}));
vi.mock('../src/bridge.js', () => ({ installBridge: fake.install, openAllowedExternal: fake.openExternal }));
vi.mock('../src/tray.js', () => ({ createDesktopTray: vi.fn(() => fake.tray) }));
vi.mock('../src/update-configuration.js', () => ({ desktopUpdateConfiguration: fake.updateConfiguration }));
vi.mock('../src/updates.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/updates.js')>();
  return {
    ...actual,
    scheduleUpdateChecks: (...args: Parameters<typeof actual.scheduleUpdateChecks>) => {
      const stop = actual.scheduleUpdateChecks(...args);
      fake.updateStops.push(stop);
      return stop;
    },
  };
});
vi.mock('../src/quit-daemon.js', () => ({ stopDaemonForQuit: fake.stopDaemonForQuit }));
vi.mock('../src/daemon-dependencies.js', () => ({
  prepareDesktopRoot: vi.fn(async () => fake.root),
  createDaemonDependencies: vi.fn(() => ({ readRegistration: fake.readRegistration, readVerifiedDaemon: fake.verified, ownerRunning: fake.running })),
}));
vi.mock('../src/cli-registration.js', () => ({
  desktopCliOptions: vi.fn((options: unknown) => options),
  registerCli: fake.cliRegister,
  observeCli: fake.cliObserve,
}));
vi.mock('../src/daemon-manager.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/daemon-manager.js')>(),
  createDaemonManager: vi.fn(() => ({ ensureReady: fake.ready })),
}));
vi.mock('../../daemon/src/config/data-root.js', () => ({ resolveDataRoot: vi.fn(() => ({ kind: 'canonical', path: fake.root })) }));
vi.mock('../src/login-item.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/login-item.js')>();
  return { ...actual, changeLoginItem: vi.fn(actual.changeLoginItem), repairServiceAtStartup: vi.fn(actual.repairServiceAtStartup) };
});

import { startDesktop, desktopResources } from '../src/main.js';
import { desktopFullScreenChannel } from '../src/ipc-contract.js';
import { changeLoginItem, repairServiceAtStartup } from '../src/login-item.js';
import { AttachError } from '../src/attach.js';
import { ConnectionError, RpcError } from '@vonvon/client/browser';
import { autoUpdater, dialog, Menu, net, powerMonitor } from 'electron';
import type { DeviceConnections } from '../src/connections.js';
import { createDesktopTray } from '../src/tray.js';

type MockApp = EventEmitter & { dock: typeof fake.dock | undefined; requestSingleInstanceLock: ReturnType<typeof vi.fn>; quit: ReturnType<typeof vi.fn>; getAppPath: ReturnType<typeof vi.fn> };
type MockWindow = EventEmitter & {
  visible: boolean;
  destroyed: boolean;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  webContents: EventEmitter & { mainFrame: { url: string }; send: ReturnType<typeof vi.fn>; windowOpenHandler?: (details: { url: string }) => { action: string } };
};

let app: MockApp;
let window: MockWindow;
let appPath: string;
let temp: string;
let actions: ShellActions;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'vonvon-native-'));
  fake.root = temp;
  vi.mocked(autoUpdater.setFeedURL).mockReset();
  vi.mocked(autoUpdater.checkForUpdates).mockReset();
  vi.mocked(autoUpdater.quitAndInstall).mockReset();
  autoUpdater.removeAllListeners();
  powerMonitor.removeAllListeners();
  vi.mocked(dialog.showErrorBox).mockClear();
  vi.mocked(dialog.showMessageBox).mockClear();
  vi.mocked(dialog.showMessageBoxSync).mockClear();
  vi.mocked(changeLoginItem).mockClear();
  vi.mocked(repairServiceAtStartup).mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the update check must use Electron net'); }));
  vi.mocked(net.fetch).mockReset().mockImplementation(async () => new Response(JSON.stringify({
    version: '0.2.0', feedURL: 'https://updates.example.test/feed',
  })));
  const resources = join(await realpath(temp), 'resources');
  await mkdir(resources);
  const alias = join(temp, 'resources-alias');
  await symlink(resources, alias, 'dir');
  appPath = join(alias, 'desktop');
  await mkdir(join(appPath, '..', 'ui', 'dist'), { recursive: true });
  await mkdir(join(appPath, 'dist'), { recursive: true });
  await mkdir(join(appPath, 'assets'), { recursive: true });
  await writeFile(join(appPath, '..', 'ui', 'dist', 'index.html'), '<html></html>');
  await writeFile(join(appPath, 'dist', 'preload.cjs'), '');
  await writeFile(join(appPath, 'assets', 'tray.png'), 'png');
  app = fake.app as MockApp;
  app.removeAllListeners();
  app.requestSingleInstanceLock.mockReturnValue(true);
  app.getAppPath.mockReturnValue(appPath);
  app.quit.mockClear();
  app.dock = fake.dock;
  fake.dock.visible = true;
  fake.dock.isVisible.mockClear();
  fake.dock.hide.mockClear();
  fake.dock.show.mockReset().mockImplementation(async () => { fake.dock.visible = true; });
  fake.bridge.requestQuit.mockClear();
  fake.bridge.dispose.mockClear().mockResolvedValue(undefined);
  fake.bridge.replaceOwner.mockClear().mockResolvedValue(undefined);
  fake.bridge.deferLocalLost.mockReset().mockReturnValue(false);
  fake.owner.dispose.mockClear();
  fake.tray.destroy.mockClear();
  fake.tray.setUpdate.mockClear();
  fake.tray.setNotice.mockClear();
  fake.bridge.publishUpdate.mockClear();
  fake.bridge.sendRemoteUpdate.mockClear();
  fake.bridge.localOwner.mockReset().mockReturnValue(null);
  fake.bridge.onLocalOwner.mockReset().mockReturnValue(() => {});
  fake.attach.mockReset().mockResolvedValue(fake.owner);
  fake.ready.mockClear();
  fake.cliRegister.mockClear();
  fake.cliObserve.mockClear();
  fake.readRegistration.mockClear().mockResolvedValue({ kind: 'absent' });
  fake.verified.mockReset().mockResolvedValue(null);
  fake.running.mockReset().mockResolvedValue(false);
  fake.stopDaemonForQuit.mockReset().mockResolvedValue(undefined);
  fake.install.mockReset().mockReturnValue(fake.bridge);
  fake.openExternal.mockClear();
  fake.loadPage.mockReset().mockResolvedValue(undefined);
  await startDesktop();
  window = fake.window as MockWindow;
  actions = fake.install.mock.lastCall?.[3];
});

afterEach(async () => {
  for (const stop of fake.updateStops.splice(0)) stop();
  vi.unstubAllGlobals();
  await rm(temp, { recursive: true, force: true });
});

async function downloadUpdate(): Promise<void> {
  await expect(actions.checkDesktopUpdate()).resolves.toMatchObject({ state: 'available' });
  expect(net.fetch).toHaveBeenLastCalledWith('https://updates.example.test/manifest.json', expect.objectContaining({ redirect: 'error' }));
  const downloading = actions.installDesktopUpdate();
  expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
  autoUpdater.emit('update-downloaded');
  await expect(downloading).resolves.toMatchObject({ state: 'downloaded' });
  expect(window.destroyed).toBe(false);
  expect(app.quit).not.toHaveBeenCalled();
}

describe('explicit desktop quit', () => {
  it('keeps the desktop and tray alive until the daemon and its Bots have stopped', async () => {
    let stopped!: () => void;
    fake.stopDaemonForQuit.mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve; }));
    const quitting = actions.confirmQuit();
    await vi.waitFor(() => expect(fake.stopDaemonForQuit).toHaveBeenCalledOnce());
    expect(actions.isExpectedDisconnect()).toBe(true);
    expect(fake.bridge.dispose).not.toHaveBeenCalled();
    expect(window.destroyed).toBe(false);
    expect(fake.tray.destroy).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    stopped();
    await quitting;
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    expect(window.destroyed).toBe(true);
    expect(fake.tray.destroy).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('coalesces repeated quit requests while the daemon is draining', async () => {
    let stopped!: () => void;
    fake.stopDaemonForQuit.mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve; }));
    const first = actions.confirmQuit();
    const second = actions.confirmQuit();
    await vi.waitFor(() => expect(fake.stopDaemonForQuit).toHaveBeenCalledOnce());
    stopped();
    await Promise.all([first, second]);
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('keeps the app available and permits retry when background shutdown is not confirmed', async () => {
    const failure = new Error('后台尚未确认停止');
    actions.hide();
    expect(window.visible).toBe(false);
    fake.stopDaemonForQuit.mockRejectedValueOnce(failure);
    await expect(actions.confirmQuit()).rejects.toBe(failure);
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(window.visible).toBe(true);
    expect(window.destroyed).toBe(false);
    expect(fake.bridge.dispose).not.toHaveBeenCalled();
    expect(fake.tray.destroy).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    const quit = { preventDefault: vi.fn() };
    app.emit('before-quit', quit);
    expect(quit.preventDefault).toHaveBeenCalledOnce();
    expect(fake.bridge.requestQuit).toHaveBeenCalledOnce();
    await actions.confirmQuit();
    expect(fake.stopDaemonForQuit).toHaveBeenCalledTimes(2);
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('preserves a window closed during background drain so failed quit can restore and retry it', async () => {
    let failStop!: (error: Error) => void;
    fake.stopDaemonForQuit.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { failStop = reject; }));
    const quitting = actions.confirmQuit();
    await vi.waitFor(() => expect(fake.stopDaemonForQuit).toHaveBeenCalledOnce());
    const close = { preventDefault: vi.fn() };
    window.emit('close', close);
    expect(close.preventDefault).toHaveBeenCalledOnce();
    expect(window.visible).toBe(false);
    expect(fake.dock.visible).toBe(false);
    expect(window.destroyed).toBe(false);
    expect(fake.bridge.dispose).not.toHaveBeenCalled();
    const failure = new Error('后台尚未确认停止');
    const rejected = expect(quitting).rejects.toBe(failure);
    failStop(failure);
    await rejected;
    await vi.waitFor(() => {
      expect(window.visible).toBe(true);
      expect(fake.dock.visible).toBe(true);
    });
    expect(window.destroyed).toBe(false);
    expect(fake.tray.destroy).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    await actions.confirmQuit();
    expect(fake.stopDaemonForQuit).toHaveBeenCalledTimes(2);
    expect(window.destroyed).toBe(true);
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it.each(['startHost', 'service start'] as const)('waits for %s before stopping its authenticated successor', async operation => {
    fake.readRegistration.mockResolvedValue({ kind: 'ours' });
    let started!: (value: VerifiedDaemon) => void;
    fake.ready.mockImplementationOnce(() => new Promise<VerifiedDaemon>(resolve => { started = resolve; }));
    const starting = operation === 'startHost' ? actions.startHost() : actions.service('start');
    await vi.waitFor(() => expect(fake.ready).toHaveBeenCalledTimes(2));
    const quitting = actions.confirmQuit();
    expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    const identity = { pid: 63, startedAt: 'start-before-quit', listen: '127.0.0.1:42345' };
    const next = { identity, dispose: vi.fn(async () => {}) };
    fake.attach.mockResolvedValueOnce(next);
    started(identity);
    await starting;
    await quitting;
    expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next);
    expect(fake.stopDaemonForQuit).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('routes the tray Quit and native Dock Quit through the same confirmed exit', async () => {
    const trayQuit = vi.mocked(createDesktopTray).mock.lastCall?.[2];
    expect(trayQuit).toBeTypeOf('function');
    trayQuit?.();
    expect(fake.bridge.requestQuit).toHaveBeenCalledOnce();
    app.emit('before-quit', { preventDefault: vi.fn() });
    expect(fake.bridge.requestQuit).toHaveBeenCalledTimes(2);
    expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
    await actions.confirmQuit();
    expect(fake.stopDaemonForQuit).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('preserves the background daemon when only the window is closed', () => {
    const close = { preventDefault: vi.fn() };
    window.emit('close', close);
    expect(close.preventDefault).toHaveBeenCalledOnce();
    expect(window.visible).toBe(false);
    expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
    expect(fake.bridge.dispose).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('does not turn desktop update installation into an explicit full quit', async () => {
    await downloadUpdate();
    await actions.installDesktopUpdate();
    expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
    // owner 2026-11-02: no question before 重启升级, on any platform; the button says it interrupts the conversations.
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('does not stop the independent daemon when the desktop renderer crashes', async () => {
    window.webContents.emit('render-process-gone');
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
  });
});

// devices-ui-4 第 5 节: another device updates this computer's Vonvon Bot. The app's own updater runs with Electron's
// updater as the fake driver: a remote applyCoreUpdate goes check → download → quitAndInstall. main 必败: no remote update.
describe('an update another device asks for', () => {
  function shellConnection() {
    const listeners = new Set<(payload: { requestId: string; action: 'check' | 'apply'; by: string }) => void>();
    const client = {
      admin: vi.fn(async () => ({ kind: 'negotiated', principal: 'owner:local', scope: null })),
      machine: vi.fn(async () => ({ type: 'done', message: '已收到。' })),
      onDesktopUpdateRequest: vi.fn((listener: (payload: { requestId: string; action: 'check' | 'apply'; by: string }) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
      onError: vi.fn((_listener: (error: Error) => void) => () => {}),
    };
    const ask = (action: 'check' | 'apply') => { for (const listener of [...listeners]) listener({ requestId: 'dur_0123456789abcdef', action, by: '「笔记本」' }); };
    const states = () => client.machine.mock.calls.map(call => ((call as unknown[])[0] as { state: string }).state);
    // the bridge hands the remote update this computer's daemon connection
    const attach = fake.bridge.onLocalOwner.mock.lastCall?.[0] as (owner: { client: typeof client }) => void;
    attach({ client });
    return { client, ask, states, listeners };
  }

  it('declares it can on this computer\'s daemon connection, and answers a check with the app\'s own', async () => {
    const shell = shellConnection();
    expect(shell.client.admin).toHaveBeenCalledExactlyOnceWith({ type: 'negotiate', capabilities: ['desktop.self-update'] });
    shell.ask('check');
    await vi.waitFor(() => expect(shell.client.machine).toHaveBeenCalledOnce());
    expect(shell.client.machine).toHaveBeenCalledWith(expect.objectContaining({ type: 'desktopUpdateReport', state: 'available', latest: '0.2.0' }));
    expect(fake.bridge.publishUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'available', latest: '0.2.0' }));
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('downloads, says so here, reports each step, and quits and installs without asking', async () => {
    const shell = shellConnection();
    shell.ask('apply');
    await vi.waitFor(() => expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce());
    const notice = '「笔记本」正在更新这台电脑上的 Vonvon Bot。下载好后会直接重启，正在进行的对话会被中断。';
    expect(fake.tray.setNotice).toHaveBeenLastCalledWith(notice);
    expect(fake.bridge.sendRemoteUpdate).toHaveBeenLastCalledWith(notice);
    await vi.waitFor(() => expect(shell.states()).toEqual(['downloading']));
    // this computer's 重启升级 waits for it
    await expect(actions.installDesktopUpdate()).rejects.toThrow('正在按另一台设备的请求更新，下载好后会自动安装并重启。');
    autoUpdater.emit('update-downloaded');
    await vi.waitFor(() => expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce());
    expect(shell.states()).toEqual(['downloading', 'downloaded', 'restarting']);
    // `restarting` went before the app closed its connections
    expect(shell.client.machine.mock.invocationCallOrder.at(-1)).toBeLessThan(fake.bridge.dispose.mock.invocationCallOrder[0]!);
    expect(shell.listeners.size).toBe(0);
    expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
  });

  it('says why it stopped and takes the notice away when the download fails', async () => {
    const shell = shellConnection();
    shell.ask('apply');
    await vi.waitFor(() => expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce());
    autoUpdater.emit('error', new Error('/Users/someone/Library/Caches'));
    await vi.waitFor(() => expect(fake.tray.setNotice).toHaveBeenLastCalledWith(undefined));
    expect(shell.client.machine).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error', message: '桌面更新下载或签名校验失败' }));
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });
});

describe('updater final install lifecycle', () => {
  it('keeps the reserved titlebar in sync with native fullscreen and document reloads', () => {
    window.emit('enter-full-screen');
    expect(window.webContents.send).toHaveBeenLastCalledWith(desktopFullScreenChannel, true);
    window.emit('leave-full-screen');
    expect(window.webContents.send).toHaveBeenLastCalledWith(desktopFullScreenChannel, false);
    window.webContents.send.mockClear();
    window.webContents.emit('did-finish-load');
    expect(window.webContents.send).toHaveBeenCalledWith(desktopFullScreenChannel, false);
    window.webContents.mainFrame.url = 'https://untrusted.example/';
    window.webContents.send.mockClear();
    window.emit('enter-full-screen');
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
  it('keeps editing shortcuts and routes explicit quit only from the tray through draft confirmation', () => {
    const menu = vi.mocked(Menu.setApplicationMenu).mock.lastCall?.[0] as unknown as Array<{
      role?: string; label?: string; submenu?: Array<{ role?: string; label?: string; accelerator?: string; click?: () => void }>;
    }>;
    expect(menu).toContainEqual({ role: 'editMenu', label: '编辑' });
    const items = menu.flatMap(item => [item, ...item.submenu ?? []]);
    expect(items.some(item => item.role === 'quit' || item.label?.includes('退出'))).toBe(false);
    expect(menu.flatMap(item => item.submenu ?? []).some(item => /\+Q$/i.test(item.accelerator ?? ''))).toBe(false);
    const trayQuit = vi.mocked(createDesktopTray).mock.lastCall?.[2];
    trayQuit?.();
    expect(fake.bridge.requestQuit).toHaveBeenCalledOnce();
    expect(fake.bridge.dispose).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });
  it('exposes CLI repair and observation without changing the daemon owner', async () => {
    await expect(actions.observeCli()).resolves.toMatchObject({ kind: 'error', message: 'absent' });
    await expect(actions.repairCli()).resolves.toEqual({ type: 'done', message: 'installed' });
    expect(fake.cliRegister).toHaveBeenCalledOnce();
    expect(fake.bridge.replaceOwner).not.toHaveBeenCalled();
  });
  it('waits for daemon readiness before final authenticated attachment', () => {
    expect(fake.ready).toHaveBeenCalledExactlyOnceWith(0);
    expect(fake.attach).toHaveBeenCalledExactlyOnceWith(fake.root);
    expect(fake.ready.mock.invocationCallOrder[0]).toBeLessThan(fake.attach.mock.invocationCallOrder[0] ?? 0);
  });
  it.each(['cleanup rejection', 'state-path write failure', 'native install throw'] as const)(
    'shows a native error and permits owned-app exit after %s', async failure => {
      await downloadUpdate();
      if (failure === 'cleanup rejection') fake.bridge.dispose.mockRejectedValueOnce(new Error('close failed'));
      if (failure === 'state-path write failure') await mkdir(join(temp, 'desktop-update-expected-version'));
      if (failure === 'native install throw') vi.mocked(autoUpdater.quitAndInstall).mockImplementationOnce(() => {
        throw new Error('native install failed');
      });

      await expect(actions.installDesktopUpdate()).rejects.toThrow();
      expect(window.destroyed).toBe(true);
      expect(fake.tray.destroy).toHaveBeenCalledOnce();
      expect(fake.bridge.dispose).toHaveBeenCalledOnce();
      expect(fake.owner.dispose).not.toHaveBeenCalled();
      expect.soft(dialog.showErrorBox).toHaveBeenCalledWith('Vonvon Bot', expect.stringContaining('桌面更新没有完成'));
      expect.soft(app.quit).toHaveBeenCalledOnce();
      const quit = { preventDefault: vi.fn() };
      app.emit('before-quit', quit);
      expect.soft(quit.preventDefault).not.toHaveBeenCalled();
      expect(fake.bridge.requestQuit).not.toHaveBeenCalled();
      expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(failure === 'native install throw' ? 1 : 0);
    },
  );

  it('persists the expected version and delegates successful final exit to the native installer', async () => {
    await downloadUpdate();
    await expect(actions.installDesktopUpdate()).resolves.toMatchObject({ state: 'downloaded' });
    expect(await readFile(join(temp, 'desktop-update-expected-version'), 'utf8')).toBe('0.2.0');
    expect(window.destroyed).toBe(true);
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    const quit = { preventDefault: vi.fn() };
    app.emit('before-quit', quit);
    expect(quit.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps the renderer available for check and download errors', async () => {
    vi.mocked(net.fetch).mockRejectedValueOnce(new Error('check failed'));
    await expect(actions.checkDesktopUpdate()).rejects.toThrow('连不上更新服务器');
    await expect(actions.checkDesktopUpdate()).resolves.toMatchObject({ state: 'available' });
    const downloading = actions.installDesktopUpdate();
    autoUpdater.emit('error', new Error('download failed'));
    await expect(downloading).rejects.toThrow('桌面更新下载或签名校验失败');
    expect(window.destroyed).toBe(false);
    expect(window.visible).toBe(true);
    expect(fake.bridge.dispose).not.toHaveBeenCalled();
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });
});

describe('daemon restart from the window', () => {
  const previous = { pid: 42, startedAt: 'initial', listen: '127.0.0.1:42345' };
  const applied = async () => ({ kind: 'applied' as const, revision: 7 });

  it('waits for the daemon\'s own successor, reattaches it, and starts nothing', async () => {
    const successor = { pid: 43, startedAt: 'successor', listen: '127.0.0.1:42345' };
    const next = { identity: successor, dispose: vi.fn(async () => {}) };
    fake.verified.mockResolvedValueOnce(previous).mockResolvedValueOnce(null).mockResolvedValue(successor);
    fake.attach.mockResolvedValueOnce(next);
    const send = vi.fn(async () => {
      expect(actions.isExpectedDisconnect()).toBe(true);
      return applied();
    });
    await expect(actions.restartHost(previous, send)).resolves.toEqual({ kind: 'applied', revision: 7 });
    expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next);
    expect(fake.ready).toHaveBeenCalledTimes(1);
    expect(actions.isExpectedDisconnect()).toBe(false);
  });

  it('returns a refused restart unchanged and keeps later disconnects unexpected', async () => {
    const refused = { kind: 'refused' as const, code: 'unsupported', message: 'no control' };
    await expect(actions.restartHost(previous, async () => refused)).resolves.toEqual(refused);
    expect(fake.verified).not.toHaveBeenCalled();
    expect(actions.isExpectedDisconnect()).toBe(false);
  });

  it('keeps waiting while the old owner drains past the ownerless deadline', async () => {
    const successor = { pid: 44, startedAt: 'late', listen: '127.0.0.1:42345' };
    const next = { identity: successor, dispose: vi.fn(async () => {}) };
    let draining = true;
    fake.verified.mockImplementation(async () => draining ? previous : successor);
    fake.attach.mockResolvedValueOnce(next);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const restarting = actions.restartHost(previous, applied);
      await vi.advanceTimersByTimeAsync(120_000);
      draining = false;
      await vi.advanceTimersByTimeAsync(500);
      await expect(restarting).resolves.toEqual({ kind: 'applied', revision: 7 });
    } finally { vi.useRealTimers(); }
    expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next);
  });

  it('keeps the window and reports when no successor appears', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      fake.verified.mockResolvedValue(null);
      const settled = expect(actions.restartHost(previous, applied)).rejects.toThrow('没有回来');
      await vi.advanceTimersByTimeAsync(61_000);
      await settled;
    } finally { vi.useRealTimers(); }
    expect(fake.bridge.replaceOwner).not.toHaveBeenCalled();
    expect(actions.isExpectedDisconnect()).toBe(true);
    expect(window.destroyed).toBe(false);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('waits for an in-flight restart before stopping its fresh owner and quitting', async () => {
    const successor = { pid: 44, startedAt: 'after-quit-request', listen: '127.0.0.1:42345' };
    const next = { identity: successor, dispose: vi.fn(async () => {}) };
    fake.verified.mockResolvedValue(successor);
    fake.attach.mockResolvedValueOnce(next);
    let reply!: (result: { kind: 'applied'; revision: number }) => void;
    const restarting = actions.restartHost(previous, () => new Promise(resolve => { reply = resolve; }));
    const quitting = actions.confirmQuit();
    expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    reply({ kind: 'applied', revision: 7 });
    await expect(restarting).resolves.toEqual({ kind: 'applied', revision: 7 });
    await quitting;
    expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next);
    expect(fake.stopDaemonForQuit).toHaveBeenCalledOnce();
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('keeps the app alive when an in-flight operation prevents confirmed quit', async () => {
    const successor = { pid: 44, startedAt: 'late-reply', listen: '127.0.0.1:42345' };
    fake.verified.mockResolvedValue(successor);
    fake.attach.mockResolvedValueOnce({ identity: successor, dispose: vi.fn(async () => {}) });
    let reply!: (result: { kind: 'applied'; revision: number }) => void;
    const restarting = actions.restartHost(previous, () => new Promise(resolve => { reply = resolve; }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const quitting = expect(actions.confirmQuit()).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(61_000);
      await quitting;
    } finally { vi.useRealTimers(); }
    expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
    expect(fake.bridge.dispose).not.toHaveBeenCalled();
    expect(window.destroyed).toBe(false);
    expect(app.quit).not.toHaveBeenCalled();
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    reply({ kind: 'applied', revision: 7 });
    await restarting;
    await actions.confirmQuit();
    expect(fake.stopDaemonForQuit).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  for (const answer of ['old owner', 'successor'] as const) {
    it(`waits through a pending owner read returning the ${answer} before full quit`, async () => {
      const successor = { pid: 45, startedAt: 'after-quit', listen: '127.0.0.1:42345' };
      let release!: () => void;
      fake.verified.mockImplementationOnce(() => new Promise<VerifiedDaemon>(resolve => { release = () => resolve(answer === 'successor' ? successor : previous); }))
        .mockResolvedValue(successor);
      const next = { identity: successor, dispose: vi.fn(async () => {}) };
      fake.attach.mockResolvedValue(next);
      const restarting = actions.restartHost(previous, applied);
      await vi.waitFor(() => expect(fake.verified).toHaveBeenCalled());
      const quitting = actions.confirmQuit();
      expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
      release();
      await expect(restarting).resolves.toEqual({ kind: 'applied', revision: 7 });
      await quitting;
      expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next);
      expect(fake.stopDaemonForQuit).toHaveBeenCalledOnce();
      expect(app.quit).toHaveBeenCalledOnce();
    });
  }

  it('waits for an in-flight successor replacement before confirmed full quit', async () => {
    const successor = { pid: 47, startedAt: 'replacing', listen: '127.0.0.1:42345' };
    fake.verified.mockResolvedValue(successor);
    fake.attach.mockResolvedValue({ identity: successor, dispose: vi.fn(async () => {}) });
    let replaced!: () => void;
    fake.bridge.replaceOwner.mockImplementationOnce(() => new Promise<void>(resolve => { replaced = resolve; }));
    const restarting = actions.restartHost(previous, applied);
    await vi.waitFor(() => expect(fake.bridge.replaceOwner).toHaveBeenCalled());
    const quitting = actions.confirmQuit();
    expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
    expect(fake.bridge.dispose).not.toHaveBeenCalled();
    replaced();
    await restarting;
    await quitting;
    expect(fake.stopDaemonForQuit).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('lets update cleanup cancel a restart while successor replacement is pending', async () => {
    const successor = { pid: 47, startedAt: 'replacing-update', listen: '127.0.0.1:42345' };
    await downloadUpdate();
    fake.verified.mockResolvedValue(successor);
    fake.attach.mockResolvedValue({ identity: successor, dispose: vi.fn(async () => {}) });
    fake.bridge.replaceOwner.mockImplementationOnce(() => new Promise<void>(() => {}));
    const restarting = actions.restartHost(previous, applied);
    const cancelled = expect(restarting).rejects.toThrow('重启已取消。');
    await vi.waitFor(() => expect(fake.bridge.replaceOwner).toHaveBeenCalled());
    await actions.installDesktopUpdate();
    await cancelled;
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('waits for a late successor attachment before full quit', async () => {
    const successor = { pid: 48, startedAt: 'late', listen: '127.0.0.1:42345' };
    const next = { identity: successor, dispose: vi.fn(async () => {}) };
    let deliver!: () => void;
    fake.verified.mockResolvedValue(successor);
    fake.attach.mockImplementationOnce(() => new Promise(resolve => { deliver = () => resolve(next); }));
    const restarting = actions.restartHost(previous, applied);
    await vi.waitFor(() => expect(fake.attach).toHaveBeenCalledTimes(2));
    const quitting = actions.confirmQuit();
    expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
    deliver();
    await restarting;
    await quitting;
    expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next);
    expect(fake.stopDaemonForQuit).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('lets the desktop update cleanup cancel a restart before it attaches the successor', async () => {
    const successor = { pid: 46, startedAt: 'after-update', listen: '127.0.0.1:42345' };
    await downloadUpdate();
    let release!: () => void;
    fake.verified.mockImplementation(() => new Promise<VerifiedDaemon>(resolve => { release = () => resolve(successor); }));
    fake.attach.mockResolvedValue({ identity: successor, dispose: vi.fn(async () => {}) });
    const restarting = actions.restartHost(previous, applied);
    await vi.waitFor(() => expect(fake.verified).toHaveBeenCalled());
    const installing = actions.installDesktopUpdate();
    release();
    await expect(restarting).rejects.toThrow('重启已取消。');
    await installing;
    expect(fake.attach).toHaveBeenCalledTimes(1);
    expect(fake.bridge.replaceOwner).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });
});

describe('a service helper started from the web UI or a terminal', () => {
  const previous = { pid: 42, startedAt: 'initial', listen: '127.0.0.1:42345' };

  it('takes the dropped connection as expected and reattaches to the daemon the helper hands over', async () => {
    const successor = { pid: 43, startedAt: 'service', listen: '127.0.0.1:42345' };
    const next = { identity: successor, dispose: vi.fn(async () => {}) };
    await writeFile(join(temp, 'service-action.json'), JSON.stringify({ pid: process.pid, action: 'install', phase: 'running', startedAt: Date.now() }));
    fake.verified.mockResolvedValueOnce(null).mockResolvedValue(successor);
    fake.ready.mockResolvedValueOnce(successor);
    fake.attach.mockResolvedValueOnce(next);
    expect(actions.recoverConnection(previous)).toBe(true);
    expect(actions.isExpectedDisconnect()).toBe(true);
    await vi.waitFor(() => expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next));
    expect(actions.isExpectedDisconnect()).toBe(false);
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
  });


});

describe('machine page stop', () => {
  const previous = { pid: 42, startedAt: 'initial', listen: '127.0.0.1:42345' };
  const done = async () => ({ type: 'done' as const, message: '正在停止 daemon。' });

  it('s18g stop expects disconnect, waits for old process exit, and allows a fresh start', async () => {
    fake.running.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    const send = vi.fn(async () => {
      expect(actions.isExpectedDisconnect()).toBe(true);
      return done();
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const stopping = actions.stopHost(previous, send);
      expect(actions.isExpectedDisconnect()).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
      await expect(stopping).resolves.toEqual({ type: 'done', message: 'daemon 已停止。' });
    } finally { vi.useRealTimers(); }
    expect(send).toHaveBeenCalledOnce();
    expect(fake.running).toHaveBeenCalledTimes(3);
    expect(fake.running.mock.calls.every(([identity]) => identity === previous)).toBe(true);
    expect(actions.isExpectedDisconnect()).toBe(true);
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
    const identity = { ...previous, pid: 43, startedAt: 'new' };
    const next = { identity, dispose: vi.fn(async () => {}) };
    fake.ready.mockResolvedValueOnce(identity);
    fake.attach.mockResolvedValueOnce(next);
    await expect(actions.startHost()).resolves.toMatchObject({ message: 'daemon 已启动。' });
    expect(actions.isExpectedDisconnect()).toBe(false);
  });

  it('s18g start waits until machine page stop finishes draining', async () => {
    let running = true;
    fake.running.mockImplementation(async () => running);
    const identity = { ...previous, pid: 44, startedAt: 'after-stop' };
    const next = { identity, dispose: vi.fn(async () => {}) };
    fake.ready.mockResolvedValueOnce(identity);
    fake.attach.mockResolvedValueOnce(next);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const stopping = actions.stopHost(previous, done);
      let started = false;
      const starting = actions.startHost().then(reply => { started = true; return reply; });
      await vi.advanceTimersByTimeAsync(750);
      expect(fake.ready).toHaveBeenCalledTimes(1);
      expect(started).toBe(false);
      running = false;
      await vi.advanceTimersByTimeAsync(250);
      await expect(stopping).resolves.toMatchObject({ message: 'daemon 已停止。' });
      await expect(starting).resolves.toMatchObject({ message: 'daemon 已启动。' });
    } finally { vi.useRealTimers(); }
    expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next);
  });

  it('s18g stop preserves an RPC refusal and clears expected disconnect', async () => {
    const refusal = new RpcError('unsupported', '不支持');
    await expect(actions.stopHost(previous, async () => { throw refusal; })).rejects.toBe(refusal);
    expect(actions.isExpectedDisconnect()).toBe(false);
    expect(fake.running).not.toHaveBeenCalled();
  });

  it('s18g stop waits for exit after the daemon closes before replying', async () => {
    await expect(actions.stopHost(previous, async () => { throw new Error('Daemon connection closed'); }))
      .resolves.toEqual({ type: 'done', message: 'daemon 已停止。' });
    expect(fake.running).toHaveBeenCalledExactlyOnceWith(previous);
  });

  it('s18g stop times out after one minute and frees startup', async () => {
    fake.running.mockResolvedValue(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const stopping = expect(actions.stopHost(previous, done)).rejects.toThrow('1 分钟内没停完');
      await vi.advanceTimersByTimeAsync(61_000);
      await stopping;
    } finally { vi.useRealTimers(); }
    expect(actions.isExpectedDisconnect()).toBe(false);
    const identity = { ...previous, pid: 45, startedAt: 'after-timeout' };
    fake.ready.mockResolvedValueOnce(identity);
    fake.attach.mockResolvedValueOnce({ identity, dispose: vi.fn(async () => {}) });
    await expect(actions.startHost()).resolves.toMatchObject({ message: 'daemon 已启动。' });
  });

  it('waits for a requested machine-page stop to finish before full quit', async () => {
    let running = true;
    fake.running.mockImplementation(async () => running);
    const stopping = actions.stopHost(previous, done);
    await vi.waitFor(() => expect(fake.running).toHaveBeenCalled());
    const quitting = actions.confirmQuit();
    expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
    expect(fake.bridge.dispose).not.toHaveBeenCalled();
    running = false;
    await expect(stopping).resolves.toMatchObject({ type: 'done' });
    await quitting;
    expect(fake.stopDaemonForQuit).toHaveBeenCalledOnce();
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
  });

  it('s18g stop refuses during passive reconnection without sending', async () => {
    fake.attach.mockRejectedValue(new AttachError('owner'));
    expect(actions.recoverConnection(previous)).toBe(true);
    const send = vi.fn(done);
    await expect(actions.stopHost(previous, send)).rejects.toThrow('正在启动、重启或重新连接 daemon，等它结束再停止。');
    expect(send).not.toHaveBeenCalled();
    await actions.confirmQuit();
  });

  it('waits for a pending stop reply before full quit', async () => {
    let reply!: (value: Awaited<ReturnType<typeof done>>) => void;
    const send = vi.fn(() => new Promise<Awaited<ReturnType<typeof done>>>(resolve => { reply = resolve; }));
    const stopping = actions.stopHost(previous, send);
    const quitting = actions.confirmQuit();
    expect(fake.stopDaemonForQuit).not.toHaveBeenCalled();
    expect(fake.running).not.toHaveBeenCalled();
    reply(await done());
    await stopping;
    await quitting;
    expect(send).toHaveBeenCalledOnce();
    expect(fake.stopDaemonForQuit).toHaveBeenCalledOnce();
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
  });
});

describe('passive daemon reconnection', () => {
  const previous = { pid: 42, startedAt: 'initial', listen: '127.0.0.1:42345' };

  it('s18g manual start takes over passive reconnection without a late dialog', async () => {
    fake.attach.mockRejectedValue(new AttachError('owner'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      expect(actions.recoverConnection(previous)).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      const identity = { ...previous, pid: 52, startedAt: 'manual' };
      const next = { identity, dispose: vi.fn(async () => {}) };
      fake.ready.mockResolvedValueOnce(identity);
      fake.attach.mockResolvedValue(next);
      await expect(actions.startHost()).resolves.toMatchObject({ message: 'daemon 已启动。' });
      expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('s18g takeover waits for passive replacement to settle before replacing again', async () => {
    const candidate = { identity: previous, dispose: vi.fn(async () => {}) };
    const identity = { ...previous, pid: 53, startedAt: 'manual' };
    const next = { identity, dispose: vi.fn(async () => {}) };
    let rejectFirst!: (error: Error) => void;
    let firstSettled = false;
    candidate.dispose.mockImplementation(async () => {
      queueMicrotask(() => { firstSettled = true; rejectFirst(new Error('candidate closed')); });
    });
    fake.bridge.replaceOwner.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(async () => { expect(firstSettled).toBe(true); });
    fake.attach.mockResolvedValueOnce(candidate).mockResolvedValueOnce(next);
    fake.ready.mockResolvedValueOnce(identity);
    expect(actions.recoverConnection(previous)).toBe(true);
    await vi.waitFor(() => expect(fake.bridge.replaceOwner).toHaveBeenCalledTimes(1));
    await expect(actions.startHost()).resolves.toMatchObject({ message: 'daemon 已启动。' });
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(fake.bridge.replaceOwner).toHaveBeenLastCalledWith(next);
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
  });

  it('s18g installed service start takes over passive reconnection', async () => {
    fake.attach.mockRejectedValue(new AttachError('owner'));
    fake.readRegistration.mockResolvedValue({ kind: 'ours' });
    expect(actions.recoverConnection(previous)).toBe(true);
    const identity = { ...previous, pid: 54, startedAt: 'service-start' };
    const next = { identity, dispose: vi.fn(async () => {}) };
    fake.ready.mockResolvedValueOnce(identity);
    fake.attach.mockResolvedValue(next);
    await expect(actions.service('start')).resolves.toMatchObject({ message: '后台服务已启动。' });
    expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next);
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
  });

  it('s18g simultaneous manual starts after passive reconnection launch only one daemon', async () => {
    fake.attach.mockRejectedValue(new AttachError('owner'));
    expect(actions.recoverConnection(previous)).toBe(true);
    const identity = { ...previous, pid: 55, startedAt: 'one-start' };
    fake.ready.mockResolvedValueOnce(identity);
    fake.attach.mockResolvedValue({ identity, dispose: vi.fn(async () => {}) });
    const outcomes = await Promise.allSettled([actions.startHost(), actions.startHost()]);
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
    const rejected = outcomes.find(value => value.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.objectContaining({ message: expect.stringContaining('等它结束再启动') }) });
    expect(fake.ready).toHaveBeenCalledTimes(2);
  });

  it('s18g quit prevents a start waiting for passive takeover from launching', async () => {
    fake.attach.mockRejectedValue(new AttachError('owner'));
    expect(actions.recoverConnection(previous)).toBe(true);
    const starting = actions.startHost();
    const rejected = expect(starting).rejects.toThrow();
    await actions.confirmQuit();
    await rejected;
    expect(fake.ready).toHaveBeenCalledTimes(1);
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
  });

  it('follows three external restarts without starting a daemon', async () => {
    let lost = previous;
    for (let crash = 1; crash <= 3; crash++) {
      const identity = { pid: 42 + crash, startedAt: `crash-${crash}`, listen: `127.0.0.1:${43000 + crash}` };
      const next = { identity, dispose: vi.fn(async () => {}) };
      fake.attach.mockRejectedValueOnce(new AttachError('owner')).mockResolvedValueOnce(next);
      expect(actions.recoverConnection(lost)).toBe(true);
      await vi.waitFor(() => expect(fake.bridge.replaceOwner).toHaveBeenCalledTimes(crash));
      expect(fake.bridge.replaceOwner).toHaveBeenLastCalledWith(next);
      expect(actions.isExpectedDisconnect()).toBe(false);
      lost = identity;
    }
    expect(fake.ready).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
  });

  it('can reconnect the same authenticated daemon after a transport failure', async () => {
    const next = { identity: previous, dispose: vi.fn(async () => {}) };
    fake.attach.mockResolvedValueOnce(next);
    expect(actions.recoverConnection(previous)).toBe(true);
    await vi.waitFor(() => expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next));
    expect(fake.ready).toHaveBeenCalledTimes(1);
  });

  it('retains the lost-connection dialog when no daemon comes back', async () => {
    fake.attach.mockRejectedValue(new AttachError('owner'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      expect(actions.recoverConnection(previous)).toBe(true);
      await vi.advanceTimersByTimeAsync(61_000);
    } finally { vi.useRealTimers(); }
    expect(dialog.showMessageBoxSync).toHaveBeenCalledOnce();
    expect(fake.bridge.replaceOwner).not.toHaveBeenCalled();
    expect(fake.ready).toHaveBeenCalledTimes(1);
    expect(window.destroyed).toBe(false);
  });

  it.each(['root', 'credential'] as const)('does not retry invalid %s state', async reason => {
    fake.attach.mockRejectedValue(new AttachError(reason));
    expect(actions.recoverConnection(previous)).toBe(true);
    await vi.waitFor(() => expect(dialog.showMessageBoxSync).toHaveBeenCalledOnce());
    expect(fake.attach).toHaveBeenCalledTimes(2);
  });

  it.each(['connection', 'identity'] as const)('retries a transient %s failure', async reason => {
    const next = { identity: previous, dispose: vi.fn(async () => {}) };
    fake.attach.mockRejectedValueOnce(new AttachError(reason)).mockResolvedValueOnce(next);
    expect(actions.recoverConnection(previous)).toBe(true);
    await vi.waitFor(() => expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next));
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
  });

  it('retries when a replacement daemon loses its connection before its first snapshot', async () => {
    const lost = { identity: previous, dispose: vi.fn(async () => {}) };
    const next = { identity: { ...previous, pid: 45 }, dispose: vi.fn(async () => {}) };
    fake.attach.mockResolvedValueOnce(lost).mockResolvedValueOnce(next);
    fake.bridge.replaceOwner.mockRejectedValueOnce(new ConnectionError('candidate crashed'));
    expect(actions.recoverConnection(previous)).toBe(true);
    await vi.waitFor(() => expect(fake.bridge.replaceOwner).toHaveBeenCalledTimes(2));
    expect(fake.bridge.replaceOwner).toHaveBeenLastCalledWith(next);
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
    expect(fake.ready).toHaveBeenCalledTimes(1);
  });

  it('reports an unexpected attachment failure without retrying it', async () => {
    fake.attach.mockRejectedValueOnce(new Error('physical close failed'));
    expect(actions.recoverConnection(previous)).toBe(true);
    await vi.waitFor(() => expect(dialog.showMessageBoxSync).toHaveBeenCalledOnce());
    expect(fake.attach).toHaveBeenCalledTimes(2);
  });

  it('closes a candidate when the deadline expires during its initial snapshot', async () => {
    let rejectReplacement!: (error: Error) => void;
    const next = { identity: previous, dispose: vi.fn(async () => { rejectReplacement(new Error('closed')); }) };
    fake.attach.mockResolvedValueOnce(next);
    fake.bridge.replaceOwner.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectReplacement = reject; }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      expect(actions.recoverConnection(previous)).toBe(true);
      await vi.advanceTimersByTimeAsync(61_000);
    } finally { vi.useRealTimers(); }
    expect(next.dispose).toHaveBeenCalledOnce();
    expect(dialog.showMessageBoxSync).toHaveBeenCalledOnce();
    expect(actions.isExpectedDisconnect()).toBe(false);
  });

  it.each(['quit', 'update cleanup'] as const)('lets %s cancel a pending attachment and closes its late candidate once', async stop => {
    if (stop === 'update cleanup') await downloadUpdate();
    const next = { identity: previous, dispose: vi.fn(async () => {}) };
    let deliver!: () => void;
    fake.attach.mockImplementationOnce(() => new Promise(resolve => { deliver = () => resolve(next); }));
    expect(actions.recoverConnection(previous)).toBe(true);
    expect(actions.recoverConnection(previous)).toBe(false);
    await (stop === 'quit' ? actions.confirmQuit() : actions.installDesktopUpdate());
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    deliver();
    await vi.waitFor(() => expect(next.dispose).toHaveBeenCalledOnce());
    expect(fake.bridge.replaceOwner).not.toHaveBeenCalled();
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
  });
});

describe('native window lifecycle', () => {
  it('refuses the switch in an app that cannot set it, before expecting a disconnect, and refuses stop', async () => {
    // JP-VPS and the Linux job run on Linux; the macOS job runs the unpackaged app.
    const refusal = process.platform === 'darwin' ? '要用打包的 Vonvon Bot 才能设置登录时启动。' : '这台电脑上不能设置登录时启动。';
    await expect(actions.setLoginItem(true)).rejects.toThrow(refusal);
    await expect(actions.setLoginItem(false)).rejects.toThrow(refusal);
    for (const action of ['install', 'uninstall'] as const) await expect(actions.service(action)).rejects.toThrow(refusal);
    await expect(actions.service('stop')).rejects.toThrow('桌面版还不能单独停止后台服务');
    expect(fake.ready).toHaveBeenCalledTimes(1);
    expect(fake.bridge.replaceOwner).not.toHaveBeenCalled();
    expect(actions.isExpectedDisconnect()).toBe(false);
  });

  it('turns service install and uninstall into the login-item switch with the attached daemon', async () => {
    const previous = { pid: 42, startedAt: 'initial', listen: '127.0.0.1:42345' };
    const during: boolean[] = [];
    const change = async (...[, , , hooks]: Parameters<typeof changeLoginItem>) => {
      hooks.expectDisconnect(true);
      during.push(actions.isExpectedDisconnect());
      hooks.expectDisconnect(false);
    };
    vi.mocked(changeLoginItem).mockImplementationOnce(change).mockImplementationOnce(change);
    await expect(actions.service('install', previous)).resolves.toEqual({ type: 'done', message: '已打开登录时启动。' });
    await expect(actions.service('uninstall', previous)).resolves.toEqual({ type: 'done', message: '已关闭登录时启动。' });
    expect(vi.mocked(changeLoginItem).mock.calls.map(call => [call[0].root, call[1], call[2]])).toEqual([[fake.root, true, previous], [fake.root, false, previous]]);
    expect(during).toEqual([true, true]);
    expect(actions.isExpectedDisconnect()).toBe(false);
  });

  it('shows why the startup repair failed instead of the readiness error, and as a notice when the daemon came up', async () => {
    const notice = '后台服务没能更新到这个位置的 Vonvon Bot：系统设置里关掉了 Vonvon Bot 的后台运行。';
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(0);
    vi.mocked(repairServiceAtStartup).mockResolvedValueOnce(notice);
    await startDesktop();
    expect(dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ type: 'warning', message: notice }));
    vi.mocked(repairServiceAtStartup).mockResolvedValueOnce(notice);
    fake.ready.mockRejectedValueOnce(new Error('后台服务启动超时，一直没有就绪。'));
    await startDesktop();
    await vi.waitFor(() => expect(dialog.showErrorBox).toHaveBeenCalledWith('Vonvon Bot', notice));
    expect(dialog.showErrorBox).not.toHaveBeenCalledWith('Vonvon Bot', expect.stringContaining('启动超时'));
  });

  it('starts a registered service through the manager and blocks a concurrent start', async () => {
    fake.readRegistration.mockResolvedValue({ kind: 'ours' });
    let release!: (value: VerifiedDaemon) => void;
    fake.ready.mockImplementationOnce(() => new Promise<VerifiedDaemon>(resolve => { release = resolve; }));
    const first = actions.service('start');
    await Promise.resolve();
    await expect(actions.startHost()).rejects.toThrow('等它结束再启动');
    const identity = { pid: 53, startedAt: 'managed', listen: '127.0.0.1:42345' };
    const next = { identity, dispose: vi.fn(async () => {}) };
    fake.attach.mockResolvedValueOnce(next);
    release(identity);
    await expect(first).resolves.toEqual({ type: 'done', message: '后台服务已启动。' });
    expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next);
  });

  it('reattaches an authenticated daemon to the same window after shell start', async () => {
    const identity = { pid: 42, startedAt: 'new', listen: '127.0.0.1:42345' };
    const next = { identity, dispose: vi.fn(async () => {}) };
    fake.ready.mockResolvedValueOnce(identity);
    fake.attach.mockResolvedValueOnce(next);
    await expect(actions.startHost('cli_exact_Bot_ID')).resolves.toEqual({ type: 'done', message: '所选 Bot 已启动。' });
    expect(fake.ready).toHaveBeenLastCalledWith(0, 'cli_exact_Bot_ID');
    expect(fake.attach).toHaveBeenCalledTimes(2);
    expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next);
    expect(window.destroyed).toBe(false);
  });

  it('does not bind a changed daemon identity and closes the rejected connection', async () => {
    const next = { identity: { pid: 43, startedAt: 'changed', listen: '127.0.0.1:42345' }, dispose: vi.fn(async () => {}) };
    fake.ready.mockResolvedValueOnce({ pid: 42, startedAt: 'expected', listen: '127.0.0.1:42345' });
    fake.attach.mockResolvedValueOnce(next);
    await expect(actions.startHost()).rejects.toThrow('没能启动并重新连上');
    expect(next.dispose).toHaveBeenCalledOnce();
    expect(fake.bridge.replaceOwner).not.toHaveBeenCalled();
  });

  it('rejects concurrent starts before another owner can launch', async () => {
    let release!: (value: VerifiedDaemon) => void;
    fake.ready.mockImplementationOnce(() => new Promise<VerifiedDaemon>(resolve => { release = resolve; }));
    const first = actions.startHost();
    await expect(actions.startHost('cli_exact_Bot_ID')).rejects.toThrow('等它结束再启动');
    const identity = { pid: 42, startedAt: 'new', listen: '127.0.0.1:42345' };
    fake.attach.mockResolvedValueOnce({ identity, dispose: vi.fn(async () => {}) });
    release(identity);
    await expect(first).resolves.toMatchObject({ type: 'done' });
    expect(fake.ready).toHaveBeenCalledTimes(2);
    expect(fake.bridge.replaceOwner).toHaveBeenCalledOnce();
  });

  it('loads only after attach and installs the bridge before the page', () => {
    expect(fake.attach).toHaveBeenCalledOnce();
    expect(fake.install).toHaveBeenCalledOnce();
    expect(fake.install.mock.invocationCallOrder[0]).toBeLessThan(window.show.mock.invocationCallOrder[0]);
    expect(window.visible).toBe(true);
    expect(desktopResources(appPath, false).preload).toBe(join(appPath, 'dist', 'preload.cjs'));
  });

  it('hides the window and Dock on close, then restores both on a second instance', async () => {
    const close = { preventDefault: vi.fn() };
    window.emit('close', close);
    expect(close.preventDefault).toHaveBeenCalledOnce();
    expect(window.visible).toBe(false);
    expect(fake.dock.visible).toBe(false);
    expect(fake.tray.destroy).not.toHaveBeenCalled();
    app.emit('second-instance', {}, []);
    await vi.waitFor(() => expect(window.visible).toBe(true));
    expect(fake.dock.show).toHaveBeenCalledOnce();
    expect(fake.dock.visible).toBe(true);
    expect(window.focus).toHaveBeenCalled();
    expect(fake.bridge.dispose).not.toHaveBeenCalled();
  });

  it('uses the same hide and restore paths for renderer hide, tray open and application activation', async () => {
    const trayShow = vi.mocked(createDesktopTray).mock.lastCall?.[1];
    for (const reopen of [trayShow, () => app.emit('activate')]) {
      actions.hide();
      expect(window.visible).toBe(false);
      expect(fake.dock.visible).toBe(false);
      reopen?.();
      await vi.waitFor(() => expect(window.visible).toBe(true));
      expect(fake.dock.visible).toBe(true);
    }
    expect(fake.bridge.dispose).not.toHaveBeenCalled();
    expect(fake.tray.destroy).not.toHaveBeenCalled();
  });

  it('lets a later close win over delayed Dock restoration without losing the tray', async () => {
    actions.hide();
    window.show.mockClear();
    let restored!: () => void;
    fake.dock.show.mockImplementationOnce(() => new Promise<void>(resolve => { restored = () => { fake.dock.visible = true; resolve(); }; }));
    app.emit('activate');
    window.emit('close', { preventDefault: vi.fn() });
    restored();
    await vi.waitFor(() => expect(fake.dock.visible).toBe(false));
    expect(window.show).not.toHaveBeenCalled();
    expect(window.visible).toBe(false);
    expect(fake.tray.destroy).not.toHaveBeenCalled();
  });

  it('coalesces pending Dock restoration and honors the newest reopen intent', async () => {
    actions.hide();
    window.show.mockClear();
    let restored!: () => void;
    fake.dock.show.mockImplementationOnce(() => new Promise<void>(resolve => { restored = () => { fake.dock.visible = true; resolve(); }; }));
    app.emit('activate');
    actions.hide();
    app.emit('second-instance', {}, []);
    expect(fake.dock.show).toHaveBeenCalledOnce();
    restored();
    await vi.waitFor(() => expect(window.visible).toBe(true));
    expect(fake.dock.visible).toBe(true);
    expect(window.show).toHaveBeenCalledOnce();
  });

  it.each(['quit', 'update cleanup'] as const)('does not revive the window or Dock when restoration completes after %s', async stop => {
    if (stop === 'update cleanup') await downloadUpdate();
    actions.hide();
    window.show.mockClear();
    let restored!: () => void;
    fake.dock.show.mockImplementationOnce(() => new Promise<void>(resolve => { restored = () => { fake.dock.visible = true; resolve(); }; }));
    app.emit('activate');
    await (stop === 'quit' ? actions.confirmQuit() : actions.installDesktopUpdate());
    restored();
    await vi.waitFor(() => expect(fake.dock.visible).toBe(false));
    expect(window.show).not.toHaveBeenCalled();
    expect(window.destroyed).toBe(true);
    expect(fake.tray.destroy).toHaveBeenCalledOnce();
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    expect(fake.owner.dispose).not.toHaveBeenCalled();
  });

  it('preserves window hide and restore on platforms without a Dock API', () => {
    app.dock = undefined;
    actions.hide();
    expect(window.visible).toBe(false);
    app.emit('activate');
    expect(window.visible).toBe(true);
    expect(fake.dock.hide).not.toHaveBeenCalled();
    expect(fake.dock.show).not.toHaveBeenCalled();
  });

  it('reissues an explicit quit after cancellation, then closes the desktop only after confirmation', async () => {
    const beforeQuit = () => ({ preventDefault: vi.fn() });
    const first = beforeQuit();
    app.emit('before-quit', first);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(fake.bridge.requestQuit).toHaveBeenCalledTimes(1);
    const again = beforeQuit();
    app.emit('before-quit', again);
    expect(fake.bridge.requestQuit).toHaveBeenCalledTimes(2);
    const actions = fake.install.mock.lastCall?.[3] as { confirmQuit: () => Promise<void> };
    await actions.confirmQuit();
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    expect(fake.owner.dispose).not.toHaveBeenCalled();
    expect(window.destroyed).toBe(true);
    expect(fake.tray.destroy).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('delegates links from the loaded document under an aliased app root and refuses lookalike documents', async () => {
    const handler = window.webContents.windowOpenHandler;
    const uiIndex = join(appPath, '..', 'ui', 'dist', 'index.html');
    const canonicalUrl = pathToFileURL(await realpath(uiIndex)).href;
    const aliasUrl = pathToFileURL(uiIndex).href;
    expect(aliasUrl).not.toBe(canonicalUrl);
    expect(window.webContents.mainFrame.url).toBe(canonicalUrl);
    expect(handler).toBeDefined();
    expect(handler?.({ url: 'https://github.com/modelzen/vonvon-bot/releases' })).toEqual({ action: 'deny' });
    expect(fake.openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/modelzen/vonvon-bot/releases');
    for (const lookalike of [aliasUrl, `${canonicalUrl}?other`, `${canonicalUrl}#other`, `${canonicalUrl}.other`, 'file:///other/index.html']) {
      window.webContents.mainFrame.url = lookalike;
      expect(handler?.({ url: 'https://github.com/modelzen/vonvon-bot/releases' })).toEqual({ action: 'deny' });
      expect(fake.openExternal).toHaveBeenCalledOnce();
    }
  });

  it('lets only the loaded document write the clipboard and denies every other permission', async () => {
    type Details = { isMainFrame: boolean; requestingUrl?: string };
    type Check = (contents: unknown, permission: string, origin: string, details: Details) => boolean;
    type Request = (contents: unknown, permission: string, callback: (granted: boolean) => void, details: Details) => void;
    const own = window.webContents as unknown as EventEmitter & { mainFrame: { url: string }; isDestroyed: () => boolean;
      session: { setPermissionCheckHandler: ReturnType<typeof vi.fn>; setPermissionRequestHandler: ReturnType<typeof vi.fn> } };
    const check = own.session.setPermissionCheckHandler.mock.lastCall?.[0] as Check;
    const request = own.session.setPermissionRequestHandler.mock.lastCall?.[0] as Request;
    const checked = (permission: string, contents: unknown = own, isMainFrame = true) =>
      check(contents, permission, 'file://', { isMainFrame, requestingUrl: own.mainFrame.url });
    const requested = (permission: string, contents: unknown = own, isMainFrame = true) => {
      const callback = vi.fn();
      request(contents, permission, callback, { isMainFrame, requestingUrl: own.mainFrame.url });
      expect(callback).toHaveBeenCalledOnce();
      return callback.mock.lastCall?.[0] as boolean;
    };
    const uiIndex = join(appPath, '..', 'ui', 'dist', 'index.html');
    const canonicalUrl = pathToFileURL(await realpath(uiIndex)).href;
    expect(own.mainFrame.url).toBe(canonicalUrl);
    expect(checked('clipboard-sanitized-write')).toBe(true);
    expect(requested('clipboard-sanitized-write')).toBe(true);
    for (const permission of ['clipboard-read', 'deprecated-sync-clipboard-read', 'media', 'notifications', 'openExternal', 'geolocation']) {
      expect(checked(permission)).toBe(false);
      expect(requested(permission)).toBe(false);
    }
    expect(checked('clipboard-sanitized-write', own, false)).toBe(false);
    expect(requested('clipboard-sanitized-write', own, false)).toBe(false);
    expect(checked('clipboard-sanitized-write', null)).toBe(false);
    expect(checked('clipboard-sanitized-write', new EventEmitter())).toBe(false);
    expect(requested('clipboard-sanitized-write', new EventEmitter())).toBe(false);
    for (const lookalike of [pathToFileURL(uiIndex).href, `${canonicalUrl}?other`, `${canonicalUrl}#other`, `${canonicalUrl}.other`, 'file:///other/index.html']) {
      own.mainFrame.url = lookalike;
      expect(checked('clipboard-sanitized-write')).toBe(false);
      expect(requested('clipboard-sanitized-write')).toBe(false);
    }
    own.mainFrame.url = canonicalUrl;
    own.isDestroyed = () => true;
    expect(checked('clipboard-sanitized-write')).toBe(false);
    expect(requested('clipboard-sanitized-write')).toBe(false);
  });

  it('destroys the window and closes the connection after a renderer crash', async () => {
    window.webContents.emit('render-process-gone');
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    expect(window.destroyed).toBe(true);
  });
});

describe('automatic update checks and a stalled install', () => {
  const record = () => join(temp, 'desktop-update-expected-version');
  const minute = 60_000, hour = 60 * minute;
  /** Close the outer beforeEach's desktop before starting an isolated scheduler under fake time. */
  async function startUnderFakeTime(at = '2026-11-02T09:00:00+08:00'): Promise<void> {
    await actions.confirmQuit();
    expect(powerMonitor.listenerCount('resume')).toBe(0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(at));
    vi.mocked(net.fetch).mockClear();
    fake.tray.setUpdate.mockClear();
    fake.bridge.publishUpdate.mockClear();
    await startDesktop();
    window = fake.window as MockWindow;
    actions = fake.install.mock.lastCall?.[3];
  }

  async function stopUnderFakeTime(): Promise<void> {
    await actions.confirmQuit();
    expect(powerMonitor.listenerCount('resume')).toBe(0);
    vi.useRealTimers();
  }

  it('checks two minutes after startup, then finds a later release without restarting or checking manually', async () => {
    try {
      await startUnderFakeTime();
      // The remote devices' wake (devices-ui-1a 4.8) and the update scheduler each listen once.
      expect(powerMonitor.listenerCount('resume')).toBe(2);
      vi.mocked(net.fetch).mockResolvedValueOnce(new Response(JSON.stringify({
        version: '0.1.0', feedURL: 'https://updates.example.test/feed',
      })));
      await vi.advanceTimersByTimeAsync(2 * minute - 1);
      expect(net.fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      // The check reads the install record from disk first, which fake timers do not wait for.
      await vi.waitFor(() => expect(fake.bridge.publishUpdate).toHaveBeenCalledOnce());
      expect(net.fetch).toHaveBeenCalledExactlyOnceWith('https://updates.example.test/manifest.json', expect.objectContaining({ redirect: 'error' }));
      expect(fake.bridge.publishUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'current' }));
      expect(fake.tray.setUpdate).toHaveBeenLastCalledWith(undefined);
      // The server now offers 0.2.0; no app restart or settings action occurs.
      await vi.advanceTimersByTimeAsync(90 * minute);
      await vi.waitFor(() => expect(fake.bridge.publishUpdate).toHaveBeenCalledTimes(2));
      expect(net.fetch).toHaveBeenCalledTimes(2);
      expect(fake.bridge.publishUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'available', latest: '0.2.0' }));
      expect(fake.tray.setUpdate).toHaveBeenLastCalledWith('有新版本 0.2.0');
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
      await actions.confirmQuit();
      expect(powerMonitor.listenerCount('resume')).toBe(0);
      powerMonitor.emit('resume');
      await vi.advanceTimersByTimeAsync(72 * hour);
      expect(net.fetch).toHaveBeenCalledTimes(2);
    } finally { await stopUnderFakeTime(); }
  });

  it('starts the initial delay only after the window has loaded', async () => {
    let loaded!: () => void;
    fake.loadPage.mockImplementationOnce(() => new Promise<void>(resolve => { loaded = resolve; }));
    try {
      const starting = startUnderFakeTime();
      await vi.waitFor(() => expect(loaded).toBeTypeOf('function'));
      // Only the remote devices' wake (devices-ui-1a 4.8) listens before the page has loaded.
      expect(powerMonitor.listenerCount('resume')).toBe(1);
      await vi.advanceTimersByTimeAsync(5 * minute);
      expect(net.fetch).not.toHaveBeenCalled();
      loaded();
      await starting;
      await vi.advanceTimersByTimeAsync(2 * minute - 1);
      expect(net.fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(fake.bridge.publishUpdate).toHaveBeenCalledOnce());
    } finally { loaded?.(); await stopUnderFakeTime(); }
  });

  it('skips the quiet hours, allows manual checks, and resumes the original cadence after 05:00', async () => {
    try {
      await startUnderFakeTime('2026-11-02T02:13:00+08:00');
      await vi.advanceTimersByTimeAsync(2 * minute);
      expect(net.fetch).not.toHaveBeenCalled();
      await expect(actions.checkDesktopUpdate()).resolves.toMatchObject({ state: 'available', latest: '0.2.0' });
      expect(net.fetch).toHaveBeenCalledOnce();
      expect(fake.tray.setUpdate).toHaveBeenLastCalledWith('有新版本 0.2.0');
      await vi.advanceTimersByTimeAsync(90 * minute);
      expect(net.fetch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(75 * minute);
      expect(net.fetch).toHaveBeenCalledOnce(); // 05:00 is not a shared restart time.
      await vi.advanceTimersByTimeAsync(15 * minute); // This instance's own next slot is 05:15.
      await vi.waitFor(() => expect(fake.bridge.publishUpdate).toHaveBeenCalledOnce());
      expect(net.fetch).toHaveBeenCalledTimes(2);
      expect(fake.bridge.publishUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'available', latest: '0.2.0' }));
    } finally { await stopUnderFakeTime(); }
  });

  it('catches up an overdue check on resume without duplicating the timer or an in-flight request', async () => {
    let answer!: (value: Response) => void;
    try {
      await startUnderFakeTime();
      vi.setSystemTime(new Date('2026-11-02T09:01:00+08:00'));
      powerMonitor.emit('resume');
      expect(net.fetch).not.toHaveBeenCalled();
      vi.mocked(net.fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { answer = resolve; }));
      vi.setSystemTime(new Date('2026-11-02T10:00:00+08:00'));
      powerMonitor.emit('resume');
      powerMonitor.emit('resume');
      await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledOnce());
      powerMonitor.emit('resume');
      expect(net.fetch).toHaveBeenCalledOnce();
      answer(new Response(JSON.stringify({ version: '0.2.0', feedURL: 'https://updates.example.test/feed' })));
      await vi.waitFor(() => expect(fake.bridge.publishUpdate).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(90 * minute);
      await vi.waitFor(() => expect(fake.bridge.publishUpdate).toHaveBeenCalledTimes(2));
      expect(net.fetch).toHaveBeenCalledTimes(2);
    } finally { await stopUnderFakeTime(); }
  });

  it('does not check on its own or subscribe to resume without a signed update source', async () => {
    try {
      fake.updateConfiguration.mockResolvedValueOnce({ signed: false } as never);
      await startUnderFakeTime();
      // The remote devices' wake (devices-ui-1a 4.8) is the only listener: no update scheduler.
      expect(powerMonitor.listenerCount('resume')).toBe(1);
      powerMonitor.emit('resume');
      await vi.advanceTimersByTimeAsync(72 * hour);
      expect(net.fetch).not.toHaveBeenCalled();
      expect(fake.bridge.publishUpdate).not.toHaveBeenCalled();
    } finally { await stopUnderFakeTime(); }
  });

  it('does not publish an in-flight automatic result or re-arm after quitting', async () => {
    let answer!: (value: Response) => void;
    try {
      await startUnderFakeTime();
      vi.mocked(net.fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { answer = resolve; }));
      await vi.advanceTimersByTimeAsync(2 * minute);
      await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledOnce());
      await actions.confirmQuit();
      expect(powerMonitor.listenerCount('resume')).toBe(0);
      answer(new Response(JSON.stringify({ version: '0.2.0', feedURL: 'https://updates.example.test/feed' })));
      await new Promise(resolve => setImmediate(resolve));
      powerMonitor.emit('resume');
      await vi.advanceTimersByTimeAsync(90 * minute);
      expect(fake.bridge.publishUpdate).not.toHaveBeenCalled();
      expect(fake.tray.setUpdate).not.toHaveBeenCalled();
      expect(net.fetch).toHaveBeenCalledOnce();
    } finally { await stopUnderFakeTime(); }
  });

  it('drops an expected-version record the running version already reached when it starts', async () => {
    try {
      await writeFile(record(), '0.1.0');
      await startUnderFakeTime();
      await expect(readFile(record(), 'utf8')).rejects.toThrow();
    } finally { await stopUnderFakeTime(); }
  });

  it('keeps asking for a retry, not refusing for good, while the expected version is still ahead', async () => {
    try {
      await writeFile(record(), '0.5.0');
      await startUnderFakeTime();
      expect(await readFile(record(), 'utf8')).toBe('0.5.0');
      // The manifest is read anyway, so a newer release would still show up; here it offers nothing past the expected version.
      await expect(actions.checkDesktopUpdate()).resolves.toMatchObject({ state: 'install-pending', latest: '0.5.0' });
      expect(net.fetch).toHaveBeenCalledOnce();
      expect(fake.tray.setUpdate).toHaveBeenLastCalledWith('上次更新没装上');
      await expect(actions.retryDesktopUpdate()).resolves.toMatchObject({ state: 'available', latest: '0.2.0' });
      expect(fake.tray.setUpdate).toHaveBeenLastCalledWith('有新版本 0.2.0');
      await expect(readFile(record(), 'utf8')).rejects.toThrow();
    } finally { await stopUnderFakeTime(); }
  });

  it('marks a failed install in the tray from the automatic check, and offers a newer release instead when there is one', async () => {
    try {
      await writeFile(record(), '0.5.0');
      await startUnderFakeTime();
      await vi.advanceTimersByTimeAsync(2 * minute);
      await vi.waitFor(() => expect(fake.bridge.publishUpdate).toHaveBeenCalledOnce());
      expect(fake.bridge.publishUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'install-pending' }));
      expect(fake.tray.setUpdate).toHaveBeenLastCalledWith('上次更新没装上');
      vi.mocked(net.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.6.0', feedURL: 'https://updates.example.test/feed' })));
      await vi.advanceTimersByTimeAsync(90 * minute);
      await vi.waitFor(() => expect(fake.bridge.publishUpdate).toHaveBeenCalledTimes(2));
      expect(fake.bridge.publishUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'available', latest: '0.6.0' }));
      expect(fake.tray.setUpdate).toHaveBeenLastCalledWith('有新版本 0.6.0');
    } finally { await stopUnderFakeTime(); }
  });
});

describe('remote devices (devices-ui-1a 4.8)', () => {
  const previous = { pid: 42, startedAt: 'initial', listen: '127.0.0.1:42345' };
  const devices = (): DeviceConnections => fake.install.mock.lastCall?.[4] as DeviceConnections;

  it("hands the bridge this computer's device list, wakes it on resume and closes it before the bridge on quit", async () => {
    expect(devices().state()).toMatchObject({
      registry: 'ok', secureStorage: true, client: { version: '0.1.0' },
      active: { id: 'local', phase: 'ready' }, devices: [{ id: 'local', current: true, status: 'online' }],
    });
    const wake = vi.spyOn(devices(), 'wake');
    powerMonitor.emit('resume');
    expect(wake).toHaveBeenCalledOnce();
    const order: string[] = [];
    const close = devices().dispose;
    vi.spyOn(devices(), 'dispose').mockImplementation(async () => { order.push('devices'); await close(); });
    fake.bridge.dispose.mockImplementationOnce(async () => { order.push('bridge'); });
    await actions.confirmQuit();
    expect(order).toEqual(['devices', 'bridge']);
    // Nothing reconnects after quit.
    powerMonitor.emit('resume');
    expect(wake).toHaveBeenCalledOnce();
    expect(powerMonitor.listenerCount('resume')).toBe(0);
  });

  it('leaves a lost local connection for the switch back while a remote device is shown, instead of a dialog', async () => {
    fake.bridge.deferLocalLost.mockReturnValue(true);
    fake.attach.mockRejectedValue(new AttachError('root'));
    expect(actions.recoverConnection(previous)).toBe(true);
    await vi.waitFor(() => expect(fake.bridge.deferLocalLost).toHaveBeenCalledOnce());
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
    expect(window.destroyed).toBe(false);
  });
});
