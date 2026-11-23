import {EventEmitter} from 'node:events';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import type {BrowserWindow, IpcMainInvokeEvent} from 'electron';
import {vi} from 'vitest';
import {ConnectionError, type VonvonClient} from '@vonvon/client/browser';
import type {AccountStatus, DesktopSnapshot} from '@vonvon/protocol';
import {installBridge} from '../../../desktop/src/bridge';
import {desktopChannels, type AttachedDaemon, type DesktopEvent, type ShellActions} from '../../../desktop/src/ipc-contract';
import type {NativeAccount} from '../../../desktop/src/account-session';
import type {DeviceConnections} from '../../../desktop/src/connections';
import type {FacadeTransport} from '../../../desktop/src/facade';
import {newClient} from '../devices-fixture';

const {handlers} = vi.hoisted(() => ({handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()}));
vi.mock('electron', () => ({ipcMain: {
  handle: (name: string, handle: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => handlers.set(name, handle),
  removeHandler: (name: string) => handlers.delete(name),
}, shell: {}}));

export function recipeBridge(devices: DeviceConnections, status: AccountStatus, initial: DesktopSnapshot, run: VonvonClient['run'], services: FacadeTransport['invoke']) {
  let listen: (event: DesktopEvent) => void = () => {};
  const dir = mkdtempSync(join(tmpdir(), 'recipe-restart-'));
  const uiIndex = join(dir, 'index.html');
  writeFileSync(uiIndex, '<!doctype html>');
  const mainFrame = {url: pathToFileURL(realpathSync(uiIndex)).href};
  const webContents = Object.assign(new EventEmitter(), {mainFrame, isDestroyed: () => false, send: (_channel: string, event: DesktopEvent) => listen(event)});
  const window = {isDestroyed: () => false, webContents} as unknown as BrowserWindow;
  const event = {sender: webContents, senderFrame: mainFrame} as unknown as IpcMainInvokeEvent;
  const unused = (): never => {throw new Error('Unexpected shell action');};
  const actions: ShellActions = {isExpectedDisconnect: () => true, chooseExecutablePath: unused, chooseDirectoryPaths: unused,
    startHost: unused, stopHost: unused, restartHost: unused, service: unused, setLoginItem: unused, recoverConnection: unused,
    repairCli: unused, observeCli: unused, checkDesktopUpdate: unused, retryDesktopUpdate: unused, installDesktopUpdate: unused,
    hide: unused, confirmQuit: unused, quitKeepsDaemon: unused, connectionLost: unused};
  const account: NativeAccount = {status: () => status, onStatus: () => () => {}, login: unused, cancelLogin: unused, logout: unused, request: unused, dispose: async () => {}};
  function owner(pid: number, value: DesktopSnapshot) {
    const errors = new Set<(error: Error) => void>(), snapshots = new Set<(snapshot: DesktopSnapshot) => void>();
    const daemon: AttachedDaemon = {
      identity: {pid, startedAt: 'test', listen: '127.0.0.1:4100'},
      serverInfo: {type: 'serverInfo', machineId: '11111111-1111-4111-8111-111111111111', version: '0.10.1', protocolVersion: 2},
      dispose: async () => {}, client: {...newClient(), snapshot: async () => value, run,
        watchSnapshots(listener) {snapshots.add(listener); return () => {snapshots.delete(listener);};},
        onError(listener) {errors.add(listener); return () => {errors.delete(listener);};},
      },
    };
    return {daemon, snapshots, errors};
  }
  let current = owner(1, initial);
  const bridge = installBridge(current.daemon, window, {uiIndex, preload: '', trayPng: ''}, actions, devices, account, join(dir, 'journal.json'));
  const passthrough = new Set<string>([desktopChannels.subscribe, desktopChannels.snapshot, desktopChannels.run, desktopChannels.devicesState, desktopChannels.accountStatus]);
  const transport: FacadeTransport = {
    receive(listener) {listen = listener; return () => {listen = () => {};};},
    invoke(channel, ...args) {return passthrough.has(channel) ? handlers.get(channel)!(event, ...args) : services(channel, ...args);},
  };
  return {transport, dispose: async () => {await bridge.dispose(); rmSync(dir,{recursive:true,force:true});},
    async replace(snapshot: DesktopSnapshot) {
      for (const cb of current.errors) cb(new ConnectionError('controlled restart'));
      current = owner(current.daemon.identity.pid + 1, snapshot);
      await bridge.replaceOwner(current.daemon);
    },
    push(snapshot: DesktopSnapshot) {for (const cb of current.snapshots) cb(snapshot);},
  };
}
