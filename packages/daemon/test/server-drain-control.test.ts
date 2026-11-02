import { fakeService, socketClient, startFixture } from './server-fixture';
import { createServer } from 'node:net';
import { Server } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { decodePairingLink, type DesktopSnapshot, type Request } from '@vonvon/protocol';
import type { AdminBot, AdminService } from '../src/admin/service';
import { connectLocal, ConnectionError, type VonvonClient } from '@vonvon/client';
import { connectSecure, generateStaticKey, nodeBinarySocket } from '@vonvon/client/secure';
import { withDaemon } from '../src/cli/daemon-client';
import { getPidLockInfo, releasePidLock, type PidLockInfo } from '../src/server/pid-lock';

function gate() {
  let release = (): void => { throw new Error('uninitialized gate'); };
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function closed(socket: WebSocket) {
  return new Promise<{ code: number; reason: string }>(resolve => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}
async function recordOwner(fixture: Awaited<ReturnType<typeof startFixture>>) {
  const lock: PidLockInfo = { pid: process.pid, startedAt: new Date().toISOString(), listen: fixture.api.listen };
  await writeFile(join(fixture.home, 'daemon.pid'), JSON.stringify(lock));
  return lock;
}
afterEach(() => { vi.restoreAllMocks(); });

it('detaches existing peers immediately while accepted work and its completion still drain', async () => {
  const entered = gate();
  const work = gate();
  const completed = vi.fn();
  const fixture = await startFixture(fakeService({ uninstallBackend: async () => {
    entered.release(); await work.promise; completed(); return { ok: true, message: 'removed' };
  } }));
  await recordOwner(fixture);
  const client = await socketClient(fixture.api.port, fixture.credential);
  let draining: Promise<void> | undefined;
  try {
    await client.ready();
    const oldClosed = closed(client.socket);
    client.socket.send(JSON.stringify({ type: 'request', id: 'held', method: 'environment', payload: { type: 'backendUninstall', id: 'test' } }));
    await entered.promise;
    const settled = vi.fn();
    draining = fixture.api.beginDrain();
    void draining.then(settled, settled);
    await vi.waitFor(() => expect(client.socket.readyState).toBe(WebSocket.CLOSED));
    expect(await oldClosed).toEqual({ code: 1001, reason: 'server_shutdown' });
    expect(settled).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    work.release();
    await draining;
    expect(completed).toHaveBeenCalledOnce();
  } finally {
    work.release();
    await Promise.allSettled([draining]);
    await client.close(); await fixture.close();
  }
});

// main 必败 for the update status line: coreUpdateStatus closed the socket while the daemon drained to update (server-3 4.6)
it('serves fresh authenticated status, update progress and stop during held drain without rebuilding snapshots or emitting events', async () => {
  const work = gate();
  const listBots = vi.fn(async () => []);
  const getDaemonStatus = vi.fn(async () => ({ installed: false, running: true, selfHosted: true, version: 'test', supported: false, pid: process.pid }));
  const updating = { phase: 'restarting' as const, ok: true, from: '1.0.0', to: '1.0.1', previous: '1.0.0', at: 1, detail: 'draining' as const };
  const fixture = await startFixture(fakeService({ listBots, getDaemonStatus, close: () => work.promise, updateStatus: () => updating }));
  const owner = await recordOwner(fixture);
  const draining = fixture.api.beginDrain();
  void draining.catch(() => undefined);
  const client = await socketClient(fixture.api.port, fixture.credential);
  try {
    await client.ready();
    const snapshotReads = listBots.mock.calls.length;
    const statusReads = getDaemonStatus.mock.calls.length;
    expect(await client.call({ type: 'request', id: 'status', method: 'admin', payload: { type: 'daemonStatus' } })).toMatchObject({ type: 'response', payload: { kind: 'daemonStatus', status: { running: true, pid: owner.pid, installed: false, supported: false } } });
    expect(await client.call({ type: 'request', id: 'update', method: 'machine', payload: { type: 'coreUpdateStatus' } })).toMatchObject({ type: 'response', payload: { type: 'coreUpdateStatus', status: updating } });
    expect(await client.call({ type: 'request', id: 'stop', method: 'machine', payload: { type: 'stopHost' } })).toMatchObject({ type: 'response', payload: { type: 'done' } });
    expect(fixture.control.requestStop).toHaveBeenCalledOnce();
    expect(listBots).toHaveBeenCalledTimes(snapshotReads);
    expect(getDaemonStatus).toHaveBeenCalledTimes(statusReads);
    expect(client.frames.filter(frame => frame.type === 'event')).toEqual([]);
    expect(await getPidLockInfo(fixture.home)).toEqual(owner);
    work.release();
    await draining;
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    const drainClosed = closed(client.socket);
    await fixture.api.release();
    await drainClosed;
    expect(client.socket.readyState).toBe(WebSocket.CLOSED);
    expect(await getPidLockInfo(fixture.home)).toEqual(owner);
    const replacement = createServer();
    try {
      await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(fixture.api.port, '127.0.0.1', resolve); });
      await releasePidLock(fixture.home, owner);
      expect(await getPidLockInfo(fixture.home)).toBeNull();
    } finally { await new Promise<void>(resolve => replacement.close(() => resolve())); }
  } finally {
    work.release(); await Promise.allSettled([draining]);
    await client.close(); await fixture.close();
  }
});

