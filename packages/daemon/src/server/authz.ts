import {
  MAINTENANCE_KINDS, PROTOCOL_VERSION, rpcKindOf,
  type AgentSettingsView, type CollaborationReply, type Command, type CommandResult, type DesktopSnapshot, type LibraryReply, type MemoryItem, type MemoryReply, type MemoryRequest,
  type MemoryScopeRef, type ProjectSettingsView, type Request, type ScheduleReply, type Scope, type SettingsReply, type SettingsScope,
} from '@vonvon/protocol';
import { notDmMessage, SESSION_TURN_ENDED } from '../agent/entry/registry';
import { sessionTurnEnded, type SessionAction, type SessionAuthz } from '../admin/ipc';
import { scheduleRefusalMessages } from '../admin/schedule-commands';
import { bridgeVersion } from '../core/version';
import { SESSION_TOKEN_INVALID } from '../host/session-tokens';
import { RpcError } from './errors';
import { filterSnapshot, scopedOwner, sessionGroups, sessionSnapshot, type BotSessionPrincipal } from './snapshot-filter';
import type { Peer } from './ws';

/** host: decided in the host (D4a); bot: the ★ rows, asked of the Bot process (D4b). */
export type BotSessionRule = 'deny' | 'host' | 'bot';
export type SessionPlace = BotSessionPrincipal['place'];
/** One place's cell of the bot-session column (devices 5.2): who decides, or a refusal and the sentence it reads. */
export type PlaceRule = 'host' | 'bot' | 'deny' | 'not-dm' | 'not-group';
/** `maintenance`: a connection of another protocol may ask it. `botSession` sums up `places`: `bot` if any place asks the Bot process. */
export interface Rule { owner: 'allow'; botSession: BotSessionRule; maintenance: boolean; places: Readonly<Record<SessionPlace, PlaceRule>> }
/** Who started the turn behind a Bot session's ★ request, as its Bot process answered: a task's actor, where a memory write lands. */
export type SessionGrant = Omit<Extract<SessionAuthz, { ok: true }>, 'ok'>;
export type DenialCode = 'permission_denied' | 'protocol_mismatch' | 'scope_required' | 'not-dm' | 'not-group' | 'not_in_session' | 'session_token_invalid';
/**
 * `narrow`: what of the reply a Bot session gets (its bot, its groups); `grant`: a ★ request's turn.
 * `details` goes into the error envelope (a `protocol_mismatch` names both versions).
 */
export type Decision =
  | { ok: true; grant?: SessionGrant; narrow?: <T>(payload: T) => T }
  | { ok: false; code: DenialCode; message: string; details?: Record<string, unknown> };
/** A settings view as a reply carries it (read's; an act's is a bot's or a group's). */
type SettingsView = Extract<SettingsReply, { kind: 'view' }>['view'];
/** A bot's bound group: its project name, its chat and its library project. */
export interface BoundGroup { name: string; chatId: string; projectId?: string }
/**
 * What the bot-session checks read. `threadsOf`: a project's session threads, which a reach of one group checks a named
 * session against. `sessionActive`: whether a session's token still stands, its use noted (devices 5.3: it ends with the
 * session or its bot's process), asked before every request on a connection made with it. `askBot` (D4b): the session's
 * Bot process judges a ★ request for its current turn; without it every ★ request is refused. `memoryItem`: an item as
 * stored, whose author and place decideEdit looks at.
 */
export interface AuthzDeps {
  groupsOf?(appId: string): Promise<readonly BoundGroup[]>;
  threadsOf?(appId: string, projectName: string): Promise<readonly string[]>;
  sessionActive?(sessionId: string): boolean;
  askBot?(appId: string, sessionId: string, action: SessionAction): Promise<SessionAuthz>;
  memoryItem?(scope: MemoryScopeRef, itemId: string): Promise<Pick<MemoryItem, 'scope' | 'source'> | undefined>;
}

/**
 * devices 15: the sentences a Bot session's command line reads. No skill teaches the command line (settings-dm-only), so
 * the refusal of a call without `--scope` says what to add: the `VONVON_SCOPE` the session was given, as it is.
 */
