import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverInfoV2Schema, type Request } from '@vonvon/protocol';
import { createInitiator, decodeFrame, encodeFrame, FRAME, generateStaticKey, type Channel, type StaticKey } from '@vonvon/protocol/secure-channel';
import { connectSecure, nodeBinarySocket, SecureChannelError, type SecureConnection } from '@vonvon/client/secure';
import { createClientRegistry } from '../src/remote/clients';
import { completePairing, createInviteBook } from '../src/remote/pairing';
import { createPeerHub } from '../src/server/peer-hub';
import { principalWire } from '../src/server/principal';
import { createSecureSocketServer, type SecureSocketServerOptions } from '../src/server/secure-socket';
import type { Peer } from '../src/server/ws';
import { Jobs } from '../src/server/jobs';
import { LogFollowers } from '../src/server/logs';
import { startFixture } from './server-fixture';

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
    control: async (peer, request) => { if (request.method === 'admin') status(peer, request.id); },
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
async function connect(h: Target, options: { clientKey?: StaticKey; pairing?: { inviteId: string; inviteSecret: string; clientName: string }; pk?: string } = {}): Promise<SecureConnection> {
  const ws = await opened(h.port);
  cleanup.push(async () => { ws.terminate(); });
  return connectSecure({ socket: nodeBinarySocket(ws), device: { id: 'd', pk: options.pk ?? h.device.publicKeyBase64url }, clientKey: options.clientKey ?? generateStaticKey().key, clientKind: 'cli', ...(options.pairing ? { pairing: options.pairing } : {}) });
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
      return plain.type === FRAME.json ? JSON.parse(plain.body.toString()) as Record<string, unknown> : { control: plain.type };
    },
  };
}
const hello = { type: 'hello', protocolVersion: PROTOCOL_VERSION, clientKind: 'cli' };

describe('an unknown key', () => {
  it('gets message 2 and nothing else, and is closed 4002 when no pairing request comes', async () => {
    const h = await harness();
    const client = await raw(h);
    await client.handshake();
    h.hub.publish({ type: 'event', event: 'log', payload: { line: 'x' } } as never);
    expect(await client.closed).toBe(4002);
    expect(client.inbox).toHaveLength(0);
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

describe('draining', () => {
  it('lets a remote peer ask only what a draining daemon answers, like the loopback', async () => {
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
    expect(connection.serverInfo).toMatchObject({ principal: 'owner:paired', capabilities: ['device'] });
    expect(await connection.client.admin({ type: 'daemonStatus' })).toMatchObject({ kind: 'daemonStatus', status: { startedAt: expect.any(Number) } });
    expect(await connection.client.device({ type: 'clients' })).toMatchObject({ kind: 'clients', clients: [{ name: '探针', invitedBy: 'local' }] });
    connection.close();
    await connection.closed;
    await vi.waitFor(() => { expect(jobs).toHaveBeenCalled(); expect(logs).toHaveBeenCalled(); });
  });
});
