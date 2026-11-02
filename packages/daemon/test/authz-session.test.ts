import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Scope, SettingsReply } from '@vonvon/protocol';

const memory = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock('../src/admin/memory', async original => ({ ...await original<object>(), memoryAction: memory.action }));
import { fakeService, socketClient, startFixture } from './server-fixture';
import { authorize, SCOPE_MISSING, SESSION_DENIED, scopeExceeded, type AuthzDeps } from '../src/server/authz';
import { NOT_DM_MESSAGE } from '../src/agent/entry/registry';
import { scheduleRefusalMessages } from '../src/admin/schedule-commands';
import type { SessionPlace } from '../src/host/session-tokens';
import type { AdminProject } from '../src/admin/service';

/** devices-4a 4.4–4.6: what a Bot session's connection may ask, by its place and `--scope`. */
const BOT = 'cli_x';
const GROUP = 'oc_y';
const OTHER = 'oc_z';
const row = (name: string, chatId: string, projectId: string): AdminProject => ({ name, chatId, projectId, cwd: '/w', blank: false, kind: 'multi', origin: 'joined',
  noMention: false, mode: 'qa', guestMode: 'qa', network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1 });
const projects = [row('研发', GROUP, 'prj_0000000a'), row('运营', OTHER, 'prj_0000000b')];
const deps: AuthzDeps = { groupsOf: async appId => appId === BOT ? projects : [] };
const principal = (place: SessionPlace) => ({ kind: 'bot-session' as const, sessionId: 'ses_0123456789abcdef', appId: BOT, place, ...(place === 'comment' ? {} : { chatId: place === 'group' ? GROUP : 'oc_dm' }) });
const peer = (place: SessionPlace, scope: Scope | null = { bot: BOT, ...(place === 'group' ? { group: GROUP } : {}) }, negotiated = true) =>
  ({ principal: principal(place), protocolVersion: 2, negotiated, scope });
const request = (method: string, payload: object): Request => ({ type: 'request', id: '1', method, payload } as Request);
const settingsSave = (projectName: string) => request('settings', { type: 'save', edit: { scope: { kind: 'project', botId: BOT, projectName }, section: 'permission', revision: 'r', patch: { mode: 'full' } } });

afterEach(() => { memory.action.mockReset(); });