export const SCOPE_MISSING = '这次调用来自 Bot 会话，要带上 `--scope "$VONVON_SCOPE"`（vonvon 给这条会话设好的范围，照抄，不要自己拼），不能比会话本身的范围大。';
export const scopeExceeded = (bot: string, group: string): string => `范围超过了这条会话（只能是 bot=${bot}, group=${group}）。改用 \`--scope "$VONVON_SCOPE"\`，不要重试更大的范围。`;
export const SESSION_DENIED = '这个操作不能从 Bot 会话里做。';
const MAINTENANCE = new Set<string>(MAINTENANCE_KINDS);
const PLACES = ['dm', 'group', 'comment'] as const;
const ALL = (cell: PlaceRule): Record<SessionPlace, PlaceRule> => ({ dm: cell, group: cell, comment: cell });
/** A private chat's read: its Bot process asks whose turn it is. A group and a comment get none (s1b: a group's whitelist). */
const DM_READ = { dm: 'bot', group: 'deny', comment: 'deny' } as const;
/** A settings write: only a private chat's turn may, the group and the comment read the not-dm sentence (devices 5.2). */
const WRITE = { dm: 'bot', group: 'not-dm', comment: 'not-dm' } as const;
const rows = (method: string, types: string, cell: PlaceRule | Readonly<Record<SessionPlace, PlaceRule>> = 'deny'): Array<[string, Rule]> => types.split(/\s+/).filter(Boolean).map(type => {
  const kind = `${method}.${type}`;
  const places = typeof cell === 'string' ? ALL(cell) : cell;
  const cells = PLACES.map(place => places[place]);
  const botSession: BotSessionRule = cells.includes('bot') ? 'bot' : cells.includes('host') ? 'host' : 'deny';
  return [kind, { owner: 'allow', botSession, maintenance: MAINTENANCE.has(kind), places }];
});
/**
 * devices 5.2: one row per `rpcKinds()` name, written out, so a new RPC is refused until it gets a row here (test/authz.test.ts
 * checks both ways). The owner may do everything; a bot session what its place's cell says, `deny` unless written.
 *
 * A group's cells are a whitelist (s1b, owner 2026-11-02): what a group's work needs and nothing else. Its tasks
 * (`schedule.*`), its project's memory and the bot's as the memory tools list them (`memory list add edit archive`), its
 * own members (`command.listGroupMembers`), and what the command line itself runs on (`admin.negotiate`, a
 * `snapshot.get` cut to the names it resolves). A settings write reads the not-dm sentence; anything else is refused
 * with words that say nothing of what is there.
 */
