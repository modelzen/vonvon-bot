/**
 * devices-2 第 6 节第 2 步：两个进程之间的配对和加密 RPC。不是 vitest 用例（test/manual/ 不在 include 里），手动跑：
 *
 *   T=$(mktemp -d)
 *   node_modules/.bin/esbuild packages/daemon/test/manual/secure-probe.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=packages/daemon/dist/secure-probe.mjs
 *   HOME=$T/home VONVON_HOME=$T/vh node packages/daemon/dist/secure-probe.mjs serve > $T/link &      # 进程 A
 *   HOME=$T/home VONVON_HOME=$T/vh node packages/daemon/dist/secure-probe.mjs connect "$(head -1 $T/link)"   # 进程 B
 *   kill %1; rm -rf -- "${T:?}"
 *
 * A：在 VONVON_HOME 里起 startApi（假的 AdminService，不起 Bot，不碰服务管理器），在 127.0.0.1 的随机端口挂
 * createSecureSocketServer，用 D1 的 InviteBook 造一条配对链接，第一行打印链接（只给 B 用，别贴出去），之后一直跑到被杀。
 * B：读链接配对，打印 pairResult、serverInfo、admin.daemonStatus；不带邀请再连一次；经 RPC 撤销自己，再连拿到
 * client_revoked。B 打印的内容已脱敏（不打印链接、secret 和密钥）。
 */
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { decodePairingLink, encodePairingLink } from '@vonvon/protocol';
import { connectSecure, generateStaticKey, nodeBinarySocket, SecureChannelError, type StaticKey } from '@vonvon/client/secure';
import type { AdminService } from '../../src/admin/service';
import { startApi } from '../../src/server/http';
import { createSecureSocketServer } from '../../src/server/secure-socket';

/** Just enough of a service for the daemon to start and answer daemonStatus: no bot, no backend. */
const service = {
  listBots: async () => [], listProjects: async () => [], getProject: async () => undefined, doctorBackends: async () => [],
  codexSetup: async () => ({ installation: 'missing', authentication: 'unknown', version: null, executable: null }),
  getDaemonStatus: async () => ({ installed: false, running: true, selfHosted: true, version: 'probe', supported: true }),
} as unknown as AdminService;

async function serve(): Promise<void> {
  const api = await startApi({ service, port: 0, serviceActions: { platform: 'linux', readService: async () => ({ supported: false, installed: false, running: false }) } });
  if (!api.secure) throw new Error('startApi gave no secure deps');
  const server = createServer();
  const remote = createSecureSocketServer({ ...api.secure, server });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const invite = api.secure.invites.create({ invitedBy: 'local' });
  // A loopback address cannot be in a link (D3 puts the real remote ones there); this probe pretends it is a LAN one.
  process.stdout.write(`${encodePairingLink({
    v: 1, device: { id: 'probe', name: api.secure.deviceName(), pk: api.secure.device.publicKey.toString('base64url') },
    addresses: [{ host: '127.0.0.1', port: address.port, kind: 'lan' }],
    invite: { id: invite.id, secret: invite.secret, expiresAt: invite.expiresAt }, relay: null, account: null,
  })}\n`);
  const stop = async (): Promise<void> => { await remote.close(); await api.close(); server.close(); process.exit(0); };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
}

async function open(link: ReturnType<typeof decodePairingLink>, clientKey: StaticKey, pairing?: { inviteId: string; inviteSecret: string; clientName: string }) {
  const address = link.addresses[0];
  if (!address) throw new Error('no address in the link');
  const ws = new WebSocket(`ws://${address.host}:${address.port}/`, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return connectSecure({ socket: nodeBinarySocket(ws), device: { id: link.device.id, pk: link.device.pk }, clientKey, clientKind: 'cli', ...(pairing ? { pairing } : {}) });
}
const print = (step: string, value: unknown): void => { process.stdout.write(`${step}: ${JSON.stringify(value)}\n`); };
const masked = (id: string): string => `${id.slice(0, 5)}…`;

async function connect(text: string): Promise<void> {
  const link = decodePairingLink(text);
  const clientKey = generateStaticKey().key;
  const first = await open(link, clientKey, { inviteId: link.invite.id, inviteSecret: link.invite.secret, clientName: 'secure-probe' });
  const clientId = first.pairResult?.clientId ?? '';
  print('1 pairResult', { clientId: masked(clientId), deviceName: first.pairResult?.deviceName });
  print('1 serverInfo', { ...first.serverInfo, machineId: masked(first.serverInfo.machineId) });
  const status = await first.client.admin({ type: 'daemonStatus' });
  print('1 admin.daemonStatus', status.kind === 'daemonStatus' ? { running: status.status.running, version: status.status.version, startedAt: typeof status.status.startedAt } : status.kind);
  first.close();
  print('1 closed', (await first.closed).code);

  const second = await open(link, clientKey);
  print('2 again without the invite', { principal: second.serverInfo.principal, pairResult: second.pairResult ?? null });
  const revoked = await second.client.device({ type: 'revokeClient', clientId });
  print('2 device.revokeClient', revoked.kind === 'revoked' ? { revoked: revoked.revoked.map(masked) } : revoked.kind);
  second.close();

  const third = await open(link, clientKey).then(() => 'connected (wrong)', (error: unknown) => error instanceof SecureChannelError ? `${error.code} at ${error.stage}, close ${error.closeCode}` : String(error));
  print('3 after the revocation', third);
  process.exit(third.startsWith('client_revoked') ? 0 : 1);
}

const [mode, argument] = process.argv.slice(2);
if (mode === 'serve') await serve();
else if (mode === 'connect' && argument) await connect(argument);
else { process.stderr.write('usage: secure-probe serve | connect <link>\n'); process.exit(2); }
