import { requestSchema, requestSchemaForMethod, type Request } from '@vonvon/protocol';
import { drainingError, errorEnvelope } from './errors';
import type { PeerHub } from './peer-hub';
import type { Peer } from './ws';

export interface MessageLoopOptions {
  request(peer: Peer, request: Request): Promise<void>;
  /** While the hub drains, every request goes here instead: it answers DRAIN_KINDS (devices 4.7: the status, the update's
   * progress, the stop, the last snapshot) and refuses the rest with `draining`, the connection kept (http.ts). */
  control?(peer: Peer, request: Request): Promise<void>;
}
/** devices-2 4.4: one message from a connection past its hello, the same for the loopback socket and the secure channel:
 * `text` is the JSON text, undefined for a frame that is not one. Drained, a request goes to `control`, and one it cannot
 * read is answered `draining` (Codex review 248: a client that reconnected to follow an update is not closed for what its
 * page asks); a frame with no id to answer is closed 1001. A connection is closed with its own `close`: the secure channel
 * says it inside the channel too. */
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
    const id = raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string' && raw.id ? raw.id : undefined;
    if (id === undefined || !options.control) { peer.close(1001, 'server_shutdown'); return; }
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) { peer.send(errorEnvelope(id, drainingError())); return; }
    if (parsed.data.method === 'snapshot' && parsed.data.payload.groupAttention) peer.enableGroupAttention?.();
    void options.control(peer, parsed.data).catch(error => peer.send(errorEnvelope(id, error)));
    return;
  }
  if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string' || !raw.id) { peer.close(1007, 'invalid_message'); return; }
  const id = raw.id;
  if ('type' in raw && raw.type === 'request' && 'method' in raw && typeof raw.method === 'string' && !requestSchemaForMethod(raw.method)) {
    peer.send({ type: 'error', id, code: 'unknown_method', message: '未知 RPC 方法。' });
    return;
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) { peer.send({ type: 'error', id, code: 'invalid_request', message: '请求参数无效。' }); return; }
  if (parsed.data.method === 'snapshot' && parsed.data.payload.groupAttention) peer.enableGroupAttention?.();
  const completion = Promise.resolve().then(() => options.request(peer, parsed.data)).catch(error => {
    peer.send(errorEnvelope(id, error));
  });
  hub.track(completion);
}