export const RULES: ReadonlyMap<string, Rule> = new Map([
  ...rows('snapshot', 'get', 'host'),
  ...rows('command', 'refresh listPendingGroups listJoinedGroups', DM_READ),
  ...rows('command', 'listGroupMembers', { dm: 'bot', group: 'host', comment: 'deny' }),
  ...rows('command', 'registerAgent refreshAgentCredentials restartHost bindGroup setAgentEnabled deleteAgent cancelJob'),
  // The desktop's older permission and reply switches: settings writes, which the command line makes as settings set.
  ...rows('command', 'setResponse setPermission', { dm: 'deny', group: 'not-dm', comment: 'not-dm' }),
  ...rows('settings', 'read.host save.host'),
  // Settings are a private chat's, read and written (settings-dm-only: no group session has settings_get either). A group
  // and a comment read none: `settings set` and `settings act` read before they write, so these reads answer with the
  // write's sentence (a private chat's turn may do both).
  ...rows('settings', 'read.agent read.session read.project', WRITE),
  ...rows('settings', 'models sessions', DM_READ),
  ...rows('settings', 'save.agent save.project save.session act.voice act.projectMember act.projectAudience act.commentInstructions', WRITE),
  // product.md section 6: the list changes in the client and the terminal only, never by chat.
  ...rows('settings', 'act.adminMember', { dm: 'deny', group: 'not-dm', comment: 'not-dm' }),
  ...rows('collaboration', 'history context project providerModels', { dm: 'host', group: 'deny', comment: 'deny' }),
  // The owner's whole provider account (plan, daily use, use outside vonvon), which no tool shows a session.
  ...rows('collaboration', 'usage'),
  ...rows('collaboration', 'createProject editProject', WRITE),
  ...rows('collaboration', 'removeProject clear compact resume startGoal stop stopSubagent endGoal reminder shareUsage'),
  ...rows('environment', `scan backendCatalog backendVersion backendInstall backendInstallStatus cancelBackendInstall backendUninstall backendLogin
    install update toolInstallStatus cancelInstall uninstall authStatus startLogin loginStatus cancelLogin
    profileList profileUse profileAdd profileInit profileInitStatus profileInitCancel`),
  ...rows('machine', `mcp.list mcp.add mcp.remove bridgeImport.detect bridgeImport.preflight bridgeImport.start bridgeImport.status bridgeImport.rollback
    status service.install service.start service.stop service.uninstall setServiceSkipped startHost stopHost logs
    checkCoreUpdate applyCoreUpdate coreUpdateStatus`),
  // U4: the owner's, and of the owner's connections only this computer's desktop shell (rpc/machine.ts checks which).
  ...rows('machine', 'desktopUpdateReport'),
  ...rows('admin', `judgeUsage state diagnosis hostDoctor setupStatus cardCallbackStatus confirmCardCallback codexSetup logs followLogs
    switchBackend secrets setSecret removeSecret testSecret`),
  // A session's command line never asks daemonStatus (`vonvon daemon status` reads the lock there); its paths are the owner's.
  ...rows('admin', 'daemonStatus', { dm: 'host', group: 'deny', comment: 'deny' }),
  ...rows('admin', 'negotiate', 'host'),
  ...rows('directory', 'list suggest choose'),
  // The library's projects with their folders: a session's command line finds its project's name in the snapshot.
  ...rows('library', 'list', { dm: 'host', group: 'deny', comment: 'deny' }),
  ...rows('library', 'workspace rename previous delete'),
  // What memory_list, memory_add, memory_update and memory_forget do: the Bot process says where a write lands and
  // whether an item may be changed (memory-authority, D4b). A group reads the entries as memory_list shows them
  // (groupMemoryReply); the files' export and an entry's history, with its authors and earlier texts, are a private chat's.
  ...rows('memory', 'list add edit archive', { dm: 'bot', group: 'bot', comment: 'deny' }),
  ...rows('memory', 'export events', DM_READ),
  ...rows('memory', 'restore promote move branchRename branchMerge branchDelete confirm purge undo reseal seen newCounts'),
  ...rows('contextPreview', 'get'),
  ...rows('schedule', 'list create edit pause resume delete runNow', { dm: 'not-group', group: 'bot', comment: 'not-group' }),
  ...rows('schedule', 'listBot', { dm: 'not-group', group: 'deny', comment: 'not-group' }),
  ...rows('device', 'status enable disable setPort pair clients renameClient revokeClient rename'),
]);

const denied = (message: string): Decision => ({ ok: false, code: 'permission_denied', message });
const OUT_OF_REACH = '这次调用碰到了这条 Bot 会话范围以外的 Bot、群或项目。';
const outOfReach = (): Decision => denied(OUT_OF_REACH);
/** devices 5.3: a reach of one group (a private chat or the owner given `--scope … group=`) moves only that group. */
export const ONE_GROUP_ONLY = '这次调用的 `--scope` 只到一个群：不能改整个 Bot 的设置，也不能建新群。';
/** A connection of another protocol refused this many requests in a row is closed (4001, devices 4.7). */
export const MAINTENANCE_STRIKES = 20;

/**
 * devices 5.3, at `admin.negotiate`: a Bot session's `--scope` must be there, name its bot, and be no wider than the
 * session (a group session's own group; a comment no group). It may narrow a private chat to one group. The owner's
 * scope is recorded as given.
 */
