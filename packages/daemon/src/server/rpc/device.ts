import { encodePairingLink, type DeviceReply, type DeviceRequest } from '@vonvon/protocol';
import { canonicalHost, resolveEnable, type EnableDeps } from '../../remote/address';
import type { ClientRegistry } from '../../remote/clients';
import { disableAddress, enableAddress, readRemoteConfig, setPort, updateRemoteConfig, type RemoteConfig } from '../../remote/config';
import type { DeviceHolder, DeviceIdentity } from '../../remote/device';
import type { InviteBook } from '../../remote/pairing';
import { RpcError, unsupported } from '../errors';
import type { RemoteListeners } from '../remote-listeners';
import type { RpcOutcome } from '../rpc';
import type { Peer } from '../ws';

/** devices 第 15 节"没开远程时 pair" (A1: no --tailscale; the terminal lists the addresses). */
export const NO_REMOTE_ADDRESS = '这台设备还没允许别的设备连接。先在终端里运行 `vonvon remote enable`，选一个别的设备能连到的地址。';
export interface DeviceDeps {
  home: string;
  /** Held here, so a rename reaches the next server info; renames take turns there. */
  identity: DeviceHolder;
  clients: ClientRegistry; invites: InviteBook;
  /** D3: the remote listeners, what opening an address asks of this machine, and how many paired clients are connected. */
  remote?: { listeners: RemoteListeners; enable: EnableDeps; active(): number };
}
const deviceView = ({ deviceId, name, keypair }: DeviceIdentity) => ({ id: deviceId, name, publicKey: keypair.publicKey });

/** The `device` RPC (devices 4.3; the remote addresses: D3 4.7). A change to the addresses is written, then the
 * listeners follow it before the reply: the status it carries is what they do now. */
export async function deviceRpc(deps: DeviceDeps, peer: Pick<Peer, 'principal'>, request: DeviceRequest): Promise<RpcOutcome<DeviceReply>> {
  const read = (value: DeviceReply): RpcOutcome<DeviceReply> => ({ kind: 'read', value });
  const { remote } = deps;
  const status = (port: number): RpcOutcome<DeviceReply> => read({ kind: 'deviceStatus', status: {
    device: deviceView(deps.identity.current),
    remote: { port, addresses: remote?.listeners.status() ?? [] },
    clients: { total: deps.clients.list().filter(client => client.revokedAt === undefined).length, active: remote?.active() ?? 0 },
  } });
  const change = async (next: (config: RemoteConfig) => RemoteConfig): Promise<RpcOutcome<DeviceReply>> => {
    if (!remote) return unsupported();
    const config = await updateRemoteConfig(deps.home, next);
    await remote.listeners.sync(config);
    return status(config.port);
  };
  switch (request.type) {
    case 'status': return remote ? status((await readRemoteConfig(deps.home)).port) : unsupported();
    case 'enable': {
      if (!remote) return unsupported();
      const address = await resolveEnable(request, remote.enable);
      return change(config => enableAddress(config, address));
    }
    case 'disable': return change(config => disableAddress(config, canonicalHost(request.host)));
    case 'setPort': return change(config => setPort(config, request.port));
    case 'pair': {
      const config = await readRemoteConfig(deps.home);
      if (!config.addresses.length) throw new RpcError('no_remote_address', NO_REMOTE_ADDRESS);
      const { principal } = peer;
      const invite = deps.invites.create({ ...(request.ttlMs ? { ttlMs: request.ttlMs } : {}), invitedBy: principal.kind === 'owner' && principal.via === 'paired' ? principal.clientId : 'local' });
      const { deviceId, name, keypair } = deps.identity.current;
      const link = encodePairingLink({
        v: 1, device: { id: deviceId, name, pk: keypair.publicKey },
        addresses: config.addresses.map(address => ({ host: address.host, port: config.port, kind: address.kind })),
        invite: { id: invite.id, secret: invite.secret, expiresAt: invite.expiresAt }, relay: null, account: null,
      });
      return read({ kind: 'pairingLink', link, inviteId: invite.id, expiresAt: invite.expiresAt });
    }
    case 'clients': return read({ kind: 'clients', generation: deps.clients.generation, clients: deps.clients.list() });
    case 'renameClient': {
      await deps.clients.rename(request.clientId, request.name);
      return read({ kind: 'clients', generation: deps.clients.generation, clients: deps.clients.list() });
    }
    // followRevocations tells the owner, and D3 disconnects them, through clients.onChange
    case 'revokeClient': return read({ kind: 'revoked', revoked: await deps.clients.revoke(request.clientId, { cascade: request.cascade ?? false }) });
    case 'rename': return read({ kind: 'device', device: deviceView(await deps.identity.rename(request.name)) });
  }
}
