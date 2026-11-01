import { encodePairingLink, type DeviceReply, type DeviceRequest, type Event } from '@vonvon/protocol';
import type { log as logger } from '../../core/logger';
import type { ClientRegistry } from '../../remote/clients';
import { readRemoteConfig } from '../../remote/config';
import { renameDevice, type DeviceIdentity } from '../../remote/device';
import type { InviteBook } from '../../remote/pairing';
import { RpcError, unsupported } from '../errors';
import type { RpcOutcome } from '../rpc';
import type { Peer } from '../ws';

/** devices 第 15 节"没开远程时 pair". */
export const NO_REMOTE_ADDRESS = '这台设备还没允许别的设备连接。先运行 `vonvon remote enable --tailscale`（推荐）或 `vonvon remote enable <这台设备的 IP>`。';

export interface DeviceDeps {
  home: string;
  /** Held here, so a rename reaches the next server info. */
  identity: { current: DeviceIdentity };
  clients: ClientRegistry; invites: InviteBook;
  publish(event: Event): void; log: Pick<typeof logger, 'info'>;
}
const deviceView = ({ deviceId, name, keypair }: DeviceIdentity) => ({ id: deviceId, name, publicKey: keypair.publicKey });

/** The `device` RPC (devices 4.3). `status/enable/disable/setPort` arrive with the remote listeners (D3). */
export async function deviceRpc(deps: DeviceDeps, peer: Pick<Peer, 'principal'>, request: DeviceRequest): Promise<RpcOutcome<DeviceReply>> {
  const read = (value: DeviceReply): RpcOutcome<DeviceReply> => ({ kind: 'read', value });
  switch (request.type) {
    case 'status': case 'enable': case 'disable': case 'setPort': return unsupported();
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
    case 'revokeClient': {
      const revoked = await deps.clients.revoke(request.clientId, { cascade: request.cascade ?? false });
      // D3 closes their connections through clients.onChange.
      for (const id of revoked) {
        const client = deps.clients.get(id);
        if (!client) continue;
        const fields = { clientId: id, name: client.name, clientKind: client.clientKind, address: client.lastAddress, invitedBy: client.invitedBy };
        deps.publish({ type: 'event', event: 'device', payload: { change: 'client-revoked', ...fields } });
        deps.log.info('device', 'client-revoked', fields);
      }
      return read({ kind: 'revoked', revoked });
    }
    case 'rename': {
      deps.identity.current = await renameDevice(deps.home, request.name);
      return read({ kind: 'device', device: deviceView(deps.identity.current) });
    }
  }
}
