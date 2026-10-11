import type { VonvonClient } from '@vonvon/client/browser';
import type { BackendInstallEventPayload, DesktopSnapshot, DesktopUpdate, LogEventPayload } from '@vonvon/protocol';
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

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: SafeFailure };

export type DesktopEvent =
  | { type: 'snapshot'; value: DesktopSnapshot }
  | { type: 'log'; value: LogEventPayload }
  | { type: 'backendInstall'; value: BackendInstallEventPayload }
  | { type: 'error'; value: SafeFailure }
  | { type: 'quitRequested' };

export type DesktopShell = Required<Pick<ShellCapabilities,
  'openExternal' | 'chooseExecutablePath' | 'checkDesktopUpdate' | 'installDesktopUpdate' |
  'hideWindow' | 'quit' | 'onQuitRequested'>>;

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
  dispose(): Promise<void>;
}

export interface ShellActions {
  chooseExecutablePath(): Promise<string | null>;
  checkDesktopUpdate(): Promise<DesktopUpdate>;
  installDesktopUpdate(): Promise<DesktopUpdate>;
  hide(): void;
  confirmQuit(): Promise<void>;
  connectionLost(): void;
}
