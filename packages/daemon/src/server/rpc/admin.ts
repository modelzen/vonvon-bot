import type { AdminRequest, AdminReply } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import { buildEventConfigUrl } from '../../config/scopes';
import { readAdminState } from '../state';
import type { RpcOutcome } from '../rpc';
import { unsupported } from '../errors';
import { secretsAction } from '../../admin/secrets';

export async function diagnosis(service: AdminService, agentId?: string): Promise<Extract<AdminReply, { kind: 'diagnosis' }>> {
  const bots = await service.listBots();
  const botId = agentId ?? (bots.find(bot => bot.current) ?? bots[0])?.appId;
  const bot = bots.find(bot => bot.appId === botId);
  const [backends, event] = await Promise.all([service.doctorBackends(), botId ? service.eventDiagnosis(botId) : Promise.resolve(undefined)]);
  const eventConfigUrl = bot ? buildEventConfigUrl(bot.appId, bot.tenant) : undefined;
  return { kind: 'diagnosis', bot: botId, backends, event, eventConfigUrl };
}
export async function adminRpc(service: AdminService, followLogs: (follow: boolean) => void, request: AdminRequest): Promise<RpcOutcome<AdminReply>> {
  switch (request.type) {
    case 'state': return { kind: 'read', value: { kind: 'state', state: await readAdminState(service) } };
    case 'diagnosis': return { kind: 'read', value: await diagnosis(service, request.agentId) };
    case 'hostDoctor': return { kind: 'read', value: { kind: 'hostDoctor', doctor: await service.hostDoctor() } };
    case 'setupStatus': return { kind: 'read', value: { kind: 'setupStatus', status: await service.getSetupStatus(request.agentId) } };
    case 'confirmCardCallback': {
      await service.confirmCardCallback(request.agentId, request.confirmed);
      return { kind: 'mutation', reply: snapshot => ({ kind: 'applied', revision: snapshot.revision }) };
    }
    case 'daemonStatus': return { kind: 'read', value: { kind: 'daemonStatus', status: await service.getDaemonStatus() } };
    case 'codexSetup': {
      if (!service.codexSetup) return unsupported();
      return { kind: 'read', value: { kind: 'codexSetup', setup: await service.codexSetup() } };
    }
    case 'logs': return { kind: 'read', value: { kind: 'logs', text: await service.tailLogs({ maxBytes: Math.min(256 * 1024, Math.max(1024, request.maxBytes ?? 64 * 1024)) }) } };
    case 'followLogs': {
      followLogs(request.follow);
      return { kind: 'mutation', reply: () => ({ kind: 'following', follow: request.follow }) };
    }
    case 'switchBackend': {
      await service.switchBackend(request.agentId, request.projectName, request.backend);
      return { kind: 'mutation', reply: snapshot => ({ kind: 'applied', revision: snapshot.revision }) };
    }
    // Nothing in the snapshot shows a key, so a save is a read: no rebuild, no revision (s23g)
    case 'secrets': case 'setSecret': case 'removeSecret': case 'testSecret':
      return { kind: 'read', value: await secretsAction(request) };
  }
}
