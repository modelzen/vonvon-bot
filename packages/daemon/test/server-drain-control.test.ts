import { fakeService, socketClient, startFixture } from './server-fixture';
import { createServer } from 'node:net';
import { Server } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { Request } from '@vonvon/protocol';
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
  { type: 'request', id: 'snapshot', method: 'snapshot', payload: { type: 'get' } },
  { type: 'request', id: 'admin', method: 'admin', payload: { type: 'codexSetup' } },
  { type: 'request', id: 'machine', method: 'machine', payload: { type: 'checkCoreUpdate' } },
  { type: 'request', id: 'environment', method: 'environment', payload: { type: 'backendUninstall', id: 'test' } },
  { type: 'request', id: 'directory', method: 'directory', payload: { type: 'list', path: '/' } },
];
it.each(forbidden)('rejects ordinary drain request $id with 1001', async request => {
  const work = gate();
  const uninstall = vi.fn(async () => ({ ok: true, message: 'removed' }));
  const fixture = await startFixture(fakeService({ close: () => work.promise, uninstallBackend: uninstall }));
  await recordOwner(fixture);
  const draining = fixture.api.beginDrain();
  void draining.catch(() => undefined);
  const client = await socketClient(fixture.api.port, fixture.credential);
  try {
    await client.ready();
    const closing = closed(client.socket);
    client.socket.send(JSON.stringify(request));
    await vi.waitFor(() => expect(client.socket.readyState).toBe(WebSocket.CLOSED));
    expect(await closing).toEqual({ code: 1001, reason: 'server_shutdown' });
    expect(uninstall).not.toHaveBeenCalled();
    expect(client.frames.filter(frame => frame.type !== 'serverInfo')).toEqual([]);
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

it.each(['{', JSON.stringify({ type: 'request', id: 'unknown', method: 'future', payload: {} }), JSON.stringify({ type: 'request', id: 'invalid', method: 'admin', payload: {} })])('rejects invalid authenticated drain traffic with shutdown closure: %s', async message => {
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
