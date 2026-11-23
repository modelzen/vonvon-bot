import { draftPreviewNavigationIdSchema } from '@vonvon/protocol';
import { RecipePreviewNavigation } from './recipe-preview-navigation.js';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { shell, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { ConnectionError, RpcError, type VonvonClient } from '@vonvon/client/browser';
import {
  desktopAuthoringRequestSchema, desktopRecipeSourceRequestSchema, recipeUseRequestSchema, communityRequestSchema, accountStatusSchema, adminRequestSchema, agentIdSchema, collaborationRequestSchema, commandSchema, scheduleRequestSchema,
  directoryRequestSchema, environmentRequestSchema, libraryRequestSchema, machineRequestSchema, memoryRequestSchema, contextPreviewRequestSchema, deviceRequestSchema,
  settingsRequestSchema, machineReplySchema, addDeviceRequestSchema, viewIdSchema, LOCAL_VIEW,
  type DesktopSnapshot, type DesktopUpdate, type MachineReply, type ViewId,
} from '@vonvon/protocol';
import { DeviceConnectionsError, type DeviceConnections, type ViewChange, type ViewSession } from './connections.js';
import { communityRequest, CommunityError } from './community-api.js';
import {RecipeUseController, type RecipeDeviceLease} from './recipe-use.js';
import {RecipeAuthoringController} from './recipe-authoring.js';
import {AuthoringJournal} from './recipe-authoring-journal.js';
import {AuthoringError} from './recipe-authoring-cloud.js';
import {RecipeCreatorSupervisor,type CreatorSourceLease} from './recipe-creator-supervisor.js';
import {RecipeCreatorExecutor} from './recipe-creator.js';
import {RecipeCreatorJournal} from './recipe-creator-journal.js';
import {MetadataJournal} from './community-metadata-journal.js';
import {RecipeJournal} from './recipe-use-journal.js';
import {RecipeUseError, changed} from './recipe-use-cloud.js';
import type { NativeAccount } from './account-session.js';
import { RegistryError } from './device-registry.js';
import { allowedExternalUrl, type ExternalUrlKind } from '../../ui/src/url-actions.js';
import { ServiceActionError } from './service-error.js';
import { StartHostRefusal } from './daemon-manager.js';
import { DesktopUpdateError } from './updates.js';
import {
  desktopChannels, desktopShellRequestSchema, safeErrorCode, viewArgumentSchema, type AttachedDaemon, type DesktopBridge, type DesktopEvent,
  type DesktopResources, type IpcResult, type SafeFailure, type ShellActions,
} from './ipc-contract.js';

const externalKinds: readonly ExternalUrlKind[] = [
  'registration', 'authorization', 'verification', 'event-settings', 'app-console', 'group', 'bot-chat', 'releases', 'download', 'tailscale',
];

export async function openAllowedExternal(raw: unknown): Promise<void> {
  let url: string | null | undefined;
  // Plain URL calls retain the official allowlist. Arbitrary web documents require an explicit purpose.
  if (typeof raw === 'string') url = externalKinds.map(kind => allowedExternalUrl(raw, kind)).find(value => value !== null);
  else if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 2 &&
      'kind' in raw && raw.kind === 'recipe-document' && 'url' in raw && typeof raw.url === 'string') {
    url = allowedExternalUrl(raw.url, 'recipe-document');
  }
  if (!url) throw new Error('Unsupported external link');
  await shell.openExternal(url);
}

/** The web UI shows daemon messages unabridged; the desktop caps them at this many characters. */
const daemonMessageLimit = 300;
/** The patterns below backtrack, so their cost grows with the square of the length; only this much is scanned. */
const daemonMessageScanLimit = 2000;

/** A key that names a secret, as in `app_secret`, `access_token`, `password`, `Authorization` or `api_key`. */
const secretKey = String.raw`((?:secret|token|password|passwd|credential|authorization|api[_-]?key)[\w-]{0,64})`;
/** The auth scheme that may come before the value, as in `Authorization: Bearer …`. */
const authScheme = String.raw`(?:(?:bearer|basic)\s+)?`;
/** A value that looks like a credential rather than a word: 8+ characters with a letter and a digit, or 16+. */
const credential = String.raw`(?:(?=[\w.~+/=-]*[a-z])(?=[\w.~+/=-]*\d)[\w.~+/=-]{8,}|[\w.~+/=-]{16,})`;
/** A quoted value goes up to the quote that opened it, spaces, commas, the other quote and escapes included;
 * without one, to the end of the scanned text. */
const quotedSecret = new RegExp(String.raw`${secretKey}(["']?\s*[:=]\s*)(["'])(?:\\.|(?!\3)[^\r\n\\])*`, 'gi');
/** `key=value`, or a quoted key or value as in JSON and inspected objects: the value is always the secret. */
const assignedSecret = new RegExp(String.raw`${secretKey}(["']?\s*=\s*["']?|["']\s*:\s*["']?|\s*:\s*["'])${authScheme}[^\s"',;&)}\]]+`, 'gi');
/** An unquoted `Authorization:` or `authorization=` value is a credential under any scheme (Token, Digest, …), so
 * the rest of the text goes, up to 256 characters. A quoted one was already cut at its closing quote by {@link quotedSecret}. */