const forbidden: Request[] = [
  { type: 'request', id: 'settings', method: 'settings', payload: { type: 'read', scope: { kind: 'host' } } },
  { type: 'request', id: 'collaboration', method: 'collaboration', payload: { action: 'usage', force: false } },
  { type: 'request', id: 'command', method: 'command', payload: { type: 'refresh' } },
  { type: 'request', id: 'admin', method: 'admin', payload: { type: 'codexSetup' } },
  { type: 'request', id: 'machine', method: 'machine', payload: { type: 'checkCoreUpdate' } },
  { type: 'request', id: 'environment', method: 'environment', payload: { type: 'backendUninstall', id: 'test' } },
  { type: 'request', id: 'directory', method: 'directory', payload: { type: 'list', path: '/' } },
];
// devices 4.7 / Codex review 248: the rest reads `draining`, the connection kept, so a client that reconnected to follow
// an update is not closed for what its page asks. main 必败: the drain closed the connection 1001.
it.each(forbidden)('answers ordinary drain request $id with draining and keeps the connection', async request => {
  const work = gate();
  const uninstall = vi.fn(async () => ({ ok: true, message: 'removed' }));
  const fixture = await startFixture(fakeService({ close: () => work.promise, uninstallBackend: uninstall }));
  await recordOwner(fixture);
  const draining = fixture.api.beginDrain();
  void draining.catch(() => undefined);
  const client = await socketClient(fixture.api.port, fixture.credential);
  try {
    await client.ready();
    expect(await client.call(request)).toMatchObject({ type: 'error', id: request.id, code: 'draining' });
    expect(uninstall).not.toHaveBeenCalled();
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(await client.call({ type: 'request', id: 'after', method: 'admin', payload: { type: 'daemonStatus' } })).toMatchObject({ type: 'response', id: 'after' });
  } finally { work.release(); await Promise.allSettled([draining]); await client.close(); await fixture.close(); }
});

// devices 4.7: DRAIN_KINDS is the one list, and it has coreUpdateStatus, so an update's progress stays visible while the
// daemon stops for it. main 必败: a draining daemon closed the connection with 1001.
it('answers machine.coreUpdateStatus during drain, to whoever the table lets ask it', async () => {
  const work = gate();
  const status = { phase: 'restarting' as const, to: '0.9.1', at: 1 };
  const fixture = await startFixture(fakeService({ close: () => work.promise, updateStatus: () => status }));
  await recordOwner(fixture);
  const draining = fixture.api.beginDrain();
  void draining.catch(() => undefined);
  const client = await socketClient(fixture.api.port, fixture.credential);
  const token = fixture.sessionTokens.issue({ appId: 'cli_x', place: 'group', chatId: 'oc_y', sessionId: 'ses_0123456789abcdef' });
  const session = await socketClient(fixture.api.port, token);
  try {
    await client.ready();
    await session.ready();
    expect(await client.call({ type: 'request', id: 'u', method: 'machine', payload: { type: 'coreUpdateStatus' } }))
      .toEqual({ type: 'response', id: 'u', method: 'machine', payload: { type: 'coreUpdateStatus', status } });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    // a Bot session may not ask it, draining or not
    expect(await session.call({ type: 'request', id: 'u', method: 'machine', payload: { type: 'coreUpdateStatus' } })).toMatchObject({ type: 'error', code: 'scope_required' });
  } finally { work.release(); await Promise.allSettled([draining]); await client.close(); await session.close(); await fixture.close(); }
});

