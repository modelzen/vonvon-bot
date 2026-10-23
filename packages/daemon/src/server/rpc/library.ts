import { libraryReplySchema, type LibraryReply, type LibraryRequest } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import type { RpcOutcome } from '../rpc';
import { unsupported } from '../errors';

/** The project library over the wire: a list of projects with the groups using them, and the one workspace write (§2.5). */
export async function libraryRpc(service: AdminService, request: LibraryRequest): Promise<RpcOutcome<LibraryReply>> {
  const library = service.library;
  if (!library) return unsupported();
  switch (request.type) {
    case 'list': {
      const overview = await library.overview();
      return { kind: 'read', value: libraryReplySchema.parse({ kind: 'list', unlinked: overview.unlinked.length,
        projects: overview.projects.map(({ id, name, revision, workspace, bindings }) => ({ id, name, revision, workspace,
          bindings: bindings.map(binding => ({ agentId: binding.botId, groupId: binding.chatId, name: binding.name, enabled: binding.enabled })) })) }) };
    }
    case 'workspace': {
      const { workspace } = request;
      const change = await library.workspace({ projectId: request.projectId, revision: request.revision,
        workspace: { primary: workspace.primary, additional: workspace.additional, ...(workspace.repositories ? { repositories: workspace.repositories } : {}) } });
      const { id, name, revision } = change.project;
      return { kind: 'mutation', reply: () => libraryReplySchema.parse({ kind: 'workspace', changed: change.changed,
        project: { id, name, revision, workspace: change.project.workspace },
        rebound: change.rebound.map(item => ({ agentId: item.botId, ...(item.chatId ? { groupId: item.chatId } : {}), state: item.state, ...(item.error ? { message: item.error } : {}) })) }) };
    }
  }
}
