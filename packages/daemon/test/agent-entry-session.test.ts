import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentThread } from '../src/agent/types';
import { createAgentEntries, NOT_DM_MESSAGE, SESSION_TURN_ENDED, type AgentPlace, type TurnFacts } from '../src/agent/entry/registry';
import { decisionMessages, type MemoryPlace } from '../src/bot/memory-authority';
import { scheduleRefusalMessages } from '../src/admin/schedule-commands';
import { sessionAuthzSchema } from '../src/admin/ipc';

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
function setup(place: AgentPlace, facts: TurnFacts | null = said(OWNER), options: { memoryPlace?: MemoryPlace } = {}) {
  const sessions = { revoke: vi.fn() };
  const memoryPlace = vi.fn(async () => options.memoryPlace ?? { chatProjectId: 'prj_0000000a', botProjectIds: ['prj_0000000a', 'prj_0000000b'] });
  const entries = createAgentEntries({
    appId: 'cli_x', isAdmin: id => id === OWNER || id === ADMIN, sessions, memoryPlace,
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
  it('lets an admin\'s private-chat turn write settings, not a member\'s', async () => {
    expect(await setup(dm, said(OWNER)).ask({ kind: 'settingsWrite' })).toEqual({ ok: true, role: 'admin', openId: OWNER, name: '某人' });
    expect(await setup(dm, said(ADMIN)).ask({ kind: 'settingsWrite' })).toEqual({ ok: true, role: 'admin', openId: ADMIN, name: '某人' });
    expect(await setup(dm, said(MEMBER)).ask({ kind: 'settingsWrite' })).toEqual({ ok: false, reason: 'not-admin', message: '只有管理员发消息触发的那一轮，或者管理员建的私聊定时任务，能改设置。' });
    expect(await setup(group, said(OWNER)).ask({ kind: 'settingsWrite' })).toEqual({ ok: false, reason: 'not-dm', message: NOT_DM_MESSAGE });
    expect(await setup(dm, { ...said(OWNER), requesterKind: 'bot', wake: true }).ask({ kind: 'settingsWrite' })).toMatchObject({ ok: false, reason: 'not-human-turn' });
  });

  // devices-4b 4.5a: a private chat's read-only queries are the owner's or an admin's, as ctx.admin is for the tools
  it('lets a private chat read the bot\'s settings and groups on an admin\'s turn only', async () => {
    expect(await setup(dm, said(MEMBER)).ask({ kind: 'adminRead' })).toMatchObject({ ok: false, reason: 'not-admin' });
    expect(await setup(dm, said(ADMIN)).ask({ kind: 'adminRead' })).toEqual({ ok: true, role: 'admin', openId: ADMIN, name: '某人' });
    expect(await setup(group, said(OWNER)).ask({ kind: 'adminRead' })).toMatchObject({ ok: false, reason: 'not-dm' });
  });

  // dm-agent 7.3: `vonvon feishu` reads with the tools' own checks: a private chat's as an admin's turn, a group's in its turn, a comment's never
  it('lets the command line read Feishu where the tools do, in a turn that stands', async () => {
    const read = { kind: 'feishuRead' } as const;
    expect(await setup(dm, said(ADMIN)).ask(read)).toEqual({ ok: true, role: 'admin', openId: ADMIN, name: '某人' });
    expect(await setup(dm, said(MEMBER)).ask(read)).toMatchObject({ ok: false, reason: 'not-admin' });
    expect(await setup(group, said(MEMBER)).ask(read)).toMatchObject({ ok: true, openId: MEMBER });
    expect(await setup(group, null).ask(read)).toEqual(ended);
    expect(await setup({ kind: 'doc', docId: 'd1' }, said(OWNER)).ask(read)).toMatchObject({ ok: false, reason: 'not-dm' });
    const dropped = setup(group, said(MEMBER));
    dropped.scope?.close();
    expect(await dropped.ask(read)).toEqual(ended);
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
    expect(await f.ask({ kind: 'schedule', action: 'create' })).toEqual({ ok: true, role: 'member', openId: MEMBER, name: '某人',
      actor: { kind: 'session', openId: MEMBER, role: 'member', chatId: 'oc_y', name: '某人', messageId: 'om_1' } });
    expect(await setup(group, said(OWNER)).ask({ kind: 'schedule', action: 'list' })).toMatchObject({ ok: true, actor: { kind: 'session', role: 'admin' } });
  });

  it('refuses in a comment, and keeps a group task\'s own run to itself', async () => {
    expect(await setup({ kind: 'doc', docId: 'd1' }, said(OWNER)).ask({ kind: 'schedule', action: 'list' })).toEqual({ ok: false, reason: 'not-group', message: scheduleRefusalMessages['not-group'] });
    const run: TurnFacts = { retry: false, initiative: false, wake: false, scheduled: { taskId: 'st_1', runId: 'run_1' } };
    expect(await setup(group, run).ask({ kind: 'schedule', action: 'create' })).toMatchObject({ ok: false, reason: 'no-human-create' });
    expect(await setup(group, run).ask({ kind: 'schedule', action: 'edit', taskId: 'st_2' })).toMatchObject({ ok: false, reason: 'scheduled-run-scope' });
    expect(await setup(group, run).ask({ kind: 'schedule', action: 'edit', taskId: 'st_1' }))
      .toMatchObject({ ok: true, role: 'bot', actor: { kind: 'scheduled', taskId: 'st_1', runId: 'run_1', chatId: 'oc_y' } });
    expect(await setup(group, { ...said(MEMBER), requesterKind: 'bot', wake: true }).ask({ kind: 'schedule', action: 'create' })).toMatchObject({ ok: false, reason: 'not-human-turn' });
  });
});

// dm-agent 6.3. main 必败: a private chat's task was no human turn, and a task or a memory of another Bot had no way through
describe('a private chat\'s turn', () => {
  const task = (creator: string): TurnFacts => ({ requesterOpenId: creator, requesterKind: 'user', retry: false, initiative: false, wake: false, scheduled: { taskId: 'st_1', runId: 'run_1' } });
  const everything = [{ kind: 'settingsWrite' }, { kind: 'adminRead' }] as const;

  it('lets a task of this private chat do what its creator may, while the creator is an admin', async () => {
    for (const action of everything) {
      expect(await setup(dm, task(ADMIN)).ask(action)).toMatchObject({ ok: true, role: 'admin', openId: ADMIN });
      expect(await setup(dm, task(MEMBER)).ask(action)).toMatchObject({ ok: false, reason: 'not-admin' });
      // no creator on the turn, no rights
      expect(await setup(dm, { retry: false, initiative: false, wake: false, scheduled: { taskId: 'st_1', runId: 'run_1' } }).ask(action)).toMatchObject({ ok: false, reason: 'not-admin' });
    }
    expect(await setup(group, task(ADMIN)).ask({ kind: 'settingsWrite' })).toMatchObject({ ok: false, reason: 'not-dm' });
  });

  // dm-agent 8. main 必败: a task's run came as `scheduled`, a person's as `session`, and neither reaches another chat
  it('runs a task\'s and a person\'s tasks alike, with neither of a group task\'s limits', async () => {
    const asTask = { kind: 'dm', via: 'cli', openId: ADMIN, chatId: 'oc_dm' };
    expect((await setup(dm, task(ADMIN)).ask({ kind: 'schedule', action: 'create' })) as { actor: object }).toMatchObject({ ok: true, actor: asTask });
    expect(await setup(dm, task(ADMIN)).ask({ kind: 'schedule', action: 'edit', taskId: 'st_2' })).toMatchObject({ ok: true, actor: asTask });
    // only a person's message is a task's origin; the text is not the command line's, as on a group's session actor
    expect(await setup(dm, said(ADMIN)).ask({ kind: 'schedule', action: 'create' }))
      .toEqual({ ok: true, role: 'admin', openId: ADMIN, name: '某人', actor: { kind: 'dm', via: 'cli', openId: ADMIN, name: '某人', chatId: 'oc_dm', messageId: 'om_1' } });
    expect(await setup(dm, said(MEMBER)).ask({ kind: 'schedule', action: 'list' })).toMatchObject({ ok: false, reason: 'not-admin' });
  });

  it('hands the host only a shape it takes, never a local actor', () => {
    const answer = { ok: true, role: 'admin', openId: ADMIN };
    const actor = { kind: 'dm', via: 'cli', openId: ADMIN, chatId: 'oc_dm' };
    expect(sessionAuthzSchema.safeParse({ ...answer, actor }).success).toBe(true);
    expect(sessionAuthzSchema.safeParse({ ...answer, actor: { ...actor, via: 'chat' } }).success).toBe(false);
    expect(sessionAuthzSchema.safeParse({ ...answer, actor: { ...actor, text: '原话' } }).success).toBe(false);
    expect(sessionAuthzSchema.safeParse({ ...answer, actor: { kind: 'local', via: 'cli' } }).success).toBe(false);
  });

  it('refuses a turn nobody asked for, and one that ended', async () => {
    const wake = { ...said(ADMIN), requesterKind: 'bot' as const, wake: true };
    for (const action of [...everything, { kind: 'schedule', action: 'list' }, { kind: 'memory', op: 'read', target: { kind: 'bot' } }] as const) {
      expect(await setup(dm, wake).ask(action)).toMatchObject({ ok: false, reason: 'not-human-turn' });
      const f = setup(dm, task(ADMIN));
      f.scope!.close();
      expect(await f.ask(action)).toEqual(ended);
    }
  });

  it('keeps memory to an admin\'s turn, where a group\'s members may read theirs', async () => {
    expect(await setup(dm, said(MEMBER)).ask({ kind: 'memory', op: 'read', target: { kind: 'bot' } })).toMatchObject({ ok: false, reason: 'not-admin' });
    expect(await setup(group, said(MEMBER)).ask({ kind: 'memory', op: 'read', target: { kind: 'bot' } })).toMatchObject({ ok: true });
  });

  it('says on its grant who asked, the union_id another Bot pulls them in by', async () => {
    expect(await setup(dm, { ...said(ADMIN), requesterUnionId: 'on_person' }).ask({ kind: 'settingsWrite' })).toEqual({ ok: true, role: 'admin', openId: ADMIN, unionId: 'on_person', name: '某人' });
  });

  it('writes any project the request names, not only those of this Bot\'s groups', async () => {
    const f = setup(dm, said(ADMIN, '记住 周四发版'), { memoryPlace: { botProjectIds: ['prj_0000000a'] } });
    expect(await f.ask({ kind: 'memory', op: 'add', target: { kind: 'project', projectId: 'prj_elsewhere' }, text: '周四发版', otherBot: true }))
      .toMatchObject({ ok: true, memory: { scope: { kind: 'project', projectId: 'prj_elsewhere' } } });
    const item = { scope: { kind: 'project' as const, projectId: 'prj_elsewhere' }, source: { via: 'tool' as const, botId: 'cli_y', actorRole: 'admin' as const } };
    expect(await f.ask({ kind: 'memory', op: 'edit', item, otherBot: true })).toMatchObject({ ok: true, memory: { scope: item.scope } });
    // a group's stays to its own
    expect(await setup(group, said(ADMIN)).ask({ kind: 'memory', op: 'add', target: { kind: 'project', projectId: 'prj_elsewhere' }, text: 'x' })).toMatchObject({ ok: false, reason: 'not-allowed-here' });
  });

  // dm-agent 6.4
  it('writes another Bot\'s memory under a name, no open_id', async () => {
    const f = setup(dm, said(ADMIN, '记住 先写结论'));
    const landed = await f.ask({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: '先写结论', otherBot: true });
    expect(landed).toMatchObject({ ok: true, memory: { scope: { kind: 'bot' }, trust: 'trusted', actor: { role: 'admin' }, source: { actorName: '某人' } } });
    expect((landed as { memory: { actor: object } }).memory.actor).not.toHaveProperty('openId');
    const own = await setup(dm, said(ADMIN, '记住 先写结论')).ask({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: '先写结论' });
    expect(own).toMatchObject({ ok: true, memory: { actor: { role: 'admin', openId: ADMIN } } });
    expect((own as { memory: { source: object } }).memory.source).not.toHaveProperty('actorName');
  });

  it('refuses another Bot\'s memory rather than land what the gate turned down in this Bot\'s project', async () => {
    const f = setup(dm, said(ADMIN, '你好'), { memoryPlace: { botProjectIds: ['prj_0000000a'] } });
    expect(await f.ask({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: '先写结论', otherBot: true })).toEqual({ ok: false, reason: 'not-allowed-here', message: decisionMessages['not-allowed-here'] });
    // its own Bot's goes where the tools would put it
    expect(await f.ask({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: '先写结论' })).toMatchObject({ ok: true, memory: { scope: { kind: 'dm' }, source: { downgraded: 'not-in-message' } } });
  });

  it('lands the page\'s other buttons where the request says, as the person who asked', async () => {
    expect(await setup(dm, said(ADMIN)).ask({ kind: 'memory', op: 'manage', target: { kind: 'bot' } }))
      .toMatchObject({ ok: true, memory: { scope: { kind: 'bot' }, trust: 'trusted', actor: { role: 'admin', openId: ADMIN }, source: { botId: 'cli_x', chatId: 'oc_dm' } } });
    expect(await setup(group, said(ADMIN)).ask({ kind: 'memory', op: 'manage', target: { kind: 'bot' } })).toMatchObject({ ok: false, reason: 'not-dm' });
  });
});

describe('memory: where a command-line write lands, by the tools\' rules', () => {
  // devices-4b acceptance: main 必败 (D4a refused --bot outright; the tools land a member's in the project)
  it('lands a member\'s --bot in its group\'s project, untrusted, and an admin\'s typed words in the bot\'s', async () => {
    const member = setup(group, said(MEMBER, '记住 周四发版'));
    expect(await member.ask({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: ' 周四发版 ' })).toEqual({ ok: true, role: 'member', openId: MEMBER, name: '某人', memory: {
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
    expect(await bot.ask({ kind: 'memory', op: 'read', target: { kind: 'project', projectId: 'prj_0000000a' } })).toEqual({ ok: true, role: 'bot', openId: 'ou_bot', name: '某人' });
    expect(await setup(group, said(MEMBER), { memoryPlace: {} }).ask({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: 'x' }))
      .toEqual({ ok: false, reason: 'no-project', message: decisionMessages['no-project'] });
    expect(await setup(group, said(MEMBER)).ask({ kind: 'memory', op: 'add', target: { kind: 'project', projectId: 'prj_0000000b' }, text: 'x' }))
      .toEqual({ ok: false, reason: 'not-allowed-here', message: decisionMessages['not-allowed-here'] });
  });

  it('keeps a private chat\'s memory to the turn\'s own person', async () => {
    const f = setup(dm, said(ADMIN));
    expect(await f.ask({ kind: 'memory', op: 'read', target: { kind: 'dm', openId: ADMIN } })).toEqual({ ok: true, role: 'admin', openId: ADMIN, name: '某人' });
    for (const action of [
      { kind: 'memory', op: 'read', target: { kind: 'dm', openId: OWNER } },
      { kind: 'memory', op: 'add', target: { kind: 'dm', openId: OWNER }, text: 'x' },
      { kind: 'memory', op: 'edit', item: { scope: { kind: 'dm', openId: OWNER }, source: { via: 'tool', botId: 'cli_x', actorRole: 'owner' } } },
      { kind: 'memory', op: 'manage', target: { kind: 'dm', openId: OWNER } },
    ] as const) expect(await f.ask(action)).toEqual({ ok: false, reason: 'out-of-scope', message: decisionMessages['out-of-scope'] });
    expect(await f.ask({ kind: 'memory', op: 'add', target: { kind: 'dm', openId: ADMIN }, text: '我喜欢短回复' }))
      .toMatchObject({ ok: true, memory: { scope: { kind: 'dm', openId: ADMIN }, actor: { role: 'admin', openId: ADMIN } } });
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
