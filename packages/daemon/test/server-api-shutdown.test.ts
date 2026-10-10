import { rm } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Jobs } from '../src/server/jobs';
import { fakeService, socketClient, startFixture } from './server-fixture';
import type { InstallResult } from '../src/agent/installer';

const teardown = vi.hoisted(() => ({ failSocket: false, socketClosed: false }));
vi.mock('../src/server/ws', async importOriginal => {
  const original = await importOriginal<typeof import('../src/server/ws')>();
  return { ...original, createSocketServer: (...args: Parameters<typeof original.createSocketServer>) => {
    const sockets = original.createSocketServer(...args);
    return { ...sockets, release: async () => {
      await sockets.release();
      teardown.socketClosed = true;
      if (teardown.failSocket) throw new Error('socket teardown failed');
    } };
  } };
});
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('uninitialized'); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('starts Jobs close synchronously and drains delayed replies and cleanup despite socket failure', async () => {
  const cleanup = deferred<InstallResult>();
  const rebuild = deferred<void>();
  let hold = false;
  let rebuilding = false;
  let signal: AbortSignal | undefined;
  const service = fakeService({
    listBots: async () => { if (hold) { rebuilding = true; await rebuild.promise; } return []; },
    installBackend: (_id, progress, cancellation) => { signal = cancellation; progress?.('started'); return cleanup.promise; },
  });
  const fixture = await startFixture(service);
  const client = await socketClient(fixture.api.port, fixture.credential);
  const closeSpy = vi.spyOn(Jobs.prototype, 'close');
  const settled = vi.fn();
  let closing: Promise<void> | undefined;
  try {
    await client.ready();
    hold = true;
    client.socket.send(JSON.stringify({ type: 'request', id: 'install', method: 'environment', payload: { type: 'backendInstall', id: 'fake', update: false } }));
    await vi.waitFor(() => expect(rebuilding).toBe(true));
    teardown.failSocket = true;
    closing = fixture.api.close();
    void closing.then(settled, settled);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(fixture.api.close()).toBe(closing);
    await vi.waitFor(() => expect(client.socket.readyState).toBe(WebSocket.CLOSED));
    expect(teardown.socketClosed).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    cleanup.resolve({ ok: false, code: null, aborted: true, tail: 'cancelled' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    hold = false;
    rebuild.resolve();
    await expect(closing).rejects.toThrow('API shutdown failed');
    expect(teardown.socketClosed).toBe(true);
  } finally {
    hold = false;
    rebuild.resolve();
    cleanup.resolve({ ok: false, code: null, aborted: true, tail: 'cancelled' });
    await client.close();
    await Promise.allSettled([closing ?? fixture.api.close()]);
    closeSpy.mockRestore();
    teardown.failSocket = false;
    teardown.socketClosed = false;
    await rm(fixture.home, { recursive: true, force: true });
  }
});
