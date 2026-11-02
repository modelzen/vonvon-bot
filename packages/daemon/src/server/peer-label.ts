import type { ClientRecord } from '@vonvon/protocol';
import type { Peer } from './ws';

/**
 * How this daemon names a connection to the person at this computer (devices 第 15 节): a paired client by the name it
 * was given, 「笔记本」; one of this computer's own by what it is. U4 writes it into the desktop shell's notice ("「笔记本」
 * 正在更新这台电脑上的 Vonvon Bot"). U3's pairing notices use the same two functions.
 */
export const pairedPeerName = (name: string): string => `「${name}」`;
const LOCAL_KIND: Record<string, string> = { desktop: '桌面端', cli: '命令行', web: '网页端' };
export const localPeerLabel = (clientKind: Peer['clientKind']): string => `这台电脑上的${LOCAL_KIND[clientKind ?? ''] ?? '客户端'}`;

/** A paired connection (its maintenance subset too) by its client's name; the rest by `localPeerLabel`. */
export function peerName(peer: Pick<Peer, 'clientKind' | 'clientId'>, clients: { get(clientId: string): Pick<ClientRecord, 'name'> | undefined }): string {
  if (peer.clientId === undefined) return localPeerLabel(peer.clientKind);
  const name = clients.get(peer.clientId)?.name;
  return name ? pairedPeerName(name) : '另一台设备';
}
