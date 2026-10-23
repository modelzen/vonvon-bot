import { contextPreviewReplySchema, type ContextPreviewReply, type ContextPreviewRequest } from '@vonvon/protocol';
import { contextPreview } from '../../admin/context-preview';
import type { AdminService } from '../../admin/service';
import type { RpcOutcome } from '../rpc';
import { RpcError } from '../errors';

/** "模型看到什么" (记忆设计 5.5): always a read. A stopped bot still answers, with the new-session column only. */
export async function contextPreviewRpc(service: AdminService, request: ContextPreviewRequest): Promise<RpcOutcome<ContextPreviewReply>> {
  const bot = (await service.listBots()).find(entry => entry.appId === request.agentId);
  if (!bot) throw new RpcError('invalid_request', '没有这个 Bot');
  const value = await contextPreview(request, { running: bot.running, ...(bot.botName ? { botName: bot.botName } : {}) });
  return { kind: 'read', value: contextPreviewReplySchema.parse(value) };
}
