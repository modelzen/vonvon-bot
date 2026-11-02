import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionError } from '@vonvon/client/browser';
import { generateStaticKey, staticKeyFromBase64url } from '@vonvon/protocol/secure-channel';
import { RemoteConnectError, routeUrl, secureConnector, type RemoteConnectOptions } from '../src/remote-transport.js';
import { startFakeDevice } from './helpers/fake-secure-server.js';

// devices-ui-1a 第 5 节 remote-transport: a real `ws` and D2's channel against a device on 127.0.0.1:0. main 必败: there was
// no remote transport.
const devices: Array<Awaited<ReturnType<typeof startFakeDevice>>> = [];
afterEach(async () => { for (const device of devices.splice(0)) await device.close(); });
async function device(options: Parameters<typeof startFakeDevice>[0] = {}) {
  const started = await startFakeDevice(options);
  devices.push(started);
  return started;
}
function options(target: { port: number; machineId: string; pk: string }, extra: Partial<RemoteConnectOptions> = {}): RemoteConnectOptions {
  const generated = generateStaticKey();
  return {
    route: { host: '127.0.0.1', port: target.port, kind: 'lan' },
    device: { id: target.machineId, pk: target.pk },
    clientKey: staticKeyFromBase64url(generated.publicKeyBase64url, generated.privateKeyBase64url),
    signal: new AbortController().signal,
    ...extra,
  };
}
async function failure(promise: Promise<unknown>): Promise<RemoteConnectError> {
  const error = await promise.then(() => { throw new Error('connected'); }, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(RemoteConnectError);
  return error as RemoteConnectError;
}

describe('remote transport', () => {
  it('writes an IPv6 host in brackets', () => {
    expect(routeUrl({ host: 'fd7a:115c:a1e0::1', port: 7767 })).toBe('ws://[fd7a:115c:a1e0::1]:7767/');
    expect(routeUrl({ host: '203.0.113.10', port: 7767 })).toBe('ws://203.0.113.10:7767/');
  });

  it('pairs with the invite, then comes back on the key alone, with no Origin header', async () => {
    const target = await device();
    const connector = secureConnector();
    const first = options(target);
    let opened = 0;
    const paired = await connector.connect({ ...first, pairing: { ...target.invite(), clientName: '我的 MacBook Pro' }, onSocketOpen: () => { opened++; } });
    expect(opened).toBe(1);
    expect(paired.pairResult?.clientId).toMatch(/^cl_/);
    expect(paired.serverInfo).toMatchObject({ machineId: target.machineId, deviceName: '测试机' });
    expect(target.clients.get(paired.pairResult!.clientId)?.name).toBe('我的 MacBook Pro');
    paired.close();
    await expect(paired.closed).resolves.toEqual({ code: 'closed' });

    const again = await connector.connect({ ...first });
    expect(again.pairResult).toBeUndefined();
    await expect(again.client.admin({ type: 'daemonStatus' })).resolves.toMatchObject({ kind: 'daemonStatus', status: { pid: 4242 } });
    again.close();
    expect(target.headers).toHaveLength(2);
    for (const headers of target.headers) {
      expect(headers.origin).toBeUndefined();
      expect(headers.host).toBe(`127.0.0.1:${target.port}`);
    }
  });

  it('tells a refused upgrade apart: 403 is forbidden, 429 is rate limited', async () => {
    const forbidden = await failure(secureConnector().connect(options(await device({ refuse: 403 }))));
    expect(forbidden).toMatchObject({ code: 'forbidden', stage: 'socket', detail: { httpStatus: 403 } });
    const limited = await failure(secureConnector().connect(options(await device({ refuse: 429 }))));
    expect(limited).toMatchObject({ code: 'rate_limited', detail: { httpStatus: 429 } });
  });

  it('says refused for a port nobody listens on', async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    const error = await failure(secureConnector().connect(options({ port, machineId: 'x', pk: generateStaticKey().publicKeyBase64url })));
    expect(error).toMatchObject({ code: 'refused', stage: 'socket', detail: { sysCode: 'ECONNREFUSED' } });
  });

  it('closes the socket when aborted, and gives up on a device that never answers', async () => {
    const target = await device({ hold: true });
    const controller = new AbortController();
    const pending = secureConnector().connect(options(target, { signal: controller.signal }));
    await expect.poll(() => target.sockets.size).toBe(1);
    controller.abort();
    expect(await failure(pending)).toMatchObject({ code: 'aborted' });
    await expect.poll(() => target.sockets.size).toBe(0);

    const late = await failure(secureConnector({ routeTimeoutMs: 200 }).connect(options(target)));
    expect(late.code).toBe('timeout');
    await expect.poll(() => target.sockets.size).toBe(0);
  });

  it('ends a revoked connection as client_revoked, after the client\'s own connection error', async () => {
    const target = await device();
    const link = await secureConnector().connect({ ...options(target), pairing: { ...target.invite(), clientName: 'a' } });
    const errors: Error[] = [];
    link.client.onError(error => errors.push(error));
    const started = Date.now();
    target.revoke(link.pairResult!.clientId);
    await expect(link.closed).resolves.toEqual({ code: 'client_revoked', closeCode: 4003 });
    expect(Date.now() - started).toBeLessThan(200);
    await expect.poll(() => errors.length).toBeGreaterThan(0);
    expect(errors[0]).toBeInstanceOf(ConnectionError);
  });

  it('says what the device said: turned off, a key it no longer knows, a revoked key coming back', async () => {
    const target = await device();
    const first = options(target);
    const link = await secureConnector().connect({ ...first, pairing: { ...target.invite(), clientName: 'a' } });
    target.closeAll(4006, 'remote_disabled');
    await expect(link.closed).resolves.toEqual({ code: 'remote_disabled', closeCode: 4006 });

    expect(await failure(secureConnector().connect(options(target)))).toMatchObject({ code: 'unknown_client' });
    target.revoke(link.pairResult!.clientId);
    expect(await failure(secureConnector().connect(first))).toMatchObject({ code: 'client_revoked' });
    const used = { inviteId: 'inv_0123456789abcdef', inviteSecret: 'bm9wZQ', clientName: 'a' };
    expect(await failure(secureConnector().connect({ ...options(target), pairing: used }))).toMatchObject({ code: 'pairing_failed', stage: 'pairing' });
  });

  it('refuses a device whose key is not the paired one', async () => {
    const target = await device();
    const error = await failure(secureConnector().connect(options({ ...target, pk: generateStaticKey().publicKeyBase64url })));
    expect(error).toMatchObject({ code: 'device_identity_changed', stage: 'handshake' });
  });
});
