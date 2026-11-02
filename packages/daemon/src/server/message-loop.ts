import { DRAIN_KINDS, requestSchema, rpcKindOf, type Request } from '@vonvon/protocol';
import { errorEnvelope } from './errors';
import type { PeerHub } from './peer-hub';
import type { Peer } from './ws';

/** What a draining daemon still answers, through `control` (devices 4.7): the shared list, coreUpdateStatus included, so an
 * update's progress stays visible. */
const DRAINING = new Set<string>(DRAIN_KINDS);

export interface MessageLoopOptions {
  request(peer: Peer, request: Request): Promise<void>;
  control?(peer: Peer, request: Request): Promise<void>;
}
/** devices-2 4.4: one message from a connection past its hello, the same for the loopback socket and the secure channel:
 * `text` is the JSON text, undefined for a frame that is not one. Drained, only the drain kinds go on (to `control`). A
 * connection is closed with its own `close`: the secure channel says it inside the channel too. */
export function handleMessage(hub: PeerHub, peer: Peer, text: string | undefined, options: MessageLoopOptions): void {
  if (hub.state === 'released') return;
  let raw: unknown;
  try {
    if (text === undefined) throw new Error('not a text frame');
    raw = JSON.parse(text);
  } catch {
    if (hub.state === 'draining') peer.close(1001, 'server_shutdown');
    else peer.close(1007, 'invalid_message');
    return;
  }
  if (hub.state === 'draining') {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success || !options.control || !DRAINING.has(rpcKindOf(parsed.data))) {
      peer.close(1001, 'server_shutdown');
      return;
    }
    void options.control(peer, parsed.data).catch(error => peer.send(errorEnvelope(parsed.data.id, error)));
    return;
  }
  if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string' || !raw.id) { peer.close(1007, 'invalid_message'); return; }
  const id = raw.id;
  if ('type' in raw && raw.type === 'request' && 'method' in raw && typeof raw.method === 'string' && !requestSchema.optionsMap.has(raw.method)) {
    peer.send({ type: 'error', id, code: 'unknown_method', message: '未知 RPC 方法。' });
    return;
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) { peer.send({ type: 'error', id, code: 'invalid_request', message: '请求参数无效。' }); return; }
  const completion = Promise.resolve().then(() => options.request(peer, parsed.data)).catch(error => {
    peer.send(errorEnvelope(id, error));
  });
  hub.track(completion);
}
