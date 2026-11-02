import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CLOSE_CODES, helloSchema, pairRequestSchema, PROTOCOL_VERSION,
  type CloseReason, type ErrorEnvelope, type Event, type Hello, type PairResult, type Request, type Response, type Scope, type ServerInfo,
} from '@vonvon/protocol';
import { createResponder, decodeFrame, encodeFrame, FRAME, type Channel, type FrameType, type StaticKey } from '@vonvon/protocol/secure-channel';
import { log } from '../core/logger';
import type { ClientRegistry } from '../remote/clients';
import type { completePairing as CompletePairing, InviteBook } from '../remote/pairing';
import { handleMessage } from './message-loop';
import type { PeerHub } from './peer-hub';
import type { Principal } from './principal';
import { formatAddress, type Peer } from './ws';

/** Before a connection is authenticated no frame may be larger: `ws`'s `maxPayload` is per server, so each frame is
 * checked here (devices 4.3; D3 caps how many such connections there are). */
export const UNAUTHENTICATED_FRAME_LIMIT = 4096;
export type HandshakeFailure = 'handshake_failed' | 'unknown_client' | 'pairing_failed';
/** What the daemon has for the secure channel, whatever server it runs on (D3's remote listeners, the tests, the probe). */
export interface SecureDeps {
  hub: PeerHub;
  device: StaticKey;
  deviceName: () => string;
  clients: ClientRegistry;
  invites: InviteBook;
  completePairing: typeof CompletePairing;
  info(peer: Peer): ServerInfo;
  request(peer: Peer, request: Request): Promise<void>;
  control?(peer: Peer, request: Request): Promise<void>;
}
export interface SecureSocketServerOptions extends SecureDeps {
  server: Server;
  /** D3: Host and Origin, and how many connections are not authenticated yet; refused upgrades never reach a socket. */
  admit?(request: IncomingMessage): { ok: true } | { ok: false; status: 403 | 429 };
  /** D3: the rate limit, asked with the remote IP before any frame is read, so before any DH. */
  onHandshake?(ip: string): 'ok' | 'rate_limited';
  /** `validInvite`: the frame named an invite that exists, so the rate limit does not count an unknown key (devices 4.3). */
  onHandshakeFailed?(ip: string, reason: HandshakeFailure, validInvite: boolean): void;
  /** handshake: up to message 1; pairing: up to the pairing request, and again up to the hello; idle: once open. */
  timers?: { handshake?: number; pairing?: number; idle?: number };
}

type Phase = 'handshake' | 'unpaired' | 'pairing' | 'hello' | 'ready';
const statusText = (status: number): string => status === 429 ? 'Too Many Requests' : status === 503 ? 'Service Unavailable' : 'Forbidden';
const refuseUpgrade = (socket: Duplex, status: number): void => { socket.end(`HTTP/1.1 ${status} ${statusText(status)}\r\nConnection: close\r\n\r\n`); };

/** devices-2 4.4: the remote side of the daemon. Each connection: the Noise IK handshake (nothing else is read first), then
 * by its key: a client on the list says hello; a revoked one is told 4003; an unknown one may send one pairing request
 * within 5 seconds and nothing more. Past the hello every request goes through the loopback's message loop, after a check
 * that the client is still on the list. The hub holds the connections; a socket not past its hello never gets a publish. */
