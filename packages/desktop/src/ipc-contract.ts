import { z } from 'zod';
import type { ServerInfo, VonvonClient } from '@vonvon/client/browser';
import { agentIdSchema, type BackendInstallEventPayload, type CommandResult, type DesktopSnapshot, type DesktopUpdate, type LogEventPayload, type MachineReply } from '@vonvon/protocol';
import type { ShellCapabilities } from '../../ui/src/client-context.js';

/** Main-to-preload notification only; it exposes no renderer action or daemon access. */
export const desktopFullScreenChannel = 'desktop:window:fullscreen';

export const desktopChannels = {
  snapshot: 'desktop:client:snapshot',
  run: 'desktop:client:run',
  settings: 'desktop:client:settings',
  collaboration: 'desktop:client:collaboration',
  environment: 'desktop:client:environment',
  machine: 'desktop:client:machine',
  admin: 'desktop:client:admin',
  directory: 'desktop:client:directory',
  library: 'desktop:client:library',
  memory: 'desktop:client:memory',
  contextPreview: 'desktop:client:contextPreview',
  schedule: 'desktop:client:schedule',
  device: 'desktop:client:device',
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
  retryDesktopUpdate: 'desktop:shell:retryDesktopUpdate',
  installDesktopUpdate: 'desktop:shell:installDesktopUpdate',
  hide: 'desktop:shell:hide',
  quit: 'desktop:shell:quit',
  event: 'desktop:event',
} as const;

/**
 * The machine-page actions the shell does itself, not the daemon (devices 8.4): their shapes live here, so the protocol
 * no longer declares `repairCli` and the desktop update requests for the shell's sake.
 */
export const desktopShellRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('startHost'), bot: agentIdSchema.unwrap().optional() }),
  z.object({ type: z.literal('service'), action: z.enum(['install', 'start', 'stop', 'uninstall']) }),
  z.object({ type: z.literal('repairCli') }),
  z.object({ type: z.literal('checkDesktopUpdate') }),
  z.object({ type: z.literal('installDesktopUpdate') }),
]);
export type DesktopShellRequest = z.infer<typeof desktopShellRequestSchema>;

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
  /** 自动检查更新的结果；窗口之后才订阅时由主进程补发最近一次。 */
  | { type: 'update'; value: DesktopUpdate }
  | { type: 'error'; value: SafeFailure }
  | { type: 'quitRequested' };

export type DesktopShell = Required<Pick<ShellCapabilities,
  'openExternal' | 'chooseExecutablePath' | 'chooseDirectoryPaths' | 'checkDesktopUpdate' | 'retryDesktopUpdate' | 'installDesktopUpdate' | 'onDesktopUpdate' |
  'hideWindow' | 'quit' | 'onQuitRequested' | 'startHost' | 'repairCli' | 'service' | 'setLoginItem'>>;

export interface DesktopResources {
  uiIndex: string;
  preload: string;
  trayPng: string;
}

export interface AttachedDaemon {
  readonly client: VonvonClient;
  /** What the daemon answered the hello with (devices 4.1). */
  readonly serverInfo: ServerInfo;
  readonly identity: { pid: number; startedAt: string; listen: string };
  dispose(): Promise<void>;
}

export interface DesktopBridge {
  requestQuit(): void;
  /** 把自动检查到的更新状态推给窗口；窗口还没订阅或刷新后重新订阅时补发最近一次。 */
  publishUpdate(update: DesktopUpdate): void;
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
  /** 忘掉上次没生效的安装，再检查一次。 */
  retryDesktopUpdate(): Promise<DesktopUpdate>;
  installDesktopUpdate(): Promise<DesktopUpdate>;
  hide(): void;
  confirmQuit(): Promise<void>;
  connectionLost(): void;
}
