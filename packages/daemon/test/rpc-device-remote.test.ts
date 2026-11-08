import { createServer as createNetServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { decodePairingLink, type AddressKind } from '@vonvon/protocol';
import { connectSecure, generateStaticKey, nodeBinarySocket } from '@vonvon/client/secure';
import { devicesPath } from '../src/remote/files';
import { Jobs } from '../src/server/jobs';
import { LogFollowers } from '../src/server/logs';
import type { AdminService } from '../src/admin/service';
import { fakeService, startFixture, socketClient, type Frame } from './server-fixture';

// D3 第 5 节: the device RPC on a real daemon API, this machine's interfaces and Tailscale injected. main 必败: the four
// remote kinds answered unsupported, and a revoked client stayed connected until its next request.
const ALIAS = '127.0.0.2';
const canBind = await new Promise<boolean>(resolve => {
  const probe = createNetServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, ALIAS, () => probe.close(() => resolve(true)));
});
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createNetServer();
  probe.once('error', reject);
  probe.listen(0, ALIAS, () => {
    const address = probe.address();
    probe.close(() => (address && typeof address !== 'string' ? resolve(address.port) : reject(new Error('no port'))));
  });
});
afterEach(() => { vi.restoreAllMocks(); });
const nic = (address: string) => ({ address, netmask: '255.255.255.0', family: 'IPv4' as const, mac: '02:00:00:00:00:01', internal: false, cidr: `${address}/24` });
const LAN = '10.255.255.253';
const seams = (classify?: (host: string) => Promise<AddressKind | 'invalid'>) => ({
  interfaces: () => ({ eth0: [nic(LAN), nic('100.70.1.1')], lo: [nic(ALIAS)] }), tailscale: async () => ({ installed: false, ips: [] }),
  networkIdentity: async (iface: string) => iface === 'eth0' ? 'gw:aa:bb:cc:dd:ee:ff' : undefined, timers: { retry: 60_000 },
  ...(classify ? { classify } : {}),
});
const call = (id: string, payload: object) => ({ type: 'request', id, method: 'device', payload } as const);
type Reply = Extract<Frame, { type: 'response' | 'error' }>;
const payload = (frame: Frame) => (frame as Extract<Frame, { type: 'response' }>).payload as { kind: string; self?: string; status?: { remote: { port: number; addresses: Array<{ host: string; kind: string; state: string }>; candidates?: unknown[] }; clients: { total: number; active: number }; via?: string } };