export function createSecureSocketServer(options: SecureSocketServerOptions): { close(reason?: CloseReason): Promise<void> } {
  const { hub, clients, invites } = options;
  const handshakeMs = options.timers?.handshake ?? 3_000;
  const pairingMs = options.timers?.pairing ?? 5_000;
  const idleMs = options.timers?.idle ?? 60_000;
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4_000_000 });
  /** This server's connections, for its own close (the hub holds every server's). */
  const own = new Map<WebSocket, () => void>();
  let closing: Promise<void> | undefined;
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (closing || hub.state === 'released') { refuseUpgrade(socket, 503); return; }
    const admitted = options.admit?.(request) ?? { ok: true };
    if (!admitted.ok) { refuseUpgrade(socket, admitted.status); return; }
    sockets.handleUpgrade(request, socket, head, ws => accept(ws, request));
  };
  options.server.on('upgrade', upgrade);

  function accept(socket: WebSocket, upgraded: IncomingMessage): void {
    const ip = upgraded.socket.remoteAddress ?? 'unknown';
    const address = formatAddress(upgraded.socket.remoteAddress, upgraded.socket.remotePort);
    let phase: Phase = 'handshake';
    let detached = false;
    let channel: Channel | undefined;
    let clientId: string | undefined;
    let clientKind: Hello['clientKind'] | undefined;
    let principal: Principal = { kind: 'unpaired' };
    let protocolVersion = 0;
    let negotiated: { capabilities: readonly string[]; scope: Scope | null } | undefined;
    let timer: NodeJS.Timeout | undefined;
    /** The key message 1 authenticated: the one a pairing registers (a pairing request carries none). */
    let pairingKey = '';
    const frame = (type: FrameType, body?: Buffer): void => {
      if (!channel || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 8_000_000) { socket.close(1013, 'slow_consumer'); detach(); return; }
      socket.send(channel.encrypt(encodeFrame(type, body)), error => { if (error) { socket.terminate(); detach(); } });
    };
    const send = (value: Response | ErrorEnvelope | Event | ServerInfo | PairResult): void => frame(FRAME.json, Buffer.from(JSON.stringify(value), 'utf8'));
    const peer: Peer = {
      id: randomUUID(), get open() { return phase === 'ready' && !detached && socket.readyState === WebSocket.OPEN; }, get clientKind() { return clientKind; },
      get principal() { return principal; }, get protocolVersion() { return protocolVersion; },
      get capabilities() { return negotiated?.capabilities ?? []; }, get scope() { return negotiated?.scope ?? null; }, get negotiated() { return negotiated !== undefined; },
      address,
      negotiate(capabilities, scope) {
        if (negotiated) return false;
        negotiated = { capabilities: [...capabilities], scope };
        return true;
      },
      send, event: send,
    };
    const detach = (): void => {
      if (detached) return;
      detached = true;
      clearTimeout(timer);
      own.delete(socket);
      hub.remove(peer);
    };
    const close = (reason: CloseReason): void => { detach(); socket.close(CLOSE_CODES[reason], reason); };
    const failed = (reason: HandshakeFailure, validInvite = false): void => {
      close(reason);
      options.onHandshakeFailed?.(ip, reason, validInvite);
    };
    const deadline = (ms: number, expire: () => void): void => {
      clearTimeout(timer);
      timer = setTimeout(expire, ms);
      timer.unref();
    };
    own.set(socket, detach);
    hub.attach(socket, detach);
    socket.on('close', detach);
    socket.on('error', detach);
    if (hub.state === 'released') { close('server_shutdown'); return; }
    // Before a single frame is read: a rate-limited address costs no DH.
    if (options.onHandshake?.(ip) === 'rate_limited') { close('rate_limited'); return; }
    deadline(handshakeMs, () => failed('handshake_failed'));

    /** A paired key (on the list, not revoked) goes on to its hello. */
    const paired = (id: string): void => {
      clientId = id;
      principal = { kind: 'owner', via: 'paired', clientId: id, generation: clients.generation };
      clients.touch(id, address);
      phase = 'hello';
      deadline(pairingMs, () => close('handshake_failed'));
    };
    const stillPaired = (): boolean => {
      const record = clientId === undefined ? undefined : clients.get(clientId);
      return !!record && record.revokedAt === undefined;
    };
    const handshake = (bytes: Buffer, binary: boolean): void => {
      if (!binary || bytes.length > UNAUTHENTICATED_FRAME_LIMIT) { failed('handshake_failed'); return; }
      const responder = createResponder(options.device);
      let remoteKey: Buffer;
      try { remoteKey = responder.readMessage1(bytes).remoteStaticPublicKey; }
      catch { failed('handshake_failed'); return; }
      const publicKey = remoteKey.toString('base64url');
      const record = clients.byPublicKey(publicKey);
      const answer = responder.message2();
      channel = answer.channel;
      socket.send(answer.bytes);
      // The client gets its message 2 either way: what follows is a close it can tell apart, not a failed handshake.
      if (record?.revokedAt !== undefined) { close('client_revoked'); return; }
      if (record) { paired(record.id); return; }
      phase = 'unpaired';
      deadline(pairingMs, () => failed('unknown_client'));
      pairingKey = publicKey;
    };
    const unpaired = (text: string | undefined): void => {
      let raw: unknown;
      try { raw = text === undefined ? undefined : JSON.parse(text); } catch { raw = undefined; }
      const inviteId = raw && typeof raw === 'object' && 'inviteId' in raw && typeof raw.inviteId === 'string' ? raw.inviteId : undefined;
      const validInvite = inviteId !== undefined && invites.has(inviteId);
      const request = pairRequestSchema.safeParse(raw);
      if (!request.success) { failed('unknown_client', validInvite); return; }
      phase = 'pairing';
      clearTimeout(timer);
      void options.completePairing({ invites, clients, device: { get name() { return options.deviceName(); } }, publish: event => hub.publish(event), log }, { publicKey: pairingKey, request: request.data, address })
        .then(result => {
          if (detached) return;
          send({ type: 'pairResult', clientId: result.clientId, deviceName: result.deviceName });
          paired(result.clientId);
        }, error => {
          if (detached) return;
          const code = error instanceof Error && 'code' in error ? error.code : undefined;
          if (code === 'pairing_failed') { failed('pairing_failed', validInvite); return; }
          if (code === 'client_revoked') { close('client_revoked'); return; }
          // The invite is spent and the key not written (a full disk, say): no answer that would say it paired.
          log.warn('device', 'pairing-write-failed', { address, error: error instanceof Error ? error.message : String(error) });
          detach();
          socket.close(1011, 'internal_error');
        });
    };
    const hello = (text: string | undefined): void => {
      let raw: unknown;
      try { raw = text === undefined ? undefined : JSON.parse(text); } catch { raw = undefined; }
      const parsed = helloSchema.safeParse(raw);
      // No credential of any kind over the channel: the key is the authorization (devices 4.4, 5.3).
      if (!parsed.success || parsed.data.credential !== undefined) { close('unauthorized'); return; }
      if (!stillPaired()) { close('client_revoked'); return; }
      clientKind = parsed.data.clientKind;
      protocolVersion = parsed.data.protocolVersion;
      if (protocolVersion !== PROTOCOL_VERSION) principal = { kind: 'maintenance', protocolVersion, inner: 'owner:paired' };
      phase = 'ready';
      hub.add(peer, socket);
      deadline(idleMs, () => close('server_shutdown'));
      send(options.info(peer));
    };
    socket.on('message', (data, binary) => {
      if (detached || hub.state === 'released') return;
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (phase === 'handshake') { handshake(bytes, binary); return; }
      if (phase !== 'ready' && bytes.length > UNAUTHENTICATED_FRAME_LIMIT) {
        if (phase === 'unpaired') failed('unknown_client'); else close('policy_violation');
        return;
      }
      let plain: { type: FrameType; body: Buffer };
      try {
        if (!channel || !binary) throw new Error('not a channel frame');
        plain = decodeFrame(channel.decrypt(bytes));
      } catch {
        if (phase === 'unpaired') failed('unknown_client'); else close('policy_violation');
        return;
      }
      const text = plain.type === FRAME.json ? plain.body.toString('utf8') : undefined;
      switch (phase) {
        case 'unpaired': unpaired(text); return;
        // Nothing comes while the pairing is written: the client waits for its result.
        case 'pairing': close('policy_violation'); return;
        case 'hello':
          if (plain.type === FRAME.ping) { frame(FRAME.pong); return; }
          hello(text);
          return;
        case 'ready':
          deadline(idleMs, () => close('server_shutdown'));
          if (plain.type === FRAME.ping) { frame(FRAME.pong); return; }
          if (plain.type === FRAME.pong) return;
          // Before every request: revoked since this connection said hello means closed now (D3 closes it at once too).
          if (!stillPaired()) { close('client_revoked'); return; }
          handleMessage(hub, peer, text, { request: options.request, ...(options.control ? { control: options.control } : {}), close: (code, reason) => { socket.close(code, reason); } });
          return;
      }
    });
  }

  return {
    /** Stops taking connections and closes this server's own, with `reason`'s code (D3: `remote_disabled` for an address turned off). */
    close(reason = 'server_shutdown') {
      if (closing) return closing;
      options.server.off('upgrade', upgrade);
      const pending = [...own.entries()].map(([socket, detach]) => new Promise<void>(resolve => {
        detach();
        if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
        const deadline = setTimeout(() => { socket.terminate(); resolve(); }, 250);
        deadline.unref();
        socket.once('close', () => { clearTimeout(deadline); resolve(); });
        socket.close(CLOSE_CODES[reason], reason);
      }));
      closing = Promise.all(pending).then(() => new Promise<void>((resolve, reject) => { sockets.close(error => { if (error) reject(error); else resolve(); }); }));
      return closing;
    },
  };
}
