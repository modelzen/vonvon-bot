import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodePairingLink, LOCAL_VIEW, PROTOCOL_VERSION, type DeviceRoute, type ServerInfo } from '@vonvon/protocol';
import { generateStaticKey } from '@vonvon/client/secure';
import { createDeviceConnections, type DeviceConnections } from '../src/connections.js';
import { openDeviceRegistry, type SecretBox, type StoredDevice } from '../src/device-registry.js';
import { RemoteConnectError, type RemoteConnectCode, type RemoteConnectOptions, type RemoteLink } from '../src/remote-transport.js';

const route: DeviceRoute = { host: '192.0.2.1', port: 7767, kind: 'lan' };
const temporary: string[] = [];
const managers: DeviceConnections[] = [];
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function fakeLink(id: string, protocolVersion = PROTOCOL_VERSION) {
  let end!: (value: { code: RemoteConnectCode }) => void;
  const closed = new Promise<{ code: RemoteConnectCode }>(resolve => { end = resolve; });
  const serverInfo: ServerInfo = { type: 'serverInfo', machineId: id, version: '0.10.1', protocolVersion };
  const client = {
    admin: vi.fn(async () => ({ kind: 'daemonStatus', status: { pid: 100, startedAt: 1 } })),
    device: vi.fn(async () => ({ kind: 'revoked', revoked: [] })),
  };
  const close = vi.fn(() => end({ code: 'closed' }));
  return {
    client: client as unknown as RemoteLink['client'], serverInfo, closed, close,
    end(code: RemoteConnectCode) { end({ code }); },
  };
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'vonvon-source-connections-'));
  temporary.push(directory);
  const box: SecretBox = {
    available: () => true,
    seal: value => `test:${value}`,
    open(value) { if (!value.startsWith('test:')) throw new Error('unreadable'); return value.slice(5); },
  };
  const registry = await openDeviceRegistry(join(directory, 'devices.json'), box);
  const calls: Array<{ options: RemoteConnectOptions; resolve(link: RemoteLink): void; reject(error: Error): void }> = [];
  const devices = createDeviceConnections({
    registry, box, client: { version: '0.10.1', protocolVersion: PROTOCOL_VERSION },
    connector: { connect(options) { return new Promise<RemoteLink>((resolve, reject) => { calls.push({ options, resolve, reject }); }); } },
  });
  managers.push(devices);
  async function add(overrides: Partial<StoredDevice> = {}) {
    const key = generateStaticKey();
    const device: StoredDevice = {
      deviceId: randomUUID(), pk: generateStaticKey().publicKeyBase64url, clientId: 'cl_test',
      clientKey: registry.sealKey(key), name: 'Source', routes: [route], addedAt: 1, ...overrides,
    };
    await registry.put(device);
    return device;
  }
  return { devices, registry, box, calls, add };
}

