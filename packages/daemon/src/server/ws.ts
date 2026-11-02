import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { DRAIN_KINDS, helloSchema, PROTOCOL_VERSION, requestSchema, rpcKindOf, type ErrorEnvelope, type Event, type Hello, type Request, type Response, type Scope, type ServerInfo } from '@vonvon/protocol';
import { errorEnvelope } from './errors';
import type { JobPeer } from './jobs';
import type { Principal } from './principal';
import { SESSION_TOKEN_PREFIX, type SessionTokens } from '../host/session-tokens';

const DRAIN = new Set<string>(DRAIN_KINDS);

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
  send(value: Response | ErrorEnvelope): void;
  /** Closes the connection with a close code of devices 4.7 (4001 `protocol_mismatch` after too many refused requests). */
  close(code: number, reason: string): void;
}
/** What `publish` hands a peer: the event as it is, another view of it, or nothing (devices-4a 4.7). */
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
 * `info` answers the hello: the server info shape that peer's protocol reads (devices 4.5). `sessions`: a hello whose
 * credential starts `vs1.` is a Bot session's token, looked up there and never compared with the owner's (devices 5.3).
 * `view`: what each peer gets of a published event.
 */
export function createSocketServer(options: { server: Server; credential: string; sessions?: Pick<SessionTokens, 'resolve'>; info: (peer: Peer) => ServerInfo; request: (peer: Peer, request: Request) => Promise<void>; control?: (peer: Peer, request: Request) => Promise<void>; detached: (peer: Peer) => void; view?: PeerView }) {
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4_000_000 });
  const peers = new Set<Peer>();
  const accepted = new Set<Promise<void>>();
  const detachments = new Map<WebSocket, () => void>();
  let state: 'open' | 'draining' | 'released' = 'open';
  let draining: Promise<void> | undefined;
  let released: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  options.server.on('upgrade', (request, socket, head) => {
    if (state === 'released' || !loopbackHost(request.headers.host) || !loopbackOrigin(request.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws, request));
  });
  sockets.on('connection', (socket: WebSocket, upgrade?: IncomingMessage) => {
    if (state === 'released') { socket.close(1001, 'server_shutdown'); return; }
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
      peers.delete(peer);
      detachments.delete(socket);
      options.detached(peer);
    };
    const deadline = setTimeout(() => socket.close(4401, 'unauthorized'), 5000);
    deadline.unref();
    detachments.set(socket, detach);
    socket.on('close', detach);
    socket.on('error', detach);
    socket.on('message', (bytes, binary) => {
      if (state === 'released' || detached) return;
      let raw: unknown;
      try { if (binary) throw new Error('binary'); raw = JSON.parse(bytes.toString()); }
      catch {
        if (!authenticated) socket.close(4401, 'unauthorized');
        else if (state === 'draining') socket.close(1001, 'server_shutdown');
        else socket.close(1007, 'invalid_message');
        return;
      }
      if (!authenticated) {
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
        peers.add(peer);
        send(options.info(peer));
        return;
      }
      if (state === 'draining') {
        const parsed = requestSchema.safeParse(raw);
        // devices 4.7: the shared list, coreUpdateStatus included, so an update's progress stays visible.
        if (!parsed.success || !options.control || !DRAIN.has(rpcKindOf(parsed.data))) {
          socket.close(1001, 'server_shutdown');
          return;
        }
        void options.control(peer, parsed.data).catch(error => peer.send(errorEnvelope(parsed.data.id, error)));
        return;
      }
      if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string' || !raw.id) { socket.close(1007, 'invalid_message'); return; }
      const id = raw.id;
      if ('type' in raw && raw.type === 'request' && 'method' in raw && typeof raw.method === 'string' && !requestSchema.optionsMap.has(raw.method)) {
        peer.send({ type: 'error', id, code: 'unknown_method', message: '未知 RPC 方法。' });
        return;
      }
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) { peer.send({ type: 'error', id, code: 'invalid_request', message: '请求参数无效。' }); return; }
      const completion = Promise.resolve().then(() => options.request(peer, parsed.data)).catch(error => {
        peer.send(errorEnvelope(id, error));
      });
      accepted.add(completion);
      void completion.then(() => { accepted.delete(completion); }, () => { accepted.delete(completion); });
    });
  });
  function closePeers(): Promise<void> {
    const errors: unknown[] = [];
    const pending: Promise<void>[] = [];
    for (const socket of sockets.clients) {
      pending.push(new Promise<void>(resolve => {
        const detach = detachments.get(socket);
        try { detach?.(); }
        catch (error) { errors.push(error); }
        try { socket.close(1001, 'server_shutdown'); }
        catch (error) {
          errors.push(error);
          try { socket.terminate(); } catch (terminationError) { errors.push(terminationError); }
          resolve();
          return;
        }
        if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
        const deadline = setTimeout(() => {
          try { socket.terminate(); }
          catch (error) { errors.push(error); }
          resolve();
        }, 250);
        deadline.unref();
        socket.once('close', () => { clearTimeout(deadline); resolve(); });
      }));
    }
    return Promise.all(pending).then(() => {
      if (errors.length) throw new AggregateError(errors, 'Socket peer cleanup failed');
    });
  }
  function beginDrain(): Promise<void> {
    if (draining) return draining;
    if (state === 'open') state = 'draining';
    let peerCleanup: Promise<void>;
    draining = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...accepted, peerCleanup]);
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Socket drain failed');
    });
    peerCleanup = closePeers();
    return draining;
  }
  function release(): Promise<void> {
    if (released) return released;
    state = 'released';
    let peerCleanup: Promise<void>;
    let serverClosed: Promise<void>;
    released = Promise.resolve().then(async () => {
      await peerCleanup;
      await serverClosed;
    });
    peerCleanup = closePeers();
    serverClosed = new Promise<void>((resolve, reject) => {
      sockets.close(error => { if (error) reject(error); else resolve(); });
    });
    void serverClosed.catch(() => undefined);
    return released;
  }
  return {
    publish(event: Event): void {
      if (state !== 'open') return;
      for (const peer of peers) {
        const shown = options.view ? options.view(peer, event) : event;
        if (shown) peer.event(shown);
      }
    },
    beginDrain,
    release,
    close(): Promise<void> {
      if (closing) return closing;
      const work: Promise<void>[] = [];
      closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled(work);
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'Socket shutdown failed');
      });
      work.push(beginDrain(), release());
      return closing;
    },
  };
}
