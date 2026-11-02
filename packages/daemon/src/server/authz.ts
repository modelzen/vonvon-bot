import {
  MAINTENANCE_KINDS, PROTOCOL_VERSION, rpcKindOf,
  type CommandResult, type DesktopSnapshot, type LibraryReply, type MemoryRequest, type Request, type Scope, type SettingsReply, type SettingsScope,
} from '@vonvon/protocol';
import { NOT_DM_MESSAGE } from '../agent/entry/registry';
import { scheduleRefusalMessages } from '../admin/schedule-commands';
import { bridgeVersion } from '../core/version';
import { RpcError } from './errors';
import { filterSnapshot, sessionGroups, type BotSessionPrincipal } from './snapshot-filter';
import type { Peer } from './ws';

/** host: decided in the host (D4a); bot: the ★ rows, asked of the Bot process (D4b). */
export type BotSessionRule = 'deny' | 'host' | 'bot';
export type SessionPlace = BotSessionPrincipal['place'];
/** One place's cell of the bot-session column (devices 5.2): who decides, or a refusal and the sentence it reads. */
export type PlaceRule = 'host' | 'bot' | 'deny' | 'not-dm' | 'not-group';
/** `maintenance`: a connection of another protocol may ask it. `botSession` sums up `places`: `bot` if any place asks the Bot process. */
export interface Rule { owner: 'allow'; botSession: BotSessionRule; maintenance: boolean; places: Readonly<Record<SessionPlace, PlaceRule>> }
/** Who started the turn behind a Bot session's ★ request (D4b fills it from the Bot process; D4a's stand-in is `member`). */
export interface SessionGrant { role: 'owner' | 'admin' | 'member' | 'bot'; openId?: string }
export type DenialCode = 'permission_denied' | 'protocol_mismatch' | 'scope_required' | 'not-dm' | 'not-group' | 'not_in_session';
/**
 * `narrow`: what of the reply a Bot session gets (its bot, its groups); `grant`: a ★ request's turn.
 * `details` goes into the error envelope (a `protocol_mismatch` names both versions).
 */
export type Decision =
  | { ok: true; grant?: SessionGrant; narrow?: <T>(payload: T) => T }
  | { ok: false; code: DenialCode; message: string; details?: Record<string, unknown> };
/** A bot's bound group: its project name, its chat and its library project. */
export interface BoundGroup { name: string; chatId: string; projectId?: string }
export type BotAnswer = { ok: true; role: SessionGrant['role']; openId?: string } | { ok: false; reason: string; message: string };
/** What the bot-session checks read. D4b adds `askBot`, which maps the kind to the Bot process's own check. */
export interface AuthzDeps {
  groupsOf?(appId: string): Promise<readonly BoundGroup[]>;
  askBot?(appId: string, sessionId: string, kind: string, request: Request): Promise<BotAnswer>;
}

/** devices 15: the sentences a Bot session's command line reads. */
export const SCOPE_MISSING = '这次调用来自 Bot 会话，必须带 `--scope bot=<appId>[,group=<chatId>]`，而且不能比会话本身的范围大。';
export const scopeExceeded = (bot: string, group: string): string => `范围超过了这条会话（只能是 bot=${bot}, group=${group}）。不要重试更大的范围。`;
export const SESSION_DENIED = '这个操作不能从 Bot 会话里做。';
const MAINTENANCE = new Set<string>(MAINTENANCE_KINDS);
const PLACES = ['dm', 'group', 'comment'] as const;
const ALL = (cell: PlaceRule): Record<SessionPlace, PlaceRule> => ({ dm: cell, group: cell, comment: cell });
/** Read in a group, asked of the Bot process in a private chat, not in a comment. */
const READ = { dm: 'bot', group: 'host', comment: 'deny' } as const;
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
 */
