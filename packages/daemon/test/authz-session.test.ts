import { afterEach, describe, expect, it, vi } from 'vitest';
import { rpcKindOf, settingsReplySchema, type Request, type ScheduledTaskView, type Scope, type SettingsReply } from '@vonvon/protocol';
import agentFixture from '../../protocol/test/fixtures/agent-settings.json';

const memory = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock('../src/admin/memory', async original => ({ ...await original<object>(), memoryAction: memory.action }));
import { fakeService, socketClient, startFixture } from './server-fixture';
import { authorize, ONE_GROUP_ONLY, RULES, SCOPE_MISSING, SESSION_DENIED, scopeExceeded, type AuthzDeps } from '../src/server/authz';
import { SESSION_TOKEN_INVALID } from '../src/host/session-tokens';
import { NOT_DM_COMMENT_MESSAGE, NOT_DM_MESSAGE, SESSION_TURN_ENDED } from '../src/agent/entry/registry';
import type { MemoryLanding, SessionAction, SessionAuthz } from '../src/admin/ipc';
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

  // settings-dm-only: a group session has no settings_get, and its command line reads no settings either, its own group's
  // included; of its group it still reads its members (s1b's whitelist).
  it('refuses a group session every settings read with the not-dm sentence, and reads a private chat\'s as settings_get does', async () => {
    const own = request('settings', { type: 'read', scope: { kind: 'project', botId: BOT, projectName: '研发' } });
    expect(await authorize(peer('group'), own, deps)).toEqual({ ok: false, code: 'not-dm', message: NOT_DM_MESSAGE });
    const decision = await authorize(peer('dm', { bot: BOT }), own, { ...deps, askBot: botSays(ownerTurn) });
    expect(decision).toMatchObject({ ok: true });
    const view = {
      scope: { kind: 'project', botId: BOT, projectName: '研发' }, sections: { permission: { value: {}, access: { kind: 'writable' } }, model: { value: {}, access: { kind: 'writable' } } },
      identity: { chatId: GROUP, backend: 'codex-appserver', cwd: '/w', kind: 'multi' }, members: { openIds: ['ou_a'], revision: 'm1', roster: { state: 'complete', entries: [{ openId: 'ou_a', name: '某人', kind: 'person' }], otherBots: false } },
      smartPrompt: { text: '判断提示词' }, skills: [{ path: '/w/skills/x', name: 'x', description: '', source: 'user', enabled: true }], skillsError: 'x', botProfile: { name: 'X' }, decisionModels: [],
    };
    const shown = decision.ok && decision.narrow ? decision.narrow({ kind: 'view', view } as unknown as SettingsReply) : undefined;
    const narrowed = (shown as { view: { sections: Record<string, { access: unknown }>; members: object } }).view;
    expect(Object.values(narrowed.sections).map(section => section.access)).toEqual([{ kind: 'writable' }, { kind: 'writable' }]);
    // D4a review SEC-4/R6: what settings_get leaves out stays out, but for what the view's schema needs (its group's identity, the response list without names)
    expect(Object.keys(narrowed).sort()).toEqual(['identity', 'members', 'scope', 'sections']);
    expect(narrowed.members).toEqual({ openIds: ['ou_a'], revision: 'm1' });
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
    expect(askBot.mock.calls.every(([, , action]) => action.kind === 'schedule' || action.kind === 'memory')).toBe(true);
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

  // D4a review SEC-5: the owner's provider account is no session's
  it('keeps the owner\'s account usage from every session, the provider\'s model list not', async () => {
    for (const place of ['group', 'dm', 'comment'] as const) {
      expect(await authorize(peer(place), request('collaboration', { action: 'usage', force: true }), deps)).toMatchObject({ ok: false, code: 'permission_denied', message: SESSION_DENIED });
    }
    expect(await authorize(peer('dm', { bot: BOT }), request('collaboration', { action: 'providerModels', provider: 'codex' }), deps)).toMatchObject({ ok: true });
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
      expect(await authorize(peer('dm', { bot: BOT }), dm, { ...deps, askBot: botSays({ ok: false, reason: 'out-of-scope', message: '这条记忆不在这里，动不了。' }) }))
        .toEqual({ ok: false, code: 'permission_denied', message: '这条记忆不在这里，动不了。', details: { reason: 'out-of-scope' } });
      const never = botSays(ownerTurn);
      expect(await authorize(peer('dm', { bot: BOT, group: GROUP }), dm, { ...deps, askBot: never })).toMatchObject({ ok: false, code: 'permission_denied' });
      expect(await authorize(peer('group'), dm, { ...deps, askBot: never })).toMatchObject({ ok: false, code: 'permission_denied' });
      expect(never).not.toHaveBeenCalled();
    }
    // a write the Bot process let through without saying where it lands is not written
    expect(await authorize(peer('group'), request('memory', { type: 'add', scope: { kind: 'project', projectId: 'prj_0000000a' }, text: 'x' }), { ...deps, askBot: botSays({ ok: true, role: 'owner' }) })).toEqual(ended);
  });

  // D4a review SEC-6: --scope group narrows the sessions a private chat may name too
  it('keeps a session named by its thread to the groups reached', async () => {
    const save = (threadId: string) => request('settings', { type: 'save', edit: { scope: { kind: 'session', botId: BOT, threadId }, section: 'model', revision: 'r', patch: {} } });
    const owned = { ...deps, askBot: botSays(ownerTurn) };
    expect(await authorize(peer('dm', { bot: BOT, group: GROUP }), save('thread-z'), owned)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('dm', { bot: BOT, group: GROUP }), save('thread-y'), owned)).toMatchObject({ ok: true });
    expect(await authorize(peer('dm', { bot: BOT }), save('thread-z'), owned)).toMatchObject({ ok: true });
    const models = (threadId: string) => request('settings', { type: 'models', query: { botId: BOT, backend: 'codex-appserver', purpose: 'session', threadId } });
    expect(await authorize(peer('dm', { bot: BOT, group: GROUP }), models('thread-z'), owned)).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('dm', { bot: BOT, group: GROUP }), models('thread-y'), owned)).toMatchObject({ ok: true });
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

  // Codex review 228-3 / 229-2: devices 5.3, a private chat narrowed to one group moves only that group, whoever's turn it is
  it('keeps a reach of one group from the whole bot and from new groups, even on the owner\'s turn', async () => {
    const owner = botSays(ownerTurn);
    const bound = { bot: BOT, group: GROUP };
    const wide = [
      request('settings', { type: 'save', edit: { scope: { kind: 'agent', botId: BOT }, section: 'cards', revision: 'r1', patch: { showToolCalls: true } } }),
      request('settings', { type: 'act', action: { kind: 'voice', botId: BOT, action: { action: 'enable' } } }),
      request('settings', { type: 'act', action: { kind: 'adminMember', botId: BOT, openId: 'ou_0123456789abcdef', membership: 'present', revision: 'r' } }),
      request('settings', { type: 'act', action: { kind: 'commentInstructions', botId: BOT, revision: 'r', content: { kind: 'default' } } }),
      request('collaboration', { action: 'createProject', agentId: BOT, name: 'New', folder: { kind: 'default' }, tool: 'codex', conversation: 'shared' }),
    ];
    for (const write of wide) {
      for (const deps2 of [deps, { ...deps, askBot: owner }]) expect(await authorize(peer('dm', bound), write, deps2)).toEqual({ ok: false, code: 'permission_denied', message: ONE_GROUP_ONLY });
      // the whole bot's private chat may, if its Bot process says the turn may
      expect(await authorize(peer('dm', { bot: BOT }), write, { ...deps, askBot: owner })).toMatchObject({ ok: true });
    }
    // what is that group's still is
    expect(await authorize(peer('dm', bound), settingsSave('研发'), { ...deps, askBot: owner })).toMatchObject({ ok: true, grant: { role: 'owner' } });
    expect(await authorize(peer('dm', bound), request('settings', { type: 'act', action: { kind: 'projectMember', botId: BOT, projectName: '研发', openId: 'ou_0123456789abcdef', membership: 'present', revision: 'r' } }), { ...deps, askBot: owner })).toMatchObject({ ok: true });
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

  // devices-4b acceptance: the owner's private chat changes another group of the same bot, and no other bot's
  it('keeps a private chat to its bot\'s groups, narrowed by --scope group', async () => {
    const askBot = botSays(ownerTurn);
    expect(await authorize(peer('dm', { bot: BOT }), settingsSave('运营'), { ...deps, askBot })).toMatchObject({ ok: true, grant: { role: 'owner', openId: 'ou_owner' } });
    expect(askBot).toHaveBeenCalledExactlyOnceWith(BOT, 'ses_0123456789abcdef', { kind: 'settingsWrite' });
    askBot.mockClear();
    expect(await authorize(peer('dm', { bot: BOT, group: GROUP }), settingsSave('运营'), { ...deps, askBot })).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('dm', { bot: BOT }), request('settings', { type: 'save', edit: { scope: { kind: 'project', botId: 'cli_other', projectName: '研发' }, section: 'permission', revision: 'r', patch: { mode: 'full' } } }), { ...deps, askBot }))
      .toMatchObject({ ok: false, code: 'permission_denied' });
    expect(askBot).not.toHaveBeenCalled();
    expect(await authorize(peer('dm', { bot: BOT }), request('settings', { type: 'save', edit: { scope: { kind: 'host' }, section: 'execution', revision: 'r', patch: { codexBin: null } } }), deps))
      .toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await authorize(peer('dm', { bot: BOT }), request('settings', { type: 'read', scope: { kind: 'agent', botId: 'cli_other' } }), deps)).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  // devices-4b 4.3. main 必败 (D4a let these through as a member's): no Bot process to ask, no answer, an error is a refusal
  it('refuses the ★ rows as a turn that ended unless the Bot process says yes, and never asks about what is out of reach', async () => {
    const create = request('schedule', { botId: BOT, request: { action: 'create', chatId: GROUP, name: '日报', instruction: 'x', spec: { kind: 'daily', time: '09:00' } } });
    const add = request('memory', { type: 'add', scope: { kind: 'project', projectId: 'prj_0000000a' }, text: 'x' });
    const adminList = request('command', { type: 'listJoinedGroups', agentId: BOT });
    for (const [place, star] of [['group', create], ['group', add], ['dm', settingsSave('研发')], ['dm', adminList]] as const) {
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

  it('maps each ★ request to the check its Bot process runs, and passes its refusal on word for word', async () => {
    const asked = async (place: SessionPlace, star: Request, answer: SessionAuthz = ownerTurn) => {
      const askBot = botSays(answer);
      const decision = await authorize(peer(place), star, { ...deps, askBot });
      return { decision, action: askBot.mock.calls[0]?.[2] };
    };
    const act = (action: object) => request('settings', { type: 'act', action });
    expect((await asked('dm', act({ kind: 'adminMember', botId: BOT, openId: 'ou_0123456789abcdef', membership: 'present', revision: 'r' }))).action).toEqual({ kind: 'adminMember' });
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
    const notOwner = await asked('dm', act({ kind: 'adminMember', botId: BOT, openId: 'ou_0123456789abcdef', membership: 'present', revision: 'r' }), { ok: false, reason: 'not-owner', message: '本机管理员名单只有飞书应用的拥有者能改。' });
    expect(notOwner.decision).toEqual({ ok: false, code: 'permission_denied', message: '本机管理员名单只有飞书应用的拥有者能改。', details: { reason: 'not-owner' } });
    const notGroup = await asked('group', request('schedule', { botId: BOT, request: { action: 'list', chatId: GROUP } }), { ok: false, reason: 'not-group', message: scheduleRefusalMessages['not-group'] });
    expect(notGroup.decision).toMatchObject({ ok: false, code: 'not-group' });
    const switchOff = await asked('dm', settingsSave('研发'), { ok: false, reason: 'switch-off', message: '关了' });
    expect(switchOff.decision).toEqual({ ok: false, code: 'permission_denied', message: '关了', details: { reason: 'switch-off' } });
  });

  // devices-4b 4.5a (SEC-4): a private chat reads the bot's settings as settings_get shows them
  it('shows a private chat the bot\'s view without what settings_get leaves out', async () => {
    const decision = await authorize(peer('dm', { bot: BOT }), request('settings', { type: 'read', scope: { kind: 'agent', botId: BOT } }), { ...deps, askBot: botSays(ownerTurn) });
    const view = {
      scope: { kind: 'agent', botId: BOT }, sections: { cards: { value: {}, access: { kind: 'writable' } } }, ownerOpenId: 'ou_owner',
      administrators: { openIds: ['ou_admin'], revision: 'a1', feishu: ['ou_admin'], draft: { text: 'x' } }, voice: { enabled: false }, commentInstructions: { kind: 'default' },
      smartPrompt: { text: '判断提示词' }, botProfile: { name: 'X' }, decisionModels: [{ id: 'm', hasKey: true }], roleDraft: '草稿',
    };
    const shown = decision.ok && decision.narrow ? decision.narrow({ kind: 'view', view } as unknown as SettingsReply) : undefined;
    const narrowed = (shown as { view: Record<string, unknown> }).view;
    expect(Object.keys(narrowed).sort()).toEqual(['administrators', 'commentInstructions', 'ownerOpenId', 'scope', 'sections', 'voice']);
    expect(narrowed.administrators).toEqual({ openIds: ['ou_admin'], revision: 'a1' });
    // a project's sections stay writable in a private chat; the roster's names stay out
    const project = await authorize(peer('dm', { bot: BOT }), request('settings', { type: 'read', scope: { kind: 'project', botId: BOT, projectName: '研发' } }), { ...deps, askBot: botSays(ownerTurn) });
    const projectView = { scope: { kind: 'project', botId: BOT, projectName: '研发' }, sections: { permission: { value: {}, access: { kind: 'writable' } } }, identity: { chatId: GROUP },
      members: { openIds: ['ou_a'], revision: 'm1', roster: { state: 'complete', entries: [] } }, smartPrompt: { text: 'x' } };
    const projectShown = project.ok && project.narrow ? project.narrow({ kind: 'view', view: projectView } as unknown as SettingsReply) : undefined;
    expect((projectShown as { view: unknown }).view).toEqual({ scope: projectView.scope, sections: projectView.sections, identity: projectView.identity, members: { openIds: ['ou_a'], revision: 'm1' } });
  });
});

describe('a Bot session against the daemon', () => {
  const executeSchedule = vi.fn(async () => ({ kind: 'tasks' as const, tasks: [], now: 1, timeZone: 'UTC' }));
  const turn = vi.fn(async (_appId: string, _sessionId: string, action: SessionAction): Promise<SessionAuthz> => action.kind === 'schedule'
    ? { ok: true, role: 'member', openId: 'ou_m', actor: { kind: 'session', openId: 'ou_m', role: 'member', chatId: GROUP } }
    : { ok: true, role: 'member', openId: 'ou_m', memory: { scope: { kind: 'project', projectId: 'prj_0000000a' }, trust: 'untrusted', actor: { role: 'member', openId: 'ou_m' }, source: { botId: BOT, chatId: GROUP } } });
  const start = (askBot: AuthzDeps['askBot'] = turn) => startFixture(fakeService({ listProjects: async appId => appId === BOT ? projects : [], executeSchedule }), undefined, undefined, undefined, askBot);
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

  // Codex review 228-3: the refusal comes before the handler, which would have made the group
  it('makes no new group for a private chat narrowed to one', async () => {
    const collaboration = vi.fn(async () => ({ ok: true }));
    const fixture = await startFixture(fakeService({ listProjects: async appId => appId === BOT ? projects : [], collaboration }));
    try {
      const client = await socketClient(fixture.api.port, fixture.sessionTokens.issue({ appId: BOT, place: 'dm', chatId: 'oc_dm', sessionId: 'ses_0123456789abcdef' }));
      await client.ready();
      await client.call(negotiate({ bot: BOT, group: GROUP }));
      const create = { type: 'request', id: 'c', method: 'collaboration', payload: { action: 'createProject', agentId: BOT, name: 'New', folder: { kind: 'default' }, tool: 'codex', conversation: 'shared' } } as unknown as Request;
      expect(await client.call(create)).toMatchObject({ type: 'error', code: 'permission_denied', message: ONE_GROUP_ONLY });
      expect(collaboration).not.toHaveBeenCalled();
      await client.close();
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

  // Codex review 239-2 / 240-1. main 必败 (in this slice): read's view was cut, and the act's reply carried it whole again
  it('cuts the view a saved or conflicting act answers a private chat with, as read\'s, still to the protocol; the owner\'s terminal gets it whole', async () => {
    const section = (value: unknown) => ({ stored: value, effective: value, revision: 'r1', access: { kind: 'writable' }, apply: [] });
    const options = { tiers: ['qa', 'write', 'full'].map(tier => ({ tier, name: '权限', summary: '说明', native: '' })), strength: '能力说明', fields: [], expanded: { qa: {}, write: {}, full: {} } };
    const decisionModels = [{ provider: 'deepseek', displayName: 'DeepSeek', models: [{ id: 'deepseek-chat', displayName: 'Chat' }], keyId: 'deepseek', keySet: true }];
    // What settings_get leaves out, each one set: where the administrators come from, the role draft, the keystore's, the roster's names, the skills.
    const agent = {
      ...agentFixture, scope: { kind: 'agent', botId: BOT }, decisionModels, judgeByBackend: { 'codex-appserver': { model: 'gpt-5', source: 'bot' } },
      roleInfo: { draft: '身份草稿', headed: true, oversized: false, mergedNotice: false, integrity: 'ok' },
      administrators: { feishu: { ownerOpenId: 'ou_owner', adminOpenIds: ['ou_fs'] }, scannerOpenId: 'ou_scan', openIds: ['ou_local', 'ou_0123456789abcdef'], revision: 'a2' },
    };
    const project = {
      scope: { kind: 'project', botId: BOT, projectName: '研发' }, decisionModels, skillsError: '读不到 /w/skills',
      sections: { permission: section({ mode: 'qa', guestMode: 'qa', network: false, custom: null, options }), response: section({ noMention: false }), model: section({ selection: { kind: 'default' } }) },
      identity: { chatId: GROUP, backend: 'codex-appserver', cwd: '/w', kind: 'multi' },
      skills: [{ path: '/w/skills/review', name: 'review', description: '审查', source: 'workspace', enabled: true }],
      members: { openIds: ['ou_a'], revision: 'm2', roster: { state: 'complete', entries: [{ openId: 'ou_a', name: '小A', kind: 'person' }], otherBots: false } },
    };
    const act = vi.fn(async (action: { kind: string }) => action.kind === 'adminMember' ? { kind: 'saved', view: agent, effects: [], warnings: [] } : { kind: 'conflict', view: project });
    const settings = { act, read: async () => { throw new Error('unused'); }, save: async () => { throw new Error('unused'); }, models: async () => { throw new Error('unused'); } };
    const fixture = await startFixture(fakeService({ listProjects: async (appId: string) => appId === BOT ? projects : [], settings } as unknown as Parameters<typeof fakeService>[0]),
      undefined, undefined, undefined, botSays(ownerTurn));
    const admin = { type: 'request', id: 'a', method: 'settings', payload: { type: 'act', action: { kind: 'adminMember', botId: BOT, openId: 'ou_0123456789abcdef', membership: 'present', revision: 'a1' } } } as unknown as Request;
    const member = { type: 'request', id: 'm', method: 'settings', payload: { type: 'act', action: { kind: 'projectMember', botId: BOT, projectName: '研发', openId: 'ou_0123456789abcdef', membership: 'present', revision: 'm1' } } } as unknown as Request;
    // the frame as the client takes it: its schema checked
    const acted = (frame: unknown): Extract<SettingsReply, { kind: 'acted' }>['result'] => {
      expect(frame).toMatchObject({ type: 'response', method: 'settings', payload: { kind: 'acted' } });
      const reply = settingsReplySchema.parse((frame as { payload: unknown }).payload);
      if (reply.kind !== 'acted') throw new Error('not acted');
      return reply.result;
    };
    try {
      const client = await socketClient(fixture.api.port, fixture.sessionTokens.issue({ appId: BOT, place: 'dm', chatId: 'oc_dm', sessionId: 'ses_0123456789abcdef' }));
      await client.ready();
      await client.call(negotiate({ bot: BOT }));
      const saved = acted(await client.call(admin));
      expect(saved).toMatchObject({ kind: 'saved', effects: [], warnings: [] });
      expect('view' in saved && saved.view).toEqual({ scope: agent.scope, sections: agent.sections, ownerOpenId: agent.ownerOpenId,
        administrators: { openIds: ['ou_local', 'ou_0123456789abcdef'], revision: 'a2' }, voice: agent.voice, commentInstructions: agent.commentInstructions });
      const conflict = acted(await client.call(member));
      expect(conflict.kind).toBe('conflict');
      expect('view' in conflict && conflict.view).toEqual({ scope: project.scope, sections: project.sections, identity: project.identity, members: { openIds: ['ou_a'], revision: 'm2' } });
      await client.close();
      // not in a session: the owner sees what the settings page shows
      const owner = await socketClient(fixture.api.port, fixture.credential);
      await owner.ready();
      const whole = acted(await owner.call(admin));
      expect('view' in whole && whole.view).toMatchObject({ roleInfo: agent.roleInfo, decisionModels, administrators: agent.administrators });
      const wholeProject = acted(await owner.call(member));
      expect('view' in wholeProject && wholeProject.view).toMatchObject({ skills: project.skills, members: project.members });
      await owner.close();
      expect(act).toHaveBeenCalledTimes(4);
    } finally { await fixture.close(); }
  });
});
