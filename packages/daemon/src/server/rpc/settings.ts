import { settingsReplySchema, type SettingsRequest, type SettingsReply } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import { parseSettingsAction, parseSettingsEdit, parseSettingsScope, parseModelQuery } from '../../admin/settings-parse';
import type { RpcOutcome } from '../rpc';
import { unsupported } from '../errors';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function settingsRpc(service: AdminService, request: SettingsRequest): Promise<RpcOutcome<SettingsReply>> {
  if (request.type === 'sessions') return { kind: 'read', value: { kind: 'sessions', sessions: await service.listSessions(request.botId, request.projectName) } };
  if (request.type === 'chooseExecutable' || request.type === 'saveExecutable') return unsupported();
  const settings = service.settings;
  if (!settings) return unsupported();
  switch (request.type) {
    case 'read': return { kind: 'read', value: settingsReplySchema.parse({ kind: 'view', view: await settings.read(parseSettingsScope(request.scope)) }) };
    case 'models': return { kind: 'read', value: settingsReplySchema.parse({ kind: 'models', catalog: await settings.models(parseModelQuery(request.query)) }) };
    case 'save': {
      const patch = request.edit.patch;
      if (request.edit.scope.kind === 'host' && request.edit.section === 'execution' && typeof patch === 'object' && patch !== null && 'codexBin' in patch && patch.codexBin !== undefined && patch.codexBin !== null) {
        const path = patch.codexBin;
        let valid = typeof path === 'string' && isAbsolute(path) && !/[\r\n\0]/.test(path) && (process.platform !== 'win32' || /\.(?:exe|cmd)$/i.test(path));
        if (valid && typeof path === 'string') {
          try {
            const physical = await realpath(path);
            valid = (await stat(physical)).isFile() && (process.platform !== 'win32' || /\.(?:exe|cmd)$/i.test(physical));
            if (valid) await access(physical, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
          } catch { valid = false; }
        }
        if (!valid) return { kind: 'mutation', reply: () => settingsReplySchema.parse({ kind: 'saved', result: { kind: 'rejected', fields: [{ field: 'codexBin', message: '所选执行程序不存在或不可执行，请重新选择。' }] } }) };
      }
      const edit = parseSettingsEdit(request.edit);
      const result = await settings.save(edit);
      return { kind: 'mutation', reply: () => settingsReplySchema.parse({ kind: 'saved', result }) };
    }
    case 'act': {
      const result = await settings.act(parseSettingsAction(request.action));
      return { kind: 'mutation', reply: () => settingsReplySchema.parse({ kind: 'acted', result }) };
    }
  }
}
