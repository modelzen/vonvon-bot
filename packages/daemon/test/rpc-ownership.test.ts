import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { requestSchema } from '@vonvon/protocol';
import type { AdminBot, AdminProject } from '../src/admin/service';
import { AdminWriteError } from '../src/admin/ops';
import { NotWiredYetError } from '../src/admin/service';
import { GroupUpstreamError, InvalidGroupInput } from '../src/admin/groups';
import { SettingsInputError } from '../src/admin/settings-parse';
import { CodexSetupConflict } from '../src/agent/codex-appserver/setup';
import { getRpcErrorCode, RpcError } from '../src/server/errors';
import { createSettingsOwner } from '../src/admin/settings';
import { fakeService, socketClient, startFixture } from './server-fixture';

const bot: AdminBot = { name: 'Owner', appId: 'cli_owner', tenant: 'feishu', active: true, current: false, running: true, completionReminder: { mode: 'failures', longTaskMinutes: 3 } };
const project: AdminProject = { name: 'Project', chatId: 'oc_group', cwd: '/', blank: false, kind: 'multi', origin: 'joined', noMention: false, mode: 'qa', guestMode: 'qa', network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1 };

function requests(agentId: string, folderToken = '00000000-0000-4000-8000-000000000000') {
  return [
    { method: 'command', payload: { type: 'listPendingGroups', agentId } },
    { method: 'command', payload: { type: 'listJoinedGroups', agentId, cursor: 'opaque' } },
    { method: 'command', payload: { type: 'bindGroup', agentId, groupId: 'oc_group', projectName: 'Project', folder: { kind: 'existing', folderToken }, tool: 'codex', conversation: 'threads' } },
    { method: 'collaboration', payload: { action: 'compact', agentId, groupId: 'oc_group', projectName: 'Project', threadId: 'omt_thread' } },
    { method: 'collaboration', payload: { action: 'createProject', agentId, name: 'Project', folder: { kind: 'existing', folderToken }, tool: 'codex', conversation: 'threads' } },
  ];
}