it('retains credential rejection during held drain', async () => {
  const work = gate();
  const fixture = await startFixture(fakeService({ close: () => work.promise }));
  await recordOwner(fixture);
  const draining = fixture.api.beginDrain();
  void draining.catch(() => undefined);
  const client = await socketClient(fixture.api.port, '00'.repeat(32));
  try {
    expect(await closed(client.socket)).toEqual({ code: 4401, reason: 'unauthorized' });
    expect(client.frames).toEqual([]);
    expect(await readFile(join(fixture.home, 'local-credential'), 'utf8')).toContain(fixture.credential);
  } finally { work.release(); await Promise.allSettled([draining]); await client.close(); await fixture.close(); }
});

it('release closes the actual listening port and authenticated drain peers', async () => {
  const fixture = await startFixture();
  const owner = await recordOwner(fixture);
  const draining = fixture.api.beginDrain();
  await draining.catch(() => undefined);
  const client = await socketClient(fixture.api.port, fixture.credential);
  try {
    await client.ready();
    await fixture.api.release().catch(() => undefined);
    await vi.waitFor(() => expect(client.socket.readyState).toBe(WebSocket.CLOSED));
    const probe = new WebSocket(`ws://127.0.0.1:${fixture.api.port}`);
    const connected = await new Promise<boolean>(resolve => {
      probe.once('open', () => resolve(true));
      probe.once('error', () => resolve(false));
    });
    probe.terminate();
    expect(connected).toBe(false);
    expect(await getPidLockInfo(fixture.home)).toEqual(owner);
  } finally { await client.close(); await fixture.close(); }
});

it.each(['{', JSON.stringify({ type: 'request', method: 'admin', payload: { type: 'daemonStatus' } })])('rejects authenticated drain traffic with no id to answer with shutdown closure: %s', async message => {
  const fixture = await startFixture();
  await recordOwner(fixture);
  await fixture.api.beginDrain();
  const client = await socketClient(fixture.api.port, fixture.credential);
  try {
    await client.ready();
    const closing = closed(client.socket);
    client.socket.send(message);
    expect(await closing).toEqual({ code: 1001, reason: 'server_shutdown' });
    expect(client.frames.filter(frame => frame.type !== 'serverInfo')).toEqual([]);
  } finally { await client.close(); await fixture.close(); }
});

it.each([JSON.stringify({ type: 'request', id: 'unknown', method: 'future', payload: {} }), JSON.stringify({ type: 'request', id: 'invalid', method: 'admin', payload: {} })])('answers drain traffic it cannot read with draining: %s', async message => {
  const fixture = await startFixture();
  await recordOwner(fixture);
  await fixture.api.beginDrain();
  const client = await socketClient(fixture.api.port, fixture.credential);
  try {
    await client.ready();
    const id = (JSON.parse(message) as { id: string }).id;
    client.socket.send(message);
    expect(await client.wait(frame => frame.type === 'error' && frame.id === id)).toMatchObject({ code: 'draining' });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  } finally { await client.close(); await fixture.close(); }
});

it('keeps its captured identity after the lock file changes during drain', async () => {
  const fixture = await startFixture();
  const owner = await recordOwner(fixture);
  await fixture.api.beginDrain();
  const client = await socketClient(fixture.api.port, fixture.credential);
  try {
    await client.ready();
    const request: Request = { type: 'request', id: 'before', method: 'admin', payload: { type: 'daemonStatus' } };
    expect(await client.call(request)).toMatchObject({ type: 'response', payload: { status: { running: true, pid: owner.pid } } });
    await writeFile(join(fixture.home, 'daemon.pid'), JSON.stringify({ ...owner, pid: owner.pid + 1 }));
    expect(await client.call({ ...request, id: 'after' })).toMatchObject({ type: 'response', payload: { status: { running: true, pid: owner.pid } } });
  } finally { await client.close(); await fixture.close(); }
});

