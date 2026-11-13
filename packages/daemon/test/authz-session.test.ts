import { afterEach, describe, expect, it, vi } from 'vitest';
import { rpcKindOf, settingsReplySchema, type DesktopSnapshot, type Request, type ScheduledTaskView, type Scope, type SettingsReply } from '@vonvon/protocol';
import agentFixture from '../../protocol/test/fixtures/agent-settings.json';

const memory = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock('../src/admin/memory', async original => ({ ...await original<object>(), memoryAction: memory.action }));
import { fakeService, socketClient, startFixture } from './server-fixture';
import { authorize, DM_ELSEWHERE, DM_OWN_BOT, foreignOpenId, memberUnchecked, ONE_GROUP_ONLY, RULES, SCOPE_MISSING, SESSION_DENIED, scopeExceeded, type AuthzDeps } from '../src/server/authz';
import { cannotInvite } from '../src/project/lifecycle';
import { SESSION_TOKEN_INVALID } from '../src/host/session-tokens';
import { NOT_DM_COMMENT_MESSAGE, NOT_DM_MESSAGE, SESSION_TURN_ENDED } from '../src/agent/entry/registry';
import type { MemoryLanding, SessionAction, SessionAuthz } from '../src/admin/ipc';
import { scheduleRefusalMessages } from '../src/admin/schedule-commands';
import type { SessionPlace } from '../src/host/session-tokens';
import type { AdminProject, AdminService } from '../src/admin/service';

/** devices-4a 4.4–4.6: what a Bot session's connection may ask, by its place and `--scope`. */
const BOT = 'cli_x';
const GROUP = 'oc_y';
const OTHER = 'oc_z';
const row = (name: string, chatId: string, projectId: string): AdminProject => ({ name, chatId, projectId, cwd: '/w', blank: false, kind: 'multi', origin: 'joined',
  noMention: false, mode: 'qa', guestMode: 'qa', network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1 });
const projects = [row('研发', GROUP, 'prj_0000000a'), row('运营', OTHER, 'prj_0000000b')];
const threads: Record<string, string[]> = { 研发: ['thread-y'], 运营: ['thread-z'] };
const deps: AuthzDeps = { groupsOf: async appId => appId === BOT ? projects : [], threadsOf: async (appId, projectName) => appId === BOT ? threads[projectName] ?? [] : [] };
const principal = (place: SessionPlace) => ({ kind: 'bot-session' as const, sessionId: 'ses_0123456789abcdef', appId: BOT, place, ...(place === 'comment' ? {} : { chatId: place === 'group' ? GROUP : 'oc_dm' }) });
const peer = (place: SessionPlace, scope: Scope | null = { bot: BOT, ...(place === 'group' ? { group: GROUP } : {}) }, negotiated = true) =>
  ({ principal: principal(place), protocolVersion: 2, negotiated, scope });
const request = (method: string, payload: object): Request => ({ type: 'request', id: '1', method, payload } as Request);
const settingsSave = (projectName: string) => request('settings', { type: 'save', edit: { scope: { kind: 'project', botId: BOT, projectName }, section: 'permission', revision: 'r', patch: { mode: 'full' } } });
/** devices-4b: a Bot process that answers every ★ request with `answer`, its questions kept. */
const botSays = (answer: SessionAuthz) => vi.fn(async (_appId: string, _sessionId: string, _action: SessionAction): Promise<SessionAuthz> => answer);
const ownerTurn = { ok: true, role: 'owner', openId: 'ou_owner' } as const;
const ended = { ok: false, code: 'permission_denied', message: SESSION_TURN_ENDED, details: { reason: 'turn-ended' } } as const;
/** The least of a daemon's state a private chat's snapshot is checked on. */
const whole = {
  agents: [{ id: BOT, name: 'A', diagnostics: { x: 1 } }, { id: 'cli_other', name: 'B', diagnostics: { x: 2 } }],
  groups: [{ id: GROUP, name: '研发' }, { id: 'oc_elsewhere', name: '别的群' }],
  memberships: [{ agentId: BOT, groupId: GROUP }, { agentId: 'cli_other', groupId: 'oc_elsewhere' }],
  jobs: [], application: { platform: 'linux', version: '1', crashes: [{ at: 1 }] },
} as unknown as DesktopSnapshot;

afterEach(() => { memory.action.mockReset(); });