export const RULES: ReadonlyMap<string, Rule> = new Map([
  ...rows('snapshot', 'get', 'host'),
  ...rows('command', 'refresh listPendingGroups listJoinedGroups listGroupMembers', READ),
  ...rows('command', 'registerAgent refreshAgentCredentials installCodex startCodexLogin restartHost bindGroup setAgentEnabled deleteAgent cancelJob'),
  // The desktop's older permission and reply switches: settings writes, which the command line makes as settings set.
  ...rows('command', 'setResponse setPermission', { dm: 'deny', group: 'not-dm', comment: 'not-dm' }),
  ...rows('settings', 'read.host save.host'),
  ...rows('settings', 'read.agent read.session', { dm: 'bot', group: 'deny', comment: 'deny' }),
  ...rows('settings', 'read.project models sessions', READ),
  ...rows('settings', 'save.agent save.project save.session act.voice act.adminMember act.projectMember act.projectAudience act.commentInstructions', WRITE),
  ...rows('collaboration', 'history context project providerModels usage', { dm: 'host', group: 'host', comment: 'deny' }),
  ...rows('collaboration', 'createProject editProject', WRITE),
  ...rows('collaboration', 'removeProject clear compact resume startGoal stop stopSubagent endGoal reminder shareUsage'),
  ...rows('environment', `scan backendCatalog backendVersion backendInstall backendInstallStatus cancelBackendInstall backendUninstall backendLogin
    install update toolInstallStatus cancelInstall uninstall authStatus startLogin loginStatus cancelLogin
    profileList profileUse profileAdd profileInit profileInitStatus profileInitCancel`),
  ...rows('machine', `mcp.list mcp.add mcp.remove bridgeImport.detect bridgeImport.preflight bridgeImport.start bridgeImport.status bridgeImport.rollback
    status service.install service.start service.stop service.uninstall setServiceSkipped startHost stopHost logs
    checkCoreUpdate applyCoreUpdate coreUpdateStatus`),
  ...rows('admin', `judgeUsage state diagnosis hostDoctor setupStatus cardCallbackStatus confirmCardCallback codexSetup logs followLogs
    switchBackend secrets setSecret removeSecret testSecret`),
  ...rows('admin', 'daemonStatus negotiate', 'host'),
  ...rows('directory', 'list suggest choose'),
  ...rows('library', 'list', 'host'),
  ...rows('library', 'workspace rename previous delete'),
  // Only what the memory tools do (memory_list, memory_add, memory_update, memory_forget), and reading it out; the rest is the owner's.
  ...rows('memory', 'list export events add edit archive', { dm: 'bot', group: 'bot', comment: 'deny' }),
  ...rows('memory', 'restore promote move branchRename branchMerge confirm purge undo reseal seen newCounts'),
  ...rows('contextPreview', 'get'),
  ...rows('schedule', 'list create edit pause resume delete runNow', { dm: 'not-group', group: 'bot', comment: 'not-group' }),
  ...rows('schedule', 'listBot', { dm: 'not-group', group: 'deny', comment: 'not-group' }),
  ...rows('device', 'status enable disable setPort pair clients renameClient revokeClient rename'),
]);

const denied = (message: string): Decision => ({ ok: false, code: 'permission_denied', message });
const OUT_OF_REACH = '这次调用碰到了这条 Bot 会话范围以外的 Bot、群或项目。';
const outOfReach = (): Decision => denied(OUT_OF_REACH);
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