it('opens only what enable may open, records a LAN address with its network, and reports remote once one is open', async () => {
  const fixture = await startFixture(undefined, undefined, undefined, seams());
  try {
    const client = await socketClient(fixture.api.port, fixture.credential);
    await client.ready();
    expect((client.frames[0] as { capabilities?: string[] }).capabilities).toEqual(['device', 'session-scope', 'attention.group', 'share.gif']);
    const error = async (id: string, request: object) => { const reply = await client.call(call(id, { type: 'enable', ...request }) as never) as Reply; return reply.type === 'error' ? { code: reply.code, message: reply.message } : reply; };
    // A1: a host always, and no --tailscale
    expect(await error('t', { tailscale: true })).toMatchObject({ code: 'invalid_request' });
    expect(await error('h', { host: 'example.com' })).toEqual({ code: 'invalid_request', message: '只接受 IP 地址，不接受主机名。' });
    expect(await error('l', { host: '127.0.0.1' })).toEqual({ code: 'invalid_request', message: '回环地址不用开启，本机客户端一直能连。' });
    expect(await error('c', { host: '100.70.1.1' })).toMatchObject({ code: 'confirm_required', message: expect.stringContaining('CGNAT') });
    expect(await error('p', { host: '203.0.113.5' })).toMatchObject({ code: 'confirm_required', message: expect.stringContaining('公网') });
    expect(await error('both', { host: LAN, tailscale: true })).toMatchObject({ code: 'invalid_request' });
    expect(await error('none', {})).toMatchObject({ code: 'invalid_request' });
    // Codex review 232-1, 234-1, 234-2: a wildcard or a link-local IPv6 is refused before remote.json is written
    expect(await error('w4', { host: '0.0.0.0', allowPublic: true })).toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/^不能开启 0\.0\.0\.0：它代表这台设备的所有地址/) });
    expect(await error('w6', { host: '::', allowPublic: true })).toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/^不能开启 ::：它代表这台设备的所有地址/) });
    expect(await error('ll', { host: 'fe80::1%eth0' })).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('链路本地的 IPv6 地址') });
    await expect(readFile(devicesPath(fixture.home, 'remote.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const opened = await client.call(call('o', { type: 'enable', host: '203.0.113.5', allowPublic: true }) as never);
    expect(payload(opened).status?.remote.addresses).toEqual([expect.objectContaining({ host: '203.0.113.5', kind: 'public', state: 'waiting' })]);
    // A1: the LAN address replaces the public one, in the file and the status. main 必败: both were open
    const replaced = await client.call(call('lan', { type: 'enable', host: LAN }) as never);
    expect(payload(replaced).status?.remote.addresses).toEqual([expect.objectContaining({ host: LAN, kind: 'lan' })]);
    const file = JSON.parse(await readFile(devicesPath(fixture.home, 'remote.json'), 'utf8'));
    expect(file.addresses).toEqual([{ host: LAN, enabledAt: expect.any(Number), kind: 'lan', iface: 'eth0', network: 'gw:aa:bb:cc:dd:ee:ff' }]);
    const next = await socketClient(fixture.api.port, fixture.credential);
    await next.ready();
    expect((next.frames[0] as { capabilities?: string[] }).capabilities).toEqual(['device', 'session-scope', 'attention.group', 'share.gif', 'remote']);
    await Promise.all([client.close(), next.close()]);
  } finally { await fixture.close(); }
});
it('disables, changes the port and counts the clients not revoked', async () => {
  const fixture = await startFixture(undefined, undefined, undefined, seams());
  try {
    const client = await socketClient(fixture.api.port, fixture.credential);
    await client.ready();
    expect(await client.call(call('d', { type: 'disable', host: LAN }) as never)).toMatchObject({ type: 'error', code: 'invalid_request', message: '这个地址没有开启。' });
    const clients = fixture.api.secure?.clients;
    if (!clients) throw new Error('no secure deps');
    const a = await clients.add({ name: 'A', publicKey: 'a'.repeat(43), clientKind: 'desktop', address: '192.0.2.1:1', invitedBy: 'local' });
    await clients.add({ name: 'B', publicKey: 'b'.repeat(43), clientKind: 'cli', address: '192.0.2.2:1', invitedBy: 'local' });
    await client.call(call('r', { type: 'revokeClient', clientId: a.id }) as never);
    const moved = await client.call(call('port', { type: 'setPort', port: 17767 }) as never);
    expect(payload(moved).status?.remote.port).toBe(17767);
    await client.call(call('e', { type: 'enable', host: LAN }) as never);
    const disabled = await client.call(call('x', { type: 'disable', host: LAN }) as never);
    expect(payload(disabled).status?.remote.addresses).toEqual([]);
    expect(payload(await client.call(call('s', { type: 'status' }) as never)).status).toMatchObject({ remote: { port: 17767, addresses: [] }, clients: { total: 1, active: 0 } });
    // devices-ui-3: what could be opened, as `remote candidates` lists it; no `via` and no `self` on the loopback. main 必败
    const status = payload(await client.call(call('c', { type: 'status', refresh: true }) as never)).status;
    expect(status?.remote.candidates).toEqual([{ host: LAN, kind: 'lan', iface: 'eth0' }, { host: '100.70.1.1', kind: 'cgnat', iface: 'eth0' }]);
    expect(status).not.toHaveProperty('via');
    expect(payload(await client.call(call('l', { type: 'clients' }) as never))).not.toHaveProperty('self');
    await client.close();
  } finally { await fixture.close(); }
});
it.runIf(canBind)('closes a revoked client within a second, its jobs and log follows cancelled, before the reply', async () => {
  const jobs = vi.spyOn(Jobs.prototype, 'detach');
  const logs = vi.spyOn(LogFollowers.prototype, 'detach');
  const fixture = await startFixture(undefined, undefined, undefined, seams(async host => host === ALIAS ? 'lan' : 'invalid'));
  try {
    const owner = await socketClient(fixture.api.port, fixture.credential);
    await owner.ready();
    await owner.call(call('port', { type: 'setPort', port: await freePort() }) as never);
    const enabled = payload(await owner.call(call('on', { type: 'enable', host: ALIAS }) as never));
    expect(enabled.status?.remote.addresses).toEqual([expect.objectContaining({ host: ALIAS, state: 'listening' })]);
    const pairing = await owner.call(call('pair', { type: 'pair' }) as never) as Extract<Frame, { type: 'response' }>;
    const link = decodePairingLink((pairing.payload as { link: string }).link);
    const target = link.addresses[0];
    if (!target) throw new Error('no address in the link');
    const ws = new WebSocket(`ws://${target.host}:${target.port}/`, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const paired = await connectSecure({ socket: nodeBinarySocket(ws), device: { id: link.device.id, pk: link.device.pk }, clientKey: generateStaticKey().key, clientKind: 'cli',
      pairing: { inviteId: link.invite.id, inviteSecret: link.invite.secret, clientName: '笔记本' } });
    const clientId = paired.pairResult?.clientId ?? '';
    expect(await paired.client.admin({ type: 'daemonStatus' })).toMatchObject({ kind: 'daemonStatus' });
    expect(payload(await owner.call(call('s', { type: 'status' }) as never)).status?.clients).toEqual({ total: 1, active: 1 });

    const started = Date.now();
    const closed = paired.closed.then(error => ({ code: error.code, ms: Date.now() - started }));
    const reply = await owner.call(call('revoke', { type: 'revokeClient', clientId }) as never);
    // the daemon closed it before it answered: by the reply, the hub no longer has it
    expect([...fixture.api.secure?.hub.peers ?? []].some(peer => peer.clientId === clientId)).toBe(false);
    expect(reply).toMatchObject({ type: 'response', payload: { kind: 'revoked', revoked: [clientId] } });
    const end = await closed;
    expect(end.code).toBe('client_revoked');
    expect(end.ms).toBeLessThan(1_000);
    expect(jobs).toHaveBeenCalledWith(expect.objectContaining({ clientId }));
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ clientId }));
    expect(await owner.wait(frame => frame.type === 'event' && frame.event === 'device' && frame.payload.change === 'client-revoked')).toMatchObject({ payload: { clientId, name: '笔记本' } });
    ws.terminate();
    await owner.close();
  } finally { await fixture.close(); }
});