describe('the bot-session column (unit)', () => {
  it('asks a session for its scope before anything but daemonStatus and negotiate', async () => {
    const unnegotiated = peer('group', null, false);
    expect(await authorize(unnegotiated, request('command', { type: 'refresh' }), deps)).toEqual({ ok: false, code: 'scope_required', message: SCOPE_MISSING });
    expect(await authorize(peer('dm', null, false), request('admin', { type: 'daemonStatus' }), deps)).toMatchObject({ ok: true });
    // s1b: a group's command line never asks daemonStatus (its paths are the owner's)
    expect(await authorize(unnegotiated, request('admin', { type: 'daemonStatus' }), deps)).toEqual({ ok: false, code: 'permission_denied', message: SESSION_DENIED });
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
    // s1b: a comment's sentence is its own
    for (const [place, message] of [['group', NOT_DM_MESSAGE], ['comment', NOT_DM_COMMENT_MESSAGE]] as const) {
      for (const write of writes) expect(await authorize(peer(place), write, deps)).toEqual({ ok: false, code: 'not-dm', message });
    }
    // settings-dm-only: the owner's words
    expect(NOT_DM_MESSAGE).toBe('群里不能改设置。私聊我可以改，也可以在 Vonvon Bot 客户端或命令行里改。');
    expect(NOT_DM_COMMENT_MESSAGE).toBe('评论里不能改设置。私聊我可以改，也可以在 Vonvon Bot 客户端或命令行里改。');
  });

  // settings-dm-only: a group session reads no settings, its own group's included; of its group it still reads its
  // members (s1b's whitelist). dm-agent 6.1: a private chat reads the whole view, the smart prompt its Skill looks at above all.
  it('refuses a group session every settings read with the not-dm sentence, and reads a private chat\'s whole', async () => {
    const own = request('settings', { type: 'read', scope: { kind: 'project', botId: BOT, projectName: '研发' } });
    expect(await authorize(peer('group'), own, deps)).toEqual({ ok: false, code: 'not-dm', message: NOT_DM_MESSAGE });
    expect(await authorize(peer('dm'), own, { ...deps, askBot: botSays(ownerTurn) })).toEqual({ ok: true, grant: { role: 'owner', openId: 'ou_owner' } });
    expect(await authorize(peer('group'), request('settings', { type: 'read', scope: { kind: 'project', botId: BOT, projectName: '运营' } }), deps)).toMatchObject({ ok: false, code: 'not-dm' });
    // D4a review R1: settings set and settings act read the bot's or a session's view before they write: the write's sentence
    for (const scope of [{ kind: 'agent', botId: BOT }, { kind: 'session', botId: BOT, threadId: 'thread-y' }]) {
      for (const [place, message] of [['group', NOT_DM_MESSAGE], ['comment', NOT_DM_COMMENT_MESSAGE]] as const) {
        expect(await authorize(peer(place), request('settings', { type: 'read', scope }), deps)).toEqual({ ok: false, code: 'not-dm', message });
      }
    }
    expect(await authorize(peer('comment', { bot: BOT }), request('settings', { type: 'read', scope: { kind: 'project', botId: BOT, projectName: '研发' } }), deps)).toEqual({ ok: false, code: 'not-dm', message: NOT_DM_COMMENT_MESSAGE });
    expect(await authorize(peer('group'), request('command', { type: 'listGroupMembers', agentId: BOT, groupId: OTHER }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('group'), request('command', { type: 'listGroupMembers', agentId: BOT, groupId: GROUP }), deps)).toMatchObject({ ok: true });
    expect(await authorize(peer('group'), request('command', { type: 'listJoinedGroups', agentId: 'cli_other' }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  // s1b: a group's token, every RPC kind. What its work needs passes the host (a ★ one asked of its Bot process); every
  // other kind is refused before any handler, a settings write with the not-dm sentence. main 必败: the bot's groups,
  // its sessions, models, history, the library list and daemonStatus all passed for a group.
  it('lets a group\'s token through only its whitelist, every other RPC kind refused', async () => {
    const stored = { scope: { kind: 'project' as const, projectId: 'prj_0000000a' }, source: { via: 'tool' as const, botId: BOT, actorRole: 'member' as const } };
    const landing: MemoryLanding = { scope: { kind: 'project', projectId: 'prj_0000000a' }, trust: 'untrusted', actor: { role: 'member', openId: 'ou_m' }, source: { botId: BOT } };
    const askBot = botSays({ ok: true, role: 'member', openId: 'ou_m', actor: { kind: 'session', openId: 'ou_m', role: 'member', chatId: GROUP }, memory: landing });
    const all = { ...deps, askBot, memoryItem: async () => stored };
    const project = { kind: 'project', projectId: 'prj_0000000a' };
    const task = (action: string, extra: object = {}) => request('schedule', { botId: BOT, request: { action, chatId: GROUP, ...extra } });
    const allowed: Record<string, Request> = {
      'snapshot.get': request('snapshot', { type: 'get' }),
      'admin.negotiate': request('admin', { type: 'negotiate', capabilities: ['cli'] }),
      'command.listGroupMembers': request('command', { type: 'listGroupMembers', agentId: BOT, groupId: GROUP }),
      'command.feishuRead': request('command', { type: 'feishuRead', tool: 'feishu_doc', args: { doc: 'dox' } }),
      'memory.list': request('memory', { type: 'list', scope: project }),
      'memory.add': request('memory', { type: 'add', scope: project, text: '周四发版' }),
      'memory.edit': request('memory', { type: 'edit', scope: project, itemId: 'mem_1', revision: 1, text: '周五发版' }),
      'memory.archive': request('memory', { type: 'archive', scope: project, itemId: 'mem_1', revision: 1 }),
      'schedule.list': task('list'),
      'schedule.create': task('create', { name: '日报', instruction: 'x', spec: { kind: 'daily', time: '09:00' } }),
      'schedule.edit': task('edit', { taskId: 'st_1', revision: 'r1', patch: { name: 'x' } }),
      'schedule.pause': task('pause', { taskId: 'st_1' }),
      'schedule.resume': task('resume', { taskId: 'st_1' }),
      'schedule.delete': task('delete', { taskId: 'st_1', revision: 'r1' }),
      'schedule.runNow': task('runNow', { taskId: 'st_1' }),
    };
    const whitelist = [...RULES].filter(([, rule]) => rule.places.group === 'host' || rule.places.group === 'bot').map(([kind]) => kind).sort();
    expect(whitelist).toEqual(Object.keys(allowed).sort());
    for (const [kind, call] of Object.entries(allowed)) {
      expect(rpcKindOf(call)).toBe(kind);
      expect(await authorize(peer('group'), call, all), kind).toMatchObject({ ok: true });
    }
    /** The least request of a kind: its discriminators only, which is all a refusal reads. */
    const nested: Record<string, (sub: string) => object> = {
      'settings.read': sub => ({ type: 'read', scope: { kind: sub } }), 'settings.save': sub => ({ type: 'save', edit: { scope: { kind: sub } } }),
      'settings.act': sub => ({ type: 'act', action: { kind: sub } }), 'machine.mcp': sub => ({ type: 'mcp', request: { action: sub } }),
      'machine.service': sub => ({ type: 'service', action: sub }), 'machine.bridgeImport': sub => ({ type: 'bridgeImport', action: sub }),
    };
    const skeleton = (kind: string): Request => {
      const [method, type, sub] = kind.split('.') as [string, string, string | undefined];
      const shapes = method === 'schedule' ? [{ botId: BOT, request: { action: type } }]
        : sub !== undefined ? [nested[`${method}.${type}`]!(sub)] : [{ type }, { action: type }];
      const found = shapes.map(payload => request(method, payload)).find(each => { try { return rpcKindOf(each) === kind; } catch { return false; } });
      if (!found) throw new Error(`no skeleton for ${kind}`);
      return found;
    };
    const refused = [...RULES.keys()].filter(kind => !(kind in allowed));
    expect(refused.length).toBeGreaterThan(100);
    for (const kind of refused) {
      const decision = await authorize(peer('group'), skeleton(kind), all);
      const cell = RULES.get(kind)!.places.group;
      expect(decision, kind).toEqual(cell === 'not-dm' ? { ok: false, code: 'not-dm', message: NOT_DM_MESSAGE }
        : cell === 'not-group' ? expect.objectContaining({ ok: false, code: 'not-group' }) : { ok: false, code: 'permission_denied', message: SESSION_DENIED });
    }
    // asked only for the whitelist's ★ requests
    expect(askBot.mock.calls.every(([, , action]) => action.kind === 'feishuRead' || action.kind === 'schedule' || action.kind === 'memory')).toBe(true);
  });

  it('refuses a comment\'s schedules with the not-group sentence', async () => {
    const list = request('schedule', { botId: BOT, request: { action: 'list', chatId: GROUP } });
    expect(await authorize(peer('comment', { bot: BOT }), list, deps)).toMatchObject({ ok: false, code: 'not-group' });
    expect(await authorize(peer('comment', { bot: BOT }), list, deps)).toMatchObject({ message: scheduleRefusalMessages['not-group'] });
  });

  // D4a review SEC-5: the owner's provider account is a group's and a comment's to never see; product.md 3.7: a private chat's to look at
  it('keeps the owner\'s account usage from a group and a comment, not from a private chat', async () => {
    for (const place of ['group', 'comment'] as const) {
      expect(await authorize(peer(place), request('collaboration', { action: 'usage', force: true }), deps)).toMatchObject({ ok: false, code: 'permission_denied', message: SESSION_DENIED });
    }
    expect(await authorize(peer('dm'), request('collaboration', { action: 'usage', force: true }), { ...deps, askBot: botSays(ownerTurn) })).toMatchObject({ ok: true });
    expect(await authorize(peer('dm'), request('collaboration', { action: 'providerModels', provider: 'codex' }), { ...deps, askBot: botSays(ownerTurn) })).toMatchObject({ ok: true });
    // s1b: not in a group's whitelist
    expect(await authorize(peer('group'), request('collaboration', { action: 'providerModels', provider: 'codex' }), deps)).toEqual({ ok: false, code: 'permission_denied', message: SESSION_DENIED });
  });

  // devices-4b 4.5: the memory tools' limits are the Bot process's to check; the host keeps the session to its reach first
  it('asks the Bot process about every memory request in reach, with the item as stored for a change', async () => {
    const item = { itemId: 'mem_1', revision: 1 };
    const stored = { scope: { kind: 'bot' as const }, source: { via: 'tool' as const, botId: BOT, actorRole: 'admin' as const, actorOpenId: 'ou_admin' } };
    const memoryItem = vi.fn(async () => stored);
    const landing: MemoryLanding = { scope: { kind: 'project', projectId: 'prj_0000000a' }, trust: 'untrusted', actor: { role: 'member', openId: 'ou_m' }, source: { botId: BOT } };
    const askBot = botSays({ ok: true, role: 'member', openId: 'ou_m', memory: landing });
    const with_ = { ...deps, askBot, memoryItem };
    for (const scope of [{ kind: 'bot', botId: BOT }, { kind: 'project', projectId: 'prj_0000000a' }]) {
      // main 必败 (D4a refused these): memory_update and memory_forget have a command now
      expect(await authorize(peer('group'), request('memory', { type: 'archive', scope, ...item }), with_)).toMatchObject({ ok: true, grant: { memory: landing } });
      expect(askBot).toHaveBeenLastCalledWith(BOT, 'ses_0123456789abcdef', { kind: 'memory', op: 'edit', item: stored });
      expect(await authorize(peer('group'), request('memory', { type: 'edit', scope, ...item, text: '新的' }), with_)).toMatchObject({ ok: true });
      expect(askBot).toHaveBeenLastCalledWith(BOT, 'ses_0123456789abcdef', { kind: 'memory', op: 'edit', item: stored, text: '新的' });
      expect(memoryItem).toHaveBeenLastCalledWith(scope, 'mem_1');
    }
    expect(await authorize(peer('group'), request('memory', { type: 'list', scope: { kind: 'project', projectId: 'prj_0000000a' } }), with_)).toMatchObject({ ok: true, grant: { role: 'member' } });
    expect(askBot).toHaveBeenLastCalledWith(BOT, 'ses_0123456789abcdef', { kind: 'memory', op: 'read', target: { kind: 'project', projectId: 'prj_0000000a' } });
    // a member's --bot: where it lands is the Bot process's to say (decideAdd)
    expect(await authorize(peer('group'), request('memory', { type: 'add', scope: { kind: 'bot', botId: BOT }, text: '周四发版' }), with_)).toMatchObject({ ok: true, grant: { memory: landing } });
    expect(askBot).toHaveBeenLastCalledWith(BOT, 'ses_0123456789abcdef', { kind: 'memory', op: 'add', target: { kind: 'bot' }, text: '周四发版' });
    // an item that is not there is not asked about
    askBot.mockClear();
    expect(await authorize(peer('group'), request('memory', { type: 'archive', scope: { kind: 'bot', botId: BOT }, ...item }), { ...with_, memoryItem: async () => undefined }))
      .toEqual({ ok: false, code: 'permission_denied', message: '没有这条记忆。' });
    expect(askBot).not.toHaveBeenCalled();
    // a private chat's memory: from a private chat whose reach names no group, the Bot process keeps it to the turn's person
    for (const type of ['list', 'add']) {
      const dm = request('memory', { type, scope: { kind: 'dm', botId: BOT, openId: 'ou_someone_else' }, ...(type === 'add' ? { text: 'x' } : {}) });
      expect(await authorize(peer('dm'), dm, { ...deps, askBot: botSays({ ok: false, reason: 'out-of-scope', message: '这条记忆不在这里，动不了。' }) }))
        .toEqual({ ok: false, code: 'permission_denied', message: '这条记忆不在这里，动不了。', details: { reason: 'out-of-scope' } });
      const never = botSays(ownerTurn);
      expect(await authorize(peer('group'), dm, { ...deps, askBot: never })).toMatchObject({ ok: false, code: 'permission_denied' });
      expect(never).not.toHaveBeenCalled();
    }
    // a write the Bot process let through without saying where it lands is not written
    expect(await authorize(peer('group'), request('memory', { type: 'add', scope: { kind: 'project', projectId: 'prj_0000000a' }, text: 'x' }), { ...deps, askBot: botSays({ ok: true, role: 'owner' }) })).toEqual(ended);
  });

  // D4a review SEC-6: --scope group narrows the sessions the owner may name too; a private chat's reach is not narrowed (dm-agent 6.1)
  it('keeps a session named by its thread to the groups an owner\'s --scope reaches', async () => {
    const owner = (scope: Scope) => ({ principal: { kind: 'owner' as const, via: 'local' as const }, protocolVersion: 2, negotiated: true, scope });
    const save = (threadId: string) => request('settings', { type: 'save', edit: { scope: { kind: 'session', botId: BOT, threadId }, section: 'model', revision: 'r', patch: {} } });
    expect(await authorize(owner({ bot: BOT, group: GROUP }), save('thread-z'), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(owner({ bot: BOT, group: GROUP }), save('thread-y'), deps)).toMatchObject({ ok: true });
    expect(await authorize(owner({ bot: BOT }), save('thread-z'), deps)).toMatchObject({ ok: true });
    const models = (threadId: string) => request('settings', { type: 'models', query: { botId: BOT, backend: 'codex-appserver', purpose: 'session', threadId } });
    expect(await authorize(owner({ bot: BOT, group: GROUP }), models('thread-z'), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(owner({ bot: BOT, group: GROUP }), models('thread-y'), deps)).toMatchObject({ ok: true });
    // s1b: a group's session lists no models
    expect(await authorize(peer('group'), models('thread-y'), deps)).toEqual({ ok: false, code: 'permission_denied', message: SESSION_DENIED });
  });

  // D4a review SEC-1/R5: a token that ended is not good for one more request on a connection already made with it
  it('refuses a session whose token ended since its hello', async () => {
    const ended: AuthzDeps = { ...deps, sessionActive: () => false };
    expect(await authorize(peer('group'), request('admin', { type: 'daemonStatus' }), ended)).toEqual({ ok: false, code: 'session_token_invalid', message: SESSION_TOKEN_INVALID });
  });

  // D4a review R7: the owner's --scope narrows as a session's would, without the place rules
  it('narrows the owner to its --scope, refusing nothing the scope does not name', async () => {
    const owner = (scope: Scope | null) => ({ principal: { kind: 'owner' as const, via: 'local' as const }, protocolVersion: 2, negotiated: scope !== null, scope });
    const scoped = owner({ bot: BOT, group: GROUP });
    expect(await authorize(scoped, request('settings', { type: 'read', scope: { kind: 'agent', botId: 'cli_other' } }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(scoped, settingsSave('运营'), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(scoped, request('schedule', { botId: BOT, request: { action: 'list', chatId: OTHER } }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(scoped, request('memory', { type: 'list', scope: { kind: 'dm', botId: BOT, openId: 'ou_a' } }), deps)).toMatchObject({ ok: false });
    // dm-agent 5: who has a private chat, as a private chat's memory: the whole bot in reach, and no session
    expect(await authorize(scoped, request('memory', { type: 'dmPeople', botId: BOT }), deps)).toMatchObject({ ok: false });
    expect(await authorize(owner({ bot: 'cli_other' }), request('memory', { type: 'dmPeople', botId: BOT }), deps)).toMatchObject({ ok: false });
    expect(await authorize(owner({ bot: BOT }), request('memory', { type: 'dmPeople', botId: BOT }), deps)).toEqual({ ok: true });
    expect(await authorize(peer('dm', { bot: BOT }), request('memory', { type: 'dmPeople', botId: BOT }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    // the place rules are a session's: the owner writes its group's settings, and reads them whole
    expect(await authorize(scoped, settingsSave('研发'), deps)).toEqual({ ok: true });
    const read = await authorize(scoped, request('settings', { type: 'read', scope: { kind: 'project', botId: BOT, projectName: '研发' } }), deps);
    expect(read).toEqual({ ok: true });
    for (const free of [request('environment', { type: 'scan' }), request('machine', { type: 'stopHost' }), request('settings', { type: 'read', scope: { kind: 'host' } }), request('command', { type: 'restartHost' })]) {
      expect(await authorize(scoped, free, deps)).toEqual({ ok: true });
    }
    expect(await authorize(owner({ bot: BOT }), request('memory', { type: 'list', scope: { kind: 'dm', botId: BOT, openId: 'ou_a' } }), deps)).toEqual({ ok: true });
    expect(await authorize(owner(null), settingsSave('运营'), deps)).toEqual({ ok: true });
    const snapshot = await authorize(scoped, request('snapshot', { type: 'get' }), deps);
    expect(snapshot.ok && typeof snapshot.narrow).toBe('function');
  });

  // Codex review 228-3 / 229-2: devices 5.3, an owner narrowed to one group moves only that group
  it('keeps an owner\'s reach of one group from the whole bot and from new groups', async () => {
    const owner = (scope: Scope) => ({ principal: { kind: 'owner' as const, via: 'local' as const }, protocolVersion: 2, negotiated: true, scope });
    const wide = [
      request('settings', { type: 'save', edit: { scope: { kind: 'agent', botId: BOT }, section: 'run', revision: 'r1', patch: { pendingPolicy: 'queue' } } }),
      request('settings', { type: 'act', action: { kind: 'voice', botId: BOT, action: { action: 'enable' } } }),
      request('settings', { type: 'act', action: { kind: 'commentInstructions', botId: BOT, revision: 'r', content: { kind: 'default' } } }),
      request('collaboration', { action: 'createProject', agentId: BOT, name: 'New', folder: { kind: 'default' }, tool: 'codex', conversation: 'shared' }),
    ];
    for (const write of wide) {
      expect(await authorize(owner({ bot: BOT, group: GROUP }), write, deps)).toEqual({ ok: false, code: 'permission_denied', message: ONE_GROUP_ONLY });
      expect(await authorize(owner({ bot: BOT }), write, deps)).toEqual({ ok: true });
    }
    // what is that group's still is
    expect(await authorize(owner({ bot: BOT, group: GROUP }), settingsSave('研发'), deps)).toEqual({ ok: true });
  });

  // dm-agent 10 (D4). main 必败: the private chat goes by no group's name, so no --scope reached its settings or tasks
  it('reaches the private chat with the whole bot, and from no group', async () => {
    const owner = (scope: Scope) => ({ principal: { kind: 'owner' as const, via: 'local' as const }, protocolVersion: 2, negotiated: true, scope });
    const read = request('settings', { type: 'read', scope: { kind: 'project', botId: BOT, projectName: `oc_dm_${BOT}` } });
    const tasks = request('schedule', { botId: BOT, request: { action: 'list', chatId: 'oc_p2p_a' } });
    const deps = { groupsOf: async () => [{ chatId: GROUP, name: '研发' }] };
    for (const ask of [read, tasks]) {
      expect(await authorize(owner({ bot: BOT }), ask, deps)).toEqual({ ok: true });
      expect(await authorize(owner({ bot: BOT, group: GROUP }), ask, deps)).toMatchObject({ ok: false });
      expect(await authorize(peer('group'), ask, deps)).toMatchObject({ ok: false });
    }
    // another Bot's id is no way in
    expect(await authorize(owner({ bot: BOT }), request('settings', { type: 'read', scope: { kind: 'project', botId: BOT, projectName: 'oc_dm_cli_other' } }), deps)).toMatchObject({ ok: false });
  });

  // Codex review 229-4: the owner's --scope binds no other group, and moves no other bot's or project's things
  it('checks the owner\'s commands, admin and library requests against its --scope by their target', async () => {
    const owner = (scope: Scope) => ({ principal: { kind: 'owner' as const, via: 'local' as const }, protocolVersion: 2, negotiated: true, scope });
    const scoped = owner({ bot: BOT, group: GROUP });
    const membership = (groupId: string) => JSON.stringify([BOT, groupId]);
    const bind = (groupId: string) => request('command', { type: 'bindGroup', agentId: BOT, groupId, projectName: 'x', folder: { kind: 'default' }, tool: 'claude', conversation: 'shared' });
    for (const outside of [
      bind('oc_outside'),
      request('command', { type: 'setPermission', membershipId: membership(OTHER), administrator: 'full' }),
      request('command', { type: 'setResponse', membershipId: membership(OTHER), response: 'all' }),
      request('command', { type: 'setAgentEnabled', agentId: BOT, enabled: false }),
      request('command', { type: 'setAgentBadgeNumber', agentId: BOT, badgeNumber: '007' }),
      request('command', { type: 'deleteAgent', agentId: BOT }),
      request('command', { type: 'refreshAgentCredentials', agentId: 'cli_other' }),
      request('command', { type: 'registerAgent' }),
      request('admin', { type: 'switchBackend', agentId: 'cli_other', projectName: '研发', backend: 'claude-agent' }),
      request('admin', { type: 'switchBackend', agentId: BOT, projectName: '运营', backend: 'claude-agent' }),
      request('admin', { type: 'confirmCardCallback', agentId: 'cli_other', confirmed: true }),
      request('library', { type: 'previous', agentId: BOT, groupId: OTHER }),
      request('library', { type: 'rename', projectId: 'prj_0000000b', revision: 1, name: 'x' }),
      request('library', { type: 'delete', projectId: 'prj_0000000c', revision: 1 }),
    ]) expect(await authorize(scoped, outside, deps), JSON.stringify(outside.payload)).toMatchObject({ ok: false, code: 'permission_denied' });
    for (const inside of [
      bind(GROUP),
      request('command', { type: 'setPermission', membershipId: membership(GROUP), administrator: 'full' }),
      request('admin', { type: 'switchBackend', agentId: BOT, projectName: '研发', backend: 'claude-agent' }),
      request('admin', { type: 'setupStatus', agentId: BOT }),
      request('library', { type: 'previous', agentId: BOT, groupId: GROUP }),
      request('library', { type: 'rename', projectId: 'prj_0000000a', revision: 1, name: 'x' }),
      // what names no bot is the machine's
      request('command', { type: 'restartHost' }), request('admin', { type: 'hostDoctor' }),
    ]) expect(await authorize(scoped, inside, deps), JSON.stringify(inside.payload)).toMatchObject({ ok: true });
    // a scope of the whole bot moves the whole bot, and still no other one
    expect(await authorize(owner({ bot: BOT }), request('command', { type: 'setAgentEnabled', agentId: BOT, enabled: false }), deps)).toEqual({ ok: true });
    expect(await authorize(owner({ bot: BOT }), bind('oc_outside'), deps)).toEqual({ ok: true });
    expect(await authorize(owner({ bot: BOT }), request('command', { type: 'deleteAgent', agentId: 'cli_other' }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  // dm-agent 4.5a: the preview and the "new" marks of a person's private chat are that person's, as their memory is.
  it('asks its Bot process about the person a private chat\'s preview or seen page names, and refuses another Bot\'s', async () => {
    const asked = vi.fn(async () => ({ ok: true as const, role: 'admin' as const, openId: 'ou_admin' }));
    const ofPerson = { kind: 'memory', op: 'read', target: { kind: 'dm', openId: 'ou_b' } };
    const page = (botId: string) => request('memory', { type: 'seen', page: { kind: 'dm', botId, openId: 'ou_b' } });
    const preview = (agentId: string) => request('contextPreview', { type: 'get', agentId, place: { kind: 'dm', openId: 'ou_b' } });
    for (const call of [page(BOT), preview(BOT)]) {
      expect(await authorize(peer('dm'), call, { ...deps, askBot: asked })).toMatchObject({ ok: true });
      expect(asked).toHaveBeenLastCalledWith(BOT, 'ses_0123456789abcdef', ofPerson);
    }
    asked.mockClear();
    for (const call of [page('cli_other'), preview('cli_other')]) expect(await authorize(peer('dm'), call, { ...deps, askBot: asked })).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(asked).not.toHaveBeenCalled();
  });

  // dm-agent 6.1. main 必败: a private chat stopped at its own Bot, and `--scope` narrowed it
  it('lets a private chat reach every Bot, group and project, whatever --scope it gives, and still asks its own Bot process', async () => {
    const askBot = botSays({ ok: true, role: 'admin', openId: 'ou_admin' });
    const other = { kind: 'project', botId: 'cli_other', projectName: '别的群' };
    for (const scope of [null, { bot: BOT }, { bot: 'cli_other', group: 'oc_elsewhere' }]) {
      for (const call of [
        settingsSave('运营'),
        request('settings', { type: 'save', edit: { scope: other, section: 'permission', revision: 'r', patch: { mode: 'full' } } }),
        request('settings', { type: 'save', edit: { scope: { kind: 'host' }, section: 'execution', revision: 'r', patch: { codexBin: null } } }),
        request('settings', { type: 'read', scope: { kind: 'agent', botId: 'cli_other' } }),
        request('settings', { type: 'read', scope: { kind: 'host' } }),
        request('command', { type: 'bindGroup', agentId: 'cli_other', groupId: 'oc_elsewhere' }),
        request('collaboration', { action: 'removeProject', agentId: 'cli_other', projectName: '别的群', groupId: 'oc_elsewhere', expectedRevision: 'r' }),
        request('collaboration', { action: 'stop', agentId: 'cli_other', projectName: '别的群', groupId: 'oc_elsewhere', threadId: 't', runId: 'r' }),
        request('library', { type: 'rename', projectId: 'prj_elsewhere', revision: 1, name: 'x' }),
        request('machine', { type: 'logs' }),
        request('environment', { type: 'scan' }),
      ]) {
        askBot.mockClear();
        expect(await authorize(peer('dm', scope), call, { ...deps, askBot }), JSON.stringify(call.payload)).toEqual({ ok: true, grant: { role: 'admin', openId: 'ou_admin' } });
        // the session's own Bot says whether this turn is going; the request then goes to the Bot it names
        expect(askBot.mock.calls[0]?.[0]).toBe(BOT);
      }
    }
  });

  // dm-agent 6.1: what scopedOwner stands for is the owner's `--scope`, which a private chat's going through does not widen
  it('keeps an owner\'s --scope without a group to its bot, though it stands as a private chat', async () => {
    const owner = { principal: { kind: 'owner' as const, via: 'local' as const }, protocolVersion: 2, negotiated: true, scope: { bot: BOT } };
    expect(await authorize(owner, request('settings', { type: 'read', scope: { kind: 'agent', botId: 'cli_other' } }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(owner, request('settings', { type: 'read', scope: { kind: 'agent', botId: BOT } }), deps)).toEqual({ ok: true });
    const snapshot = await authorize(owner, request('snapshot', { type: 'get' }), deps);
    const cut = snapshot.ok ? snapshot.narrow?.(whole) : undefined;
    expect(cut?.agents.map(agent => agent.id)).toEqual([BOT]);
  });

  // dm-agent 6.1. main 必败: only the session's own Bot
  it('shows a private chat every Bot in the snapshot, without the crashes and the diagnostics', async () => {
    const decision = await authorize(peer('dm', null), request('snapshot', { type: 'get' }), deps);
    const shown = decision.ok ? decision.narrow?.(whole) : undefined;
    expect(shown?.agents.map(agent => agent.id)).toEqual([BOT, 'cli_other']);
    expect(shown?.agents.some(agent => 'diagnostics' in agent)).toBe(false);
    expect(shown?.application).not.toHaveProperty('crashes');
    expect(shown?.memberships).toEqual(whole.memberships);
    expect(shown?.groups).toEqual(whole.groups);
  });

  // dm-agent 6.2. Every row, by name, so that a row added later is decided here and not by accident.
  it('refuses a private chat exactly what it may not do, saying where to do it, and takes the rest to its Bot process', async () => {
    const refused = new Set([
      'command.registerAgent', 'command.refreshAgentCredentials', 'command.deleteAgent', 'command.restartHost', 'command.readGroupIdentity',
      'machine.status', 'machine.service.install', 'machine.service.start', 'machine.service.stop', 'machine.service.uninstall', 'machine.setServiceSkipped',
      'machine.startHost', 'machine.stopHost', 'machine.checkCoreUpdate', 'machine.applyCoreUpdate', 'machine.coreUpdateStatus', 'machine.desktopUpdateReport',
      'machine.bridgeImport.detect', 'machine.bridgeImport.preflight', 'machine.bridgeImport.start', 'machine.bridgeImport.status', 'machine.bridgeImport.rollback',
      'environment.backendInstall', 'environment.cancelBackendInstall', 'environment.backendUninstall', 'environment.backendLogin', 'environment.install', 'environment.update',
      'environment.cancelInstall', 'environment.uninstall', 'environment.startLogin', 'environment.cancelLogin',
      'environment.profileList', 'environment.profileUse', 'environment.profileAdd', 'environment.profileInit', 'environment.profileInitStatus', 'environment.profileInitCancel',
      'admin.secrets', 'admin.setSecret', 'admin.removeSecret', 'admin.testSecret',
      'device.status', 'device.enable', 'device.disable', 'device.setPort', 'device.pair', 'device.clients', 'device.renameClient', 'device.revokeClient', 'device.rename',
      'settings.act.adminMember', 'memory.dmPeople',
      'recipeInstall.source', 'recipeInstall.createdGroup', 'recipeInstall.ignoreVersion',
      'recipeInstall.prepare', 'recipeInstall.commit', 'recipeInstall.status', 'recipeInstall.cancel',
      'recipeInstall.issuing', 'recipeInstall.reconcile',
      ...'advance beginLink cancel close confirmLink deliver edit inspectCandidate inspectLink open prepare reconcile resend reviewSource settle status updateCard'
        .split(' ').map(type => 'recipeAuthoring.' + type),
    ]);
    const onHost = new Set(['snapshot.get', 'admin.negotiate', 'admin.daemonStatus']);
    for (const [kind, rule] of RULES) expect(rule.places.dm, kind).toBe(refused.has(kind) ? 'deny' : onHost.has(kind) ? 'host' : 'bot');
    expect(await authorize(peer('dm'), request('admin', { type: 'secrets' }), deps)).toEqual({ ok: false, code: 'permission_denied', message: expect.stringContaining('密钥页') });
    expect(await authorize(peer('dm'), request('settings', { type: 'act', action: { kind: 'adminMember', botId: BOT, openId: 'ou_a', membership: 'present', revision: 'r' } }), deps))
      .toEqual({ ok: false, code: 'permission_denied', message: expect.stringContaining('私聊 → 沟通方式 → 回应谁') });
    expect(await authorize(peer('dm'), request('machine', { type: 'stopHost' }), deps)).toEqual({ ok: false, code: 'permission_denied', message: expect.stringContaining('/menu') });
    for (const call of [request('device', { type: 'pair', ttlMinutes: 10 }), request('command', { type: 'deleteAgent', agentId: BOT }), request('environment', { type: 'startLogin' })]) {
      expect(await authorize(peer('dm'), call, deps)).toEqual({ ok: false, code: 'permission_denied', message: DM_ELSEWHERE });
    }
    // the sentence of the groups stays theirs
    expect(await authorize(peer('group'), request('machine', { type: 'stopHost' }), deps)).toEqual({ ok: false, code: 'permission_denied', message: SESSION_DENIED });
  });

  // dm-agent 6.2: this turn would cut off its own private chat
  it('lets a private chat disable another Bot, not its own', async () => {
    const askBot = botSays({ ok: true, role: 'admin', openId: 'ou_admin' });
    expect(await authorize(peer('dm'), request('command', { type: 'setAgentEnabled', agentId: BOT, enabled: false }), { ...deps, askBot })).toEqual({ ok: false, code: 'permission_denied', message: DM_OWN_BOT });
    expect(askBot).not.toHaveBeenCalled();
    expect(await authorize(peer('dm'), request('command', { type: 'setAgentEnabled', agentId: 'cli_other', enabled: false }), { ...deps, askBot })).toMatchObject({ ok: true });
    expect(await authorize(peer('group'), request('command', { type: 'setAgentEnabled', agentId: 'cli_other', enabled: false }), { ...deps, askBot })).toEqual({ ok: false, code: 'permission_denied', message: SESSION_DENIED });
  });

  // dm-agent 6.4: an open_id is its app's. main 必败: another Bot's list took the id as it was
  describe('Feishu ids across Bots', () => {
    const member = (botId: string, membership: 'present' | 'absent' = 'present') => request('settings', { type: 'act', action: { kind: 'projectMember', botId, projectName: '研发', openId: 'ou_0123456789abcdef', membership, revision: 'r' } });
    const admin = botSays({ ok: true, role: 'admin', openId: 'ou_admin', unionId: 'on_person', name: '张三' });
    const named = { ...deps, askBot: admin, botName: async (appId: string) => appId === 'cli_other' ? 'B' : 'A' };
    const create = (agentId: string) => request('collaboration', { action: 'createProject', agentId, name: 'New', folder: { kind: 'default' }, tool: 'codex', conversation: 'shared' });

    it('takes a person for another Bot\'s list only if that Bot finds them', async () => {
      const knowsMember = vi.fn(async () => true);
      expect(await authorize(peer('dm'), member('cli_other'), { ...named, knowsMember })).toMatchObject({ ok: true });
      expect(knowsMember).toHaveBeenCalledExactlyOnceWith('cli_other', '研发', 'ou_0123456789abcdef');
      expect(await authorize(peer('dm'), member('cli_other'), { ...named, knowsMember: async () => false })).toEqual({ ok: false, code: 'permission_denied', message: foreignOpenId('B') });
      expect(foreignOpenId('B')).toBe('这个 ID 不是 Bot B 查到的。用 `vonvon feishu members --bot B` 查。');
      // not known is not "yes": the Bot may be stopped
      expect(await authorize(peer('dm'), member('cli_other'), { ...named, knowsMember: async () => { throw new Error('bot not running'); } })).toEqual({ ok: false, code: 'permission_denied', message: memberUnchecked('B') });
      expect(await authorize(peer('dm'), member('cli_other'), named)).toEqual({ ok: false, code: 'permission_denied', message: foreignOpenId('B') });
    });

    it('asks nothing of the session\'s own Bot, or for a person being taken off', async () => {
      const knowsMember = vi.fn(async () => false);
      expect(await authorize(peer('dm'), member(BOT), { ...named, knowsMember })).toMatchObject({ ok: true });
      expect(await authorize(peer('dm'), member('cli_other', 'absent'), { ...named, knowsMember })).toMatchObject({ ok: true });
      expect(knowsMember).not.toHaveBeenCalled();
    });

    it('pulls who asked into a new group, by open_id on its own Bot and union_id on another', async () => {
      expect(await authorize(peer('dm'), create(BOT), named)).toMatchObject({ ok: true, invitee: { idType: 'open_id', id: 'ou_admin' } });
      expect(await authorize(peer('dm'), create('cli_other'), named)).toMatchObject({ ok: true, invitee: { idType: 'union_id', id: 'on_person' } });
    });

    it('makes no group on another Bot for a turn with no union_id', async () => {
      expect(await authorize(peer('dm'), create('cli_other'), { ...named, askBot: botSays({ ok: true, role: 'admin', openId: 'ou_admin' }) })).toEqual({ ok: false, code: 'permission_denied', message: cannotInvite('B') });
      expect(cannotInvite('B')).toBe('Bot B 拉不了你。可以你自己建群、把 B 拉进去，再让我绑定。');
    });

    it('tells the Bot process when a memory written is another Bot\'s', async () => {
      const landing: MemoryLanding = { scope: { kind: 'bot' }, trust: 'trusted', actor: { role: 'admin' }, source: { botId: BOT, actorName: '张三' } };
      const askBot = botSays({ ok: true, role: 'admin', openId: 'ou_admin', memory: landing });
      const stored = { scope: { kind: 'bot' as const }, source: { via: 'tool' as const, botId: BOT, actorRole: 'admin' as const } };
      const said = async (payload: object) => { askBot.mockClear(); await authorize(peer('dm'), request('memory', payload), { ...deps, askBot, memoryItem: async () => stored }); return askBot.mock.calls[0]?.[2]; };
      expect(await said({ type: 'add', scope: { kind: 'bot', botId: 'cli_other' }, text: 'x' })).toEqual({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: 'x', otherBot: true });
      expect(await said({ type: 'add', scope: { kind: 'bot', botId: BOT }, text: 'x' })).toEqual({ kind: 'memory', op: 'add', target: { kind: 'bot' }, text: 'x' });
      // a project is the session's own Bot's when one of its groups is bound to it
      expect(await said({ type: 'add', scope: { kind: 'project', projectId: 'prj_0000000a' }, text: 'x' })).toEqual({ kind: 'memory', op: 'add', target: { kind: 'project', projectId: 'prj_0000000a' }, text: 'x' });
      expect(await said({ type: 'add', scope: { kind: 'project', projectId: 'prj_elsewhere' }, text: 'x' })).toEqual({ kind: 'memory', op: 'add', target: { kind: 'project', projectId: 'prj_elsewhere' }, text: 'x', otherBot: true });
      expect(await said({ type: 'archive', scope: { kind: 'bot', botId: 'cli_other' }, itemId: 'mem_1', revision: 1 })).toEqual({ kind: 'memory', op: 'edit', item: stored, otherBot: true });
      expect(await said({ type: 'restore', scope: { kind: 'bot', botId: 'cli_other' }, itemId: 'mem_1', revision: 1 })).toEqual({ kind: 'memory', op: 'manage', target: { kind: 'bot' }, otherBot: true });
      // what names no memory is a private chat's turn like any other
      expect(await said({ type: 'newCounts' })).toEqual({ kind: 'adminRead' });
    });

    // dm-agent 6.4. Codex 审查任务 346 必败: only where a transfer starts was looked at
    it('counts where a transfer ends, not only where it starts', async () => {
      const askBot = botSays({ ok: true, role: 'admin', openId: 'ou_admin', memory: { scope: { kind: 'bot' }, trust: 'trusted', actor: { role: 'admin' }, source: { botId: BOT } } });
      const said = async (payload: object) => { askBot.mockClear(); await authorize(peer('dm'), request('memory', payload), { ...deps, askBot }); return askBot.mock.calls[0]?.[2]; };
      const own = { kind: 'project', projectId: 'prj_0000000a' } as const;
      const manage = { kind: 'memory', op: 'manage' };
      expect(await said({ type: 'promote', scope: own, itemId: 'mem_1', revision: 1, botId: 'cli_other' })).toEqual({ ...manage, target: own, otherBot: true });
      expect(await said({ type: 'promote', scope: own, itemId: 'mem_1', revision: 1, botId: BOT })).toEqual({ ...manage, target: own });
      expect(await said({ type: 'move', scope: { kind: 'bot', botId: BOT }, itemId: 'mem_1', revision: 1, to: { projectId: 'prj_elsewhere' } })).toEqual({ ...manage, target: { kind: 'bot' }, otherBot: true });
      expect(await said({ type: 'move', scope: { kind: 'bot', botId: BOT }, itemId: 'mem_1', revision: 1, to: { projectId: own.projectId } })).toEqual({ ...manage, target: { kind: 'bot' } });
    });

    // dm-agent 6.4. Codex 审查任务 346 必败: it landed in the other Bot's memory/dm/<this Bot's open_id>, which nothing reads
    it('refuses a private chat memory of another Bot, its open_id being another app\'s', async () => {
      const askBot = botSays({ ok: true, role: 'admin', openId: 'ou_admin' });
      for (const memory of [{ type: 'add', text: 'x' }, { type: 'list' }, { type: 'archive', itemId: 'mem_1', revision: 1 }, { type: 'restore', itemId: 'mem_1', revision: 1 }]) {
        const decision = await authorize(peer('dm'), request('memory', { ...memory, scope: { kind: 'dm', botId: 'cli_other', openId: 'ou_admin' } }), { ...deps, askBot, memoryItem: async () => undefined });
        expect(decision).toMatchObject({ ok: false, code: 'permission_denied' });
      }
      expect(askBot).not.toHaveBeenCalled();
    });
  });

  // devices-4b 4.3. main 必败 (D4a let these through as a member's): no Bot process to ask, no answer, an error is a refusal
  it('refuses the ★ rows as a turn that ended unless the Bot process says yes, and never asks about what is out of reach', async () => {
    const create = request('schedule', { botId: BOT, request: { action: 'create', chatId: GROUP, name: '日报', instruction: 'x', spec: { kind: 'daily', time: '09:00' } } });
    const add = request('memory', { type: 'add', scope: { kind: 'project', projectId: 'prj_0000000a' }, text: 'x' });
    const adminList = request('command', { type: 'listJoinedGroups', agentId: BOT });
    for (const [place, star] of [['group', create], ['group', add], ['dm', settingsSave('研发')], ['dm', adminList], ['dm', request('machine', { type: 'logs' })]] as const) {
      expect(await authorize(peer(place), star, deps)).toEqual(ended);
      expect(await authorize(peer(place), star, { ...deps, askBot: vi.fn(async () => { throw new Error('channel closed'); }) })).toEqual(ended);
    }
    expect(SESSION_TURN_ENDED).toBe('这次调用对应的那一轮对话已经结束，不能再改设置。');
    const askBot = botSays(ownerTurn);
    for (const outside of [
      request('schedule', { botId: 'cli_other', request: { action: 'list', chatId: GROUP } }),
      request('schedule', { botId: BOT, request: { action: 'list', chatId: OTHER } }),
      request('memory', { type: 'add', scope: { kind: 'project', projectId: 'prj_0000000b' }, text: 'x' }),
      request('memory', { type: 'add', scope: { kind: 'bot', botId: 'cli_other' }, text: 'x' }),
    ]) expect(await authorize(peer('group'), outside, { ...deps, askBot })).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('comment', { bot: BOT }), request('memory', { type: 'list', scope: { kind: 'bot', botId: BOT } }), { ...deps, askBot })).toMatchObject({ ok: false, code: 'permission_denied', message: SESSION_DENIED });
    // a group's settings write is refused by the table: its Bot process is not asked
    expect(await authorize(peer('group'), settingsSave('研发'), { ...deps, askBot })).toEqual({ ok: false, code: 'not-dm', message: NOT_DM_MESSAGE });
    expect(askBot).not.toHaveBeenCalled();
  });

  const asked = async (place: SessionPlace, star: Request, answer: SessionAuthz = ownerTurn) => {
    const askBot = botSays(answer);
    const decision = await authorize(peer(place), star, { ...deps, askBot });
    return { decision, action: askBot.mock.calls[0]?.[2] };
  };

  it('maps each ★ request to the check its Bot process runs, and passes its refusal on word for word', async () => {
    const act = (action: object) => request('settings', { type: 'act', action });
    expect((await asked('dm', act({ kind: 'voice', botId: BOT, action: { action: 'enable' } }))).action).toEqual({ kind: 'settingsWrite' });
    expect((await asked('dm', request('collaboration', { action: 'createProject', agentId: BOT, name: 'P', folder: { kind: 'default' }, tool: 'codex', conversation: 'shared' }))).action).toEqual({ kind: 'settingsWrite' });
    // devices-4b 4.5a: a private chat's reads, as settings_get and the group lists are an admin's there
    expect((await asked('dm', request('settings', { type: 'read', scope: { kind: 'agent', botId: BOT } }))).action).toEqual({ kind: 'adminRead' });
    expect((await asked('dm', request('settings', { type: 'sessions', botId: BOT, projectName: '研发' }))).action).toEqual({ kind: 'adminRead' });
    expect((await asked('dm', request('command', { type: 'listJoinedGroups', agentId: BOT }))).action).toEqual({ kind: 'adminRead' });
    expect((await asked('dm', request('command', { type: 'listGroupMembers', agentId: BOT, groupId: GROUP }))).action).toEqual({ kind: 'adminRead' });
    const actor = { kind: 'session', openId: 'ou_m', role: 'member', chatId: GROUP } as const;
    const edit = await asked('group', request('schedule', { botId: BOT, request: { action: 'edit', chatId: GROUP, taskId: 'st_1', revision: 'r1', patch: { name: 'x' } } }), { ok: true, role: 'member', openId: 'ou_m', actor });
    expect(edit.action).toEqual({ kind: 'schedule', action: 'edit', taskId: 'st_1' });
    expect(edit.decision).toMatchObject({ ok: true, grant: { actor } });
    // a task the Bot process let through without an actor does not run
    expect((await asked('group', request('schedule', { botId: BOT, request: { action: 'list', chatId: GROUP } }), ownerTurn)).decision).toEqual(ended);
    // its refusals: the sentence word for word, the code the command line knows for its place
    const notGroup = await asked('group', request('schedule', { botId: BOT, request: { action: 'list', chatId: GROUP } }), { ok: false, reason: 'not-group', message: scheduleRefusalMessages['not-group'] });
    expect(notGroup.decision).toMatchObject({ ok: false, code: 'not-group' });
    const closed = await asked('dm', settingsSave('研发'), { ok: false, reason: 'turn-ended', message: '结束了' });
    expect(closed.decision).toEqual({ ok: false, code: 'permission_denied', message: '结束了', details: { reason: 'turn-ended' } });
  });

  // dm-agent 6.4 and 8. main 必败: an open_id of the session's Bot landed in another Bot's schedules.json
  it('takes the open_id off a task a private chat makes on another Bot, and keeps the name', async () => {
    const actor = { kind: 'dm', via: 'cli', openId: 'ou_owner', name: '张三', chatId: 'oc_p2p', messageId: 'om_1' } as const;
    const create = (botId: string) => request('schedule', { botId, request: { action: 'create', chatId: GROUP, name: '日报', instruction: 'x', spec: { kind: 'daily', time: '09:00' } } });
    const made = (await asked('dm', create('cli_other'), { ok: true, role: 'admin', openId: 'ou_owner', actor })).decision;
    expect(made).toMatchObject({ ok: true, grant: { actor: { kind: 'dm', via: 'cli', name: '张三', chatId: 'oc_p2p' } } });
    expect((made as { grant: { actor: object } }).grant.actor).not.toHaveProperty('openId');
    expect((made as { grant: { actor: object } }).grant.actor).not.toHaveProperty('messageId');
    expect((await asked('dm', create(BOT), { ok: true, role: 'admin', openId: 'ou_owner', actor })).decision).toMatchObject({ ok: true, grant: { actor } });
  });

  it('reaches every chat of every Bot from a private chat, and a group\'s to its own', async () => {
    const named = (botId: string, chatId: string) => request('schedule', { botId, request: { action: 'list', chatId } });
    const actor = { kind: 'dm', via: 'cli', openId: 'ou_owner', chatId: 'oc_p2p' } as const;
    const answer = { ok: true, role: 'admin', openId: 'ou_owner', actor } as const;
    for (const each of [named('cli_other', 'oc_elsewhere'), named(BOT, OTHER), request('schedule', { botId: 'cli_other', request: { action: 'listBot' } })]) {
      expect((await asked('dm', each, answer)).decision).toMatchObject({ ok: true });
    }
    expect((await asked('group', named(BOT, OTHER), answer)).decision).toMatchObject({ ok: false, code: 'permission_denied' });
    expect((await asked('group', named('cli_other', GROUP), answer)).decision).toMatchObject({ ok: false, code: 'permission_denied' });
  });
});

describe('a Bot session against the daemon', () => {
  const executeSchedule = vi.fn(async () => ({ kind: 'tasks' as const, tasks: [], now: 1, timeZone: 'UTC' }));
  const turn = vi.fn(async (_appId: string, _sessionId: string, action: SessionAction): Promise<SessionAuthz> => action.kind === 'schedule'
    ? { ok: true, role: 'member', openId: 'ou_m', actor: { kind: 'session', openId: 'ou_m', role: 'member', chatId: GROUP } }
    : { ok: true, role: 'member', openId: 'ou_m', memory: { scope: { kind: 'project', projectId: 'prj_0000000a' }, trust: 'untrusted', actor: { role: 'member', openId: 'ou_m' }, source: { botId: BOT, chatId: GROUP } } });
  const start = (askBot: AuthzDeps['askBot'] = turn) => startFixture(fakeService({ listProjects: async appId => appId === BOT ? projects : [], executeSchedule }), undefined, undefined, undefined, askBot);
  const negotiate = (scope?: Scope) => ({ type: 'request' as const, id: `n${Math.random()}`, method: 'admin' as const, payload: { type: 'negotiate' as const, capabilities: ['cli'], ...(scope ? { scope } : {}) } });

  // dm-agent 6.4: a group's members come in pages, and a miss on the first one is no refusal
  it('looks through every page of another Bot\'s group for a person it is asked to add', async () => {
    const act = vi.fn(async () => { throw new Error('reached the Bot'); });
    const groupMembers = vi.fn(async (_bot: string, _chat: string, cursor?: string) => cursor
      ? { members: [{ openId: 'ou_0123456789abcdef', name: '第二页的人' }] }
      : { members: [{ openId: 'ou_fedcba9876543210', name: '第一页的人' }], nextCursor: 'next' });
    const fixture = await startFixture(fakeService({ listProjects: async appId => appId === 'cli_other' ? projects : [], groupMembers, settings: { act } as unknown as AdminService['settings'] }),
      undefined, undefined, undefined, async () => ({ ok: true, role: 'admin', openId: 'ou_a' }));
    try {
      const token = fixture.sessionTokens.issue({ appId: BOT, place: 'dm', chatId: 'oc_dm', sessionId: 'ses_0123456789abcdef' });
      const client = await socketClient(fixture.api.port, token);
      await client.call(negotiate());
      const add = (openId: string) => client.call({ ...request('settings', { type: 'act', action: { kind: 'projectMember', botId: 'cli_other', projectName: '研发', openId, membership: 'present', revision: 'r' } }), id: openId });
      expect(await add('ou_aaaaaaaaaaaaaaaa')).toMatchObject({ type: 'error', code: 'permission_denied', message: foreignOpenId('cli_other') });
      expect(act).not.toHaveBeenCalled();
      await add('ou_0123456789abcdef');
      expect(act).toHaveBeenCalledOnce();
      expect(groupMembers).toHaveBeenLastCalledWith('cli_other', GROUP, 'next');
      await client.close();
    } finally { await fixture.close(); }
  });

  // dm-agent 7.2, 7.3: `vonvon feishu`, by who asks. main 必败: there was no such command
  it('keeps a Feishu read to the session\'s Bot and chat, and only a private chat may name another', async () => {
    const read = (agentId?: string) => request('command', { type: 'feishuRead', ...(agentId ? { agentId } : {}), tool: 'feishu_doc', args: { doc: 'dox' } });
    const asked = vi.fn(async () => ({ ok: true, role: 'admin', openId: 'ou_a' } as SessionAuthz));
    const all = { ...deps, askBot: asked };
    const named = { ok: true, feishu: { bot: BOT, only: GROUP } };
    expect(await authorize(peer('group'), read(), all)).toMatchObject(named);
    expect(await authorize(peer('group'), read(BOT), all)).toMatchObject(named);
    expect(await authorize(peer('group'), read('cli_other'), all)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('dm'), read('cli_other'), all)).toMatchObject({ ok: true, feishu: { prefer: BOT } });
    expect(await authorize(peer('dm'), read(), all)).toMatchObject({ ok: true, feishu: { prefer: BOT } });
    expect(asked).toHaveBeenCalledWith(BOT, 'ses_0123456789abcdef', { kind: 'feishuRead' });
    // a comment is told no by the table, its Bot not asked
    asked.mockClear();
    expect(await authorize(peer('comment'), read(), all)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(asked).not.toHaveBeenCalled();
    // the Bot's no stands: a member's private chat, a group's ended turn
    expect(await authorize(peer('dm'), read('cli_other'), { ...deps, askBot: botSays({ ok: false, reason: 'not-admin', message: '不是管理员' }) })).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('group'), read(), { ...deps, askBot: botSays({ ok: false, reason: 'turn-ended', message: SESSION_TURN_ENDED }) })).toMatchObject({ ok: false, code: 'permission_denied', message: SESSION_TURN_ENDED });
    // an owner's `--scope` is one group: its own Bot, that chat, the reading Bot checks the chat
    const scoped = { principal: { kind: 'owner' as const, via: 'local' as const }, protocolVersion: 2, negotiated: true, scope: { bot: BOT, group: GROUP } };
    expect(await authorize(scoped, read(), deps)).toMatchObject(named);
    expect(await authorize(scoped, read('cli_other'), deps)).toMatchObject({ ok: false });
  });

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
        ['dm', undefined, null],
        ['dm', { bot: BOT }, null],
        ['dm', { bot: BOT, group: GROUP }, null],
        ['dm', { bot: 'cli_other', group: OTHER }, null],
        ['comment', { bot: BOT, group: GROUP }, scopeExceeded(BOT, '（评论会话，不带群）')],
        ['comment', { bot: BOT }, null],
      ];
      for (const [place, scope, refusal] of cases) {
        const client = await connect(place);
        const reply = await client.call(negotiate(scope));
        if (refusal) expect(reply).toMatchObject({ type: 'error', code: 'scope_required', message: refusal });
        else {
          expect(reply).toMatchObject({ type: 'response', payload: { kind: 'negotiated', principal: `bot-session:${place}`, scope: scope ?? null } });
          expect(await client.call(negotiate(scope))).toMatchObject({ type: 'error', code: 'invalid_request' });
        }
        await client.close();
      }
      expect(scopeExceeded(BOT, GROUP)).toContain('超过');
      // dm-agent 6.1: a private chat needs no --scope, and one it gives moves nothing
      const dm = await connect('dm');
      expect(await dm.call(negotiate())).toMatchObject({ type: 'response', payload: { kind: 'negotiated', principal: 'bot-session:dm' } });
      expect(await dm.call({ ...settingsSave('运营'), id: 's1' })).toMatchObject({ type: 'error', code: 'unsupported' }); // past the checks: the fixture's service has no settings
      await dm.close();
    } finally { await fixture.close(); }
  });

  it('reaches the schedule and memory handlers for a ★ request as the turn its Bot process named', async () => {
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
      expect(executeSchedule).toHaveBeenCalledWith(BOT, { kind: 'session', openId: 'ou_m', role: 'member', chatId: GROUP }, task);
      expect(turn).toHaveBeenCalledWith(BOT, 'ses_0123456789abcdef', { kind: 'schedule', action: 'create' });
      expect(await client.call(schedule('c2', 'cli_other'))).toMatchObject({ type: 'error', code: 'permission_denied' });
      expect(executeSchedule).toHaveBeenCalledTimes(1);
      const add = (id: string, projectId: string) => ({ type: 'request', id, method: 'memory', payload: { type: 'add', scope: { kind: 'project', projectId }, text: '周四发版' } }) as unknown as Request;
      expect(await client.call(add('m', 'prj_0000000a'))).toMatchObject({ type: 'response', method: 'memory' });
      expect(memory.action).toHaveBeenCalledWith({ type: 'add', scope: { kind: 'project', projectId: 'prj_0000000a' }, text: '周四发版' },
        { origin: 'cli', landing: { scope: { kind: 'project', projectId: 'prj_0000000a' }, trust: 'untrusted', actor: { role: 'member', openId: 'ou_m' }, source: { botId: BOT, chatId: GROUP } } });
      expect(await client.call(add('m2', 'prj_0000000b'))).toMatchObject({ type: 'error', code: 'permission_denied' });
      expect(memory.action).toHaveBeenCalledTimes(1);
      // a group session's settings write: the not-dm sentence, word for word
      expect(await client.call({ ...settingsSave('研发'), id: 'w' })).toMatchObject({ type: 'error', code: 'not-dm', message: NOT_DM_MESSAGE });
      await client.close();
    } finally { await fixture.close(); }
  });

  // devices-4b acceptance: with no Bot process to ask (the daemon alone), a ★ request reaches no handler
  it('runs no ★ request when there is no Bot process to ask', async () => {
    executeSchedule.mockClear();
    const fixture = await startFixture(fakeService({ listProjects: async appId => appId === BOT ? projects : [], executeSchedule }));
    try {
      const client = await socketClient(fixture.api.port, fixture.sessionTokens.issue({ appId: BOT, place: 'group', chatId: GROUP, sessionId: 'ses_0123456789abcdef' }));
      await client.ready();
      await client.call(negotiate({ bot: BOT, group: GROUP }));
      const list = { type: 'request', id: 'l', method: 'schedule', payload: { botId: BOT, request: { action: 'list', chatId: GROUP } } } as unknown as Request;
      expect(await client.call(list)).toMatchObject({ type: 'error', code: 'permission_denied', message: SESSION_TURN_ENDED });
      const add = { type: 'request', id: 'm', method: 'memory', payload: { type: 'add', scope: { kind: 'project', projectId: 'prj_0000000a' }, text: 'x' } } as unknown as Request;
      expect(await client.call(add)).toMatchObject({ type: 'error', code: 'permission_denied', message: SESSION_TURN_ENDED });
      expect(executeSchedule).not.toHaveBeenCalled();
      expect(memory.action).not.toHaveBeenCalled();
      await client.close();
    } finally { await fixture.close(); }
  });

  // Codex review 228-1 / 229-1. main 必败 (in this slice): history listed the provider's sessions of the whole directory
  it('lists in a group\'s history only the native sessions bound to that group, unless the owner gave no --scope', async () => {
    // Two groups share one folder, and the owner works in it from a terminal: the provider lists all three by folder.
    const bound = { threadId: 'thread-y', chatId: GROUP, sessionId: 'native-a', summary: 'A', backend: 'codex-appserver', cwd: '/w', createdAt: 1, updatedAt: 1 };
    const native = (sessionId: string, preview: string, name?: string) => ({ sessionId, preview, ...(name ? { name } : {}), createdAt: 1, updatedAt: 1 });
    const collaboration = vi.fn(async () => ({ sessions: [bound], backend: 'codex-appserver',
      threads: [native('native-a', 'A 群自己的会话'), native('native-b', 'B 群的发版计划'), native('native-owner', '主人终端里的草稿', '主人终端')] }));
    const fixture = await startFixture(fakeService({ listBots: async () => [{ appId: BOT, name: 'X', tenant: 'feishu', active: true, current: true, running: true, completionReminder: { mode: 'failures', longTaskMinutes: 3 } }],
      listProjects: async appId => appId === BOT ? projects : [], collaboration }));
    try {
      const history = { type: 'request', id: 'h', method: 'collaboration', payload: { action: 'history', agentId: BOT, projectName: '研发', groupId: GROUP } } as unknown as Request;
      const ask = async (credential: string, scope?: Scope) => {
        const client = await socketClient(fixture.api.port, credential);
        await client.ready();
        if (scope) expect(await client.call(negotiate(scope))).toMatchObject({ type: 'response' });
        const reply = await client.call(history);
        await client.close();
        return reply;
      };
      const group = fixture.sessionTokens.issue({ appId: BOT, place: 'group', chatId: GROUP, sessionId: 'ses_0123456789abcdef' });
      // s1b: a group's session reads no history at all; the owner narrowed to the group still gets its own sessions only
      expect(await ask(group, { bot: BOT, group: GROUP })).toMatchObject({ type: 'error', code: 'permission_denied', message: SESSION_DENIED });
      for (const reply of [await ask(fixture.credential, { bot: BOT, group: GROUP })]) {
        expect(reply).toMatchObject({ type: 'response', payload: { kind: 'history', sessions: [bound], threads: [native('native-a', 'A 群自己的会话')] } });
        for (const leak of ['native-b', 'B 群的发版计划', 'native-owner', '主人终端']) expect(JSON.stringify(reply)).not.toContain(leak);
      }
      const whole = await ask(fixture.credential);
      expect(whole).toMatchObject({ type: 'response', payload: { kind: 'history' } });
      expect((whole as { payload: { threads: unknown[] } }).payload.threads).toHaveLength(3);
    } finally { await fixture.close(); }
  });

  // Codex review 228-2 / 229-3. main 必败: the schedule reply skipped the narrowing the table gave
  it('cuts the owner\'s listBot to the one group of its --scope', async () => {
    const task = (id: string, chatId: string): ScheduledTaskView => ({ id, botId: BOT, chatId, revision: 'r1', name: id, instruction: 'x', spec: { kind: 'every', minutes: 60 }, timeZone: 'UTC', placement: { kind: 'follow' },
      state: 'active', createdBy: { via: 'cli' }, createdAt: 1, updatedAt: 1, nextRunAt: 2, running: false, counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [], describe: '每小时' });
    const executeSchedule = vi.fn(async () => ({ kind: 'tasks' as const, tasks: [task('st_a', GROUP), task('st_b', OTHER)], now: 1, timeZone: 'UTC' }));
    const fixture = await startFixture(fakeService({ listProjects: async appId => appId === BOT ? projects : [], executeSchedule }));
    try {
      const client = await socketClient(fixture.api.port, fixture.credential);
      await client.ready();
      await client.call(negotiate({ bot: BOT, group: GROUP }));
      const reply = await client.call({ type: 'request', id: 'all', method: 'schedule', payload: { botId: BOT, request: { action: 'listBot' } } } as unknown as Request);
      expect(reply).toMatchObject({ type: 'response', payload: { kind: 'tasks', tasks: [{ id: 'st_a', chatId: GROUP }] } });
      expect((reply as { payload: { tasks: unknown[] } }).payload.tasks).toHaveLength(1);
      await client.close();
    } finally { await fixture.close(); }
  });

  // dm-agent 6.4: who the group is for reaches the Bot process with the creation. main 必败: it always pulled the primary admin
  it('sends a private chat\'s new group with who asked, and the owner\'s without', async () => {
    const collaboration = vi.fn(async (_botId: string, _operation: { invitee?: unknown }) => ({ ok: true }));
    const running = async (appId: string) => ({ appId, name: appId, tenant: 'feishu' as const, active: true, current: true, running: true, completionReminder: { mode: 'failures' as const, longTaskMinutes: 3 } });
    const fixture = await startFixture(fakeService({ listBots: async () => [await running(BOT), await running('cli_other')], listProjects: async appId => appId === BOT ? projects : [],
      collaboration: collaboration as never }), undefined, undefined, undefined, botSays({ ok: true, role: 'admin', openId: 'ou_admin', unionId: 'on_person' }));
    const create = (agentId: string) => ({ type: 'request', id: `c${agentId}`, method: 'collaboration', payload: { action: 'createProject', agentId, name: 'New', folder: { kind: 'default' }, tool: 'codex', conversation: 'shared' } }) as unknown as Request;
    try {
      const client = await socketClient(fixture.api.port, fixture.sessionTokens.issue({ appId: BOT, place: 'dm', chatId: 'oc_dm', sessionId: 'ses_0123456789abcdef' }));
      await client.ready();
      await client.call(negotiate());
      await client.call(create(BOT));
      expect(collaboration.mock.lastCall?.[1]).toMatchObject({ invitee: { idType: 'open_id', id: 'ou_admin' } });
      await client.call(create('cli_other'));
      expect(collaboration.mock.lastCall?.[0]).toBe('cli_other');
      expect(collaboration.mock.lastCall?.[1]).toMatchObject({ invitee: { idType: 'union_id', id: 'on_person' } });
      await client.close();
      const owner = await socketClient(fixture.api.port, fixture.credential);
      await owner.ready();
      await owner.call(create(BOT));
      expect(collaboration.mock.lastCall?.[1]).not.toHaveProperty('invitee');
      await owner.close();
    } finally { await fixture.close(); }
  });

  // D4a review SEC-1/R5. main 必败 (in this slice): a connection made with a revoked token kept working
  it('closes the connections made with a token when its session ends, and only those', async () => {
    const fixture = await start();
    try {
      const open = async (sessionId: string) => {
        const client = await socketClient(fixture.api.port, fixture.sessionTokens.issue({ appId: BOT, place: 'group', chatId: GROUP, sessionId }));
        await client.ready();
        await client.call(negotiate({ bot: BOT, group: GROUP }));
        const closed = new Promise<[number, string]>(resolve => client.socket.once('close', (code, reason) => resolve([code, reason.toString()])));
        return { client, closed };
      };
      const ending = await open('ses_0123456789abcdef');
      const other = await open('ses_1111111111111111');
      fixture.sessionTokens.revoke('ses_0123456789abcdef');
      expect(await ending.closed).toEqual([4401, 'invalid_session_token']);
      const list = { type: 'request', id: 'l', method: 'schedule', payload: { botId: BOT, request: { action: 'list', chatId: GROUP } } } as unknown as Request;
      expect(await other.client.call(list)).toMatchObject({ type: 'response', method: 'schedule' });
      await other.client.close();
    } finally { await fixture.close(); }
  });
});


it.each(['dm', 'group', 'comment'] as const)('keeps exact group identity reads owner-only in %s sessions', async place => {
  expect(await authorize(peer(place), request('command', {type: 'readGroupIdentity', agentId: BOT, groupId: GROUP}), deps)).toMatchObject({ok: false});
});
