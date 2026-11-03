import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionError } from '@vonvon/client/browser';
import { encodePairingLink, PROTOCOL_VERSION, type DeviceRoute, type DevicesState, type ServerInfo } from '@vonvon/protocol';
import { generateStaticKey, staticKeyFromBase64url } from '@vonvon/protocol/secure-channel';
import { createDeviceConnections, type DeviceConnections, type ViewChange } from '../src/connections.js';
import { RegistryError, type DeviceRegistry, type RegistryStatus, type SecretBox, type StoredDevice } from '../src/device-registry.js';
import { RemoteConnectError, type RemoteConnectCode, type RemoteConnectOptions, type RemoteConnector, type RemoteLink } from '../src/remote-transport.js';
import { plainSecretBox } from './helpers/fake-secure-server.js';

// devices-ui-1a 第 5 节 connections: a fake connector and fake timers. main 必败: there was no connection manager.
const r1: DeviceRoute = { host: 'fd7a:115c:a1e0::10', port: 7767, kind: 'tailscale' };
const r2: DeviceRoute = { host: '198.51.100.20', port: 7767, kind: 'lan' };
const LOCAL_ID = randomUUID();

/** A list in memory with the real one's rules for keys and writes. */
function memoryRegistry(box: SecretBox, status: RegistryStatus = 'ok') {
  let devices: StoredDevice[] = [];
  const writable = (): void => { if (status !== 'ok') throw new RegistryError(status === 'newer' ? 'registry_newer' : 'registry_unreadable'); };
  const registry: DeviceRegistry = {
    get status() { return status; },
    list: () => devices,
    get: id => devices.find(device => device.deviceId === id),
    async put(device) {
      await Promise.resolve();
      writable();
      devices = devices.some(entry => entry.deviceId === device.deviceId) ? devices.map(entry => entry.deviceId === device.deviceId ? device : entry) : [...devices, device];
    },
    async update(id, patch) {
      await Promise.resolve();
      writable();
      const current = devices.find(device => device.deviceId === id);
      if (!current) return undefined;
      const next = patch(current);
      devices = devices.map(device => device.deviceId === id ? next : device);
      return next;
    },
    async remove(id) {
      await Promise.resolve();
      writable();
      const had = devices.some(device => device.deviceId === id);
      devices = devices.filter(device => device.deviceId !== id);
      return had;
    },
    sealKey: generated => ({ publicKey: generated.publicKeyBase64url, secretKeySealed: box.seal(generated.privateKeyBase64url) }),
    openKey(device) {
      if (!box.available()) throw new RegistryError('key_unreadable');
      try { return staticKeyFromBase64url(device.clientKey.publicKey, box.open(device.clientKey.secretKeySealed)); }
      catch { throw new RegistryError('key_unreadable'); }
    },
  };
  return { registry, seed(device: StoredDevice) { devices = [...devices, device]; } };
}

type Call = { options: RemoteConnectOptions; resolve(link: RemoteLink): void; reject(error: Error): void; aborted: () => boolean; at: number };
type FakeLink = RemoteLink & { end(code: RemoteConnectCode): void; closeSpy: ReturnType<typeof vi.fn>; emitError(error: Error): void };

