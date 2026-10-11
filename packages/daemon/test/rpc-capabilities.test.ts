import { AdminWriteError } from '../src/admin/ops';
import { homedir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { agentIdSchema, groupIdSchema } from '@vonvon/protocol';
import type { AdminBot, AdminProject } from '../src/admin/service';
import { fakeService, socketClient, startFixture } from './server-fixture';

const bot: AdminBot = { appId: 'cli_a', name: 'Bot', tenant: 'feishu', active: true, current: true, running: true, completionReminder: { mode: 'failures', longTaskMinutes: 3 } };
const project: AdminProject = { name: 'Project', chatId: 'oc_chat', cwd: '/tmp', blank: false, kind: 'multi', origin: 'joined', noMention: false, autoCompact: true, mode: 'qa', guestMode: 'qa', network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1 };
const agentId = agentIdSchema.parse(bot.appId);
const groupId = groupIdSchema.parse(project.chatId);

describe('desktop companion RPC capabilities', () => {
  it('forwards joined-group cursor, pending events and a canonical directory binding to the selected Bot', async () => {
    const joinedGroups = vi.fn(async () => ({ groups: [{ chatId: 'oc_chat', name: 'local', bound: false }], nextCursor: 'next' }));
    const pendingGroups = vi.fn(async () => ({ groups: [{ chatId: 'oc_pending', name: 'Pending', addedAt: 1 }] }));
    const bindGroup = vi.fn(async () => project);
    const fixture = await startFixture(fakeService({ listBots: async () => [bot], joinedGroups, pendingGroups, bindGroup }));
    try {
      const client = await socketClient(fixture.api.port, fixture.credential); await client.ready();
      expect(await client.call({ type: 'request', id: 'joined', method: 'command', payload: { type: 'listJoinedGroups', agentId, cursor: 'opaque' } })).toMatchObject({ type: 'response', payload: { kind: 'groups', nextCursor: 'next', groups: [{ id: 'oc_chat' }] } });
      expect(joinedGroups).toHaveBeenCalledWith(bot.appId, 'opaque');
      expect(await client.call({ type: 'request', id: 'pending', method: 'command', payload: { type: 'listPendingGroups', agentId } })).toMatchObject({ type: 'response', payload: { kind: 'pendingGroups', groups: [{ chatId: 'oc_pending' }] } });
      expect(pendingGroups).toHaveBeenCalledWith(bot.appId);
      const chosen = await client.call({ type: 'request', id: 'folder', method: 'directory', payload: { type: 'choose', path: homedir() } });
      if (chosen.type !== 'response' || chosen.method !== 'directory' || chosen.payload.kind !== 'folderChosen') throw new Error('folder token missing');
      expect(await client.call({ type: 'request', id: 'bind', method: 'command', payload: { type: 'bindGroup', agentId, groupId, projectName: project.name, folderToken: chosen.payload.folder.token, tool: 'codex', conversation: 'threads' } })).toMatchObject({ type: 'response', payload: { kind: 'applied' } });
      expect(bindGroup).toHaveBeenCalledWith(bot.appId, { chatId: project.chatId, projectName: project.name, directory: homedir(), backend: 'codex-appserver', kind: 'multi' });
      await client.close();
    } finally { await fixture.close(); }
  });

  it('routes collaboration through the selected Bot owner and preserves the service conflict error', async () => {
    const collaboration = vi.fn(async () => { throw new AdminWriteError('session is busy'); });
    const fixture = await startFixture(fakeService({ listBots: async () => [bot], collaboration }));
    try {
      const client = await socketClient(fixture.api.port, fixture.credential); await client.ready();
      const result = await client.call({ type: 'request', id: 'collab', method: 'collaboration', payload: { action: 'compact', agentId, groupId, projectName: project.name, threadId: 'omt_topic' } });
      expect(result).toMatchObject({ type: 'error', code: 'conflict', message: 'session is busy' });
      expect(collaboration).toHaveBeenCalledWith(bot.appId, { action: 'compact', chatId: project.chatId, projectName: project.name, threadId: 'omt_topic' });
      await client.close();
    } finally { await fixture.close(); }
  });
});
