import { describe, expect, it, vi } from 'vitest';
import { createCommandTools } from '../src/agent/entry/command-tools';
import { createAgentEntries, type AgentPlace, type TurnFacts } from '../src/agent/entry/registry';
import type { AgentThread } from '../src/agent/types';
import { feishuGroups, feishuMembers } from '../src/admin/structured-commands';

const botId = 'cli_fixture';
function fixture(options: { admin?: boolean; place?: AgentPlace; facts?: Partial<TurnFacts> } = {}) {
  const flags = { admin: options.admin ?? true };
  const groups = vi.fn(async (_cursor?: string) => ({ groups: [
    { chatId: 'oc_visible', name: 'visible', bound: true },
    { chatId: 'oc_hidden', name: 'hidden', bound: true },
  ], nextCursor: 'next-page' }));
  const members = vi.fn(async (_chatId: string, _cursor?: string) => ({ members: [{ openId: 'synthetic-member', name: 'fixture' }], nextCursor: 'next-members' }));
  const thread: AgentThread = { sessionId: 'synthetic', isAlive: () => true, close: async () => {},
    runStreamed: () => { throw Error('unused'); }, runGoal: () => { throw Error('unused'); },
    clearGoal: async () => {}, abort: async () => {}, steer: async () => {}, compact: async () => ({ compacted: false, usage: null }) };
  const tools = createCommandTools({ appId: botId, groups, members });
  const entries = createAgentEntries({ appId: botId, isAdmin: () => flags.admin, tools });
  const entry = entries.issue(options.place ?? { kind: 'p2p' }); entry.attach(thread);
  const turn = entries.openTurn(thread, { requesterOpenId: 'synthetic', requesterKind: 'user', triggerMessageId: 'synthetic-message', retry: false, wake: false, initiative: false, ...options.facts });
  entry.noteToolUse('synthetic-use');
  return { flags, turn, groups, members, tools, listed: () => entry.tools().map(tool => tool.name),
    call: (name: string, args: unknown) => entry.call(name, args, { toolUseId: 'synthetic-use' }) };
}
describe('s47 MCP authorization and structured commands', () => {
  it('uses strict tool input schemas and never accepts caller supplied authorization', async () => {
    const f = fixture();
    for (const args of [{ admin: true }, { commit: true }, { notAfter: Date.now() + 1e6 }]) {
      expect(await f.call('feishu_groups', args)).toMatchObject({ ok: false, code: 'bad-args' });
    }
    expect(await f.call('feishu_members', { chat: '' })).toMatchObject({ ok: false, code: 'bad-args' });
    expect(await f.call('feishu_groups', { cursor: 4 })).toMatchObject({ ok: false, code: 'bad-args' });
  });
  // dm-agent 5: no settings tools anywhere, a private chat's Agent uses the vonvon command line.
  // s1b: a group's whitelist has its own members and not the bot's groups; a comment neither.
  it.each([
    [{ kind: 'group', chatId: 'oc_visible' }, ['session_info', 'feishu_members']],
    [{ kind: 'doc', docId: 'doc' }, ['session_info']],
    [{ kind: 'p2p' }, ['session_info', 'feishu_groups', 'feishu_members']],
  ] satisfies [AgentPlace, string[]][])('lists no settings tool, and the group list in a private chat only: %j', (place, names) => {
    expect(fixture({ place }).listed()).toEqual(names);
  });
  it('has no group list in a group or a comment, and refuses a private chat\'s nonadministrator without asking upstream', async () => {
    for (const place of [{ kind: 'group', chatId: 'oc_visible' }, { kind: 'doc', docId: 'doc' }] satisfies AgentPlace[]) {
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
    expect(await f.call('feishu_members', { chat: 'oc_visible' })).toEqual({ ok: false, code: 'unknown-tool', message: '没有这个工具。' });
    expect(f.members).not.toHaveBeenCalled();
  });
  it('preserves administrator list pagination and shares the direct business function result', async () => {
    const f = fixture();
    expect(await f.call('feishu_groups', { cursor: 'held-cursor' })).toEqual({ ok: true, result: await feishuGroups(f, 'held-cursor') });
    expect(f.groups).toHaveBeenCalledWith('held-cursor');
  });
  it('only forwards member queries for a visible and bound group', async () => {
    const f = fixture({ admin: false, place: { kind: 'group', chatId: 'oc_visible' } });
    expect(await f.call('feishu_members', { chat: 'oc_hidden' })).toMatchObject({ ok: false, code: 'refused' });
    expect(await f.call('feishu_members', { chat: 'oc_missing' })).toMatchObject({ ok: false, code: 'refused' });
    expect(f.members).not.toHaveBeenCalled();
    expect(await f.call('feishu_members', { chat: 'oc_visible', cursor: 'members-cursor' })).toEqual({ ok: true, result: await feishuMembers(f, 'oc_visible', 'members-cursor') });
    expect(f.members).toHaveBeenCalledWith('oc_visible', 'members-cursor');
  });
  it('lets the owning-bot transport verify administrator queries for an unbound group', async () => {
    const f = fixture();
    expect(await f.call('feishu_members', { chat: 'oc_unbound' })).toMatchObject({ ok: true });
    expect(f.members).toHaveBeenCalledWith('oc_unbound', undefined);
  });
  it('keeps an empty upstream page successful and does not disguise upstream failures as empty results', async () => {
    const f = fixture();
    f.groups.mockResolvedValueOnce({ groups: [], nextCursor: 'empty-page-next' });
    expect(await f.call('feishu_groups', {})).toEqual({ ok: true, result: { groups: [], nextCursor: 'empty-page-next' } });
    f.groups.mockRejectedValueOnce(Error('upstream unavailable'));
    expect(await f.call('feishu_groups', {})).toMatchObject({ ok: false, code: 'failed' });
    f.members.mockRejectedValueOnce(Error('upstream unavailable'));
    expect(await f.call('feishu_members', { chat: 'oc_visible' })).toMatchObject({ ok: false, code: 'failed' });
  });
  it('does not expand group visibility when the triggering user is an administrator', async () => {
    const f = fixture({ admin: true, place: { kind: 'group', chatId: 'oc_visible' } });
    expect(await f.call('feishu_groups', {})).toMatchObject({ ok: false, code: 'unknown-tool' });
    expect(await f.call('feishu_members', { chat: 'oc_hidden' })).toMatchObject({ ok: false, code: 'refused' });
    expect(f.groups).not.toHaveBeenCalled(); expect(f.members).not.toHaveBeenCalled();
  });
  it.each(['revoke administrator', 'close turn'])('rechecks authorization after a delayed upstream group list: %s', async change => {
    const f = fixture(); let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    f.groups.mockImplementationOnce(async () => { started(); await gate; return { groups: [{ chatId: 'oc_hidden', name: 'hidden', bound: true }], nextCursor: 'private-cursor' }; });
    const pending = f.call('feishu_groups', {}); await entered;
    if (change === 'close turn') f.turn.close(); else f.flags.admin = false;
    release();
    const result = await pending;
    expect(JSON.stringify(result)).not.toContain('oc_hidden');
    expect(JSON.stringify(result)).not.toContain('private-cursor');
  });
});
