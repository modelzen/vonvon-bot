import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { Event } from '@vonvon/protocol';
import { createPeerHub } from '../src/server/peer-hub';
import { viewFor } from '../src/server/http';
import type { Peer } from '../src/server/ws';

// devices-2 4.3: the hub taken out of ws.ts. The loopback tests (server-handshake, api-listen-lifecycle,
// server-socket-shutdown, server-drain-control) run through it unchanged.
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function sockets() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  cleanup.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return async () => {
    const accepted = new Promise<WebSocket>(resolve => server.once('connection', resolve));
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const closed = new Promise<number>(resolve => client.once('close', code => resolve(code)));
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    return { socket: await accepted, client, closed };
  };
}
const event: Event = { type: 'event', event: 'log', payload: { line: 'x' } } as unknown as Event;
/** A connection's detach runs once, however many times it is called. */
const once = (run: () => void) => { let done = false; return () => { if (!done) { done = true; run(); } }; };
function fakePeer(open = true) {
  const received: Event[] = [];
  const peer = { id: String(Math.random()), open, event: (value: Event) => { received.push(value); } } as unknown as Peer & { open: boolean };
  return { peer, received };
}

it('publishes to the open peers only, each in the view the hub gives it', async () => {
  let view: ((peer: Peer, event: Event) => Event | null) | undefined;
  const hub = createPeerHub({ detached: () => undefined, view: (peer, published) => view ? view(peer, published) : published });
  const connect = await sockets();
  const [a, b, c] = [fakePeer(), fakePeer(false), fakePeer()];
  for (const { peer } of [a, b, c]) { const { socket } = await connect(); hub.attach(socket, once(() => hub.remove(peer))); hub.add(peer, socket); }
  hub.publish(event);
  expect([a.received.length, b.received.length, c.received.length]).toEqual([1, 0, 1]);
  const other = { type: 'event', event: 'log', payload: { line: 'y' } } as unknown as Event;
  view = peer => peer === a.peer ? null : other;
  hub.publish(event);
  expect(a.received).toHaveLength(1);
  expect(c.received[1]).toBe(other);
  expect(hub.peers.size).toBe(3);
});

it('drains: stops publishing, closes every attached socket (a peer or not), and waits for what it tracks', async () => {
  const detached = vi.fn();
  const hub = createPeerHub({ detached });
  const connect = await sockets();
  const paired = fakePeer();
  const one = await connect();
  hub.attach(one.socket, once(() => hub.remove(paired.peer)));
  hub.add(paired.peer, one.socket);
  // Not past its handshake: never a peer, still closed by the drain.
  const unauthenticated = fakePeer();
  const two = await connect();
  hub.attach(two.socket, once(() => hub.remove(unauthenticated.peer)));
  let finish = (): void => undefined;
  hub.track(new Promise<void>(resolve => { finish = resolve; }));
  let drained = false;
  const draining = hub.beginDrain().then(() => { drained = true; });
  expect(hub.state).toBe('draining');
  hub.publish(event);
  expect(paired.received).toHaveLength(0);
  expect(await one.closed).toBe(1001);
  expect(await two.closed).toBe(1001);
  expect(detached).toHaveBeenCalledWith(paired.peer);
  expect(detached).toHaveBeenCalledWith(unauthenticated.peer);
  expect(hub.peers.size).toBe(0);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(drained).toBe(false);
  finish();
  await draining;
  expect(drained).toBe(true);
  expect(hub.beginDrain()).toBe(hub.beginDrain());
});

it('closes the peers a predicate picks, with its code, and releases once', async () => {
  const detached = vi.fn();
  const hub = createPeerHub({ detached });
  const connect = await sockets();
  const kept = fakePeer();
  const revoked = fakePeer();
  const first = await connect();
  const second = await connect();
  hub.attach(first.socket, once(() => hub.remove(kept.peer)));
  hub.add(kept.peer, first.socket);
  hub.attach(second.socket, once(() => hub.remove(revoked.peer)));
  hub.add(revoked.peer, second.socket);
  hub.closeWhere(peer => peer === revoked.peer, 4003, 'client_revoked');
  expect(await second.closed).toBe(4003);
  expect(detached).toHaveBeenCalledTimes(1);
  expect([...hub.peers]).toEqual([kept.peer]);
  const released = hub.release();
  expect(hub.release()).toBe(released);
  expect(hub.state).toBe('released');
  await released;
  expect(await first.closed).toBe(1001);
  hub.publish(event);
  expect(kept.received).toHaveLength(0);
});

// main 必败: a protocol 1 client parses snapshots strictly, and a `windows` platform would break it (devices 4.5, devices-ui-2 4.5).
it('publishes snapshots to current connections only, never to a maintenance one', async () => {
  // the daemon's own view (devices-4a 4.7), which also gives a maintenance connection nothing
  const hub = createPeerHub({ detached: () => undefined, view: viewFor({ active: () => false }) });
  const connect = await sockets();
  const [current, maintenance] = [fakePeer(), fakePeer()];
  Object.assign(current.peer, { principal: { kind: 'owner', scope: 'local' } });
  Object.assign(maintenance.peer, { principal: { kind: 'maintenance' } });
  for (const { peer } of [current, maintenance]) { const { socket } = await connect(); hub.attach(socket, once(() => hub.remove(peer))); hub.add(peer, socket); }
  const snapshot = { type: 'event', event: 'snapshot', payload: {} } as unknown as Event;
  hub.publish(snapshot);
  expect(current.received).toEqual([snapshot]);
  expect(maintenance.received).toEqual([]);
});

// devices-ui-3 4.2: a connection whose hello was accepted is told once it is a peer, so its client's scan goes on. main 必败
it('says each added peer to `attached`, once, after it is in `peers`', async () => {
  const seen: number[] = [];
  const hub = createPeerHub({ detached: () => undefined, attached: () => { seen.push(hub.peers.size); } });
  const connect = await sockets();
  const one = fakePeer();
  const { socket } = await connect();
  hub.attach(socket, once(() => hub.remove(one.peer)));
  expect(seen).toEqual([]);
  hub.add(one.peer, socket);
  expect(seen).toEqual([1]);
});
