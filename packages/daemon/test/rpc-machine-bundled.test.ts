import { createServer } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { decodePairingLink, DESKTOP_SELF_UPDATE_CAPABILITY, type Request } from '@vonvon/protocol';
import { connectSecure, generateStaticKey, nodeBinarySocket } from '@vonvon/client/secure';
import { fakeService, socketClient, startFixture, type Frame } from './server-fixture';

// After the fixture's module has mocked the paths: a static import above it would read and write the real data directory.
const { readUpdateStatus } = await import('../src/service/update');

// devices-ui-4 第 5 节 rpc-machine-bundled: an in-process daemon installed `bundled`, a loopback desktop connection that
// declared `desktop.self-update` and plays the shell, and the clients that ask it. main 必败: checkCoreUpdate asked npm,
// applyCoreUpdate installed an npm package, and there was no desktopUpdateReport.
afterEach(() => { vi.restoreAllMocks(); });
const ALIAS = '127.0.0.2';
const canBindAlias = await new Promise<boolean>(resolve => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, ALIAS, () => probe.close(() => resolve(true)));
});
const aliasPort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, ALIAS, () => { const bound = probe.address(); probe.close(() => (bound && typeof bound !== 'string' ? resolve(bound.port) : reject(new Error('no port')))); });
});
const aliasSeams = {
  interfaces: () => ({ lo: [{ address: ALIAS, netmask: '255.0.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: true, cidr: `${ALIAS}/8` }] }),
  tailscale: async () => ({ installed: false, ips: [] }), networkIdentity: async () => undefined, classify: async (host: string) => (host === ALIAS ? 'lan' as const : 'invalid' as const),
};
const bundled = () => startFixture(fakeService({ updateStatus: () => readUpdateStatus() }), undefined, undefined, aliasSeams, undefined, async () => ({ kind: 'bundled', cliPath: '/Applications/Vonvon Bot.app/Contents/Resources/daemon/bin/vonvon.mjs' }));
type Client = Awaited<ReturnType<typeof socketClient>>;
let next = 0;
const machine = (payload: object): Request => ({ type: 'request', id: `m${++next}`, method: 'machine', payload } as Request);
const negotiate = (): Request => ({ type: 'request', id: `n${++next}`, method: 'admin', payload: { type: 'negotiate', capabilities: [DESKTOP_SELF_UPDATE_CAPABILITY] } });
async function connected(port: number, credential: string, kind: 'cli' | 'web' | 'desktop', declare = false): Promise<Client> {
  const client = await socketClient(port, credential, undefined, 3000, kind);
  await client.ready();
  if (declare) expect(await client.call(negotiate())).toMatchObject({ type: 'response', payload: { kind: 'negotiated' } });
  return client;
}
type UpdateRequest = { requestId: string; action: string; by: string };
const requests = (client: Client): UpdateRequest[] => client.frames.flatMap(frame => frame.type === 'event' && frame.event === 'desktopUpdateRequest' ? [frame.payload] : []);
/** The shell's request of that kind: each test asks for one of each. */
async function nextRequest(client: Client, action: 'check' | 'apply'): Promise<UpdateRequest> {
  await vi.waitFor(() => expect(requests(client).some(request => request.action === action)).toBe(true), { timeout: 2000 });
  return requests(client).filter(request => request.action === action).at(-1)!;
}
const report = (shell: Client, requestId: string, state: string, extra: object = {}) =>
  shell.call(machine({ type: 'desktopUpdateReport', requestId, state, message: state, ...extra }));
const reply = (frame: Frame) => frame as Extract<Frame, { type: 'response' | 'error' }> & { payload?: Record<string, unknown>; code?: string; message?: string };

it('says what it can update, and checks and updates through the desktop shell, end to end', async () => {
  const fixture = await bundled();
  const clients: Client[] = [];
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    const cli = await connected(fixture.api.port, fixture.credential, 'cli');
    clients.push(cli);
    expect((cli.frames[0] as { capabilities: string[] }).capabilities).toContain('update.bundled');
    // no shell yet: the update is refused in the design words, nothing written
    expect(reply(await cli.call(machine({ type: 'applyCoreUpdate' })))).toMatchObject({ type: 'error', code: 'desktop_not_running' });
    expect(reply(await cli.call(machine({ type: 'checkCoreUpdate' }))).payload).toMatchObject({ type: 'coreUpdate', distribution: { kind: 'bundled' }, desktopShell: false, latest: null });
    // a cli, a web page and an undeclared desktop are not the shell, even when they declare it
    const imposter = await connected(fixture.api.port, fixture.credential, 'cli', true);
    const undeclared = await connected(fixture.api.port, fixture.credential, 'desktop');
    clients.push(imposter, undeclared);
    expect(reply(await cli.call(machine({ type: 'checkCoreUpdate' }))).payload).toMatchObject({ desktopShell: false });
    expect(reply(await imposter.call(machine({ type: 'desktopUpdateReport', requestId: 'dur_0000000000000000', state: 'current', message: 'x' })))).toMatchObject({ type: 'error', code: 'forbidden', message: '只有这台电脑上的桌面端能报告更新进度。' });
    expect(reply(await undeclared.call(machine({ type: 'desktopUpdateReport', requestId: 'dur_0000000000000000', state: 'current', message: 'x' })))).toMatchObject({ code: 'forbidden' });

    const shell = await connected(fixture.api.port, fixture.credential, 'desktop', true);
    clients.push(shell);
    // check: the shell is asked, and its answer is the reply
    const checking = cli.call(machine({ type: 'checkCoreUpdate' }));
    const check = await nextRequest(shell, 'check');
    expect(check.by).toBe('本机的命令行');
    await report(shell, check.requestId, 'available', { latest: '0.9.1' });
    expect(reply(await checking).payload).toMatchObject({ type: 'coreUpdate', distribution: { kind: 'bundled' }, current: expect.any(String), latest: '0.9.1', hasUpdate: true, desktopShell: true });
    // a version is the standalone server's only
    expect(reply(await cli.call(machine({ type: 'applyCoreUpdate', version: '0.9.1' })))).toMatchObject({ code: 'invalid_request' });

    expect(reply(await cli.call(machine({ type: 'applyCoreUpdate' }))).payload).toEqual({ type: 'done', message: '开始更新…' });
    const apply = await nextRequest(shell, 'apply');
    // the imposter's report for the same request is refused
    expect(reply(await imposter.call(machine({ type: 'desktopUpdateReport', requestId: apply.requestId, state: 'error', message: 'x' })))).toMatchObject({ code: 'forbidden' });
    await report(shell, apply.requestId, 'downloading', { latest: '0.9.1', progress: { transferred: 50, total: 100 } });
    expect(reply(await cli.call(machine({ type: 'coreUpdateStatus' }))).payload).toMatchObject({ status: { phase: 'installing', detail: 'desktop-downloading', via: 'desktop', progress: { transferred: 50, total: 100 } } });
    await report(shell, apply.requestId, 'downloaded', { latest: '0.9.1' });
    expect(reply(await report(shell, apply.requestId, 'restarting', { latest: '0.9.1' })).payload).toEqual({ type: 'done', message: '已收到。' });
    expect(reply(await cli.call(machine({ type: 'coreUpdateStatus' }))).payload).toMatchObject({ status: { phase: 'restarting', detail: 'draining', to: '0.9.1', via: 'desktop' } });
    // the restart is pending: no new update over it
    expect(reply(await cli.call(machine({ type: 'applyCoreUpdate' })))).toMatchObject({ code: 'conflict' });
  } finally {
    for (const client of clients) await client.close();
    await fixture.close();
  }
});

it('takes no report from a Bot session', async () => {
  const fixture = await bundled();
  try {
    const token = fixture.sessionTokens.issue({ appId: 'cli_a1b2c3d4e5f6a7b8', place: 'dm', chatId: 'oc_dm', sessionId: 'ses_0123456789abcdef' });
    const session = await socketClient(fixture.api.port, token);
    await session.ready();
    // a session negotiates its scope first, and may declare the capability: it still is not the shell
    expect(await session.call({ type: 'request', id: 'scope', method: 'admin', payload: { type: 'negotiate', capabilities: [DESKTOP_SELF_UPDATE_CAPABILITY], scope: { bot: 'cli_a1b2c3d4e5f6a7b8' } } }))
      .toMatchObject({ type: 'response', payload: { kind: 'negotiated' } });
    expect(reply(await session.call(machine({ type: 'desktopUpdateReport', requestId: 'dur_0000000000000000', state: 'current', message: 'x' })))).toMatchObject({ type: 'error', code: 'permission_denied' });
    await session.close();
  } finally { await fixture.close(); }
});

it.runIf(canBindAlias)('names a paired client in the request, and never takes a paired desktop for the shell', async () => {
  const fixture = await bundled();
  const sockets: WebSocket[] = [];
  const shell = await connected(fixture.api.port, fixture.credential, 'desktop', true);
  try {
    await shell.call({ type: 'request', id: 'port', method: 'device', payload: { type: 'setPort', port: await aliasPort() } });
    await shell.call({ type: 'request', id: 'on', method: 'device', payload: { type: 'enable', host: ALIAS } });
    const pairing = reply(await shell.call({ type: 'request', id: 'pair', method: 'device', payload: { type: 'pair' } })).payload as { link: string };
    const link = decodePairingLink(pairing.link);
    const target = link.addresses[0]!;
    const ws = new WebSocket(`ws://${target.host}:${target.port}/`, { perMessageDeflate: false });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const paired = await connectSecure({ socket: nodeBinarySocket(ws), device: { id: link.device.id, pk: link.device.pk }, clientKey: generateStaticKey().key, clientKind: 'desktop',
      pairing: { inviteId: link.invite.id, inviteSecret: link.invite.secret, clientName: '笔记本' } });
    expect(paired.serverInfo.capabilities).toContain('update.bundled');
    // a paired desktop may declare it, and still is not the shell: it may not report
    await paired.client.admin({ type: 'negotiate', capabilities: [DESKTOP_SELF_UPDATE_CAPABILITY] });
    await expect(paired.client.machine({ type: 'desktopUpdateReport', requestId: 'dur_0000000000000000', state: 'current', message: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await paired.client.machine({ type: 'applyCoreUpdate' })).toEqual({ type: 'done', message: '开始更新…' });
    const apply = await nextRequest(shell, 'apply');
    expect(apply.by).toBe('「笔记本」');
    await report(shell, apply.requestId, 'unavailable', { message: '这个安装包没有可用的签名更新源，请到官网下载新版本：https://vonvon.cc/get/' });
    expect(await paired.client.machine({ type: 'coreUpdateStatus' })).toMatchObject({ status: { phase: 'error', message: expect.stringContaining('没有可用的签名更新源') } });
    await paired.client.close();
  } finally {
    await shell.close();
    for (const socket of sockets) socket.terminate();
    await fixture.close();
  }
});
