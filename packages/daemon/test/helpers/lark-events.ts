import { createBridgeChannel } from '../../src/bot/bridge-channel';
import { EventDispatcher, LoggerLevel, normalize, type NormalizedMessage } from '@larksuiteoapi/node-sdk';

/** A receive event's `message` object, as Feishu names its fields. */
export type EventMessage = Record<string, unknown>;

export interface ReceiveOpts {
  bot: { openId: string; name: string };
  /** The sender's open_id; `app` for another bot; the name the SDK resolves for it. Default: a person, ou_owner. */
  sender?: { openId: string; type?: 'user' | 'app'; name?: string };
}

/** The SDK's own path: a WS frame's JSON through its EventDispatcher, then its
 * normalize with includeRaw, as LarkChannel does with includeRawEvent. */
export async function receive(message: EventMessage, opts: ReceiveOpts): Promise<NormalizedMessage> {
  const sender = opts.sender ?? { openId: 'ou_owner' };
  const at = String(message.create_time ?? Date.now());
  let out: Promise<NormalizedMessage> | undefined;
  const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.error }).register({
    'im.message.receive_v1': (raw: never) => { out = normalize(raw, { botIdentity: opts.bot, includeRaw: true, resolveSenderName: () => sender.name }); },
  } as never);
  await dispatcher.invoke({
    schema: '2.0',
    header: { event_id: `ev_${String(message.message_id)}`, event_type: 'im.message.receive_v1', create_time: at, token: '', app_id: 'cli_fixture', tenant_key: 't' },
    event: { sender: { sender_id: { open_id: sender.openId, union_id: `on_${sender.openId}` }, sender_type: sender.type ?? 'user', tenant_key: 't' }, message },
  }, { needCheck: false });
  if (!out) throw new Error('no receive handler ran');
  return out;
}

/** Use the real channel's safety pipeline without opening a network connection. */
export async function throughBridgeChannel(message: NormalizedMessage, handler: (message: NormalizedMessage) => unknown): Promise<void> {
  const channel = createBridgeChannel({ id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' }, 'fixture');
  channel.on('message', async value => { await handler(value); });
  channel.on('reject', rejection => { throw new Error(`SDK rejected: ${rejection.reason}`); });
  // The SDK exposes no offline receive API; use its actual private pipeline,
  // keeping normalization and policy execution real rather than mocking them.
  const safety: unknown = Reflect.get(channel, 'safety');
  if (!safety || typeof safety !== 'object' || !('pushMessage' in safety) || typeof safety.pushMessage !== 'function' || !('dispose' in safety) || typeof safety.dispose !== 'function') throw new Error('SDK safety pipeline unavailable');
  try { await safety.pushMessage(message); }
  finally { await safety.dispose(); }
}
