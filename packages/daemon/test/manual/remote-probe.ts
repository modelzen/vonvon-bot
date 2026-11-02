/**
 * devices-3 第 6 节：远程监听的手动探针。不是 vitest 用例（test/manual/ 不在 include 里），手动跑：
 *
 *   T=$(mktemp -d); mkdir -p "$T/home" "$T/vh"
 *   node_modules/.bin/esbuild packages/daemon/test/manual/remote-probe.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=packages/daemon/dist/remote-probe.mjs
 *   HOME=$T/home VONVON_HOME=$T/vh node packages/daemon/dist/remote-probe.mjs serve > "$T/serve.out" &   # 进程 A
 *   HOME=$T/home VONVON_HOME=$T/vh node packages/daemon/dist/remote-probe.mjs connect "$(head -1 "$T/serve.out")"   # 进程 B
 *   kill -TERM %1; wait; cat "$T/serve.out"; rm -rf -- "${T:?}"
 *
 * A：在 VONVON_HOME 里起 startApi（假的 AdminService，不起 Bot，不碰服务管理器），第一行打印 loopback 端口。远程地址
 * 用 127.0.0.2：Linux 上 127/8 都能绑，只在本机；注入的分类把它当局域网地址（回环地址本来不让开），网卡表里补上它。
 * 不碰真实的 Tailscale、公网网卡。收到 SIGTERM 时打印排空加关闭用了多久。
 * B：经 loopback 的 device RPC 开地址、生成链接，用 D2 的安全客户端配对、调 RPC，撤销后计时，无通道探针，限流，
 * 300 条乱写的连接时 loopback 的延迟，关地址，等待地址。打印的内容已脱敏（不打印链接、secret、密钥和 id）。
 */
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { decodePairingLink, PROTOCOL_VERSION, type DeviceReply } from '@vonvon/protocol';
import { connectSecure, generateStaticKey, nodeBinarySocket, SecureChannelError, type StaticKey } from '@vonvon/client/secure';
import type { AdminService } from '../../src/admin/service';
import { paths } from '../../src/config/paths';
import { classify } from '../../src/remote/address';
import { tailscaleIps } from '../../src/remote/tailscale';
import { startApi } from '../../src/server/http';

const ALIAS = '127.0.0.2';
const PORT = 17767;
const service = {
  listBots: async () => [], listProjects: async () => [], getProject: async () => undefined, doctorBackends: async () => [],
  codexSetup: async () => ({ installation: 'missing', authentication: 'unknown', version: null, executable: null }),
  getDaemonStatus: async () => ({ installed: false, running: true, selfHosted: true, version: 'probe', supported: true }),
} as unknown as AdminService;