/** Before every request is dispatched (http.ts). */
export async function authorize(peer: Pick<Peer, 'principal' | 'protocolVersion' | 'negotiated' | 'scope'>, request: Request, deps: AuthzDeps = {}): Promise<Decision> {
  const kind = rpcKindOf(request);
  const rule = RULES.get(kind);
  if (!rule) return denied(`这个 daemon 没有登记 ${kind} 的权限，不处理它。`);
  switch (peer.principal.kind) {
    case 'owner': return { ok: true };
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
  if (!peer.negotiated && kind !== 'admin.daemonStatus' && kind !== 'admin.negotiate') return { ok: false, code: 'scope_required', message: SCOPE_MISSING };
  const cell = rule.places[principal.place];
  switch (cell) {
    case 'deny': return denied(SESSION_DENIED);
    case 'not-dm': return { ok: false, code: 'not-dm', message: NOT_DM_MESSAGE };
    case 'not-group': return { ok: false, code: 'not-group', message: scheduleRefusalMessages['not-group'] };
    case 'host': case 'bot': break;
  }
  const reaches = sessionGroups(principal, peer.scope);
  const groups = principal.place === 'comment' ? [] : (await deps.groupsOf?.(principal.appId) ?? []).filter(group => reaches(group.chatId));
  const decision = inReach(principal, peer.scope, groups, request);
  if (!decision.ok || cell === 'host') return decision;
  // ★ (devices 5.2): who started this turn and whether it is still going is the Bot process's to say (D4b).
  // D4a, temporarily: without askBot a ★ request within the session's reach is let through as a member's; D4b refuses it instead.
  if (!deps.askBot) return { ...decision, grant: { role: 'member' } };
  const answer = await deps.askBot(principal.appId, principal.sessionId, kind, request);
  if (!answer.ok) return { ok: false, code: answer.reason === 'not-dm' ? 'not-dm' : 'permission_denied', message: answer.message, details: { reason: answer.reason } };
  return { ...decision, grant: { role: answer.role, ...(answer.openId ? { openId: answer.openId } : {}) } };
}

/**
 * devices-4a 4.5, the host's half: the request names this session's bot and only groups and projects it reaches
 * (`groups`, already narrowed to the place and `--scope`); a reply that lists more is cut down to them.
 */
function inReach(principal: BotSessionPrincipal, scope: Scope | null, groups: readonly BoundGroup[], request: Request): Decision {
  const ok: Decision = { ok: true };
  const own = (botId: string): boolean => botId === principal.appId;
  const chats = new Set(groups.map(group => group.chatId));
  const reaches = sessionGroups(principal, scope);
  const named = (projectName: string, groupId?: string): boolean => groups.some(group => group.name === projectName && (groupId === undefined || group.chatId === groupId));
  const narrow = (cut: (payload: never) => unknown): Decision => ({ ok: true, narrow: <T>(payload: T): T => cut(payload as never) as T });
  switch (request.method) {
    case 'snapshot': return narrow((snapshot: DesktopSnapshot) => filterSnapshot(snapshot, principal, scope));
    case 'admin': return ok;
    case 'command': {
      const command = request.payload;
      if (command.type === 'refresh') return ok;
      if (!('agentId' in command) || !own(command.agentId)) return outOfReach();
      if (command.type === 'listGroupMembers') return reaches(command.groupId) ? ok : outOfReach();
      // A private chat's own joined and pending groups (D4b asks whose turn it is); a group session's only its own.
      return narrow((result: CommandResult) => result.kind === 'groups' ? { ...result, groups: result.groups.filter(group => reaches(group.id)) }
        : result.kind === 'pendingGroups' ? { ...result, groups: result.groups.filter(group => reaches(group.chatId)) } : result);
    }
    case 'settings': {
      const payload = request.payload;
      const scoped = (target: SettingsScope): boolean => target.kind !== 'host' && own(target.botId) && (target.kind !== 'project' || named(target.projectName));
      switch (payload.type) {
        case 'read': {
          if (!scoped(payload.scope)) return outOfReach();
          return principal.place === 'group' ? narrow(readOnlyInGroup) : ok;
        }
        case 'save': return scoped(payload.edit.scope) ? ok : outOfReach();
        case 'act': {
          const action = payload.action;
          if (!own(action.botId)) return outOfReach();
          return 'projectName' in action && !named(action.projectName) ? outOfReach() : ok;
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
      if (payload.action === 'providerModels' || payload.action === 'usage') return ok;
      if (payload.action === 'createProject') return own(payload.agentId) ? ok : outOfReach();
      return 'agentId' in payload && own(payload.agentId) && named(payload.projectName, payload.groupId) ? ok : outOfReach();
    }
    case 'library':
      return narrow((reply: LibraryReply) => reply.kind !== 'list' ? reply : {
        ...reply, unlinked: 0,
        projects: reply.projects.map(project => ({ ...project, bindings: project.bindings.filter(binding => own(binding.agentId) && chats.has(binding.groupId)) }))
          .filter(project => project.bindings.length > 0),
      });
    case 'memory': return memoryInReach(request.payload, principal, groups) ? ok : outOfReach();
    case 'schedule': {
      const { botId, request: task } = request.payload;
      return own(botId) && 'chatId' in task && chats.has(task.chatId) ? ok : outOfReach();
    }
    default: return outOfReach();
  }
}

/** A group session reads its group's settings, each part marked read-only with the reason the tools give (settings_get). */
function readOnlyInGroup(reply: SettingsReply): SettingsReply {
  if (reply.kind !== 'view') return reply;
  const access = { kind: 'readonly' as const, reason: 'not-dm' as const, message: NOT_DM_MESSAGE };
  const sections = Object.fromEntries(Object.entries(reply.view.sections).map(([name, section]) => [name, section && { ...section, access }]));
  // Which decision models have a key is the keystore's, not the group's.
  const { decisionModels: _keys, ...view } = reply.view as typeof reply.view & { decisionModels?: unknown };
  return { ...reply, view: { ...view, sections } as typeof reply.view };
}

/** Memory of this bot, of the projects of the groups it reaches, and in a private chat that chat's memory of this bot. */
function memoryInReach(request: MemoryRequest, principal: BotSessionPrincipal, groups: readonly BoundGroup[]): boolean {
  if (!('scope' in request)) return false;
  const projects = new Set(groups.flatMap(group => group.projectId ? [group.projectId] : []));
  const scope = request.scope;
  if (scope.kind === 'project') return projects.has(scope.projectId);
  if (scope.botId !== principal.appId) return false;
  return scope.kind === 'bot' || principal.place === 'dm';
}
