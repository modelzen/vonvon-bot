import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { connect as netConnect, createServer as createNetServer, type Server, type Socket } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { agentIdSchema, PROTOCOL_VERSION, serverInfoV2Schema, type DesktopSnapshot, type Request } from '@vonvon/protocol';
import { createInitiator, decodeFrame, encodeFrame, FRAME, generateStaticKey, readCloseBody, type Channel, type StaticKey } from '@vonvon/protocol/secure-channel';
import { connectSecure, nodeBinarySocket, SecureChannelError, type BinarySocket, type SecureConnection } from '@vonvon/client/secure';
import { createClientRegistry } from '../src/remote/clients';
import { completePairing, createInviteBook } from '../src/remote/pairing';
import { createPeerHub } from '../src/server/peer-hub';
import { principalWire } from '../src/server/principal';
import { createSecureSocketServer, type SecureSocketServerOptions } from '../src/server/secure-socket';
import type { AdminBot, AdminProject } from '../src/admin/service';
import type { Peer } from '../src/server/ws';
import { Jobs } from '../src/server/jobs';
import { LogFollowers } from '../src/server/logs';
import { fakeService, socketClient, startFixture } from './server-fixture';
import { RpcError } from '../src/server/errors';

// devices-2 第 5 节: a real http.Server and real ws on 127.0.0.1:0. Timers are injected short, not faked: ws keeps its
// own. main 必败: there was no secure socket server.
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
};
async function harness(overrides: Partial<SecureSocketServerOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-secure-'));
  const clients = await createClientRegistry(home);
  const invites = createInviteBook();
  const device = generateStaticKey();
  const detached = vi.fn();
  const hub = createPeerHub({ detached });
  const failures: Array<[string, boolean]> = [];
  const requests: Request[] = [];
  const server = createServer();
  const status = (peer: Peer, id: string) => peer.send({ type: 'response', id, method: 'admin', payload: { kind: 'daemonStatus', status: { installed: false, running: true, selfHosted: true, version: 'test', supported: true, startedAt: 1 } } });
  const secure = createSecureSocketServer({
    server, hub, device: device.key, deviceName: () => '测试机', clients, invites, completePairing,
    info: peer => serverInfoV2Schema.parse({ type: 'serverInfo', machineId: randomUUID(), version: 'test', protocolVersion: PROTOCOL_VERSION, deviceName: '测试机', platform: 'linux', capabilities: ['device'], principal: principalWire(peer.principal) }),
    request: async (peer, request) => {
      requests.push(request);
      if (request.method === 'admin' && request.payload.type === 'daemonStatus') status(peer, request.id);
      else throw new Error('not in this harness');
    },
    // http.ts's control in small: the status, and `draining` for the rest (devices 4.7)
    control: async (peer, request) => { if (request.method === 'admin') status(peer, request.id); else throw new RpcError('draining', 'draining'); },
    onHandshakeFailed: (_ip, reason, validInvite) => { failures.push([reason, validInvite]); },
    timers: { handshake: 300, pairing: 300, idle: 600 },
    ...overrides,
  });
  const port = await listen(server);
  cleanup.push(async () => {
    await secure.close();
    await hub.release();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await clients.close();
    await rm(home, { recursive: true, force: true });
  });
  return { port, home, clients, invites, hub, detached, device, failures, requests, server, secure };
}
type Harness = Awaited<ReturnType<typeof harness>>;

const opened = async (port: number): Promise<WebSocket> => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
};
type Target = { port: number; device: { publicKeyBase64url: string; key: StaticKey } };
async function connect(h: Target, options: { clientKey?: StaticKey; clientKind?: 'desktop' | 'cli'; pairing?: { inviteId: string; inviteSecret: string; clientName: string }; pk?: string } = {}): Promise<SecureConnection> {
  const ws = await opened(h.port);
  cleanup.push(async () => { ws.terminate(); });
  return connectSecure({ socket: nodeBinarySocket(ws), device: { id: 'd', pk: options.pk ?? h.device.publicKeyBase64url }, clientKey: options.clientKey ?? generateStaticKey().key, clientKind: options.clientKind ?? 'cli', ...(options.pairing ? { pairing: options.pairing } : {}) });
}
const refused = async (pending: Promise<unknown>): Promise<SecureChannelError> => {
  const error = await pending.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(SecureChannelError);
  return error as SecureChannelError;
};
async function paired(h: Harness) {
  const clientKey = generateStaticKey().key;
  const invite = h.invites.create({ invitedBy: 'local' });
  const connection = await connect(h, { clientKey, pairing: { inviteId: invite.id, inviteSecret: invite.secret, clientName: '笔记本' } });
  return { clientKey, connection, clientId: connection.pairResult?.clientId ?? '' };
}

