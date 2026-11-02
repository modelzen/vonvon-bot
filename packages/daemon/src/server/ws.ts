import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { helloSchema, PROTOCOL_VERSION, type ErrorEnvelope, type Event, type Hello, type Request, type Response, type Scope, type ServerInfo } from '@vonvon/protocol';
import { handleMessage } from './message-loop';
import { createPeerHub, type PeerHub } from './peer-hub';
import type { JobPeer } from './jobs';
import type { Principal } from './principal';
import { SESSION_TOKEN_PREFIX, type SessionTokens } from '../host/session-tokens';

export interface Peer extends JobPeer {
  /** What the client said it is in its hello; every request comes after it. */
  readonly clientKind?: Hello['clientKind'];
  /** Who the connection acts as (devices 5.1), set by the hello; `protocolVersion` is the hello's, not the daemon's. */
  readonly principal: Principal; readonly protocolVersion: number;
  /** What admin.negotiate recorded, empty and null until then; `negotiate` answers false when this connection already did. */
  readonly capabilities: readonly string[]; readonly scope: Scope | null; readonly negotiated: boolean;
  negotiate(capabilities: readonly string[], scope: Scope | null): boolean;
  /** The remote end, `ip:port` (`[ip]:port` for IPv6). */
  readonly address: string;
  /** A secure-channel connection: the paired client whose key it proved, whatever its principal (a maintenance one has
   * no client id): what D3 matches a revoked client's connections by. Undefined on the loopback. */
  readonly clientId?: string;
  send(value: Response | ErrorEnvelope): void;
  /** Closes the connection with a close code of devices 4.7: the message loop's 1001 and 1007, 4001 `protocol_mismatch` after
   * too many refused requests. A secure-channel connection says it inside the channel too. */
  close(code: number, reason: string): void;
}
/** What the hub's `publish` hands a peer: the event as it is, another view of it, or nothing (devices-4a 4.7). */
export type PeerView = (peer: Peer, event: Event) => Event | null;
export const formatAddress = (host: string | undefined, port: number | undefined): string =>
  `${host?.includes(':') ? `[${host}]` : host ?? 'unknown'}:${port ?? 0}`;
/** devices 4.5: a 0.8 client parses strictly, so it does not get the startedAt protocol 2 added, nor the device event it has no schema for. */
function forProtocol1(value: Response | ErrorEnvelope | Event | ServerInfo): unknown {
  if (value.type === 'event' && value.event === 'device') return undefined;
  if (value.type === 'error' && value.details) { const { details: _added, ...error } = value; return error; }
  if (value.type !== 'response' || value.method !== 'admin' || value.payload.kind !== 'daemonStatus') return value;
  const { startedAt: _added, ...status } = value.payload.status;
  return { ...value, payload: { ...value.payload, status } };
}
function loopbackHost(host: string | undefined): boolean {
  return !!host && /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host);
}
function loopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try { const url = new URL(origin); return (url.protocol === 'http:' || url.protocol === 'https:') && loopbackHost(url.host); }
  catch { return false; }
}
/**
 * `info` answers the hello: the server info shape that peer's protocol reads (devices 4.5). The loopback socket: the hello
 * with the local credential or a Bot session's token, then the shared message loop; its peers live in `hub` (one of its own
 * when none is given). `sessions`: a hello whose credential starts `vs1.` is a Bot session's token, looked up there and never
 * compared with the owner's (devices 5.3). Only this socket takes one: the secure channel refuses any credential (devices-2 4.4).
 */