// devices-ui-3 4.2: a revoked client's scan ends at once, though its connection already dropped and its grace runs; a paired
// client's status says the address it came in on, and the client list its own id. main 必败
it.runIf(canBind)('cancels a revoked client\'s scan in its grace at once, and tells a paired client its address and its id', async () => {
  const cancelOwner = vi.spyOn(Jobs.prototype, 'cancelOwner');
  const detach = vi.spyOn(Jobs.prototype, 'detach');
  const scanning: AdminService['registerBotByQr'] = callbacks => new Promise(resolve => {
    callbacks.onQr({ url: 'https://example.com/qr', expireIn: 600 });
    callbacks.signal.addEventListener('abort', () => resolve({ ok: false, code: 'abort', reason: '' }), { once: true });
  });
  const fixture = await startFixture(fakeService({ registerBotByQr: scanning }), undefined, undefined, seams(async host => host === ALIAS ? 'lan' : 'invalid'));
  try {
    const owner = await socketClient(fixture.api.port, fixture.credential);
    await owner.ready();
    await owner.call(call('port', { type: 'setPort', port: await freePort() }) as never);
    await owner.call(call('on', { type: 'enable', host: ALIAS }) as never);
    const link = decodePairingLink((payload(await owner.call(call('pair', { type: 'pair' }) as never)) as unknown as { link: string }).link);
    const target = link.addresses[0];
    if (!target) throw new Error('no address in the link');
    const ws = new WebSocket(`ws://${target.host}:${target.port}/`, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const paired = await connectSecure({ socket: nodeBinarySocket(ws), device: { id: link.device.id, pk: link.device.pk }, clientKey: generateStaticKey().key, clientKind: 'desktop',
      pairing: { inviteId: link.invite.id, inviteSecret: link.invite.secret, clientName: '笔记本' } });
    const clientId = paired.pairResult?.clientId ?? '';
    const status = await paired.client.device({ type: 'status' });
    expect(status.kind === 'deviceStatus' && status.status.via).toBe(ALIAS);
    expect(await paired.client.device({ type: 'clients' })).toMatchObject({ kind: 'clients', self: clientId });
    expect(await paired.client.run({ type: 'registerAgent' })).toMatchObject({ kind: 'started' });
    await owner.wait(frame => frame.type === 'event' && frame.event === 'snapshot' && frame.payload.jobs.some(job => job.phase === 'qr'));
    ws.terminate();
    await vi.waitFor(() => expect(detach).toHaveBeenCalledWith(expect.objectContaining({ clientId })));
    // in its grace: not cancelled by the drop
    const now = await owner.call({ type: 'request', id: 'snap', method: 'snapshot', payload: { type: 'get' } });
    expect((now as Extract<Frame, { type: 'response' }>).payload).toMatchObject({ jobs: [expect.objectContaining({ phase: 'qr' })] });
    await owner.call(call('revoke', { type: 'revokeClient', clientId }) as never);
    expect(cancelOwner).toHaveBeenCalledWith(`paired:${clientId}`);
    // well before the 60 seconds: the owner's wait gives up after 3
    await owner.wait(frame => frame.type === 'event' && frame.event === 'snapshot' && frame.payload.jobs.some(job => job.phase === 'cancelled'));
    await owner.close();
  } finally { await fixture.close(); }
});
