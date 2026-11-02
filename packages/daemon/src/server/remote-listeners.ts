import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { PROTOCOL_VERSION, type AddressKind, type CloseReason } from '@vonvon/protocol';
import type { log as logger } from '../core/logger';
import { exposure, hasAddress, hostHeader, interfaceFor, overlayOf, type Interfaces } from '../remote/address';
import type { RemoteAddress, RemoteConfig } from '../remote/config';
import type { RateLimiter } from '../remote/rate-limit';
import { createSecureSocketServer, type SecureDeps, type SecureSocketServerOptions } from './secure-socket';

export type RemoteAddressState = 'listening' | 'waiting' | 'needs-confirmation' | 'disabled' | 'failed';
export interface RemoteAddressStatus { host: string; kind: AddressKind; enabledAt: number; state: RemoteAddressState; detail?: string }
export interface RemoteListeners {
  /** Brings the listeners in line with `config`: a new address is bound, one gone is closed (its connections 4006), a new
   * port rebinds them all. Settles once each address listens, waits or failed. */
  sync(config: RemoteConfig): Promise<void>;
  /** The addresses of the last `sync`, each with what its listener does now. */
  status(): RemoteAddressStatus[];
  /** No more binding, retrying or watching. The listeners stay open (devices 4.7: a draining daemon answers DRAIN_KINDS
   * remotely as on the loopback, to connections that pass the same channel and limits); the hub drains the connections. */
  beginDrain(): Promise<void>;
  /** Closes every remote server, its connections with 1001, and settles once each has closed; no timer is left. */
  release(): Promise<void>;
  onChange(listener: () => void): () => void;
}
export interface RemoteListenerDeps {
  secure: SecureDeps;
  limiter: RateLimiter;
  log: Pick<typeof logger, 'info' | 'warn'>;
  interfaces: () => Interfaces;
  networkIdentity: (iface: string) => Promise<string | undefined>;
  /** retry: a bind that waits for its address or port; watch: a listening address still on this machine. */
  timers?: { retry?: number; watch?: number };
  /** The secure channel's own timers (the tests shorten them). */
  secureTimers?: SecureSocketServerOptions['timers'];
}

// devices 第 15 节 and D3 4.5
const waitingFor = (host: string): string => `等待地址 ${host} 出现`;
const portBusy = (port: number): string => `端口 ${port} 被占用，每 15 秒重试；可用 \`vonvon remote port <n>\` 换端口`;
const networkChanged = (host: string): string => `这台设备所在的网络变了（之前在另一个局域网开启了 ${host}）。确认现在的网络是你信任的，再重新开启。`;
const overlayLeft = (host: string): string => `${host} 现在不在组网工具的网卡上了（可能是别的网络分到了同一个地址）。确认现在的网络是你信任的，再重新开启。`;
const HEALTH = JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION });

interface Entry {
  address: RemoteAddress;
  port: number;
  state: RemoteAddressState;
  detail?: string;
  server?: Server;
  /** Every TCP connection the server took: an upgraded one leaves the HTTP server's own list, which closeAllConnections uses. */
  connections?: Set<Socket>;
  secure?: { close(reason?: CloseReason): Promise<void> };
  /** Settles once the server listens or failed to. */
  binding?: Promise<void>;
  timer?: NodeJS.Timeout;
  stopped: boolean;
  /** One step at a time per address: a bind, a check, a close. */
  turn: Promise<void>;
}

/** devices 4.2, D3 4.5: one http.Server per opened address, on the fixed port, beside the loopback one. It answers only
 * `GET /health` and the secure channel's upgrade, to a Host that is exactly this address and port and no Origin. */
