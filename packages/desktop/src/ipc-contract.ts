import type { VonvonClient } from '@vonvon/client/browser';
import type { BackendInstallEventPayload, CommandResult, DesktopSnapshot, DesktopUpdate, LogEventPayload, MachineReply } from '@vonvon/protocol';
import type { ShellCapabilities } from '../../ui/src/client-context.js';

export const desktopChannels = {
  snapshot: 'desktop:client:snapshot',
  run: 'desktop:client:run',
  settings: 'desktop:client:settings',
  collaboration: 'desktop:client:collaboration',
  environment: 'desktop:client:environment',
  machine: 'desktop:client:machine',
  admin: 'desktop:client:admin',
  directory: 'desktop:client:directory',
  close: 'desktop:client:close',
  subscribe: 'desktop:subscribe',
  external: 'desktop:shell:external',
  chooseExecutablePath: 'desktop:shell:chooseExecutablePath',
  chooseDirectoryPaths: 'desktop:shell:chooseDirectoryPaths',
  startHost: 'desktop:shell:startHost',
  service: 'desktop:shell:service',
  setLoginItem: 'desktop:shell:setLoginItem',
  repairCli: 'desktop:shell:repairCli',
  checkDesktopUpdate: 'desktop:shell:checkDesktopUpdate',
  installDesktopUpdate: 'desktop:shell:installDesktopUpdate',
  hide: 'desktop:shell:hide',
  quit: 'desktop:shell:quit',
  event: 'desktop:event',
} as const;

export type SafeFailure = {
  kind: 'rpc' | 'connection' | 'validation';
  message: string;
  code?: string;
};

/** A daemon error code the renderer may see: short and plain, so it cannot carry text of its own. */
export function safeErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : undefined;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: SafeFailure };

export type DesktopEvent =
  | { type: 'reattached' }
  | { type: 'snapshot'; value: DesktopSnapshot }
  | { type: 'log'; value: LogEventPayload }
  | { type: 'backendInstall'; value: BackendInstallEventPayload }
  | { type: 'error'; value: SafeFailure }
  | { type: 'quitRequested' };

export type DesktopShell = Required<Pick<ShellCapabilities,
  'openExternal' | 'chooseExecutablePath' | 'chooseDirectoryPaths' | 'checkDesktopUpdate' | 'installDesktopUpdate' |
  'hideWindow' | 'quit' | 'onQuitRequested' | 'startHost' | 'repairCli' | 'service' | 'setLoginItem'>>;

export interface DesktopResources {
  uiIndex: string;
  preload: string;
  trayPng: string;
}

export interface AttachedDaemon {
  readonly client: VonvonClient;
  readonly identity: { pid: number; startedAt: string; listen: string };
  dispose(): Promise<void>;
}

export interface DesktopBridge {
  requestQuit(): void;
  /** Takes ownership of `owner`, closing it on failure and when the bridge is disposed mid-replacement. */
  replaceOwner(owner: AttachedDaemon): Promise<void>;
  dispose(): Promise<void>;
}

export interface ShellActions {
  chooseExecutablePath(): Promise<string | null>;
  chooseDirectoryPaths(multiple: boolean): Promise<string[] | null>;
  startHost(bot?: string): Promise<MachineReply>;
  /** Expect disconnection before sending the machine-page stop, then wait for this daemon to exit. */
  stopHost(previous: AttachedDaemon['identity'], send: () => Promise<MachineReply>): Promise<MachineReply>;
  restartHost(previous: AttachedDaemon['identity'], send: () => Promise<CommandResult>): Promise<CommandResult>;
  /** `previous` is the daemon the window talks to, so a switch that replaced it reattaches. */
  service(action: 'install' | 'start' | 'stop' | 'uninstall', previous?: AttachedDaemon['identity'] | null): Promise<MachineReply>;
  setLoginItem(enabled: boolean, previous?: AttachedDaemon['identity'] | null): Promise<void>;
  isExpectedDisconnect(): boolean;
  /** True when the shell takes responsibility for reattachment and reports an unrecoverable drop itself. */
  recoverConnection(lost: AttachedDaemon['identity']): boolean;
  repairCli(): Promise<MachineReply>;
  observeCli(): Promise<Extract<MachineReply, { type: 'status' }>['cli']>;
  checkDesktopUpdate(): Promise<DesktopUpdate>;
  installDesktopUpdate(): Promise<DesktopUpdate>;
  hide(): void;
  confirmQuit(): Promise<void>;
  connectionLost(): void;
}