/** A client at the byte level, for what connectSecure never sends. */
async function raw(h: Target, clientKey: StaticKey = generateStaticKey().key) {
  const ws = await opened(h.port);
  cleanup.push(async () => { ws.terminate(); });
  const inbox: Buffer[] = [];
  const waiters = new Set<() => void>();
  ws.on('message', data => { inbox.push(Buffer.from(data as Buffer)); for (const wake of waiters) wake(); });
  const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)));
  let channel: Channel | undefined;
  const next = (): Promise<Buffer> => inbox.length ? Promise.resolve(inbox.shift() as Buffer) : new Promise((resolve, reject) => {
    const wake = (): void => { waiters.delete(wake); resolve(inbox.shift() as Buffer); };
    waiters.add(wake);
    void closed.then(() => { waiters.delete(wake); reject(new Error('closed')); });
  });
  return {
    ws, closed, inbox,
    async handshake() {
      const initiator = createInitiator(clientKey, h.device.key.publicKey);
      ws.send(initiator.message1());
      channel = initiator.finish(await next()).channel;
    },
    frame(type: number, body?: Buffer) { if (!channel) throw new Error('no channel'); ws.send(channel.encrypt(encodeFrame(type as 0, body))); },
    json(value: unknown) { this.frame(FRAME.json, Buffer.from(JSON.stringify(value))); },
    async read() {
      if (!channel) throw new Error('no channel');
      const plain = decodeFrame(channel.decrypt(await next()));
      if (plain.type === FRAME.close) return { close: readCloseBody(plain.body) };
      return plain.type === FRAME.json ? JSON.parse(plain.body.toString()) as Record<string, unknown> : { control: plain.type };
    },
  };
}
const hello = { type: 'hello', protocolVersion: PROTOCOL_VERSION, clientKind: 'cli' };