async function serve(): Promise<void> {
  const interfaces = () => {
    const real = networkInterfaces();
    return { ...real, lo: [...real.lo ?? [], { address: ALIAS, netmask: '255.0.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: true, cidr: `${ALIAS}/8` }] };
  };
  const api = await startApi({
    service, port: 0, serviceActions: { platform: 'linux', readService: async () => ({ supported: false, installed: false, running: false }) },
    remote: { interfaces, classify: async host => host === ALIAS ? 'lan' : classify(host, { interfaces, tailscale: () => tailscaleIps() }) },
  });
  process.stdout.write(`${api.port}\n`);
  const stop = async (): Promise<void> => {
    const started = Date.now();
    await api.close();
    process.stdout.write(`serve: drained and closed in ${Date.now() - started} ms\n`);
    process.exit(0);
  };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
}

const print = (step: string, value: unknown): void => { process.stdout.write(`${step}: ${JSON.stringify(value)}\n`); };
const masked = (id: string): string => `${id.slice(0, 3)}…`;
/** The owner's loopback connection, with the local credential, as the CLI has it. */
async function loopback(port: number) {
  const credential = (await readFile(join(paths.appDir, 'local-credential'), 'utf8')).trim();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const waiting = new Map<string, (frame: { type: string; payload?: unknown; code?: string; message?: string }) => void>();
  let ready: () => void = () => undefined;
  const hello = new Promise<void>(resolve => { ready = resolve; });
  ws.on('message', data => {
    const frame = JSON.parse(String(data));
    if (frame.type === 'serverInfo') ready();
    if ('id' in frame) waiting.get(frame.id)?.(frame);
  });
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, clientKind: 'cli', credential }));
  await hello;
  let next = 0;
  const call = (method: string, payload: object) => new Promise<{ type: string; payload?: unknown; code?: string; message?: string }>(resolve => {
    const id = `p${next++}`;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ type: 'request', id, method, payload }));
  });
  const device = async (payload: object) => {
    const reply = await call('device', payload);
    if (reply.type !== 'response') throw new Error(`${reply.code}: ${reply.message}`);
    return reply.payload as DeviceReply;
  };
  return { call, device, close: () => ws.close() };
}
const statusOf = (reply: DeviceReply) => reply.kind === 'deviceStatus' ? { port: reply.status.remote.port, addresses: reply.status.remote.addresses.map(({ host, kind, state, detail }) => ({ host, kind, state, ...(detail ? { detail } : {}) })), clients: reply.status.clients } : reply.kind;
function get(port: number, headers: Record<string, string> = {}): Promise<string> {
  return new Promise(resolve => {
    const sent = httpRequest({ host: ALIAS, port, path: '/health', headers: { host: `${ALIAS}:${port}`, ...headers }, agent: false }, response => {
      let body = '';
      response.on('data', chunk => { body += String(chunk); });
      response.on('end', () => resolve(`${response.statusCode} ${body}`));
    });
    sent.on('error', error => resolve((error as NodeJS.ErrnoException).code ?? error.message));
    sent.end();
  });
}
const opened = async (port: number): Promise<WebSocket> => {
  const ws = new WebSocket(`ws://${ALIAS}:${port}/`, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_request, response) => { ws.on('error', () => undefined); ws.terminate(); reject(new Error(`HTTP ${response.statusCode}`)); });
  });
  return ws;
};
const plain = async (port: number): Promise<number> => {
  const ws = await opened(port);
  const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)));
  if (ws.readyState === WebSocket.OPEN) ws.send('hello');
  return closed;
};

