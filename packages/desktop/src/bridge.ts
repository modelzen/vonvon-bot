import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { shell, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { ConnectionError, RpcError } from '@vonvon/client/browser';
import {
  adminRequestSchema, collaborationRequestSchema, commandSchema,
  directoryRequestSchema, environmentRequestSchema, machineRequestSchema,
  settingsRequestSchema,
} from '@vonvon/protocol';
import { allowedExternalUrl, type ExternalUrlKind } from '../../ui/src/url-actions.js';
import {
  desktopChannels, type AttachedDaemon, type DesktopBridge, type DesktopEvent,
  type DesktopResources, type IpcResult, type SafeFailure, type ShellActions,
} from './ipc-contract.js';

const externalKinds: readonly ExternalUrlKind[] = [
  'registration', 'authorization', 'verification', 'event-settings', 'group', 'releases',
];

export async function openAllowedExternal(raw: unknown): Promise<void> {
  if (typeof raw !== 'string') throw new Error('Unsupported external link');
  const url = externalKinds.map(kind => allowedExternalUrl(raw, kind)).find(value => value !== null);
  if (!url) throw new Error('Unsupported external link');
  await shell.openExternal(url);
}

function safeFailure(error: unknown): SafeFailure {
  if (error instanceof RpcError) {
    return {
      kind: 'rpc', message: 'Daemon request failed',
      ...( /^[A-Za-z0-9_.-]{1,80}$/.test(error.code) ? { code: error.code } : {}),
    };
  }
  if (error instanceof ConnectionError) return { kind: 'connection', message: 'Daemon connection lost' };
  return { kind: 'validation', message: 'Desktop request failed' };
}

function failure(error: unknown): IpcResult<never> {
  return { ok: false, error: safeFailure(error) };
}

export function installBridge(
  owner: AttachedDaemon, window: BrowserWindow, paths: DesktopResources, actions: ShellActions,
): DesktopBridge {
  const expectedUrl = pathToFileURL(realpathSync(paths.uiIndex)).href;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let subscribed = false;
  let pendingQuit = false;
  let connectionLost = false;
  const retainedErrors: SafeFailure[] = [];

  function currentDocument(): boolean {
    if (disposed || window.isDestroyed() || window.webContents.isDestroyed()) return false;
    const mainFrame = window.webContents.mainFrame;
    return mainFrame !== undefined && mainFrame.url === expectedUrl;
  }

  function authorized(event: IpcMainInvokeEvent): boolean {
    return currentDocument() && event.sender === window.webContents &&
      event.senderFrame !== null && event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame.url === expectedUrl;
  }

  function send(event: DesktopEvent): void {
    if (!subscribed || !currentDocument()) return;
    window.webContents.send(desktopChannels.event, event);
  }

  function retain(error: SafeFailure): void {
    retainedErrors.push(error);
    if (retainedErrors.length > 32) retainedErrors.shift();
  }

  function onError(error: Error): void {
    if (disposed) return;
    const safe = safeFailure(error);
    if (!subscribed || !currentDocument()) retain(safe);
    else send({ type: 'error', value: safe });
    if (error instanceof ConnectionError && !connectionLost) {
      connectionLost = true;
      actions.connectionLost();
    }
  }

  const offSnapshot = owner.client.watchSnapshots(value => send({ type: 'snapshot', value }));
  const offLog = owner.client.onLog(value => send({ type: 'log', value }));
  const offInstall = owner.client.onBackendInstall(value => send({ type: 'backendInstall', value }));
  const offError = owner.client.onError(onError);
  const registeredChannels: string[] = [];

  function register<T>(channel: string, arity: number, parse: (value: unknown) => T,
    invoke: (value: T) => Promise<unknown>): void {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      if (!authorized(event)) return { ok: false, error: { kind: 'validation', message: 'Unauthorized desktop request' } };
      if (args.length !== arity) return { ok: false, error: { kind: 'validation', message: 'Invalid desktop request' } };
      try { return { ok: true, value: await invoke(parse(args[0])) }; }
      catch (error) { return failure(error); }
    });
    registeredChannels.push(channel);
  }

  const noArg = (_: unknown): undefined => undefined;
  const onNavigation = (): void => { subscribed = false; };
  try {
    register(desktopChannels.snapshot, 0, noArg, () => owner.client.snapshot());
    register(desktopChannels.run, 1, value => commandSchema.parse(value), value => owner.client.run(value));
    register(desktopChannels.settings, 1, value => settingsRequestSchema.parse(value), value => owner.client.settings(value));
    register(desktopChannels.collaboration, 1, value => collaborationRequestSchema.parse(value), value => owner.client.collaboration(value));
    register(desktopChannels.environment, 1, value => environmentRequestSchema.parse(value), value => owner.client.environment(value));
    register(desktopChannels.machine, 1, value => {
      const request = machineRequestSchema.parse(value);
      if (request.type === 'repairCli' || request.type === 'service' || request.type === 'startHost' ||
          request.type === 'checkDesktopUpdate' || request.type === 'installDesktopUpdate')
        throw new Error('Shell-owned machine action');
      return request;
    }, value => owner.client.machine(value));
    register(desktopChannels.admin, 1, value => adminRequestSchema.parse(value), value => owner.client.admin(value));
    register(desktopChannels.directory, 1, value => directoryRequestSchema.parse(value), value => owner.client.directory(value));
    register(desktopChannels.close, 0, noArg, () => owner.dispose());
    register(desktopChannels.external, 1, value => value, openAllowedExternal);
    register(desktopChannels.chooseExecutablePath, 0, noArg, () => actions.chooseExecutablePath());
    register(desktopChannels.checkDesktopUpdate, 0, noArg, () => actions.checkDesktopUpdate());
    register(desktopChannels.installDesktopUpdate, 0, noArg, () => actions.installDesktopUpdate());
    register(desktopChannels.hide, 0, noArg, async () => { actions.hide(); });
    register(desktopChannels.quit, 0, noArg, () => actions.confirmQuit());
    ipcMain.handle(desktopChannels.subscribe, async (event, ...args): Promise<IpcResult<void>> => {
      if (!authorized(event)) return { ok: false, error: { kind: 'validation', message: 'Unauthorized desktop request' } };
      if (args.length !== 0) return { ok: false, error: { kind: 'validation', message: 'Invalid desktop request' } };
      subscribed = true;
      for (const value of retainedErrors.splice(0)) send({ type: 'error', value });
      if (pendingQuit) { pendingQuit = false; send({ type: 'quitRequested' }); }
      return { ok: true, value: undefined };
    });
    registeredChannels.push(desktopChannels.subscribe);
    window.webContents.on('did-start-navigation', onNavigation);
  } catch (error) {
    window.webContents.removeListener('did-start-navigation', onNavigation);
    for (const channel of registeredChannels) ipcMain.removeHandler(channel);
    offSnapshot(); offLog(); offInstall(); offError();
    throw error;
  }

  return {
    requestQuit() {
      if (disposed) return;
      if (!subscribed || !currentDocument()) pendingQuit = true;
      else send({ type: 'quitRequested' });
    },
    dispose() {
      disposal ??= (async () => {
        disposed = true;
        subscribed = false;
        window.webContents.removeListener('did-start-navigation', onNavigation);
        for (const channel of registeredChannels) ipcMain.removeHandler(channel);
        offSnapshot(); offLog(); offInstall(); offError();
        await owner.dispose();
      })();
      return disposal;
    },
  };
}
