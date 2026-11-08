import type { AdminRequest, AdminReply } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import { buildEventConfigUrl } from '../../config/scopes';
import { readAdminState } from '../state';
import type { RpcOutcome } from '../rpc';
import { RpcError, unsupported } from '../errors';
import { principalWire } from '../principal';
import { checkSessionScope } from '../authz';
import type { Peer } from '../ws';
import { judgeUsageView } from '../../admin/judge-usage';
import { secretsAction } from '../../admin/secrets';
import { shareTargets, type ShareUploads } from '../../admin/share';

export async function diagnosis(service: AdminService, agentId?: string): Promise<Extract<AdminReply, { kind: 'diagnosis' }>> {
  const bots = await service.listBots();
  const botId = agentId ?? (bots.find(bot => bot.current) ?? bots[0])?.appId;
  const bot = bots.find(bot => bot.appId === botId);
  const [backends, event] = await Promise.all([service.doctorBackends(), botId ? service.eventDiagnosis(botId) : Promise.resolve(undefined)]);
  const eventConfigUrl = bot ? buildEventConfigUrl(bot.appId, bot.tenant) : undefined;
  return { kind: 'diagnosis', bot: botId, backends, event, eventConfigUrl };
}
/** What the connection adds: when this daemon started, the peer admin.negotiate records on, and where its share GIF goes up. */
export interface AdminConnection { startedAt: number; peer: Pick<Peer, 'principal' | 'scope' | 'negotiated' | 'negotiate'>; shares?: ShareUploads }
export async function adminRpc(service: AdminService, followLogs: (follow: boolean) => void, request: AdminRequest, connection?: AdminConnection): Promise<RpcOutcome<AdminReply>> {
  switch (request.type) {
    case 'judgeUsage': return { kind: 'read', value: await judgeUsageView() };
    case 'state': return { kind: 'read', value: { kind: 'state', state: await readAdminState(service) } };
    case 'diagnosis': return { kind: 'read', value: await diagnosis(service, request.agentId) };
    case 'hostDoctor': return { kind: 'read', value: { kind: 'hostDoctor', doctor: await service.hostDoctor() } };
    case 'setupStatus': return { kind: 'read', value: { kind: 'setupStatus', status: await service.getSetupStatus(request.agentId) } };
    case 'cardCallbackStatus': {
      if (!service.getCardCallbackStatus) return unsupported();
      return { kind: 'read', value: { kind: 'cardCallbackStatus', cardCallback: await service.getCardCallbackStatus(request.agentId) } };
    }
    case 'confirmCardCallback': {
      await service.confirmCardCallback(request.agentId, request.confirmed);
      return { kind: 'mutation', reply: snapshot => ({ kind: 'applied', revision: snapshot.revision }) };
    }
    case 'daemonStatus': return { kind: 'read', value: { kind: 'daemonStatus', status: { ...await service.getDaemonStatus(), startedAt: connection?.startedAt ?? Math.round(performance.timeOrigin) } } };
    // devices 4.5: recorded once; a Bot session's scope must be no wider than the session (devices 5.3).
    case 'negotiate': {
      if (!connection) return unsupported();
      if (connection.peer.negotiated) throw new RpcError('invalid_request', 'negotiate 只能发一次。');
      checkSessionScope(connection.peer.principal, request.scope ?? null);
      if (!connection.peer.negotiate(request.capabilities, request.scope ?? null)) throw new RpcError('invalid_request', 'negotiate 只能发一次。');
      return { kind: 'read', value: { kind: 'negotiated', principal: principalWire(connection.peer.principal), scope: connection.peer.scope } };
    }
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
    // now-share N5c: refusals are replies; an upload lives as long as the connection that sends it.
    case 'shareTargets': return { kind: 'read', value: await shareTargets(service) };
    case 'shareStart': case 'sharePart': case 'shareSend': {
      if (!connection?.shares) return unsupported();
      return { kind: 'read', value: await connection.shares.handle(connection.peer, request) };
    }
  }
}
