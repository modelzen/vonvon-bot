import { z } from 'zod';
import type { ServerInfo, VonvonClient } from '@vonvon/client/browser';
import {
  agentIdSchema, viewIdSchema, type AuthoringSaved, type AccountShell, type CommunityShell, type RecipeUseShell, type RecipeAuthoringShell, type RecipeSourceShell, type AccountStatus, type BackendInstallEventPayload, type CommandResult, type DesktopSnapshot, type DesktopUpdate, type DeviceEventPayload,
  type DevicesState, type LogEventPayload, type MachineReply, type ViewId,
} from '@vonvon/protocol';
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
  community: 'desktop:community:request',
  recipeSource: 'desktop:recipe-source:request',
  recipeAuthoring: 'desktop:recipe-authoring:request',
  recipeUse: 'desktop:recipe-use:request',
  accountStatus: 'desktop:account:status',
  accountLogin: 'desktop:account:login',
  accountCancel: 'desktop:account:cancel',
  accountLogout: 'desktop:account:logout',
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
  quitKeepsDaemon: 'desktop:quit-keeps-daemon',
  devicesState: 'desktop:devices:state',
  devicesInspect: 'desktop:devices:inspect',
  devicesAdd: 'desktop:devices:add',
  devicesCancelAdd: 'desktop:devices:cancelAdd',
  devicesRename: 'desktop:devices:rename',
  devicesRemove: 'desktop:devices:remove',
  devicesSwitch: 'desktop:devices:switch',
  devicesRetry: 'desktop:devices:retry',
  event: 'desktop:event',
} as const;

/** devices-ui-1a 4.6: the channels that reach a daemon take one more, last argument: the device the calling page belongs
 * to, or 'current'. A page bound to one device cannot send to another after a switch. */
export const clientChannelNames = [
  'snapshot', 'run', 'settings', 'collaboration', 'environment', 'machine', 'admin', 'memory', 'contextPreview', 'directory',
  'library', 'schedule', 'device', 'close',
] as const satisfies readonly (keyof typeof desktopChannels)[];
export const viewArgumentSchema = z.union([viewIdSchema, z.literal('current')]);
export type ViewArgument = z.infer<typeof viewArgumentSchema>;

/** The machine-page actions the shell does itself, not the daemon (devices 8.4): their shapes live here, so the protocol
 * no longer declares `repairCli` and the desktop update requests for the shell's sake. */
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
  retryAfter?: number;
};

/** A daemon error code the renderer may see: short and plain, so it cannot carry text of its own. */
export function safeErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : undefined;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: SafeFailure };

export type DesktopEvent =
  /** The page now hears `view`'s connection: snapshots after it come from there only. */
  | { type: 'reattached'; view: ViewId }
  | { type: 'snapshot'; view: ViewId; value: DesktopSnapshot }
  | { type: 'log'; view: ViewId; value: LogEventPayload }
  | { type: 'backendInstall'; view: ViewId; value: BackendInstallEventPayload }
  | { type: 'device'; view: ViewId; value: DeviceEventPayload }
  /** This computer's own device events, whichever device the page shows (U3's "new device paired"). */
  | { type: 'localDevice'; value: DeviceEventPayload }
  | { type: 'account'; value: AccountStatus }
  | { type: 'authoringSaved'; value: AuthoringSaved }
  | { type: 'devices'; value: DevicesState }
  /** 自动检查更新的结果；窗口之后才订阅时由主进程补发最近一次。 */
  | { type: 'update'; value: DesktopUpdate }
  /** U4: another device is updating this computer's Vonvon Bot; no text when it ended. A window that subscribes later
   * gets the last one. */
  | { type: 'remoteUpdate'; text?: string }
  | { type: 'error'; value: SafeFailure }
  | { type: 'quitRequested' };

export type DesktopShell = Required<Pick<ShellCapabilities,
  'openExternal' | 'chooseExecutablePath' | 'chooseDirectoryPaths' | 'checkDesktopUpdate' | 'retryDesktopUpdate' | 'installDesktopUpdate' | 'onDesktopUpdate' |
  'hideWindow' | 'quit' | 'onQuitRequested' | 'startHost' | 'repairCli' | 'service' | 'setLoginItem' | 'devices' | 'onLocalDeviceEvent' | 'quitKeepsDaemon' | 'onRemoteUpdate'>> & { account: AccountShell; community: CommunityShell; recipeAuthoring: RecipeAuthoringShell; recipeUse: RecipeUseShell; recipeSource:RecipeSourceShell };

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
  /** This computer's daemon connection, whichever device the page shows; null while it is lost. */
  localOwner(): AttachedDaemon | null;
  /** Each new local connection once it is ready (looking at this computer or not); never on a loss. U4 declares its
   * capability on each. A listener that throws affects no other. */
  onLocalOwner(listener: (owner: AttachedDaemon) => void): () => void;
  /** The shell gave up reconnecting: this computer shows offline. Showing a remote device: the loss is reported when the
   * user switches back. True when deferred. */
  deferLocalLost(): boolean;
  viewId(): ViewId;
  requestQuit(): void;
  /** 把自动检查到的更新状态推给窗口；窗口还没订阅或刷新后重新订阅时补发最近一次。 */
  publishUpdate(update: DesktopUpdate): void;
  /** U4: the window's line while another device updates this computer; kept for a window that subscribes later. */
  sendRemoteUpdate(text: string | undefined): void;
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
  /** devices 7.4: whether quitting leaves this computer's verified daemon running. No daemon or unsure is false. */
  quitKeepsDaemon(): Promise<boolean>;
  connectionLost(): void;
}
