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
  verified: vi.fn(async (): Promise<VerifiedDaemon | null> => null),
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
    net: { fetch: vi.fn() },
  };
});

vi.mock('../src/attach.js', () => ({ attachExisting: fake.attach, AttachError: class AttachError extends Error {} }));
vi.mock('../src/bridge.js', () => ({ installBridge: fake.install, openAllowedExternal: fake.openExternal }));
vi.mock('../src/tray.js', () => ({ createDesktopTray: vi.fn(() => fake.tray) }));
vi.mock('../src/update-configuration.js', () => ({ desktopUpdateConfiguration: fake.updateConfiguration }));
vi.mock('../src/daemon-dependencies.js', () => ({
  prepareDesktopRoot: vi.fn(async () => fake.root),
  createDaemonDependencies: vi.fn(() => ({ readRegistration: fake.readRegistration, readVerifiedDaemon: fake.verified })),
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
import { autoUpdater, dialog, net } from 'electron';

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
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the update check must use Electron net'); }));
  vi.mocked(net.fetch).mockReset().mockImplementation(async () => new Response(JSON.stringify({
    version: '0.2.0', feedURL: 'https://updates.example.test/feed',
  })));
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
  fake.verified.mockReset().mockResolvedValue(null);
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
  expect(net.fetch).toHaveBeenLastCalledWith('https://updates.example.test/manifest.json', expect.objectContaining({ redirect: 'error' }));
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
    vi.mocked(net.fetch).mockRejectedValueOnce(new Error('check failed'));
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
      const settled = expect(actions.restartHost(previous, applied)).rejects.toThrow('did not come back after restart');
      await vi.advanceTimersByTimeAsync(61_000);
      await settled;
    } finally { vi.useRealTimers(); }
    expect(fake.bridge.replaceOwner).not.toHaveBeenCalled();
    expect(actions.isExpectedDisconnect()).toBe(true);
    expect(window.destroyed).toBe(false);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('lets a quit cancel a restart whose reply is still pending, and ignores the late reply', async () => {
    let reply!: (result: { kind: 'applied'; revision: number }) => void;
    const restarting = actions.restartHost(previous, () => new Promise(resolve => { reply = resolve; }));
    const cancelled = expect(restarting).rejects.toThrow('Desktop restart was cancelled.');
    await actions.confirmQuit();
    await cancelled;
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    reply({ kind: 'applied', revision: 7 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fake.verified).not.toHaveBeenCalled();
    expect(fake.attach).toHaveBeenCalledTimes(1);
  });

  for (const answer of ['old owner', 'successor'] as const) {
    it(`lets a quit win while the owner read is pending and then returns the ${answer}`, async () => {
      const successor = { pid: 45, startedAt: 'after-quit', listen: '127.0.0.1:42345' };
      let release!: () => void;
      fake.verified.mockImplementation(() => new Promise<VerifiedDaemon>(resolve => { release = () => resolve(answer === 'successor' ? successor : previous); }));
      fake.attach.mockResolvedValue({ identity: successor, dispose: vi.fn(async () => {}) });
      const restarting = actions.restartHost(previous, applied);
      await vi.waitFor(() => expect(fake.verified).toHaveBeenCalled());
      const quitting = actions.confirmQuit();
      release();
      await expect(restarting).rejects.toThrow('Desktop restart was cancelled.');
      await quitting;
      expect(fake.attach).toHaveBeenCalledTimes(1);
      expect(fake.bridge.replaceOwner).not.toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalledOnce();
    });
  }

  for (const stop of ['quit', 'update cleanup'] as const) {
    it(`lets ${stop} cancel a restart while the successor replacement is pending`, async () => {
      const successor = { pid: 47, startedAt: 'replacing', listen: '127.0.0.1:42345' };
      if (stop === 'update cleanup') await downloadUpdate();
      fake.verified.mockResolvedValue(successor);
      fake.attach.mockResolvedValue({ identity: successor, dispose: vi.fn(async () => {}) });
      fake.bridge.replaceOwner.mockImplementationOnce(() => new Promise<void>(() => {}));
      const restarting = actions.restartHost(previous, applied);
      const cancelled = expect(restarting).rejects.toThrow('Desktop restart was cancelled.');
      await vi.waitFor(() => expect(fake.bridge.replaceOwner).toHaveBeenCalled());
      await (stop === 'quit' ? actions.confirmQuit() : actions.installDesktopUpdate());
      await cancelled;
      expect(fake.bridge.dispose).toHaveBeenCalledOnce();
      if (stop === 'quit') expect(app.quit).toHaveBeenCalledOnce();
      else expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
    });
  }

  it.each([false, true])('handles a successor arriving after quit when close rejects=%s', async closeRejects => {
    const successor = { pid: 48, startedAt: 'late', listen: '127.0.0.1:42345' };
    const late = { identity: successor, dispose: vi.fn(async () => {
      if (closeRejects) throw new Error('Daemon WebSocket close timed out; physical closure was not observed');
    }) };
    let deliver!: () => void;
    fake.verified.mockResolvedValue(successor);
    fake.attach.mockImplementationOnce(() => new Promise(resolve => { deliver = () => resolve(late); }));
    const restarting = actions.restartHost(previous, applied);
    const cancelled = expect(restarting).rejects.toThrow('Desktop restart was cancelled.');
    await vi.waitFor(() => expect(fake.attach).toHaveBeenCalledTimes(2));
    await actions.confirmQuit();
    await cancelled;
    deliver();
    await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledOnce());
    expect(fake.bridge.replaceOwner).not.toHaveBeenCalled();
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
    await expect(restarting).rejects.toThrow('Desktop restart was cancelled.');
    await installing;
    expect(fake.attach).toHaveBeenCalledTimes(1);
    expect(fake.bridge.replaceOwner).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
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
