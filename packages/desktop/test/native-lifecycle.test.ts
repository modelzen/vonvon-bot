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
  bridge: { requestQuit: vi.fn(), replaceOwner: vi.fn(async () => {}), dispose: vi.fn(async () => {}) },
  owner: { dispose: vi.fn(async () => {}) },
  attach: vi.fn(),
  ready: vi.fn(async (): Promise<VerifiedDaemon> => ({ pid: 42, startedAt: 'initial', listen: '127.0.0.1:42345' })),
  install: vi.fn(),
  cliRegister: vi.fn(async () => ({ kind: 'ready' as const, bin: '/tmp/vonvon', message: 'installed' })),
  cliObserve: vi.fn(async () => ({ kind: 'error' as const, message: 'absent' })),
  readRegistration: vi.fn(async (): Promise<Registration> => ({ kind: 'absent' })),
  tray: { destroy: vi.fn() },
  openExternal: vi.fn(async () => {}),
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
    isDestroyed = () => this.destroyed;
    destroy = vi.fn(() => { this.destroyed = true; });
    loadFile = vi.fn(async (path: string) => {
      this.webContents.mainFrame.url = pathToFileURL(path).href;
      this.emit('ready-to-show');
    });
    constructor(readonly options: unknown) { super(); fake.window = this; }
  }
  class MockApp extends EventEmitter {
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
    BrowserWindow: MockWindow,
    dialog: { showErrorBox: vi.fn(), showMessageBoxSync: vi.fn() },
    Menu: { buildFromTemplate: vi.fn((items: unknown) => items), setApplicationMenu: vi.fn() },
  };
});

vi.mock('../src/attach.js', () => ({ attachExisting: fake.attach, AttachError: class AttachError extends Error {} }));
vi.mock('../src/bridge.js', () => ({ installBridge: fake.install, openAllowedExternal: fake.openExternal }));
vi.mock('../src/tray.js', () => ({ createDesktopTray: vi.fn(() => fake.tray) }));
vi.mock('../src/update-configuration.js', () => ({ desktopUpdateConfiguration: fake.updateConfiguration }));
vi.mock('../src/daemon-dependencies.js', () => ({
  prepareDesktopRoot: vi.fn(async () => fake.root),
  createDaemonDependencies: vi.fn(() => ({ readRegistration: fake.readRegistration })),
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

import { startDesktop, desktopResources } from '../src/main.js';
import { autoUpdater, dialog } from 'electron';

type MockApp = EventEmitter & { requestSingleInstanceLock: ReturnType<typeof vi.fn>; quit: ReturnType<typeof vi.fn>; getAppPath: ReturnType<typeof vi.fn> };
type MockWindow = EventEmitter & {
  visible: boolean;
  destroyed: boolean;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  webContents: EventEmitter & { mainFrame: { url: string }; windowOpenHandler?: (details: { url: string }) => { action: string } };
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
  vi.mocked(dialog.showErrorBox).mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    version: '0.2.0', feedURL: 'https://updates.example.test/feed',
  }))));
  const resources = join(await realpath(temp), 'resources');
  await mkdir(resources);
  const alias = join(temp, 'resources-alias');
  await symlink(resources, alias, process.platform === 'win32' ? 'junction' : 'dir');
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
  fake.bridge.requestQuit.mockClear();
  fake.bridge.dispose.mockClear().mockResolvedValue(undefined);
  fake.bridge.replaceOwner.mockClear().mockResolvedValue(undefined);
  fake.owner.dispose.mockClear();
  fake.tray.destroy.mockClear();
  fake.attach.mockReset().mockResolvedValue(fake.owner);
  fake.ready.mockClear();
  fake.cliRegister.mockClear();
  fake.cliObserve.mockClear();
  fake.readRegistration.mockClear().mockResolvedValue({ kind: 'absent' });
  fake.install.mockReset().mockReturnValue(fake.bridge);
  fake.openExternal.mockClear();
  await startDesktop();
  window = fake.window as MockWindow;
  actions = fake.install.mock.lastCall?.[3];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(temp, { recursive: true, force: true });
});

async function downloadUpdate(): Promise<void> {
  await expect(actions.checkDesktopUpdate()).resolves.toMatchObject({ state: 'available' });
  const downloading = actions.installDesktopUpdate();
  expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
  autoUpdater.emit('update-downloaded');
  await expect(downloading).resolves.toMatchObject({ state: 'downloaded' });
  expect(window.destroyed).toBe(false);
  expect(app.quit).not.toHaveBeenCalled();
}

