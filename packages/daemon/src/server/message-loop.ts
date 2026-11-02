import { DRAIN_KINDS, requestSchema, rpcKindOf, type Request } from '@vonvon/protocol';
import { getRpcErrorCode } from './errors';
import type { PeerHub } from './peer-hub';
import type { Peer } from './ws';

/** What a draining daemon still answers, through `control` (devices 4.7): `DRAIN_KINDS`, with `control` answering
 * `machine.coreUpdateStatus` too (server-3a). */
const DRAINING: ReadonlySet<string> = new Set(DRAIN_KINDS);

export interface MessageLoopOptions {
  request(peer: Peer, request: Request): Promise<void>;
  control?(peer: Peer, request: Request): Promise<void>;
  close(code: number, reason: string): void;
}
/** devices-2 4.4: one message from a connection past its hello, the same for the loopback socket and the secure channel:
 * `text` is the JSON text, undefined for a frame that is not one. Drained, only the drain kinds go on (to `control`). */
export function handleMessage(hub: PeerHub, peer: Peer, text: string | undefined, options: MessageLoopOptions): void {
  if (hub.state === 'released') return;
  let raw: unknown;
  try {
    if (text === undefined) throw new Error('not a text frame');
    raw = JSON.parse(text);
  } catch {
    if (hub.state === 'draining') options.close(1001, 'server_shutdown');
    else options.close(1007, 'invalid_message');
    return;
  }
  if (hub.state === 'draining') {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success || !options.control || !DRAINING.has(rpcKindOf(parsed.data))) {
      options.close(1001, 'server_shutdown');
      return;
    }
    void options.control(peer, parsed.data).catch(error => peer.send({ type: 'error', id: parsed.data.id, code: getRpcErrorCode(error), message: error instanceof Error ? error.message : '操作失败。' }));
    return;
  }
  if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string' || !raw.id) { options.close(1007, 'invalid_message'); return; }
  const id = raw.id;
  if ('type' in raw && raw.type === 'request' && 'method' in raw && typeof raw.method === 'string' && !requestSchema.optionsMap.has(raw.method)) {
    peer.send({ type: 'error', id, code: 'unknown_method', message: '未知 RPC 方法。' });
    return;
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) { peer.send({ type: 'error', id, code: 'invalid_request', message: '请求参数无效。' }); return; }
  const completion = Promise.resolve().then(() => options.request(peer, parsed.data)).catch(error => {
    peer.send({ type: 'error', id, code: getRpcErrorCode(error), message: error instanceof Error ? error.message : '操作失败。' });
  });
  hub.track(completion);
}
