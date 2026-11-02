import type { ClientRegistry } from '../remote/clients';
import type { Peer } from './ws';

/**
 * devices 6.3 and devices-ui-3 4.2: who a scan belongs to. `key`: the same paired client by its id, a client on this
 * computer by its kind, whatever connection it comes back on. `label`: how a refusal names it to someone on this
 * computer; `far`: to a paired client, which has its own 本机.
 */
export interface PeerOwner { key: string; label: string; far: string }

const KIND: Record<string, string> = { desktop: '桌面端', cli: '命令行', web: '网页端' };
/** "本机的桌面端 / 命令行 / 网页端"; a kind it does not know is "本机的客户端". U4's peerName uses it too. */
export function localPeerLabel(clientKind: string | undefined): string {
  return `本机的${KIND[clientKind ?? ''] ?? '客户端'}`;
}
/** A paired client's name, "未知设备" when it is not on the list. U4's peerName uses it too. */
export function pairedPeerName(clientId: string, clients: Pick<ClientRegistry, 'get'>): string {
  return clients.get(clientId)?.name ?? '未知设备';
}
/** A paired client by its id, one on this computer by its kind; a Bot session or a maintenance connection has none. */
export function peerOwner(peer: Pick<Peer, 'principal' | 'clientKind'>, clients: Pick<ClientRegistry, 'get'>, deviceName: string): PeerOwner | undefined {
  const { principal } = peer;
  if (principal.kind !== 'owner') return undefined;
  if (principal.via === 'paired') {
    const label = `另一台设备「${pairedPeerName(principal.clientId, clients)}」`;
    return { key: `paired:${principal.clientId}`, label, far: label };
  }
  const kind = KIND[peer.clientKind ?? ''] ?? '客户端';
  return { key: `local:${peer.clientKind ?? 'unknown'}`, label: localPeerLabel(peer.clientKind), far: `「${deviceName}」上的${kind}` };
}
