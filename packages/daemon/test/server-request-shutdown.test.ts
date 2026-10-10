import { fakeService, socketClient, startFixture } from './server-fixture';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('../src/server/http', async importOriginal => {
  const { paths } = await import('../src/config/paths');
  const actual = await importOriginal<typeof import('../src/server/http')>();
  return { ...actual, startApi: (options: Parameters<typeof actual.startApi>[0]) => {
    expect(paths.appDir.startsWith(join(tmpdir(), 'vonvon-api-'))).toBe(true);
    return actual.startApi(options);
  } };
});
afterEach(() => { vi.restoreAllMocks(); });

function gate() {
  let release = (): void => { throw new Error('gate not initialized'); };
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it.each([false, true])('retains a detached uninstall and its snapshot completion when service rejects %s', async rejects => {
  const entered = gate();
  const operation = gate();
  const finishing = gate();
  const snapshot = gate();
  let finishStarted = false;
  let completed = false;
  const fixture = await startFixture(fakeService({
    uninstallBackend: async () => {
      entered.release();
      await operation.promise;
      finishStarted = true;
      if (rejects) throw new Error('uninstall rejected');
      return { ok: true, message: 'removed' };
    },
    listBots: async () => {
      if (finishStarted) { finishing.release(); await snapshot.promise; completed = true; }
      return [];
    },
  }));
  const client = await socketClient(fixture.api.port, fixture.credential);
  let closing: Promise<void> | undefined;
  try {
    await client.ready();
    client.socket.send(JSON.stringify({ type: 'request', id: 'uninstall', method: 'environment', payload: { type: 'backendUninstall', id: 'fake' } }));
    await entered.promise;
    await client.close();
    let settled = false;
    closing = fixture.api.close();
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await tick(); await tick();
    expect(settled).toBe(false);
    operation.release();
    await Promise.race([finishing.promise, closing.then(() => { throw new Error('API closed before uninstall snapshot completion'); })]);
    await tick();
    expect(settled).toBe(false);
    snapshot.release();
    await closing;
    expect(completed).toBe(true);
  } finally {
    operation.release(); snapshot.release();
    await closing;
    await client.close();
    await fixture.close();
  }
});

it('starts service and Jobs cancellation while an accepted Codex setup RPC is held', async () => {
  const probeEntered = gate();
  const probe = gate();
  const serviceCleanup = gate();
  const backendCleanup = gate();
  const closeEntered = gate();
  let holdProbe = false;
  let backendSignal: AbortSignal | undefined;
  const close = vi.fn(() => { closeEntered.release(); return serviceCleanup.promise; });
  const fixture = await startFixture(fakeService({
    close,
    codexSetup: async () => {
      if (holdProbe) { probeEntered.release(); await probe.promise; }
      return { installation: 'missing', authentication: 'unknown', version: null, executable: null };
    },
    installBackend: async (_id, _progress, signal) => {
      backendSignal = signal;
      await backendCleanup.promise;
      return { ok: false, code: null, aborted: true, tail: '' };
    },
  }));
  const client = await socketClient(fixture.api.port, fixture.credential);
  let closing: Promise<void> | undefined;
  try {
    await client.ready();
    await client.call({ type: 'request', id: 'install', method: 'environment', payload: { type: 'backendInstall', id: 'fake', update: false } });
    holdProbe = true;
    client.socket.send(JSON.stringify({ type: 'request', id: 'probe', method: 'admin', payload: { type: 'codexSetup' } }));
    await probeEntered.promise;
    let settled = false;
    closing = fixture.api.close();
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(client.socket.readyState).toBe(WebSocket.CLOSED));
    expect(close).toHaveBeenCalledOnce();
    expect(backendSignal?.aborted).toBe(true);
    await closeEntered.promise;
    holdProbe = false;
    serviceCleanup.release(); backendCleanup.release();
    await tick(); await tick();
    expect(settled).toBe(false);
    probe.release();
    await closing;
  } finally {
    probe.release(); serviceCleanup.release(); backendCleanup.release();
    await closing;
    await client.close();
    await fixture.close();
  }
});

it('allows an afterReply stop signal to initiate API close without waiting on itself', async () => {
  const fixture = await startFixture();
  const client = await socketClient(fixture.api.port, fixture.credential);
  const signalled = gate();
  let closing: Promise<void> | undefined;
  fixture.control.requestStop = () => { closing = fixture.api.close(); void closing.catch(() => undefined); signalled.release(); };
  try {
    await client.ready();
    expect(await client.call({ type: 'request', id: 'stop', method: 'machine', payload: { type: 'stopHost' } })).toMatchObject({ type: 'response', id: 'stop', payload: { type: 'done' } });
    await signalled.promise;
    await closing;
  } finally { await client.close(); await fixture.close(); }
});
