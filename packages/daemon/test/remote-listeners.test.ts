import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverInfoV2Schema } from '@vonvon/protocol';
import { generateStaticKey } from '@vonvon/protocol/secure-channel';
import { connectSecure, nodeBinarySocket, type SecureChannelError } from '@vonvon/client/secure';
import type { Interfaces } from '../src/remote/address';
import { createClientRegistry } from '../src/remote/clients';
import type { RemoteAddress, RemoteConfig } from '../src/remote/config';
import { completePairing, createInviteBook } from '../src/remote/pairing';
import { createRateLimiter } from '../src/remote/rate-limit';
import { createPeerHub } from '../src/server/peer-hub';
import { principalWire } from '../src/server/principal';
import { createRemoteListeners, type RemoteListenerDeps } from '../src/server/remote-listeners';

// D3 第 5 节: real http.Servers on 127.0.0.2, which Linux binds as any 127/8 address (the listeners never classify; the
// config says "lan"). Elsewhere (the macOS runner) the address does not exist, and these skip. main 必败: no listeners.
const ALIAS = '127.0.0.2';
const canBind = await new Promise<boolean>(resolve => {
  const probe = createNetServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, ALIAS, () => probe.close(() => resolve(true)));
});
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createNetServer();
  probe.once('error', reject);
  probe.listen(0, ALIAS, () => {
    const address = probe.address();
    probe.close(() => (address && typeof address !== 'string' ? resolve(address.port) : reject(new Error('no port'))));
  });
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); vi.restoreAllMocks(); });