export function checkSessionScope(principal: Peer['principal'], scope: Scope | null): void {
  if (principal.kind !== 'bot-session') return;
  if (!scope) throw new RpcError('scope_required', SCOPE_MISSING);
  const limit = principal.place === 'group' ? principal.chatId ?? '' : principal.place === 'dm' ? '（私聊会话，不限群）' : '（评论会话，不带群）';
  const wider = scope.bot !== principal.appId
    || principal.place === 'group' && (scope.group === undefined || scope.group !== principal.chatId)
    || principal.place === 'comment' && scope.group !== undefined;
  if (wider) throw new RpcError('scope_required', scopeExceeded(principal.appId, limit));
}

/**
 * Before every request is dispatched (http.ts). The owner may do everything; with a `--scope` given at negotiate, only
 * within it (devices 5.3: so a person checks a skill from their own terminal), without a session's place rules.
 */
export async function authorize(peer: Pick<Peer, 'principal' | 'protocolVersion' | 'negotiated' | 'scope'>, request: Request, deps: AuthzDeps = {}): Promise<Decision> {
  const kind = rpcKindOf(request);
  const rule = RULES.get(kind);
  if (!rule) return denied(`这个 daemon 没有登记 ${kind} 的权限，不处理它。`);
  switch (peer.principal.kind) {
    case 'owner': return peer.scope ? withinReach(scopedOwner(peer.scope), peer.scope, 'owner', request, deps) : { ok: true };
    case 'maintenance':
      return rule.maintenance ? { ok: true } : {
        ok: false, code: 'protocol_mismatch',
        message: `这个客户端用的协议版本是 ${peer.protocolVersion}，daemon 的是 ${PROTOCOL_VERSION}，这条连接只能查状态、升级或停止 daemon。把较旧的那一边升级到同一个版本。`,
        // The hello carries no client version: only its protocol is known.
        details: { serverProtocol: PROTOCOL_VERSION, clientProtocol: peer.protocolVersion, serverVersion: bridgeVersion(), clientVersion: null },
      };
    case 'bot-session': return authorizeSession(peer.principal, peer, request, kind, rule, deps);
    default: return denied('这个操作不能从这条连接里做。');
  }
}

async function authorizeSession(principal: BotSessionPrincipal, peer: Pick<Peer, 'negotiated' | 'scope'>, request: Request, kind: string, rule: Rule, deps: AuthzDeps): Promise<Decision> {
  // devices 5.3: a token revoked since the hello (its session ended, its bot's process went) or left idle takes the connection made with it along.
  if (deps.sessionActive && !deps.sessionActive(principal.sessionId)) return { ok: false, code: 'session_token_invalid', message: SESSION_TOKEN_INVALID };
  if (!peer.negotiated && kind !== 'admin.daemonStatus' && kind !== 'admin.negotiate') return { ok: false, code: 'scope_required', message: SCOPE_MISSING };
  const cell = rule.places[principal.place];
  switch (cell) {
    case 'deny': return denied(SESSION_DENIED);
    case 'not-dm': return { ok: false, code: 'not-dm', message: notDmMessage(principal.place) };
    case 'not-group': return { ok: false, code: 'not-group', message: scheduleRefusalMessages['not-group'] };
    case 'host': case 'bot': break;
  }
  // The host's half first: what is out of the session's reach never reaches its Bot process.
  const decision = await withinReach(principal, peer.scope, 'session', request, deps);
  if (!decision.ok || cell === 'host') return decision;
  // ★ (devices 5.2): who started this turn and whether it is still going, the Bot process says with the tools' own checks.
  // No Bot process to ask, no answer, an error: refused as a turn that ended, never let through.
  const action = await sessionActionOf(request, deps);
  if ('ok' in action) return action;
  const answer = deps.askBot ? await deps.askBot(principal.appId, principal.sessionId, action).catch(sessionTurnEnded) : sessionTurnEnded();
  if (!answer.ok) {
    const code = answer.reason === 'not-dm' || answer.reason === 'not-group' ? answer.reason : 'permission_denied';
    return { ok: false, code, message: answer.message, details: { reason: answer.reason } };
  }
  const { ok: _ok, ...grant } = answer;
  // A task runs as the actor the Bot process gave and a memory write lands where it said: without them, nothing runs.
  const missing = action.kind === 'schedule' ? !grant.actor : action.kind === 'memory' && action.op !== 'read' && !grant.memory;
  if (missing) return { ok: false, code: 'permission_denied', message: SESSION_TURN_ENDED, details: { reason: 'turn-ended' } };
  return { ...decision, grant };
}

