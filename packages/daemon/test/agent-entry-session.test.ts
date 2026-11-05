import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentThread } from '../src/agent/types';
import { createAgentEntries, NOT_DM_MESSAGE, SESSION_TURN_ENDED, type AgentPlace, type TurnFacts } from '../src/agent/entry/registry';
import { decisionMessages, type MemoryPlace } from '../src/bot/memory-authority';
import { scheduleRefusalMessages } from '../src/admin/schedule-commands';

vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));

/**
 * devices-4b 4.2: a Bot session's command line, judged by its Bot process for the session's current turn with the
 * tools' own checks (authorizeNow, authorizeMemory, authorizeSchedule, `ctx.admin`), not a second copy of them.
 */
const OWNER = 'ou_owner';
const ADMIN = 'ou_admin';
const MEMBER = 'ou_member';
function thread(alive = true): AgentThread {
  return {
    sessionId: 'fixture', isAlive: vi.fn(() => alive), close: vi.fn(async () => {}),
    runStreamed: () => { throw Error('unused'); }, runGoal: () => { throw Error('unused'); },
    clearGoal: async () => {}, steer: async () => {}, abort: async () => {},
    compact: async () => ({ compacted: false, usage: null }),
  };
}
const said = (openId: string, text = '记住 先写结论'): TurnFacts => ({
  requesterOpenId: openId, requesterKind: 'user', triggerMessageId: 'om_1', retry: false, initiative: false, wake: false, typed: true, triggerText: text, requesterName: '某人',
});
function setup(place: AgentPlace, facts: TurnFacts | null = said(OWNER), options: { switchOn?: boolean; memoryPlace?: MemoryPlace } = {}) {
  const sessions = { revoke: vi.fn() };
  const memoryPlace = vi.fn(async () => options.memoryPlace ?? { chatProjectId: 'prj_0000000a', botProjectIds: ['prj_0000000a', 'prj_0000000b'] });
  const entries = createAgentEntries({
    appId: 'cli_x', isAdmin: id => id === OWNER || id === ADMIN, chatSettingsOn: () => options.switchOn ?? true, sessions, memoryPlace,
  });
  const entry = entries.issue(place);
  const t = thread();
  entry.attach(t);
  const scope = facts ? entries.openTurn(t, facts) : undefined;
  return { entries, entry, t, scope, sessions, memoryPlace, ask: (action: Parameters<typeof entries.authorizeSessionCall>[1]) => entries.authorizeSessionCall(entry.sessionId, action) };
}
const dm: AgentPlace = { kind: 'p2p', chatId: 'oc_dm' };
const group: AgentPlace = { kind: 'group', chatId: 'oc_y' };
const ended = { ok: false, reason: 'turn-ended', message: SESSION_TURN_ENDED };
afterEach(() => { vi.clearAllMocks(); });

describe('settings writes and the administrators', () => {
  it('lets an admin\'s private-chat turn write settings, not a member\'s, and not with the switch off', async () => {
    expect(await setup(dm, said(OWNER)).ask({ kind: 'settingsWrite' })).toEqual({ ok: true, role: 'admin', openId: OWNER });
    expect(await setup(dm, said(ADMIN)).ask({ kind: 'settingsWrite' })).toEqual({ ok: true, role: 'admin', openId: ADMIN });
    expect(await setup(dm, said(MEMBER)).ask({ kind: 'settingsWrite' })).toEqual({ ok: false, reason: 'not-admin', message: '只有管理员发消息触发的那一轮能改设置。' });
    expect(await setup(dm, said(OWNER), { switchOn: false }).ask({ kind: 'settingsWrite' }))
      .toEqual({ ok: false, reason: 'switch-off', message: '主人关了私聊里的“聊天改设置”，要改请去桌面端或网页。' });
    expect(await setup(group, said(OWNER)).ask({ kind: 'settingsWrite' })).toEqual({ ok: false, reason: 'not-dm', message: NOT_DM_MESSAGE });
    expect(await setup(dm, { ...said(OWNER), requesterKind: 'bot', wake: true }).ask({ kind: 'settingsWrite' })).toMatchObject({ ok: false, reason: 'not-human-turn' });
  });

  // devices-4b 4.5a: a private chat's read-only queries are the owner's or an admin's, as ctx.admin is for the tools
  it('lets a private chat read the bot\'s settings and groups on an admin\'s turn only, the switch not looked at', async () => {
    expect(await setup(dm, said(MEMBER)).ask({ kind: 'adminRead' })).toMatchObject({ ok: false, reason: 'not-admin' });
    expect(await setup(dm, said(ADMIN), { switchOn: false }).ask({ kind: 'adminRead' })).toEqual({ ok: true, role: 'admin', openId: ADMIN });
    expect(await setup(group, said(OWNER)).ask({ kind: 'adminRead' })).toMatchObject({ ok: false, reason: 'not-dm' });
  });
});

