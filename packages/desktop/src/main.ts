import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, autoUpdater, BrowserWindow, dialog, Menu, net, type Tray, type WebContents } from 'electron';
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
import { liveServiceActionRecord } from '../../daemon/src/service/action-report.js';
import { changeLoginItem, followServiceHelper, repairServiceAtStartup, type LoginItemHooks, type ServiceRuntime } from './login-item.js';
import type { CommandResult, MachineReply } from '@vonvon/protocol';
import { ConnectionError, RpcError } from '@vonvon/client/browser';

const restartDeadlineMs = 60_000;
const stopDeadlineMs = 60_000;
/** A manual start cancels passive reconnection without a connection-lost dialog. */
const startTakesOver = 'start-takes-over';

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
  const testHome = process.env.VONVON_DESKTOP_TEST_HOME;
  if (testHome) {
    // The existing test entry point must isolate Electron's lock/cache/update state too.
    if (!isAbsolute(testHome) || !process.env.VONVON_HOME || !isAbsolute(process.env.VONVON_HOME)) {
      throw new Error('Desktop testing requires absolute test home and VONVON_HOME');
    }
    const userData = join(testHome, 'userData');
    mkdirSync(userData, { recursive: true, mode: 0o700 });
    app.setPath('appData', testHome);
    app.setPath('userData', userData);
    app.setAppLogsPath(join(testHome, 'logs'));
  }
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
  let starting: Promise<unknown> | undefined;
  let restartCancel: AbortController | undefined;
  let passive: { cancel: AbortController; done: Promise<void> } | undefined;
  let stopping: Promise<MachineReply> | undefined;
  let wantsVisible = true;
  let visibilityRevision = 0;
  let restoringDock: Promise<void> | undefined;

  const show = (): void => {
    if (quitting || terminating || cleanupPromise) return;
    wantsVisible = true;
    const revision = ++visibilityRevision;
    if (!window || window.isDestroyed()) {
      focusWhenReady = true;
      return;
    }
    const current = window;
    const reveal = (): void => {
      // Dock restoration is asynchronous. A later close or quit must win, including
      // hiding a Dock icon that a completed show() has just brought back.
      if (!wantsVisible || quitting || terminating || cleanupPromise) {
        app.dock?.hide();
        return;
      }
      if (revision !== visibilityRevision || current !== window || current.isDestroyed()) return;
      focusWhenReady = false;
      if (current.isMinimized()) current.restore();
      current.show();
      current.focus();
    };
    if (app.dock && !app.dock.isVisible()) {
      restoringDock ??= app.dock.show().finally(() => { restoringDock = undefined; });
      // Still offer the window if macOS refuses Dock restoration.
      void restoringDock.then(reveal, reveal);
    } else reveal();
  };

  const hide = (): void => {
    wantsVisible = false;
    focusWhenReady = false;
    visibilityRevision += 1;
    if (window && !window.isDestroyed()) window.hide();
    app.dock?.hide();
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
    hide();
    let closeFailure: unknown;
    restartCancel?.abort();
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
    // Use the same padded, transparent icon as the bundle, including in dev mode.
    if (process.platform === 'darwin') app.dock?.setIcon(join(dirname(paths.trayPng), 'macos-icon.png'));
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
    const serviceRuntime: ServiceRuntime = {
      platform: process.platform, packaged: app.isPackaged, root, home: homedir(),
      executable: process.execPath, resources: process.resourcesPath,
    };
    const managerDependencies = createDaemonDependencies(serviceRuntime);
    const manager = createDaemonManager(managerDependencies);
    const cliOptions = desktopCliOptions({ platform: process.platform, executable: process.execPath,
      resources: process.resourcesPath, packaged: app.isPackaged });
    if (app.isPackaged && !process.env.VONVON_DESKTOP_TEST_HOME) await registerCli(cliOptions);
    // A moved or updated app points its service at itself first. If the desktop then cannot attach, that is the cause.
    const repairNotice = await repairServiceAtStartup(serviceRuntime, managerDependencies);
    try { await manager.ensureReady(0); }
    catch (error) { throw repairNotice ? new Error(repairNotice) : error; }
    owner = await attachExisting(root);
    if (terminating) {
      await owner.dispose();
      owner = null;
      return;
    }

    window = new BrowserWindow({
      width: 1000,
      height: 800,
      minWidth: 760,
      minHeight: 640,
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
    // 复制链接 needs clipboard-sanitized-write: Chromium checks it after a click and requests it otherwise.
    // Only the bundled page's main frame gets it; every other permission, clipboard-read included, stays denied.
    const ownClipboardWrite = (contents: WebContents | null, permission: string, isMainFrame: boolean): boolean =>
      permission === 'clipboard-sanitized-write' && contents === current.webContents && isMainFrame && authorizedDocument();
    current.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(ownClipboardWrite(contents, permission, details.isMainFrame)));
    current.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
      ownClipboardWrite(contents, permission, details.isMainFrame));
    current.on('close', event => {
      if (!quitting && !terminating) {
        event.preventDefault();
        hide();
      }
    });
    current.once('ready-to-show', () => {
      if (!terminating && wantsVisible) show();
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

    async function restartHost(previous: AttachedDaemon['identity'], send: () => Promise<CommandResult>): Promise<CommandResult> {
      if (starting || terminating || cleanupPromise) throw new StartHostRefusal('Desktop restart is unavailable.');
      const cancel = new AbortController();
      const cancelled = (): boolean => cancel.signal.aborted || terminating || cleanupPromise !== undefined || !bridge;
      const refusal = (): StartHostRefusal => new StartHostRefusal('Desktop restart was cancelled.');
      const unlessCancelled = <T>(pending: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
        const stop = (): void => reject(refusal());
        if (cancel.signal.aborted) { stop(); return; }
        cancel.signal.addEventListener('abort', stop, { once: true });
        pending.then(resolve, reject).finally(() => cancel.signal.removeEventListener('abort', stop));
      });
      const restart = (async (): Promise<CommandResult> => {
        controlledDisconnect = true;
        let result: CommandResult;
        try { result = await unlessCancelled(send()); }
        catch (error) { if (!cancelled()) controlledDisconnect = false; throw error; }
        if (result.kind !== 'applied') { controlledDisconnect = false; return result; }
        let ownerlessSince: number | undefined;
        for (;;) {
          if (cancelled()) throw refusal();
          const ready = await unlessCancelled(managerDependencies.readVerifiedDaemon().catch(() => null));
          if (cancelled()) throw refusal();
          if (ready && (ready.pid !== previous.pid || ready.startedAt !== previous.startedAt)) {
            const attaching = attachExisting(root);
            let next: AttachedDaemon;
            try { next = await unlessCancelled(attaching); }
            catch (error) {
              if (cancelled()) void attaching.then(late => late.dispose()).catch(() => {});
              throw error;
            }
            if (cancelled() || !bridge) { await next.dispose(); throw refusal(); }
            if (next.identity.pid !== ready.pid || next.identity.startedAt !== ready.startedAt) {
              await next.dispose();
              throw new StartHostRefusal('The daemon owner changed during desktop restart.');
            }
            await unlessCancelled(bridge.replaceOwner(next));
            connectionFailureShown = false;
            controlledDisconnect = false;
            return result;
          }
          ownerlessSince = ready ? undefined : ownerlessSince ?? Date.now();
          if (ownerlessSince !== undefined && Date.now() - ownerlessSince >= restartDeadlineMs) throw new StartHostRefusal('The daemon did not come back after restart. Check daemon.log, then start it from Vonvon Bot.');
          await unlessCancelled(new Promise(resolve => setTimeout(resolve, 250)));
        }
      })().finally(() => {
        starting = undefined;
        if (restartCancel === cancel) restartCancel = undefined;
      });
      restartCancel = cancel;
      starting = restart;
      return restart;
    }

    async function stopHost(previous: AttachedDaemon['identity'], send: () => Promise<MachineReply>): Promise<MachineReply> {
      if (starting || terminating || cleanupPromise) throw new StartHostRefusal('正在启动、重启或重新连接 daemon，等它结束再停止。');
      const cancel = new AbortController();
      const cancelled = (): boolean => cancel.signal.aborted || terminating || cleanupPromise !== undefined || !bridge;
      const refusal = (): StartHostRefusal => new StartHostRefusal('停止已取消。');
      const unlessCancelled = <T>(pending: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
        const stop = (): void => reject(refusal());
        if (cancel.signal.aborted) { stop(); return; }
        cancel.signal.addEventListener('abort', stop, { once: true });
        pending.then(resolve, reject).finally(() => cancel.signal.removeEventListener('abort', stop));
      });
      const run = (async (): Promise<MachineReply> => {
        controlledDisconnect = true;
        try { await unlessCancelled(send()); }
        catch (error) {
          if (cancelled()) throw error;
          if (error instanceof RpcError) { controlledDisconnect = false; throw error; }
          // The connection can close before the reply; still wait for the daemon to exit.
        }
        const deadline = Date.now() + stopDeadlineMs;
        for (;;) {
          if (cancelled()) throw refusal();
          const running = await unlessCancelled(managerDependencies.ownerRunning(previous).catch(() => true));
          if (!running) return { type: 'done', message: 'daemon 已停止。' };
          if (Date.now() >= deadline) {
            controlledDisconnect = false;
            throw new StartHostRefusal('daemon 1 分钟内没停完，详情在 daemon.log。稍后点"刷新状态"再看。');
          }
          await unlessCancelled(new Promise(resolve => setTimeout(resolve, 250)));
        }
      })().finally(() => {
        starting = undefined;
        stopping = undefined;
        if (restartCancel === cancel) restartCancel = undefined;
      });
      restartCancel = cancel;
      starting = run;
      stopping = run;
      return run;
    }

    /** Manual starts wait for passive reconnection to yield or an in-progress stop to finish. */
    function startBlocker(refusal: string): Promise<unknown> | undefined {
      if (terminating || cleanupPromise) throw new StartHostRefusal(refusal);
      if (!starting) return undefined;
      if (passive && starting === passive.done) { passive.cancel.abort(startTakesOver); return passive.done; }
      if (stopping && starting === stopping) return stopping.catch(() => {});
      throw new StartHostRefusal(refusal);
    }

    async function guardedService<T>(operation: () => Promise<T>): Promise<T> {
      if (starting || terminating || cleanupPromise) throw new StartHostRefusal('Desktop service operation is unavailable.');
      const run = operation().finally(() => { starting = undefined; });
      starting = run;
      return run;
    }

    const loginItemHooks: LoginItemHooks = {
      readVerifiedDaemon: () => managerDependencies.readVerifiedDaemon(),
      reattach: () => reattachReady(),
      expectDisconnect: expected => { controlledDisconnect = expected; },
      cancelled: () => terminating || cleanupPromise !== undefined || !bridge,
    };

    /** The bundled helper changes the service; the window expects the daemon to go and reattaches to its successor. */
    function setLoginItem(enabled: boolean, previous?: AttachedDaemon['identity'] | null): Promise<void> {
      return guardedService(() => changeLoginItem(serviceRuntime, enabled, previous, loginItemHooks));
    }

    async function reconnectPassive(cancel: AbortController): Promise<void> {
      const stopped = (): boolean => cancel.signal.aborted || terminating || cleanupPromise !== undefined || !bridge;
      const refusal = (): Error => new Error('Desktop reconnection was cancelled or timed out.');
      const unlessStopped = <T>(pending: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
        const stop = (): void => reject(refusal());
        if (stopped()) { stop(); return; }
        cancel.signal.addEventListener('abort', stop, { once: true });
        pending.then(resolve, reject).finally(() => cancel.signal.removeEventListener('abort', stop));
      });
      for (;;) {
        if (stopped()) throw refusal();
        const attaching = attachExisting(root);
        let next: AttachedDaemon;
        try { next = await unlessStopped(attaching); }
        catch (error) {
          if (stopped()) {
            void attaching.then(late => late.dispose()).catch(() => {});
            throw error;
          }
          if (!(error instanceof AttachError) ||
              (error.reason !== 'owner' && error.reason !== 'connection' && error.reason !== 'identity')) throw error;
          await unlessStopped(new Promise(resolve => setTimeout(resolve, 250)));
          continue;
        }
        if (stopped() || !bridge) { await next.dispose(); throw refusal(); }
        const closeCandidate = (): void => { void next.dispose().catch(() => {}); };
        cancel.signal.addEventListener('abort', closeCandidate, { once: true });
        const replacement = bridge.replaceOwner(next);
        try {
          try { await unlessStopped(replacement); }
          finally { cancel.signal.removeEventListener('abort', closeCandidate); }
        } catch (error) {
          if (stopped()) { await replacement.catch(() => {}); throw error; }
          if (!(error instanceof ConnectionError)) throw error;
          await unlessStopped(new Promise(resolve => setTimeout(resolve, 250)));
          continue;
        }
        connectionFailureShown = false;
        return;
      }
    }

    /** Follow a helper's handover, or passively authenticate whatever daemon comes back after a connection loss. */
    function recoverConnection(lost: AttachedDaemon['identity']): boolean {
      if (starting || terminating || cleanupPromise || !bridge) return false;
      controlledDisconnect = true;
      if (liveServiceActionRecord(root)?.phase === 'running') {
        void guardedService(() => followServiceHelper(serviceRuntime, lost, loginItemHooks)).catch(() => {
          controlledDisconnect = false;
          showConnectionLost();
        });
        return true;
      }
      const cancel = new AbortController();
      const deadline = setTimeout(() => cancel.abort(), restartDeadlineMs);
      restartCancel = cancel;
      const done = reconnectPassive(cancel).catch(() => {
        if (!terminating && !cleanupPromise && cancel.signal.reason !== startTakesOver) showConnectionLost();
      }).finally(() => {
        clearTimeout(deadline);
        if (passive?.cancel === cancel) passive = undefined;
        controlledDisconnect = false;
        starting = undefined;
        if (restartCancel === cancel) restartCancel = undefined;
      });
      passive = { cancel, done };
      starting = done;
      return true;
    }

    function showConnectionLost(): void {
      if (connectionFailureShown || terminating) return;
      connectionFailureShown = true;
      dialog.showMessageBoxSync(current, {
        type: 'error',
        title: 'Vonvon Bot connection lost',
        message: 'The daemon connection was lost. Check the daemon, then start it again in Vonvon Bot.',
        buttons: ['OK'],
      });
    }

    bridge = installBridge(owner, current, paths, {
      observeCli: () => observeCli(cliOptions),
      repairCli: async () => {
        const result = await registerCli(cliOptions);
        if (result.kind === 'error') throw new StartHostRefusal(result.message);
        return { type: 'done', message: result.message };
      },
      restartHost,
      stopHost,
      startHost: async bot => {
        for (let blocker = startBlocker('Desktop startup is unavailable.'); blocker; blocker = startBlocker('Desktop startup is unavailable.')) await blocker;
        const run = (async (): Promise<MachineReply> => {
          try {
            await reattachReady(bot);
            return { type: 'done', message: bot === undefined ? 'Daemon started.' : 'Selected Bot started.' };
          } catch (error) {
            if (error instanceof StartHostRefusal) throw error;
            throw new StartHostRefusal('The daemon could not start and reconnect. Check daemon.log and try again.');
          }
        })().finally(() => { starting = undefined; });
        starting = run;
        return run;
      },
      isExpectedDisconnect: () => controlledDisconnect,
      recoverConnection,
      setLoginItem,
      service: async (action, previous) => {
        if (action === 'install' || action === 'uninstall') {
          await setLoginItem(action === 'install', previous);
          return { type: 'done', message: action === 'install' ? '已打开登录时启动。' : '已关闭登录时启动。' };
        }
        if (action === 'start') {
          for (let blocker = startBlocker('Desktop service operation is unavailable.'); blocker; blocker = startBlocker('Desktop service operation is unavailable.')) await blocker;
        }
        return guardedService(async () => {
          if (action === 'stop') throw new StartHostRefusal('桌面版还不能单独停止后台服务：在终端运行 vonvon daemon stop。');
          if ((await managerDependencies.readRegistration()).kind !== 'ours') throw new StartHostRefusal('Install the background service first.');
          await reattachReady();
          return { type: 'done', message: 'Background service started.' };
        });
      },
      chooseExecutablePath: async () => {
        const result = await dialog.showOpenDialog(current, {
          title: 'Choose Codex executable',
          properties: ['openFile'],
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
      },
      chooseDirectoryPaths: async multiple => {
        const result = await dialog.showOpenDialog(current, {
          title: '选择目录',
          properties: multiple ? ['openDirectory', 'multiSelections'] : ['openDirectory'],
        });
        return result.canceled ? null : result.filePaths;
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
      hide,
      confirmQuit,
      connectionLost: showConnectionLost,
    });
    tray = createDesktopTray(icon, show, requestQuit);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Vonvon Bot', submenu: [
        { label: '显示 Vonvon Bot', click: show },
      ] },
      // macOS routes editing shortcuts, including Cmd+V in password fields, through native menu roles.
      { role: 'editMenu', label: '编辑' },
    ]));
    await current.loadFile(uiIndex);
    if (repairNotice) void dialog.showMessageBox(current, { type: 'warning', title: 'Vonvon Bot', message: repairNotice, buttons: ['OK'] }).catch(() => {});
    if (focusWhenReady) show();
    if (quitWhenReady) requestQuit();
  } catch (error) {
    fatal(startupMessage(error));
  }
}

void startDesktop();