const memoryTarget = (scope: MemoryScopeRef): Extract<SessionAction, { kind: 'memory'; op: 'read' }>['target'] =>
  scope.kind === 'project' ? { kind: 'project', projectId: scope.projectId } : scope.kind === 'dm' ? { kind: 'dm', openId: scope.openId } : { kind: 'bot' };

/**
 * devices-4b 4.3: a ★ row's request as the check its Bot process runs. Settings writes and new or edited groups are
 * authorizeNow's; a private chat's reads `ctx.admin`'s; memory and tasks
 * their own. An item to change is read here, so the Bot process can judge it as its tools do.
 */
async function sessionActionOf(request: Request, deps: AuthzDeps): Promise<SessionAction | Decision> {
  switch (request.method) {
    case 'settings': {
      const payload = request.payload;
      return payload.type === 'save' || payload.type === 'act' ? { kind: 'settingsWrite' } : { kind: 'adminRead' };
    }
    case 'command': return { kind: 'adminRead' };
    case 'collaboration': return { kind: 'settingsWrite' };
    case 'schedule': {
      const task = request.payload.request;
      return { kind: 'schedule', action: task.action, ...('taskId' in task ? { taskId: task.taskId } : {}) };
    }
    case 'memory': {
      const memory = request.payload;
      switch (memory.type) {
        case 'list': case 'export': case 'events': return { kind: 'memory', op: 'read', target: memoryTarget(memory.scope) };
        case 'add': return { kind: 'memory', op: 'add', target: memoryTarget(memory.scope), text: memory.text };
        case 'edit': case 'archive': {
          const item = await deps.memoryItem?.(memory.scope, memory.itemId);
          if (!item) return denied('没有这条记忆。');
          return { kind: 'memory', op: 'edit', item: { scope: item.scope, source: item.source }, ...(memory.type === 'edit' && memory.text !== undefined ? { text: memory.text } : {}) };
        }
      }
    }
  }
  return denied(SESSION_DENIED);
}

/** A session a settings request names by its thread: a `session` scope, or a session's model list. */
function threadNamed(request: Request): string | undefined {
  if (request.method !== 'settings') return undefined;
  const payload = request.payload;
  const target = payload.type === 'read' ? payload.scope : payload.type === 'save' ? payload.edit.scope : undefined;
  if (target?.kind === 'session') return target.threadId;
  return payload.type === 'models' ? payload.query.threadId : undefined;
}

/**
 * The groups a session (or an owner's `--scope`) reaches, and the request checked against them. A reach of one group (a
 * group session; a private chat or an owner narrowed with `group=`) names only sessions of that group's project.
 */
async function withinReach(principal: BotSessionPrincipal, scope: Scope | null, who: Who, request: Request, deps: AuthzDeps): Promise<Decision> {
  const reaches = sessionGroups(principal, scope);
  const groups = principal.place === 'comment' ? [] : (await deps.groupsOf?.(principal.appId) ?? []).filter(group => reaches(group.chatId));
  const thread = threadNamed(request);
  if (thread !== undefined && (principal.place !== 'dm' || scope?.group !== undefined)) {
    const threads = new Set((await Promise.all(groups.map(group => deps.threadsOf?.(principal.appId, group.name) ?? []))).flat());
    if (!threads.has(thread)) return outOfReach();
  }
  return inReach(principal, scope, groups, request, who);
}

/** A Bot session, or the owner within a `--scope`: the owner's is only narrowed, with no place rules and nothing it names no bot for refused. */
type Who = 'session' | 'owner';

/**
 * devices-4a 4.5, the host's half: the request names this session's bot and only groups and projects it reaches
 * (`groups`, already narrowed to the place and `--scope`); a reply that lists more is cut down to them.
 */
