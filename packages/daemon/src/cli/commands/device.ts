import type { ClientRecord, DeviceReply, DeviceRequest } from '@vonvon/protocol';
import { acquireMutex, closeMutex, MUTEX_TIMEOUT, type Mutex } from '../../config/data-access';
import { paths } from '../../config/paths';
import { createClientRegistry } from '../../remote/clients';
import { loadOrCreateDevice, renameDevice } from '../../remote/device';
import { readMachineId } from '../../server/local-credential';
import { RpcError } from '../../server/errors';
import { readRunningPidLock } from '../../server/pid-lock';
import { badArgs, CommandError, rpcErrorKind } from '../command-error';
import { localTime, print, printable, want, withDaemon, type Daemon, type Io } from '../daemon-client';

// the texts: devices 第 15 节
const PAIR_NO_DAEMON = '后台服务没在运行，连接链接要由它生成。先运行 `vonvon daemon start`。';
const pairHint = (minutes: number): string => `把下面这条链接粘到另一台电脑的 Vonvon Bot → 设置 → 设备 → 添加。${minutes} 分钟内有效，只能用一次，别发给别人；如果是让 AI 替你运行的，它的对话记录里会留着这条链接。`;
/** A lock that cannot be read counts as running: the connection then says what is wrong. */
const daemonRunning = (home: string): Promise<boolean> => readRunningPidLock(home).then(Boolean, () => true);
const NEW_MS = 24 * 3600_000;

/** The link goes to stdout either way (devices 4.3 REQ-2): a script captures it, a person copies it. */
export async function runPair(options: { ttl?: string }, io: Io, daemon: Daemon = withDaemon, home = paths.appDir): Promise<void> {
  const minutes = options.ttl === undefined ? 10 : Number(options.ttl);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10) throw badArgs('--ttl 是 1 到 10 的整数（分钟）。');
  if (!await daemonRunning(home)) throw new CommandError('connection', PAIR_NO_DAEMON);
  const reply = await daemon(call => call('生成连接链接', c => c.device({ type: 'pair', ttlMs: minutes * 60_000 })));
  const { link, inviteId, expiresAt } = want('生成连接链接', reply, 'pairingLink');
  print(io, [pairHint(minutes), link], { link, inviteId, expiresAt });
}

const DAEMON_STARTING = '后台服务正在启动，等它起来再运行一次这条命令。';
/** How long the files path waits for the host mutex: another CLI's turn takes milliseconds; a daemon holds it until it stops. */
const FILES_WAIT_MS = 10_000;
/** The host mutex, taken from a CLI that writes these files itself; undefined while someone else holds it. */
async function hostMutex(home: string): Promise<Mutex | undefined> {
  try { return await acquireMutex(home, 'host', 200); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === MUTEX_TIMEOUT) return undefined;
    throw error;
  }
}

/** clients, device rename and remote (devices 8.1, 8.3): through the daemon when it runs, which alone writes these files then;
 * otherwise straight on the files, and the output says `source: 'files'`. The files path holds the host mutex, which a
 * running daemon holds from its start to its exit (host/bootstrap.ts): two CLIs take turns at the read-change-write, and a
 * daemon starting meanwhile waits for it and then reads what it wrote, so no revocation is lost to a stale copy. */
export async function either<T>(home: string, daemon: Daemon, what: string, rpc: (send: (request: DeviceRequest) => Promise<DeviceReply>) => Promise<T>,
  files: () => Promise<T>): Promise<[T, { source?: 'files' }]> {
  const deadline = Date.now() + FILES_WAIT_MS;
  for (;;) {
    if (await daemonRunning(home)) return [await daemon(call => rpc(request => call(what, c => c.device(request)))), {}];
    const lock = await hostMutex(home);
    if (!lock) {
      if (Date.now() >= deadline) throw new CommandError('connection', DAEMON_STARTING);
      continue;
    }
    try { return [await files(), { source: 'files' }]; }
    catch (error) { throw error instanceof RpcError ? new CommandError(rpcErrorKind(error.code), error.message, { reason: error.code }) : error; }
    finally { await closeMutex(lock); }
  }
}
export async function onFiles<T>(home: string, use: (registry: Awaited<ReturnType<typeof createClientRegistry>>) => Promise<T>): Promise<T> {
  const registry = await createClientRegistry(home);
  try { return await use(registry); } finally { await registry.close(); }
}
const checkName = (name: string): string => {
  if (!name.trim() || name.length > 40) throw badArgs('名字要 1 到 40 个字。');
  return name;
};
function clientLine(client: ClientRecord, now: number): string {
  const seen = client.lastSeenAt === client.createdAt ? '—' : localTime(client.lastSeenAt);
  const state = client.revokedAt === undefined ? '' : `  已撤销 ${localTime(client.revokedAt)}`;
  const fresh = client.revokedAt === undefined && now - client.createdAt < NEW_MS ? '  新' : '';
  return `${client.id}  ${printable(client.name)}  ${client.clientKind}  配对 ${localTime(client.createdAt)}  最近 ${seen}  邀请自 ${client.invitedBy}${state}${fresh}`;
}

export async function runClients(action: 'ls' | 'rename' | 'revoke', target: { clientId?: string; name?: string; cascade?: boolean }, io: Io, daemon: Daemon = withDaemon, home = paths.appDir): Promise<void> {
  if (action === 'ls') {
    const [{ generation, clients }, from] = await either(home, daemon, '读取客户端列表', async send => want('读取客户端列表', await send({ type: 'clients' }), 'clients'),
      () => onFiles(home, async registry => ({ generation: registry.generation, clients: registry.list() })));
    const now = Date.now();
    print(io, clients.length ? clients.map(client => clientLine(client, now)) : ['还没有配对过的设备。运行 vonvon pair 生成连接链接。'], { generation, clients, ...from });
    return;
  }
  const clientId = target.clientId ?? '';
  if (action === 'rename') {
    const name = checkName(target.name ?? '');
    const [client, from] = await either(home, daemon, '改客户端名字',
      async send => want('改客户端名字', await send({ type: 'renameClient', clientId, name }), 'clients').clients.find(entry => entry.id === clientId),
      () => onFiles(home, registry => registry.rename(clientId, name)));
    print(io, [`已把 ${clientId} 改名为「${printable(name)}」。`], { client, ...from });
    return;
  }
  const cascade = Boolean(target.cascade);
  const [revoked, from] = await either(home, daemon, '撤销客户端', async send => want('撤销客户端', await send({ type: 'revokeClient', clientId, cascade }), 'revoked').revoked,
    () => onFiles(home, registry => registry.revoke(clientId, { cascade })));
  print(io, [revoked.length ? `已撤销：${revoked.join('、')}。它们要再连，得重新配对。` : `${clientId} 之前已经撤销过了。`], { revoked, ...from });
}

export async function runDeviceRename(name: string, io: Io, daemon: Daemon = withDaemon, home = paths.appDir): Promise<void> {
  checkName(name);
  const [device, from] = await either(home, daemon, '改设备名字', async send => want('改设备名字', await send({ type: 'rename', name }), 'device').device, async () => {
    await loadOrCreateDevice(home, await readMachineId(home));
    const { deviceId, name: renamed, keypair } = await renameDevice(home, name);
    return { id: deviceId, name: renamed, publicKey: keypair.publicKey };
  });
  print(io, [`这台设备现在叫「${printable(device.name)}」，别的设备下次连上时看到新名字。`], { device, ...from });
}
