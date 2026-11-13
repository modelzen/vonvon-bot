import { mkdirSync, realpathSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, autoUpdater, BrowserWindow, dialog, Menu, net, powerMonitor, safeStorage, shell, type WebContents } from 'electron';
import { resolveDataRoot } from '../../daemon/src/config/data-root.js';
import { attachExisting, AttachError } from './attach.js';
import { installBridge, openAllowedExternal } from './bridge.js';
import type { AttachedDaemon, DesktopBridge, DesktopResources } from './ipc-contract.js';
import { desktopFullScreenChannel } from './ipc-contract.js';
import { createDesktopTray, type DesktopTray } from './tray.js';
import { DesktopUpdater, scheduleUpdateChecks } from './updates.js';
import { WindowsDesktopUpdater, windowsUpdateConfiguration, createWindowsUpdateDriver } from './windows-updates.js';
import { desktopUpdateConfiguration } from './update-configuration.js';
import { createDaemonManager, protocolMismatchMessage, StartHostRefusal, type VerifiedDaemon } from './daemon-manager.js';
import { createDaemonDependencies, prepareDesktopRoot } from './daemon-dependencies.js';
import { daemonKeptOnQuit, stopDaemonForQuit } from './quit-daemon.js';
import { stopVerifiedOwner } from '../../daemon/src/server/owner-verification.js';
import { desktopCliOptions, observeCli, registerCli } from './cli-registration.js';
import { liveServiceActionRecord } from '../../daemon/src/service/action-report.js';
import { changeLoginItem, followServiceHelper, repairServiceAtStartup, type LoginItemHooks, type ServiceRuntime } from './login-item.js';
import { desktopUpdateNotice, PROTOCOL_VERSION, type CommandResult, type DesktopUpdate, type MachineReply } from '@vonvon/protocol';
import { accountDeployment } from './account-auth.js';
import { createAccountSession, type NativeAccount } from './account-session.js';
import { accountStore } from './account-store.js';
import { electronSecretBox, openDeviceRegistry } from './device-registry.js';
import { createDeviceConnections, type DeviceConnections } from './connections.js';
import { secureConnector } from './remote-transport.js';
import { createDeviceLog } from './device-log.js';
import { REMOTE_UPDATE_TEXT, startRemoteSelfUpdate, type RemoteSelfUpdate } from './remote-self-update.js';
import { ConnectionError, RpcError } from '@vonvon/client/browser';

declare const __VONVON_ACCOUNT_WEB_ORIGIN__: string | undefined;
declare const __VONVON_ACCOUNT_API_ORIGIN__: string | undefined;