const aliasNic = (address: string): Interfaces => ({ lo: [{ address, netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: `${address}/8` }] });
async function harness(overrides: Partial<RemoteListenerDeps> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-remote-'));
  const clients = await createClientRegistry(home);
  const invites = createInviteBook();
  const device = generateStaticKey();
  const hub = createPeerHub({ detached: () => undefined });
  const limiter = createRateLimiter();
  const failed = vi.spyOn(limiter, 'handshakeFailed');
  const log = { info: vi.fn(), warn: vi.fn() };
  let present = true;
  const remote = createRemoteListeners({
    secure: {
      hub, device: device.key, deviceName: () => '测试机', clients, invites, completePairing,
      info: peer => serverInfoV2Schema.parse({ type: 'serverInfo', machineId: randomUUID(), version: 'test', protocolVersion: PROTOCOL_VERSION, deviceName: '测试机', platform: 'linux', capabilities: ['device', 'remote'], principal: principalWire(peer.principal) }),
      request: async () => undefined,
    },
    limiter, log, interfaces: () => (present ? aliasNic(ALIAS) : {}), networkIdentity: async () => undefined,
    secureTimers: { handshake: 500, pairing: 500, idle: 5_000 },
    ...overrides,
  });
  cleanup.push(async () => {
    await remote.release();
    await hub.release();
    await clients.close();
    await rm(home, { recursive: true, force: true });
  });
  return { remote, hub, clients, invites, device, limiter, failed, log, gone() { present = false; } };
}
type Harness = Awaited<ReturnType<typeof harness>>;
const lan = (host: string, extra: Partial<RemoteAddress> = {}): RemoteAddress => ({ host, enabledAt: 1, kind: 'lan', ...extra });
const config = (port: number, ...addresses: RemoteAddress[]): RemoteConfig => ({ v: 1, port, addresses });
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest({ host: ALIAS, port, path, headers: { host: `${ALIAS}:${port}`, ...headers }, agent: false }, response => {
      let body = '';
      response.on('data', chunk => { body += String(chunk); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    sent.on('error', reject);
    sent.end();
  });
}
async function pairOver(h: Harness, port: number) {
  const ws = new WebSocket(`ws://${ALIAS}:${port}/`, { perMessageDeflate: false });
  cleanup.push(async () => { ws.terminate(); });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const invite = h.invites.create({ invitedBy: 'local' });
  return connectSecure({ socket: nodeBinarySocket(ws), device: { id: 'd', pk: h.device.publicKeyBase64url }, clientKey: generateStaticKey().key, clientKind: 'cli', pairing: { inviteId: invite.id, inviteSecret: invite.secret, clientName: '笔记本' } });
}
const closeCode = async (closed: Promise<SecureChannelError>) => (await closed).code;

describe.runIf(canBind)('remote listeners', () => {
  it('answers /health with two keys and nothing else, and refuses another Host or any Origin', async () => {
    const h = await harness();
    const port = await freePort();
    await h.remote.sync(config(port, lan(ALIAS)));
    expect(h.remote.status()).toEqual([{ host: ALIAS, kind: 'lan', enabledAt: 1, state: 'listening' }]);
    expect(h.log.info).toHaveBeenCalledWith('remote', 'remote-listening', { host: ALIAS, port, kind: 'lan' });
    const health = await get(port, '/health');
    expect(health).toEqual({ status: 200, body: '{"ok":true,"protocolVersion":2}' });
    expect(Object.keys(JSON.parse(health.body))).toEqual(['ok', 'protocolVersion']);
    expect((await get(port, '/')).status).toBe(404);
    expect((await get(port, '/health', { origin: 'http://example.test' })).status).toBe(403);
    expect((await get(port, '/health', { host: `127.0.0.3:${port}` })).status).toBe(403);
    // the WebSocket upgrade meets the same rules, before any frame
    for (const headers of [{ origin: `http://${ALIAS}:${port}` }, { host: `127.0.0.3:${port}` }]) {
      const ws = new WebSocket(`ws://${ALIAS}:${port}/`, { headers });
      ws.on('error', () => undefined);
      expect(await new Promise(resolve => { ws.once('unexpected-response', (_request, response) => resolve(response.statusCode)); ws.once('open', () => resolve('open')); })).toBe(403);
      ws.terminate();
    }
  });
  it('closes a socket that speaks no channel with 4005, counted by the limiter, and refuses a fifth unauthenticated one with 429', async () => {
    const h = await harness();
    const port = await freePort();
    await h.remote.sync(config(port, lan(ALIAS)));
    const ws = new WebSocket(`ws://${ALIAS}:${port}/`);
    await new Promise(resolve => ws.once('open', resolve));
    ws.send('hello');
    expect(await new Promise(resolve => ws.once('close', code => resolve(code)))).toBe(4005);
    // the client's own address (Linux sends from 127.0.0.1 to 127.0.0.2), the listener's address beside it
    await vi.waitFor(() => expect(h.failed).toHaveBeenCalledWith(expect.stringMatching(/^127\./), 'handshake_failed', false));
    expect(h.log.warn).toHaveBeenCalledWith('remote', 'handshake-rejected', { ip: expect.stringMatching(/^127\./), reason: 'handshake_failed', host: ALIAS });
    const held: WebSocket[] = [];
    for (let n = 0; n < 4; n++) {
      const open = new WebSocket(`ws://${ALIAS}:${port}/`);
      held.push(open);
      await new Promise(resolve => open.once('open', resolve));
    }
    const fifth = new WebSocket(`ws://${ALIAS}:${port}/`);
    fifth.on('error', () => undefined);
    expect(await new Promise(resolve => fifth.once('unexpected-response', (_request, response) => resolve(response.statusCode)))).toBe(429);
    fifth.terminate();
    // a paired one passes its hello and frees its place
    for (const open of held) open.terminate();
    await vi.waitFor(async () => { const paired = await pairOver(h, port); paired.close(); });
  });
  it('waits for an address that is not there, retries every 15 s, and drains without a timer left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = await harness({ interfaces: () => ({}) });
    const { Server } = await import('node:net');
    const listen = vi.spyOn(Server.prototype, 'listen');
    await h.remote.sync(config(17767, lan('10.255.255.254')));
    expect(h.remote.status()).toEqual([{ host: '10.255.255.254', kind: 'lan', enabledAt: 1, state: 'waiting', detail: '等待地址 10.255.255.254 出现' }]);
    expect(h.log.info).toHaveBeenCalledWith('remote', 'remote-bind-waiting', { host: '10.255.255.254', port: 17767 });
    expect(listen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(2));
    expect(h.log.info).toHaveBeenCalledTimes(1);
    void h.remote.beginDrain();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(2);
    await h.remote.release();
    expect(vi.getTimerCount()).toBe(0);
  });
  // Found writing the probe: a refused upgrade whose client never closed its side held server.close(), so disabling the
  // address, changing the port and stopping the daemon all hung.
  it('does not let a refused client that keeps its socket open hold up closing the address', async () => {
    const h = await harness();
    const port = await freePort();
    await h.remote.sync(config(port, lan(ALIAS)));
    const raw = netConnect({ port, host: ALIAS, allowHalfOpen: true });
    raw.on('error', () => undefined);
    cleanup.push(async () => { raw.destroy(); });
    raw.write(`GET / HTTP/1.1\r\nHost: ${ALIAS}:${port}\r\nOrigin: http://x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    expect(String(await new Promise(resolve => raw.once('data', resolve)))).toMatch(/^HTTP\/1\.1 403/);
    const keptAlive = netConnect({ port, host: ALIAS, allowHalfOpen: true });
    keptAlive.on('error', () => undefined);
    cleanup.push(async () => { keptAlive.destroy(); });
    keptAlive.write(`GET /health HTTP/1.1\r\nHost: ${ALIAS}:${port}\r\nConnection: keep-alive\r\n\r\n`);
    await new Promise(resolve => keptAlive.once('data', resolve));
    const started = Date.now();
    await h.remote.sync(config(port));
    expect(Date.now() - started).toBeLessThan(500);
  });
  it('waits for a port another program holds, and says how to change it', async () => {
    const h = await harness({ timers: { retry: 100 } });
    const port = await freePort();
    const squatter = createNetServer();
    await new Promise<void>(resolve => squatter.listen(port, ALIAS, resolve));
    await h.remote.sync(config(port, lan(ALIAS)));
    expect(h.remote.status()).toEqual([{ host: ALIAS, kind: 'lan', enabledAt: 1, state: 'waiting', detail: `端口 ${port} 被占用，每 15 秒重试；可用 \`vonvon remote port <n>\` 换端口` }]);
    expect(h.log.warn).toHaveBeenCalledWith('remote', 'remote-bind-failed', { host: ALIAS, port, code: 'EADDRINUSE' });
    await new Promise<void>(resolve => squatter.close(() => resolve()));
    await vi.waitFor(() => expect(h.remote.status()[0]?.state).toBe('listening'));
  });
  it('does not bind a LAN address on another network, and says so', async () => {
    const h = await harness({ networkIdentity: async () => 'gw:11:22:33:44:55:66' });
    const port = await freePort();
    const { Server } = await import('node:net');
    const listen = vi.spyOn(Server.prototype, 'listen');
    await h.remote.sync(config(port, lan(ALIAS, { iface: 'lo', network: 'gw:aa:bb:cc:dd:ee:ff' })));
    expect(h.remote.status()).toEqual([{ host: ALIAS, kind: 'lan', enabledAt: 1, state: 'needs-confirmation', detail: `这台设备所在的网络变了（之前在另一个局域网开启了 ${ALIAS}）。确认现在的网络是你信任的，再重新开启。` }]);
    expect(listen).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalledWith('remote', 'remote-network-changed', { host: ALIAS, iface: 'lo' });
    // opened again, on this network: it binds
    await h.remote.sync(config(port, lan(ALIAS, { iface: 'lo', network: 'gw:11:22:33:44:55:66', enabledAt: 2 })));
    expect(h.remote.status()[0]?.state).toBe('listening');
  });
  // Codex review 233-1: an address that moved to another interface is another network, whatever the gateway says (none
  // known, or the old interface gone with its gateway): it stops, its connections end, and the owner confirms.
  describe('a LAN address that moves to another interface', () => {
    const changedText = `这台设备所在的网络变了（之前在另一个局域网开启了 ${ALIAS}）。确认现在的网络是你信任的，再重新开启。`;
    const on = (name: string): Interfaces => ({ [name]: aliasNic(ALIAS).lo ?? [] });
    it('stops listening when only the interface is recorded', async () => {
      let nics = on('eth0');
      const h = await harness({ interfaces: () => nics, timers: { watch: 50, retry: 60_000 } });
      const port = await freePort();
      await h.remote.sync(config(port, lan(ALIAS, { iface: 'eth0' })));
      expect(h.remote.status()[0]?.state).toBe('listening');
      const connection = await pairOver(h, port);
      nics = on('wlan0');
      expect(await closeCode(connection.closed)).toBe('remote_disabled');
      await vi.waitFor(() => expect(h.remote.status()[0]).toMatchObject({ state: 'needs-confirmation', detail: changedText }));
      await expect(get(port, '/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(h.log.warn).toHaveBeenCalledWith('remote', 'remote-network-changed', { host: ALIAS, iface: 'eth0' });
    });
    it('stops listening when the network was known and the old interface is gone', async () => {
      let nics = on('eth0');
      // Linux: the gateway of an interface that is gone cannot be read
      const h = await harness({ interfaces: () => nics, networkIdentity: async iface => (iface === 'eth0' && nics.eth0 ? 'gw:aa:bb:cc:dd:ee:ff' : undefined), timers: { watch: 50, retry: 60_000 } });
      const port = await freePort();
      await h.remote.sync(config(port, lan(ALIAS, { iface: 'eth0', network: 'gw:aa:bb:cc:dd:ee:ff' })));
      expect(h.remote.status()[0]?.state).toBe('listening');
      nics = on('wlan0');
      await vi.waitFor(() => expect(h.remote.status()[0]).toMatchObject({ state: 'needs-confirmation', detail: changedText }));
      await expect(get(port, '/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });
    it('does not bind again on another interface, at a start or after the address came back', async () => {
      let nics = on('wlan0');
      const h = await harness({ interfaces: () => nics, timers: { watch: 50, retry: 50 } });
      const port = await freePort();
      const { Server } = await import('node:net');
      const listen = vi.spyOn(Server.prototype, 'listen');
      await h.remote.sync(config(port, lan(ALIAS, { iface: 'eth0' })));
      expect(h.remote.status()).toEqual([{ host: ALIAS, kind: 'lan', enabledAt: 1, state: 'needs-confirmation', detail: changedText }]);
      expect(listen).not.toHaveBeenCalled();
      // opened on eth0 and listening; the address leaves, and comes back on wlan0
      nics = on('eth0');
      await h.remote.sync(config(port, lan(ALIAS, { iface: 'eth0', enabledAt: 2 })));
      expect(h.remote.status()[0]?.state).toBe('listening');
      nics = {};
      await vi.waitFor(() => expect(h.remote.status()[0]?.state).toBe('waiting'));
      const binds = listen.mock.calls.length;
      nics = on('wlan0');
      await vi.waitFor(() => expect(h.remote.status()[0]).toMatchObject({ state: 'needs-confirmation', detail: changedText }));
      expect(listen.mock.calls.length).toBe(binds);
      await expect(get(port, '/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });
  });
  // Codex review 232-2 / devices 4.7: draining keeps the address open for what a draining daemon answers; the release
  // closes it. The hub's drain decides about the connections, as on the loopback.
  it('keeps listening while draining, with no retry or watch, and closes at the release', async () => {
    let nics = aliasNic(ALIAS);
    const h = await harness({ interfaces: () => nics, timers: { watch: 50, retry: 50 } });
    const port = await freePort();
    await h.remote.sync(config(port, lan(ALIAS)));
    const before = await pairOver(h, port);
    await h.remote.beginDrain();
    expect(h.remote.status()[0]?.state).toBe('listening');
    expect((await get(port, '/health')).status).toBe(200);
    const during = await pairOver(h, port);
    expect(during.serverInfo.principal).toBe('owner:paired');
    // no watch while draining: the address leaving does not close it
    nics = {};
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(h.remote.status()[0]?.state).toBe('listening');
    expect((await get(port, '/health')).status).toBe(200);
    // 1001 server_shutdown, said inside the channel (a client takes 1001 as `closed`, and reconnects)
    const ends = Promise.all([before.closed, during.closed]);
    await h.remote.release();
    expect((await ends).map(end => end.closeCode)).toEqual([1001, 1001]);
    await expect(get(port, '/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
  it('goes back to waiting when the address leaves, and its connections end with 4006', async () => {
    const h = await harness({ timers: { watch: 100, retry: 60_000 } });
    const port = await freePort();
    await h.remote.sync(config(port, lan(ALIAS)));
    const connection = await pairOver(h, port);
    h.gone();
    expect(await closeCode(connection.closed)).toBe('remote_disabled');
    await vi.waitFor(() => expect(h.remote.status()[0]).toMatchObject({ state: 'waiting', detail: `等待地址 ${ALIAS} 出现` }));
    await expect(get(port, '/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
  it('closes a disabled address and rebinds every one on a new port, their connections ending with 4006', async () => {
    const h = await harness();
    const [first, second] = [await freePort(), await freePort()];
    await h.remote.sync(config(first, lan(ALIAS)));
    const before = await pairOver(h, first);
    await h.remote.sync(config(second, lan(ALIAS)));
    expect(await closeCode(before.closed)).toBe('remote_disabled');
    expect((await get(second, '/health')).status).toBe(200);
    await expect(get(first, '/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    const after = await pairOver(h, second);
    expect(after.serverInfo.principal).toBe('owner:paired');
    expect(h.hub.peers.size).toBe(1);
    expect([...h.hub.peers][0]?.listener).toBe(ALIAS);
    await h.remote.sync(config(second));
    expect(await closeCode(after.closed)).toBe('remote_disabled');
    expect(h.remote.status()).toEqual([]);
    await expect(get(second, '/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