describe('a turn that is over', () => {
  it('reads the same for a closed turn, a later call, a session never issued and one whose thread is dead', async () => {
    const f = setup(dm, said(OWNER));
    f.scope!.close();
    for (const action of [{ kind: 'settingsWrite' }, { kind: 'adminRead' }] as const) expect(await f.ask(action)).toEqual(ended);
    expect(await setup(dm, null).ask({ kind: 'settingsWrite' })).toEqual(ended);
    expect(await f.entries.authorizeSessionCall('ses_0000000000000000', { kind: 'settingsWrite' })).toEqual(ended);
    const g = setup(group, said(MEMBER));
    vi.mocked(g.t.isAlive).mockReturnValue(false);
    expect(await g.ask({ kind: 'schedule', action: 'list' })).toEqual(ended);
    expect(g.sessions.revoke).toHaveBeenCalledExactlyOnceWith(g.entry.sessionId);
    // the grant is gone: asked again, the same, and nothing more is revoked
    expect(await g.ask({ kind: 'memory', op: 'read', target: { kind: 'project', projectId: 'prj_0000000a' } })).toEqual(ended);
    expect(g.sessions.revoke).toHaveBeenCalledTimes(1);
  });

  it('judges a call by the session\'s current turn: a later turn of a member is a member\'s', async () => {
    const f = setup(dm, said(OWNER));
    f.entries.openTurn(f.t, said(MEMBER));
    expect(await f.ask({ kind: 'settingsWrite' })).toMatchObject({ ok: false, reason: 'not-admin' });
  });
});

describe('scheduled tasks', () => {
  it('gives a group member\'s turn the session actor, as the tools give the chat actor, without the message text', async () => {
    const f = setup(group, said(MEMBER, '每天九点发日报'));
    expect(await f.ask({ kind: 'schedule', action: 'create' })).toEqual({ ok: true, role: 'member', openId: MEMBER,
      actor: { kind: 'session', openId: MEMBER, role: 'member', chatId: 'oc_y', name: '某人', messageId: 'om_1' } });
    expect(await setup(group, said(OWNER)).ask({ kind: 'schedule', action: 'list' })).toMatchObject({ ok: true, actor: { kind: 'session', role: 'admin' } });
  });

  it('refuses outside a group, and keeps a task\'s own run to itself', async () => {
    expect(await setup(dm, said(OWNER)).ask({ kind: 'schedule', action: 'list' })).toEqual({ ok: false, reason: 'not-group', message: scheduleRefusalMessages['not-group'] });
    const run: TurnFacts = { retry: false, initiative: false, wake: false, scheduled: { taskId: 'st_1', runId: 'run_1' } };
    expect(await setup(group, run).ask({ kind: 'schedule', action: 'create' })).toMatchObject({ ok: false, reason: 'no-human-create' });
    expect(await setup(group, run).ask({ kind: 'schedule', action: 'edit', taskId: 'st_2' })).toMatchObject({ ok: false, reason: 'scheduled-run-scope' });
    expect(await setup(group, run).ask({ kind: 'schedule', action: 'edit', taskId: 'st_1' }))
      .toMatchObject({ ok: true, role: 'bot', actor: { kind: 'scheduled', taskId: 'st_1', runId: 'run_1', chatId: 'oc_y' } });
    expect(await setup(group, { ...said(MEMBER), requesterKind: 'bot', wake: true }).ask({ kind: 'schedule', action: 'create' })).toMatchObject({ ok: false, reason: 'not-human-turn' });
  });
});