async function openSource(h: Awaited<ReturnType<typeof harness>>, id: string) {
  const retaining = h.devices.retainSource(id);
  await flush();
  const link = fakeLink(id);
  h.calls.at(-1)!.resolve(link);
  return { lease: await retaining, link };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function pairingLink(id: string) {
  return encodePairingLink({
    v: 1, device: { id, pk: generateStaticKey().publicKeyBase64url, name: 'Source' },
    addresses: [route], relay: null, account: null,
    invite: { id: 'inv_0123456789abcdef', secret: 'dGVzdA', expiresAt: Date.now() + 60_000 },
  });
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()));
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('retained remote source connections', () => {
  it('shares one peer between concurrent references and closes only after the last release', async () => {
    const h = await harness();
    const device = await h.add();
    const first = h.devices.retainSource(device.deviceId);
    const second = h.devices.retainSource(device.deviceId);
    await flush();
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.options.device.id === device.deviceId && call.options.device.pk === device.pk).toBe(true);
    expect(call.options.clientKey.publicKey.toString('base64url') === device.clientKey.publicKey).toBe(true);
    expect(call.options.pairing).toBeUndefined();
    const link = fakeLink(device.deviceId);
    call.resolve(link);
    const [a, b] = await Promise.all([first, second]);
    expect(a.client === b.client && a.client === link.client).toBe(true);
    a.check(); b.check();
    a.release(); a.release();
    expect(a.signal.aborted).toBe(true);
    expect(() => a.check()).toThrow();
    b.check();
    expect(link.close).not.toHaveBeenCalled();
    b.release();
    expect(link.close).toHaveBeenCalledOnce();
    expect(h.calls).toHaveLength(1);
  });

  it('preserves the original source through view changes and leaves normal view closing unchanged', async () => {
    const h = await harness();
    const source = await h.add();
    const other = await h.add();
    const retaining = h.devices.retainSource(source.deviceId);
    await flush();
    const sourceLink = fakeLink(source.deviceId);
    h.calls[0]!.resolve(sourceLink);
    const lease = await retaining;
    await h.devices.switchTo(source.deviceId);
    const selectedLink = fakeLink(source.deviceId);
    h.calls[1]!.resolve(selectedLink);
    await flush();
    await h.devices.switchTo(other.deviceId);
    expect(selectedLink.close).toHaveBeenCalledOnce();
    expect(sourceLink.close).not.toHaveBeenCalled();
    const otherLink = fakeLink(other.deviceId);
    h.calls[2]!.resolve(otherLink);
    await flush();
    await h.devices.switchTo(LOCAL_VIEW);
    expect(otherLink.close).toHaveBeenCalledOnce();
    lease.check();
    expect(lease.id).toBe(source.deviceId);
    expect(lease.client === sourceLink.client).toBe(true);
    expect(h.devices.view()).toEqual({ kind: 'local' });
    lease.release();
  });

  it('cancels one pending retain without aborting another reference', async () => {
    const h = await harness();
    const device = await h.add();
    const abort = new AbortController();
    const first = h.devices.retainSource(device.deviceId, { signal: abort.signal });
    const firstResult = expect(first).rejects.toMatchObject({ code: 'aborted' });
    const second = h.devices.retainSource(device.deviceId);
    await flush();
    abort.abort();
    await firstResult;
    expect(h.calls[0]!.options.signal.aborted).toBe(false);
    const link = fakeLink(device.deviceId);
    h.calls[0]!.resolve(link);
    const lease = await second;
    lease.check(); lease.release();
    expect(link.close).toHaveBeenCalledOnce();
  });

  it.each(['remove', 'dispose', 'cancel'] as const)('%s aborts a pending source and closes a connector that resolves late', async action => {
    const h = await harness();
    const device = await h.add();
    const abort = new AbortController();
    const retaining = h.devices.retainSource(device.deviceId, { signal: abort.signal });
    const result = expect(retaining).rejects.toMatchObject({ code: action === 'cancel' ? 'aborted' : action === 'remove' ? 'removed' : 'disposed' });
    await flush();
    let disposing: Promise<void> | undefined;
    if (action === 'remove') await h.devices.remove(device.deviceId);
    else if (action === 'dispose') disposing = h.devices.dispose();
    else abort.abort();
    await result;
    expect(h.calls[0]!.options.signal.aborted).toBe(true);
    const late = fakeLink(device.deviceId);
    h.calls[0]!.resolve(late);
    await disposing;
    await flush();
    expect(late.close).toHaveBeenCalledOnce();
  });

  it.each(['remove', 'dispose'] as const)('%s invalidates every active reference immediately', async action => {
    const h = await harness();
    const device = await h.add();
    const first = h.devices.retainSource(device.deviceId);
    const second = h.devices.retainSource(device.deviceId);
    await flush();
    const link = fakeLink(device.deviceId);
    h.calls[0]!.resolve(link);
    const [a, b] = await Promise.all([first, second]);
    const ending = action === 'remove' ? h.devices.remove(device.deviceId) : h.devices.dispose();
    expect(a.signal.aborted && b.signal.aborted).toBe(true);
    expect(() => a.check()).toThrow();
    expect(() => b.check()).toThrow();
    await ending;
    expect(link.close).toHaveBeenCalledOnce();
    a.release(); b.release();
    expect(link.close).toHaveBeenCalledOnce();
  });

  it('invalidates disconnected references and explicitly reacquires using the same paired identity', async () => {
    const h = await harness();
    const device = await h.add();
    const first = h.devices.retainSource(device.deviceId);
    await flush();
    const link = fakeLink(device.deviceId);
    h.calls[0]!.resolve(link);
    const old = await first;
    link.end('closed');
    await flush();
    expect(old.signal.aborted).toBe(true);
    expect(() => old.check()).toThrow();
    expect(h.calls).toHaveLength(1);
    const next = h.devices.retainSource(device.deviceId);
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.options.device.pk === h.calls[1]!.options.device.pk).toBe(true);
    expect(h.calls[0]!.options.clientKey.publicKey.equals(h.calls[1]!.options.clientKey.publicKey)).toBe(true);
    h.calls[1]!.resolve(fakeLink(device.deviceId));
    const fresh = await next;
    fresh.check();
    expect(() => old.check()).toThrow();
    fresh.release();
  });

  it.each(['client_revoked', 'unknown_client'] as const)('persists %s and refuses reacquisition without repairing pairing', async code => {
    const h = await harness();
    const device = await h.add();
    const retaining = h.devices.retainSource(device.deviceId);
    await flush();
    const link = fakeLink(device.deviceId);
    h.calls[0]!.resolve(link);
    const lease = await retaining;
    link.end(code);
    await flush();
    expect(lease.signal.aborted).toBe(true);
    await expect(h.devices.retainSource(device.deviceId)).rejects.toMatchObject({ code: code === 'client_revoked' ? 'revoked' : code });
    expect(h.calls).toHaveLength(1);
    await expect.poll(() => h.registry.get(device.deviceId)?.problem?.code).toBe(code === 'client_revoked' ? 'revoked' : code);
  });

  it.each(['pk', 'clientId', 'publicKey', 'sealedKey'] as const)('refuses a retained identity after paired %s changes', async field => {
    const h = await harness();
    const device = await h.add();
    const retaining = h.devices.retainSource(device.deviceId);
    await flush();
    const link = fakeLink(device.deviceId);
    h.calls[0]!.resolve(link);
    const old = await retaining;
    const replacement = generateStaticKey();
    await h.registry.update(device.deviceId, stored => ({
      ...stored,
      ...(field === 'pk' ? { pk: replacement.publicKeyBase64url } : {}),
      ...(field === 'clientId' ? { clientId: 'cl_repaired' } : {}),
      ...(field === 'publicKey' ? { clientKey: h.registry.sealKey(replacement) } : {}),
      ...(field === 'sealedKey' ? { clientKey: { ...stored.clientKey, secretKeySealed: h.box.seal(replacement.privateKeyBase64url) } } : {}),
    }));
    expect(() => old.check()).toThrow();
    expect(old.signal.aborted).toBe(true);
    expect(link.close).toHaveBeenCalledOnce();
  });

  it('revalidates the paired identity while a source connection is pending', async () => {
    const h = await harness();
    const device = await h.add();
    const retaining = h.devices.retainSource(device.deviceId);
    const result = expect(retaining).rejects.toMatchObject({ code: 'identity_changed' });
    await flush();
    await h.registry.update(device.deviceId, stored => ({ ...stored, clientId: 'cl_new' }));
    const stale = fakeLink(device.deviceId);
    h.calls[0]!.resolve(stale);
    await result;
    expect(stale.close).toHaveBeenCalledOnce();
  });

  it('keeps aliases and route changes separate from paired identity', async () => {
    const h = await harness();
    const device = await h.add();
    const retaining = h.devices.retainSource(device.deviceId);
    await flush();
    h.calls[0]!.resolve(fakeLink(device.deviceId));
    const lease = await retaining;
    await h.devices.rename(device.deviceId, 'Renamed');
    await h.registry.update(device.deviceId, stored => ({ ...stored, routes: [{ ...route, host: '192.0.2.2' }] }));
    lease.check(); lease.release();
  });

  it('keeps the captured paired identity separate from mutable registry entries', async () => {
    const h = await harness();
    const device = await h.add();
    const retaining = h.devices.retainSource(device.deviceId);
    await flush();
    h.calls[0]!.resolve(fakeLink(device.deviceId));
    const lease = await retaining;
    h.registry.get(device.deviceId)!.clientId = 'cl_changed';
    expect(() => lease.check()).toThrowError(expect.objectContaining({ code: 'identity_changed' }));
    expect(lease.signal.aborted).toBe(true);
  });

  it('does not transfer an old peer revocation to a newly paired identity', async () => {
    const h = await harness();
    const device = await h.add();
    const retaining = h.devices.retainSource(device.deviceId);
    await flush();
    const link = fakeLink(device.deviceId);
    h.calls[0]!.resolve(link);
    const lease = await retaining;
    await h.registry.update(device.deviceId, stored => ({ ...stored, clientId: 'cl_new' }));
    link.end('client_revoked');
    await flush();
    expect(lease.signal.aborted).toBe(true);
    expect(h.registry.get(device.deviceId)?.problem).toBeUndefined();
    const next = h.devices.retainSource(device.deviceId);
    await flush();
    h.calls[1]!.resolve(fakeLink(device.deviceId));
    const fresh = await next;
    fresh.check(); fresh.release();
  });

  it('invalidates all retained references when the selected peer reports revocation', async () => {
    const h = await harness();
    const device = await h.add();
    const retaining = h.devices.retainSource(device.deviceId);
    await flush();
    const sourceLink = fakeLink(device.deviceId);
    h.calls[0]!.resolve(sourceLink);
    const lease = await retaining;
    await h.devices.switchTo(device.deviceId);
    const selected = fakeLink(device.deviceId);
    h.calls[1]!.resolve(selected);
    await expect.poll(() => h.devices.state().active.phase).toBe('ready');
    selected.end('client_revoked');
    await flush();
    expect(lease.signal.aborted).toBe(true);
    expect(sourceLink.close).toHaveBeenCalledOnce();
    await expect(h.devices.retainSource(device.deviceId)).rejects.toMatchObject({ code: 'revoked' });
    expect(h.calls).toHaveLength(2);
  });

  it.each(['open failure', 'close'] as const)('ignores an old selected pairing reporting revocation on %s', async event => {
    const h = await harness();
    const { deviceId: id } = await h.add();
    await h.devices.switchTo(id);
    const oldAttempt = h.calls[0]!;
    const selected = fakeLink(id);
    if (event === 'close') {
      oldAttempt.resolve(selected);
      await expect.poll(() => h.devices.view().kind).toBe('remote');
    }
    h.registry.get(id)!.clientId = 'cl_repaired';
    await h.devices.rename(id, 'Repaired');
    const { lease, link } = await openSource(h, id);
    if (event === 'close') selected.end('client_revoked');
    else oldAttempt.reject(new RemoteConnectError('unknown_client', 'handshake'));
    await flush();
    await h.devices.rename(id, 'After callback');
    expect(lease.signal.aborted).toBe(false);
    lease.check();
    expect(link.close).not.toHaveBeenCalled();
    expect(h.registry.get(id)?.problem).toBeUndefined();
    lease.release();
  });

  it.each(['retain', 'selected close'] as const)('reports identity change to the old peer when the new pairing is revoked on %s', async observation => {
    const h = await harness();
    const { deviceId: id } = await h.add();
    const { lease, link } = await openSource(h, id);
    await h.registry.update(id, stored => ({ ...stored, clientId: 'cl_repaired' }));
    if (observation === 'selected close') {
      await h.devices.switchTo(id);
      const selected = fakeLink(id);
      h.calls[1]!.resolve(selected);
      await expect.poll(() => h.devices.view().kind).toBe('remote');
      selected.end('client_revoked');
      await flush();
    } else {
      await h.registry.update(id, stored => ({ ...stored, problem: { code: 'revoked', at: 1 } }));
    }
    await expect(h.devices.retainSource(id)).rejects.toMatchObject({ code: 'revoked' });
    expect(lease.signal.reason).toMatchObject({ code: 'identity_changed' });
    expect(link.close).toHaveBeenCalledOnce();
  });

  it.each(['saved', 'write failed'] as const)('preserves source revocation (%s) when an earlier selected open finishes its status read', async persistence => {
    const h = await harness();
    const { deviceId: id } = await h.add();
    const { link, lease } = await openSource(h, id);
    await h.devices.switchTo(id);
    const selected = fakeLink(id);
    const status = gate();
    const admin = selected.client.admin;
    selected.client.admin = vi.fn(async request => { await status.promise; return admin(request); });
    h.calls[1]!.resolve(selected);
    await flush();
    expect(selected.client.admin).toHaveBeenCalledOnce();
    if (persistence === 'write failed') vi.spyOn(h.registry, 'update').mockRejectedValueOnce(new Error('fixture write failure'));
    link.end('client_revoked');
    await flush();
    expect(lease.signal.aborted).toBe(true);
    if (persistence === 'saved') await expect.poll(() => h.registry.get(id)?.problem?.code).toBe('revoked');
    status.resolve();
    await expect.poll(() => h.devices.state().active.phase).not.toBe('connecting');
    expect(h.registry.get(id)?.problem?.code).toBe(persistence === 'saved' ? 'revoked' : undefined);
    const retry = h.devices.retainSource(id);
    const outcome = retry.then(lease => { lease.release(); return 'opened'; }, error => error.code);
    await flush();
    h.calls[2]?.resolve(fakeLink(id));
    expect(await outcome).toBe('revoked');
    expect(h.calls.length).toBe(2);
  });

  it('retires a retained peer when acquisition observes a missing registry entry', async () => {
    const h = await harness();
    const { deviceId: id } = await h.add();
    const { lease, link } = await openSource(h, id);
    await h.registry.remove(id);
    await expect(h.devices.retainSource(id)).rejects.toMatchObject({ code: 'unknown_device' });
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({ code: 'removed' });
    expect(link.close).toHaveBeenCalledOnce();
  });

  it('retires the last socket before its release listener reacquires', async () => {
    const h = await harness();
    const { deviceId: id } = await h.add();
    const { lease, link } = await openSource(h, id);
    let next!: ReturnType<DeviceConnections['retainSource']>;
    let retired = false;
    lease.signal.addEventListener('abort', () => {
      retired = link.close.mock.calls.length === 1;
      next = h.devices.retainSource(id);
    });
    lease.release();
    await flush();
    h.calls[1]?.resolve(fakeLink(id));
    const fresh = await next;
    expect(retired).toBe(true);
    expect(fresh.client === lease.client).toBe(false);
    fresh.check();
    fresh.release();
  });

  it('shares the replacement acquired by the stale lease abort listener and disposes it', async () => {
    const h = await harness();
    const { deviceId: id } = await h.add();
    const { lease, link } = await openSource(h, id);
    let inner!: ReturnType<DeviceConnections['retainSource']>;
    lease.signal.addEventListener('abort', () => { inner = h.devices.retainSource(id); });
    await h.registry.update(id, stored => ({ ...stored, clientId: 'cl_repaired' }));
    const outer = h.devices.retainSource(id);
    await flush();
    const links = h.calls.slice(1).map(call => {
      const next = fakeLink(id);
      call.resolve(next);
      return next;
    });
    const [a, b] = await Promise.all([outer, inner]);
    await h.devices.dispose();
    expect(a.client === b.client).toBe(true);
    expect(a.signal.aborted && b.signal.aborted).toBe(true);
    expect(links).toHaveLength(1);
    for (const retired of [link, ...links]) expect(retired.close).toHaveBeenCalledOnce();
  });

  it('keeps removal authoritative when a concurrent repair saves the new pairing', async () => {
    const h = await harness();
    const { deviceId: id } = await h.add();
    await h.devices.switchTo(id);
    const selected = fakeLink(id);
    h.calls[0]!.resolve(selected);
    await expect.poll(() => h.devices.view().kind).toBe('remote');
    await h.registry.update(id, stored => ({ ...stored, problem: { code: 'revoked', at: 1 } }));
    const adding = h.devices.add({ link: pairingLink(id) });
    const revoke = gate();
    const device = selected.client.device;
    selected.client.device = vi.fn(async request => { await revoke.promise; return device(request); });
    const removing = h.devices.remove(id);
    expect(selected.client.device).toHaveBeenCalledOnce();
    h.calls[1]!.resolve({ ...fakeLink(id), pairResult: { type: 'pairResult', clientId: 'cl_repaired', deviceName: 'Source' } });
    await expect(adding).resolves.toMatchObject({ kind: 'added', repaired: true });
    const acquisition = h.devices.retainSource(id);
    const outcome = acquisition.then(lease => { lease.release(); return 'opened'; }, error => error.code);
    await flush();
    h.calls[2]?.resolve(fakeLink(id));
    const code = await outcome;
    revoke.resolve();
    await removing;
    expect(code).toBe('removed');
    expect(h.calls.length).toBe(2);
    expect(h.registry.get(id) === undefined).toBe(true);
  });

  it('blocks reacquisition during removal even before the registry write finishes', async () => {
    const h = await harness();
    const device = await h.add();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const remove = h.registry.remove;
    h.registry.remove = async id => { await gate; return remove(id); };
    const removing = h.devices.remove(device.deviceId);
    await expect(h.devices.retainSource(device.deviceId)).rejects.toMatchObject({ code: 'removed' });
    finish();
    await removing;
    expect(h.calls).toHaveLength(0);
  });

  it('invalidates retained authority during pairing repair and blocks the old identity until saving finishes', async () => {
    const h = await harness();
    const device = await h.add();
    const retaining = h.devices.retainSource(device.deviceId);
    await flush();
    const original = fakeLink(device.deviceId);
    h.calls[0]!.resolve(original);
    const lease = await retaining;
    await h.registry.update(device.deviceId, stored => ({ ...stored, problem: { code: 'revoked', at: 1 } }));
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const put = h.registry.put;
    h.registry.put = async stored => { await gate; return put(stored); };
    const adding = h.devices.add({ link: pairingLink(device.deviceId) });
    const paired = { ...fakeLink(device.deviceId), pairResult: { type: 'pairResult' as const, clientId: 'cl_repaired', deviceName: 'Source' } };
    h.calls[1]!.resolve(paired);
    await flush();
    expect(lease.signal.aborted).toBe(true);
    expect(original.close).toHaveBeenCalledOnce();
    await expect(h.devices.retainSource(device.deviceId)).rejects.toMatchObject({ code: 'identity_changed' });
    finish();
    await expect(adding).resolves.toMatchObject({ kind: 'added', repaired: true });
    const fresh = h.devices.retainSource(device.deviceId);
    await flush();
    expect(h.calls[2]!.options.clientKey.publicKey.equals(h.calls[0]!.options.clientKey.publicKey)).toBe(false);
    h.calls[2]!.resolve(fakeLink(device.deviceId));
    const next = await fresh;
    next.check(); next.release();
    expect(() => lease.check()).toThrow();
  });

  it('handles a connector rejection after cancellation without reviving or retrying the source', async () => {
    const h = await harness();
    const device = await h.add();
    const abort = new AbortController();
    const retaining = h.devices.retainSource(device.deviceId, { signal: abort.signal });
    const cancelled = expect(retaining).rejects.toMatchObject({ code: 'aborted' });
    await flush();
    abort.abort();
    await cancelled;
    h.calls[0]!.reject(new RemoteConnectError('closed', 'socket'));
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.registry.get(device.deviceId)?.problem).toBeUndefined();
  });

  it('refuses another machine id and never returns usable authority in maintenance mode', async () => {
    const h = await harness();
    const device = await h.add();
    const wrong = h.devices.retainSource(device.deviceId);
    const wrongResult = expect(wrong).rejects.toMatchObject({ code: 'identity_changed' });
    await flush();
    const link = fakeLink(randomUUID());
    h.calls[0]!.resolve(link);
    await wrongResult;
    expect(link.close).toHaveBeenCalledOnce();
    const retaining = h.devices.retainSource(device.deviceId);
    await flush();
    h.calls[1]!.resolve(fakeLink(device.deviceId, PROTOCOL_VERSION + 1));
    const lease = await retaining;
    expect(lease.mode).toBe('maintenance');
    expect(() => lease.check()).toThrowError(expect.objectContaining({ code: 'maintenance' }));
    lease.release();
  });

  it('does not connect local, unknown, pre-cancelled, or unreadable sources', async () => {
    const h = await harness();
    await expect(h.devices.retainSource(LOCAL_VIEW)).rejects.toMatchObject({ code: 'local_device' });
    await expect(h.devices.retainSource(randomUUID())).rejects.toMatchObject({ code: 'unknown_device' });
    const device = await h.add();
    const abort = new AbortController(); abort.abort();
    await expect(h.devices.retainSource(device.deviceId, { signal: abort.signal })).rejects.toMatchObject({ code: 'aborted' });
    await h.registry.update(device.deviceId, stored => ({ ...stored, clientKey: { ...stored.clientKey, secretKeySealed: 'invalid' } }));
    await expect(h.devices.retainSource(device.deviceId)).rejects.toMatchObject({ code: 'key_unreadable' });
    expect(h.calls).toHaveLength(0);
  });

  it('tries the registered route order and handles rejected cleanup without an unhandled rejection', async () => {
    const h = await harness();
    const fallback = { ...route, host: '192.0.2.2' };
    const device = await h.add({ routes: [route, fallback], lastRoute: fallback });
    const retaining = h.devices.retainSource(device.deviceId);
    const result = expect(retaining).rejects.toMatchObject({ code: 'unreachable' });
    await flush();
    expect(h.calls[0]!.options.route).toEqual(fallback);
    h.calls[0]!.reject(new RemoteConnectError('unreachable', 'socket'));
    await flush();
    expect(h.calls[1]!.options.route).toEqual(route);
    h.calls[1]!.reject(new RemoteConnectError('unreachable', 'socket'));
    await result;
    await h.devices.dispose();
  });
});