describe('RPC owner admission', () => {
  it('binds a default workspace without a folder token and rejects a stopped owner', async () => {
    let active = true;
    const bindGroup = vi.fn(async () => project);
    const fixture = await startFixture(fakeService({ listBots: async () => [{ ...bot, active }], bindGroup }));
    try {
      const client = await socketClient(fixture.api.port, fixture.credential); await client.ready();
      const request = requestSchema.parse({ type: 'request', id: 'default', method: 'command', payload: { type: 'bindGroup', agentId: bot.appId, groupId: 'oc_group', projectName: 'Project', folder: { kind: 'default' }, tool: 'codex', conversation: 'threads' } });
      expect(await client.call(request)).toMatchObject({ type: 'response' });
      expect(bindGroup).toHaveBeenCalledExactlyOnceWith(bot.appId, { chatId: 'oc_group', projectName: 'Project', directory: undefined, backend: 'codex-appserver', kind: 'multi' });
      active = false;
      expect(await client.call({ ...request, id: 'stopped-default' })).toMatchObject({ type: 'error', code: 'conflict' });
      expect(bindGroup).toHaveBeenCalledTimes(1);
      await client.close();
    } finally { await fixture.close(); }
  });

  it.each([
    { name: 'missing', target: undefined },
    { name: 'inactive', target: { ...bot, active: false } },
    { name: 'stopped', target: { ...bot, running: false } },
  ])('rejects $name target before group or collaboration work', async ({ target }) => {
    const pendingGroups = vi.fn(async () => ({ groups: [] }));
    const joinedGroups = vi.fn(async () => ({ groups: [] }));
    const bindGroup = vi.fn(async () => project);
    const collaboration = vi.fn(async () => ({ ok: true }));
    const fixture = await startFixture(fakeService({ listBots: async () => [{ ...bot, appId: 'cli_other', current: true }, ...(target ? [target] : [])], pendingGroups, joinedGroups, bindGroup, collaboration }));
    try {
      const client = await socketClient(fixture.api.port, fixture.credential); await client.ready();
      for (const [index, operation] of requests(bot.appId).entries()) {
        expect(await client.call(requestSchema.parse({ type: 'request', id: `denied-${index}`, ...operation }))).toMatchObject({ type: 'error', code: 'conflict' });
      }
      expect(pendingGroups).not.toHaveBeenCalled(); expect(joinedGroups).not.toHaveBeenCalled(); expect(bindGroup).not.toHaveBeenCalled(); expect(collaboration).not.toHaveBeenCalled();
      expect(await client.call({ type: 'request', id: 'still-open', method: 'snapshot', payload: { type: 'get' } })).toMatchObject({ type: 'response' });
      await client.close();
    } finally { await fixture.close(); }
  });

  it('uses the explicit active owner and rechecks live state after the snapshot', async () => {
    let active = true;
    const pendingGroups = vi.fn(async () => ({ groups: [{ chatId: 'oc_pending', name: 'Pending', addedAt: 1 }] }));
    const joinedGroups = vi.fn(async () => ({ groups: [{ chatId: 'oc_group', name: 'Group', bound: false }], nextCursor: 'next' }));
    const bindGroup = vi.fn(async () => project);
    const collaboration = vi.fn(async () => ({ ok: true }));
    const fixture = await startFixture(fakeService({ listBots: async () => [{ ...bot, appId: 'cli_other', current: true }, { ...bot, active }], pendingGroups, joinedGroups, bindGroup, collaboration }));
    try {
      const client = await socketClient(fixture.api.port, fixture.credential); await client.ready();
      const chosen = await client.call({ type: 'request', id: 'choose', method: 'directory', payload: { type: 'choose', path: homedir() } });
      if (chosen.type !== 'response' || chosen.method !== 'directory' || chosen.payload.kind !== 'folderChosen') throw new Error('folder missing');
      const operations = requests(bot.appId, chosen.payload.folder.token);
      for (const [index, operation] of operations.entries()) {
        const result = await client.call(requestSchema.parse({ type: 'request', id: `allowed-${index}`, ...operation }));
        expect(result).toMatchObject({ type: 'response' });
        if (index === 0) expect(result).toMatchObject({ payload: { kind: 'pendingGroups', groups: [{ chatId: 'oc_pending' }] } });
        if (index === 1) expect(result).toMatchObject({ payload: { kind: 'groups', groups: [{ id: 'oc_group' }], nextCursor: 'next' } });
      }
      expect(pendingGroups).toHaveBeenCalledWith(bot.appId);
      expect(joinedGroups).toHaveBeenCalledWith(bot.appId, 'opaque');
      expect(bindGroup).toHaveBeenCalledWith(bot.appId, { chatId: 'oc_group', projectName: 'Project', directory: await realpath(homedir()), backend: 'codex-appserver', kind: 'multi' });
      expect(collaboration).toHaveBeenNthCalledWith(1, bot.appId, { action: 'compact', chatId: 'oc_group', projectName: 'Project', threadId: 'omt_thread' });
      expect(collaboration).toHaveBeenNthCalledWith(2, bot.appId, expect.objectContaining({ action: 'createProject', name: 'Project', directory: await realpath(homedir()), kind: 'multi', backend: 'codex-appserver' }));
      active = false;
      for (const [index, operation] of operations.entries()) {
        expect(await client.call(requestSchema.parse({ type: 'request', id: `after-stop-${index}`, ...operation }))).toMatchObject({ type: 'error', code: 'conflict' });
      }
      expect(pendingGroups).toHaveBeenCalledTimes(1); expect(joinedGroups).toHaveBeenCalledTimes(1); expect(bindGroup).toHaveBeenCalledTimes(1); expect(collaboration).toHaveBeenCalledTimes(2);
      await client.close();
    } finally { await fixture.close(); }
  });

  it('rejects forged actor fields and keeps the real settings owner check', async () => {
    const writePreferences = vi.fn(async () => ({}));
    const collaboration = vi.fn(async () => ({ ok: true }));
    const owner = createSettingsOwner({ cfg: { accounts: { app: { id: bot.appId, tenant: 'feishu', secret: 'fixture' } } }, writePreferences, backendFor: () => { throw new Error('unexpected backend access'); }, evictLiveSessionsForChat: async () => {} });
    const act = vi.fn(owner.act);
    const fixture = await startFixture(fakeService({ listBots: async () => [bot], collaboration, settings: { ...owner, act } }));
    try {
      const client = await socketClient(fixture.api.port, fixture.credential); await client.ready();
      const action = { kind: 'adminMember', botId: 'cli_other', openId: 'ou_member', membership: 'present', revision: 'old' };
      const forged = [
        { method: 'collaboration', payload: { action: 'compact', agentId: bot.appId, groupId: 'oc_group', projectName: 'Project', threadId: 'omt_thread', actor: 'ou_forged' } },
        { method: 'settings', payload: { type: 'act', agentId: bot.appId, action } },
      ];
      for (const [index, operation] of forged.entries()) {
        const id = `forged-${index}`;
        client.socket.send(JSON.stringify({ type: 'request', id, ...operation }));
        expect(await client.wait(frame => frame.type === 'error' && frame.id === id)).toMatchObject({ code: 'invalid_request' });
      }
      expect(act).not.toHaveBeenCalled(); expect(collaboration).not.toHaveBeenCalled();
      expect(await client.call(requestSchema.parse({ type: 'request', id: 'wrong-owner', method: 'settings', payload: { type: 'act', action } }))).toMatchObject({ type: 'error', code: 'invalid_request', message: '设置不属于这个 Bot' });
      expect(writePreferences).not.toHaveBeenCalled();
      await client.close();
    } finally { await fixture.close(); }
  });
});

it.each([
  [new RpcError('outside_home', 'outside'), 'outside_home'],
  [new AdminWriteError('busy'), 'conflict'],
  [new CodexSetupConflict('busy'), 'conflict'],
  [new GroupUpstreamError('scope denied'), 'upstream'],
  [new InvalidGroupInput('bad group'), 'invalid_request'],
  [new SettingsInputError('wrong owner'), 'invalid_request'],
  [new URIError('bad URI'), 'invalid_request'],
  [new NotWiredYetError('group'), 'unsupported'],
  [new Error('corrupt pending file'), 'operation_failed'],
])('preserves the semantic RPC code for %s', (error, expected) => {
  expect(getRpcErrorCode(error)).toBe(expected);
});