describe('the bot-session column (unit)', () => {
  it('asks a session for its scope before anything but daemonStatus and negotiate', async () => {
    const unnegotiated = peer('group', null, false);
    expect(await authorize(unnegotiated, request('command', { type: 'refresh' }), deps)).toEqual({ ok: false, code: 'scope_required', message: SCOPE_MISSING });
    expect(await authorize(unnegotiated, request('admin', { type: 'daemonStatus' }), deps)).toMatchObject({ ok: true });
    expect(await authorize(unnegotiated, request('admin', { type: 'negotiate', capabilities: ['cli'] }), deps)).toMatchObject({ ok: true });
  });

  // main 必败: a Bot session was not a principal the table knew
  it('gives a group and a comment session the not-dm sentence for settings writes, the same constant the tools use', async () => {
    const writes = [
      settingsSave('研发'),
      request('settings', { type: 'act', action: { kind: 'voice', botId: BOT, action: { action: 'enable' } } }),
      request('collaboration', { action: 'createProject', agentId: BOT, name: 'P', folder: { kind: 'existing', folderToken: 'x' }, tool: 'codex', conversation: 'threads' }),
      request('collaboration', { action: 'editProject', agentId: BOT, projectName: '研发', groupId: GROUP, expectedRevision: 'r' }),
    ];
    for (const place of ['group', 'comment'] as const) {
      for (const write of writes) expect(await authorize(peer(place), write, deps)).toEqual({ ok: false, code: 'not-dm', message: NOT_DM_MESSAGE });
    }
    expect(NOT_DM_MESSAGE).toBe('设置只能在私聊里改。请对方去私聊里跟我说。');
  });

  it('lets a group session read its own group\'s settings, every part read-only for not-dm, and nothing else', async () => {
    const decision = await authorize(peer('group'), request('settings', { type: 'read', scope: { kind: 'project', botId: BOT, projectName: '研发' } }), deps);
    expect(decision).toMatchObject({ ok: true });
    const reply = { kind: 'view', view: { scope: { kind: 'project' }, sections: { permission: { value: {}, access: { kind: 'writable' } }, model: { value: {}, access: { kind: 'writable' } } } } } as unknown as SettingsReply;
    const shown = decision.ok && decision.narrow ? decision.narrow(reply) : reply;
    expect(Object.values((shown as { view: { sections: Record<string, { access: unknown }> } }).view.sections).map(section => section.access))
      .toEqual([{ kind: 'readonly', reason: 'not-dm', message: NOT_DM_MESSAGE }, { kind: 'readonly', reason: 'not-dm', message: NOT_DM_MESSAGE }]);
    expect(await authorize(peer('group'), request('settings', { type: 'read', scope: { kind: 'project', botId: BOT, projectName: '运营' } }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('group'), request('settings', { type: 'read', scope: { kind: 'agent', botId: BOT } }), deps)).toEqual({ ok: false, code: 'permission_denied', message: SESSION_DENIED });
    expect(await authorize(peer('group'), request('command', { type: 'listGroupMembers', agentId: BOT, groupId: OTHER }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('group'), request('command', { type: 'listGroupMembers', agentId: BOT, groupId: GROUP }), deps)).toMatchObject({ ok: true });
    expect(await authorize(peer('group'), request('command', { type: 'listJoinedGroups', agentId: 'cli_other' }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  it('refuses the deny rows, and schedules outside a group with the not-group sentence', async () => {
    for (const denied of [
      request('command', { type: 'bindGroup', agentId: BOT, groupId: GROUP }),
      request('machine', { type: 'stopHost' }),
      request('admin', { type: 'secrets' }),
      request('device', { type: 'pair', ttlMinutes: 10 }),
      request('environment', { type: 'scan' }),
    ]) expect(await authorize(peer('dm', { bot: BOT }), denied, deps)).toMatchObject({ ok: false, code: 'permission_denied', message: SESSION_DENIED });
    const list = request('schedule', { botId: BOT, request: { action: 'list', chatId: GROUP } });
    expect(await authorize(peer('dm', { bot: BOT }), list, deps)).toEqual({ ok: false, code: 'not-group', message: scheduleRefusalMessages['not-group'] });
    expect(await authorize(peer('comment', { bot: BOT }), list, deps)).toMatchObject({ ok: false, code: 'not-group' });
  });

  it('keeps a private chat to its bot\'s groups, narrowed by --scope group', async () => {
    expect(await authorize(peer('dm', { bot: BOT }), settingsSave('运营'), deps)).toMatchObject({ ok: true, grant: { role: 'member' } });
    expect(await authorize(peer('dm', { bot: BOT, group: GROUP }), settingsSave('运营'), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('dm', { bot: BOT }), request('settings', { type: 'save', edit: { scope: { kind: 'host' }, section: 'execution', revision: 'r', patch: { codexBin: null } } }), deps))
      .toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('dm', { bot: BOT }), request('settings', { type: 'read', scope: { kind: 'agent', botId: 'cli_other' } }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  // 4.6: until D4b asks the Bot process, a ★ request within reach goes through as a member's
  it('lets the ★ rows through within reach as a member, and only within reach', async () => {
    const create = request('schedule', { botId: BOT, request: { action: 'create', chatId: GROUP, name: '日报', instruction: 'x', spec: { kind: 'daily', time: '09:00' } } });
    expect(await authorize(peer('group'), create, deps)).toMatchObject({ ok: true, grant: { role: 'member' } });
    expect(await authorize(peer('group'), request('schedule', { botId: 'cli_other', request: { action: 'list', chatId: GROUP } }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('group'), request('schedule', { botId: BOT, request: { action: 'list', chatId: OTHER } }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('group'), request('memory', { type: 'add', scope: { kind: 'project', projectId: 'prj_0000000a' }, text: 'x' }), deps)).toMatchObject({ ok: true, grant: { role: 'member' } });
    expect(await authorize(peer('group'), request('memory', { type: 'add', scope: { kind: 'project', projectId: 'prj_0000000b' }, text: 'x' }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('group'), request('memory', { type: 'add', scope: { kind: 'bot', botId: 'cli_other' }, text: 'x' }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('comment', { bot: BOT }), request('memory', { type: 'list', scope: { kind: 'bot', botId: BOT } }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    // with D4b's askBot the Bot process decides
    const askBot = vi.fn(async () => ({ ok: false as const, reason: 'turn-ended', message: '这一轮已经结束了。' }));
    expect(await authorize(peer('group'), create, { ...deps, askBot })).toMatchObject({ ok: false, code: 'permission_denied', message: '这一轮已经结束了。' });
  });
});

describe('a Bot session against the daemon', () => {
  const executeSchedule = vi.fn(async () => ({ kind: 'tasks' as const, tasks: [], now: 1, timeZone: 'UTC' }));
  const start = () => startFixture(fakeService({ listProjects: async appId => appId === BOT ? projects : [], executeSchedule }));
  const negotiate = (scope?: Scope) => ({ type: 'request' as const, id: `n${Math.random()}`, method: 'admin' as const, payload: { type: 'negotiate' as const, capabilities: ['cli'], ...(scope ? { scope } : {}) } });

  it('checks --scope at negotiate against the session', async () => {
    const fixture = await start();
    try {
      const connect = async (place: SessionPlace) => {
        const token = fixture.sessionTokens.issue({ appId: BOT, place, sessionId: `ses_${'0123456789abcdef'.slice(0, 15)}${place.length}`, ...(place === 'comment' ? {} : { chatId: place === 'group' ? GROUP : 'oc_dm' }) });
        const client = await socketClient(fixture.api.port, token);
        await client.ready();
        return client;
      };
      const cases: Array<[SessionPlace, Scope | undefined, string | null]> = [
        ['group', undefined, SCOPE_MISSING],
        ['group', { bot: BOT }, scopeExceeded(BOT, GROUP)],
        ['group', { bot: 'cli_other', group: GROUP }, scopeExceeded(BOT, GROUP)],
        ['group', { bot: BOT, group: OTHER }, scopeExceeded(BOT, GROUP)],
        ['group', { bot: BOT, group: GROUP }, null],
        ['dm', { bot: BOT }, null],
        ['dm', { bot: BOT, group: GROUP }, null],
        ['comment', { bot: BOT, group: GROUP }, scopeExceeded(BOT, '（评论会话，不带群）')],
        ['comment', { bot: BOT }, null],
      ];
      for (const [place, scope, refusal] of cases) {
        const client = await connect(place);
        const reply = await client.call(negotiate(scope));
        if (refusal) expect(reply).toMatchObject({ type: 'error', code: 'scope_required', message: refusal });
        else {
          expect(reply).toMatchObject({ type: 'response', payload: { kind: 'negotiated', principal: `bot-session:${place}`, scope } });
          expect(await client.call(negotiate(scope))).toMatchObject({ type: 'error', code: 'invalid_request' });
        }
        await client.close();
      }
      expect(scopeExceeded(BOT, GROUP)).toContain('超过');
      // a private chat narrowed to one group cannot write another's settings
      const dm = await connect('dm');
      await dm.call(negotiate({ bot: BOT, group: GROUP }));
      expect(await dm.call({ ...settingsSave('运营'), id: 's1' })).toMatchObject({ type: 'error', code: 'permission_denied' });
      await dm.close();
    } finally { await fixture.close(); }
  });

  it('reaches the schedule and memory handlers for a ★ request, with the member\'s role and the terminal\'s origin', async () => {
    memory.action.mockResolvedValue({ kind: 'seen', at: 1 });
    const fixture = await start();
    try {
      const token = fixture.sessionTokens.issue({ appId: BOT, place: 'group', chatId: GROUP, sessionId: 'ses_0123456789abcdef' });
      const client = await socketClient(fixture.api.port, token);
      await client.ready();
      expect(await client.call({ type: 'request', id: 'early', method: 'command', payload: { type: 'refresh' } })).toMatchObject({ type: 'error', code: 'scope_required', message: SCOPE_MISSING });
      await client.call(negotiate({ bot: BOT, group: GROUP }));
      const task = { action: 'create', chatId: GROUP, name: '日报', instruction: 'x', spec: { kind: 'daily', time: '09:00' } };
      const schedule = (id: string, botId: string) => ({ type: 'request', id, method: 'schedule', payload: { botId, request: task } }) as unknown as Request;
      expect(await client.call(schedule('c', BOT))).toMatchObject({ type: 'response', method: 'schedule' });
      expect(executeSchedule).toHaveBeenCalledWith(BOT, 'cli', task);
      expect(await client.call(schedule('c2', 'cli_other'))).toMatchObject({ type: 'error', code: 'permission_denied' });
      expect(executeSchedule).toHaveBeenCalledTimes(1);
      const add = (id: string, projectId: string) => ({ type: 'request', id, method: 'memory', payload: { type: 'add', scope: { kind: 'project', projectId }, text: '周四发版' } }) as unknown as Request;
      expect(await client.call(add('m', 'prj_0000000a'))).toMatchObject({ type: 'response', method: 'memory' });
      expect(memory.action).toHaveBeenCalledWith({ type: 'add', scope: { kind: 'project', projectId: 'prj_0000000a' }, text: '周四发版' }, { origin: 'cli', actor: { role: 'member' } });
      expect(await client.call(add('m2', 'prj_0000000b'))).toMatchObject({ type: 'error', code: 'permission_denied' });
      expect(memory.action).toHaveBeenCalledTimes(1);
      // a group session's settings write: the not-dm sentence, word for word
      expect(await client.call({ ...settingsSave('研发'), id: 'w' })).toMatchObject({ type: 'error', code: 'not-dm', message: NOT_DM_MESSAGE });
      await client.close();
    } finally { await fixture.close(); }
  });
});
