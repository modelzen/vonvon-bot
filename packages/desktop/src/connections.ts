import { hostname as osHostname } from 'node:os';
import { ConnectionError, type VonvonClient } from '@vonvon/client/browser';
import { generateStaticKey } from '@vonvon/client/secure';
import {
  decodePairingLink, deviceAliasSchema, deviceRouteSchema, LOCAL_VIEW,
  type ActiveDeviceState, type AddDeviceRequest, type AddDeviceResult, type DeviceRoute, type DeviceRow, type DeviceRowStatus,
  type DevicesState, type LinkPreview, type PairingLink, type RemoveDeviceResult, type RouteFailure, type ServerInfo, type ViewId,
} from '@vonvon/protocol';
import { MAX_DEVICES, RegistryError, type DeviceRegistry, type SecretBox, type StoredDevice, type StoredProblem } from './device-registry.js';
import { RemoteConnectError, type RemoteConnector, type RemoteLink } from './remote-transport.js';

/** devices-ui-1a 4.4: the desktop's devices, one current at a time, and the connection to it. */
export type DeviceLogEvent = 'device-opened' | 'device-closed' | 'device-failed' | 'device-added' | 'device-removed'
  | 'device-route-failed' | 'device-add-failed';
export interface DeviceConnectionsDeps {
  registry: DeviceRegistry;
  connector: RemoteConnector;
  box: SecretBox;
  /** app.getVersion() and PROTOCOL_VERSION. */
  client: { version: string; protocolVersion: number };
  generateKey?: typeof generateStaticKey;
  now?: () => number;
  timers?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;
  /** This computer's name when the local daemon has not said one. */
  hostname?: () => string;
  /** Only the device id's first 8 characters, the event, codes and times: never an address, a link or a key. */
  log?: (event: DeviceLogEvent, fields: Record<string, string | number>) => void;
  /** macOS 15 and later: the system may block an app's connections to the local network until the user allows them, and
   * the first one fails at once while it asks (TN3179). */
  localNetworkPrivacy?: boolean;
}
export type ViewMode = 'full' | 'maintenance';
export interface ViewSession { id: string; client: VonvonClient; serverInfo: ServerInfo; mode: ViewMode }
export type ViewChange =
  | { kind: 'local' }
  | { kind: 'remote'; session: ViewSession; cause: 'opened' | 'reopened' | 'restarted' }
  /** The current device is remote and there is no connection to use right now: connecting, reconnecting or failed. */
  | { kind: 'waiting'; id: string };
export type LocalStatus = 'online' | 'connecting' | 'offline';
export interface DeviceConnections {
  state(): DevicesState;
  onState(listener: (state: DevicesState) => void): () => void;
  onView(listener: (change: ViewChange) => void): () => void;
  view(): ViewChange;
  pairedPublicKey?(id: string): string | undefined;
  /** Returns once switched, without waiting for the connection. */
  switchTo(id: ViewId): Promise<void>;
  retry(): void;
  /** The computer woke up. */
  wake(): void;
  inspectLink(text: string): LinkPreview;
  add(request: AddDeviceRequest): Promise<AddDeviceResult>;
  cancelAdd(): void;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<RemoveDeviceResult>;
  setLocal(local: { status: LocalStatus; serverInfo?: ServerInfo }): void;
  /** Said before a restart or stop goes to the remote device: its disconnect is then not a failure. */
  expect(kind: 'restart' | 'stop'): void;
  dispose(): Promise<void>;
}
export type DeviceConnectionsErrorCode = 'disposed' | 'unknown_device' | 'local_device' | 'invalid_name';
export class DeviceConnectionsError extends Error {
  constructor(readonly code: DeviceConnectionsErrorCode) {
    super(`devices: ${code}`);
    this.name = 'DeviceConnectionsError';
  }
}

/** 1, 2, 4, 8, 16, 30, 30… seconds. */
export const backoff = (n: number): number => Math.min(30_000, 1_000 * 2 ** n);
const RATE_LIMITED_MS = 60_000;
const STATUS_TIMEOUT_MS = 5_000;
const REVOKE_TIMEOUT_MS = 3_000;
const EXPECTED_MS = 120_000;
const DISPOSE_WAIT_MS = 2_000;
const MAX_ROUTES = 8;
const LOCAL_NAME = '这台电脑';

type Phase = ActiveDeviceState['phase'];
type Failure = NonNullable<ActiveDeviceState['failure']>;
type Notice = NonNullable<ActiveDeviceState['notice']>;
type Cause = Extract<ViewChange, { kind: 'remote' }>['cause'];
interface Session { id: string; link: RemoteLink; info: ServerInfo; mode: ViewMode; pid?: number; startedAt?: number; view: ViewSession; cause: Cause }
type Timer = ReturnType<typeof setTimeout>;
const TERMINAL: Partial<Record<string, StoredProblem | 'key_unreadable'>> = {
  client_revoked: 'revoked', unknown_client: 'unknown_client', identity_changed: 'identity_changed', key_unreadable: 'key_unreadable',
};
/** Stopped on, but only this attempt's result: not written down, tried again on retry, a switch back or the next start.
 * A key the keychain will not open may open later; another identity is a 4005 before message 2, which anyone on the path
 * can send (D2), or a machine id that does not match, which every attempt meets again (Codex 审查 235-2). */