export function createRemoteListeners(deps: RemoteListenerDeps): RemoteListeners {
  const retryMs = deps.timers?.retry ?? 15_000;
  const watchMs = deps.timers?.watch ?? 15_000;
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let latest: RemoteConfig | undefined;
  let turn: Promise<void> = Promise.resolve();
  let drained = false;
  let releasing: Promise<void> | undefined;
  /** Addresses being closed, those a sync took out of `entries` too: the release waits for them. */
  const stopping = new Set<Promise<void>>();
  const changed = (): void => { for (const listener of listeners) { try { listener(); } catch { /* the listener's own */ } } };
  const queue = (entry: Entry, step: () => Promise<void>): Promise<void> => {
    const run = entry.turn.then(step);
    entry.turn = run.catch(() => undefined);
    return entry.turn;
  };
  const later = (entry: Entry, ms: number, step: () => Promise<void>): void => {
    clearTimeout(entry.timer);
    if (!live(entry)) return;
    entry.timer = setTimeout(() => { entry.timer = undefined; void queue(entry, step); }, ms);
    entry.timer.unref();
  };
  /** The state, logged once when it changes (a retry every 15 s does not log again). */
  function set(entry: Entry, state: RemoteAddressState, detail?: string, code?: string): void {
    if (entry.state === state && entry.detail === detail) return;
    entry.state = state;
    if (detail === undefined) delete entry.detail; else entry.detail = detail;
    const { host, kind } = entry.address;
    if (state === 'listening') deps.log.info('remote', 'remote-listening', { host, port: entry.port, kind });
    else if (state === 'needs-confirmation') deps.log.warn('remote', 'remote-network-changed', { host, iface: entry.address.iface });
    else if (state === 'waiting' && code === 'EADDRINUSE') deps.log.warn('remote', 'remote-bind-failed', { host, port: entry.port, code });
    else if (state === 'waiting') deps.log.info('remote', 'remote-bind-waiting', { host, port: entry.port });
    else if (state === 'failed') deps.log.warn('remote', 'remote-bind-failed', { host, port: entry.port, code });
    changed();
  }
  function live(entry: Entry): boolean { return !entry.stopped && !drained; }

  /**
   * devices 4.2: whether a LAN address is still on the network it was opened on. The interface that carries it now comes
   * first (Codex review 233-1): another one than recorded is another network, whatever its gateway (a dock unplugged, Wi-Fi
   * on another network with the same IP; the old interface may be gone with its gateway). On that interface, the
   * gateway's MAC if one was recorded: another one is another network, none seen yet is `unknown`.
   */
  async function lanCheck(address: RemoteAddress): Promise<'absent' | 'same' | 'changed' | 'unknown'> {
    const current = interfaceFor(address.host, deps.interfaces())?.name;
    if (current === undefined) return 'absent';
    if (address.iface !== undefined && current !== address.iface) return 'changed';
    if (address.network === undefined) return 'same';
    const network = await deps.networkIdentity(current);
    return network === undefined ? 'unknown' : network === address.network ? 'same' : 'changed';
  }
  /**
   * A1: an overlay address stays one only on a network tool's interface (address.ts `overlayOf`). Which one does not
   * matter: macOS numbers its tunnels anew (utun3 one day, utun5 the next), so the name is not compared and the owner is
   * not asked after every restart. The same IP on Wi-Fi or a cable is another network handing it out, as with a LAN.
   */
  function overlayCheck(address: RemoteAddress): 'absent' | 'same' | 'changed' {
    const current = interfaceFor(address.host, deps.interfaces())?.name;
    if (current === undefined) return 'absent';
    return overlayOf(current) ? 'same' : 'changed';
  }
  /** A LAN address binds only on the network it was opened on: another one waits for the owner, one not known yet (no
   * route or gateway seen) waits like a missing address; a missing address tries, and waits. An overlay address binds
   * only on a network tool's interface. */
  async function ensure(entry: Entry): Promise<void> {
    if (!live(entry)) return;
    const { address } = entry;
    if (address.kind === 'overlay' && overlayCheck(address) === 'changed') { set(entry, 'needs-confirmation', overlayLeft(address.host)); return; }
    if (address.kind === 'lan') {
      const check = await lanCheck(address);
      if (!live(entry)) return;
      if (check === 'changed') { set(entry, 'needs-confirmation', networkChanged(address.host)); return; }
      if (check === 'unknown') { set(entry, 'waiting', waitingFor(address.host)); later(entry, retryMs, () => ensure(entry)); return; }
    }
    await bind(entry);
  }
  function bind(entry: Entry): Promise<void> {
    const { host, kind } = entry.address;
    let port = entry.port;
    const handler = (request: IncomingMessage, response: ServerResponse): void => {
      if (!allowed(request)) { response.writeHead(403); response.end(); return; }
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(HEALTH) });
        response.end(HEALTH);
        return;
      }
      response.writeHead(404);
      response.end();
    };
    // DNS rebinding and cross-site WebSockets: only this address and port as the Host, and no browser (devices 4.2).
    const allowed = (request: IncomingMessage): boolean => request.headers.origin === undefined && request.headers.host?.toLowerCase() === hostHeader(host, port).toLowerCase();
    const server = createServer(handler);
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    const connections = new Set<Socket>();
    server.on('connection', (socket: Socket) => { connections.add(socket); socket.once('close', () => { connections.delete(socket); }); });
    const unauthenticated = new WeakMap<Socket, { ip: string; authenticated: boolean }>();
    const secure = createSecureSocketServer({
      ...deps.secure, server, listenerId: host, ...(deps.secureTimers ? { timers: deps.secureTimers } : {}),
      admit(request) {
        if (!allowed(request)) return { ok: false, status: 403 };
        const ip = request.socket.remoteAddress ?? 'unknown';
        if (deps.limiter.connectionOpened(ip) === 'too_many') return { ok: false, status: 429 };
        const counted = { ip, authenticated: false };
        unauthenticated.set(request.socket, counted);
        request.socket.once('close', () => { deps.limiter.connectionClosed(ip, counted.authenticated); });
        return { ok: true };
      },
      onHandshake: ip => deps.limiter.handshakeStarted(ip, exposure(kind)),
      onHandshakeFailed(ip, reason, validInvite) {
        deps.limiter.handshakeFailed(ip, reason, validInvite);
        deps.log.warn('remote', reason === 'pairing_failed' ? 'pairing-refused' : 'handshake-rejected', { ip, reason, host });
      },
      onAuthenticated(request) {
        const counted = unauthenticated.get(request.socket);
        if (!counted || counted.authenticated) return;
        counted.authenticated = true;
        deps.limiter.connectionAuthenticated(counted.ip);
      },
    });
    entry.server = server;
    entry.connections = connections;
    entry.secure = secure;
    entry.binding = new Promise<void>(resolve => {
      let listening = false;
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (listening) { deps.log.warn('remote', 'remote-server-error', { host, code: error.code }); return; }
        resolve();
        entry.server = undefined;
        entry.connections = undefined;
        entry.secure = undefined;
        entry.binding = undefined;
        void secure.close();
        if (!live(entry)) return;
        if (error.code === 'EADDRNOTAVAIL' || error.code === 'EADDRINUSE') {
          set(entry, 'waiting', error.code === 'EADDRINUSE' ? portBusy(entry.port) : waitingFor(host), error.code);
          later(entry, retryMs, () => ensure(entry));
        } else set(entry, 'failed', error.code ?? error.message, error.code);
      });
      server.once('listening', () => {
        listening = true;
        resolve();
        const bound = server.address();
        if (bound && typeof bound !== 'string') port = bound.port;
        // A bind that ends while draining listens too, until the release; it is not watched.
        if (entry.stopped) return;
        set(entry, 'listening');
        later(entry, watchMs, () => watch(entry));
      });
      server.listen(entry.port, host);
    });
    return entry.binding;
  }
  /** An address that left this machine (devices 4.2) goes back to waiting; a LAN address on another interface or network,
   * or an overlay one off a network tool's interface, now waits for the owner. Either way its connections end with 4006.
   * A network not seen for a moment keeps it. */
  async function watch(entry: Entry): Promise<void> {
    if (!live(entry) || entry.state !== 'listening') return;
    const { address } = entry;
    let next: { state: RemoteAddressState; detail: string } | undefined;
    if (!hasAddress(address.host, deps.interfaces())) next = { state: 'waiting', detail: waitingFor(address.host) };
    else if (address.kind === 'overlay' && overlayCheck(address) === 'changed') next = { state: 'needs-confirmation', detail: overlayLeft(address.host) };
    else if (address.kind === 'lan' && await lanCheck(address) === 'changed') next = { state: 'needs-confirmation', detail: networkChanged(address.host) };
    if (!live(entry)) return;
    if (!next) { later(entry, watchMs, () => watch(entry)); return; }
    await teardown(entry, 'remote_disabled');
    if (!live(entry)) return;
    set(entry, next.state, next.detail);
    if (next.state === 'waiting') later(entry, retryMs, () => ensure(entry));
  }
  async function teardown(entry: Entry, reason: CloseReason): Promise<void> {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    await entry.binding;
    const { server, secure, connections } = entry;
    entry.server = undefined;
    entry.connections = undefined;
    entry.secure = undefined;
    entry.binding = undefined;
    // The channel's connections first, each told why inside it; then whatever is left (a /health keep-alive, a refused
    // upgrade, one still in its HTTP request) is cut, or the server's close would wait for it.
    await secure?.close(reason);
    if (!server?.listening) return;
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
      for (const socket of connections ?? []) socket.destroy();
    });
  }
  /** Ends an address for good: no step after this one, and the timer goes now, not at its turn. */
  function stop(entry: Entry, reason: CloseReason): Promise<void> {
    entry.stopped = true;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const stopped = queue(entry, () => teardown(entry, reason));
    stopping.add(stopped);
    void stopped.then(() => { stopping.delete(stopped); });
    return stopped;
  }
  function start(address: RemoteAddress, port: number): Entry {
    const entry: Entry = { address, port, state: 'waiting', stopped: false, turn: Promise.resolve() };
    entries.set(address.host, entry);
    void queue(entry, () => ensure(entry));
    return entry;
  }

  /** Codex review 232-2: draining only stops what would bind or close an address later; the release closes them. */
  function beginDrain(): Promise<void> {
    if (drained) return Promise.resolve();
    drained = true;
    for (const entry of entries.values()) { clearTimeout(entry.timer); entry.timer = undefined; }
    return Promise.resolve();
  }

  return {
    sync(config) {
      latest = config;
      const run = turn.then(async () => {
        if (drained) return;
        const work: Promise<void>[] = [];
        const wanted = new Map(config.addresses.map(address => [address.host, address]));
        for (const [host, entry] of entries) {
          const next = wanted.get(host);
          if (next && entry.port === config.port && (entry.state === 'listening' || JSON.stringify(next) === JSON.stringify(entry.address))) {
            // Opened again while listening: the record is new (its network is confirmed), the connections stay.
            entry.address = next;
            wanted.delete(host);
            continue;
          }
          entries.delete(host);
          work.push(stop(entry, 'remote_disabled'));
        }
        await Promise.all(work);
        if (drained) return;
        const started = [...wanted.values()].map(address => start(address, config.port));
        changed();
        await Promise.all(started.map(entry => entry.turn));
      });
      turn = run.catch(() => undefined);
      return run;
    },
    status() {
      return (latest?.addresses ?? []).map(({ host, kind, enabledAt }) => {
        const entry = entries.get(host);
        return { host, kind, enabledAt, state: entry?.state ?? 'waiting', ...(entry?.detail === undefined ? {} : { detail: entry.detail }) };
      });
    },
    beginDrain,
    release() {
      releasing ??= (async () => {
        await beginDrain();
        for (const entry of entries.values()) void stop(entry, 'server_shutdown');
        while (stopping.size) await Promise.all(stopping);
      })();
      return releasing;
    },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