describe('memory: where a command-line write lands, by the tools\' rules', () => {
  // devices-4b acceptance: main 必败 (D4a refused --bot outright; the tools land a member's in the project)
  it('lands a member\'s --bot in its group\'s project, untrusted, and an admin\'s typed words in the bot\'s', async () => {
    const member = setup(group, said(MEMBER, '记住 周四发版'));
    expect(await member.ask({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: ' 周四发版 ' })).toEqual({ ok: true, role: 'member', openId: MEMBER, memory: {
      scope: { kind: 'project', projectId: 'prj_0000000a' }, trust: 'untrusted', actor: { role: 'member', openId: MEMBER },
      source: { botId: 'cli_x', turn: { kind: 'human', steered: false }, chatId: 'oc_y', messageId: 'om_1', downgraded: 'member' },
    } });
    expect(member.memoryPlace).toHaveBeenCalledWith({ place: 'group', chatId: 'oc_y' });
    const admin = setup(group, said(ADMIN, '记住 先写结论'));
    expect(await admin.ask({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: '先写结论' }))
      .toMatchObject({ ok: true, memory: { scope: { kind: 'bot' }, trust: 'trusted', actor: { role: 'admin', openId: ADMIN } } });
    // one bot-memory write a turn, as the tools: the second lands in the project
    expect(await admin.ask({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: '先写结论' }))
      .toMatchObject({ ok: true, memory: { scope: { kind: 'project' }, source: { downgraded: 'quota' } } });
    // words not in the message do not reach the bot's memory
    expect(await setup(group, said(ADMIN, '你好')).ask({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: '先写结论' }))
      .toMatchObject({ ok: true, memory: { scope: { kind: 'project' }, source: { downgraded: 'not-in-message' } } });
  });

  it('gives a bot\'s turn the bot role, and a group with no project the tools\' sentence', async () => {
    const bot = setup(group, { ...said(MEMBER), requesterKind: 'bot', requesterOpenId: 'ou_bot' });
    expect(await bot.ask({ kind: 'memory', op: 'read', target: { kind: 'project', projectId: 'prj_0000000a' } })).toEqual({ ok: true, role: 'bot', openId: 'ou_bot' });
    expect(await setup(group, said(MEMBER), { memoryPlace: {} }).ask({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: 'x' }))
      .toEqual({ ok: false, reason: 'no-project', message: decisionMessages['no-project'] });
    expect(await setup(group, said(MEMBER)).ask({ kind: 'memory', op: 'add', target: { kind: 'project', projectId: 'prj_0000000b' }, text: 'x' }))
      .toEqual({ ok: false, reason: 'not-allowed-here', message: decisionMessages['not-allowed-here'] });
  });

  it('keeps a private chat\'s memory to the turn\'s own person', async () => {
    const f = setup(dm, said(MEMBER));
    expect(await f.ask({ kind: 'memory', op: 'read', target: { kind: 'dm', openId: MEMBER } })).toEqual({ ok: true, role: 'member', openId: MEMBER });
    for (const action of [
      { kind: 'memory', op: 'read', target: { kind: 'dm', openId: OWNER } },
      { kind: 'memory', op: 'add', target: { kind: 'dm', openId: OWNER }, text: 'x' },
      { kind: 'memory', op: 'edit', item: { scope: { kind: 'dm', openId: OWNER }, source: { via: 'tool', botId: 'cli_x', actorRole: 'owner' } } },
    ] as const) expect(await f.ask(action)).toEqual({ ok: false, reason: 'out-of-scope', message: decisionMessages['out-of-scope'] });
    expect(await f.ask({ kind: 'memory', op: 'add', target: { kind: 'dm', openId: MEMBER }, text: '我喜欢短回复' }))
      .toMatchObject({ ok: true, memory: { scope: { kind: 'dm', openId: MEMBER }, actor: { role: 'member', openId: MEMBER } } });
  });

  it('lets a member change only its own project item, and no bot item', async () => {
    const f = setup(group, said(MEMBER));
    const project = (actorOpenId: string) => ({ scope: { kind: 'project' as const, projectId: 'prj_0000000a' }, source: { via: 'tool' as const, botId: 'cli_x', actorRole: 'member' as const, actorOpenId } });
    expect(await f.ask({ kind: 'memory', op: 'edit', item: project('ou_other') })).toEqual({ ok: false, reason: 'not-yours', message: decisionMessages['not-yours'] });
    expect(await f.ask({ kind: 'memory', op: 'edit', item: project(MEMBER), text: '周五' }))
      .toMatchObject({ ok: true, memory: { scope: { kind: 'project', projectId: 'prj_0000000a' }, actor: { role: 'member', openId: MEMBER } } });
    const botItem = { scope: { kind: 'bot' as const }, source: { via: 'tool' as const, botId: 'cli_x', actorRole: 'owner' as const } };
    expect(await f.ask({ kind: 'memory', op: 'edit', item: botItem })).toEqual({ ok: false, reason: 'out-of-scope', message: decisionMessages['out-of-scope'] });
    expect(await setup(group, said(OWNER)).ask({ kind: 'memory', op: 'edit', item: botItem })).toMatchObject({ ok: true, memory: { scope: { kind: 'bot' } } });
  });

  it('gives a comment session nothing', async () => {
    expect(await setup({ kind: 'doc', docId: 'd1' }, said(OWNER)).ask({ kind: 'memory', op: 'read', target: { kind: 'bot' } })).toMatchObject({ ok: false, reason: 'unknown-tool' });
  });

  it('reads the turn after the memory place is known: a turn that ended meanwhile is refused', async () => {
    const f = setup(group, said(ADMIN, '记住 先写结论'));
    let release!: (place: MemoryPlace) => void;
    f.memoryPlace.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.ask({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: '先写结论' });
    f.scope!.close();
    release({ chatProjectId: 'prj_0000000a' });
    expect(await pending).toEqual(ended);
  });
});