const RETRYABLE = new Set<string>(['key_unreadable', 'identity_changed']);
const routeKey = (route: Pick<DeviceRoute, 'host' | 'port'>): string => `${route.host}|${route.port}`;
const sameRoutes = (a: readonly DeviceRoute[], b: readonly DeviceRoute[]): boolean =>
  a.length === b.length && a.every(route => b.some(other => routeKey(other) === routeKey(route) && other.kind === route.kind));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A name to give a device or to pair under: at most 40 characters, no control characters. */
function cleanName(raw: string, fallback: string): string {
  const name = Array.from(raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 40).join('').trim();
  return deviceAliasSchema.safeParse(name).success ? name : fallback;
}

export function createDeviceConnections(deps: DeviceConnectionsDeps): DeviceConnections {
  const { registry, connector, box } = deps;
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? globalThis;
  const generateKey = deps.generateKey ?? generateStaticKey;
  const log = (event: DeviceLogEvent, fields: Record<string, string | number>): void => {
    try { deps.log?.(event, fields); } catch { /* logging never breaks a connection */ }
  };
  const short = (id: string): string => id.slice(0, 8);
  /** Reconnecting: each address's failure as last logged, so a device that stays unreachable logs it once, not every 30 s. */
  const loggedRoutes = new Map<string, string>();
  /** One failed address: logged with why (stage, errno, HTTP status) and how long it took, never the address itself.
   * `changes`: only when it differs from the last one logged for this address. */
  const routeFailure = (id: string, route: DeviceRoute, error: unknown, started: number, changes = false): RouteFailure => {
    const failure = error instanceof RemoteConnectError ? error : new RemoteConnectError('closed', 'socket');
    const sys = failure.detail?.sysCode;
    const http = failure.detail?.httpStatus;
    const key = `${id} ${routeKey(route)}`;
    const what = `${failure.code} ${failure.stage} ${sys ?? ''} ${http ?? ''}`;
    if (failure.code !== 'aborted' && !(changes && loggedRoutes.get(key) === what)) {
      if (changes) loggedRoutes.set(key, what);
      log('device-route-failed', { id: short(id), kind: route.kind, code: failure.code, stage: failure.stage,
        ...(sys ? { sys } : {}), ...(http === undefined ? {} : { http }), ms: Math.max(0, now() - started) });
    }
    const blocked = deps.localNetworkPrivacy === true && sys === 'EHOSTUNREACH' && (route.kind === 'lan' || route.kind === 'overlay');
    return { route, code: failure.code, ...(blocked ? { localNetwork: true as const } : {}) };
  };

  let disposed = false;
  let disposal: Promise<void> | undefined;
  let viewId: ViewId = LOCAL_VIEW;
  /** Bumped by every switch, the removal of the current device and dispose: a connection of another generation is stale. */
  let gen = 0;
  /** Bumped by every attempt: retry() and wake() replace the attempt in flight. */
  let seq = 0;
  let session: Session | undefined;
  let phase: Phase = 'ready';
  let attempt = 0;
  let retryAt: number | undefined;
  let retryTimer: Timer | undefined;
  let connecting: AbortController | undefined;
  let failure: Failure | undefined;
  let expected: { kind: 'restart' | 'stop'; timer: Timer } | undefined;
  let notice: Notice | undefined;
  let disabledAt: number | undefined;
  /** The current remote device's last connection, kept while it reconnects. */
  let lastMode: ViewMode | undefined;
  let lastInfo: ServerInfo | undefined;
  /** Terminal problems in memory, written at once; the registry follows asynchronously. */
  const problems = new Map<string, StoredProblem>();
  const lastIdentity = new Map<string, { pid?: number; startedAt?: number; version: string }>();
  const lastFailure = new Map<string, string>();
  let pairing: { abort: AbortController; stage: 'connecting' | 'pairing' | 'checking'; route?: DeviceRoute } | undefined;
  let removing: string | undefined;
  let local: { status: LocalStatus; serverInfo?: ServerInfo } = { status: 'online' };
  let revision = 0;
  let currentView: ViewChange = { kind: 'local' };
  const stateListeners = new Set<(state: DevicesState) => void>();
  const viewListeners = new Set<(change: ViewChange) => void>();
  /** Opens, adds and problem writes still running: dispose waits for them, two seconds at most. */
  const inflight = new Set<Promise<unknown>>();

  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work);
    void work.then(() => inflight.delete(work), () => inflight.delete(work));
    return work;
  };
  /** Deadlines still running, ended by dispose so none outlives it. */
  const deadlines = new Map<Timer, () => void>();
  const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
    const expire = (): void => { deadlines.delete(timer); reject(new Error('timeout')); };
    const timer = timers.setTimeout(expire, ms);
    deadlines.set(timer, expire);
    const settle = (): void => { timers.clearTimeout(timer); deadlines.delete(timer); };
    work.then(value => { settle(); resolve(value); }, error => { settle(); reject(error); });
  });
  const problemOf = (id: string): StoredProblem | undefined => problems.get(id) ?? registry.get(id)?.problem?.code;
  const keyUnreadable = (device: StoredDevice): boolean => {
    try { registry.openKey(device); return false; } catch { return true; }
  };

  function rowStatus(device: StoredDevice): DeviceRowStatus {
    const id = device.deviceId;
    if (id === viewId) {
      if (phase === 'ready') return session?.mode === 'maintenance' ? 'maintenance' : 'online';
      if (phase === 'failed') return problemOf(id) === 'revoked' ? 'revoked' : 'needs-pairing';
      return phase;
    }
    const problem = problemOf(id);
    if (problem) return problem === 'revoked' ? 'revoked' : 'needs-pairing';
    // Like the current device: stopped on it, pairing again is what fixes it.
    if (RETRYABLE.has(lastFailure.get(id) ?? '')) return 'needs-pairing';
    if (lastFailure.has(id)) return 'offline';
    if (device.lastKnown && device.lastKnown.protocolVersion !== deps.client.protocolVersion) return 'maintenance';
    return 'unknown';
  }
  function row(device: StoredDevice): DeviceRow {
    const live = device.deviceId === viewId && session ? session.info : undefined;
    const known = device.lastKnown;
    const platform = live?.platform ?? known?.platform;
    const version = live?.version ?? known?.version;
    const protocolVersion = live?.protocolVersion ?? known?.protocolVersion;
    const failed = lastFailure.get(device.deviceId);
    const problem = problemOf(device.deviceId) ?? (failed === 'key_unreadable' || failed === 'identity_changed' ? failed : undefined);
    return {
      id: device.deviceId, name: device.name, current: device.deviceId === viewId, status: rowStatus(device),
      ...(platform ? { platform } : {}), ...(version ? { version } : {}), ...(protocolVersion === undefined ? {} : { protocolVersion }),
      ...(device.lastConnectedAt === undefined ? {} : { lastConnectedAt: device.lastConnectedAt }),
      ...(problem ? { problem } : {}),
      routes: device.routes,
    };
  }
  function active(): ActiveDeviceState {
    if (viewId === LOCAL_VIEW) return { id: LOCAL_VIEW, phase: 'ready', mode: 'full', ...(local.serverInfo ? { serverInfo: local.serverInfo } : {}), attempt: 0 };
    const mode = phase === 'ready' ? session?.mode : lastMode;
    const info = phase === 'ready' ? session?.info : lastInfo;
    return {
      id: viewId, phase, ...(mode ? { mode } : {}), ...(info ? { serverInfo: info } : {}), attempt,
      ...(retryAt === undefined ? {} : { retryAt }), ...(failure ? { failure } : {}), ...(expected ? { expected: expected.kind } : {}),
      ...(disabledAt === undefined ? {} : { disabledAt }), ...(notice ? { notice } : {}),
    };
  }
  function state(): DevicesState {
    const info = local.serverInfo;
    return {
      v: 1, revision, client: { version: deps.client.version, protocolVersion: deps.client.protocolVersion },
      registry: registry.status, secureStorage: box.available(),
      devices: [{
        id: LOCAL_VIEW, name: LOCAL_NAME, current: viewId === LOCAL_VIEW, status: local.status,
        ...(info?.platform ? { platform: info.platform } : {}), ...(info ? { version: info.version, protocolVersion: info.protocolVersion } : {}),
        routes: [],
      }, ...registry.list().map(row)],
      active: active(),
      ...(pairing ? { adding: { stage: pairing.stage, ...(pairing.route ? { route: pairing.route } : {}) } } : {}),
    };
  }
  function emitState(): void {
    if (disposed) return;
    revision++;
    const value = state();
    for (const listener of stateListeners) {
      try { listener(value); } catch { /* one listener does not stop the others */ }
    }
  }
  function emitView(change: ViewChange): void {
    if (disposed) return;
    currentView = change;
    for (const listener of viewListeners) {
      try { listener(change); } catch { /* as above */ }
    }
  }

  function clearRetry(): void {
    if (retryTimer !== undefined) timers.clearTimeout(retryTimer);
    retryTimer = undefined;
    retryAt = undefined;
  }
  function clearExpected(): void {
    if (expected) timers.clearTimeout(expected.timer);
    expected = undefined;
  }
  function persistProblem(id: string, problem: StoredProblem): void {
    problems.set(id, problem);
    const at = now();
    void track(registry.update(id, device => ({ ...device, problem: { code: problem, at } }))
      .catch(() => log('device-failed', { id: short(id), code: 'problem_not_saved' })));
  }
  function schedule(myGen: number, delay: number): void {
    clearRetry();
    retryAt = now() + delay;
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      retryAt = undefined;
      if (disposed || gen !== myGen) return;
      seq++;
      void track(open(gen, seq));
      emitState();
    }, delay);
  }
  /** Attempts in route order: the last one that worked first, then the rest as stored. */
  function routeOrder(device: StoredDevice): DeviceRoute[] {
    const order: DeviceRoute[] = [];
    for (const route of [...(device.lastRoute ? [device.lastRoute] : []), ...device.routes]) {
      if (!order.some(seen => routeKey(seen) === routeKey(route))) order.push(route);
    }
    return order.slice(0, MAX_ROUTES);
  }
  /** One code for the whole device: a key it recognized decides; 4005 on every route is a device that is not this one;
   * otherwise the first route's other failure (4.4 "连" step 3). */
  function deviceCode(attempts: readonly RouteFailure[]): string {
    for (const decisive of ['client_revoked', 'unknown_client']) if (attempts.some(entry => entry.code === decisive)) return decisive;
    if (attempts.length > 0 && attempts.every(entry => entry.code === 'device_identity_changed')) return 'identity_changed';
    return attempts.find(entry => entry.code !== 'device_identity_changed')?.code ?? 'closed';
  }

  /** One attempt at the current device, up to `ready` or a failure. `connecting` stays set until it ends, so wake() does
   * not start a second one. */
  async function open(myGen: number, mySeq: number): Promise<void> {
    const abort = new AbortController();
    connecting = abort;
    try { await attemptOpen(myGen, mySeq, abort); }
    finally { if (connecting === abort) connecting = undefined; }
  }
  async function attemptOpen(myGen: number, mySeq: number, abort: AbortController): Promise<void> {
    const current = (): boolean => !disposed && gen === myGen && seq === mySeq;
    const id = viewId;
    const device = registry.get(id);
    if (!device || !current()) return;
    let key;
    try { key = registry.openKey(device); }
    catch { onFailure(myGen, mySeq, 'key_unreadable', []); return; }
    const attempts: RouteFailure[] = [];
    let opened: { link: RemoteLink; route: DeviceRoute } | undefined;
    for (const route of routeOrder(device)) {
      if (!current()) break;
      const started = now();
      try {
        const link = await connector.connect({ route, device: { id: device.deviceId, pk: device.pk }, clientKey: key, signal: abort.signal });
        opened = { link, route };
        break;
      } catch (error) {
        const failed = routeFailure(device.deviceId, route, error, started, true);
        const { code } = failed;
        if (code === 'aborted') break;
        attempts.push(failed);
        // The device knew this key: another address says the same.
        if (code === 'client_revoked' || code === 'unknown_client') break;
      }
    }
    if (!current()) { opened?.link.close(); return; }
    if (!opened) { onFailure(myGen, mySeq, deviceCode(attempts), attempts); return; }
    const { link, route } = opened;
    // A switch or a retry from here on closes it at once, not after the status read below (Codex 审查 236-2).
    const closeOnAbort = (): void => link.close();
    abort.signal.addEventListener('abort', closeOnAbort, { once: true });
    const info = link.serverInfo;
    // The channel checked the key already; this is a data directory copied to another machine.
    if (info.machineId !== device.deviceId) { link.close(); onFailure(myGen, mySeq, 'identity_changed', attempts); return; }
    const mode: ViewMode = info.protocolVersion === deps.client.protocolVersion ? 'full' : 'maintenance';
    const reply = await withTimeout(link.client.admin({ type: 'daemonStatus' }), STATUS_TIMEOUT_MS).catch(() => undefined);
    if (!current()) { link.close(); return; }
    const status = reply?.kind === 'daemonStatus' ? reply.status : undefined;
    const before = lastIdentity.get(id);
    const updated = before !== undefined && before.version !== info.version;
    const cause: Cause = !before ? 'opened'
      : status ? (status.pid === before.pid && status.startedAt === before.startedAt ? 'reopened' : 'restarted')
        : updated ? 'restarted' : 'reopened';
    const at = now();
    if (updated) notice = { kind: 'updated', from: before.version, to: info.version, at };
    else if (cause === 'restarted' && !expected) notice = { kind: 'restarted', at };
    clearExpected();
    await registry.update(id, stored => {
      const { problem: _cleared, ...rest } = stored;
      return {
        ...rest, lastRoute: route, lastConnectedAt: at,
        lastKnown: { version: info.version, protocolVersion: info.protocolVersion, ...(info.platform ? { platform: info.platform } : {}),
          ...(info.deviceName ? { deviceName: info.deviceName } : {}), at },
      };
    }).catch(() => undefined);
    if (!current()) { link.close(); return; }
    abort.signal.removeEventListener('abort', closeOnAbort);
    const view: ViewSession = { id, client: link.client, serverInfo: info, mode };
    const opening: Session = {
      id, link, info, mode, view, cause,
      ...(status?.pid === undefined ? {} : { pid: status.pid }), ...(status ? { startedAt: status.startedAt } : {}),
    };
    session = opening;
    phase = 'ready';
    attempt = 0;
    clearRetry();
    failure = undefined;
    disabledAt = undefined;
    lastMode = mode;
    lastInfo = info;
    problems.delete(id);
    lastFailure.delete(id);
    lastIdentity.set(id, { ...(opening.pid === undefined ? {} : { pid: opening.pid }), ...(opening.startedAt === undefined ? {} : { startedAt: opening.startedAt }), version: info.version });
    void link.closed.then(closed => onClosed(myGen, opening, closed));
    log('device-opened', { id: short(id), cause });
    for (const key of loggedRoutes.keys()) if (key.startsWith(`${id} `)) loggedRoutes.delete(key);
    // The bridge binds first, so a request the page sends once it reads `ready` has somewhere to go.
    emitView({ kind: 'remote', session: view, cause });
    emitState();
  }

  function onClosed(myGen: number, closing: Session, closed: { code: string; closeCode?: number }): void {
    if (disposed || gen !== myGen || closing !== session) return;
    const id = closing.id;
    log('device-closed', { id: short(id), code: closed.code, ...(closed.closeCode === undefined ? {} : { close: closed.closeCode }) });
    lastIdentity.set(id, { ...(closing.pid === undefined ? {} : { pid: closing.pid }), ...(closing.startedAt === undefined ? {} : { startedAt: closing.startedAt }), version: closing.info.version });
    session = undefined;
    emitView({ kind: 'waiting', id });
    const ownRemoval = removing === id;
    if ((closed.code === 'client_revoked' && !ownRemoval) || closed.code === 'unknown_client') {
      // In this callback, before anything else can run: no reconnect is ever scheduled for a revoked key.
      persistProblem(id, closed.code === 'client_revoked' ? 'revoked' : 'unknown_client');
      lastFailure.set(id, closed.code);
      phase = 'failed';
      clearRetry();
      failure = { code: closed.code, attempts: [], at: now() };
      emitState();
      return;
    }
    phase = 'reconnecting';
    attempt = 0;
    if (closed.code === 'remote_disabled') disabledAt = now();
    // Removing it: the removal switches away next, nothing to reconnect.
    if (!ownRemoval) schedule(myGen, backoff(0));
    emitState();
  }

  function onFailure(myGen: number, mySeq: number, code: string, attempts: readonly RouteFailure[]): void {
    if (disposed || gen !== myGen || seq !== mySeq) return;
    const id = viewId;
    lastFailure.set(id, code);
    log('device-failed', { id: short(id), code });
    failure = { code, attempts: attempts.slice(0, MAX_ROUTES), at: now() };
    const terminal = TERMINAL[code];
    if (terminal) {
      phase = 'failed';
      clearRetry();
      // Revoked and an unknown key are written down; the rest is this attempt's result (RETRYABLE).
      if (terminal === 'revoked' || terminal === 'unknown_client') persistProblem(id, terminal);
      emitState();
      return;
    }
    if (code === 'remote_disabled') disabledAt ??= now();
    attempt++;
    const delay = code === 'rate_limited' ? Math.max(RATE_LIMITED_MS, backoff(attempt - 1)) : backoff(attempt - 1);
    schedule(myGen, delay);
    emitState();
  }

  function attemptNow(): void {
    connecting?.abort();
    seq++;
    clearRetry();
    void track(open(gen, seq));
  }
  /** After a repair: the new key, whatever the problem was (retry() leaves revoked and the like alone). */
  function reconnectNow(id: string): void {
    problems.delete(id);
    lastFailure.delete(id);
    failure = undefined;
    disabledAt = undefined;
    phase = 'connecting';
    attempt = 0;
    attemptNow();
    emitState();
  }

  async function switchTo(id: ViewId): Promise<void> {
    if (disposed) throw new DeviceConnectionsError('disposed');
    if (id === viewId) {
      if (phase === 'failed') retry();
      return;
    }
    if (id !== LOCAL_VIEW && !registry.get(id)) throw new DeviceConnectionsError('unknown_device');
    gen++;
    connecting?.abort();
    connecting = undefined;
    clearRetry();
    const previous = session;
    session = undefined;
    previous?.link.close();
    failure = undefined;
    clearExpected();
    notice = undefined;
    disabledAt = undefined;
    lastMode = undefined;
    lastInfo = undefined;
    attempt = 0;
    viewId = id;
    if (id === LOCAL_VIEW) {
      phase = 'ready';
      emitView({ kind: 'local' });
      emitState();
      return;
    }
    const problem = problemOf(id);
    if (problem) {
      phase = 'failed';
      failure = { code: problem, attempts: [], at: now() };
      emitView({ kind: 'waiting', id });
      emitState();
      return;
    }
    phase = 'connecting';
    emitView({ kind: 'waiting', id });
    emitState();
    seq++;
    void track(open(gen, seq));
  }

  function retry(): void {
    if (disposed || viewId === LOCAL_VIEW || phase === 'ready') return;
    // Revoked or an unknown key: only pairing again helps.
    if (phase === 'failed' && !RETRYABLE.has(failure?.code ?? '')) return;
    if (phase === 'failed') { phase = 'connecting'; failure = undefined; }
    attempt = 0;
    attemptNow();
    emitState();
  }

  function wake(): void {
    if (disposed || viewId === LOCAL_VIEW || connecting) return;
    if (phase !== 'connecting' && phase !== 'reconnecting') return;
    attempt = 0;
    attemptNow();
    emitState();
  }

  function preview(text: string): { preview: LinkPreview; link?: PairingLink; routes?: DeviceRoute[]; existing?: StoredDevice } {
    if (text.length > 4096) return { preview: { ok: false, code: 'invalid_link' } };
    let link: PairingLink;
    try { link = decodePairingLink(text); } catch { return { preview: { ok: false, code: 'invalid_link' } }; }
    const routes = link.addresses.slice(0, MAX_ROUTES).map(address => deviceRouteSchema.safeParse(address));
    if (!UUID.test(link.device.id) || routes.some(route => !route.success)) return { preview: { ok: false, code: 'invalid_link' } };
    const parsedRoutes = routes.flatMap(route => route.success ? [route.data] : []);
    const deviceId = link.device.id;
    const name = link.device.name;
    if (link.invite.expiresAt <= now()) return { preview: { ok: false, code: 'link_expired', deviceId, name } };
    if (local.serverInfo && deviceId === local.serverInfo.machineId) return { preview: { ok: false, code: 'own_link', deviceId, name } };
    const existing = registry.get(deviceId);
    if (existing) {
      const repairable = problemOf(deviceId) !== undefined || RETRYABLE.has(lastFailure.get(deviceId) ?? '') || keyUnreadable(existing);
      if (!repairable) {
        return { preview: { ok: false, code: 'already_added', deviceId, name: existing.name, routesChanged: !sameRoutes(existing.routes, parsedRoutes) }, link, routes: parsedRoutes, existing };
      }
    }
    if (!box.available()) return { preview: { ok: false, code: 'no_secure_storage', deviceId, name } };
    if (registry.status === 'newer') return { preview: { ok: false, code: 'registry_newer', deviceId, name } };
    if (registry.status === 'unreadable') return { preview: { ok: false, code: 'registry_unreadable', deviceId, name } };
    if (!existing && registry.list().length >= MAX_DEVICES) return { preview: { ok: false, code: 'too_many', deviceId, name } };
    return {
      preview: { ok: true, deviceId, name, routes: parsedRoutes, expiresAt: link.invite.expiresAt, repair: existing !== undefined },
      link, routes: parsedRoutes, ...(existing ? { existing } : {}),
    };
  }

  function setAdding(stage: 'connecting' | 'pairing' | 'checking', route?: DeviceRoute): void {
    if (!pairing) return;
    pairing.stage = stage;
    if (route) pairing.route = route; else delete pairing.route;
    emitState();
  }
  function localName(): string {
    let fallback = '';
    try { fallback = (deps.hostname ?? osHostname)(); } catch { fallback = ''; }
    return cleanName(local.serverInfo?.deviceName || fallback, 'Vonvon Bot');
  }

  async function pair(link: PairingLink, routes: readonly DeviceRoute[], existing: StoredDevice | undefined, name: string | undefined, abort: AbortController): Promise<AddDeviceResult> {
    const attempts: RouteFailure[] = [];
    const failed = (code: string): AddDeviceResult => ({ kind: 'failed', code, attempts: attempts.slice(0, MAX_ROUTES) });
    const generated = generateKey();
    const device = { id: link.device.id, pk: link.device.pk };
    const invite = { inviteId: link.invite.id, inviteSecret: link.invite.secret, clientName: localName() };
    const connect = (route: DeviceRoute, withInvite: boolean): Promise<RemoteLink> => connector.connect({
      route, device, clientKey: generated.key, signal: abort.signal,
      ...(withInvite ? { pairing: invite } : {}),
      onSocketOpen: () => setAdding('pairing', route),
    });
    let paired: { link: RemoteLink; route: DeviceRoute; clientId: string } | undefined;
    for (const route of routes) {
      if (abort.signal.aborted) return failed('aborted');
      setAdding('connecting', route);
      const started = now();
      try {
        const linked = await connect(route, true);
        if (abort.signal.aborted) { linked.close(); return failed('aborted'); }
        paired = { link: linked, route, clientId: linked.pairResult?.clientId ?? '' };
        break;
      } catch (error) {
        const failure = error instanceof RemoteConnectError ? error : new RemoteConnectError('closed', 'socket');
        if (failure.code === 'aborted' || abort.signal.aborted) return failed('aborted');
        attempts.push(routeFailure(link.device.id, route, failure, started));
        if (failure.code === 'pairing_failed') return failed(now() >= link.invite.expiresAt ? 'link_expired' : 'link_used');
        if (failure.code === 'rate_limited') return failed('rate_limited');
        // Cut off while pairing, or after its answer while waiting for the hello (Codex 审查 235-3): the request may have been
        // taken and the invite spent, or was for sure, so the same key, no invite.
        if ((failure.stage === 'pairing' || failure.stage === 'hello') && (failure.code === 'closed' || failure.code === 'timeout')) {
          const recovered = await recoverPairing(route, connect, generated.publicKeyBase64url, abort);
          if (recovered.kind === 'paired') { paired = { ...recovered, route }; break; }
          if (recovered.kind === 'aborted') return failed('aborted');
          if (recovered.kind === 'used') return failed(now() >= link.invite.expiresAt ? 'link_expired' : 'link_used');
          return failed('pairing_interrupted');
        }
      }
    }
    if (!paired) {
      if (attempts.length > 0 && attempts.every(entry => entry.code === 'device_identity_changed')) return failed('identity_changed');
      return failed(attempts.find(entry => entry.code !== 'device_identity_changed')?.code ?? 'closed');
    }
    const { link: linked, route, clientId } = paired;
    setAdding('checking', route);
    const info = linked.serverInfo;
    if (info.machineId !== link.device.id || !clientId) { linked.close(); return failed(info.machineId !== link.device.id ? 'identity_changed' : 'pairing_interrupted'); }
    const at = now();
    const alias = name ?? existing?.name ?? cleanName(link.device.name, '未命名设备');
    try {
      if (abort.signal.aborted) throw new Error('aborted');
      const stored: StoredDevice = {
        deviceId: link.device.id, name: alias, pk: link.device.pk, clientId,
        clientKey: registry.sealKey(generated),
        routes: [...routes], lastRoute: route, addedAt: existing?.addedAt ?? at, lastConnectedAt: at,
        lastKnown: { version: info.version, protocolVersion: info.protocolVersion, ...(info.platform ? { platform: info.platform } : {}),
          ...(info.deviceName ? { deviceName: info.deviceName } : {}), at },
      };
      await registry.put(stored);
      // Cancelled while it was saved (Codex 审查 236-3): put back what was there; below takes the key back off its list.
      if (abort.signal.aborted) {
        await (existing ? registry.put(existing) : registry.remove(stored.deviceId)).catch(() => undefined);
        throw new Error('aborted');
      }
    } catch {
      // Paired over there, forgotten here: take the key back off its list while the connection is still open.
      await withTimeout(linked.client.device({ type: 'revokeClient', clientId }), REVOKE_TIMEOUT_MS).catch(() => undefined);
      linked.close();
      return failed(abort.signal.aborted ? 'aborted' : 'registry_write_failed');
    }
    linked.close();
    const id = link.device.id;
    problems.delete(id);
    lastFailure.delete(id);
    lastIdentity.delete(id);
    log('device-added', { id: short(id), repaired: existing ? 1 : 0 });
    return { kind: 'added', deviceId: id, name: alias, repaired: existing !== undefined };
  }

  /** 4.4 "添加" step 4: connect with the key alone. Paired → its client id from the list; 4002 → not registered, so pair
   * again, once. */
  async function recoverPairing(route: DeviceRoute, connect: (route: DeviceRoute, withInvite: boolean) => Promise<RemoteLink>, publicKey: string, abort: AbortController):
    Promise<{ kind: 'paired'; link: RemoteLink; clientId: string } | { kind: 'aborted' } | { kind: 'used' } | { kind: 'lost' }> {
    let invited = false;
    for (;;) {
      if (abort.signal.aborted) return { kind: 'aborted' };
      let linked: RemoteLink;
      try { linked = await connect(route, invited); }
      catch (error) {
        const code = error instanceof RemoteConnectError ? error.code : 'closed';
        if (code === 'aborted' || abort.signal.aborted) return { kind: 'aborted' };
        if (code === 'unknown_client' && !invited) { invited = true; continue; }
        if (code === 'pairing_failed') return { kind: 'used' };
        return { kind: 'lost' };
      }
      if (invited) {
        if (linked.pairResult) return { kind: 'paired', link: linked, clientId: linked.pairResult.clientId };
        linked.close();
        return { kind: 'lost' };
      }
      const reply = await withTimeout(linked.client.device({ type: 'clients' }), STATUS_TIMEOUT_MS).catch(() => undefined);
      const mine = reply?.kind === 'clients' ? reply.clients.find(client => client.publicKey === publicKey && client.revokedAt === undefined) : undefined;
      if (mine) return { kind: 'paired', link: linked, clientId: mine.id };
      linked.close();
      return { kind: 'lost' };
    }
  }

  async function add(request: AddDeviceRequest): Promise<AddDeviceResult> {
    if (disposed) throw new DeviceConnectionsError('disposed');
    if (pairing) return { kind: 'failed', code: 'busy', attempts: [] };
    const checked = preview(request.link);
    if (!checked.preview.ok) {
      const { code } = checked.preview;
      if (code === 'already_added' && checked.preview.routesChanged && checked.existing && checked.routes) {
        // Only the addresses moved: take the link's first, keep the old ones after, and leave the invite unused.
        const fresh = checked.routes;
        const merged = [...fresh, ...checked.existing.routes.filter(route => !fresh.some(other => routeKey(other) === routeKey(route)))].slice(0, MAX_ROUTES);
        try { await registry.update(checked.existing.deviceId, device => ({ ...device, routes: merged })); }
        catch { return { kind: 'failed', code: 'registry_write_failed', attempts: [] }; }
        emitState();
        return { kind: 'updated', deviceId: checked.existing.deviceId, name: checked.existing.name };
      }
      return { kind: 'failed', code, attempts: [] };
    }
    const { link, routes, existing } = checked;
    if (!link || !routes) return { kind: 'failed', code: 'invalid_link', attempts: [] };
    const abort = new AbortController();
    pairing = { abort, stage: 'connecting' };
    emitState();
    const work = track(pair(link, routes, existing, request.name === undefined ? undefined : cleanName(request.name, '未命名设备'), abort));
    let result: AddDeviceResult;
    try { result = await work; }
    finally {
      pairing = undefined;
      emitState();
    }
    // Adding failed: the page says so, and only this line is left to tell why afterwards (0.9.0 Mac 验收 S-1').
    if (result.kind === 'failed' && result.code !== 'aborted') log('device-add-failed', { id: short(link.device.id), code: result.code, routes: result.attempts.length });
    // Repaired the current device while it is stopped on its problem: connect with the new key now.
    if (result.kind === 'added' && result.repaired && viewId === result.deviceId && phase === 'failed' && !disposed) reconnectNow(result.deviceId);
    return result;
  }

  async function revokeSelf(current: Session, clientId: string): Promise<boolean> {
    const closedRevoked = current.link.closed.then(closed => closed.code === 'client_revoked');
    const replied = current.view.client.device({ type: 'revokeClient', clientId }).then(
      reply => reply.kind === 'revoked',
      // The device may close this connection (4003) before its answer arrives.
      error => error instanceof ConnectionError ? closedRevoked : false,
    );
    return withTimeout(Promise.race([replied, closedRevoked.then(revoked => revoked || replied)]), REVOKE_TIMEOUT_MS).catch(() => false);
  }

  async function remove(id: string): Promise<RemoveDeviceResult> {
    if (disposed) throw new DeviceConnectionsError('disposed');
    if (id === LOCAL_VIEW) throw new DeviceConnectionsError('local_device');
    const device = registry.get(id);
    if (!device) throw new DeviceConnectionsError('unknown_device');
    let revokedRemotely = false;
    const current = session;
    if (viewId === id && phase === 'ready' && current?.mode === 'full') {
      removing = id;
      try { revokedRemotely = await revokeSelf(current, device.clientId); }
      catch { revokedRemotely = false; }
    }
    try {
      if (viewId === id && !disposed) await switchTo(LOCAL_VIEW);
    } finally { removing = undefined; }
    await registry.remove(id);
    problems.delete(id);
    lastIdentity.delete(id);
    lastFailure.delete(id);
    log('device-removed', { id: short(id), revoked: revokedRemotely ? 1 : 0 });
    emitState();
    return { revokedRemotely };
  }

  return {
    state,
    onState(listener) { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; },
    onView(listener) { viewListeners.add(listener); return () => { viewListeners.delete(listener); }; },
    view: () => currentView,
    pairedPublicKey: id => registry.get(id)?.pk,
    switchTo,
    retry,
    wake,
    inspectLink: text => preview(text).preview,
    add,
    cancelAdd() { pairing?.abort.abort(); },
    async rename(id, name) {
      if (disposed) throw new DeviceConnectionsError('disposed');
      if (id === LOCAL_VIEW) throw new DeviceConnectionsError('local_device');
      const parsed = deviceAliasSchema.safeParse(name);
      if (!parsed.success) throw new DeviceConnectionsError('invalid_name');
      const updated = await registry.update(id, device => ({ ...device, name: parsed.data }));
      if (!updated) throw new DeviceConnectionsError('unknown_device');
      emitState();
    },
    remove,
    setLocal(next) {
      if (disposed) return;
      // Offline, the last machine id seen still tells this computer's own link apart.
      const serverInfo = next.serverInfo ?? local.serverInfo;
      local = { status: next.status, ...(serverInfo ? { serverInfo } : {}) };
      emitState();
    },
    expect(kind) {
      if (disposed || viewId === LOCAL_VIEW) return;
      clearExpected();
      const timer = timers.setTimeout(() => {
        if (expected?.timer !== timer) return;
        expected = undefined;
        emitState();
      }, EXPECTED_MS);
      expected = { kind, timer };
      emitState();
    },
    dispose() {
      disposal ??= (async () => {
        disposed = true;
        gen++;
        connecting?.abort();
        connecting = undefined;
        pairing?.abort.abort();
        clearRetry();
        clearExpected();
        const current = session;
        session = undefined;
        current?.link.close();
        for (const [timer, expire] of [...deadlines]) { timers.clearTimeout(timer); expire(); }
        if (inflight.size > 0) {
          let timer: Timer | undefined;
          await Promise.race([
            Promise.allSettled([...inflight]),
            new Promise<void>(resolve => { timer = timers.setTimeout(resolve, DISPOSE_WAIT_MS); }),
          ]);
          if (timer !== undefined) timers.clearTimeout(timer);
        }
        stateListeners.clear();
        viewListeners.clear();
      })();
      return disposal;
    },
  };
}

export { RegistryError };