function harness(options: { box?: SecretBox; status?: RegistryStatus; log?: (event: string, fields: Record<string, string | number>) => void; localNetworkPrivacy?: boolean } = {}) {
  const box = options.box ?? plainSecretBox();
  const { registry, seed } = memoryRegistry(box, options.status);
  const calls: Call[] = [];
  let open = 0;
  let maxOpen = 0;
  const connector: RemoteConnector = {
    connect(connectOptions) {
      return new Promise<RemoteLink>((resolve, reject) => {
        calls.push({
          options: connectOptions, at: Date.now(), aborted: () => connectOptions.signal.aborted,
          resolve(link) { open++; maxOpen = Math.max(maxOpen, open); resolve(link); },
          reject,
        });
      });
    },
  };
  const status = { pid: 4242, startedAt: 1000, version: '0.9.0' };
  const clients: Array<{ id: string; publicKey: string }> = [];
  function link(info: Partial<ServerInfo> & { machineId: string }, extra: { pairResult?: { clientId: string } } = {}): FakeLink {
    let settle!: (value: { code: RemoteConnectCode }) => void;
    let done = false;
    const closed = new Promise<{ code: RemoteConnectCode }>(resolve => { settle = resolve; });
    const end = (code: RemoteConnectCode): void => { if (done) return; done = true; open--; settle({ code }); };
    const errors = new Set<(error: Error) => void>();
    const closeSpy = vi.fn(() => end('closed'));
    const client = {
      admin: vi.fn(async () => ({ kind: 'daemonStatus', status: { installed: true, running: true, selfHosted: true, supported: true, version: status.version, pid: status.pid, startedAt: status.startedAt } })),
      device: vi.fn(async (request: { type: string; clientId?: string }) => request.type === 'clients'
        ? { kind: 'clients', generation: 1, clients: clients.map(entry => ({ ...entry, name: '笔记本', clientKind: 'desktop', createdAt: 1, lastSeenAt: 1, lastAddress: 'x', pairedVia: 'invite', invitedBy: 'local' })) }
        : { kind: 'revoked', revoked: [request.clientId] }),
      onError(listener: (error: Error) => void) { errors.add(listener); return () => { errors.delete(listener); }; },
    };
    return {
      client: client as unknown as RemoteLink['client'],
      serverInfo: { type: 'serverInfo', version: status.version, protocolVersion: PROTOCOL_VERSION, platform: 'linux', deviceName: '机房', capabilities: ['device'], ...info },
      ...(extra.pairResult ? { pairResult: { type: 'pairResult', deviceName: '机房', ...extra.pairResult } } : {}),
      closed, close: closeSpy, closeSpy, end,
      emitError: error => { for (const listener of errors) listener(error); },
    };
  }
  const views: ViewChange[] = [];
  const states: DevicesState[] = [];
  const devices = createDeviceConnections({
    registry, connector, box, client: { version: '0.9.0', protocolVersion: PROTOCOL_VERSION }, hostname: () => 'x'.repeat(60),
    ...(options.log ? { log: options.log } : {}), ...(options.localNetworkPrivacy ? { localNetworkPrivacy: true } : {}),
  });
  devices.onView(change => views.push(change));
  devices.onState(state => states.push(state));
  devices.setLocal({ status: 'online', serverInfo: { type: 'serverInfo', machineId: LOCAL_ID, version: '0.9.0', protocolVersion: PROTOCOL_VERSION, deviceName: '我的 MacBook Pro', platform: 'macos' } });
  function add(overrides: Partial<StoredDevice> = {}): StoredDevice {
    const generated = generateStaticKey();
    const device: StoredDevice = {
      deviceId: randomUUID(), name: '机房', pk: generateStaticKey().publicKeyBase64url, clientId: 'cl_00000000000000aa',
      clientKey: registry.sealKey(generated), routes: [r1], addedAt: 1, ...overrides,
    };
    seed(device);
    return device;
  }
  return { devices, registry, calls, views, states, status, clients, link, add, box, openLinks: () => open, maxOpen: () => maxOpen };
}
type Harness = ReturnType<typeof harness>;
const flush = async (): Promise<void> => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const failWith = (code: RemoteConnectCode, stage: 'socket' | 'handshake' | 'pairing' | 'hello' = 'socket', detail?: { httpStatus?: number; sysCode?: string }) =>
  new RemoteConnectError(code, stage, detail);
async function readyOn(h: Harness, device: StoredDevice): Promise<FakeLink> {
  await h.devices.switchTo(device.deviceId);
  const link = h.link({ machineId: device.deviceId });
  h.calls.at(-1)!.resolve(link);
  await flush();
  expect(h.devices.state().active.phase).toBe('ready');
  return link;
}
function pairingLink(deviceId: string, overrides: { expiresAt?: number; addresses?: DeviceRoute[]; name?: string } = {}) {
  return encodePairingLink({
    v: 1, device: { id: deviceId, name: overrides.name ?? '机房', pk: generateStaticKey().publicKeyBase64url },
    addresses: overrides.addresses ?? [r1], relay: null, account: null,
    invite: { id: 'inv_0123456789abcdef', secret: 'c2VjcmV0', expiresAt: overrides.expiresAt ?? Date.now() + 600_000 },
  });
}

beforeEach(() => { vi.useFakeTimers({ now: Date.UTC(2026, 10, 2) }); });
afterEach(() => { vi.useRealTimers(); });

