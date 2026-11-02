import { WebSocket } from 'ws';
import type { Event } from '@vonvon/protocol';
import type { Peer } from './ws';

export type HubState = 'open' | 'draining' | 'released';
/** devices-2 4.3: the daemon's connections, whichever server took them (loopback today, the remote listeners from D3):
 * one place that publishes, drains and closes them all. */
export interface PeerHub {
  readonly state: HubState;
  /** The connections whose hello was accepted: they get `publish`, `closeWhere` looks among them. */
  readonly peers: ReadonlySet<Peer>;
  /** Every socket from its first moment, its handshake done or not, with its connection's detach: `closePeers` and
   * `release` close it until its close event. `announce` says the close inside the connection first (the secure
   * channel's authenticated close frame), right before the hub closes the socket. */
  attach(socket: WebSocket, detach: () => void, announce?: (code: number, reason: string) => void): void;
  add(peer: Peer, socket: WebSocket): void;
  /** The connection ended (the connection's detach calls it once): out of `peers`, and `detached(peer)`. */
  remove(peer: Peer): void;
  /** To the open peers; `shape` may give a peer its own version of the event, or nothing (D4a's filterSnapshot). */
  publish(event: Event, shape?: (peer: Peer) => Event | null): void;
  /** A request still being answered: draining waits for it. */
  track(promise: Promise<unknown>): void;
  /** Stops publishing, closes every socket and settles once the tracked requests have. */
  beginDrain(): Promise<void>;
  closePeers(code?: number, reason?: string): Promise<void>;
  /** D3: a revoked client's or a disabled address's connections. */
  closeWhere(pred: (peer: Peer) => boolean, code: number, reason: string): void;
  release(): Promise<void>;
}

export function createPeerHub(options: { detached(peer: Peer): void }): PeerHub {
  let state: HubState = 'open';
  const peers = new Set<Peer>();
  const sockets = new Map<Peer, WebSocket>();
  const attached = new Map<WebSocket, { detach(): void; announce?: ((code: number, reason: string) => void) | undefined }>();
  const accepted = new Set<Promise<unknown>>();
  let draining: Promise<void> | undefined;
  let released: Promise<void> | undefined;
  /** Detached first, so nothing more reaches it; closed, and terminated when the peer does not answer within 250 ms. */
  function closeSocket(socket: WebSocket, code: number, reason: string, errors: unknown[]): Promise<void> {
    return new Promise<void>(resolve => {
      const connection = attached.get(socket);
      try { connection?.detach(); connection?.announce?.(code, reason); }
      catch (error) { errors.push(error); }
      try { socket.close(code, reason); }
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
    });
  }
  function closePeers(code = 1001, reason = 'server_shutdown'): Promise<void> {
    const errors: unknown[] = [];
    const pending = [...attached.keys()].map(socket => closeSocket(socket, code, reason, errors));
    return Promise.all(pending).then(() => {
      if (errors.length) throw new AggregateError(errors, 'Socket peer cleanup failed');
    });
  }
  return {
    get state() { return state; },
    peers,
    attach(socket, detach, announce) {
      attached.set(socket, { detach, announce });
      socket.once('close', () => { attached.delete(socket); });
    },
    add(peer, socket) { peers.add(peer); sockets.set(peer, socket); },
    remove(peer) {
      peers.delete(peer);
      sockets.delete(peer);
      options.detached(peer);
    },
    publish(event, shape) {
      if (state !== 'open') return;
      for (const peer of peers) {
        if (!peer.open) continue;
        const shaped = shape ? shape(peer) : event;
        if (shaped) peer.event(shaped);
      }
    },
    track(promise) {
      accepted.add(promise);
      const forget = (): void => { accepted.delete(promise); };
      void promise.then(forget, forget);
    },
    beginDrain() {
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
    },
    closePeers,
    closeWhere(pred, code, reason) {
      const errors: unknown[] = [];
      for (const peer of [...peers]) {
        const socket = sockets.get(peer);
        if (socket && pred(peer)) void closeSocket(socket, code, reason, errors);
      }
    },
    release() {
      if (released) return released;
      state = 'released';
      released = closePeers();
      return released;
    },
  };
}