const authorizationValue = /\b(authorization)(["']?\s*[:=]\s*)(?![\s"'])[^\r\n]{1,256}/gi;
/** Unquoted `key: value` is also prose ("Invalid token: expired"), so only a credential-shaped value goes. */
const labelledSecret = new RegExp(String.raw`${secretKey}(\s*:\s*)${authScheme}${credential}`, 'gi');
/** Any 8+ character word after Bearer goes: "Bearer authentication failed" loses a word, a short token does not leak. */
const bareBearer = /\b(bearer)\s+[\w.~+/=-]{8,}/gi;
/** `Basic` and base64 or base64url: a credential has a digit, a symbol or padding, or a capital after its first
 * letter. "Basic settings", "Basic Settings" and "Basic HTTP" stay. */
const bareBasic = /\b(basic)\s+([\w+/-]{4,}={0,2})/gi;
function maskBasic(match: string, scheme: string, value: string): string {
  return /[\d=+/_-]/.test(value) || /[a-z]/.test(value) && /[A-Z]/.test(value.slice(1)) ? `${scheme} …` : match;
}

/**
 * Daemon RPC errors are the user-facing texts the web UI already shows, so the desktop shows them too, as one
 * plain line: no control or format characters, no URL credentials, query strings or fragments, no bearer
 * tokens, `secret=…`-style values, Feishu access tokens or `sk-` API keys, and at most
 * {@link daemonMessageLimit} characters. File paths stay: the web UI shows them too, and they say what failed.
 */
export function sanitizeDaemonMessage(raw: string): string {
  // Cut before matching. The word the cut lands in goes too: half a secret would slip past the patterns.
  const head = raw.length > 2 * daemonMessageScanLimit ? raw.slice(0, 2 * daemonMessageScanLimit) : raw;
  const points = Array.from(head);
  const cut = head !== raw || points.length > daemonMessageScanLimit;
  const scanned = cut ? points.slice(0, daemonMessageScanLimit).join('').replace(/\S+$/, '') : raw;
  const text = scanned
    .replace(/\p{Cf}/gu, '')
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .replace(/\b([a-z][a-z\d+.-]{0,31}:\/\/)[^\s/?#@]*@/gi, '$1')
    .replace(/\b([a-z][a-z\d+.-]{0,31}:\/\/[^\s?#]*)[?#]\S*/gi, '$1')
    .replace(quotedSecret, '$1$2$3…')
    .replace(authorizationValue, '$1$2…')
    .replace(assignedSecret, '$1$2…')
    .replace(labelledSecret, '$1$2…')
    .replace(bareBearer, '$1 …')
    .replace(bareBasic, maskBasic)
    .replace(/\b[tua]-[A-Za-z0-9]{24,}\b/g, '…')
    .replace(/\bsk-[\w-]{16,}/g, '…')
    .replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  if (chars.length === 0) return '后台请求失败，请重试。';
  if (!cut && chars.length <= daemonMessageLimit) return text;
  return `${chars.slice(0, daemonMessageLimit - 1).join('')}…`;
}

/** A request for the device the page shows while it has no connection (devices-ui-1a 4.5). */
export class DeviceUnavailable extends Error {
  constructor(name: string) { super(`还没连上「${name}」。`); this.name = 'DeviceUnavailable'; }
}
/** A request from a page of the device shown before the last switch: never sent to the one shown now. */
export class DeviceSwitched extends Error {
  constructor() { super('已经切到另一台设备，这次操作没有发出。'); this.name = 'DeviceSwitched'; }
}
/** What only this computer's shell may do, refused while another device is shown, or always from the page. */
export class LocalOnlyRefusal extends Error {
  constructor(message: string, readonly code: string = 'local_only') { super(message); this.name = 'LocalOnlyRefusal'; }
}
const deviceErrorText: Record<string, string> = {
  disposed: 'Vonvon Bot 正在退出。',
  unknown_device: '设备列表里没有这台设备。',
  local_device: '这台电脑不能在这里删除或改名。',
  invalid_name: '名字要 1 到 40 个字。',
  registry_newer: '设备列表是更新版本的 Vonvon Bot 写的，这个版本只能看、不能改。先更新这台电脑上的应用。',
  registry_unreadable: '读不了设备列表文件，暂时不能修改。看一下 Vonvon Bot 的数据目录权限。',
};

function safeFailure(error: unknown): SafeFailure {
  if (error instanceof RpcError) {
    const code = safeErrorCode(error.code);
    return { kind: 'rpc', message: sanitizeDaemonMessage(error.message), ...(code ? { code } : {}) };
  }
  if (error instanceof CommunityError) return {kind: 'validation', message: error.message, code: error.code, ...(error.retryAfter ? {retryAfter: error.retryAfter} : {})};
  if (error instanceof AuthoringError || error instanceof RecipeUseError) return {kind: 'validation', message: error.message};
  if (error instanceof ConnectionError) return { kind: 'connection', message: '和后台的连接断开了。' };
  if (error instanceof DeviceUnavailable) return { kind: 'connection', code: 'device_unavailable', message: error.message };
  if (error instanceof DeviceSwitched) return { kind: 'connection', code: 'device_switched', message: error.message };
  if (error instanceof LocalOnlyRefusal) return { kind: 'validation', code: error.code, message: error.message };
  if (error instanceof DeviceConnectionsError || error instanceof RegistryError) {
    const message = deviceErrorText[error.code];
    if (message) return { kind: 'validation', code: error.code, message };
  }
  if (error instanceof ServiceActionError) return { kind: 'validation', message: sanitizeDaemonMessage(error.safeMessage) };
  if (error instanceof StartHostRefusal || error instanceof DesktopUpdateError) return { kind: 'validation', message: error.message };
  return { kind: 'validation', message: '桌面端操作没有成功，请重试。' };
}

function failure(error: unknown): IpcResult<never> {
  return { ok: false, error: safeFailure(error) };
}

type MachineStatus = Extract<MachineReply, { type: 'status' }>;
/** The stopped view has no daemon, running service or temporary Bot. */
function stoppedView(before: MachineStatus): MachineStatus {
  const { temporaryAgent: _stopped, ...rest } = before;
  const state = before.service.state === 'running' || before.service.state === 'detached' ? 'stopped' : before.service.state;
  return { ...rest, host: null, service: { ...before.service, running: false, pid: undefined, ...(state ? { state } : {}) } };
}

/** What the page is shown: this computer, a remote device's connection, or a remote device with no connection right now. */
type View = { kind: 'local' } | { kind: 'remote'; session: ViewSession } | { kind: 'waiting'; id: string };
type Binding = {
  dispose(): void;
  connectionFailure(): ConnectionError | undefined;
  activate(initial: DesktopSnapshot): void;
};
/** The login-time switch of a remote device, which the remote page sends through `machine` (U2 4.4.3). */
const remoteServiceToggle = (value: unknown): boolean => {
  const parsed = desktopShellRequestSchema.safeParse(value);
  return parsed.success && parsed.data.type === 'service' && (parsed.data.action === 'install' || parsed.data.action === 'uninstall');
};

export function installBridge(
  owner: AttachedDaemon, window: BrowserWindow, paths: DesktopResources, actions: ShellActions, devices: DeviceConnections, account: NativeAccount, recipeJournalPath?:string, authoringJournalPath?:string, recipePreview = new RecipePreviewNavigation('vonvon'),
): DesktopBridge {
  const expectedUrl = pathToFileURL(realpathSync(paths.uiIndex)).href;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let subscribed = false;
  let pendingQuit = false;
  let retainedUpdate: DesktopUpdate | undefined;
  let retainedRemoteUpdate: string | undefined;
  let connectionLost = false;
  /** This computer's connection, whichever device the page shows. */
  let localDaemon: AttachedDaemon | null = owner;
  let replacing: Promise<void> | undefined;
  let candidate: AttachedDaemon | null = null;
  let stoppedStatus: MachineStatus | undefined;
  let lastStatus: MachineStatus | undefined;
  const retainedErrors: SafeFailure[] = [];
  let view: View = { kind: 'local' };
  /** The local connection's own subscriptions (losses, device events): follow `localDaemon`, not the view. */
  let localWatch: (() => void) | null = null;
  /** The binding of what the page is shown, or none. */
  let viewBinding: Binding | null = null;
  /** Bumped by every view change and every local replacement: an await that sees another value is stale. */
  let viewSeq = 0;
  let localGen = 0;
  let localSourceOwner=new AbortController();
  /** The local connection was lost while a remote device was shown: reported once the page is back here. */
  let localLostPending = false;
  /** `localDaemon` closed, whoever handles it (an expected stop, the shell reconnecting): it answers nothing now. */
  let localDead = false;
  /** The first snapshot a switch to a remote device waits for: the new page's own first request shares it, not another
   * one of hundreds of KB over a slow link (0.9.0 Mac 验收 B-1). */
  let firstSnapshot: { session: ViewSession; value: Promise<DesktopSnapshot> } | undefined;
  /** The last snapshot of this computer's connection. A page built again for this computer while its daemon is stopped
   * or lost gets it, as the one page kept it before devices, with 启动 daemon still there (Codex 审查 235-1). */
  let localSnapshot: DesktopSnapshot | undefined;
  const localOwnerListeners = new Set<(owner: AttachedDaemon) => void>();

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

  function publishUpdate(update: DesktopUpdate): void {
    if (disposed) return;
    retainedUpdate = update;
    send({ type: 'update', value: update });
  }

  async function updateResult(action: () => Promise<DesktopUpdate>): Promise<DesktopUpdate> {
    const update = await action();
    // Manual downloads must replace the automatic check's retained `available`.
    // Otherwise a reloaded window may offer "download" for an already downloaded update.
    publishUpdate(update);
    return update;
  }

  function retain(error: SafeFailure): void {
    retainedErrors.push(error);
    if (retainedErrors.length > 32) retainedErrors.shift();
  }
  function report(error: Error): void {
    const safe = safeFailure(error);
    if (!subscribed || !currentDocument()) retain(safe);
    else send({ type: 'error', value: safe });
  }
  function lost(): void {
    if (connectionLost) return;
    connectionLost = true;
    actions.connectionLost();
  }

  /** devices-ui-1a 4.5 `localLost`: the shell owns reattachment and reports a drop it cannot recover; while a remote
   * device is shown, only once the page is back here. */
  function localLost(error: ConnectionError, from: AttachedDaemon): void {
    if (disposed || from !== localDaemon) return;
    // A page built again for this computer gets the last snapshot from here on, also while the shell reconnects: asking
    // the closed connection left it loading with 启动 daemon out of reach (0.9.0 Mac 验收 S-4).
    localDead = true;
    localSourceOwner.abort();
    if (actions.isExpectedDisconnect()) return;
    if (actions.recoverConnection(from.identity)) { devices.setLocal({ status: 'connecting' }); return; }
    devices.setLocal({ status: 'offline' });
    if (view.kind !== 'local') { localLostPending = true; return; }
    report(error);
    lost();
  }
  function watchLocal(current: AttachedDaemon): () => void {
    const offError = current.client.onError(error => { if (error instanceof ConnectionError) localLost(error, current); });
    const offDevice = current.client.onDevice(value => send({ type: 'localDevice', value }));
    return () => { offError(); offDevice(); };
  }

  /** Stopped here, lost, or between two connections: nothing to ask for a snapshot. */
  function localDown(): boolean {
    return !localDaemon || localDead || stoppedStatus !== undefined || connectionLost || localLostPending;
  }

  function viewId(): ViewId {
    return view.kind === 'local' ? LOCAL_VIEW : view.kind === 'remote' ? view.session.id : view.id;
  }
  function deviceName(id: string): string {
    return devices.state().devices.find(device => device.id === id)?.name ?? '另一台设备';
  }
  function client(): VonvonClient {
    if (view.kind === 'remote') return view.session.client;
    if (view.kind === 'waiting') throw new DeviceUnavailable(deviceName(view.id));
    if (!localDaemon) throw new Error('Daemon connection unavailable');
    return localDaemon.client;
  }
  function localOnly(): void {
    if (view.kind !== 'local') throw new LocalOnlyRefusal(`现在看的是「${deviceName(viewId())}」，这个操作只对这台电脑有效。先切回这台电脑。`);
  }

  /** A login-item switch changed the service: machine `status` reads it again, and the daemon pushes the new snapshot. */
  async function refreshService(): Promise<void> {
    await localDaemon?.client.machine({ type: 'status' }).catch(() => {});
  }

  /** The page's subscriptions to `target`. Sends only while it is the view's binding and not paused, so one replaced or
   * stale sends nothing even before its listeners are gone. */
  function bind(target: { view: ViewId; client: VonvonClient }, paused = false): Binding {
    let latest: DesktopSnapshot | undefined;
    let revision = -1;
    let bound = true;
    let connectionFailure: ConnectionError | undefined;
    const removers: (() => void)[] = [];
    const live = (): boolean => bound && !paused && viewBinding === binding;
    const binding: Binding = {
      dispose() { if (!bound) return; bound = false; latest = undefined; for (const off of removers) off(); },
      connectionFailure: () => connectionFailure,
      activate(initial) {
        const value = latest && latest.revision >= initial.revision ? latest : initial;
        latest = undefined;
        revision = value.revision;
        paused = false;
        if (target.view === LOCAL_VIEW) localSnapshot = value;
        send({ type: 'snapshot', view: target.view, value });
      },
    };
    try {
      removers.push(target.client.watchSnapshots(value => {
        if (!bound || value.revision < revision) return;
        revision = value.revision;
        if (target.view === LOCAL_VIEW) localSnapshot = value;
        // A paused binding is the candidate of a replacement or a switch: it keeps the newest until activated.
        if (paused) latest = value;
        else if (viewBinding === binding) send({ type: 'snapshot', view: target.view, value });
      }));
      removers.push(target.client.onLog(value => { if (live()) send({ type: 'log', view: target.view, value }); }));
      removers.push(target.client.onBackendInstall(value => { if (live()) send({ type: 'backendInstall', view: target.view, value }); }));
      removers.push(target.client.onDevice(value => { if (live()) send({ type: 'device', view: target.view, value }); }));
      // Lost connections are not the page's: the local one is watchLocal's, a remote one the connections'.
      removers.push(target.client.onError(error => {
        if (error instanceof ConnectionError) { if (paused) connectionFailure = error; return; }
        if (live()) report(error);
      }));
    } catch (error) { binding.dispose(); throw error; }
    return binding;
  }

  /** devices-ui-1a 4.5 `onView`: after each await, only the latest change goes on. */
  async function onView(change: ViewChange): Promise<void> {
    if (disposed) return;
    const seq = ++viewSeq;
    viewBinding?.dispose();
    viewBinding = null;
    if (change.kind === 'waiting') { view = { kind: 'waiting', id: change.id }; return; }
    if (change.kind === 'local') {
      view = { kind: 'local' };
      // The replacement in flight binds its connection itself once it sees this view.
      if (replacing) return;
      const current = localDaemon;
      // Stopped, or lost while another device was shown: the connection is still set but dead. The page gets the last
      // snapshot to stand on; a loss is reported now, as here.
      if (!current || localDown()) {
        send({ type: 'reattached', view: LOCAL_VIEW });
        if (localSnapshot) send({ type: 'snapshot', view: LOCAL_VIEW, value: localSnapshot });
        if (localLostPending) { localLostPending = false; lost(); }
        return;
      }
      const myLocalGen = localGen;
      const binding = bind({ view: LOCAL_VIEW, client: current.client }, true);
      viewBinding = binding;
      let initial: DesktopSnapshot;
      try { initial = await current.client.snapshot(); }
      catch { binding.dispose(); if (viewBinding === binding) viewBinding = null; return; }
      if (disposed || seq !== viewSeq || myLocalGen !== localGen) { binding.dispose(); return; }
      send({ type: 'reattached', view: LOCAL_VIEW });
      binding.activate(initial);
      return;
    }
    const { session } = change;
    view = { kind: 'remote', session };
    // A device of another protocol pushes no snapshots and answers no snapshot request.
    if (session.mode === 'maintenance') { send({ type: 'reattached', view: session.id }); return; }
    // Asked before the binding's watch asks as well: the page shows once the first of the two has come.
    const first = session.client.snapshot();
    firstSnapshot = { session, value: first };
    const settled = (): void => { if (firstSnapshot?.value === first) firstSnapshot = undefined; };
    let binding: Binding;
    try { binding = bind({ view: session.id, client: session.client }, true); }
    catch { void first.catch(() => {}).finally(settled); return; }
    viewBinding = binding;
    let initial: DesktopSnapshot;
    // Lost again right away: the connections say waiting next.
    try { initial = await first; }
    catch { binding.dispose(); if (viewBinding === binding) viewBinding = null; return; }
    finally { settled(); }
    if (disposed || seq !== viewSeq) { binding.dispose(); return; }
    send({ type: 'reattached', view: session.id });
    binding.activate(initial);
  }

  if (devices.view().kind === 'local') {
    viewBinding = bind({ view: LOCAL_VIEW, client: owner.client });
  } else void onView(devices.view());
  try { localWatch = watchLocal(owner); }
  catch (error) { viewBinding?.dispose(); throw error; }
  const registeredChannels: string[] = [];
  const unsubscribers: (() => void)[] = [];

  function register<T>(channel: string, arity: number, parse: (...values: unknown[]) => T,
    invoke: (value: T) => Promise<unknown>): void {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      if (!authorized(event)) return { ok: false, error: { kind: 'validation', message: 'Unauthorized desktop request' } };
      if (args.length !== arity) return { ok: false, error: { kind: 'validation', message: 'Invalid desktop request' } };
      try { return { ok: true, value: await invoke(parse(...args)) }; }
      catch (error) { return failure(error); }
    });
    registeredChannels.push(channel);
  }
  /** A channel to a daemon: one more argument, the page's device; a page of another device than the one shown now is
   * answered `device_switched` and nothing is sent (devices-ui-1a 4.6). */
  function registerClient<T>(channel: string, arity: number, parse: (...values: unknown[]) => T,
    invoke: (value: T) => Promise<unknown>): void {
    register(channel, arity + 1, (...values) => {
      const target = viewArgumentSchema.parse(values[arity]);
      if (target !== 'current' && target !== viewId()) throw new DeviceSwitched();
      return parse(...values.slice(0, arity));
    }, invoke);
  }

  const captureRecipeDevice = (id:string): RecipeDeviceLease => {
    if(id!==viewId() || view.kind==='waiting' || view.kind==='remote' && view.session.mode!=='full' || view.kind==='local' && localDown()) throw changed();
    const selected=view, seq=viewSeq, gen=localGen, connection=client(), pairedKey=selected.kind==='remote' ? devices.pairedPublicKey?.(id) : undefined;
    return {viewId:id,client:connection,pairedKey,check() {
      if(disposed || selected!==view || seq!==viewSeq || gen!==localGen || client()!==connection ||
        (selected.kind==='remote' && (!pairedKey || devices.pairedPublicKey?.(id)!==pairedKey)) ||
        (selected.kind==='local' && localDown())) throw changed();
    }};
  };
  const metadataJournal = new MetadataJournal(recipeJournalPath && recipeJournalPath+'.metadata');
  const recipes = new RecipeUseController(account, captureRecipeDevice, new RecipeJournal(recipeJournalPath));
  const authoringJournal=new AuthoringJournal(authoringJournalPath);
  const authoring = new RecipeAuthoringController(account, captureRecipeDevice, authoringJournal, value => send({type:'authoringSaved',value}));
  const creatorJournal=new RecipeCreatorJournal(authoringJournalPath&&authoringJournalPath+'.creator');
  const retainCreatorSource=async(id:string,signal:AbortSignal):Promise<CreatorSourceLease>=>{
    if(id!==LOCAL_VIEW){
      const source=await devices.retainSource(id,{signal});
      try {
        source.check();const pairedKey=devices.pairedPublicKey?.(id);if(!pairedKey)throw changed();
        return {viewId:id,client:source.client,pairedKey,signal:source.signal,check:()=>{source.check();if(devices.pairedPublicKey?.(id)!==pairedKey)throw changed();},release:()=>source.release()};
      }catch(error){source.release();throw error;}
    }
    if(localDown()||!localDaemon)throw changed();
    const current=localDaemon,generation=localGen,reference=new AbortController();
    const active=AbortSignal.any([signal,localSourceOwner.signal,reference.signal]);
    return {viewId:LOCAL_VIEW,client:current.client,signal:active,release:()=>reference.abort(),check:()=>{
      if(disposed||active.aborted||localDaemon!==current||generation!==localGen||localDown())throw changed();
    }};
  };
  const creator=new RecipeCreatorSupervisor(account,retainCreatorSource,()=>devices.state().devices.map(row=>row.id),creatorJournal,authoringJournal,authoring,
    new RecipeCreatorExecutor(account,creatorJournal,metadataJournal,authoringJournal,
      value=>send({type:'authoringPublished',value}),value=>send({type:'authoringSaved',value})));
  const noArg = (_: unknown): undefined => undefined;
  const onNavigation = (event: Electron.WebContentsDidStartNavigationEventParams): void => {
    if (!event.isMainFrame || event.isSameDocument) return;
    subscribed = false;
    if (event.url !== expectedUrl) authoring.closeRenderer();
  };
  try {
    registerClient(desktopChannels.snapshot, 0, noArg, () => {
      if (view.kind === 'local' && localDown() && localSnapshot) return Promise.resolve(localSnapshot);
      if (view.kind === 'remote' && firstSnapshot?.session === view.session) return firstSnapshot.value;
      return client().snapshot();
    });
    registerClient(desktopChannels.run, 1, value => commandSchema.parse(value), value => {
      if (value.type !== 'restartHost') return client().run(value);
      if (view.kind !== 'local') {
        // A remote restart is followed by its disconnect, not by this computer's pid lock.
        const remote = client();
        devices.expect('restart');
        return remote.run(value);
      }
      const current = localDaemon;
      if (!current) return client().run(value);
      return actions.restartHost(current.identity, () => current.client.run(value));
    });
    registerClient(desktopChannels.settings, 1, value => settingsRequestSchema.parse(value), value => client().settings(value));
    registerClient(desktopChannels.collaboration, 1, value => collaborationRequestSchema.parse(value), value => client().collaboration(value));
    registerClient(desktopChannels.environment, 1, value => environmentRequestSchema.parse(value), value => client().environment(value));
    registerClient(desktopChannels.machine, 1, value => {
      // The shell's own actions never reach a daemon; a remote device's login-time switch is that device's own.
      if (desktopShellRequestSchema.safeParse(value).success && !(view.kind !== 'local' && remoteServiceToggle(value))) throw new Error('Shell-owned machine action');
      return machineRequestSchema.parse(value);
    }, async value => {
      if (view.kind !== 'local') {
        const remote = client();
        // The daemon answers, then the helper replaces it: a restart, not a lost device.
        if (value.type === 'service') devices.expect('restart');
        if (value.type === 'stopHost') devices.expect('stop');
        return remote.machine(value);
      }
      if (value.type === 'service') throw new Error('Shell-owned machine action');
      if (value.type === 'stopHost' && localDaemon) {
        const current = localDaemon;
        // Preserve the last readable machine status when the pre-stop status request fails.
        const read = await current.client.machine({ type: 'status' }).catch(() => undefined);
        const before = read?.type === 'status' ? read : lastStatus;
        const reply = await actions.stopHost(current.identity, () => current.client.machine(value));
        // A replacement connected while stopping must keep its own status.
        if (before && localDaemon === current) {
          stoppedStatus = stoppedView(before);
          devices.setLocal({ status: 'offline' });
        }
        return reply;
      }
      const reply = value.type === 'status' && stoppedStatus ? stoppedStatus : await client().machine(value);
      if (reply.type === 'status' && reply !== stoppedStatus) lastStatus = reply;
      return value.type === 'status' && reply.type === 'status'
        ? { ...reply, cli: await actions.observeCli() } : reply;
    });
    registerClient(desktopChannels.admin, 1, value => {
      const request = adminRequestSchema.parse(value);
      // One negotiate per connection, and the desktop makes it on its own (U4's capability): never the page's.
      if (request.type === 'negotiate') throw new LocalOnlyRefusal('能力由桌面端自己声明。', 'shell_owned');
      return request;
    }, value => client().admin(value));
    registerClient(desktopChannels.memory, 1, value => memoryRequestSchema.parse(value), value => client().memory(value));
    registerClient(desktopChannels.contextPreview, 1, value => contextPreviewRequestSchema.parse(value), value => client().contextPreview(value));
    registerClient(desktopChannels.directory, 1, value => directoryRequestSchema.parse(value), value => client().directory(value));
    registerClient(desktopChannels.library, 1, value => libraryRequestSchema.parse(value), value => client().library(value));
    registerClient(desktopChannels.schedule, 2, (botId, request) => ({ botId: agentIdSchema.parse(botId), request: scheduleRequestSchema.parse(request) }),
      value => client().schedule(value.botId, value.request));
    registerClient(desktopChannels.device, 1, value => deviceRequestSchema.parse(value), value => client().device(value));
    // Never this computer's connection from a remote view.
    registerClient(desktopChannels.close, 0, noArg, () => view.kind === 'local' ? localDaemon?.dispose() ?? Promise.resolve() : Promise.resolve());
    register(desktopChannels.external, 1, value => value, openAllowedExternal);
    register(desktopChannels.startHost, 1, value => {
      localOnly();
      const request = desktopShellRequestSchema.parse(value);
      if (request.type !== 'startHost') throw new Error('Invalid start request');
      return request;
    }, async value => {
      devices.setLocal({ status: 'connecting' });
      try { return machineReplySchema.parse(await actions.startHost(value.bot)); }
      catch (error) { devices.setLocal({ status: localDown() ? 'offline' : 'online' }); throw error; }
    });
    register(desktopChannels.service, 1, value => {
      localOnly();
      const request = desktopShellRequestSchema.parse(value);
      if (request.type !== 'service') throw new Error('Invalid service request');
      return request.action;
    }, async value => {
      const before = value === 'stop' ? stoppedStatus ?? await client().machine({ type: 'status' }) : undefined;
      if (before && before.type !== 'status') throw new Error('Cannot read service status');
      const switchesLoginItem = value === 'install' || value === 'uninstall';
      let reply: MachineReply;
      try { reply = machineReplySchema.parse(await actions.service(value, localDaemon?.identity ?? null)); }
      finally { if (switchesLoginItem) await refreshService(); }
      if (value === 'stop' && before?.type === 'status') {
        stoppedStatus = stoppedView(before);
        devices.setLocal({ status: 'offline' });
      }
      return reply;
    });
    register(desktopChannels.setLoginItem, 1, value => {
      localOnly();
      if (typeof value !== 'boolean') throw new Error('Invalid login item request');
      return value;
    }, async value => {
      // A failed switch may still have changed the service, so the state is read again either way.
      try { await actions.setLoginItem(value, localDaemon?.identity ?? null); }
      finally { await refreshService(); }
    });
    register(desktopChannels.repairCli, 0, () => { localOnly(); },
      () => actions.repairCli().then(reply => machineReplySchema.parse(reply)));
    register(desktopChannels.chooseExecutablePath, 0, () => { localOnly(); }, () => actions.chooseExecutablePath());
    register(desktopChannels.chooseDirectoryPaths, 1, value => {
      localOnly();
      if (typeof value !== 'boolean') throw new Error('Invalid directory request');
      return value;
    }, value => actions.chooseDirectoryPaths(value));
    register(desktopChannels.checkDesktopUpdate, 0, noArg, () => updateResult(() => actions.checkDesktopUpdate()));
    register(desktopChannels.retryDesktopUpdate, 0, noArg, () => updateResult(() => actions.retryDesktopUpdate()));
    register(desktopChannels.installDesktopUpdate, 0, noArg, () => updateResult(() => actions.installDesktopUpdate()));
    register(desktopChannels.hide, 0, noArg, async () => { actions.hide(); });
    register(desktopChannels.quit, 0, noArg, () => actions.confirmQuit());
    register(desktopChannels.quitKeepsDaemon, 0, () => { localOnly(); }, () => actions.quitKeepsDaemon());
    register(desktopChannels.recipeSource,1,value=>desktopRecipeSourceRequestSchema.parse(value),value=>recipes.source(value));
    register(desktopChannels.recipeAuthoring, 1, value => desktopAuthoringRequestSchema.parse(value), async value => {
      if(value.type==='creatorContinue')return creator.continue(value);
      const reply=await authoring.request(value);
      if(value.type==='confirmLink'&&reply.kind==='link'&&reply.linked){
        const status=await authoring.request({type:'status',handle:value.handle});
        if(status.kind==='session')void creator.associated(status.target.accountId,status.target.viewId,status.target.botId).catch(()=>{});
      }
      return reply;
    });
    register(desktopChannels.recipeUse,1,value=>recipeUseRequestSchema.parse(value),value=>recipes.request(value));
    register(desktopChannels.recipePreviewPending, 0, noArg, async () => recipePreview.pending());
    register(desktopChannels.recipePreviewAcknowledge, 1, value => draftPreviewNavigationIdSchema.parse(value), async value => recipePreview.acknowledge(value));
    register(desktopChannels.community, 1, value => communityRequestSchema.parse(value), value => communityRequest(account, value, metadataJournal));
    register(desktopChannels.accountStatus, 0, noArg, async () => accountStatusSchema.parse(account.status()));
    register(desktopChannels.accountLogin, 0, noArg, async () => accountStatusSchema.parse(await account.login()));
    register(desktopChannels.accountCancel, 0, noArg, async () => accountStatusSchema.parse(await account.cancelLogin()));
    register(desktopChannels.accountLogout, 0, noArg, async () => accountStatusSchema.parse(await account.logout()));
    register(desktopChannels.devicesState, 0, noArg, async () => devices.state());
    register(desktopChannels.devicesInspect, 1, value => {
      if (typeof value !== 'string' || value.length > 65_536) throw new Error('Invalid link');
      return value;
    }, async value => devices.inspectLink(value));
    register(desktopChannels.devicesAdd, 1, value => addDeviceRequestSchema.parse(value), value => devices.add(value));
    register(desktopChannels.devicesCancelAdd, 0, noArg, async () => { devices.cancelAdd(); });
    register(desktopChannels.devicesRename, 2, (id, name) => {
      if (typeof name !== 'string') throw new Error('Invalid name');
      return { id: viewIdSchema.parse(id), name };
    }, value => devices.rename(value.id, value.name));
    register(desktopChannels.devicesRemove, 1, value => viewIdSchema.parse(value), value => devices.remove(value));
    register(desktopChannels.devicesSwitch, 1, value => viewIdSchema.parse(value), value => devices.switchTo(value));
    register(desktopChannels.devicesRetry, 0, noArg, async () => { devices.retry(); });
    ipcMain.handle(desktopChannels.subscribe, async (event, ...args): Promise<IpcResult<void>> => {
      if (!authorized(event)) return { ok: false, error: { kind: 'validation', message: 'Unauthorized desktop request' } };
      if (args.length !== 0) return { ok: false, error: { kind: 'validation', message: 'Invalid desktop request' } };
      subscribed = true;
      for (const value of retainedErrors.splice(0)) send({ type: 'error', value });
      if (retainedUpdate) send({ type: 'update', value: retainedUpdate });
      if (retainedRemoteUpdate !== undefined) send({ type: 'remoteUpdate', text: retainedRemoteUpdate });
      if (pendingQuit) { pendingQuit = false; send({ type: 'quitRequested' }); }
      send({ type: 'account', value: accountStatusSchema.parse(account.status()) });
      send({ type: 'devices', value: devices.state() });
      return { ok: true, value: undefined };
    });
    registeredChannels.push(desktopChannels.subscribe);
    unsubscribers.push(recipePreview.onOpen(value => send({type: 'recipePreview', value})));
    unsubscribers.push(account.onStatus(value => send({ type: 'account', value: accountStatusSchema.parse(value) })));
    unsubscribers.push(devices.onState(value => send({ type: 'devices', value })));
    unsubscribers.push(devices.onView(change => { void onView(change); authoring.invalidateStale(); }));
    window.webContents.on('did-start-navigation', onNavigation);
  } catch (error) {
    creator.dispose();authoring.closeAll();
    window.webContents.removeListener('did-start-navigation', onNavigation);
    for (const channel of registeredChannels) ipcMain.removeHandler(channel);
    for (const off of unsubscribers) off();
    viewBinding?.dispose();
    localWatch?.();
    throw error;
  }

  return {
    replaceOwner(next) {
      if (disposed || replacing) {
        void next.dispose().catch(() => {});
        return Promise.reject(new Error('Desktop connection is unavailable'));
      }
      candidate = next;
      replacing = (async () => {
        localGen++;
        localSourceOwner.abort();localSourceOwner=new AbortController();
        authoring.invalidateStale();
        localWatch?.();
        localWatch = null;
        // A remote view's binding is not this connection's.
        if (view.kind === 'local') { viewBinding?.dispose(); viewBinding = null; }
        const previous = localDaemon;
        localDaemon = null;
        try { await previous?.dispose(); }
        catch (error) { await next.dispose(); throw error; }
        if (disposed) { await next.dispose(); throw new Error('Desktop connection is unavailable'); }
        let initial: DesktopSnapshot;
        let nextBinding: Binding | undefined;
        try {
          nextBinding = bind({ view: LOCAL_VIEW, client: next.client }, true);
          initial = await next.client.snapshot();
          const lostAlready = nextBinding.connectionFailure();
          if (lostAlready) throw lostAlready;
          if (disposed) throw new Error('Desktop connection is unavailable');
        } catch (error) {
          nextBinding?.dispose();
          await next.dispose();
          throw nextBinding?.connectionFailure() ?? error;
        }
        localDaemon = next;
        localWatch = watchLocal(next);
        localDead = false;
        stoppedStatus = undefined;
        connectionLost = false;
        localLostPending = false;
        devices.setLocal({ status: 'online', serverInfo: next.serverInfo });
        // Whichever device is shown: U4 declares its capability again on every new local connection.
        for (const listener of localOwnerListeners) {
          try { listener(next); } catch { /* one listener does not stop the others or the replacement */ }
        }
        // Decided by the view now, after the awaits: a remote view keeps its page and binds this later, when shown.
        if (view.kind === 'local') {
          viewBinding = nextBinding;
          send({ type: 'reattached', view: LOCAL_VIEW });
          nextBinding.activate(initial);
        } else nextBinding.dispose();
      })().finally(() => { replacing = undefined; candidate = null; });
      return replacing;
    },
    localOwner: () => localDaemon,
    onLocalOwner(listener) {
      localOwnerListeners.add(listener);
      return () => { localOwnerListeners.delete(listener); };
    },
    deferLocalLost() {
      // The shell gave up reconnecting: 这台电脑 was "connecting" until now.
      devices.setLocal({ status: 'offline' });
      if (view.kind === 'local') return false;
      localLostPending = true;
      return true;
    },
    viewId,
    publishUpdate,
    sendRemoteUpdate(text) {
      if (disposed) return;
      retainedRemoteUpdate = text;
      send(text === undefined ? { type: 'remoteUpdate' } : { type: 'remoteUpdate', text });
    },
    requestQuit() {
      if (disposed) return;
      if (!subscribed || !currentDocument()) pendingQuit = true;
      else send({ type: 'quitRequested' });
    },
    dispose() {
      disposal ??= (async () => {
        disposed = true;
        creator.dispose();
        localSourceOwner.abort();
        authoring.closeAll();
        subscribed = false;
        for (const off of unsubscribers.splice(0)) off();
        window.webContents.removeListener('did-start-navigation', onNavigation);
        for (const channel of registeredChannels) ipcMain.removeHandler(channel);
        await candidate?.dispose().catch(() => {});
        if (replacing) await replacing.catch(() => {});
        viewBinding?.dispose();
        viewBinding = null;
        localWatch?.();
        localWatch = null;
        await localDaemon?.dispose();
        localDaemon = null;
      })();
      return disposal;
    },
  };
}