async function connect(text: string): Promise<void> {
  const owner = await loopback(Number(text));
  print('1 device.setPort', statusOf(await owner.device({ type: 'setPort', port: PORT })));
  print('1 device.enable 127.0.0.2', statusOf(await owner.device({ type: 'enable', host: ALIAS })));
  print('1 device.enable 127.0.0.1', await owner.call('device', { type: 'enable', host: '127.0.0.1' }).then(reply => reply.code));
  print('1 device.enable 100.70.0.1', await owner.call('device', { type: 'enable', host: '100.70.0.1' }).then(reply => reply.code));
  print('1 device.enable 0.0.0.0', await owner.call('device', { type: 'enable', host: '0.0.0.0' }).then(reply => reply.code));
  print('2 GET /health', await get(PORT));
  print('2 GET /health with Origin', await get(PORT, { origin: 'http://x' }));
  print('2 GET /health with Host 1.2.3.4', await get(PORT, { host: '1.2.3.4' }));

  const pairing = await owner.device({ type: 'pair' });
  if (pairing.kind !== 'pairingLink') throw new Error('no link');
  const link = decodePairingLink(pairing.link);
  print('3 link addresses', link.addresses);
  const clientKey: StaticKey = generateStaticKey().key;
  const secure = await connectSecure({ socket: nodeBinarySocket(await opened(PORT)), device: { id: link.device.id, pk: link.device.pk }, clientKey, clientKind: 'cli',
    pairing: { inviteId: link.invite.id, inviteSecret: link.invite.secret, clientName: 'remote-probe' } });
  const clientId = secure.pairResult?.clientId ?? '';
  print('3 paired', { clientId: masked(clientId), principal: secure.serverInfo.principal, capabilities: secure.serverInfo.capabilities });
  const status = await secure.client.admin({ type: 'daemonStatus' });
  print('3 admin.daemonStatus over the channel', status.kind === 'daemonStatus' ? { running: status.status.running, version: status.status.version } : status.kind);
  const clients = await owner.device({ type: 'clients' });
  print('3 device.clients', clients.kind === 'clients' ? clients.clients.length : clients.kind);
  print('3 device.status', statusOf(await owner.device({ type: 'status' })));

  print('4 plaintext hello, no channel', await plain(PORT));

  const revokedAt = Date.now();
  const ended = secure.closed.then(error => ({ code: error.code, ms: Date.now() - revokedAt }));
  const revoked = await owner.device({ type: 'revokeClient', clientId });
  print('5 device.revokeClient', revoked.kind === 'revoked' ? revoked.revoked.map(masked) : revoked.kind);
  print('5 the paired connection ended', await ended);
  const again = await connectSecure({ socket: nodeBinarySocket(await opened(PORT)), device: { id: link.device.id, pk: link.device.pk }, clientKey, clientKind: 'cli' })
    .then(() => 'connected (wrong)', (error: unknown) => error instanceof SecureChannelError ? `${error.code} at ${error.stage}` : String(error));
  print('5 the revoked key again', again);

  const held = [];
  for (let n = 0; n < 4; n++) held.push(await opened(PORT));
  print('6 a fifth unauthenticated connection from one IP', await opened(PORT).then(() => 'open (wrong)', (error: Error) => error.message));
  for (const ws of held) ws.terminate();
  await new Promise(resolve => setTimeout(resolve, 200));
  const probes: number[] = [];
  for (let n = 0; n < 15 && !probes.includes(4004); n++) probes.push(await plain(PORT));
  print('6 plaintext probes until banned (close codes)', probes);
  const banned = await connectSecure({ socket: nodeBinarySocket(await opened(PORT)), device: { id: link.device.id, pk: link.device.pk }, clientKey: generateStaticKey().key, clientKind: 'cli' })
    .then(() => 'connected (wrong)', (error: unknown) => error instanceof SecureChannelError ? `${error.code} at ${error.stage}` : String(error));
  print('6 a banned IP, even with a key', banned);

  // devices 6 step 2: a burst of junk first messages; the loopback still answers at once
  const sockets = Array.from({ length: 300 }, () => {
    const socket = netConnect(PORT, ALIAS, () => { socket.end('x'); });
    socket.on('error', () => undefined);
    socket.resume();
    return socket;
  });
  const timed = Date.now();
  await owner.call('admin', { type: 'daemonStatus' });
  print('7 admin.daemonStatus on the loopback during 300 junk connections (ms)', Date.now() - timed);
  const settled = await Promise.race([
    Promise.all(sockets.map(socket => new Promise(resolve => { if (socket.destroyed) resolve(undefined); else socket.once('close', resolve); }))).then(() => 'all closed'),
    new Promise(resolve => setTimeout(() => resolve(`${sockets.filter(socket => !socket.destroyed).length} still open after 5 s`), 5_000)),
  ]);
  print('7 the junk connections', settled);
  for (const socket of sockets) socket.destroy();

  print('8 device.disable 127.0.0.2', statusOf(await owner.device({ type: 'disable', host: ALIAS })));
  print('8 GET /health after disable', await get(PORT));
  print('9 device.enable 10.255.255.254', statusOf(await owner.device({ type: 'enable', host: '10.255.255.254' })));
  owner.close();
  process.exit(0);
}

const [mode, argument] = process.argv.slice(2);
if (mode === 'serve') await serve();
else if (mode === 'connect' && argument) await connect(argument);
else { process.stderr.write('usage: remote-probe serve | connect <loopback port>\n'); process.exit(2); }
