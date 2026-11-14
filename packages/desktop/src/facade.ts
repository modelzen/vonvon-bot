import type { VonvonClient } from '@vonvon/client/browser';
import {
  authoringSavedSchema, type AuthoringSaved, acquisitionFailureSchema, desktopAuthoringRequestSchema, desktopAuthoringReplySchema, desktopRecipeSourceRequestSchema,desktopRecipeSourceReplySchema,recipeUseReplySchema, recipeUseRequestSchema, communityRequestSchema, communityResponseSchemas, type CommunityShell, accountStatusSchema, type AccountStatus, adminReplySchema, backendInstallEventPayloadSchema, collaborationReplySchema,
  commandResultSchema, desktopSnapshotSchema, directoryReplySchema, memoryReplySchema, contextPreviewReplySchema,
  environmentReplySchema, libraryReplySchema, logEventPayloadSchema, machineReplySchema, desktopUpdateSchema, deviceReplySchema,
  scheduleReplySchema, settingsReplySchema, viewIdSchema, devicesStateSchema, deviceEventPayloadSchema, linkPreviewSchema,
  addDeviceResultSchema, removeDeviceResultSchema,
  type BackendInstallEventPayload, type DesktopSnapshot, type DesktopUpdate, type DeviceEventPayload, type DevicesState, type LogEventPayload,
  type ViewId,
} from '@vonvon/protocol';
import type { DevicesShell } from '../../ui/src/client-context.js';
import {
  desktopChannels, safeErrorCode, type DesktopShell, type DesktopShellRequest, type ViewArgument,
} from './ipc-contract.js';

export interface FacadeTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  receive(listener: (event: unknown) => void): () => void;
}

/** A plain Error carrying the daemon's message and code. contextBridge copies only an Error's message into
 * the page, so code in the page sees the (sanitized) message; the code serves the preload side. */
function ordinaryError(message: string, rawCode: unknown): Error {
  const code = safeErrorCode(rawCode);
  return code ? Object.assign(new Error(message), { code }) : new Error(message);
}

function readResult<T>(value: unknown, parse: (value: unknown) => T): T {
  if (!value || typeof value !== 'object' || !('ok' in value)) throw new Error('Invalid desktop response');
  if (value.ok === true && 'value' in value) return parse(value.value);
  if (value.ok === false && 'error' in value && value.error && typeof value.error === 'object' &&
      'kind' in value.error && 'message' in value.error &&
      (value.error.kind === 'rpc' || value.error.kind === 'connection' || value.error.kind === 'validation') &&
      typeof value.error.message === 'string') {
    throw ordinaryError(value.error.message, 'code' in value.error ? value.error.code : undefined);
  }
  throw new Error('Invalid desktop response');
}

function parseVoid(value: unknown): void {
  if (value !== undefined) throw new Error('Invalid desktop response');
}

function parseExecutablePath(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new Error('Invalid desktop response');
}

/** The events a page's client hears: those of its device ('current' hears every device's). */
type ViewEvent =
  | { type: 'reattached'; view: ViewId }
  | { type: 'snapshot'; view: ViewId; value: DesktopSnapshot }
  | { type: 'log'; view: ViewId; value: LogEventPayload }
  | { type: 'backendInstall'; view: ViewId; value: BackendInstallEventPayload }
  | { type: 'device'; view: ViewId; value: DeviceEventPayload };
interface BoundClient { client: VonvonClient; receive(event: ViewEvent): void; error(error: Error): void; closed(): boolean }

function readView(raw: object): ViewId {
  if (!('view' in raw)) throw new Error('Invalid desktop event');
  return viewIdSchema.parse(raw.view);
}
function readValue(raw: object): unknown {
  if (!('value' in raw)) throw new Error('Invalid desktop event');
  return raw.value;
}