export function createSocketServer(options: { server: Server; credential: string; sessions?: Pick<SessionTokens, 'resolve'>; info: (peer: Peer) => ServerInfo; request: (peer: Peer, request: Request) => Promise<void>; control?: (peer: Peer, request: Request) => Promise<void>; detached?: (peer: Peer) => void; hub?: PeerHub }) {
  const hub = options.hub ?? createPeerHub({ detached: peer => options.detached?.(peer) });
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4_000_000 });
  let released: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  options.server.on('upgrade', (request, socket, head) => {
    if (hub.state === 'released' || !loopbackHost(request.headers.host) || !loopbackOrigin(request.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws, request));
  });
  sockets.on('connection', (socket: WebSocket, upgrade?: IncomingMessage) => {
    if (hub.state === 'released') { socket.close(1001, 'server_shutdown'); return; }
    let authenticated = false;
    let detached = false;
    let clientKind: Hello['clientKind'] | undefined;
    let principal: Principal = { kind: 'unpaired' };
    let protocolVersion = 0;
    let negotiated: { capabilities: readonly string[]; scope: Scope | null } | undefined;
    const send = (value: Response | ErrorEnvelope | Event | ServerInfo): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 8_000_000) { socket.close(1013, 'slow_consumer'); detach(); return; }
      const frame = protocolVersion === 1 ? forProtocol1(value) : value;
      if (frame === undefined) return;
      socket.send(JSON.stringify(frame), error => { if (error) { socket.terminate(); detach(); } });
    };
    const peer: Peer = {
      id: randomUUID(), get open() { return authenticated && !detached && socket.readyState === WebSocket.OPEN; }, get clientKind() { return clientKind; },
      get principal() { return principal; }, get protocolVersion() { return protocolVersion; },
      get capabilities() { return negotiated?.capabilities ?? []; }, get scope() { return negotiated?.scope ?? null; }, get negotiated() { return negotiated !== undefined; },
      address: formatAddress(upgrade?.socket.remoteAddress, upgrade?.socket.remotePort),
      negotiate(capabilities, scope) {
        if (negotiated) return false;
        negotiated = { capabilities: [...capabilities], scope };
        return true;
      },
      send, event: send,
      close(code, reason) { socket.close(code, reason); },
    };
    const detach = (): void => {
      if (detached) return;
      detached = true;
      clearTimeout(deadline);
      hub.remove(peer);
    };
    const deadline = setTimeout(() => socket.close(4401, 'unauthorized'), 5000);
    deadline.unref();
    hub.attach(socket, detach);
    socket.on('close', detach);
    socket.on('error', detach);
    socket.on('message', (bytes, binary) => {
      if (hub.state === 'released' || detached) return;
      if (authenticated) { handleMessage(hub, peer, binary ? undefined : bytes.toString(), { request: options.request, ...(options.control ? { control: options.control } : {}) }); return; }
      let raw: unknown;
      try { if (binary) throw new Error('binary'); raw = JSON.parse(bytes.toString()); }
      catch { socket.close(4401, 'unauthorized'); return; }
      const hello = helloSchema.safeParse(raw);
      const credential = hello.success ? hello.data.credential : undefined;
      if (hello.success && credential?.startsWith(SESSION_TOKEN_PREFIX)) {
        // A Bot session (devices 5.3): its token, not the owner's credential. Its CLI is this daemon's own, so no maintenance subset.
        const session = options.sessions?.resolve(credential);
        if (!session) { socket.close(4401, 'invalid_session_token'); return; }
        if (hello.data.protocolVersion !== PROTOCOL_VERSION) { socket.close(4001, 'protocol_mismatch'); return; }
        principal = { kind: 'bot-session', sessionId: session.sessionId, appId: session.appId, place: session.place, ...(session.chatId ? { chatId: session.chatId } : {}) };
      } else {
        const supplied = Buffer.from(credential ?? '');
        const expected = Buffer.from(options.credential);
        if (!hello.success || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { socket.close(4401, 'unauthorized'); return; }
        principal = hello.data.protocolVersion === PROTOCOL_VERSION ? { kind: 'owner', via: 'local' } : { kind: 'maintenance', protocolVersion: hello.data.protocolVersion, inner: 'owner:local' };
      }
      authenticated = true;
      clientKind = hello.data.clientKind;
      protocolVersion = hello.data.protocolVersion;
      clearTimeout(deadline);
      hub.add(peer, socket);
      send(options.info(peer));
    });
  });
  function release(): Promise<void> {
    if (released) return released;
    const peerCleanup = hub.release();
    const serverClosed = new Promise<void>((resolve, reject) => {
      sockets.close(error => { if (error) reject(error); else resolve(); });
    });
    void serverClosed.catch(() => undefined);
    released = Promise.resolve().then(async () => {
      await peerCleanup;
      await serverClosed;
    });
    return released;
  }
  return {
    publish(event: Event): void { hub.publish(event); },
    beginDrain: () => hub.beginDrain(),
    release,
    close(): Promise<void> {
      if (closing) return closing;
      const work: Promise<void>[] = [];
      closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled(work);
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'Socket shutdown failed');
      });
      work.push(hub.beginDrain(), release());
      return closing;
    },
  };
}
