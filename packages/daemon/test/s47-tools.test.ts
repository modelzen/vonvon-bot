import { describe, expect, it, vi } from 'vitest';
import { FULL_ACCESS_WARNING } from '@vonvon/protocol';
import { createCommandTools } from '../src/agent/entry/command-tools';
import { createAgentEntries, type AgentPlace, type TurnFacts } from '../src/agent/entry/registry';
import type { AgentThread } from '../src/agent/types';
import { permissionTable } from '../src/agent/permission';
import type { HostSettings, ProjectSettingsView, SettingsSection, SettingsSave } from '../src/admin/settings-types';
import { feishuGroups, feishuMembers } from '../src/admin/structured-commands';
import type { Project } from '../src/project/registry';

const botId = 'cli_fixture';
const projectScope = { kind: 'project', botId, projectName: 'visible' } satisfies ProjectSettingsView['scope'];
const section = <T>(value: T): SettingsSection<T> => ({ stored: value, effective: value, revision: 'held', access: { kind: 'writable' }, apply: [] });
const permission = permissionTable('codex-appserver');
const sections: ProjectSettingsView['sections'] = {
  permission: section({ mode: 'qa', guestMode: 'qa', network: false, custom: null, options: { tiers: [...permission.tiers({ platform: 'darwin' })], strength: permission.strength({ platform: 'darwin' }), fields: permission.fields({ platform: 'darwin' }), expanded: { qa: permission.expand('qa'), write: permission.expand('write'), full: permission.expand('full') } } }), response: section({ noMention: false }),
  model: section({ selection: { kind: 'default' } }), run: section({ pendingPolicy: 'default' }), judge: section({ selection: { kind: 'default' } }),
};
const projects: Project[] = [
  { name: 'visible', chatId: 'visible-chat', cwd: '/fixture', blank: true, createdAt: 1 },
  { name: 'hidden', chatId: 'hidden-chat', cwd: '/fixture', blank: true, createdAt: 1 },
];
function fixture(options: { admin?: boolean; enabled?: boolean; place?: AgentPlace; facts?: Partial<TurnFacts> } = {}) {
  const flags = { admin: options.admin ?? true, enabled: options.enabled ?? true };
  const groups = vi.fn(async (_cursor?: string) => ({ groups: [
    { chatId: 'visible-chat', name: 'visible', bound: true },
    { chatId: 'hidden-chat', name: 'hidden', bound: true },
  ], nextCursor: 'next-page' }));
  const members = vi.fn(async (_chatId: string, _cursor?: string) => ({ members: [{ openId: 'synthetic-member', name: 'fixture' }], nextCursor: 'next-members' }));
  const read = vi.fn<HostSettings['read']>(async scope => {
    if (scope.kind !== 'project' || !projects.some(p => p.name === scope.projectName)) throw Error('missing');
    return { scope, sections, identity: { chatId: 'visible-chat', backend: 'codex-appserver', cwd: '/fixture', kind: 'multi' }, members: { openIds: ['secretSentinel'], revision: 'private' } } satisfies ProjectSettingsView;
  });
  const save = vi.fn<HostSettings['save']>(async () => ({ kind: 'rejected', fields: [{ field: 'fixture', message: 'not used' }] }));
  const settings: HostSettings = { read, save, act: async () => { throw Error('unused'); }, models: async () => { throw Error('unused'); } };
  const thread: AgentThread = { sessionId: 'synthetic', isAlive: () => true, close: async () => {},
    runStreamed: () => { throw Error('unused'); }, runGoal: () => { throw Error('unused'); },
    clearGoal: async () => {}, abort: async () => {}, steer: async () => {}, compact: async () => ({ compacted: false, usage: null }) };
  const tools = createCommandTools({ appId: botId, settings, projects: async () => projects, groups, members });
  const entries = createAgentEntries({ appId: botId, isAdmin: () => flags.admin, isOwner: () => false,
    chatSettingsOn: () => flags.enabled, tools });
  const entry = entries.issue(options.place ?? { kind: 'p2p' }); entry.attach(thread);
  const turn = entries.openTurn(thread, { requesterOpenId: 'synthetic', requesterKind: 'user', triggerMessageId: 'synthetic-message', retry: false, wake: false, initiative: false, ...options.facts });
  entry.noteToolUse('synthetic-use');
  return { flags, turn, groups, members, read, save, tools, listed: () => entry.tools().map(tool => tool.name),
    call: (name: string, args: unknown) => entry.call(name, args, { toolUseId: 'synthetic-use' }) };
}
const edit = { scope: projectScope, section: 'response', revision: 'held-revision', patch: { noMention: true } };
describe('s47 MCP authorization and structured commands', () => {
  it.each([
    [{ place: { kind: 'group', chatId: 'visible-chat' } }, 'not-dm'],
    [{ facts: { requesterKind: 'bot' } }, 'not-human-turn'],
    [{ facts: { retry: true } }, 'not-human-turn'],
    [{ facts: { initiative: true } }, 'not-human-turn'],
    [{ facts: { wake: true } }, 'not-human-turn'],
    [{ admin: false }, 'not-admin'],
    [{ enabled: false }, 'switch-off'],
  ] satisfies [Parameters<typeof fixture>[0], string][])('refuses settings writes under %j', async (options, reason) => {
    const f = fixture(options);
    expect(await f.call('settings_set', { edit })).toMatchObject({ ok: false, code: 'refused', reason });
    expect(f.save).not.toHaveBeenCalled();
  });
  it('uses strict tool input schemas and never accepts caller supplied authorization', async () => {
    const f = fixture();
    for (const args of [{ edit, admin: true }, { edit, commit: true }, { edit, notAfter: Date.now() + 1e6 }]) {
      expect(await f.call('settings_set', args)).toMatchObject({ ok: false, code: 'bad-args' });
    }
    expect(await f.call('feishu_members', { chatId: '' })).toMatchObject({ ok: false, code: 'bad-args' });
    expect(await f.call('feishu_groups', { cursor: 4 })).toMatchObject({ ok: false, code: 'bad-args' });
    expect(f.save).not.toHaveBeenCalled();
  });
  // settings-dm-only: settings are a private chat's, read and written; a group and a comment have none of the three.
  // s1b: a group's whitelist has its own members and not the bot's groups; a comment neither.
  it.each([
    [{ kind: 'group', chatId: 'visible-chat' }, ['session_info', 'feishu_members']],
    [{ kind: 'doc', docId: 'doc' }, ['session_info']],
    [{ kind: 'p2p' }, ['session_info', 'settings_get', 'settings_access', 'settings_set', 'feishu_groups', 'feishu_members']],
  ] satisfies [AgentPlace, string[]][])('lists the settings tools in a private chat only: %j', (place, names) => {
    expect(fixture({ place }).listed()).toEqual(names);
  });
  it.each([{ kind: 'group', chatId: 'visible-chat' }, { kind: 'doc', docId: 'doc' }] satisfies AgentPlace[])('has no settings read outside a private chat, an administrator\'s turn included: %j', async place => {
    const f = fixture({ admin: true, place });
    for (const name of ['settings_get', 'settings_access']) {
      expect(await f.call(name, { scope: projectScope })).toEqual({ ok: false, code: 'unknown-tool', message: '没有这个工具。' });
    }
    expect(f.read).not.toHaveBeenCalled();
  });
  it('allows a private chat\'s read with the settings switch off and removes private metadata', async () => {
    const f = fixture({ enabled: false });
    expect(await f.call('settings_get', { scope: projectScope })).toMatchObject({ ok: true, result: { view: { scope: projectScope, sections: Object.fromEntries(Object.keys(sections).map(name => [name, { access: { kind: 'readonly', reason: 'switch-off' } }])) } } });
    expect(JSON.stringify(await f.call('settings_get', { scope: projectScope }))).not.toContain('secretSentinel');
  });
  it('returns the same access result for absent, unauthorized, host and other-bot scopes', async () => {
    const f = fixture({ admin: false });
    const deniedScopes = [
      projectScope, { ...projectScope, projectName: 'missing' }, { ...projectScope, projectName: 'hidden' },
      { ...projectScope, botId: 'cli_other' }, { kind: 'host' }, { kind: 'agent', botId },
    ];
    const replies = [];
    for (const scope of deniedScopes) replies.push(await f.call('settings_access', { scope }));
    expect(replies).toEqual(deniedScopes.map(() => ({ ok: true, result: { access: 'unavailable' } })));
    expect(await f.call('settings_get', { scope: projectScope })).toMatchObject({ ok: false, code: 'refused', message: '目标不存在或没有权限。' });
    expect(f.read).not.toHaveBeenCalled();
  });
  it('never forwards a cross-bot settings write even from an administrator', async () => {
    const f = fixture();
    expect(await f.call('settings_set', { edit: { ...edit, scope: { ...projectScope, botId: 'cli_other' } } })).toMatchObject({ ok: false, code: 'refused' });
    expect(f.save).not.toHaveBeenCalled();
  });
  it('has no group list in a group or a comment, and refuses a private chat\'s nonadministrator without asking upstream', async () => {
    for (const place of [{ kind: 'group', chatId: 'visible-chat' }, { kind: 'doc', docId: 'doc' }] satisfies AgentPlace[]) {
      const f = fixture({ admin: true, place });
      expect(await f.call('feishu_groups', {})).toEqual({ ok: false, code: 'unknown-tool', message: '没有这个工具。' });
      expect(f.groups).not.toHaveBeenCalled();
    }
    const dm = fixture({ admin: false });
    expect(await dm.call('feishu_groups', {})).toMatchObject({ ok: false, code: 'refused' });
    expect(dm.groups).not.toHaveBeenCalled();
  });
  it('has no member query in a comment', async () => {
    const f = fixture({ admin: true, place: { kind: 'doc', docId: 'doc' } });
    expect(await f.call('feishu_members', { chatId: 'visible-chat' })).toEqual({ ok: false, code: 'unknown-tool', message: '没有这个工具。' });
    expect(f.members).not.toHaveBeenCalled();
  });
  it('preserves administrator list pagination and shares the direct business function result', async () => {
    const f = fixture();
    expect(await f.call('feishu_groups', { cursor: 'held-cursor' })).toEqual({ ok: true, result: await feishuGroups(f, 'held-cursor') });
    expect(f.groups).toHaveBeenCalledWith('held-cursor');
  });
  it('only forwards member queries for a visible and bound group', async () => {
    const f = fixture({ admin: false, place: { kind: 'group', chatId: 'visible-chat' } });
    expect(await f.call('feishu_members', { chatId: 'hidden-chat' })).toMatchObject({ ok: false, code: 'refused' });
    expect(await f.call('feishu_members', { chatId: 'missing-chat' })).toMatchObject({ ok: false, code: 'refused' });
    expect(f.members).not.toHaveBeenCalled();
    expect(await f.call('feishu_members', { chatId: 'visible-chat', cursor: 'members-cursor' })).toEqual({ ok: true, result: await feishuMembers(f, 'visible-chat', 'members-cursor') });
    expect(f.members).toHaveBeenCalledWith('visible-chat', 'members-cursor');
  });
  it('lets the owning-bot transport verify administrator queries for an unbound group', async () => {
    const f = fixture();
    expect(await f.call('feishu_members', { chatId: 'unbound' })).toMatchObject({ ok: true });
    expect(f.members).toHaveBeenCalledWith('unbound', undefined);
  });
  it('keeps an empty upstream page successful and does not disguise upstream failures as empty results', async () => {
    const f = fixture();
    f.groups.mockResolvedValueOnce({ groups: [], nextCursor: 'empty-page-next' });
    expect(await f.call('feishu_groups', {})).toEqual({ ok: true, result: { groups: [], nextCursor: 'empty-page-next' } });
    f.groups.mockRejectedValueOnce(Error('upstream unavailable'));
    expect(await f.call('feishu_groups', {})).toMatchObject({ ok: false, code: 'failed' });
    f.members.mockRejectedValueOnce(Error('upstream unavailable'));
    expect(await f.call('feishu_members', { chatId: 'visible-chat' })).toMatchObject({ ok: false, code: 'failed' });
  });
  it('does not expand group visibility when the triggering user is an administrator', async () => {
    const f = fixture({ admin: true, place: { kind: 'group', chatId: 'visible-chat' } });
    expect(await f.call('settings_get', { scope: { ...projectScope, projectName: 'hidden' } })).toMatchObject({ ok: false, code: 'unknown-tool' });
    expect(await f.call('feishu_groups', {})).toMatchObject({ ok: false, code: 'unknown-tool' });
    expect(await f.call('feishu_members', { chatId: 'hidden-chat' })).toMatchObject({ ok: false, code: 'refused' });
    expect(f.groups).not.toHaveBeenCalled(); expect(f.members).not.toHaveBeenCalled();
  });
  it('does not automatically retry a guarded write whose outcome is unknown', async () => {
    const f = fixture();
    f.save.mockImplementationOnce(async (_edit, options) => {
      options?.beforeCommit?.();
      throw Error('reply lost after commit');
    });
    expect(await f.call('settings_set', { edit })).toMatchObject({ ok: false, code: 'failed', message: expect.stringContaining('设置可能已经改了') });
    expect(f.save).toHaveBeenCalledTimes(1);
  });
  it('returns a guarded successful result and keeps its modification explanation', async () => {
    const f = fixture();
    const saved: SettingsSave = { kind: 'saved', section: { scope: projectScope, section: 'response', value: { stored: { noMention: true }, effective: { noMention: true }, revision: 'new-revision', access: { kind: 'writable' }, apply: [] } }, effects: [] };
    f.save.mockImplementationOnce(async (_edit, options) => {
      options?.beforeCommit?.();
      return saved;
    });
    expect(await f.call('settings_set', { edit, reason: 'owner request' })).toEqual({ ok: true, result: { ...saved, reason: 'owner request' } });
    expect(f.save).toHaveBeenCalledTimes(1);
  });
  // devices-ui-2 4.10: the 完全访问 warning reaches the bot, which repeats it to the user.
  it('passes the saved warnings on to the bot', async () => {
    const f = fixture();
    const saved: SettingsSave = { kind: 'saved', section: { scope: projectScope, section: 'permission', value: { stored: {}, effective: {}, revision: 'r2', access: { kind: 'writable' }, apply: [] } }, effects: [], warnings: [FULL_ACCESS_WARNING] } as unknown as SettingsSave;
    f.save.mockImplementationOnce(async (_edit, options) => { options?.beforeCommit?.(); return saved; });
    expect(await f.call('settings_set', { edit })).toMatchObject({ ok: true, result: { warnings: [FULL_ACCESS_WARNING] } });
  });

  it('conceals absent settings and forbidden targets with the same access result for a DM administrator', async () => {
    const f = fixture();
    const missing = await f.call('settings_access', { scope: { ...projectScope, projectName: 'missing' } });
    const forbidden = await f.call('settings_access', { scope: { ...projectScope, botId: 'cli_other' } });
    expect(missing).toEqual(forbidden);
    expect(missing).toEqual({ ok: true, result: { access: 'unavailable' } });
  });
  it.each(['revoke administrator', 'close turn'])('rechecks authorization after a delayed settings read: %s', async change => {
    const f = fixture(); let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const ordinaryRead = f.read.getMockImplementation();
    if (!ordinaryRead) throw Error('missing fixture read');
    f.read.mockImplementationOnce(async scope => { started(); await gate; return ordinaryRead(scope); });
    const pending = f.call('settings_get', { scope: projectScope }); await entered;
    if (change === 'close turn') f.turn.close(); else f.flags.admin = false;
    release();
    const result = await pending;
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('held');
  });
  it.each(['revoke administrator', 'close turn'])('rechecks authorization after a delayed upstream group list: %s', async change => {
    const f = fixture(); let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    f.groups.mockImplementationOnce(async () => { started(); await gate; return { groups: [{ chatId: 'hidden-chat', name: 'hidden', bound: true }], nextCursor: 'private-cursor' }; });
    const pending = f.call('feishu_groups', {}); await entered;
    if (change === 'close turn') f.turn.close(); else f.flags.admin = false;
    release();
    const result = await pending;
    expect(JSON.stringify(result)).not.toContain('hidden-chat');
    expect(JSON.stringify(result)).not.toContain('private-cursor');
  });

  it('reports read-only access after the chat-settings switch closes while keeping values readable', async () => {
    const f = fixture();
    expect(await f.call('settings_access', { scope: projectScope })).toMatchObject({ ok: true, result: { access: { response: { kind: 'writable' } } } });
    f.flags.enabled = false;
    expect(await f.call('settings_access', { scope: projectScope })).toMatchObject({ ok: true, result: { access: { response: { kind: 'readonly' } } } });
    expect(await f.call('settings_get', { scope: projectScope })).toMatchObject({ ok: true, result: { view: { sections: { response: { stored: { noMention: false }, access: { kind: 'readonly' } } } } } });
    expect(f.save).not.toHaveBeenCalled();
  });

});
