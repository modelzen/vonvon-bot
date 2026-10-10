import { fakeService, socketClient, startFixture } from './server-fixture';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import * as directoryModule from '../src/server/directory-browser';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { CodexSetupService } from '../src/agent/codex-appserver/setup';
import type { startApi as startApiType } from '../src/server/http';
import * as snapshotModule from '../src/server/snapshot';

vi.mock('../src/server/http', async importOriginal => {
  const { paths } = await import('../src/config/paths');
  const actual = await importOriginal<typeof import('../src/server/http')>();
  return { ...actual, startApi: (options: Parameters<typeof actual.startApi>[0]) => {
    expect(paths.appDir.startsWith(join(tmpdir(), 'vonvon-api-'))).toBe(true);
    return actual.startApi(options);
  } };
});

beforeEach(() => { vi.stubEnv('CODEX_BIN', ''); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function gate() {
  let release = (): void => { throw new Error('gate not initialized'); };
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function causes(error: unknown): unknown[] { return error instanceof AggregateError ? error.errors.flatMap(causes) : [error]; }

it('drains an authenticated Codex install through its cleanup gate and shares reentrant close', async () => {
  const cleanup = gate();
  let signal: AbortSignal | undefined;
  const tools = new CodexSetupService({ install: cancellation => { signal = cancellation; return cleanup.promise; } });
  let reentered: Promise<void> | undefined;
  let api: Awaited<ReturnType<typeof startApiType>> | undefined;
  const close = vi.fn(() => { reentered = api?.close(); return tools.close(); });
  const fixture = await startFixture(fakeService({ startCodexJob: type => tools.start(type), codexJob: id => tools.get(id), close }));
  api = fixture.api;
  const client = await socketClient(api.port, fixture.credential);
  let settled = false;
  try {
    await client.ready();
    expect(await client.call({ type: 'request', id: 'install', method: 'command', payload: { type: 'installCodex' } })).toMatchObject({ type: 'response', payload: { kind: 'started' } });
    const closing = api.close();
    void closing.then(() => { settled = true; });
    expect(api.close()).toBe(closing);
    await tick();
    expect(signal?.aborted).toBe(true);
    expect(reentered).toBe(closing);
    expect(close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    cleanup.release();
    await closing;
    expect(api.close()).toBe(closing);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    cleanup.release();
    await tools.close();
    await client.close();
    await fixture.close();
  }
});

it.each(['throw', 'reject'] as const)('keeps Jobs, sockets, snapshots and HTTP cleanup after service %s', async mode => {
  const cleanup = gate();
  const failure = new Error(`service ${mode}`);
  let signal: AbortSignal | undefined;
  const original = snapshotModule.createSnapshotStore;
  let store: snapshotModule.SnapshotStore | undefined;
  const snapshotSpy = vi.spyOn(snapshotModule, 'createSnapshotStore').mockImplementation(async options => {
    store = await original(options);
    vi.spyOn(store, 'close');
    return store;
  });
  const fixture = await startFixture(fakeService({
    close: () => { if (mode === 'throw') throw failure; return Promise.reject(failure); },
    installBackend: async (_id, _progress, cancellation) => { signal = cancellation; await cleanup.promise; return { ok: false, code: null, aborted: true, tail: '' }; },
  }));
  const client = await socketClient(fixture.api.port, fixture.credential);
  let settled = false;
  try {
    await client.ready();
    await client.call({ type: 'request', id: 'backend', method: 'environment', payload: { type: 'backendInstall', id: 'fake', update: false } });
    const closing = fixture.api.close();
    const outcome = closing.catch(error => error);
    void outcome.then(() => { settled = true; });
    await vi.waitFor(() => expect(client.socket.readyState).toBe(WebSocket.CLOSED));
    await tick();
    expect(signal?.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(store?.close).not.toHaveBeenCalled();
    cleanup.release();
    expect(causes(await outcome)).toContain(failure);
    expect(store?.close).toHaveBeenCalledOnce();
    await expect(fetch(`http://127.0.0.1:${fixture.api.port}`)).rejects.toThrow();
    expect(fixture.api.close()).toBe(closing);
  } finally {
    cleanup.release();
    await client.close();
    await fixture.api.close().catch(() => undefined);
    await rm(fixture.home, { recursive: true, force: true });
    snapshotSpy.mockRestore();
  }
});

it('supports a service without close', async () => {
  const fixture = await startFixture();
  try { await fixture.api.close(); } finally { await fixture.close(); }
});

it.each([['snapshot', false], ['snapshot', true], ['listen', false], ['listen', true]] as const)('awaits %s startup rollback with cleanup rejection %s and retains its causes', async (phase, rejectCleanup) => {
  const fixture = await startFixture();
  await fixture.api.close();
  const blocker = createServer();
  const cleanup = gate();
  const startupError = new Error('snapshot startup failed');
  const cleanupError = new Error('service rollback failed');
  const entered = vi.fn();
  let construction: Promise<unknown> | undefined;
  try {
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('missing blocker address');
    const { startApi } = await import('../src/server/http');
    construction = startApi({ port: phase === 'listen' ? address.port : 0, service: fakeService({
      ...(phase === 'snapshot' ? { listBots: async () => { throw startupError; } } : {}),
      close: async () => { entered(); await cleanup.promise; if (rejectCleanup) throw cleanupError; },
    }) }).then(value => { throw new Error(`unexpected listening API ${value.port}`); }, error => error);
    let settled = false;
    void construction.then(() => { settled = true; });
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    cleanup.release();
    const errors = causes(await construction);
    if (rejectCleanup) expect(errors).toContain(cleanupError);
    else expect(errors).not.toContain(cleanupError);
    if (phase === 'snapshot') expect(errors).toContain(startupError);
    else expect(errors).toContainEqual(expect.objectContaining({ code: 'EADDRINUSE' }));
  } finally {
    cleanup.release();
    await construction;
    await new Promise<void>(resolve => blocker.close(() => resolve()));
    await fixture.close();
  }
});

it('retains queued snapshots and tool refresh until service and snapshot drains settle', async () => {
  const serviceCleanup = gate();
  const readCleanup = gate();
  const toolCleanup = gate();
  const original = snapshotModule.createSnapshotStore;
  let store: snapshotModule.SnapshotStore | undefined;
  const spy = vi.spyOn(snapshotModule, 'createSnapshotStore').mockImplementation(async options => {
    store = await original(options);
    vi.spyOn(store, 'close');
    return store;
  });
  let hold = false;
  const close = vi.fn(() => serviceCleanup.promise);
  const fixture = await startFixture(fakeService({
    close,
    listBots: async () => { if (hold) await readCleanup.promise; return []; },
    codexSetup: async () => { if (hold) await toolCleanup.promise; return { installation: 'missing', authentication: 'unknown', version: null, executable: null }; },
  }));
  let refresh: Promise<void> | undefined;
  try {
    hold = true;
    fixture.api.invalidate();
    refresh = store?.refreshTools();
    const closing = fixture.api.close();
    let settled = false;
    void closing.then(() => { settled = true; });
    await tick();
    expect(close).toHaveBeenCalledOnce();
    expect(store?.close).not.toHaveBeenCalled();
    serviceCleanup.release();
    await vi.waitFor(() => expect(store?.close).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    readCleanup.release();
    await tick();
    expect(settled).toBe(false);
    toolCleanup.release();
    await closing;
    await refresh;
  } finally {
    serviceCleanup.release(); readCleanup.release(); toolCleanup.release();
    await refresh;
    await fixture.close();
    spy.mockRestore();
  }
});

it.each(['mkdir', 'identity', 'directory'] as const)('awaits service rollback after %s preflight fails and retains async cleanup failure', async phase => {
  const fixture = await startFixture();
  await fixture.api.close();
  const cleanup = gate();
  const cleanupError = new Error('preflight cleanup rejected');
  const directoryError = new Error('directory preflight failed');
  const close = vi.fn(async () => { await cleanup.promise; throw cleanupError; });
  let construction: Promise<unknown> | undefined;
  try {
    if (phase === 'mkdir') {
      await rm(fixture.home, { recursive: true });
      await writeFile(fixture.home, 'not a directory');
    } else if (phase === 'identity') {
      await writeFile(join(fixture.home, 'local-credential'), 'invalid');
    } else {
      vi.spyOn(directoryModule, 'createDirectoryBrowser').mockRejectedValue(directoryError);
    }
    const { startApi } = await import('../src/server/http');
    construction = startApi({ port: 0, service: fakeService({ close }) }).then(
      async api => { await api.close(); return new Error('unexpected API startup'); }, error => error,
    );
    let settled = false;
    void construction.then(() => { settled = true; });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    cleanup.release();
    const errors = causes(await construction);
    expect(errors).toContain(cleanupError);
    if (phase === 'directory') expect(errors).toContain(directoryError);
    else if (phase === 'identity') expect(errors).toContainEqual(new Error('Invalid local credential file'));
    else expect(errors).toContainEqual(expect.objectContaining({ code: 'EEXIST' }));
    expect(close).toHaveBeenCalledOnce();
  } finally {
    cleanup.release();
    await construction;
    await rm(fixture.home, { recursive: true, force: true });
  }
});

it('retains identity failure and a synchronous service rollback failure', async () => {
  const fixture = await startFixture();
  await fixture.api.close();
  const cleanupError = new Error('synchronous rollback failed');
  const close = vi.fn(() => { throw cleanupError; });
  try {
    await writeFile(join(fixture.home, 'local-credential'), 'invalid');
    const { startApi } = await import('../src/server/http');
    const result = await startApi({ service: fakeService({ close }), port: 0 }).catch(error => error);
    expect(causes(result)).toContainEqual(new Error('Invalid local credential file'));
    expect(causes(result)).toContain(cleanupError);
    expect(close).toHaveBeenCalledOnce();
  } finally { await fixture.close(); }
});
