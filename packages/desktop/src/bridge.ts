import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { shell, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { ConnectionError, RpcError } from '@vonvon/client/browser';
import {
  adminRequestSchema, collaborationRequestSchema, commandSchema,
  directoryRequestSchema, environmentRequestSchema, machineRequestSchema,
  settingsRequestSchema, machineReplySchema, type MachineReply,
} from '@vonvon/protocol';
import { allowedExternalUrl, type ExternalUrlKind } from '../../ui/src/url-actions.js';
import { ServiceActionError } from './service-error.js';
import { StartHostRefusal } from './daemon-manager.js';
import {
  desktopChannels, safeErrorCode, type AttachedDaemon, type DesktopBridge, type DesktopEvent,
  type DesktopResources, type IpcResult, type SafeFailure, type ShellActions,
} from './ipc-contract.js';

const externalKinds: readonly ExternalUrlKind[] = [
  'registration', 'authorization', 'verification', 'event-settings', 'app-console', 'group', 'releases',
];

export async function openAllowedExternal(raw: unknown): Promise<void> {
  if (typeof raw !== 'string') throw new Error('Unsupported external link');
  const url = externalKinds.map(kind => allowedExternalUrl(raw, kind)).find(value => value !== null);
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
  if (chars.length === 0) return 'Daemon request failed';
  if (!cut && chars.length <= daemonMessageLimit) return text;
  return `${chars.slice(0, daemonMessageLimit - 1).join('')}…`;
}

function safeFailure(error: unknown): SafeFailure {
  if (error instanceof RpcError) {
    const code = safeErrorCode(error.code);
    return { kind: 'rpc', message: sanitizeDaemonMessage(error.message), ...(code ? { code } : {}) };
  }
  if (error instanceof ConnectionError) return { kind: 'connection', message: 'Daemon connection lost' };
  if (error instanceof ServiceActionError) return { kind: 'validation', message: sanitizeDaemonMessage(error.safeMessage) };
  if (error instanceof StartHostRefusal) return { kind: 'validation', message: error.message };
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
  let activeOwner: AttachedDaemon | null = owner;
  let replacing: Promise<void> | undefined;
  let candidate: AttachedDaemon | null = null;
  let stoppedStatus: Extract<MachineReply, { type: 'status' }> | undefined;
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

  function onError(error: Error, from: AttachedDaemon): void {
    if (disposed) return;
    // The shell owns reattachment and reports a drop if recovery fails.
    if (error instanceof ConnectionError && (actions.isExpectedDisconnect() || actions.recoverConnection(from.identity))) return;
    const safe = safeFailure(error);
    if (!subscribed || !currentDocument()) retain(safe);
    else send({ type: 'error', value: safe });
    if (error instanceof ConnectionError && !connectionLost) {
      connectionLost = true;
      actions.connectionLost();
    }
  }

  function client(): AttachedDaemon['client'] {
    if (!activeOwner) throw new Error('Daemon connection unavailable');
    return activeOwner.client;
  }

  /** A login-item switch changed the service: machine `status` reads it again, and the daemon pushes the new snapshot. */
  async function refreshService(): Promise<void> {
    await activeOwner?.client.machine({ type: 'status' }).catch(() => {});
  }

  function bind(current: AttachedDaemon, paused = false) {
    let latest: Awaited<ReturnType<AttachedDaemon['client']['snapshot']>> | undefined;
    let revision = -1;
    let bound = true;
    let connectionFailure: ConnectionError | undefined;
    const removers: (() => void)[] = [];
    const dispose = () => { if (!bound) return; bound = false; latest = undefined; for (const off of removers) off(); };
    try {
      removers.push(current.client.watchSnapshots(value => {
        if (!bound || value.revision < revision) return;
        revision = value.revision;
        // A paused binding is the candidate of a replacement: it keeps the newest until activated.
        if (paused) latest = value;
        else if (activeOwner === current) send({ type: 'snapshot', value });
      }));
      removers.push(current.client.onLog(value => { if (!paused && activeOwner === current) send({ type: 'log', value }); }));
      removers.push(current.client.onBackendInstall(value => { if (!paused && activeOwner === current) send({ type: 'backendInstall', value }); }));
      removers.push(current.client.onError(error => {
        if (paused && error instanceof ConnectionError) connectionFailure = error;
        else if (!paused && activeOwner === current) onError(error, current);
      }));
    } catch (error) { dispose(); throw error; }
    return {
      dispose,
      connectionFailure: () => connectionFailure,
      activate(initial: Awaited<ReturnType<AttachedDaemon['client']['snapshot']>>) {
        const value = latest && latest.revision >= initial.revision ? latest : initial;
        latest = undefined;
        revision = value.revision;
        paused = false;
        send({ type: 'snapshot', value });
      },
    };
  }

  let binding = bind(owner);
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
    register(desktopChannels.snapshot, 0, noArg, () => client().snapshot());
    register(desktopChannels.run, 1, value => commandSchema.parse(value), value => {
      if (value.type !== 'restartHost' || !activeOwner) return client().run(value);
      return actions.restartHost(activeOwner.identity, () => client().run(value));
    });
    register(desktopChannels.settings, 1, value => settingsRequestSchema.parse(value), value => client().settings(value));
    register(desktopChannels.collaboration, 1, value => collaborationRequestSchema.parse(value), value => client().collaboration(value));
    register(desktopChannels.environment, 1, value => environmentRequestSchema.parse(value), value => client().environment(value));
    register(desktopChannels.machine, 1, value => {
      const request = machineRequestSchema.parse(value);
      if (request.type === 'repairCli' || request.type === 'service' || request.type === 'startHost' ||
          request.type === 'checkDesktopUpdate' || request.type === 'installDesktopUpdate')
        throw new Error('Shell-owned machine action');
      return request;
    }, async value => {
      const reply = value.type === 'status' && stoppedStatus ? stoppedStatus : await client().machine(value);
      return value.type === 'status' && reply.type === 'status'
        ? { ...reply, cli: await actions.observeCli() } : reply;
    });
    register(desktopChannels.admin, 1, value => adminRequestSchema.parse(value), value => client().admin(value));
    register(desktopChannels.directory, 1, value => directoryRequestSchema.parse(value), value => client().directory(value));
    register(desktopChannels.close, 0, noArg, () => activeOwner?.dispose() ?? Promise.resolve());
    register(desktopChannels.external, 1, value => value, openAllowedExternal);
    register(desktopChannels.startHost, 1, value => {
      const request = machineRequestSchema.parse(value);
      if (request.type !== 'startHost') throw new Error('Invalid start request');
      return request;
    },
      value => actions.startHost(value.bot).then(reply => machineReplySchema.parse(reply)));
    register(desktopChannels.service, 1, value => {
      const request = machineRequestSchema.parse(value);
      if (request.type !== 'service') throw new Error('Invalid service request');
      return request.action;
    }, async value => {
      const before = value === 'stop' ? stoppedStatus ?? await client().machine({ type: 'status' }) : undefined;
      if (before && before.type !== 'status') throw new Error('Cannot read service status');
      const switchesLoginItem = value === 'install' || value === 'uninstall';
      let reply: MachineReply;
      try { reply = machineReplySchema.parse(await actions.service(value, activeOwner?.identity ?? null)); }
      finally { if (switchesLoginItem) await refreshService(); }
      if (value === 'stop' && before?.type === 'status') {
        stoppedStatus = { ...before, host: null, service: { ...before.service, running: false, pid: undefined } };
      }
      return reply;
    });
    register(desktopChannels.setLoginItem, 1, value => {
      if (typeof value !== 'boolean') throw new Error('Invalid login item request');
      return value;
    }, async value => {
      // A failed switch may still have changed the service, so the state is read again either way.
      try { await actions.setLoginItem(value, activeOwner?.identity ?? null); }
      finally { await refreshService(); }
    });
    register(desktopChannels.repairCli, 0, noArg,
      () => actions.repairCli().then(reply => machineReplySchema.parse(reply)));
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
    binding.dispose();
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
        binding.dispose();
        const previous = activeOwner;
        activeOwner = null;
        try { await previous?.dispose(); }
        catch (error) { await next.dispose(); throw error; }
        if (disposed) { await next.dispose(); throw new Error('Desktop connection is unavailable'); }
        let initial: Awaited<ReturnType<AttachedDaemon['client']['snapshot']>>;
        let nextBinding: ReturnType<typeof bind> | undefined;
        try {
          nextBinding = bind(next, true);
          binding = nextBinding;
          initial = await next.client.snapshot();
          const lost = nextBinding.connectionFailure();
          if (lost) throw lost;
          if (disposed) throw new Error('Desktop connection is unavailable');
        } catch (error) {
          binding.dispose();
          await next.dispose();
          throw nextBinding?.connectionFailure() ?? error;
        }
        activeOwner = next;
        stoppedStatus = undefined;
        connectionLost = false;
        send({ type: 'reattached' });
        binding.activate(initial);
      })().finally(() => { replacing = undefined; candidate = null; });
      return replacing;
    },
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
        await candidate?.dispose().catch(() => {});
        if (replacing) await replacing.catch(() => {});
        binding.dispose();
        await activeOwner?.dispose();
        activeOwner = null;
      })();
      return disposal;
    },
  };
}