it('initiates listener closure synchronously and awaits its actual completion callback', async () => {
  const fixture = await startFixture();
  await recordOwner(fixture);
  await fixture.api.beginDrain();
  const closedListener = gate();
  let confirmClosure = (): void => { throw new Error('listener is not closed'); };
  const original = Server.prototype.close;
  const close = vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, callback) {
    return original.call(this, error => {
      confirmClosure = () => callback?.(error);
      closedListener.release();
    });
  });
  let releasing: Promise<void> | undefined;
  try {
    const settled = vi.fn();
    releasing = fixture.api.release();
    void releasing.then(settled, settled);
    expect(close).toHaveBeenCalledOnce();
    expect(fixture.api.release()).toBe(releasing);
    await closedListener.promise;
    expect(settled).not.toHaveBeenCalled();
    confirmClosure();
    await releasing;
    expect(settled).toHaveBeenCalledOnce();
  } finally {
    close.mockRestore();
    confirmClosure();
    await releasing;
    await fixture.close();
  }
});

function cleanupReasons(error: unknown): unknown[] {
  return error instanceof AggregateError ? [error, ...error.errors.flatMap(cleanupReasons)] : [error];
}

it('settles a failed 250ms peer termination after actual HTTP cutoff without a WSS callback', async () => {
  const fixture = await startFixture();
  await recordOwner(fixture);
  await fixture.api.beginDrain();
  const client = await socketClient(fixture.api.port, fixture.credential);
  await client.ready();
  const terminationError = new Error('fixture release timer terminate failed');
  const actualHttpClose = gate();
  const realHttpClose = Server.prototype.close;
  const realSocketClose = WebSocket.prototype.close;
  const realTerminate = WebSocket.prototype.terminate;
  const realWssClose = WebSocketServer.prototype.close;
  let wssCallbackObserved = false;
  let forwardWss = (): void => {};
  const serverPeers = new Set<WebSocket>();
  vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, callback) {
    return realHttpClose.call(this, error => { actualHttpClose.release(); callback?.(error); });
  });
  vi.spyOn(WebSocket.prototype, 'close').mockImplementation(function (this: WebSocket, ...args) {
    if (this === client.socket) return realSocketClose.apply(this, args);
    serverPeers.add(this);
  });
  vi.spyOn(WebSocket.prototype, 'terminate').mockImplementation(function (this: WebSocket) {
    if (serverPeers.has(this)) { realTerminate.call(this); throw terminationError; }
    return realTerminate.call(this);
  });
  vi.spyOn(WebSocketServer.prototype, 'close').mockImplementation(function (this: WebSocketServer, callback) {
    return realWssClose.call(this, error => { forwardWss = () => { wssCallbackObserved = true; callback?.(error); }; });
  });
  let releasing: Promise<unknown> | undefined;
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const settled = vi.fn();
    releasing = fixture.api.release().then(() => { settled(); return undefined; }, error => { settled(); return error; });
    let escaped: unknown;
    try { await vi.advanceTimersByTimeAsync(250); } catch (error) { escaped = error; }
    vi.useRealTimers();
    await actualHttpClose.promise;
    expect.soft(escaped, 'termination errors belong to release, not the timer callback').toBeUndefined();
    expect(wssCallbackObserved).toBe(false);
    await vi.waitFor(() => expect(settled, 'known termination failure must settle without WSS close callback').toHaveBeenCalledOnce(), { timeout: 500 });
    const { ApiCleanupError } = await import('../src/server/http');
    const error = await releasing;
    expect(error).toBeInstanceOf(ApiCleanupError);
    expect(cleanupReasons(error)).toContain(terminationError);
    const replacement = createServer();
    try {
      await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(fixture.api.port, '127.0.0.1', resolve); });
      expect(replacement.address()).toMatchObject({ port: fixture.api.port });
    } finally { await new Promise<void>(resolve => replacement.close(() => resolve())); }
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const socket of serverPeers) realTerminate.call(socket);
    client.socket.terminate();
    forwardWss();
    await releasing;
    await fixture.api.close().catch(() => undefined);
    await rm(fixture.home, { recursive: true, force: true });
  }
});

