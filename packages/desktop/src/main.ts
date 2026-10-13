import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, autoUpdater, BrowserWindow, dialog, Menu, net, type Tray } from 'electron';
import { resolveDataRoot } from '../../daemon/src/config/data-root.js';
import { attachExisting, AttachError } from './attach.js';
import { installBridge, openAllowedExternal } from './bridge.js';
import type { AttachedDaemon, DesktopBridge, DesktopResources } from './ipc-contract.js';
import { createDesktopTray } from './tray.js';
import { DesktopUpdater } from './updates.js';
import { desktopUpdateConfiguration } from './update-configuration.js';
import { createDaemonManager, StartHostRefusal } from './daemon-manager.js';
import { createDaemonDependencies, prepareDesktopRoot } from './daemon-dependencies.js';
import { desktopCliOptions, observeCli, registerCli } from './cli-registration.js';
import type { MachineReply } from '@vonvon/protocol';

const serviceUnavailable = 'Vonvon Bot cannot manage an OS service in this version. Use vonvon daemon start and vonvon daemon stop.';

export function desktopResources(appPath: string, packaged: boolean): DesktopResources {
  return packaged ? {
    uiIndex: join(appPath, 'ui', 'index.html'),
    preload: join(appPath, 'desktop', 'preload.cjs'),
    trayPng: join(appPath, 'assets', 'tray.png'),
  } : {
    uiIndex: join(appPath, '..', 'ui', 'dist', 'index.html'),
    preload: join(appPath, 'dist', 'preload.cjs'),
    trayPng: join(appPath, 'assets', 'tray.png'),
  };
}

function startupMessage(error: unknown): string {
  if (error instanceof AttachError) return `${error.message} Start the daemon and reopen Vonvon Bot.`;
  if (error instanceof Error) return error.message;
  return 'Vonvon Bot could not open its desktop window. Check the daemon and reopen the app.';
}