export function createDesktopFacades(transport: FacadeTransport): { client: VonvonClient; shell: DesktopShell } {
  const quitListeners = new Set<() => void>();
  const updateListeners = new Set<(value: DesktopUpdate) => void>();
  const accountListeners = new Set<(value: AccountStatus) => void>();
  let latestAccount: AccountStatus | undefined;
  const authoringSavedListeners = new Set<(value:AuthoringSaved) => void>();
  const stateListeners = new Set<(value: DevicesState) => void>();
  const localDeviceListeners = new Set<(value: DeviceEventPayload) => void>();
  const remoteUpdateListeners = new Set<(text: string | undefined) => void>();
  /** U4: the last remote-update line, once one came (a cleared one too, so a late subscriber hears it is gone). */
  let latestRemoteUpdate: { text: string | undefined } | undefined;
  let latestUpdate: DesktopUpdate | undefined;
  let latestDevices: DevicesState | undefined;
  let pendingQuit = false;
  const clients = new Map<ViewArgument, BoundClient>();

  /** Shell listeners have no client of their own: what they throw goes to the current client's errors. */
  function shellFailure(failure: unknown): void {
    clients.get('current')?.error(failure instanceof Error ? failure : new Error(String(failure)));
  }
  function deliverShell<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try { listener(value); }
      catch (failure) { shellFailure(failure); }
    }
  }
  function everyClient(error: Error): void {
    for (const bound of clients.values()) bound.error(error);
  }

  function onEvent(raw: unknown): void {
    try {
      if (!raw || typeof raw !== 'object' || !('type' in raw)) throw new Error('Invalid desktop event');
      switch (raw.type) {
        case 'quitRequested':
          if (quitListeners.size === 0) pendingQuit = true;
          else deliverShell(quitListeners, undefined);
          return;
        case 'reattached': {
          const event: ViewEvent = { type: 'reattached', view: readView(raw) };
          for (const bound of clients.values()) bound.receive(event);
          return;
        }
        case 'snapshot': case 'log': case 'backendInstall': case 'device': {
          const view = readView(raw);
          const value = readValue(raw);
          const event: ViewEvent = raw.type === 'snapshot' ? { type: 'snapshot', view, value: desktopSnapshotSchema.parse(value) }
            : raw.type === 'log' ? { type: 'log', view, value: logEventPayloadSchema.parse(value) }
              : raw.type === 'backendInstall' ? { type: 'backendInstall', view, value: backendInstallEventPayloadSchema.parse(value) }
                : { type: 'device', view, value: deviceEventPayloadSchema.parse(value) };
          for (const bound of clients.values()) bound.receive(event);
          return;
        }
        case 'localDevice':
          deliverShell(localDeviceListeners, deviceEventPayloadSchema.parse(readValue(raw)));
          return;
        case 'account':
          latestAccount = accountStatusSchema.parse(readValue(raw));
          deliverShell(accountListeners, latestAccount);
          return;
        case 'authoringSaved': {
          const receipt = authoringSavedSchema.parse(readValue(raw));
          if (latestAccount?.kind === 'signedIn' && latestAccount.accountId === receipt.accountId) deliverShell(authoringSavedListeners,receipt);
          return;
        }
        case 'devices':
          latestDevices = devicesStateSchema.parse(readValue(raw));
          deliverShell(stateListeners, latestDevices);
          return;
        case 'update':
          latestUpdate = desktopUpdateSchema.parse(readValue(raw));
          deliverShell(updateListeners, latestUpdate);
          return;
        // About this computer's shell, not one daemon connection: heard whatever a page's client did.
        case 'remoteUpdate': {
          const text = 'text' in raw ? raw.text : undefined;
          if (text !== undefined && (typeof text !== 'string' || text.length > 512)) throw new Error('Invalid desktop event');
          latestRemoteUpdate = { text };
          deliverShell(remoteUpdateListeners, text);
          return;
        }
        case 'error': {
          const value = readValue(raw);
          if (!value || typeof value !== 'object' || !('message' in value) || !('kind' in value) ||
              typeof value.message !== 'string')
            throw new Error('Invalid desktop event');
          const kind = value.kind;
          if (kind !== 'rpc' && kind !== 'connection' && kind !== 'validation')
            throw new Error('Invalid desktop event');
          everyClient(ordinaryError(value.message, 'code' in value ? value.code : undefined));
          return;
        }
        default: throw new Error('Invalid desktop event');
      }
    } catch { everyClient(new Error('Invalid desktop event')); }
  }

  /** One page's client: each request names `view` last, and only `view`'s events reach it (devices-ui-1a 4.6). */
  function makeClient(view: ViewArgument): BoundClient {
    const snapshots = new Set<(value: DesktopSnapshot) => void>();
    const reattachments = new Set<() => void>();
    const logs = new Set<(value: LogEventPayload) => void>();
    const installs = new Set<(value: BackendInstallEventPayload) => void>();
    const devices = new Set<(value: DeviceEventPayload) => void>();
    const errors = new Set<(error: Error) => void>();
    const retainedErrors: Error[] = [];
    const pending = new Set<(error: Error) => void>();
    let connectionEpoch = 0;
    let clientClosed = false;
    let closing: Promise<void> | undefined;

    function retain(error: Error): void {
      retainedErrors.push(error);
      if (retainedErrors.length > 32) retainedErrors.shift();
    }
    function emitError(error: Error): void {
      if (clientClosed) return;
      if (errors.size === 0) { retain(error); return; }
      for (const listener of errors) {
        try { listener(error); }
        catch (failure) { retain(failure instanceof Error ? failure : new Error(String(failure))); }
      }
    }
    function deliver<T>(listeners: Set<(value: T) => void>, value: T): void {
      for (const listener of listeners) {
        try { listener(value); }
        catch (failure) { emitError(failure instanceof Error ? failure : new Error(String(failure))); }
      }
    }
    function receive(event: ViewEvent): void {
      if (clientClosed || (view !== 'current' && event.view !== view)) return;
      switch (event.type) {
        // Another connection: its revisions start over.
        case 'reattached': connectionEpoch++; deliver(reattachments, undefined); return;
        case 'snapshot': deliver(snapshots, event.value); return;
        case 'log': deliver(logs, event.value); return;
        case 'backendInstall': deliver(installs, event.value); return;
        case 'device': deliver(devices, event.value); return;
      }
    }

    function callClient<T>(channel: string, parse: (value: unknown) => T, ...args: unknown[]): Promise<T> {
      if (clientClosed) return Promise.reject(new Error('Daemon connection closed'));
      return new Promise<T>((resolve, reject) => {
        pending.add(reject);
        void transport.invoke(channel, ...args, view).then(value => {
          if (!pending.delete(reject)) return;
          try { resolve(readResult(value, parse)); }
          catch (error) { reject(error); }
        }, error => {
          if (!pending.delete(reject)) return;
          reject(error instanceof Error ? new Error(error.message) : new Error('桌面端操作没有成功，请重试。'));
        });
      });
    }

    const client: VonvonClient = {
      snapshot: () => callClient(desktopChannels.snapshot, value => desktopSnapshotSchema.parse(value)),
      watchSnapshots(listener, onReattached) {
        if (clientClosed) return () => {};
        let active = true;
        let revision = -1;
        const reattach = () => {
          revision = -1;
          onReattached?.();
        };
        const receiveSnapshot = (value: DesktopSnapshot): void => {
          if (active && !clientClosed && value.revision > revision) {
            revision = value.revision;
            try { listener(value); }
            catch (failure) { emitError(failure instanceof Error ? failure : new Error(String(failure))); }
          }
        };
        snapshots.add(receiveSnapshot);
        reattachments.add(reattach);
        const seedEpoch = connectionEpoch;
        void client.snapshot().then(value => { if (seedEpoch === connectionEpoch) receiveSnapshot(value); }).catch(error => {
          if (active && !clientClosed && seedEpoch === connectionEpoch) emitError(error instanceof Error ? error : new Error('Snapshot failed'));
        });
        return () => { active = false; snapshots.delete(receiveSnapshot); reattachments.delete(reattach); };
      },
      run: command => callClient(desktopChannels.run, value => commandResultSchema.parse(value), command),
      settings: request => callClient(desktopChannels.settings, value => settingsReplySchema.parse(value), request),
      collaboration: request => callClient(desktopChannels.collaboration, value => collaborationReplySchema.parse(value), request),
      environment: request => callClient(desktopChannels.environment, value => environmentReplySchema.parse(value), request),
      machine: request => callClient(desktopChannels.machine, value => machineReplySchema.parse(value), request),
      admin: request => callClient(desktopChannels.admin, value => adminReplySchema.parse(value), request),
      memory: request => callClient(desktopChannels.memory, value => memoryReplySchema.parse(value), request),
      contextPreview: request => callClient(desktopChannels.contextPreview, value => contextPreviewReplySchema.parse(value), request),
      directory: request => callClient(desktopChannels.directory, value => directoryReplySchema.parse(value), request),
      library: request => callClient(desktopChannels.library, value => libraryReplySchema.parse(value), request),
      schedule: (botId, request) => callClient(desktopChannels.schedule, value => scheduleReplySchema.parse(value), botId, request),
      device: request => callClient(desktopChannels.device, value => deviceReplySchema.parse(value), request),
      onLog(listener) {
        if (!clientClosed) logs.add(listener);
        return () => { logs.delete(listener); };
      },
      onBackendInstall(listener) {
        if (!clientClosed) installs.add(listener);
        return () => { installs.delete(listener); };
      },
      onDevice(listener) {
        if (!clientClosed) devices.add(listener);
        return () => { devices.delete(listener); };
      },
      // U4: only the main process's own connection to this computer hears the daemon's update requests.
      onDesktopUpdateRequest: () => () => {},
      onError(listener) {
        if (clientClosed) return () => {};
        errors.add(listener);
        for (const error of retainedErrors.splice(0)) {
          if (clientClosed) break;
          try { listener(error); }
          catch (failure) { retain(failure instanceof Error ? failure : new Error(String(failure))); }
        }
        return () => { errors.delete(listener); };
      },
      close() {
        closing ??= (async () => {
          clientClosed = true;
          for (const reject of pending) reject(new Error('Daemon connection closed'));
          pending.clear();
          snapshots.clear(); reattachments.clear(); logs.clear(); installs.clear(); devices.clear(); errors.clear();
          retainedErrors.length = 0;
          readResult(await transport.invoke(desktopChannels.close, view), parseVoid);
        })();
        return closing;
      },
    };
    return { client, receive, error: emitError, closed: () => clientClosed };
  }
  function boundClient(view: ViewArgument): BoundClient {
    let bound = clients.get(view);
    // A device's page that closed its client gets a new one next time; the page's own 'current' client stays closed.
    if (!bound || (view !== 'current' && bound.closed())) { bound = makeClient(view); clients.set(view, bound); }
    return bound;
  }

  const client = boundClient('current').client;
  transport.receive(onEvent);
  void transport.invoke(desktopChannels.subscribe).then(value => readResult(value, parseVoid))
    .catch(() => everyClient(new Error('Desktop event subscription failed')));

  function callShell(channel: string, ...args: unknown[]): Promise<void> {
    return transport.invoke(channel, ...args).then(value => readResult(value, parseVoid), error => {
      throw error instanceof Error ? new Error(error.message) : new Error('桌面端操作没有成功，请重试。');
    });
  }
  function callShellFor<T>(channel: string, parse: (value: unknown) => T, ...args: unknown[]): Promise<T> {
    return transport.invoke(channel, ...args).then(value => readResult(value, parse), error => {
      throw error instanceof Error ? new Error(error.message) : new Error('桌面端操作没有成功，请重试。');
    });
  }

  const devices: DevicesShell = {
    state: () => callShellFor(desktopChannels.devicesState, value => devicesStateSchema.parse(value)),
    onState(listener) {
      stateListeners.add(listener);
      if (latestDevices) {
        try { listener(latestDevices); }
        catch (failure) { shellFailure(failure); }
      }
      return () => { stateListeners.delete(listener); };
    },
    clientFor: view => boundClient(viewIdSchema.parse(view)).client,
    inspect: link => callShellFor(desktopChannels.devicesInspect, value => linkPreviewSchema.parse(value), link),
    add: request => callShellFor(desktopChannels.devicesAdd, value => addDeviceResultSchema.parse(value), request),
    cancelAdd: () => callShell(desktopChannels.devicesCancelAdd),
    rename: (id, name) => callShell(desktopChannels.devicesRename, id, name),
    remove: id => callShellFor(desktopChannels.devicesRemove, value => removeDeviceResultSchema.parse(value), id),
    switchTo: id => callShell(desktopChannels.devicesSwitch, id),
    retry: () => callShell(desktopChannels.devicesRetry),
  };

  const shell: DesktopShell = {
    openExternal: url => callShell(desktopChannels.external, url),
    chooseExecutablePath: () => transport.invoke(desktopChannels.chooseExecutablePath)
      .then(value => readResult(value, parseExecutablePath), error => {
        throw error instanceof Error ? new Error(error.message) : new Error('桌面端操作没有成功，请重试。');
      }),
    chooseDirectoryPaths: multiple => transport.invoke(desktopChannels.chooseDirectoryPaths, multiple)
      .then(value => readResult(value, paths => {
        if (paths === null) return null;
        if (!Array.isArray(paths) || paths.length > 64 || paths.some(path => typeof path !== 'string' || !path || path.includes('\0'))) throw new Error('Invalid desktop response');
        return paths as string[];
      })),
    startHost: bot => transport.invoke(desktopChannels.startHost, { type: 'startHost', ...(bot === undefined ? {} : { bot }) } satisfies DesktopShellRequest)
      .then(value => readResult(value, value => machineReplySchema.parse(value))),
    service: action => transport.invoke(desktopChannels.service, { type: 'service', action } satisfies DesktopShellRequest)
      .then(value => readResult(value, value => machineReplySchema.parse(value))),
    setLoginItem: enabled => callShell(desktopChannels.setLoginItem, enabled),
    repairCli: () => transport.invoke(desktopChannels.repairCli)
      .then(value => readResult(value, value => machineReplySchema.parse(value))),
    checkDesktopUpdate: () => transport.invoke(desktopChannels.checkDesktopUpdate)
      .then(value => readResult(value, value => desktopUpdateSchema.parse(value))),
    retryDesktopUpdate: () => transport.invoke(desktopChannels.retryDesktopUpdate)
      .then(value => readResult(value, value => desktopUpdateSchema.parse(value))),
    installDesktopUpdate: () => transport.invoke(desktopChannels.installDesktopUpdate)
      .then(value => readResult(value, value => desktopUpdateSchema.parse(value))),
    onDesktopUpdate(listener) {
      updateListeners.add(listener);
      if (latestUpdate) {
        try { listener(latestUpdate); }
        catch (failure) { shellFailure(failure); }
      }
      return () => { updateListeners.delete(listener); };
    },
    hideWindow: () => callShell(desktopChannels.hide),
    quit: () => callShell(desktopChannels.quit),
    quitKeepsDaemon: () => transport.invoke(desktopChannels.quitKeepsDaemon)
      .then(value => readResult(value, value => value === true)),
    onQuitRequested(listener) {
      quitListeners.add(listener);
      if (pendingQuit) {
        pendingQuit = false;
        try { listener(); }
        catch (failure) { shellFailure(failure); }
      }
      return () => { quitListeners.delete(listener); };
    },
    devices,
    recipeSource: {request:raw=>callShellFor(desktopChannels.recipeSource,value=>desktopRecipeSourceReplySchema.parse(value),desktopRecipeSourceRequestSchema.parse(raw))},
    recipeAuthoring: {
      onSaved(listener) {authoringSavedListeners.add(listener); return () => { authoringSavedListeners.delete(listener); };},
      request: raw => callShellFor(desktopChannels.recipeAuthoring, value => desktopAuthoringReplySchema.parse(value), desktopAuthoringRequestSchema.parse(raw)),
    },
    recipeUse: {
      request: raw => callShellFor(desktopChannels.recipeUse, value=>recipeUseReplySchema.parse(value),recipeUseRequestSchema.parse(raw)),
    },
    community: {
      request: ((raw: Parameters<CommunityShell['request']>[0]) => {
        const request = communityRequestSchema.parse(raw);
        if (request.type !== 'acquire') return callShellFor(desktopChannels.community, value => communityResponseSchemas[request.type].parse(value), request);
        return (async () => {
          try {
            const result = await transport.invoke(desktopChannels.community, request);
            if (result && typeof result === 'object' && 'ok' in result && result.ok === false && 'error' in result && result.error && typeof result.error === 'object') {
              const error = result.error;
              const parsed = acquisitionFailureSchema.safeParse({code: 'code' in error ? error.code : 'unavailable', ...('retryAfter' in error ? {retryAfter: error.retryAfter} : {})});
              return {ok: false as const, error: parsed.success ? parsed.data : {code: 'unavailable' as const}};
            }
            return {ok: true as const, value: readResult(result, value => communityResponseSchemas.acquire.parse(value))};
          } catch {return {ok: false as const, error: {code: 'unavailable' as const}};}
        })();
      }) as CommunityShell['request'],
    },
    account: {
      status: () => callShellFor(desktopChannels.accountStatus, value => accountStatusSchema.parse(value)),
      login: () => callShellFor(desktopChannels.accountLogin, value => accountStatusSchema.parse(value)),
      cancelLogin: () => callShellFor(desktopChannels.accountCancel, value => accountStatusSchema.parse(value)),
      logout: () => callShellFor(desktopChannels.accountLogout, value => accountStatusSchema.parse(value)),
      onStatus(listener) {
        accountListeners.add(listener);
        if (latestAccount) {
          try { listener(latestAccount); } catch (error) { shellFailure(error); }
        }
        return () => { accountListeners.delete(listener); };
      },
    },
    onRemoteUpdate(listener) {
      remoteUpdateListeners.add(listener);
      if (latestRemoteUpdate) {
        try { listener(latestRemoteUpdate.text); }
        catch (failure) { shellFailure(failure); }
      }
      return () => { remoteUpdateListeners.delete(listener); };
    },
    onLocalDeviceEvent(listener) {
      localDeviceListeners.add(listener);
      return () => { localDeviceListeners.delete(listener); };
    },
  };
  return { client, shell };
}