it.each(['throw', 'callback'] as const)('keeps HTTP close %s untyped when connection cleanup also fails', async failure => {
  const fixture = await startFixture();
  await fixture.api.beginDrain();
  const cleanupError = new Error('fixture WSS release failure');
  const listenerError = new Error('fixture HTTP cutoff unknown');
  const realHttpClose = Server.prototype.close;
  const realWssClose = WebSocketServer.prototype.close;
  const servers = new Set<Server>();
  const sockets = new Set<WebSocketServer>();
  vi.spyOn(WebSocketServer.prototype, 'close').mockImplementation(function (this: WebSocketServer) {
    sockets.add(this); throw cleanupError;
  });
  vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, callback) {
    servers.add(this);
    if (failure === 'throw') throw listenerError;
    callback?.(listenerError);
    return this;
  });
  try {
    const error = await fixture.api.release().then(() => undefined, error => error);
    const { ApiCleanupError } = await import('../src/server/http');
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiCleanupError);
    expect(cleanupReasons(error)).toContain(listenerError);
    expect([...servers].every(server => server.listening)).toBe(true);
  } finally {
    vi.restoreAllMocks();
    await Promise.all([...sockets].map(socket => new Promise<void>(resolve => realWssClose.call(socket, () => resolve()))));
    await Promise.all([...servers].map(server => new Promise<void>(resolve => realHttpClose.call(server, () => resolve()))));
    await fixture.api.close().catch(() => undefined);
    await rm(fixture.home, { recursive: true, force: true });
  }
});

it('retains successful peer release until the real WSS callback is forwarded', async () => {
  const fixture = await startFixture();
  await fixture.api.beginDrain();
  const client = await socketClient(fixture.api.port, fixture.credential);
  await client.ready();
  const actualWssClose = gate();
  const realClose = WebSocketServer.prototype.close;
  let forward = (): void => {};
  vi.spyOn(WebSocketServer.prototype, 'close').mockImplementation(function (this: WebSocketServer, callback) {
    return realClose.call(this, error => {
      forward = () => callback?.(error);
      actualWssClose.release();
    });
  });
  const settled = vi.fn();
  const releasing = fixture.api.release();
  void releasing.then(settled, settled);
  try {
    await actualWssClose.promise;
    expect(settled).not.toHaveBeenCalled();
    forward();
    await releasing;
    expect(settled).toHaveBeenCalledOnce();
  } finally {
    forward();
    vi.restoreAllMocks();
    client.socket.terminate();
    await releasing;
    await fixture.close();
  }
});

// Codex review 232-2 / devices 4.7: a remote client sees a draining daemon as the loopback one does. The listener stays
// open until the release, so a client whose connection the drain closed reconnects through the same channel and limits
// and asks the status and the update's progress; after the release the address takes nothing. main 必败: the drain
// closed the remote listener at once, before the work and the release.
const ALIAS = '127.0.0.2';
const canBindAlias = await new Promise<boolean>(resolve => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, ALIAS, () => probe.close(() => resolve(true)));
});
it.runIf(canBindAlias)('answers status and update progress over a remote address while draining, and closes it at the release', async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, ALIAS, () => { const bound = probe.address(); probe.close(() => (bound && typeof bound !== 'string' ? resolve(bound.port) : reject(new Error('no port')))); });
  });
  const work = gate();
  const updating = { phase: 'restarting' as const, to: '0.9.1', at: 1 };
  const fixture = await startFixture(fakeService({ close: () => work.promise, updateStatus: () => updating }), undefined, undefined, {
    interfaces: () => ({ lo: [{ address: ALIAS, netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: `${ALIAS}/8` }] }),
    tailscale: async () => ({ installed: false, ips: [] }), networkIdentity: async () => undefined, classify: async host => (host === ALIAS ? 'lan' : 'invalid'),
  });
  const owner = await recordOwner(fixture);
  const local = await socketClient(fixture.api.port, fixture.credential);
  const sockets: WebSocket[] = [];
  let draining: Promise<void> | undefined;
  try {
    await local.ready();
    await local.call({ type: 'request', id: 'port', method: 'device', payload: { type: 'setPort', port } });
    await local.call({ type: 'request', id: 'on', method: 'device', payload: { type: 'enable', host: ALIAS } });
    const pairing = await local.call({ type: 'request', id: 'pair', method: 'device', payload: { type: 'pair' } }) as { payload: { link: string } };
    const link = decodePairingLink(pairing.payload.link);
    const clientKey = generateStaticKey().key;
    const open = async (pairing?: { inviteId: string; inviteSecret: string; clientName: string }) => {
      const ws = new WebSocket(`ws://${ALIAS}:${port}/`, { perMessageDeflate: false });
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      return connectSecure({ socket: nodeBinarySocket(ws), device: { id: link.device.id, pk: link.device.pk }, clientKey, clientKind: 'desktop', ...(pairing ? { pairing } : {}) });
    };
    const paired = await open({ inviteId: link.invite.id, inviteSecret: link.invite.secret, clientName: '笔记本' });
    draining = fixture.api.beginDrain();
    void draining.catch(() => undefined);
    // the drain closes the connections it found, remote or not (the loopback's rule)
    expect((await paired.closed).closeCode).toBe(1001);
    const again = await open();
    expect(again.serverInfo.principal).toBe('owner:paired');
    expect(await again.client.admin({ type: 'daemonStatus' })).toMatchObject({ kind: 'daemonStatus', status: { running: true, pid: owner.pid } });
    expect(await again.client.machine({ type: 'coreUpdateStatus' })).toEqual({ type: 'coreUpdateStatus', status: updating });
    work.release();
    await draining;
    const closing = again.closed;
    await fixture.api.release();
    expect((await closing).closeCode).toBe(1001);
    const refused = new WebSocket(`ws://${ALIAS}:${port}/`);
    sockets.push(refused);
    expect(await new Promise(resolve => { refused.once('open', () => resolve('open')); refused.once('error', error => resolve((error as NodeJS.ErrnoException).code)); })).toBe('ECONNREFUSED');
  } finally {
    work.release();
    await Promise.allSettled([draining]);
    for (const socket of sockets) socket.terminate();
    await local.close();
    await fixture.close();
  }
});