/** A TCP relay in front of the server, as anyone on the path is: it passes everything, and can write to the client. */
async function relay(target: number) {
  const ends: Socket[] = [];
  const toClient: Socket[] = [];
  const server = createNetServer(client => {
    const upstream = netConnect(target, '127.0.0.1');
    for (const end of [client, upstream]) { end.on('error', () => undefined); ends.push(end); }
    client.pipe(upstream);
    upstream.pipe(client);
    toClient.push(client);
  });
  const port = await listen(server);
  cleanup.push(async () => { for (const end of ends) end.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { port, inject: (bytes: Buffer) => { toClient[0]?.write(bytes); } };
}
/** An upgrade by hand that then never writes again, not even the answer to a close frame. */
async function mute(port: number): Promise<{ received: () => Buffer }> {
  const socket = netConnect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  cleanup.push(async () => { socket.destroy(); });
  const chunks: Buffer[] = [];
  socket.on('data', chunk => chunks.push(chunk));
  await new Promise<void>(resolve => socket.once('connect', () => resolve()));
  socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  return { received: () => Buffer.concat(chunks) };
}

describe('an unknown key', () => {
  it('gets message 2 and nothing else, and is closed 4002 when no pairing request comes', async () => {
    const h = await harness();
    const client = await raw(h);
    await client.handshake();
    h.hub.publish({ type: 'event', event: 'log', payload: { line: 'x' } } as never);
    expect(await client.closed).toBe(4002);
    // Only the close, said inside the channel.
    expect(client.inbox).toHaveLength(1);
    expect(await client.read()).toEqual({ close: { code: 4002, reason: 'unknown_client' } });
    expect(h.failures).toEqual([['unknown_client', false]]);
    expect(h.hub.peers.size).toBe(0);
  });

  it('is closed 4002 at once for anything but a pairing request, and never gets a server info', async () => {
    const h = await harness();
    const error = await refused(connect(h));
    expect(error).toMatchObject({ code: 'unknown_client', stage: 'hello', closeCode: 4002 });
    expect(h.failures).toEqual([['unknown_client', false]]);
    expect(h.requests).toHaveLength(0);
  });

  it('pairs with a valid invite: the channel key is registered, then the hello gives the paired server info and RPC works', async () => {
    const h = await harness();
    const { clientKey, connection, clientId } = await paired(h);
    expect(clientId).toMatch(/^cl_[0-9a-f]{16}$/);
    expect(connection.pairResult).toEqual({ type: 'pairResult', clientId, deviceName: '测试机' });
    expect(connection.serverInfo).toMatchObject({ principal: 'owner:paired', deviceName: '测试机' });
    const file = JSON.parse(await readFile(join(h.home, 'devices', 'clients.json'), 'utf8')) as { clients: Array<Record<string, unknown>> };
    expect(file.clients).toHaveLength(1);
    expect(file.clients[0]).toMatchObject({ id: clientId, name: '笔记本', clientKind: 'cli', invitedBy: 'local', publicKey: clientKey.publicKey.toString('base64url') });
    expect(file.clients[0]?.lastAddress).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(h.hub.peers.size).toBe(1);
    expect([...h.hub.peers][0]?.principal).toEqual({ kind: 'owner', via: 'paired', clientId, generation: h.clients.generation });
    expect(await connection.client.admin({ type: 'daemonStatus' })).toMatchObject({ kind: 'daemonStatus', status: { running: true } });
    // The same key again, without an invite, is simply paired.
    const again = await connect(h, { clientKey });
    expect(again.serverInfo.principal).toBe('owner:paired');
    expect(h.hub.peers.size).toBe(2);
  });

  it.each([
    ['a secret one character off', true],
    ['an invite that does not exist', false],
  ])('is refused 4007 for %s', async (_name, validInvite) => {
    const h = await harness();
    const invite = h.invites.create({ invitedBy: 'local' });
    const secret = `${invite.secret.slice(0, -1)}${invite.secret.endsWith('A') ? 'B' : 'A'}`;
    const pairing = validInvite ? { inviteId: invite.id, inviteSecret: secret, clientName: 'x' } : { inviteId: 'inv_ffffffffffffffff', inviteSecret: invite.secret, clientName: 'x' };
    expect(await refused(connect(h, { pairing }))).toMatchObject({ code: 'pairing_failed', stage: 'pairing', closeCode: 4007 });
    expect(h.failures).toEqual([['pairing_failed', validInvite]]);
    expect(h.clients.list()).toHaveLength(0);
  });

  it('cannot use an invite a second device already used', async () => {
    const h = await harness();
    const invite = h.invites.create({ invitedBy: 'local' });
    const pairing = { inviteId: invite.id, inviteSecret: invite.secret, clientName: 'x' };
    await connect(h, { pairing });
    expect(await refused(connect(h, { pairing }))).toMatchObject({ code: 'pairing_failed', closeCode: 4007 });
    expect(h.clients.list()).toHaveLength(1);
  });

  it('may send only the one frame while its pairing is written', async () => {
    const h = await harness();
    const invite = h.invites.create({ invitedBy: 'local' });
    const client = await raw(h);
    await client.handshake();
    client.json({ type: 'pairRequest', inviteId: invite.id, inviteSecret: invite.secret, clientName: 'x', clientKind: 'cli' });
    client.json(hello);
    expect(await client.closed).toBe(1008);
  });
});

describe('a paired key', () => {
  it('is told 4003 once revoked, and a connection already open is closed 4003 at its next request', async () => {
    const h = await harness();
    const { clientKey, connection, clientId } = await paired(h);
    await h.clients.revoke(clientId);
    expect(await refused(connect(h, { clientKey }))).toMatchObject({ code: 'client_revoked', stage: 'hello', closeCode: 4003 });
    await expect(connection.client.admin({ type: 'daemonStatus' })).rejects.toThrow();
    expect(await connection.closed).toMatchObject({ code: 'client_revoked', closeCode: 4003 });
    expect(h.requests).toHaveLength(0);
    expect(h.hub.peers.size).toBe(0);
  });

  it('is closed 4401 for a hello with a credential', async () => {
    const h = await harness();
    const { clientKey } = await paired(h);
    const client = await raw(h, clientKey);
    await client.handshake();
    client.json({ ...hello, credential: 'x' });
    expect(await client.closed).toBe(4401);
  });

  it('answers ping with pong, and is closed 1001 after the idle time without a frame', async () => {
    const h = await harness();
    const { clientKey } = await paired(h);
    const client = await raw(h, clientKey);
    await client.handshake();
    client.json(hello);
    expect(await client.read()).toMatchObject({ type: 'serverInfo', principal: 'owner:paired' });
    const started = Date.now();
    for (let index = 0; index < 4; index++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      client.frame(FRAME.ping);
      expect(await client.read()).toEqual({ control: FRAME.pong });
    }
    // Pinged past the 600 ms idle time, so the pings kept it open; silent now, it closes.
    expect(Date.now() - started).toBeGreaterThan(900);
    expect(await client.closed).toBe(1001);
  });

  it('is closed 1008 for a changed frame, and its peer leaves the hub, detached', async () => {
    const h = await harness();
    const { clientKey } = await paired(h);
    const client = await raw(h, clientKey);
    await client.handshake();
    client.json(hello);
    await client.read();
    expect(h.hub.peers.size).toBe(2);
    const original = client.ws.send.bind(client.ws);
    vi.spyOn(client.ws, 'send').mockImplementationOnce((data: unknown) => {
      const bytes = Buffer.from(data as Buffer);
      bytes[12] = (bytes[12] ?? 0) ^ 1;
      original(bytes);
    });
    client.json({ type: 'request', id: 'r', method: 'admin', payload: { type: 'daemonStatus' } });
    expect(await client.closed).toBe(1008);
    await vi.waitFor(() => expect(h.hub.peers.size).toBe(1));
    expect(h.detached).toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
  });

  it('is closed 1008 for a replayed frame', async () => {
    const h = await harness();
    const { clientKey } = await paired(h);
    const client = await raw(h, clientKey);
    await client.handshake();
    const sent: Buffer[] = [];
    const original = client.ws.send.bind(client.ws);
    vi.spyOn(client.ws, 'send').mockImplementation((data: unknown) => { sent.push(Buffer.from(data as Buffer)); original(data as Buffer); });
    client.json(hello);
    await client.read();
    original(sent[0] as Buffer);
    expect(await client.closed).toBe(1008);
  });

  // 审查 D2-CRYPTO-2 and R5: IK's message 1 can be sent again by anyone who recorded it, with no key at all.
  it('is not seen for a replayed message 1, only for a hello', async () => {
    const h = await harness();
    const { clientKey, clientId } = await paired(h);
    const before = h.clients.get(clientId);
    expect(before?.lastAddress).toMatch(/^127\.0\.0\.1:\d+$/);
    const recorded = createInitiator(clientKey, h.device.key.publicKey).message1();
    const replayer = await raw(h);
    replayer.ws.send(recorded);
    expect(await replayer.closed).toBe(4005);
    expect(replayer.inbox[0]).toHaveLength(48);
    expect(h.clients.get(clientId)).toMatchObject({ lastAddress: before?.lastAddress, lastSeenAt: before?.lastSeenAt });
    // The hello timed out: counted as a failed handshake, for D3's rate limit.
    expect(h.failures).toEqual([['handshake_failed', false]]);
    const client = await raw(h, clientKey);
    await client.handshake();
    client.json(hello);
    await client.read();
    expect(h.clients.get(clientId)?.lastAddress).not.toBe(before?.lastAddress);
  });

  // 审查 R4: a ping is checked too, and a maintenance connection still says which client it is.
  it('is closed 4003 at its next frame once revoked, a ping as well, also when the hello made it a maintenance connection', async () => {
    const h = await harness();
    const { clientKey, clientId } = await paired(h);
    const client = await raw(h, clientKey);
    await client.handshake();
    client.json({ ...hello, protocolVersion: 1 });
    expect(await client.read()).toMatchObject({ type: 'serverInfo', principal: 'maintenance' });
    const peer = [...h.hub.peers].find(each => each.principal.kind === 'maintenance');
    expect(peer?.clientId).toBe(clientId);
    await h.clients.revoke(clientId);
    client.frame(FRAME.ping);
    expect(await client.read()).toEqual({ close: { code: 4003, reason: 'client_revoked' } });
    expect(await client.closed).toBe(4003);
    expect(h.hub.peers.has(peer as Peer)).toBe(false);
  });

  // 审查 D2-CRYPTO-1: the close code of a WebSocket is not authenticated; only the one inside the channel is believed.
  it('is not revoked by a close frame someone on the path writes, and its client sees it as a plain close', async () => {
    const h = await harness();
    const { clientKey, clientId } = await paired(h);
    const path = await relay(h.port);
    const connection = await connect({ port: path.port, device: h.device }, { clientKey });
    path.inject(Buffer.from([0x88, 0x02, 0x0f, 0xa3]));
    expect(await connection.closed).toMatchObject({ code: 'closed', closeCode: 4003 });
    expect(h.clients.get(clientId)?.revokedAt).toBeUndefined();
  });
});

describe('the handshake', () => {
  it('is refused 4005 when the device has another key, which the client reads as another device', async () => {
    const h = await harness();
    const stale = generateStaticKey();
    expect(await refused(connect(h, { pk: stale.publicKeyBase64url }))).toMatchObject({ code: 'device_identity_changed', stage: 'handshake', closeCode: 4005 });
    expect(h.failures).toEqual([['handshake_failed', false]]);
  });

  it('closes 4005 without a first frame in time, for a first frame over 4096 bytes, and for a text one', async () => {
    const h = await harness();
    expect(await (await raw(h)).closed).toBe(4005);
    const big = await raw(h);
    big.ws.send(Buffer.alloc(4097, 1));
    expect(await big.closed).toBe(4005);
    const text = await raw(h);
    text.ws.send(JSON.stringify(hello));
    expect(await text.closed).toBe(4005);
    expect(h.failures).toEqual([['handshake_failed', false], ['handshake_failed', false], ['handshake_failed', false]]);
  });

  // 审查 R2: only a message 1 this device cannot read says "another device"; a late one is a timeout, another version 4001.
  it('tells a message 1 that came late, and another channel version, from another key', async () => {
    const h = await harness();
    const ws = await opened(h.port);
    cleanup.push(async () => { ws.terminate(); });
    const socket = nodeBinarySocket(ws);
    const late: BinarySocket = { ...socket, send: bytes => { setTimeout(() => { if (socket.isOpen()) socket.send(bytes); }, 500); } };
    expect(await refused(connectSecure({ socket: late, device: { id: 'd', pk: h.device.publicKeyBase64url }, clientKey: generateStaticKey().key, clientKind: 'cli' })))
      .toMatchObject({ code: 'timeout', stage: 'handshake', closeCode: 4005 });
    const later = await raw(h);
    const message1 = createInitiator(generateStaticKey().key, h.device.key.publicKey).message1();
    message1[0] = 0x02;
    later.ws.send(message1);
    expect(await later.closed).toBe(4001);
    expect(later.inbox).toHaveLength(0);
    expect(h.failures).toEqual([['handshake_failed', false], ['handshake_failed', false]]);
  });

  it('asks admit before the upgrade, and the rate limit before reading a frame', async () => {
    const onHandshake = vi.fn(() => 'ok' as const);
    const forbidden = await harness({ admit: () => ({ ok: false, status: 403 }), onHandshake });
    const ws = new WebSocket(`ws://127.0.0.1:${forbidden.port}/`);
    ws.on('error', () => undefined);
    const status = await new Promise<number>(resolve => ws.once('unexpected-response', (request, response) => { request.destroy(); resolve(response.statusCode ?? 0); }));
    expect(status).toBe(403);
    expect(onHandshake).not.toHaveBeenCalled();
    const limited = await harness({ onHandshake: () => 'rate_limited' });
    const client = await raw(limited);
    // Closed before the client wrote anything: no frame was read, so no DH was done.
    expect(await client.closed).toBe(4004);
    expect(client.inbox).toHaveLength(0);
    expect(await refused(connect(limited))).toMatchObject({ code: 'rate_limited', stage: 'handshake', closeCode: 4004 });
  });
});

describe('closing the server', () => {
  // 审查 R1: a refused socket stays in ws's own list until it closes; one whose peer never answers would hold close() 30 s.
  it('does not wait on a refused socket whose peer never answers its close frame', async () => {
    const h = await harness();
    const peer = await mute(h.port);
    // Refused for no first frame: 4005 went out (a close frame starts with 0x88), and no answer comes.
    await vi.waitFor(() => expect(peer.received().includes(0x88)).toBe(true), { timeout: 2_000 });
    const started = Date.now();
    await h.secure.close();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('draining', () => {
  // devices 4.7 / Codex review 248: drained, every request of a remote peer goes to `control`, as the loopback's, and what
  // it refuses is answered with the connection kept; a frame with no id to answer is closed 1001.
  it('hands a remote peer\'s requests to control while draining, like the loopback, and keeps the connection for a refusal', async () => {
    const h = await harness();
    const { clientKey } = await paired(h);
    void h.hub.beginDrain();
    const client = await raw(h, clientKey);
    await client.handshake();
    client.json(hello);
    expect(await client.read()).toMatchObject({ type: 'serverInfo' });
    client.json({ type: 'request', id: 's', method: 'admin', payload: { type: 'daemonStatus' } });
    expect(await client.read()).toMatchObject({ type: 'response', id: 's' });
    client.json({ type: 'request', id: 'r', method: 'command', payload: { type: 'refresh' } });
    expect(await client.read()).toMatchObject({ type: 'error', id: 'r', code: 'draining' });
    client.json({ type: 'request', id: 'f', method: 'future', payload: {} });
    expect(await client.read()).toMatchObject({ type: 'error', id: 'f', code: 'draining' });
    client.json({ type: 'request', method: 'admin', payload: { type: 'daemonStatus' } });
    expect(await client.read()).toEqual({ close: { code: 1001, reason: 'server_shutdown' } });
    expect(await client.closed).toBe(1001);
    expect(h.requests).toHaveLength(0);
  });
});

describe('the daemon', () => {
  it('pairs and answers over the channel with its own dispatch, and detaches a closed peer from jobs and logs', async () => {
    const fixture = await startFixture();
    const server = createServer();
    const secure = fixture.api.secure;
    if (!secure) throw new Error('startApi gives no secure deps');
    const remote = createSecureSocketServer({ ...secure, server });
    const port = await listen(server);
    cleanup.push(async () => { await remote.close(); await fixture.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const invite = secure.invites.create({ invitedBy: 'local' });
    const device = { publicKeyBase64url: secure.device.publicKey.toString('base64url'), key: secure.device };
    const jobs = vi.spyOn(Jobs.prototype, 'detach');
    const logs = vi.spyOn(LogFollowers.prototype, 'detach');
    const connection = await connect({ port, device }, { pairing: { inviteId: invite.id, inviteSecret: invite.secret, clientName: '探针' } });
    expect(connection.serverInfo).toMatchObject({ principal: 'owner:paired', capabilities: ['device', 'session-scope', 'attention.group'] });
    expect(await connection.client.admin({ type: 'daemonStatus' })).toMatchObject({ kind: 'daemonStatus', status: { startedAt: expect.any(Number) } });
    expect(await connection.client.device({ type: 'clients' })).toMatchObject({ kind: 'clients', clients: [{ name: '探针', invitedBy: 'local' }] });
    connection.close();
    await connection.closed;
    await vi.waitFor(() => { expect(jobs).toHaveBeenCalled(); expect(logs).toHaveBeenCalled(); });
  });
});

// Merging I3 and D4a (2026-11-02): their loopback behaviour now lives in the hub and the message loop both servers share.
describe('the daemon, with I3 and D4a', () => {
  const SESSION = 'ses_0123456789abcdef';
  async function daemon(service = fakeService()) {
    const fixture = await startFixture(service);
    const server = createServer();
    const secure = fixture.api.secure;
    if (!secure) throw new Error('startApi gives no secure deps');
    const remote = createSecureSocketServer({ ...secure, server });
    const port = await listen(server);
    cleanup.push(async () => { await remote.close(); await fixture.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const target = { port, device: { publicKeyBase64url: secure.device.publicKey.toString('base64url'), key: secure.device } };
    const pair = async (clientKind: 'cli' | 'desktop' = 'cli') => {
      const clientKey = generateStaticKey().key;
      const invite = secure.invites.create({ invitedBy: 'local' });
      return { clientKey, connection: await connect(target, { clientKey, clientKind, pairing: { inviteId: invite.id, inviteSecret: invite.secret, clientName: '探针' } }) };
    };
    const loopback = async (credential: string) => {
      const client = await socketClient(fixture.api.port, credential);
      cleanup.push(() => client.close());
      await client.ready();
      return client;
    };
    const session = () => loopback(fixture.sessionTokens.issue({ appId: 'cli_x', place: 'group', chatId: 'oc_y', sessionId: SESSION }));
    return { fixture, target, pair, owner: () => loopback(fixture.credential), session };
  }
  const closeOf = (socket: WebSocket) => new Promise<[number, string]>(resolve => socket.once('close', (code, reason) => resolve([code, reason.toString()])));

  it('lets a paired desktop dispatch a local draft and acknowledge it after reconnecting', async () => {
    const operationId = randomUUID(), draftId = randomUUID(), session = randomUUID();
    const botId = agentIdSchema.parse('cli_test');
    const receipt = { operationId, status: 'accepted' as const, stateRevision: 3 as const, draftId, revision: 1 };
    const binary = Buffer.alloc(32, 1).toString('base64url');
    const operation = { operationId, draftId, purpose: 'prepareDraft', targetPublicKey: binary, nonceCommitment: binary,
      format: 'rich-v2', storage: 'local', state: 'candidate', deliveryUnknown: false, createdAt: 1 };
    const handler = vi.fn<NonNullable<ReturnType<typeof fakeService>['recipeAuthoring']>>(async (_botId, command) => {
      if (command.kind === 'recipeAuthoring' && command.request.type === 'localDraftAdvance') return { kind: 'operation', operation };
      return { kind: 'localDraftAcknowledged', operationId };
    });
    const { pair, target } = await daemon(fakeService({ recipeAuthoring: handler }));
    const { connection, clientKey } = await pair('desktop');
    expect(connection.serverInfo.principal).toBe('owner:paired');
    connection.close();
    await connection.closed;

    const remote = await connect(target, { clientKey, clientKind: 'desktop' });
    expect(remote.serverInfo.principal).toBe('owner:paired');
    const advance = { type: 'localDraftAdvance' as const, botId, session, operationId, advance: { kind: 'dispatch' as const, draftId } };
    const ack = { type: 'localDraftAcknowledged' as const, botId, session, operationId, receipt };
    expect(await remote.client.recipeAuthoring!(advance)).toEqual({ kind: 'operation', operation });
    expect(await remote.client.recipeAuthoring!(ack)).toEqual({ kind: 'localDraftAcknowledged', operationId });
    expect(handler.mock.calls.map(([, command]) => command.kind === 'recipeAuthoring' && command.request)).toEqual([advance, ack]);
  });

  it('answers a remote peer\'s coreUpdateStatus and snapshot while draining, through the shared message loop, refuses the rest and closes it 1001 at the release', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const status = { phase: 'restarting' as const, to: '0.9.1', at: 1 };
    const { fixture, target, pair } = await daemon(fakeService({ close: () => held, updateStatus: () => status }));
    const { clientKey, connection } = await pair();
    const draining = fixture.api.beginDrain();
    void draining.catch(() => undefined);
    try {
      await connection.closed;
      const client = await raw(target, clientKey);
      await client.handshake();
      client.json(hello);
      expect(await client.read()).toMatchObject({ type: 'serverInfo', principal: 'owner:paired' });
      client.json({ type: 'request', id: 'u', method: 'machine', payload: { type: 'coreUpdateStatus' } });
      expect(await client.read()).toEqual({ type: 'response', id: 'u', method: 'machine', payload: { type: 'coreUpdateStatus', status } });
      client.json({ type: 'request', id: 'c', method: 'machine', payload: { type: 'checkCoreUpdate' } });
      expect(await client.read()).toMatchObject({ type: 'error', id: 'c', code: 'draining' });
      client.json({ type: 'request', id: 'snap', method: 'snapshot', payload: { type: 'get' } });
      expect(await client.read()).toMatchObject({ type: 'response', id: 'snap', method: 'snapshot', payload: { stale: true } });
      release();
      await draining;
      await fixture.api.release();
      expect(await client.read()).toEqual({ close: { code: 1001, reason: 'server_shutdown' } });
      expect(await client.closed).toBe(1001);
    } finally { release(); await Promise.allSettled([draining]); }
  });

  it('closes a Bot session\'s connection 4401 through the hub when its token ends, detached at once, and leaves the owner\'s', async () => {
    const { fixture, pair, owner, session } = await daemon();
    const { connection } = await pair();
    const local = await owner();
    const bot = await session();
    const jobs = vi.spyOn(Jobs.prototype, 'detach');
    const closed = closeOf(bot.socket);
    fixture.sessionTokens.revoke(SESSION);
    // hub.closeWhere detaches before it closes: no job or log line reaches it while its close frame is on the way
    expect(jobs).toHaveBeenCalledTimes(1);
    expect(jobs.mock.calls[0]?.[0]).toMatchObject({ principal: { kind: 'bot-session', sessionId: SESSION } });
    expect(await closed).toEqual([4401, 'invalid_session_token']);
    expect(await local.call({ type: 'request', id: 's', method: 'admin', payload: { type: 'daemonStatus' } })).toMatchObject({ type: 'response' });
    expect(await connection.client.admin({ type: 'daemonStatus' })).toMatchObject({ kind: 'daemonStatus' });
  });

  it('refuses a Bot session\'s token in a remote hello with 4401: on the channel only the key authorizes', async () => {
    const { fixture, target, pair } = await daemon();
    const { clientKey, connection } = await pair();
    connection.close();
    await connection.closed;
    const token = fixture.sessionTokens.issue({ appId: 'cli_x', place: 'group', chatId: 'oc_y', sessionId: SESSION });
    const client = await raw(target, clientKey);
    await client.handshake();
    client.json({ ...hello, credential: token });
    expect(await client.read()).toEqual({ close: { code: 4401, reason: 'unauthorized' } });
    expect(await client.closed).toBe(4401);
    // the token itself is good: the loopback takes it
    expect(fixture.sessionTokens.resolve(token)).toMatchObject({ sessionId: SESSION });
  });

  it('gives a pairing\'s device event to the owner and none of it to a Bot session: the hub\'s view, whoever publishes', async () => {
    const { pair, owner, session } = await daemon();
    const local = await owner();
    const bot = await session();
    const negotiate = { type: 'request', id: 'n', method: 'admin', payload: { type: 'negotiate', capabilities: ['cli'], scope: { bot: 'cli_x', group: 'oc_y' } } } as unknown as Request;
    expect(await bot.call(negotiate)).toMatchObject({ type: 'response' });
    await pair();
    await local.wait(frame => frame.type === 'event' && frame.event === 'device');
    // replies keep their order on a socket: a device event published to it before this request would be there by now
    await bot.call({ type: 'request', id: 'after', method: 'admin', payload: { type: 'daemonStatus' } });
    expect(bot.frames.filter(frame => frame.type === 'event' && frame.event === 'device')).toEqual([]);
  });
});

// 0.9.0 Mac 验收: B's snapshot was 98 % pictures, sent whole on every change to every connection; a remote one on a
// 20 KB/s relay never caught up. main 必败: each reply and push carried every picture, and every push was queued.
describe('a remote connection on a slow link', () => {
  const BOT = `data:image/png;base64,${'B'.repeat(80_000)}`;
  const GROUP = `data:image/png;base64,${'G'.repeat(20_000)}`;
  const largest = (sizes: number[], from: number): number => Math.max(0, ...sizes.slice(from));

  it('gets each picture once over the real channel and its client puts it back everywhere; the loopback gets them whole', async () => {
    let connection = 'connected';
    const bot: AdminBot = { appId: 'cli_a', name: 'a', tenant: 'feishu', active: true, current: true, running: true, avatarDataUrl: BOT, completionReminder: { mode: 'failures', longTaskMinutes: 3 } };
    const project: AdminProject = { name: 'p', chatId: 'oc_1', cwd: '/tmp/p', blank: false, kind: 'multi', origin: 'joined', noMention: false, mode: 'write', guestMode: 'qa', network: true, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1, avatarDataUrl: GROUP };
    const fixture = await startFixture(fakeService({ listBots: async () => [{ ...bot, connection }], listProjects: async () => [project, { ...project, name: 'q', chatId: 'oc_2' }] }));
    const server = createServer();
    const secure = fixture.api.secure;
    if (!secure) throw new Error('startApi gives no secure deps');
    const remote = createSecureSocketServer({ ...secure, server });
    const port = await listen(server);
    cleanup.push(async () => { await remote.close(); await fixture.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const invite = secure.invites.create({ invitedBy: 'local' });
    const ws = await opened(port);
    cleanup.push(async () => { ws.terminate(); });
    const sizes: number[] = [];
    ws.on('message', data => { sizes.push((data as Buffer).length); });
    const { client } = await connectSecure({ socket: nodeBinarySocket(ws), device: { id: 'd', pk: secure.device.publicKey.toString('base64url') }, clientKey: generateStaticKey().key, clientKind: 'desktop',
      pairing: { inviteId: invite.id, inviteSecret: invite.secret, clientName: '探针' } });

    let mark = sizes.length;
    const first = await client.snapshot();
    expect(largest(sizes, mark)).toBeGreaterThan(100_000);
    expect(first.agents[0]).toMatchObject({ avatarDataUrl: BOT });
    expect(first.agents[0]).not.toHaveProperty('avatarRef');
    expect(first.groups.map(group => [group.avatarDataUrl, 'avatarRef' in group])).toEqual([[GROUP, false], [GROUP, false]]);
    mark = sizes.length;
    expect(await client.snapshot()).toEqual(first);
    expect(largest(sizes, mark)).toBeLessThan(5_000);

    const pushed: DesktopSnapshot[] = [];
    const stop = client.watchSnapshots(value => { pushed.push(value); });
    cleanup.push(async () => { stop(); });
    await vi.waitFor(() => { expect(pushed).toHaveLength(1); });
    mark = sizes.length;
    connection = 'reconnecting';
    fixture.api.invalidate();
    await vi.waitFor(() => { expect(pushed).toHaveLength(2); });
    expect(pushed[1]?.agents[0]).toMatchObject({ connection: 'reconnecting', avatarDataUrl: BOT });
    expect(pushed[1]?.groups.map(group => group.avatarDataUrl)).toEqual([GROUP, GROUP]);
    expect(largest(sizes, mark)).toBeLessThan(5_000);
    // The client answered the ping after that push: the next one comes too
    connection = 'connecting';
    fixture.api.invalidate();
    await vi.waitFor(() => { expect(pushed.at(-1)?.agents[0]).toMatchObject({ connection: 'connecting', avatarDataUrl: BOT }); });

    const local = await socketClient(fixture.api.port, fixture.credential);
    cleanup.push(() => local.close());
    await local.ready();
    for (const id of ['l1', 'l2']) {
      const reply = await local.call({ type: 'request', id, method: 'snapshot', payload: { type: 'get' } });
      if (reply.type !== 'response' || reply.method !== 'snapshot') throw new Error('no snapshot');
      expect(reply.payload.agents[0]).toMatchObject({ avatarDataUrl: BOT });
      expect([...reply.payload.agents, ...reply.payload.groups].some(item => 'avatarRef' in item)).toBe(false);
    }
    connection = 'connected';
    fixture.api.invalidate();
    const event = await local.wait(frame => frame.type === 'event' && frame.event === 'snapshot');
    if (event.type !== 'event' || event.event !== 'snapshot') throw new Error('no snapshot');
    expect(event.payload.groups.map(group => [group.avatarDataUrl, 'avatarRef' in group])).toEqual([[GROUP, false], [GROUP, false]]);
  });

  it('pings after a pushed snapshot and keeps only the newest one until the pong; other events go at once, a reply behind the held snapshot', async () => {
    const h = await harness();
    const { clientKey, connection } = await paired(h);
    connection.close();
    await connection.closed;
    const client = await raw(h, clientKey);
    await client.handshake();
    client.json(hello);
    await client.read();
    const snapshot = (revision: number) => ({ type: 'event', event: 'snapshot', payload: { revision, agents: [], groups: [], memberships: [] } }) as never;
    h.hub.publish(snapshot(1));
    expect(await client.read()).toMatchObject({ type: 'event', event: 'snapshot', payload: { revision: 1 } });
    expect(await client.read()).toEqual({ control: FRAME.ping });
    for (const revision of [2, 3]) h.hub.publish(snapshot(revision));
    h.hub.publish({ type: 'event', event: 'log', payload: { lines: 'x' } });
    expect(await client.read()).toMatchObject({ type: 'event', event: 'log' });
    client.frame(FRAME.pong);
    expect(await client.read()).toMatchObject({ type: 'event', event: 'snapshot', payload: { revision: 3 } });
    expect(await client.read()).toEqual({ control: FRAME.ping });
    // 复核 P2: a reply goes after the snapshot it may refer to (docs/plan.md), the held one written ahead of it
    for (const revision of [4, 5]) h.hub.publish(snapshot(revision));
    client.json({ type: 'request', id: 's', method: 'admin', payload: { type: 'daemonStatus' } });
    expect(await client.read()).toMatchObject({ type: 'event', event: 'snapshot', payload: { revision: 5 } });
    expect(await client.read()).toMatchObject({ type: 'response', id: 's' });
    // The pong of the ping after 3 finds nothing held; the next push goes at once
    client.frame(FRAME.pong);
    client.json({ type: 'request', id: 't', method: 'admin', payload: { type: 'daemonStatus' } });
    expect(await client.read()).toMatchObject({ type: 'response', id: 't' });
    h.hub.publish(snapshot(6));
    expect(await client.read()).toMatchObject({ type: 'event', event: 'snapshot', payload: { revision: 6 } });
    expect(await client.read()).toEqual({ control: FRAME.ping });
  });
});

it('projects group attention for an old secure client and opts a new client in from advertised capabilities', async () => {
  const snapshot: DesktopSnapshot = {attentionModel: 'group', revision: 1, observedAt: 1, stale: false, host: {kind: 'starting'},
    agents: [], groups: [], memberships: [], tools: [], jobs: [], application: {platform: 'linux', version: 'test', loginItem: false, dataPath: ''}};
  const h = await harness({
    info: peer => ({type: 'serverInfo', protocolVersion: 2, version: 'test', capabilities: ['attention.group'], principal: principalWire(peer.principal)}),
    request: async (peer, request) => {
      if (request.method === 'snapshot') peer.send({type: 'response', id: request.id, method: 'snapshot', payload: snapshot});
    },
  });
  const {clientKey, connection} = await paired(h);
  expect((await connection.client.snapshot()).attentionModel).toBe('group');
  await connection.client.close();
  const old = await raw(h, clientKey);
  await old.handshake(); old.json(hello);
  expect(await old.read()).toMatchObject({type: 'serverInfo'});
  old.json({type: 'request', id: 'legacy', method: 'snapshot', payload: {type: 'get'}});
  const legacy = await old.read();
  expect(legacy).toMatchObject({type: 'response', id: 'legacy', payload: {revision: 1}});
  expect((legacy.payload as DesktopSnapshot).attentionModel).toBeUndefined();
  old.json({type: 'request', id: 'new', method: 'snapshot', payload: {type: 'get', groupAttention: true}});
  const reply = await old.read();
  expect(reply).toMatchObject({type: 'response', id: 'new', payload: {attentionModel: 'group'}});
});
