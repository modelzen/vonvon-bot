import type {CollaborationClient, CollaborationReply} from '@vonvon/protocol';

export type Usage = Extract<CollaborationReply, {kind: 'usage'}>['data'];

/** One request contract for the settings page and home; daemon owns the cache. */
export async function readUsage(request: CollaborationClient, force = false, backend?: 'claude-agent'): Promise<Usage> {
  const reply = await request({action: 'usage', force, ...(backend ? {backend} : {})});
  if (reply.kind === 'usage') return reply.data;
  throw new Error(reply.kind === 'refused' ? reply.message : '无法读取用量。');
}