export async function startDesktop(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  let window: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let owner: AttachedDaemon | null = null;
  let bridge: DesktopBridge | null = null;
  let quitting = false;
  let terminating = false;
  let focusWhenReady = false;
  let quitWhenReady = false;
  let cleanupPromise: Promise<void> | undefined;
  let confirmation: Promise<void> | undefined;
  let connectionFailureShown = false;
  let controlledDisconnect = false;
  let starting: Promise<MachineReply> | undefined;

  const show = (): void => {
    if (!window || window.isDestroyed()) {
      focusWhenReady = true;
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  const requestQuit = (): void => {
    if (quitting || terminating) return;
    if (!bridge) {
      quitWhenReady = true;
      return;
    }
    show();
    bridge.requestQuit();
  };

  const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
    let closeFailure: unknown;
    try {
      if (starting) await starting.catch(() => {});
      if (bridge) await bridge.dispose();
      else if (owner) await owner.dispose();
    } catch (error) {
      closeFailure = error;
    } finally {
      bridge = null;
      owner = null;
      tray?.destroy();
      tray = null;
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    }
    if (closeFailure) throw closeFailure;
  })();

  const fatal = (message: string): void => {
    if (terminating) return;
    terminating = true;
    void cleanup().catch(() => {
      dialog.showErrorBox('Vonvon Bot', 'The desktop connection did not close cleanly.');
    }).finally(() => {
      dialog.showErrorBox('Vonvon Bot', message);
      quitting = true;
      app.quit();
    });
  };

  const confirmQuit = (): Promise<void> => confirmation ??= (async () => {
    if (terminating) return;
    terminating = true;
    try { await cleanup(); }
    catch (error) {
      dialog.showErrorBox('Vonvon Bot', 'The desktop connection did not close cleanly.');
      throw error;
    } finally {
      quitting = true;
      app.quit();
    }
  })();

  app.on('second-instance', show);
  app.on('activate', show);
  app.on('before-quit', event => {
    if (!quitting) {
      event.preventDefault();
      requestQuit();
    }
  });

  try {
    await app.whenReady();
    if (terminating) return;
    const paths = desktopResources(app.getAppPath(), app.isPackaged);
    const uiIndex = realpathSync(paths.uiIndex);
    const uiUrl = pathToFileURL(uiIndex).href;
    const preload = realpathSync(paths.preload);
    const icon = realpathSync(paths.trayPng);
    const root = await prepareDesktopRoot(resolveDataRoot(homedir()));
    const updateConfiguration = await desktopUpdateConfiguration({ appPath: app.getAppPath(), isPackaged: app.isPackaged });
    const updater = new DesktopUpdater({
      current: app.getVersion(), ...updateConfiguration, driver: autoUpdater,
      // Chromium's stack follows the system proxy and the macOS keychain's certificate trust.
      fetch: (url, init) => net.fetch(url, init),
      statePath: join(app.getPath('userData'), 'desktop-update-expected-version'),
      beforeInstall: async () => {
        await cleanup();
        terminating = true;
        quitting = true;
      },
    });
    const managerDependencies = createDaemonDependencies({
      root, home: homedir(), executable: process.execPath,
      resources: process.resourcesPath, packaged: app.isPackaged,
    });
    const manager = createDaemonManager(managerDependencies);
    const cliOptions = desktopCliOptions({ platform: process.platform, executable: process.execPath,
      resources: process.resourcesPath, packaged: app.isPackaged });
    if (app.isPackaged && !process.env.VONVON_DESKTOP_TEST_HOME) await registerCli(cliOptions);
    await manager.ensureReady(0);
    owner = await attachExisting(root);
    if (terminating) {
      await owner.dispose();
      owner = null;
      return;
    }

    window = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 780,
      minHeight: 560,
      show: false,
      webPreferences: {
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    const current = window;
    const authorizedDocument = (): boolean => !current.webContents.isDestroyed() &&
      current.webContents.mainFrame?.url === uiUrl;
    current.webContents.setWindowOpenHandler(({ url }) => {
      if (authorizedDocument()) void openAllowedExternal(url).catch(() => {
        dialog.showMessageBoxSync(current, {
          type: 'warning', title: 'Vonvon Bot', message: 'This external link cannot be opened.', buttons: ['OK'],
        });
      });
      return { action: 'deny' };
    });
    current.webContents.on('will-navigate', event => event.preventDefault());
    current.webContents.on('will-frame-navigate', event => event.preventDefault());
    current.webContents.on('will-redirect', event => event.preventDefault());
    current.webContents.on('will-attach-webview', event => event.preventDefault());
    current.webContents.on('render-process-gone', () => fatal('The desktop window stopped unexpectedly. Reopen Vonvon Bot.'));
    current.webContents.on('did-fail-load', (_event, code, _description, _validatedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) fatal('The desktop page could not load. Reopen Vonvon Bot.');
    });
    current.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    current.webContents.session.setPermissionCheckHandler(() => false);
    current.on('close', event => {
      if (!quitting && !terminating) {
        event.preventDefault();
        current.hide();
      }
    });
    current.once('ready-to-show', () => {
      if (!terminating) show();
    });
    async function reattachReady(bot?: string): Promise<void> {
      const ready = await manager.ensureReady(0, bot);
      const next = await attachExisting(root);
      if (next.identity.pid !== ready.pid || next.identity.startedAt !== ready.startedAt || next.identity.listen !== ready.listen) {
        await next.dispose();
        throw new Error('The daemon owner changed during desktop restart.');
      }
      if (terminating || !bridge) {
        await next.dispose();
        throw new Error('Desktop startup is unavailable.');
      }
      await bridge.replaceOwner(next);
      connectionFailureShown = false;
      controlledDisconnect = false;
    }

    async function guardedService(operation: () => Promise<MachineReply>): Promise<MachineReply> {
      if (starting || terminating || cleanupPromise) throw new StartHostRefusal('Desktop service operation is unavailable.');
      starting = operation().finally(() => { starting = undefined; });
      return starting;
    }

    bridge = installBridge(owner, current, paths, {
      observeCli: () => observeCli(cliOptions),
      repairCli: async () => {
        const result = await registerCli(cliOptions);
        if (result.kind === 'error') throw new StartHostRefusal(result.message);
        return { type: 'done', message: result.message };
      },
      startHost: async bot => {
        if (starting || terminating || cleanupPromise) throw new StartHostRefusal('Desktop startup is unavailable.');
        starting = (async (): Promise<MachineReply> => {
          try {
            await reattachReady(bot);
            return { type: 'done', message: bot === undefined ? 'Daemon started.' : 'Selected Bot started.' };
          } catch (error) {
            if (error instanceof StartHostRefusal) throw error;
            throw new StartHostRefusal('The daemon could not start and reconnect. Check daemon.log and try again.');
          }
        })().finally(() => { starting = undefined; });
        return starting;
      },
      readLoginItem: async () => (await managerDependencies.readRegistration()).kind === 'ours',
      isExpectedDisconnect: () => controlledDisconnect,
      setLoginItem: async () => { throw new StartHostRefusal(serviceUnavailable); },
      service: action => guardedService(async () => {
        if (action !== 'start') throw new StartHostRefusal(serviceUnavailable);
        if ((await managerDependencies.readRegistration()).kind !== 'ours') throw new StartHostRefusal('Install the background service first.');
        await reattachReady();
        return { type: 'done', message: 'Background service started.' };
      }),
      chooseExecutablePath: async () => {
        const result = await dialog.showOpenDialog(current, {
          title: 'Choose Codex executable',
          properties: ['openFile'],
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
      },
      checkDesktopUpdate: () => updater.check(),
      installDesktopUpdate: async () => {
        try { return await updater.install(); }
        catch (error) {
          if (cleanupPromise) {
            terminating = true;
            dialog.showErrorBox('Vonvon Bot', 'The desktop update failed. Reopen Vonvon Bot to try again.');
            quitting = true;
            app.quit();
          }
          throw error;
        }
      },
      hide: () => current.hide(),
      confirmQuit,
      connectionLost: () => {
        if (connectionFailureShown || terminating) return;
        connectionFailureShown = true;
        dialog.showMessageBoxSync(current, {
          type: 'error',
          title: 'Vonvon Bot connection lost',
          message: 'The daemon connection was lost. Check the daemon, then start it again in Vonvon Bot.',
          buttons: ['OK'],
        });
      },
    });
    tray = createDesktopTray(icon, show, requestQuit);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Vonvon Bot', submenu: [
        { label: 'Show Vonvon Bot', click: show },
        { label: 'Quit Vonvon Bot', click: requestQuit },
      ] },
    ]));
    await current.loadFile(uiIndex);
    if (focusWhenReady) show();
    if (quitWhenReady) requestQuit();
  } catch (error) {
    fatal(startupMessage(error));
  }
}

void startDesktop();
