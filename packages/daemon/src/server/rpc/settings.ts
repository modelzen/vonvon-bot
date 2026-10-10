import { settingsReplySchema, type SettingsRequest, type SettingsReply } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import { parseSettingsAction, parseSettingsEdit, parseSettingsScope, parseModelQuery } from '../../admin/settings-parse';
import type { RpcOutcome } from '../rpc';
import { unsupported } from '../errors';

export async function settingsRpc(service: AdminService, request: SettingsRequest): Promise<RpcOutcome<SettingsReply>> {
  if (request.type === 'sessions') return { kind: 'read', value: { kind: 'sessions', sessions: await service.listSessions(request.botId, request.projectName) } };
  if (request.type === 'chooseExecutable' || request.type === 'saveExecutable') return unsupported();
  const settings = service.settings;
  if (!settings) return unsupported();
  switch (request.type) {
    case 'read': return { kind: 'read', value: settingsReplySchema.parse({ kind: 'view', view: await settings.read(parseSettingsScope(request.scope)) }) };
    case 'models': return { kind: 'read', value: settingsReplySchema.parse({ kind: 'models', catalog: await settings.models(parseModelQuery(request.query)) }) };
    case 'save': {
      const result = await settings.save(parseSettingsEdit(request.edit));
      return { kind: 'mutation', reply: () => settingsReplySchema.parse({ kind: 'saved', result }) };
    }
    case 'act': {
      const result = await settings.act(parseSettingsAction(request.action));
      return { kind: 'mutation', reply: () => settingsReplySchema.parse({ kind: 'acted', result }) };
    }
  }
}