function inReach(principal: BotSessionPrincipal, scope: Scope | null, groups: readonly BoundGroup[], request: Request, who: Who): Decision {
  const ok: Decision = { ok: true };
  const session = who === 'session';
  const own = (botId: string): boolean => botId === principal.appId;
  const chats = new Set(groups.map(group => group.chatId));
  const reaches = sessionGroups(principal, scope);
  // devices 5.3: a reach of one group (a group session; a private chat or the owner given `group=`) moves only that
  // group, whoever's turn it is: nothing of the whole bot, and no new group.
  const wholeBot = principal.place === 'dm' && scope?.group === undefined;
  const botWide = (): Decision => wholeBot ? ok : denied(ONE_GROUP_ONLY);
  const named = (projectName: string, groupId?: string): boolean => groups.some(group => group.name === projectName && (groupId === undefined || group.chatId === groupId));
  const narrow = (cut: (payload: never) => unknown): Decision => ({ ok: true, narrow: <T>(payload: T): T => cut(payload as never) as T });
  /** A settings reply's views as settings_get shows them: read's, and those a saved or conflicting act answers with. */
  const settingsShown = (decision: Decision): Decision => !decision.ok || !session ? decision
    : narrow((reply: SettingsReply) => sessionReply(reply, principal.place === 'group'));
  switch (request.method) {
    case 'snapshot': return narrow((snapshot: DesktopSnapshot) => (session ? sessionSnapshot : filterSnapshot)(snapshot, principal, scope));
    case 'admin': {
      // A session's row lets through only daemonStatus and negotiate, which name no bot; the owner's name theirs.
      const admin = request.payload;
      if (!('agentId' in admin) || admin.agentId === undefined) return ok;
      if (!own(admin.agentId)) return outOfReach();
      if (admin.type === 'switchBackend') return named(admin.projectName) ? ok : outOfReach();
      return admin.type === 'confirmCardCallback' ? botWide() : ok;
    }
    case 'command': return commandInReach(request.payload, session, own, reaches, botWide, narrow);
    case 'settings': {
      const payload = request.payload;
      const scoped = (target: SettingsScope): boolean => target.kind === 'host' ? !session : own(target.botId) && (target.kind !== 'project' || named(target.projectName));
      switch (payload.type) {
        case 'read': return scoped(payload.scope) ? settingsShown(ok) : outOfReach();
        case 'save': {
          if (!scoped(payload.edit.scope)) return outOfReach();
          return payload.edit.scope.kind === 'agent' ? botWide() : ok;
        }
        case 'act': {
          const action = payload.action;
          if (!own(action.botId)) return outOfReach();
          // Codex review 239-2 / 240-1: a saved or conflicting act answers with the whole view, cut as read's is.
          if ('projectName' in action) return named(action.projectName) ? settingsShown(ok) : outOfReach();
          return settingsShown(botWide());
        }
        case 'models': return own(payload.query.botId) ? ok : outOfReach();
        case 'sessions': {
          if (!own(payload.botId) || !named(payload.projectName)) return outOfReach();
          return narrow((reply: SettingsReply) => reply.kind === 'sessions' ? { ...reply, sessions: reply.sessions.filter(session => chats.has(session.chatId)) } : reply);
        }
      }
      return outOfReach();
    }
    case 'collaboration': {
      const payload = request.payload;
      // Neither names a bot: a session's table row decides on them (usage is denied there).
      if (payload.action === 'providerModels' || payload.action === 'usage') return ok;
      if (payload.action === 'createProject') return own(payload.agentId) ? botWide() : outOfReach();
      if (!('agentId' in payload) || !own(payload.agentId) || !named(payload.projectName, payload.groupId)) return outOfReach();
      // The provider lists its sessions by folder: another group's sharing it, and the owner's own from a terminal.
      // Only those bound to this group are known to be its (Codex review 228-1, 229-1).
      return payload.action !== 'history' ? ok : narrow((reply: CollaborationReply) => reply.kind !== 'history' ? reply
        : { ...reply, threads: reply.threads.filter(thread => reply.sessions.some(bound => bound.sessionId === thread.sessionId)) });
    }
    case 'library': {
      const library = request.payload;
      const projects = new Set(groups.flatMap(group => group.projectId ? [group.projectId] : []));
      switch (library.type) {
        case 'list':
          return narrow((reply: LibraryReply) => reply.kind !== 'list' ? reply : {
            ...reply, unlinked: 0,
            projects: reply.projects.map(project => ({ ...project, bindings: project.bindings.filter(binding => own(binding.agentId) && chats.has(binding.groupId)) }))
              .filter(project => project.bindings.length > 0),
          });
        case 'previous': return own(library.agentId) && reaches(library.groupId) ? ok : outOfReach();
        // A project none of the groups reached is bound to (one no group uses, to delete) is out of reach.
        default: return projects.has(library.projectId) ? ok : outOfReach();
      }
    }
    case 'memory': return memoryInReach(request.payload, principal, scope, groups, who);
    case 'schedule': {
      const { botId, request: task } = request.payload;
      if (!own(botId)) return outOfReach();
      if ('chatId' in task) return chats.has(task.chatId) ? ok : outOfReach();
      // listBot, which a session's row denies: the owner's, cut to the one group its --scope names.
      return scope?.group === undefined ? ok : narrow((reply: ScheduleReply) => reply.kind === 'tasks' ? { ...reply, tasks: reply.tasks.filter(item => chats.has(item.chatId)) } : reply);
    }
    default: return session ? outOfReach() : ok;
  }
}

