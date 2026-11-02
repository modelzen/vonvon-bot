import { networkInterfaces } from 'node:os';
import type { AddressKind, DeviceReply, DeviceRequest, DeviceStatus } from '@vonvon/protocol';
import { paths } from '../../config/paths';
import { hostHeader, networkIdentity, ONE_TARGET, resolveEnable, canonicalHost, type EnableDeps } from '../../remote/address';
import { disableAddress, enableAddress, PORT_RANGE, readRemoteConfig, setPort, updateRemoteConfig, type RemoteConfig } from '../../remote/config';
import { loadOrCreateDevice } from '../../remote/device';
import { NO_REMOTE_ADDRESS } from '../../server/rpc/device';
import { readMachineId } from '../../server/local-credential';
import { tailscaleIps } from '../../remote/tailscale';
import { badArgs } from '../command-error';
import { print, want, withDaemon, type Daemon, type Io } from '../daemon-client';
import { either, onFiles } from './device';

// D3 4.8; the texts: devices 第 15 节
const KIND_NAME: Record<AddressKind, string> = { tailscale: 'Tailscale 地址', lan: '局域网地址', cgnat: '运营商地址', public: '公网地址', loopback: '回环地址' };
const confirmed = (kind: AddressKind): string => kind === 'cgnat' || kind === 'public' ? `${KIND_NAME[kind]}（已确认）` : KIND_NAME[kind];
const STATE_NAME: Record<DeviceStatus['remote']['addresses'][number]['state'], string> = {
  listening: '在听', waiting: '等待地址出现', 'needs-confirmation': '网络变了，确认后再开', failed: '失败', disabled: '没在听',
};
const NOT_RUNNING = '后台服务没在运行，下次启动时生效。';
const enabled = (host: string, port: number, kind: AddressKind): string => `已在 ${hostHeader(host, port)} 接受连接（${confirmed(kind)}）。只有配对过的客户端能连上，接下来运行 \`vonvon pair\` 生成连接链接。`;

const machine: EnableDeps = { interfaces: networkInterfaces, tailscale: () => tailscaleIps(), networkIdentity: iface => networkIdentity(iface) };
/** With no daemon: the addresses as written, none listened on, and no client connected. */
async function filesStatus(home: string, config: RemoteConfig): Promise<DeviceStatus> {
  const { deviceId, name, keypair } = await loadOrCreateDevice(home, await readMachineId(home));
  const total = await onFiles(home, async registry => registry.list().filter(client => client.revokedAt === undefined).length);
  return {
    device: { id: deviceId, name, publicKey: keypair.publicKey },
    remote: { port: config.port, addresses: config.addresses.map(({ host, kind, enabledAt }) => ({ host, kind, enabledAt, state: 'disabled' as const })) },
    clients: { total, active: 0 },
  };
}
type Source = { source?: 'files' };
const tail = (from: Source): string[] => from.source === 'files' ? [NOT_RUNNING] : [];
/** One address's state as a line, for the ones a command just changed and does not listen on yet. */
const stateLine = (address: DeviceStatus['remote']['addresses'][number] | undefined): string[] =>
  address && address.state !== 'listening' && address.state !== 'disabled' ? [`现在：${STATE_NAME[address.state]}${address.detail ? `，${address.detail}` : ''}。`] : [];

/** `vonvon remote status|enable|disable|port` (D3 4.8): through the daemon when it runs, which binds and closes the
 * listeners at once; otherwise on remote.json under the host mutex, for the next start. */
export async function runRemote(action: 'status' | 'enable' | 'disable' | 'port', target: { host?: string; tailscale?: boolean; allowPublic?: boolean; port?: string },
  io: Io, daemon: Daemon = withDaemon, home = paths.appDir, deps: EnableDeps = machine): Promise<void> {
  const viaDaemon = (what: string, request: DeviceRequest) => async (send: (request: DeviceRequest) => Promise<DeviceReply>) => want(what, await send(request), 'deviceStatus').status;
  if (action === 'status') {
    const [status, from] = await either(home, daemon, '读取远程连接状态', viaDaemon('读取远程连接状态', { type: 'status' }), async () => filesStatus(home, await readRemoteConfig(home)));
    const rows = status.remote.addresses.map(({ host, kind, state, detail }) => `${host}  ${KIND_NAME[kind]}  ${STATE_NAME[state]}  ${detail ?? '—'}  ${status.remote.port}`);
    print(io, [...rows.length ? ['地址  种类  状态  说明  端口', ...rows] : [NO_REMOTE_ADDRESS], `客户端：${status.clients.total} 台，在线 ${status.clients.active}`, ...tail(from)], { status, ...from });
    return;
  }
  if (action === 'enable') {
    if ((target.host === undefined) === !target.tailscale) throw badArgs(ONE_TARGET);
    const request = { ...(target.host === undefined ? { tailscale: true } : { host: target.host }), ...(target.allowPublic ? { allowPublic: true } : {}) };
    let host = target.host === undefined ? '' : canonicalHost(target.host);
    const [status, from] = await either(home, daemon, '开启远程地址', viaDaemon('开启远程地址', { type: 'enable', ...request }), async () => {
      const address = await resolveEnable(request, deps);
      host = address.host;
      return filesStatus(home, await updateRemoteConfig(home, config => enableAddress(config, address)));
    });
    // --tailscale through the daemon: the address it picked is the one opened last
    const latest = status.remote.addresses.reduce<DeviceStatus['remote']['addresses'][number] | undefined>((last, entry) => !last || entry.enabledAt >= last.enabledAt ? entry : last, undefined);
    const address = host ? status.remote.addresses.find(entry => entry.host === host) : latest;
    if (!address) throw new Error('开启的地址不在状态里。');
    print(io, [enabled(address.host, status.remote.port, address.kind), ...stateLine(address), ...tail(from)], { host: address.host, status, ...from });
    return;
  }
  if (action === 'disable') {
    const host = canonicalHost(target.host ?? '');
    const [status, from] = await either(home, daemon, '关闭远程地址', viaDaemon('关闭远程地址', { type: 'disable', host }),
      async () => filesStatus(home, await updateRemoteConfig(home, config => disableAddress(config, host))));
    print(io, [from.source === 'files' ? `已关闭 ${host}。` : `已关闭 ${host}，经这个地址的连接都已断开。`, ...tail(from)], { host, status, ...from });
    return;
  }
  const port = Number(target.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw badArgs(PORT_RANGE);
  const [status, from] = await either(home, daemon, '改远程端口', viaDaemon('改远程端口', { type: 'setPort', port }),
    async () => filesStatus(home, await updateRemoteConfig(home, config => setPort(config, port))));
  print(io, [`远程端口改成了 ${port}，已配对的设备要重新配对。`, ...status.remote.addresses.flatMap(address => stateLine(address).map(line => `${address.host}：${line}`)), ...tail(from)], { status, ...from });
}