/** 应用内更新没生效时给用户的手动下载地址，和设置页里的链接一致。 */
const downloadPage = 'https://vonvon.cc/get/';
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
  // Another protocol says which side is older (devices 4.5). `ensureReady` already says it with the registration; a
  // daemon swapped in before the attach gets the same words without it.
  if (error instanceof AttachError && error.reason === 'protocol' && error.serverProtocol !== undefined) {
    return protocolMismatchMessage({ server: error.serverProtocol, client: PROTOCOL_VERSION, registration: { kind: 'absent' } });
  }
  if (error instanceof AttachError) return error.reason === 'protocol' ? error.message : `${error.message}请先启动 daemon，再重新打开 Vonvon Bot。`;
  if (error instanceof Error) return error.message;
  return 'Vonvon Bot 没能打开桌面窗口。请检查 daemon，再重新打开应用。';
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
  let tray: DesktopTray | null = null;
  let stopUpdateChecks: (() => void) | undefined;
  let owner: AttachedDaemon | null = null;
  let bridge: DesktopBridge | null = null;
  let account: NativeAccount | undefined;
  let devices: DeviceConnections | null = null;
  const onResume = (): void => { devices?.wake(); };
  let quitting = false;
  let terminating = false;
  let focusWhenReady = false;
  let quitWhenReady = false;
  let cleanupPromise: Promise<void> | undefined;
  let confirmation: Promise<void> | undefined;
  let quitRequested = false;
  let stopBeforeQuit: (() => Promise<void>) | undefined;
  let connectionFailureShown = false;
  let controlledDisconnect = false;
  let starting: Promise<unknown> | undefined;
  let restartCancel: AbortController | undefined;
  let passive: { cancel: AbortController; done: Promise<void> } | undefined;
  let stopping: Promise<MachineReply> | undefined;
  let wantsVisible = true;
  let visibilityRevision = 0;
  let restoringDock: Promise<void> | undefined;
  /** U4: another device updating this computer's Vonvon Bot (macOS only for 0.9.0). */
  let remoteUpdate: RemoteSelfUpdate | undefined;

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
    if (quitRequested || quitting || terminating) return;
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
    stopUpdateChecks?.();
    stopUpdateChecks = undefined;
    restartCancel?.abort();
    powerMonitor.off('resume', onResume);
    remoteUpdate?.dispose();
    try {
      await account?.dispose();
      if (starting) await starting.catch(() => {});
      // Remote connections first, so no reconnect fires while the rest closes; the remote daemons are left alone.
      await devices?.dispose();
      if (bridge) await bridge.dispose();
      else if (owner) await owner.dispose();
    } catch (error) {
      closeFailure = error;
    } finally {
      bridge = null;
      devices = null;
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
      dialog.showErrorBox('Vonvon Bot', '桌面连接没有正常关闭。');
    }).finally(() => {
      dialog.showErrorBox('Vonvon Bot', message);
      quitting = true;
      app.quit();
    });
  };

  const confirmQuit = (): Promise<void> => confirmation ??= (async () => {
    if (terminating) return;
    quitRequested = true;
    // A real restart/start may be between owners. Let it finish so explicit Quit
    // can stop its successor; abort only passive reconnection, which starts nothing.
    if (passive && starting === passive.done) passive.cancel.abort();
    let timer: NodeJS.Timeout | undefined;
    try {
      if (starting) await Promise.race([
        starting.catch(() => {}),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new StartHostRefusal('后台切换还没有完成，Vonvon Bot 尚未退出。请稍后重试。')), stopDeadlineMs);
        }),
      ]);
      terminating = true;
      controlledDisconnect = true;
      await stopBeforeQuit?.();
    } catch (error) {
      terminating = false;
      quitRequested = false;
      controlledDisconnect = false;
      confirmation = undefined;
      show();
      dialog.showErrorBox('Vonvon Bot 尚未退出', error instanceof Error ? error.message : '后台服务尚未确认停止，请稍后再试。');
      throw error;
    } finally { clearTimeout(timer); }
    try { await cleanup(); }
    catch (error) {
      dialog.showErrorBox('Vonvon Bot', '桌面连接没有正常关闭。');
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
    const beforeUpdateInstall = async () => {
      // U4: a remote update tells the daemon it restarts now, before the connection closes (at most 2 s).
      await remoteUpdate?.aboutToRestart();
      // NSIS replaces this executable and its bundled daemon. Drain and stop the
      // authenticated owner before releasing the desktop connection or installing.
      if (process.platform === 'win32' && await managerDependencies.readVerifiedDaemon()) {
        const attached = await attachExisting(root);
        try { await stopHost(attached.identity, () => attached.client.machine({type:'stopHost', reason:'update'})); }
        finally { await attached.dispose(); }
      }
      await cleanup();
      terminating = true;
      quitting = true;
    };
    const updateStatePath = join(app.getPath('userData'), 'desktop-update-expected-version');
    const windowsConfiguration = await windowsUpdateConfiguration({appPath:app.getAppPath(),isPackaged:app.isPackaged});
    const updater = process.platform === 'win32' ? new WindowsDesktopUpdater({
      current: app.getVersion(),
      ...windowsConfiguration,
      driver: createWindowsUpdateDriver(windowsConfiguration.publicKey),
      onUpdate: update => { if (!terminating && !cleanupPromise) bridge?.publishUpdate(noteUpdate(update)); },
      beforeInstall: beforeUpdateInstall, statePath:updateStatePath,
    }) : new DesktopUpdater({
      current: app.getVersion(), ...updateConfiguration, driver: autoUpdater,
      // Chromium's stack follows the system proxy and the macOS keychain's certificate trust.
      fetch: (url, init) => net.fetch(url, init),
      statePath: updateStatePath,
      beforeInstall: beforeUpdateInstall,
    });
    // 菜单栏菜单和窗口里的更新提示（有新版本、上次没装上），都以最近一次检查的结果为准。
    const noteUpdate = (update: DesktopUpdate): DesktopUpdate => {
      tray?.setUpdate(desktopUpdateNotice(update));
      remoteUpdate?.observe(update);
      return update;
    };
    /** 重启升级's install, here or for another device: one that fails after the app closed its window says so and quits. */
    const installUpdate = async (): Promise<DesktopUpdate> => {
      try { return await updater.install(); }
      catch (error) {
        if (cleanupPromise) {
          terminating = true;
          dialog.showErrorBox('Vonvon Bot', `桌面更新没有完成。请重新打开 Vonvon Bot 再试一次；也可以到 ${downloadPage} 重新下载安装。`);
          quitting = true;
          app.quit();
        }
        throw error;
      }
    };
    await updater.settleInstallState().catch(() => {});
    const serviceRuntime: ServiceRuntime = {
      platform: process.platform, packaged: app.isPackaged, root, home: homedir(),
      executable: process.execPath, resources: process.resourcesPath,
    };
    const managerDependencies = createDaemonDependencies(serviceRuntime);
    const manager = createDaemonManager(managerDependencies);
    // devices 7.4: a server installed and registered on its own, and not the one this app carries, stays on quit.
    const keepOnQuit = (owner: VerifiedDaemon): Promise<boolean> =>
      daemonKeptOnQuit(owner, { readRegistration: () => managerDependencies.readRegistration(), attach: () => attachExisting(root) });
    stopBeforeQuit = () => stopDaemonForQuit({
      keep: keepOnQuit,
      readVerifiedDaemon: () => managerDependencies.readVerifiedDaemon(),
      requestStop: daemon => stopVerifiedOwner(root, daemon),
      ownerRunning: daemon => managerDependencies.ownerRunning(daemon),
      handoffPending: () => liveServiceActionRecord(root)?.phase === 'running',
      pause: ms => managerDependencies.pause(ms),
    });
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
      width: 910,
      height: 808,
      minWidth: 760,
      minHeight: 640,
      show: false,
      ...(process.platform === 'win32' ? { icon: join(dirname(icon), 'windows-icon.ico') } : {}),
      backgroundColor: '#f5f5f7',
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 12, y: 10 } }
        : { titleBarOverlay: { color: '#e7e8ec', symbolColor: '#5f6068', height: 34 } }),
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
    const publishFullScreen = (value: boolean): void => {
      if (authorizedDocument()) current.webContents.send(desktopFullScreenChannel, value);
    };
    current.on('enter-full-screen', () => publishFullScreen(true));
    current.on('leave-full-screen', () => publishFullScreen(false));
    current.webContents.on('did-finish-load', () => publishFullScreen(current.isFullScreen()));
    current.webContents.setWindowOpenHandler(({ url }) => {
      if (authorizedDocument()) void openAllowedExternal(url).catch(() => {
        dialog.showMessageBoxSync(current, {
          type: 'warning', title: 'Vonvon Bot', message: '无法打开这个外部链接。', buttons: ['好'],
        });
      });
      return { action: 'deny' };
    });
    current.webContents.on('will-navigate', event => event.preventDefault());
    current.webContents.on('will-frame-navigate', event => event.preventDefault());
    current.webContents.on('will-redirect', event => event.preventDefault());
    current.webContents.on('will-attach-webview', event => event.preventDefault());
    current.webContents.on('render-process-gone', () => fatal('桌面窗口意外停止了。请重新打开 Vonvon Bot。'));
    current.webContents.on('did-fail-load', (_event, code, _description, _validatedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) fatal('桌面页面没能加载。请重新打开 Vonvon Bot。');
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
      // Quit can still fail while the daemon drains. Keep this window reusable
      // until desktop cleanup actually commits, so a failed stop can be retried.
      if (!quitting && !cleanupPromise) {
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
        throw new Error('重启期间，后台的所有者变了。');
      }
      if (terminating || !bridge) {
        await next.dispose();
        throw new Error('桌面端正在退出或还没启动完，不能重新连接。');
      }
      await bridge.replaceOwner(next);
      connectionFailureShown = false;
      controlledDisconnect = false;
    }

    async function restartHost(previous: AttachedDaemon['identity'], send: () => Promise<CommandResult>): Promise<CommandResult> {
      if (quitRequested || starting || terminating || cleanupPromise) throw new StartHostRefusal('正在启动、重启或重新连接 daemon，等它结束再重启。');
      const cancel = new AbortController();
      const cancelled = (): boolean => cancel.signal.aborted || terminating || cleanupPromise !== undefined || !bridge;
      const refusal = (): StartHostRefusal => new StartHostRefusal('重启已取消。');
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
              throw new StartHostRefusal('重启期间 daemon 被另一个进程接管了，请稍后再试。');
            }
            await unlessCancelled(bridge.replaceOwner(next));
            connectionFailureShown = false;
            controlledDisconnect = false;
            return result;
          }
          ownerlessSince = ready ? undefined : ownerlessSince ?? Date.now();
          if (ownerlessSince !== undefined && Date.now() - ownerlessSince >= restartDeadlineMs) throw new StartHostRefusal('daemon 重启后没有回来。先看 daemon.log，再在 Vonvon Bot 里启动它。');
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
      if (quitRequested || starting || terminating || cleanupPromise) throw new StartHostRefusal('正在启动、重启或重新连接 daemon，等它结束再停止。');
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
      if (quitRequested || terminating || cleanupPromise) throw new StartHostRefusal(refusal);
      if (!starting) return undefined;
      if (passive && starting === passive.done) { passive.cancel.abort(startTakesOver); return passive.done; }
      if (stopping && starting === stopping) return stopping.catch(() => {});
      throw new StartHostRefusal(refusal);
    }

    async function guardedService<T>(operation: () => Promise<T>): Promise<T> {
      if (quitRequested || starting || terminating || cleanupPromise) throw new StartHostRefusal('正在启动、重启或重新连接 daemon，等它结束再操作后台服务。');
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
      const refusal = (): Error => new Error('重新连接已取消或超时。');
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
              (error.reason !== 'owner' && error.reason !== 'connection' && error.reason !== 'identity' && error.reason !== 'protocol')) throw error;
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
      if (quitRequested || starting || terminating || cleanupPromise || !bridge) return false;
      controlledDisconnect = true;
      if (liveServiceActionRecord(root)?.phase === 'running') {
        void guardedService(() => followServiceHelper(serviceRuntime, lost, loginItemHooks)).catch(() => {
          controlledDisconnect = false;
          if (!bridge?.deferLocalLost()) showConnectionLost();
        });
        return true;
      }
      const cancel = new AbortController();
      const deadline = setTimeout(() => cancel.abort(), restartDeadlineMs);
      restartCancel = cancel;
      const done = reconnectPassive(cancel).catch(() => {
        if (!terminating && !cleanupPromise && cancel.signal.reason !== startTakesOver && !bridge?.deferLocalLost()) showConnectionLost();
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
      if (connectionFailureShown || quitRequested || terminating) return;
      connectionFailureShown = true;
      dialog.showMessageBoxSync(current, {
        type: 'error',
        title: 'Vonvon Bot 连接中断',
        message: 'daemon 连接中断了。检查 daemon，再在 Vonvon Bot 里重新启动。',
        buttons: ['好'],
      });
    }

    // devices-ui-1a 4.8: the devices this computer manages; the list never stops the app from starting.
    const deviceLog = createDeviceLog<string>(join(app.getPath('userData'), 'devices.log'));
    const box = electronSecretBox(safeStorage);
    const webOrigin = typeof __VONVON_ACCOUNT_WEB_ORIGIN__ !== 'undefined' ? __VONVON_ACCOUNT_WEB_ORIGIN__ : undefined;
    const apiOrigin = typeof __VONVON_ACCOUNT_API_ORIGIN__ !== 'undefined' ? __VONVON_ACCOUNT_API_ORIGIN__ : undefined;
    const allowDev = !app.isPackaged;
    const deployment = accountDeployment(webOrigin ?? (allowDev ? process.env.VONVON_ACCOUNT_WEB_ORIGIN : undefined),
      apiOrigin ?? (allowDev ? process.env.VONVON_ACCOUNT_API_ORIGIN : undefined), allowDev);
    const accountBox = {
      ...box,
      available: () => box.available() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    };
    account = createAccountSession({
      deployment, store: accountStore(join(app.getPath('userData'), 'account.session'), accountBox),
      openBrowser: url => shell.openExternal(url),
    });
    const registry = await openDeviceRegistry(join(app.getPath('userData'), 'devices.json'), box);
    devices = createDeviceConnections({
      registry, connector: secureConnector(), box,
      client: { version: app.getVersion(), protocolVersion: PROTOCOL_VERSION },
      log: deviceLog,
      // macOS 15 is Darwin 24.
      localNetworkPrivacy: process.platform === 'darwin' && Number(release().split('.')[0]) >= 24,
    });
    devices.setLocal({ status: 'online', serverInfo: owner.serverInfo });
    powerMonitor.on('resume', onResume);
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
        for (let blocker = startBlocker('正在启动、重启或重新连接 daemon，等它结束再启动。'); blocker; blocker = startBlocker('正在启动、重启或重新连接 daemon，等它结束再启动。')) await blocker;
        const run = (async (): Promise<MachineReply> => {
          try {
            await reattachReady(bot);
            return { type: 'done', message: bot === undefined ? 'daemon 已启动。' : '所选 Bot 已启动。' };
          } catch (error) {
            if (error instanceof StartHostRefusal) throw error;
            throw new StartHostRefusal('daemon 没能启动并重新连上。看看 daemon.log，再试一次。');
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
          for (let blocker = startBlocker('正在启动、重启或重新连接 daemon，等它结束再操作后台服务。'); blocker; blocker = startBlocker('正在启动、重启或重新连接 daemon，等它结束再操作后台服务。')) await blocker;
        }
        return guardedService(async () => {
          if (action === 'stop') throw new StartHostRefusal('桌面版还不能单独停止后台服务：在终端运行 vonvon daemon stop。');
          if ((await managerDependencies.readRegistration()).kind !== 'ours') throw new StartHostRefusal('先安装后台服务。');
          await reattachReady();
          return { type: 'done', message: '后台服务已启动。' };
        });
      },
      chooseExecutablePath: async () => {
        const result = await dialog.showOpenDialog(current, {
          title: '选择 Codex 可执行文件',
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
      checkDesktopUpdate: async () => noteUpdate(await updater.check()),
      retryDesktopUpdate: async () => noteUpdate(await updater.retry()),
      installDesktopUpdate: async () => {
        if (quitRequested) throw new StartHostRefusal('Vonvon Bot 正在退出，请稍后再更新。');
        // U4: another device's update downloads and restarts on its own; two installs must not race to quitAndInstall.
        if (remoteUpdate?.busy) throw new StartHostRefusal(REMOTE_UPDATE_TEXT.localRefused);
        // No question first, as on macOS (owner 2026-11-02): the button itself says the restart interrupts the
        // conversations in progress; a dialog on an unattended computer would wait forever.
        return installUpdate();
      },
      hide,
      confirmQuit,
      quitKeepsDaemon: async () => {
        const verified = await managerDependencies.readVerifiedDaemon().catch(() => null);
        return verified ? keepOnQuit(verified) : false;
      },
      connectionLost: showConnectionLost,
    }, devices, account, join(app.getPath('userData'),'recipe-install-journal.json'),
      join(app.getPath('userData'),'recipe-authoring-journal.json'));
    tray = createDesktopTray(icon, show, requestQuit);
    // U4: the daemon this app carries asks it to update when another device says so. Windows' app is updated on that
    // computer for 0.9.0 (owner 2026-11-02): its shell does not declare it can, as its daemon does not offer it.
    if (process.platform !== 'win32') {
      remoteUpdate = startRemoteSelfUpdate({
        updater: { check: () => updater.check(), install: installUpdate, get busy() { return updater.busy; } },
        owner: () => bridge?.localOwner() ?? null,
        onOwner: listener => bridge?.onLocalOwner(listener) ?? (() => {}),
        quitting: () => quitRequested || terminating || cleanupPromise !== undefined,
        notice: text => { tray?.setNotice(text); bridge?.sendRemoteUpdate(text); },
        publish: update => { if (!terminating && !cleanupPromise) bridge?.publishUpdate(noteUpdate(update)); },
        log: (event, fields = {}) => deviceLog(event, fields),
      });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Vonvon Bot', submenu: [
        { label: '显示 Vonvon Bot', click: show },
      ] },
      // macOS routes editing shortcuts, including Cmd+V in password fields, through native menu roles.
      { role: 'editMenu', label: '编辑' },
    ]));
    await current.loadFile(uiIndex);
    // 页面加载完后再开始计时；只发现新版本，下载和安装仍由用户点。
    if (updater.enabled && !terminating && !cleanupPromise) {
      stopUpdateChecks = scheduleUpdateChecks(updater, update => {
        if (terminating || cleanupPromise || !bridge) return;
        bridge.publishUpdate(noteUpdate(update));
      }, {
        onResume: listener => {
          powerMonitor.on('resume', listener);
          return () => { powerMonitor.removeListener('resume', listener); };
        },
      });
    }
    if (repairNotice) void dialog.showMessageBox(current, { type: 'warning', title: 'Vonvon Bot', message: repairNotice, buttons: ['好'] }).catch(() => {});
    if (focusWhenReady) show();
    if (quitWhenReady) requestQuit();
  } catch (error) {
    fatal(startupMessage(error));
  }
}

void startDesktop();