describe('switching', () => {
  it('waits, then shows the remote connection; back to this computer closes it', async () => {
    const h = harness();
    const a = h.add();
    await h.devices.switchTo(a.deviceId);
    expect(h.views).toEqual([{ kind: 'waiting', id: a.deviceId }]);
    expect(h.devices.state().active).toMatchObject({ id: a.deviceId, phase: 'connecting' });
    const link = h.link({ machineId: a.deviceId });
    h.calls[0]!.resolve(link);
    await flush();
    expect(h.views[1]).toMatchObject({ kind: 'remote', cause: 'opened', session: { id: a.deviceId, mode: 'full' } });
    expect(h.devices.state().active).toMatchObject({ phase: 'ready', mode: 'full' });
    expect(h.devices.state().devices[1]).toMatchObject({ id: a.deviceId, status: 'online', current: true });
    await h.devices.switchTo('local');
    expect(link.closeSpy).toHaveBeenCalledOnce();
    expect(h.views.at(-1)).toEqual({ kind: 'local' });
    expect(h.devices.state().devices[0]).toMatchObject({ id: 'local', current: true, name: '这台电脑' });
  });

  it('tries the last route that worked first and remembers the one that works now', async () => {
    const h = harness();
    const a = h.add({ routes: [r1, r2], lastRoute: r2 });
    await h.devices.switchTo(a.deviceId);
    expect(h.calls[0]!.options.route).toEqual(r2);
    h.calls[0]!.reject(failWith('refused'));
    await flush();
    expect(h.calls[1]!.options.route).toEqual(r1);
    h.calls[1]!.resolve(h.link({ machineId: a.deviceId }));
    await flush();
    expect(h.registry.get(a.deviceId)?.lastRoute).toEqual(r1);
    expect(h.registry.get(a.deviceId)?.lastKnown).toMatchObject({ version: '0.9.0', platform: 'linux' });
  });

  it('backs off 1, 2, 4, 8, 16, 30 and 30 seconds', async () => {
    const h = harness();
    const a = h.add();
    await h.devices.switchTo(a.deviceId);
    for (let index = 0; index < 8; index++) {
      h.calls[index]!.reject(failWith('unreachable'));
      await flush();
      await vi.advanceTimersToNextTimerAsync();
      await flush();
    }
    const gaps = h.calls.slice(1, 8).map((call, index) => call.at - h.calls[index]!.at);
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(h.devices.state().active).toMatchObject({ phase: 'connecting', failure: { code: 'unreachable' } });
  });

  it('waits at least a minute after a rate limit (HTTP 429 or 4004)', async () => {
    const h = harness();
    const a = h.add();
    await h.devices.switchTo(a.deviceId);
    h.calls[0]!.reject(new RemoteConnectError('rate_limited', 'socket', { httpStatus: 429 }));
    await flush();
    expect(h.devices.state().active.retryAt).toBe(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(2);
  });

  it('switching on before connections finish closes them all and shows nothing of them', async () => {
    const h = harness();
    const a = h.add();
    const b = h.add({ name: 'B' });
    await h.devices.switchTo(a.deviceId);
    await h.devices.switchTo(b.deviceId);
    await h.devices.switchTo('local');
    expect(h.calls[0]!.aborted()).toBe(true);
    expect(h.calls[1]!.aborted()).toBe(true);
    const linkA = h.link({ machineId: a.deviceId });
    const linkB = h.link({ machineId: b.deviceId });
    h.calls[0]!.resolve(linkA);
    h.calls[1]!.resolve(linkB);
    await flush();
    expect(linkA.closeSpy).toHaveBeenCalled();
    expect(linkB.closeSpy).toHaveBeenCalled();
    expect(h.views.some(view => view.kind === 'remote')).toBe(false);
    expect(h.devices.view()).toEqual({ kind: 'local' });
    expect(h.maxOpen()).toBeLessThanOrEqual(2);
  });

  it('starts over as connecting after a failure, a switch away and back', async () => {
    const h = harness();
    const a = h.add();
    await h.devices.switchTo(a.deviceId);
    h.calls[0]!.reject(failWith('unreachable'));
    await flush();
    expect(h.devices.state().active.failure?.code).toBe('unreachable');
    await h.devices.switchTo('local');
    h.states.length = 0;
    await h.devices.switchTo(a.deviceId);
    expect(h.states[0]!.active).toMatchObject({ id: a.deviceId, phase: 'connecting', attempt: 0 });
    expect(h.states[0]!.active.failure).toBeUndefined();
  });

  it('shows another protocol in maintenance', async () => {
    const h = harness();
    const a = h.add();
    await h.devices.switchTo(a.deviceId);
    h.calls[0]!.resolve(h.link({ machineId: a.deviceId, protocolVersion: PROTOCOL_VERSION + 1 }));
    await flush();
    expect(h.devices.state().active).toMatchObject({ phase: 'ready', mode: 'maintenance' });
    expect(h.devices.state().devices[1]!.status).toBe('maintenance');
  });
});

describe('revocation and identity', () => {
  it('is revoked within the close callback: no timer, written to disk after, no retry', async () => {
    const h = harness();
    const a = h.add();
    const link = await readyOn(h, a);
    link.end('client_revoked');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.devices.state().active).toMatchObject({ phase: 'failed', failure: { code: 'client_revoked' } });
    expect(h.devices.state().devices[1]!.status).toBe('revoked');
    expect(vi.getTimerCount()).toBe(0);
    await flush();
    expect(h.registry.get(a.deviceId)?.problem?.code).toBe('revoked');
    h.devices.retry();
    expect(h.calls).toHaveLength(1);
  });

  it('is revoked even when the client\'s connection error comes first', async () => {
    const h = harness();
    const a = h.add();
    const link = await readyOn(h, a);
    link.emitError(new ConnectionError(new Error('Daemon connection closed')));
    queueMicrotask(() => link.end('client_revoked'));
    await flush();
    expect(h.devices.state().active.phase).toBe('failed');
    expect(h.devices.state().devices[1]!.status).toBe('revoked');
    expect(h.devices.state().active.retryAt).toBeUndefined();
  });

  it('repairs a revoked current device with a new link and connects with the new key at once', async () => {
    const h = harness();
    const a = h.add();
    const link = await readyOn(h, a);
    link.end('client_revoked');
    await flush();
    const text = pairingLink(a.deviceId);
    expect(h.devices.inspectLink(text)).toMatchObject({ ok: true, repair: true });
    const adding = h.devices.add({ link: text });
    const pairCall = h.calls.at(-1)!;
    expect(pairCall.options.pairing).toBeDefined();
    pairCall.resolve(h.link({ machineId: a.deviceId }, { pairResult: { clientId: 'cl_00000000000000bb' } }));
    await expect(adding).resolves.toMatchObject({ kind: 'added', repaired: true });
    const reconnect = h.calls.at(-1)!;
    expect(reconnect).not.toBe(pairCall);
    expect(reconnect.options.pairing).toBeUndefined();
    expect(reconnect.options.clientKey.publicKey.toString('base64url')).toBe(pairCall.options.clientKey.publicKey.toString('base64url'));
    reconnect.resolve(h.link({ machineId: a.deviceId }));
    await flush();
    expect(h.devices.state().active.phase).toBe('ready');
    expect(h.registry.get(a.deviceId)).toMatchObject({ clientId: 'cl_00000000000000bb' });
    expect(h.registry.get(a.deviceId)?.problem).toBeUndefined();
  });

  it('stops on a device whose machine id is not the paired one, as this attempt\'s result only', async () => {
    const h = harness();
    const a = h.add();
    await h.devices.switchTo(a.deviceId);
    const other = h.link({ machineId: randomUUID() });
    h.calls[0]!.resolve(other);
    await flush();
    expect(other.closeSpy).toHaveBeenCalled();
    expect(h.devices.state().active).toMatchObject({ phase: 'failed', failure: { code: 'identity_changed' } });
    expect(vi.getTimerCount()).toBe(0);
    expect(h.registry.get(a.deviceId)?.problem).toBeUndefined();
    h.devices.retry();
    expect(h.calls).toHaveLength(2);
  });

  it('moves past one address that is another machine; all of them is another identity', async () => {
    const h = harness();
    const a = h.add({ routes: [r1, r2] });
    await h.devices.switchTo(a.deviceId);
    h.calls[0]!.reject(failWith('device_identity_changed', 'handshake'));
    await flush();
    h.calls[1]!.resolve(h.link({ machineId: a.deviceId }));
    await flush();
    expect(h.devices.state().active.phase).toBe('ready');
    expect(h.registry.get(a.deviceId)).toMatchObject({ lastRoute: r2 });
    expect(h.registry.get(a.deviceId)?.problem).toBeUndefined();

    const b = h.add({ routes: [r1, r2], name: 'B' });
    await h.devices.switchTo(b.deviceId);
    h.calls[2]!.reject(failWith('device_identity_changed', 'handshake'));
    await flush();
    h.calls[3]!.reject(failWith('device_identity_changed', 'handshake'));
    await flush();
    expect(h.devices.state().active).toMatchObject({ phase: 'failed', failure: { code: 'identity_changed' } });
    expect(h.devices.state().devices.find(row => row.id === b.deviceId)).toMatchObject({ status: 'needs-pairing', problem: 'identity_changed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a 4005 before message 2 out of the list: retry, a switch back and the next start try again (Codex 审查 235-2)', async () => {
    const h = harness();
    const a = h.add();
    await h.devices.switchTo(a.deviceId);
    // Anyone on the path can close with a plain 4005 before message 2 (D2).
    h.calls[0]!.reject(failWith('device_identity_changed', 'handshake'));
    await flush();
    expect(h.devices.state().active).toMatchObject({ phase: 'failed', failure: { code: 'identity_changed' } });
    expect(h.registry.get(a.deviceId)?.problem).toBeUndefined();
    // A new link of the same device may still pair it again.
    expect(h.devices.inspectLink(pairingLink(a.deviceId))).toMatchObject({ ok: true, repair: true });
    h.devices.retry();
    expect(h.calls).toHaveLength(2);
    h.calls[1]!.reject(failWith('device_identity_changed', 'handshake'));
    await flush();
    await h.devices.switchTo('local');
    await h.devices.switchTo(a.deviceId);
    expect(h.calls).toHaveLength(3);
    h.calls[2]!.resolve(h.link({ machineId: a.deviceId }));
    await flush();
    expect(h.devices.state().active.phase).toBe('ready');
    // The next start reads the list: nothing there stops it.
    expect(h.registry.get(a.deviceId)?.problem).toBeUndefined();
  });

  it('leaves an unreadable key on disk as it is, retries it, and lets a new link repair it', async () => {
    let refuse = true;
    const plain = plainSecretBox();
    const h = harness({ box: { ...plain, open: sealed => { if (refuse) throw new Error('keychain said no'); return plain.open(sealed); } } });
    const a = h.add();
    await h.devices.switchTo(a.deviceId);
    expect(h.calls).toHaveLength(0);
    expect(h.devices.state().active).toMatchObject({ phase: 'failed', failure: { code: 'key_unreadable' } });
    await flush();
    expect(h.registry.get(a.deviceId)?.problem).toBeUndefined();
    expect(h.devices.inspectLink(pairingLink(a.deviceId))).toMatchObject({ ok: true, repair: true });
    refuse = false;
    h.devices.retry();
    expect(h.calls).toHaveLength(1);
  });
});

describe('reconnecting', () => {
  it('reconnects a second after 4006 and comes back as the same daemon', async () => {
    const h = harness();
    const a = h.add();
    const link = await readyOn(h, a);
    link.end('remote_disabled');
    await flush();
    expect(h.devices.state().active).toMatchObject({ phase: 'reconnecting', mode: 'full' });
    expect(h.devices.state().active.disabledAt).toBeDefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(2);
    h.calls[1]!.resolve(h.link({ machineId: a.deviceId }));
    await flush();
    expect(h.views.at(-1)).toMatchObject({ kind: 'remote', cause: 'reopened' });
    expect(h.devices.state().active.notice).toBeUndefined();
  });

  it('keeps "turned off" through later refusals until it connects again', async () => {
    const h = harness();
    const a = h.add();
    const link = await readyOn(h, a);
    link.end('remote_disabled');
    await flush();
    const disabledAt = h.devices.state().active.disabledAt;
    for (const index of [1, 2]) {
      await vi.advanceTimersByTimeAsync(2000);
      h.calls[index]!.reject(failWith('refused'));
      await flush();
    }
    expect(h.devices.state().active).toMatchObject({ disabledAt, failure: { code: 'refused' } });
    await vi.advanceTimersByTimeAsync(4000);
    h.calls[3]!.resolve(h.link({ machineId: a.deviceId }));
    await flush();
    expect(h.devices.state().active.disabledAt).toBeUndefined();
  });

  it('tells a restart apart, unless it was the one asked for', async () => {
    const h = harness();
    const a = h.add();
    let link = await readyOn(h, a);
    h.status.startedAt = 2000;
    link.end('closed');
    await vi.advanceTimersByTimeAsync(1000);
    link = h.link({ machineId: a.deviceId });
    h.calls[1]!.resolve(link);
    await flush();
    expect(h.views.at(-1)).toMatchObject({ kind: 'remote', cause: 'restarted' });
    expect(h.devices.state().active.notice).toMatchObject({ kind: 'restarted' });

    h.devices.expect('restart');
    h.status.startedAt = 3000;
    link.end('closed');
    await flush();
    expect(h.devices.state().active).toMatchObject({ phase: 'reconnecting', expected: 'restart' });
    await vi.advanceTimersByTimeAsync(1000);
    h.calls[2]!.resolve(h.link({ machineId: a.deviceId }));
    await flush();
    expect(h.views.at(-1)).toMatchObject({ cause: 'restarted' });
    expect(h.devices.state().active.notice?.at).toBeLessThan(Date.now());
    expect(h.devices.state().active.expected).toBeUndefined();
  });

  it('tells an update apart and writes the new version down', async () => {
    const h = harness();
    const a = h.add();
    const link = await readyOn(h, a);
    h.status.version = '0.9.1';
    link.end('closed');
    await vi.advanceTimersByTimeAsync(1000);
    h.calls[1]!.resolve(h.link({ machineId: a.deviceId, version: '0.9.1' }));
    await flush();
    expect(h.devices.state().active.notice).toMatchObject({ kind: 'updated', from: '0.9.0', to: '0.9.1' });
    expect(h.registry.get(a.deviceId)?.lastKnown?.version).toBe('0.9.1');
  });

  it('tries at once on wake, but not over an attempt in flight', async () => {
    const h = harness();
    const a = h.add();
    await h.devices.switchTo(a.deviceId);
    for (let index = 0; index < 5; index++) {
      h.calls[index]!.reject(failWith('unreachable'));
      await flush();
      if (index < 4) await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(h.devices.state().active.retryAt).toBe(Date.now() + 16_000);
    h.devices.wake();
    expect(h.calls).toHaveLength(6);
    h.devices.wake();
    expect(h.calls).toHaveLength(6);
  });

  it('closes a connection still reading its status at once when switched away (Codex 审查 236-2)', async () => {
    const h = harness();
    const a = h.add();
    for (let round = 0; round < 3; round++) {
      await h.devices.switchTo(a.deviceId);
      const slow = h.link({ machineId: a.deviceId });
      vi.mocked(slow.client.admin).mockReturnValue(new Promise(() => {}));
      h.calls.at(-1)!.resolve(slow);
      await flush();
      await h.devices.switchTo('local');
      expect(slow.closeSpy).toHaveBeenCalled();
      expect(h.openLinks()).toBe(0);
    }
    expect(h.views.some(view => view.kind === 'remote')).toBe(false);
  });

  it('retry replaces the attempt in flight and closes what it brings back late', async () => {
    const h = harness();
    const a = h.add();
    await h.devices.switchTo(a.deviceId);
    h.devices.retry();
    expect(h.calls[0]!.aborted()).toBe(true);
    expect(h.calls).toHaveLength(2);
    const views = h.views.length;
    const late = h.link({ machineId: a.deviceId });
    h.calls[0]!.resolve(late);
    await flush();
    expect(late.closeSpy).toHaveBeenCalled();
    expect(h.views).toHaveLength(views);
    h.calls[1]!.resolve(h.link({ machineId: a.deviceId }));
    await flush();
    expect(h.views.at(-1)).toMatchObject({ kind: 'remote' });
    expect(h.maxOpen()).toBeLessThanOrEqual(2);
  });

  it('closes everything on dispose within two seconds and says nothing after', async () => {
    const h = harness();
    const a = h.add();
    await h.devices.switchTo(a.deviceId);
    const disposing = h.devices.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    await disposing;
    const views = h.views.length;
    const states = h.states.length;
    const late = h.link({ machineId: a.deviceId });
    h.calls[0]!.resolve(late);
    await flush();
    expect(late.closeSpy).toHaveBeenCalled();
    expect([h.views.length, h.states.length]).toEqual([views, states]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(h.devices.switchTo('local')).rejects.toMatchObject({ code: 'disposed' });
  });
});

describe('adding', () => {
  it('refuses what it cannot add, and only moves the addresses of one added already', async () => {
    const h = harness();
    expect(h.devices.inspectLink('vonvon://pair#nonsense')).toEqual({ ok: false, code: 'invalid_link' });
    expect(h.devices.inspectLink(pairingLink(randomUUID(), { expiresAt: Date.now() - 1 }))).toMatchObject({ ok: false, code: 'link_expired', name: '机房' });
    expect(h.devices.inspectLink(pairingLink(LOCAL_ID))).toMatchObject({ ok: false, code: 'own_link' });
    const a = h.add();
    expect(h.devices.inspectLink(pairingLink(a.deviceId))).toMatchObject({ ok: false, code: 'already_added', routesChanged: false });
    await expect(h.devices.add({ link: pairingLink(a.deviceId) })).resolves.toMatchObject({ kind: 'failed', code: 'already_added' });
    await expect(h.devices.add({ link: pairingLink(a.deviceId, { addresses: [r2] }) })).resolves.toEqual({ kind: 'updated', deviceId: a.deviceId, name: '机房' });
    expect(h.registry.get(a.deviceId)?.routes).toEqual([r2, r1]);
    expect(h.calls).toHaveLength(0);
    const locked = harness({ box: plainSecretBox({ available: () => false }) });
    expect(locked.devices.inspectLink(pairingLink(randomUUID()))).toMatchObject({ ok: false, code: 'no_secure_storage' });
  });

  it('pairs with a new key under this computer\'s name and keeps the new device without switching to it', async () => {
    const h = harness();
    const id = randomUUID();
    const adding = h.devices.add({ link: pairingLink(id), name: '机房 A' });
    expect(h.devices.state().adding).toMatchObject({ stage: 'connecting', route: r1 });
    const call = h.calls[0]!;
    expect(call.options.pairing).toMatchObject({ inviteId: 'inv_0123456789abcdef', clientName: '我的 MacBook Pro' });
    const paired = h.link({ machineId: id }, { pairResult: { clientId: 'cl_00000000000000cc' } });
    call.resolve(paired);
    await expect(adding).resolves.toEqual({ kind: 'added', deviceId: id, name: '机房 A', repaired: false });
    const stored = h.registry.get(id)!;
    expect(stored).toMatchObject({ clientId: 'cl_00000000000000cc', name: '机房 A', routes: [r1], lastRoute: r1 });
    expect(stored.clientKey.publicKey).toBe(call.options.clientKey.publicKey.toString('base64url'));
    expect(stored.clientKey.secretKeySealed.startsWith('sealed:')).toBe(true);
    expect(paired.closeSpy).toHaveBeenCalled();
    expect(h.devices.view()).toEqual({ kind: 'local' });
    expect(h.devices.state().adding).toBeUndefined();
    expect(JSON.stringify(h.states)).not.toContain('c2VjcmV0');
  });

  it('falls back to the host name, cut to 40 characters', async () => {
    const h = harness();
    h.devices.setLocal({ status: 'online', serverInfo: { type: 'serverInfo', machineId: LOCAL_ID, version: '0.9.0', protocolVersion: PROTOCOL_VERSION } });
    void h.devices.add({ link: pairingLink(randomUUID()) });
    expect(h.calls[0]!.options.pairing?.clientName).toBe('x'.repeat(40));
    h.devices.cancelAdd();
  });

  it('stores nothing for a used link', async () => {
    const h = harness();
    const adding = h.devices.add({ link: pairingLink(randomUUID()) });
    h.calls[0]!.reject(failWith('pairing_failed', 'pairing'));
    await expect(adding).resolves.toMatchObject({ kind: 'failed', code: 'link_used' });
    expect(h.registry.list()).toEqual([]);
  });

  it.each(['pairing', 'hello'] as const)('finds its client id when cut off at %s, the answer to the pairing lost or past it (Codex 审查 235-3)', async stage => {
    const h = harness();
    const id = randomUUID();
    const adding = h.devices.add({ link: pairingLink(id) });
    h.calls[0]!.reject(failWith('closed', stage));
    await flush();
    const again = h.calls[1]!;
    expect(again.options.pairing).toBeUndefined();
    expect(again.options.clientKey.publicKey).toEqual(h.calls[0]!.options.clientKey.publicKey);
    h.clients.push({ id: 'cl_00000000000000dd', publicKey: again.options.clientKey.publicKey.toString('base64url') });
    again.resolve(h.link({ machineId: id }));
    await expect(adding).resolves.toMatchObject({ kind: 'added' });
    expect(h.registry.get(id)?.clientId).toBe('cl_00000000000000dd');
  });

  it('cancelled while it is saved, adds nothing and takes its key back off the device (Codex 审查 236-3)', async () => {
    const h = harness();
    const id = randomUUID();
    const put = h.registry.put;
    h.registry.put = async device => { const saving = put(device); h.devices.cancelAdd(); return saving; };
    const adding = h.devices.add({ link: pairingLink(id) });
    const paired = h.link({ machineId: id }, { pairResult: { clientId: 'cl_00000000000000cc' } });
    h.calls[0]!.resolve(paired);
    await expect(adding).resolves.toMatchObject({ kind: 'failed', code: 'aborted' });
    expect(h.registry.list()).toEqual([]);
    expect(paired.client.device).toHaveBeenCalledWith({ type: 'revokeClient', clientId: 'cl_00000000000000cc' });
    expect(paired.closeSpy).toHaveBeenCalled();
  });

  it('adds one device at a time and can be cancelled', async () => {
    const h = harness();
    const first = h.devices.add({ link: pairingLink(randomUUID()) });
    await expect(h.devices.add({ link: pairingLink(randomUUID()) })).resolves.toMatchObject({ kind: 'failed', code: 'busy' });
    h.devices.cancelAdd();
    expect(h.calls[0]!.aborted()).toBe(true);
    h.calls[0]!.reject(failWith('aborted'));
    await expect(first).resolves.toMatchObject({ kind: 'failed', code: 'aborted' });
    expect(h.registry.list()).toEqual([]);
  });
});

describe('removing', () => {
  it('revokes its own key on the current device first, and the 4003 that follows is not a revocation', async () => {
    const h = harness();
    const a = h.add();
    const link = await readyOn(h, a);
    const device = vi.mocked(link.client.device);
    device.mockImplementationOnce(async request => {
      queueMicrotask(() => link.end('client_revoked'));
      return { kind: 'revoked', revoked: [(request as { clientId: string }).clientId] };
    });
    await expect(h.devices.remove(a.deviceId)).resolves.toEqual({ revokedRemotely: true });
    expect(device).toHaveBeenCalledWith({ type: 'revokeClient', clientId: a.clientId });
    await flush();
    expect(h.devices.view()).toEqual({ kind: 'local' });
    expect(h.devices.state().active.phase).toBe('ready');
    expect(h.registry.get(a.deviceId)).toBeUndefined();
    expect(h.devices.state().devices).toHaveLength(1);
  });

  it('removes another device without connecting to it', async () => {
    const h = harness();
    const a = h.add();
    await expect(h.devices.remove(a.deviceId)).resolves.toEqual({ revokedRemotely: false });
    expect(h.calls).toHaveLength(0);
    expect(h.registry.list()).toEqual([]);
    await expect(h.devices.remove('local')).rejects.toMatchObject({ code: 'local_device' });
  });
});

// 0.9.0 Mac 验收 S-1': a failed add left nothing in devices.log, and an address macOS's local network privacy blocks reads as
// the network's fault.
describe('why an address failed', () => {
  const blocked = () => failWith('unreachable', 'socket', { sysCode: 'EHOSTUNREACH' });

  it('logs each failed address and the failed add without the address, and flags a LAN address macOS 15 may have blocked', async () => {
    const lines: Array<[string, Record<string, string | number>]> = [];
    const h = harness({ log: (event, fields) => lines.push([event, fields]), localNetworkPrivacy: true });
    const id = randomUUID();
    const adding = h.devices.add({ link: pairingLink(id, { addresses: [r1, r2] }) });
    await flush();
    vi.advanceTimersByTime(40);
    h.calls[0]!.reject(blocked());
    await flush();
    h.calls[1]!.reject(blocked());
    // Tailscale's interface is a VPN, not a local network: only the LAN address is flagged.
    await expect(adding).resolves.toEqual({ kind: 'failed', code: 'unreachable', attempts: [{ route: r1, code: 'unreachable' }, { route: r2, code: 'unreachable', localNetwork: true }] });
    const short = id.slice(0, 8);
    expect(lines).toEqual([
      ['device-route-failed', { id: short, kind: 'tailscale', code: 'unreachable', stage: 'socket', sys: 'EHOSTUNREACH', ms: 40 }],
      ['device-route-failed', { id: short, kind: 'lan', code: 'unreachable', stage: 'socket', sys: 'EHOSTUNREACH', ms: 0 }],
      ['device-add-failed', { id: short, code: 'unreachable', routes: 2 }],
    ]);
    expect(JSON.stringify(lines)).not.toContain(r2.host);
  });

  it('flags nothing before macOS 15 or elsewhere, logs a refusal\'s HTTP status, and logs no cancelled add', async () => {
    const lines: Array<[string, Record<string, string | number>]> = [];
    const h = harness({ log: (event, fields) => lines.push([event, fields]) });
    const a = h.add({ routes: [r1, r2] });
    await h.devices.switchTo(a.deviceId);
    h.calls[0]!.reject(failWith('forbidden', 'socket', { httpStatus: 403 }));
    await flush();
    h.calls[1]!.reject(blocked());
    await flush();
    expect(h.devices.state().active.failure?.attempts).toEqual([{ route: r1, code: 'forbidden' }, { route: r2, code: 'unreachable' }]);
    const short = a.deviceId.slice(0, 8);
    expect(lines.filter(([event]) => event === 'device-route-failed').map(([, fields]) => fields)).toEqual([
      { id: short, kind: 'tailscale', code: 'forbidden', stage: 'socket', http: 403, ms: 0 },
      { id: short, kind: 'lan', code: 'unreachable', stage: 'socket', sys: 'EHOSTUNREACH', ms: 0 },
    ]);
    expect(lines.at(-1)).toEqual(['device-failed', { id: short, code: 'forbidden' }]);
    // Trying again every so often: an address that fails the same way is not logged again, one that changes is.
    lines.length = 0;
    const tried = h.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.calls).toHaveLength(tried + 1);
    h.calls[tried]!.reject(failWith('forbidden', 'socket', { httpStatus: 403 }));
    await flush();
    h.calls[tried + 1]!.reject(failWith('timeout'));
    await flush();
    expect(lines).toEqual([
      ['device-route-failed', { id: short, kind: 'lan', code: 'timeout', stage: 'socket', ms: 0 }],
      ['device-failed', { id: short, code: 'forbidden' }],
    ]);
    await h.devices.switchTo('local');
    lines.length = 0;
    const adding = h.devices.add({ link: pairingLink(randomUUID()) });
    await flush();
    h.devices.cancelAdd();
    h.calls.at(-1)!.reject(failWith('aborted'));
    await expect(adding).resolves.toMatchObject({ kind: 'failed', code: 'aborted' });
    expect(lines).toEqual([]);
  });
});
