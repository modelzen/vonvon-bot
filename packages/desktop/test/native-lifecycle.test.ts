import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  app: undefined as unknown,
  window: undefined as unknown,
  bridge: { requestQuit: vi.fn(), dispose: vi.fn(async () => {}) },
  owner: { dispose: vi.fn(async () => {}) },
  attach: vi.fn(),
  install: vi.fn(),
  tray: { destroy: vi.fn() },
  openExternal: vi.fn(async () => {}),
  root: '/tmp/vonvon-native-test-root',
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
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
      this.webContents.mainFrame.url = new URL(`file://${path}`).href;
      this.emit('ready-to-show');
    });
    constructor(readonly options: unknown) { super(); fake.window = this; }
  }
  class MockApp extends EventEmitter {
    requestSingleInstanceLock = vi.fn(() => false);
    quit = vi.fn();
    whenReady = vi.fn(async () => {});
    getAppPath = vi.fn(() => fake.root);
    isPackaged = false;
  }
  const app = new MockApp();
  fake.app = app;
  return {
    app,
    BrowserWindow: MockWindow,
    dialog: { showErrorBox: vi.fn(), showMessageBoxSync: vi.fn() },
    Menu: { buildFromTemplate: vi.fn((items: unknown) => items), setApplicationMenu: vi.fn() },
  };
});

vi.mock('../src/attach.js', () => ({ attachExisting: fake.attach, AttachError: class AttachError extends Error {} }));
vi.mock('../src/bridge.js', () => ({ installBridge: fake.install, openAllowedExternal: fake.openExternal }));
vi.mock('../src/tray.js', () => ({ createDesktopTray: vi.fn(() => fake.tray) }));
vi.mock('../../daemon/src/config/data-root.js', () => ({ resolveDataRoot: vi.fn(() => ({ kind: 'canonical', path: fake.root })) }));

import { startDesktop, desktopResources } from '../src/main.js';

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

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'vonvon-native-'));
  appPath = join(temp, 'desktop');
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
  fake.owner.dispose.mockClear();
  fake.tray.destroy.mockClear();
  fake.attach.mockReset().mockResolvedValue(fake.owner);
  fake.install.mockReset().mockReturnValue(fake.bridge);
  fake.openExternal.mockClear();
  await startDesktop();
  window = fake.window as MockWindow;
});

afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

describe('native window lifecycle', () => {
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

  it('denies every popup and delegates only from the exact main document', async () => {
    const handler = window.webContents.windowOpenHandler;
    expect(handler).toBeDefined();
    expect(handler?.({ url: 'https://github.com/modelzen/vonvon-bot/releases' })).toEqual({ action: 'deny' });
    expect(fake.openExternal).toHaveBeenCalledOnce();
    window.webContents.mainFrame.url = 'file:///other/index.html';
    handler?.({ url: 'https://github.com/modelzen/vonvon-bot/releases' });
    expect(fake.openExternal).toHaveBeenCalledOnce();
  });

  it('destroys the window and closes the connection after a renderer crash', async () => {
    window.webContents.emit('render-process-gone');
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(fake.bridge.dispose).toHaveBeenCalledOnce();
    expect(window.destroyed).toBe(true);
  });
});
