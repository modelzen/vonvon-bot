import { socketClient } from './server-fixture';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { machineIdSchema } from '@vonvon/protocol';
import { createSocketServer } from '../src/server/ws';

afterEach(() => { vi.restoreAllMocks(); });
function gate() {
  let release = (): void => { throw new Error('gate not initialized'); };
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it('closes admission synchronously, shares reentrant close, and retains the accepted callback', async () => {
  const server = createServer();
  const entered = gate();
  const operation = gate();
  const detached = gate();
  let reentered: Promise<void> | undefined;
  const calls: string[] = [];
  const sockets = createSocketServer({
    server, credential: 'test-credential',
    info: { type: 'serverInfo', machineId: machineIdSchema.parse('00000000-0000-4000-8000-000000000000'), version: 'test', protocolVersion: 1 },
    request: async (_peer, request) => { calls.push(request.id); entered.release(); await operation.promise; },
    detached: () => { reentered = sockets.close(); void reentered.catch(() => undefined); detached.release(); },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listening address');
  const client = await socketClient(address.port, 'test-credential');
  let closing: Promise<void> | undefined;
  let late: WebSocket | undefined;
  try {
    await client.ready();
    client.socket.send(JSON.stringify({ type: 'request', id: 'accepted', method: 'snapshot', payload: { type: 'get' } }));
    await entered.promise;
    const originalClose = WebSocket.prototype.close;
    const closeSpy = vi.spyOn(WebSocket.prototype, 'close').mockImplementation(function (this: WebSocket, ...args) {
      if (this !== client.socket) this.emit('message', Buffer.from(JSON.stringify({ type: 'request', id: 'late', method: 'snapshot', payload: { type: 'get' } })), false);
      return originalClose.apply(this, args);
    });
    let settled = false;
    closing = sockets.close();
    void closing.then(() => { settled = true; }, () => { settled = true; });
    expect.soft(sockets.close()).toBe(closing);
    await detached.promise;
    await tick();
    closeSpy.mockRestore();
    expect.soft(reentered).toBe(closing);
    expect.soft(calls).toEqual(['accepted']);
    expect.soft(settled).toBe(false);
    late = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const upgraded = await new Promise<boolean>(resolve => {
      late?.once('open', () => resolve(true));
      late?.once('error', () => resolve(false));
    });
    expect(upgraded).toBe(false);
    operation.release();
    await closing;
  } finally {
    operation.release();
    late?.terminate();
    await closing;
    await reentered;
    await client.close();
    await sockets.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
