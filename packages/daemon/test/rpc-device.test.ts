import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { decodePairingLink, type Event } from '@vonvon/protocol';
import { createClientRegistry } from '../src/remote/clients';
import { loadOrCreateDevice } from '../src/remote/device';
import { createInviteBook } from '../src/remote/pairing';
import { deviceRpc } from '../src/server/rpc/device';
import { startFixture, socketClient } from './server-fixture';

const call = (id: string, payload: object) => ({ type: 'request', id, method: 'device', payload } as const);

it('makes a pairing link only once an address is open, for this device and that address', async () => {
  const fixture = await startFixture();
  try {
    const client = await socketClient(fixture.api.port, fixture.credential);
    await client.ready();
    const refused = await client.call(call('p0', { type: 'pair' }) as never);
    expect(refused).toMatchObject({ type: 'error', code: 'no_remote_address', message: expect.stringContaining('vonvon remote enable') });
    const address = { host: '192.0.2.9', kind: 'lan', enabledAt: 1 };
    await writeFile(join(fixture.home, 'remote.json'), JSON.stringify({ v: 1, port: 7767, addresses: [address] }));
    const reply = await client.call(call('p1', { type: 'pair' }) as never);
    if (reply.type !== 'response' || reply.method !== 'device' || reply.payload.kind !== 'pairingLink') throw new Error(`no link: ${JSON.stringify(reply)}`);
    const link = decodePairingLink(reply.payload.link);
    const device = JSON.parse(await readFile(join(fixture.home, 'device.json'), 'utf8'));
    expect(link.addresses).toEqual([{ host: '192.0.2.9', port: 7767, kind: 'lan' }]);
    expect(link.device).toEqual({ id: device.deviceId, name: device.name, pk: device.keypair.publicKey });
    expect(link.invite).toMatchObject({ id: reply.payload.inviteId, expiresAt: reply.payload.expiresAt });
    expect(await client.call(call('c', { type: 'clients' }) as never)).toMatchObject({ payload: { kind: 'clients', generation: 0, clients: [] } });
    for (const type of ['status', 'disable']) {
      expect(await client.call(call(type, { type, ...(type === 'disable' ? { host: '192.0.2.9' } : {}) }) as never)).toMatchObject({ type: 'error', code: 'unsupported' });
    }
    expect(await client.call(call('r', { type: 'rename', name: '测试机' }) as never)).toMatchObject({ payload: { kind: 'device', device: { name: '测试机', publicKey: device.keypair.publicKey } } });
    expect(JSON.parse(await readFile(join(fixture.home, 'device.json'), 'utf8')).name).toBe('测试机');
    const next = await socketClient(fixture.api.port, fixture.credential);
    await next.ready();
    expect(next.frames[0]).toMatchObject({ deviceName: '测试机' });
    await Promise.all([client.close(), next.close()]);
  } finally { await fixture.close(); }
});

it('renames and revokes clients, files and replies alike, and tells the owner of each revoked one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-rpc-device-'));
  try {
    const clients = await createClientRegistry(home);
    const invites = createInviteBook();
    const create = vi.spyOn(invites, 'create');
    const published: Event[] = [];
    const log = { info: vi.fn() };
    const deps = { home, identity: { current: await loadOrCreateDevice(home, '00000000-0000-4000-8000-000000000000') }, clients, invites, publish: (event: Event) => published.push(event), log };
    const owner = { principal: { kind: 'owner', via: 'local' } } as const;
    const a = await clients.add({ name: 'A', publicKey: 'a'.repeat(43), clientKind: 'desktop', address: '192.0.2.1:1', invitedBy: 'local' });
    const b = await clients.add({ name: 'B', publicKey: 'b'.repeat(43), clientKind: 'cli', address: '192.0.2.2:1', invitedBy: a.id });

    const renamed = await deviceRpc(deps, owner, { type: 'renameClient', clientId: b.id, name: '笔记本' });
    const file = async () => JSON.parse(await readFile(join(home, 'clients.json'), 'utf8'));
    expect(renamed).toEqual({ kind: 'read', value: { kind: 'clients', generation: 3, clients: (await file()).clients } });
    expect(await deviceRpc(deps, owner, { type: 'revokeClient', clientId: a.id, cascade: true })).toEqual({ kind: 'read', value: { kind: 'revoked', revoked: [a.id, b.id] } });
    expect((await file()).clients.map((client: { revokedAt?: number }) => client.revokedAt)).toEqual([expect.any(Number), expect.any(Number)]);
    expect(published.map(event => event.event === 'device' && event.payload)).toEqual([
      { change: 'client-revoked', clientId: a.id, name: 'A', clientKind: 'desktop', address: '192.0.2.1:1', invitedBy: 'local' },
      { change: 'client-revoked', clientId: b.id, name: '笔记本', clientKind: 'cli', address: '192.0.2.2:1', invitedBy: a.id },
    ]);
    expect(log.info).toHaveBeenCalledTimes(2);

    await writeFile(join(home, 'remote.json'), JSON.stringify({ v: 1, port: 7767, addresses: [{ host: '192.0.2.9', kind: 'lan', enabledAt: 1 }] }));
    await deviceRpc(deps, owner, { type: 'pair' });
    await deviceRpc(deps, { principal: { kind: 'owner', via: 'paired', clientId: a.id, generation: 1 } }, { type: 'pair', ttlMs: 60_000 });
    expect(create.mock.calls).toEqual([[{ invitedBy: 'local' }], [{ ttlMs: 60_000, invitedBy: a.id }]]);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('vonvon://');
  } finally { await rm(home, { recursive: true, force: true }); }
});
