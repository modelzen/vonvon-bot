import type { VonvonClient } from '@vonvon/client/browser';
import {
  adminReplySchema, backendInstallEventPayloadSchema, collaborationReplySchema,
  commandResultSchema, desktopSnapshotSchema, directoryReplySchema,
  environmentReplySchema, logEventPayloadSchema, machineReplySchema, desktopUpdateSchema,
  settingsReplySchema,
  type BackendInstallEventPayload, type DesktopSnapshot, type LogEventPayload,
} from '@vonvon/protocol';
import {
  desktopChannels, type DesktopShell, type SafeFailure,
} from './ipc-contract.js';

export interface FacadeTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  receive(listener: (event: unknown) => void): () => void;
}

function ordinaryError(failure: SafeFailure): Error {
  return new Error(failure.message);
}

function readResult<T>(value: unknown, parse: (value: unknown) => T): T {
  if (!value || typeof value !== 'object' || !('ok' in value)) throw new Error('Invalid desktop response');
  if (value.ok === true && 'value' in value) return parse(value.value);
  if (value.ok === false && 'error' in value && value.error && typeof value.error === 'object' &&
      'kind' in value.error && 'message' in value.error &&
      (value.error.kind === 'rpc' || value.error.kind === 'connection' || value.error.kind === 'validation') &&
      typeof value.error.message === 'string') {
    throw ordinaryError({ kind: value.error.kind, message: value.error.message });
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

export function createDesktopFacades(transport: FacadeTransport): { client: VonvonClient; shell: DesktopShell } {
  const snapshots = new Set<(value: DesktopSnapshot) => void>();
  const logs = new Set<(value: LogEventPayload) => void>();
  const installs = new Set<(value: BackendInstallEventPayload) => void>();
  const errors = new Set<(error: Error) => void>();
  const quitListeners = new Set<() => void>();
  const retainedErrors: Error[] = [];
  const pending = new Set<(error: Error) => void>();
  let pendingQuit = false;
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

  function onEvent(raw: unknown): void {
    try {
      if (!raw || typeof raw !== 'object' || !('type' in raw)) throw new Error('Invalid desktop event');
      if (raw.type === 'quitRequested') {
        if (quitListeners.size === 0) pendingQuit = true;
        else deliver(quitListeners, undefined);
        return;
      }
      if (clientClosed) return;
      switch (raw.type) {
        case 'reattached':
          connectionEpoch++;
          break;
        case 'snapshot':
          if (!('value' in raw)) throw new Error('Invalid desktop event');
          deliver(snapshots, desktopSnapshotSchema.parse(raw.value));
          break;
        case 'log':
          if (!('value' in raw)) throw new Error('Invalid desktop event');
          deliver(logs, logEventPayloadSchema.parse(raw.value));
          break;
        case 'backendInstall':
          if (!('value' in raw)) throw new Error('Invalid desktop event');
          deliver(installs, backendInstallEventPayloadSchema.parse(raw.value));
          break;
        case 'error': {
          if (!('value' in raw)) throw new Error('Invalid desktop event');
          const value = raw.value;
          if (!value || typeof value !== 'object' || !('message' in value) || !('kind' in value) ||
              typeof value.message !== 'string')
            throw new Error('Invalid desktop event');
          const kind = value.kind;
          if (kind !== 'rpc' && kind !== 'connection' && kind !== 'validation')
            throw new Error('Invalid desktop event');
          emitError(ordinaryError({ kind, message: value.message }));
          break;
        }
        default: throw new Error('Invalid desktop event');
      }
    } catch { emitError(new Error('Invalid desktop event')); }
  }

  transport.receive(onEvent);
  void transport.invoke(desktopChannels.subscribe).then(value => readResult(value, parseVoid))
    .catch(() => emitError(new Error('Desktop event subscription failed')));

  function callClient<T>(channel: string, parse: (value: unknown) => T, ...args: unknown[]): Promise<T> {
    if (clientClosed) return Promise.reject(new Error('Daemon connection closed'));
    return new Promise<T>((resolve, reject) => {
      pending.add(reject);
      void transport.invoke(channel, ...args).then(value => {
        if (!pending.delete(reject)) return;
        try { resolve(readResult(value, parse)); }
        catch (error) { reject(error); }
      }, error => {
        if (!pending.delete(reject)) return;
        reject(error instanceof Error ? new Error(error.message) : new Error('Desktop request failed'));
      });
    });
  }

  function callShell(channel: string, ...args: unknown[]): Promise<void> {
    return transport.invoke(channel, ...args).then(value => readResult(value, parseVoid), error => {
      throw error instanceof Error ? new Error(error.message) : new Error('Desktop request failed');
    });
  }

  const client: VonvonClient = {
    snapshot: () => callClient(desktopChannels.snapshot, value => desktopSnapshotSchema.parse(value)),
    watchSnapshots(listener) {
      if (clientClosed) return () => {};
      let active = true;
      let revision = -1;
      let observedEpoch = connectionEpoch;
      const receive = (value: DesktopSnapshot): void => {
        if (observedEpoch !== connectionEpoch) {
          revision = -1;
          observedEpoch = connectionEpoch;
        }
        if (active && !clientClosed && value.revision > revision) {
          revision = value.revision;
          try { listener(value); }
          catch (failure) { emitError(failure instanceof Error ? failure : new Error(String(failure))); }
        }
      };
      snapshots.add(receive);
      const seedEpoch = connectionEpoch;
      void client.snapshot().then(value => { if (seedEpoch === connectionEpoch) receive(value); }).catch(error => {
        if (active && !clientClosed && seedEpoch === connectionEpoch) emitError(error instanceof Error ? error : new Error('Snapshot failed'));
      });
      return () => { active = false; snapshots.delete(receive); };
    },
    run: command => callClient(desktopChannels.run, value => commandResultSchema.parse(value), command),
    settings: request => callClient(desktopChannels.settings, value => settingsReplySchema.parse(value), request),
    collaboration: request => callClient(desktopChannels.collaboration, value => collaborationReplySchema.parse(value), request),
    environment: request => callClient(desktopChannels.environment, value => environmentReplySchema.parse(value), request),
    machine: request => callClient(desktopChannels.machine, value => machineReplySchema.parse(value), request),
    admin: request => callClient(desktopChannels.admin, value => adminReplySchema.parse(value), request),
    directory: request => callClient(desktopChannels.directory, value => directoryReplySchema.parse(value), request),
    onLog(listener) {
      if (!clientClosed) logs.add(listener);
      return () => { logs.delete(listener); };
    },
    onBackendInstall(listener) {
      if (!clientClosed) installs.add(listener);
      return () => { installs.delete(listener); };
    },
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
        snapshots.clear(); logs.clear(); installs.clear(); errors.clear();
        retainedErrors.length = 0;
        readResult(await transport.invoke(desktopChannels.close), parseVoid);
      })();
      return closing;
    },
  };

  const shell: DesktopShell = {
    openExternal: url => callShell(desktopChannels.external, url),
    chooseExecutablePath: () => transport.invoke(desktopChannels.chooseExecutablePath)
      .then(value => readResult(value, parseExecutablePath), error => {
        throw error instanceof Error ? new Error(error.message) : new Error('Desktop request failed');
      }),
    startHost: bot => transport.invoke(desktopChannels.startHost, { type: 'startHost', ...(bot === undefined ? {} : { bot }) })
      .then(value => readResult(value, value => machineReplySchema.parse(value))),
    repairCli: () => transport.invoke(desktopChannels.repairCli)
      .then(value => readResult(value, value => machineReplySchema.parse(value))),
    checkDesktopUpdate: () => transport.invoke(desktopChannels.checkDesktopUpdate)
      .then(value => readResult(value, value => desktopUpdateSchema.parse(value))),
    installDesktopUpdate: () => transport.invoke(desktopChannels.installDesktopUpdate)
      .then(value => readResult(value, value => desktopUpdateSchema.parse(value))),
    hideWindow: () => callShell(desktopChannels.hide),
    quit: () => callShell(desktopChannels.quit),
    onQuitRequested(listener) {
      quitListeners.add(listener);
      if (pendingQuit) {
        pendingQuit = false;
        try { listener(); }
        catch (failure) { emitError(failure instanceof Error ? failure : new Error(String(failure))); }
      }
      return () => { quitListeners.delete(listener); };
    },
  };
  return { client, shell };
}