/**
 * A command by what it moves: the machine (restarting the host, cancelling a job), no session's and the owner's as it
 * is; a bot, its own and only with the whole bot reached; a group, one reached. A new bot is outside any reach.
 */
function commandInReach(command: Command, session: boolean, own: (botId: string) => boolean, reaches: (groupId: string) => boolean,
  botWide: () => Decision, narrow: (cut: (payload: never) => unknown) => Decision): Decision {
  const ok: Decision = { ok: true };
  switch (command.type) {
    case 'refresh': return ok;
    case 'restartHost': case 'cancelJob': return session ? outOfReach() : ok;
    case 'registerAgent': return outOfReach();
    case 'refreshAgentCredentials': case 'setAgentEnabled': case 'deleteAgent': return own(command.agentId) ? botWide() : outOfReach();
    case 'bindGroup': case 'listGroupMembers': return own(command.agentId) && reaches(command.groupId) ? ok : outOfReach();
    case 'setResponse': case 'setPermission': {
      const target = membershipOf(command.membershipId);
      return target && own(target.agentId) && reaches(target.groupId) ? ok : outOfReach();
    }
    case 'listPendingGroups': case 'listJoinedGroups':
      if (!own(command.agentId)) return outOfReach();
      // A private chat's own joined and pending groups (D4b asks whose turn it is); a group session's only its own.
      return narrow((result: CommandResult) => result.kind === 'groups' ? { ...result, groups: result.groups.filter(group => reaches(group.id)) }
        : result.kind === 'pendingGroups' ? { ...result, groups: result.groups.filter(group => reaches(group.chatId)) } : result);
  }
}

/** A membership's id is its bot and group (`server/projection.ts`); the command finds it by exactly that id. */
function membershipOf(id: string): { agentId: string; groupId: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(id);
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [agentId, groupId] = parsed as unknown[];
    return typeof agentId === 'string' && typeof groupId === 'string' ? { agentId, groupId } : undefined;
  } catch { return undefined; }
}

/**
 * A session reads settings as settings_get does, in a private chat only: its sections, and nothing the tool leaves out
 * but what the view's schema requires. The judge prompt, the skills and their paths, the bot's profile, the roster's
 * names, which decision models have a key (the keystore's), the role draft and who of the administrators Feishu or the
 * scan made stay out: the command line reaches no further than the tools (devices 5; devices-4b 4.5a, SEC-4).
 */