describe('updater final install lifecycle', () => {
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
      expect.soft(dialog.showErrorBox).toHaveBeenCalledWith('Vonvon Bot', expect.stringMatching(/update.*failed/i));
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
    vi.mocked(fetch).mockRejectedValueOnce(new Error('check failed'));
    await expect(actions.checkDesktopUpdate()).rejects.toThrow('check failed');
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

describe('native window lifecycle', () => {
  it('refuses Open at login and service install, uninstall and stop in this version', async () => {
    fake.readRegistration.mockResolvedValue({ kind: 'ours' });
    await expect(actions.setLoginItem(true)).rejects.toThrow('cannot manage an OS service');
    await expect(actions.setLoginItem(false)).rejects.toThrow('cannot manage an OS service');
    for (const action of ['install', 'uninstall', 'stop'] as const) {
      await expect(actions.service(action)).rejects.toThrow('cannot manage an OS service');
    }
    expect(fake.ready).toHaveBeenCalledTimes(1);
    expect(fake.bridge.replaceOwner).not.toHaveBeenCalled();
    expect(actions.isExpectedDisconnect()).toBe(false);
  });

  it('starts a registered service through the manager and blocks a concurrent start', async () => {
    fake.readRegistration.mockResolvedValue({ kind: 'ours' });
    let release!: (value: VerifiedDaemon) => void;
    fake.ready.mockImplementationOnce(() => new Promise<VerifiedDaemon>(resolve => { release = resolve; }));
    const first = actions.service('start');
    await Promise.resolve();
    await expect(actions.startHost()).rejects.toThrow('startup is unavailable');
    const identity = { pid: 53, startedAt: 'managed', listen: '127.0.0.1:42345' };
    const next = { identity, dispose: vi.fn(async () => {}) };
    fake.attach.mockResolvedValueOnce(next);
    release(identity);
    await expect(first).resolves.toEqual({ type: 'done', message: 'Background service started.' });
    expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next);
  });

  it('reattaches an authenticated daemon to the same window after shell start', async () => {
    const identity = { pid: 42, startedAt: 'new', listen: '127.0.0.1:42345' };
    const next = { identity, dispose: vi.fn(async () => {}) };
    fake.ready.mockResolvedValueOnce(identity);
    fake.attach.mockResolvedValueOnce(next);
    await expect(actions.startHost('cli_exact_Bot_ID')).resolves.toEqual({ type: 'done', message: 'Selected Bot started.' });
    expect(fake.ready).toHaveBeenLastCalledWith(0, 'cli_exact_Bot_ID');
    expect(fake.attach).toHaveBeenCalledTimes(2);
    expect(fake.bridge.replaceOwner).toHaveBeenCalledExactlyOnceWith(next);
    expect(window.destroyed).toBe(false);
  });

  it('does not bind a changed daemon identity and closes the rejected connection', async () => {
    const next = { identity: { pid: 43, startedAt: 'changed', listen: '127.0.0.1:42345' }, dispose: vi.fn(async () => {}) };
    fake.ready.mockResolvedValueOnce({ pid: 42, startedAt: 'expected', listen: '127.0.0.1:42345' });
    fake.attach.mockResolvedValueOnce(next);
    await expect(actions.startHost()).rejects.toThrow('could not start and reconnect');
    expect(next.dispose).toHaveBeenCalledOnce();
    expect(fake.bridge.replaceOwner).not.toHaveBeenCalled();
  });

  it('rejects concurrent starts before another owner can launch', async () => {
    let release!: (value: VerifiedDaemon) => void;
    fake.ready.mockImplementationOnce(() => new Promise<VerifiedDaemon>(resolve => { release = resolve; }));
    const first = actions.startHost();
    await expect(actions.startHost('cli_exact_Bot_ID')).rejects.toThrow('startup is unavailable');
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

  it('hides on close and reopens on second instance while preserving the owner', () => {
    const close = { preventDefault: vi.fn() };
    window.emit('close', close);
    expect(close.preventDefault).toHaveBeenCalledOnce();
    expect(window.visible).toBe(false);
    app.emit('second-instance');
    expect(window.visible).toBe(true);
    expect(window.focus).toHaveBeenCalled();
    expect(fake.bridge.dispose).not.toHaveBeenCalled();
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

  it('destroys the window and closes the connection after a renderer crash', async () => {
    window.webContents.emit('render-process-gone');
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    expect(window.destroyed).toBe(true);
  });
});