const aliasSeams = {
  interfaces: () => ({ lo: [{ address: ALIAS, netmask: '255.0.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: true, cidr: `${ALIAS}/8` }] }),
  tailscale: async () => ({ installed: false, ips: [] }), networkIdentity: async () => undefined, classify: async (host: string) => (host === ALIAS ? 'lan' as const : 'invalid' as const),
};
async function aliasPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, ALIAS, () => { const bound = probe.address(); probe.close(() => (bound && typeof bound !== 'string' ? resolve(bound.port) : reject(new Error('no port')))); });
  });
}
/** A page's start on a connection, as the desktop bridge does it (U2 bridge.ts): watchSnapshots, which asks for a snapshot
 * itself, then a snapshot asked outright. */
async function attachPage(client: VonvonClient) {
  const errors: Error[] = [];
  const watched: DesktopSnapshot[] = [];
  client.onError(error => { errors.push(error); });
  client.watchSnapshots(value => { watched.push(value); });
  const asked = await client.snapshot();
  await vi.waitFor(() => expect(watched).toHaveLength(1));
  return { errors, watched, asked };
}
const lostConnection = (client: VonvonClient) => new Promise<Error>(resolve => { client.onError(error => { if (error instanceof ConnectionError) resolve(error); }); });

// Codex review 248 / devices 4.7: the drain closes the connections it finds (1001) and a desktop reconnects at once, through
// the real client a page stands on: the loopback's (connectLocal) and a paired device's (connectSecure). Its first request
// is the snapshot (watchSnapshots, then the bridge's own): it gets the last one built, marked stale; the update's progress
// is read as it moves; the rest of what a page asks reads `draining`, the connection kept; after the release the
// connection is closed 1001. main 必败: the snapshot request closed the connection 1001, so the page never got its snapshot
// and the client reconnected in a loop.
it.runIf(canBindAlias)('lets a client that reconnects during a held drain get its snapshot and follow the update, refusing the rest without closing it', async () => {
  const port = await aliasPort();
  const work = gate();
  const uninstall = vi.fn(async () => ({ ok: true, message: 'removed' }));
  let status: ReturnType<AdminService['updateStatus']> = { phase: 'restarting', ok: true, from: '0.9.0', to: '0.9.1', previous: '0.9.0', at: 1, detail: 'draining' };
  const fixture = await startFixture(fakeService({ close: () => work.promise, updateStatus: () => status, uninstallBackend: uninstall }), undefined, undefined, aliasSeams);
  const owner = await recordOwner(fixture);
  const cliEntry = join(fixture.home, 'fake-cli.mjs');
  await writeFile(cliEntry, `process.stdout.write(JSON.stringify({running:true,listen:"127.0.0.1:${fixture.api.port}"}));`);
  const setup = await socketClient(fixture.api.port, fixture.credential);
  const sockets: WebSocket[] = [];
  const clients: VonvonClient[] = [];
  let draining: Promise<void> | undefined;
  try {
    await setup.ready();
    await setup.call({ type: 'request', id: 'port', method: 'device', payload: { type: 'setPort', port } });
    await setup.call({ type: 'request', id: 'on', method: 'device', payload: { type: 'enable', host: ALIAS } });
    const pairing = await setup.call({ type: 'request', id: 'pair', method: 'device', payload: { type: 'pair' } }) as { payload: { link: string } };
    const link = decodePairingLink(pairing.payload.link);
    const clientKey = generateStaticKey().key;
    const remote = async (pairing?: { inviteId: string; inviteSecret: string; clientName: string }) => {
      const ws = new WebSocket(`ws://${ALIAS}:${port}/`, { perMessageDeflate: false });
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const connection = await connectSecure({ socket: nodeBinarySocket(ws), device: { id: link.device.id, pk: link.device.pk }, clientKey, clientKind: 'desktop', ...(pairing ? { pairing } : {}) });
      clients.push(connection.client);
      return connection;
    };
    const local = async () => { const { client } = await connectLocal({ home: fixture.home, cliEntry }); clients.push(client); return client; };

    const firstRemote = await remote({ inviteId: link.invite.id, inviteSecret: link.invite.secret, clientName: '笔记本' });
    const firstLocal = await local();
    const before = await attachPage(firstLocal);
    expect(before.asked.stale).toBe(false);
    await attachPage(firstRemote.client);
    const localLost = lostConnection(firstLocal);

    draining = fixture.api.beginDrain();
    void draining.catch(() => undefined);
    expect((await firstRemote.closed).closeCode).toBe(1001);
    await localLost;

    const again = await remote();
    let remoteClosed = false;
    void again.closed.then(() => { remoteClosed = true; });
    const againLocal = await local();
    for (const client of [again.client, againLocal]) {
      const page = await attachPage(client);
      expect(page.asked).toMatchObject({ stale: true, revision: before.asked.revision });
      expect(page.watched[0]).toMatchObject({ stale: true });
      expect(page.errors).toEqual([]);
      expect(await client.machine({ type: 'coreUpdateStatus' })).toEqual({ type: 'coreUpdateStatus', status });
      await expect(client.run({ type: 'refresh' })).rejects.toMatchObject({ name: 'RpcError', code: 'draining' });
      await expect(client.environment({ type: 'backendUninstall', id: 'test' })).rejects.toMatchObject({ name: 'RpcError', code: 'draining' });
      await expect(client.settings({ type: 'read', scope: { kind: 'host' } })).rejects.toMatchObject({ name: 'RpcError', code: 'draining' });
      expect(await client.admin({ type: 'daemonStatus' })).toMatchObject({ kind: 'daemonStatus', status: { running: true, pid: owner.pid } });
      expect(page.errors).toEqual([]);
    }
    expect(uninstall).not.toHaveBeenCalled();
    // the update moves on while the page polls, and neither connection was closed for what it was refused
    status = { ...status, detail: 'waiting', at: 2 };
    await new Promise(resolve => setTimeout(resolve, 300));
    for (const client of [again.client, againLocal]) expect(await client.machine({ type: 'coreUpdateStatus' })).toEqual({ type: 'coreUpdateStatus', status: expect.objectContaining({ detail: 'waiting', at: 2 }) });
    expect(remoteClosed).toBe(false);
    // the command line's restart reads the drain as before (exit 3), now from the daemon's answer, not a closed connection
    await expect(withDaemon(call => call('重启 daemon', c => c.run({ type: 'restartHost' })), () => connectLocal({ home: fixture.home, cliEntry })))
      .rejects.toMatchObject({ kind: 'connection', reason: 'draining' });

    // the work done, the daemon still answers until the release, which closes both 1001
    const probe = await socketClient(fixture.api.port, fixture.credential);
    await probe.ready();
    const probeClosed = closed(probe.socket);
    const localClosed = lostConnection(againLocal);
    work.release();
    await draining;
    expect(await again.client.machine({ type: 'coreUpdateStatus' })).toMatchObject({ type: 'coreUpdateStatus' });
    await fixture.api.release();
    expect((await again.closed).closeCode).toBe(1001);
    expect(await probeClosed).toEqual({ code: 1001, reason: 'server_shutdown' });
    await localClosed;
  } finally {
    work.release();
    await Promise.allSettled([draining]);
    await Promise.allSettled(clients.map(client => client.close()));
    for (const socket of sockets) socket.terminate();
    await setup.close();
    await fixture.close();
  }
});