function sessionView(view: SettingsView, group: boolean): SettingsView {
  // A group session reads no settings (settings-dm-only: read.* and act are refused before): fail closed if one comes.
  if (group || view.scope.kind === 'host') throw new RpcError('permission_denied', OUT_OF_REACH);
  if (view.scope.kind === 'project') {
    const project = view as ProjectSettingsView;
    const { roster: _names, ...members } = project.members;
    const shown: ProjectSettingsView = { scope: project.scope, sections: project.sections, identity: project.identity, members };
    return shown;
  }
  if (view.scope.kind === 'session') return view;
  const agent = view as AgentSettingsView;
  const { openIds, revision } = agent.administrators;
  const shown: AgentSettingsView = { scope: agent.scope, sections: agent.sections, ownerOpenId: agent.ownerOpenId, administrators: { openIds, revision },
    voice: agent.voice, commentInstructions: agent.commentInstructions };
  return shown;
}

/** Every view a settings reply carries, as a session reads it: read's, and the bot's or group's a saved or conflicting act answers with. */
function sessionReply(reply: SettingsReply, group: boolean): SettingsReply {
  if (reply.kind === 'view') return { ...reply, view: sessionView(reply.view, group) };
  if (reply.kind !== 'acted') return reply;
  const result = reply.result;
  if (result.kind !== 'saved' && result.kind !== 'conflict') return reply;
  return { ...reply, result: { ...result, view: sessionView(result.view, group) as typeof result.view } };
}

/**
 * Memory of this bot and of the projects of the groups reached. A private chat's memory is reached from a private chat's
 * session (its Bot process then keeps it to the turn's own person) and by the owner, while no group is named.
 */
function memoryInReach(request: MemoryRequest, principal: BotSessionPrincipal, scope: Scope | null, groups: readonly BoundGroup[], who: Who): Decision {
  // s1b: a group session reads the entries as memory_list shows them, the authors and the archived ones left out.
  const ok: Decision = who === 'session' && principal.place === 'group'
    ? { ok: true, narrow: <T>(payload: T): T => groupMemoryReply(payload as MemoryReply) as T } : { ok: true };
  // newCounts and seen name no memory: the owner's, and a session's row denies them.
  if (!('scope' in request)) return who === 'owner' ? ok : outOfReach();
  const projects = new Set(groups.flatMap(group => group.projectId ? [group.projectId] : []));
  const target = request.scope;
  if (request.type === 'promote' && request.botId !== principal.appId) return outOfReach();
  if (request.type === 'move' && !projects.has(request.to.projectId)) return outOfReach();
  if (target.kind === 'project') return projects.has(target.projectId) ? ok : outOfReach();
  if (target.botId !== principal.appId) return outOfReach();
  if (target.kind === 'dm') return (who === 'owner' || principal.place === 'dm') && scope?.group === undefined ? ok : outOfReach();
  return ok;
}

/** An entry as a group reads it (s1b): its text, branch, trust and revision; who wrote or last edited it, where and why, blank. */
function groupMemoryItem(item: MemoryItem): MemoryItem {
  const { lastEditedBy: _edited, source, ...rest } = item;
  return { ...rest, source: { via: source.via, botId: '', actorRole: source.actorRole } };
}

/**
 * A memory reply as a group session reads it (s1b, "nothing beyond the memory rules"): memory_list's view of the same
 * entries. The active ones only, no authors (a branch's maker blank unless the system's), none of the owner page's marks.
 */
function groupMemoryReply(reply: MemoryReply): MemoryReply {
  switch (reply.kind) {
    case 'list': {
      const { lastEventId: _last, newIds: _ids, newBranches: _new, madeRoom: _room, ...rest } = reply;
      return {
        ...rest, problems: [],
        items: reply.items.filter(item => item.state === 'active').map(groupMemoryItem),
        branches: reply.branches.map(branch => branch.fixed ? branch : { ...branch, createdBy: '' }),
      };
    }
    case 'item': return { ...reply, item: groupMemoryItem(reply.item) };
    case 'conflict': return reply.current ? { ...reply, current: groupMemoryItem(reply.current) } : reply;
    case 'branches': return { ...reply, branches: reply.branches.map(branch => branch.fixed ? branch : { ...branch, createdBy: '' }) };
    default: return reply;
  }
}
