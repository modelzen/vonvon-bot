import type { AdminService } from '../../admin/service';
import { RpcError } from '../errors';

export async function requireRunningAgent(service: AdminService, agentId: string): Promise<void> {
  const agent = (await service.listBots()).find(bot => bot.appId === agentId);
  if (!agent?.active || !agent.running) throw new RpcError('conflict', 'Bot 没启用或没在运行');
}
