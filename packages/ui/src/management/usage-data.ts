import type {CollaborationClient, CollaborationReply} from '@vonvon/protocol';

export type Usage = Extract<CollaborationReply, {kind: 'usage'}>['data'];

/** One request contract for the settings page and home; daemon owns the cache. */
export async function readUsage(request: CollaborationClient, force = false): Promise<Usage> {
  const reply = await request({action: 'usage', force});
  if (reply.kind === 'usage') return reply.data;
  throw new Error(reply.kind === 'refused' ? reply.message : '无法读取 Codex 用量。');
}
