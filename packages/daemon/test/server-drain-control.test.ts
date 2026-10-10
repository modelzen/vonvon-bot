import { fakeService, socketClient, startFixture } from './server-fixture';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
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

it('serves fresh authenticated status and stop during held drain without rebuilding snapshots or emitting events', async () => {
  const work = gate();
  const listBots = vi.fn(async () => []);
  const getDaemonStatus = vi.fn(async () => ({ installed: false, running: true, selfHosted: true, version: 'test', supported: false, pid: process.pid }));
  const fixture = await startFixture(fakeService({ listBots, getDaemonStatus, close: () => work.promise }));
  const owner = await recordOwner(fixture);
  const draining = fixture.api.beginDrain();
  void draining.catch(() => undefined);
  const client = await socketClient(fixture.api.port, fixture.credential);
  try {
    await client.ready();
    const snapshotReads = listBots.mock.calls.length;
    const statusReads = getDaemonStatus.mock.calls.length;
    expect(await client.call({ type: 'request', id: 'status', method: 'admin', payload: { type: 'daemonStatus' } })).toMatchObject({ type: 'response', payload: { kind: 'daemonStatus', status: { running: true, pid: owner.pid, installed: false, supported: false } } });
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
  { type: 'request', id: 'machine', method: 'machine', payload: { type: 'coreUpdateStatus' } },
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