// devices 4.7 with D4a: a Bot session reconnecting during a drain negotiates its scope and reads its own part of the
// snapshot, nothing more; a connection of another protocol is refused what it may never ask as when open, and closed
// 4001 after 20 in a row, draining or not.
it('gives a Bot session its own part of the snapshot during drain, and closes a connection of another protocol 4001 after 20 refusals', async () => {
  const work = gate();
  const bot = (appId: string): AdminBot => ({ appId, name: appId, tenant: 'feishu', active: true, current: appId === 'cli_x', running: true, completionReminder: { mode: 'failures' as const, longTaskMinutes: 3 } });
  const fixture = await startFixture(fakeService({ close: () => work.promise, listBots: async () => [bot('cli_x'), bot('cli_z')] }));
  await recordOwner(fixture);
  const draining = fixture.api.beginDrain();
  void draining.catch(() => undefined);
  const owner = await socketClient(fixture.api.port, fixture.credential);
  const session = await socketClient(fixture.api.port, fixture.sessionTokens.issue({ appId: 'cli_x', place: 'group', chatId: 'oc_y', sessionId: 'ses_0123456789abcdef' }));
  const old = await socketClient(fixture.api.port, fixture.credential, 1);
  try {
    await Promise.all([owner.ready(), session.ready(), old.ready()]);
    const whole = await owner.call({ type: 'request', id: 'all', method: 'snapshot', payload: { type: 'get' } }) as { payload: DesktopSnapshot };
    expect(whole.payload.agents.map(agent => agent.id).sort()).toEqual(['cli_x', 'cli_z']);
    expect(await session.call({ type: 'request', id: 'early', method: 'snapshot', payload: { type: 'get' } })).toMatchObject({ type: 'error', code: 'scope_required' });
    expect(await session.call({ type: 'request', id: 'scope', method: 'admin', payload: { type: 'negotiate', capabilities: ['cli'], scope: { bot: 'cli_x', group: 'oc_y' } } }))
      .toMatchObject({ type: 'response', payload: { kind: 'negotiated', scope: { bot: 'cli_x', group: 'oc_y' } } });
    const own = await session.call({ type: 'request', id: 'own', method: 'snapshot', payload: { type: 'get' } }) as { payload: DesktopSnapshot };
    expect(own.payload.stale).toBe(true);
    expect(own.payload.agents.map(agent => agent.id)).toEqual(['cli_x']);
    expect(await session.call({ type: 'request', id: 'upd', method: 'machine', payload: { type: 'coreUpdateStatus' } })).toMatchObject({ type: 'error', code: 'permission_denied' });
    expect(session.socket.readyState).toBe(WebSocket.OPEN);

    expect(await old.call({ type: 'request', id: 'check', method: 'machine', payload: { type: 'checkCoreUpdate' } })).toMatchObject({ type: 'error', code: 'draining' });
    expect(await old.call({ type: 'request', id: 'status', method: 'admin', payload: { type: 'daemonStatus' } })).toMatchObject({ type: 'response' });
    const oldClosed = closed(old.socket);
    for (let index = 0; index < 19; index++) {
      expect(await old.call({ type: 'request', id: `r${index}`, method: 'command', payload: { type: 'refresh' } })).toMatchObject({ type: 'error', code: 'protocol_mismatch' });
    }
    expect(old.socket.readyState).toBe(WebSocket.OPEN);
    old.socket.send(JSON.stringify({ type: 'request', id: 'r19', method: 'snapshot', payload: { type: 'get' } }));
    expect(await oldClosed).toEqual({ code: 4001, reason: 'protocol_mismatch' });
  } finally {
    work.release(); await Promise.allSettled([draining]);
    await owner.close(); await session.close(); await old.close(); await fixture.close();
  }
});
