import { MAINTENANCE_KINDS, PROTOCOL_VERSION, rpcKindOf, type Request } from '@vonvon/protocol';
import type { Peer } from './ws';

/** host: D4a decides in the host; bot: the ★ rows, asked of the Bot process (D4b). */
export type BotSessionRule = 'deny' | 'host' | 'bot';
/** `maintenance`: a connection of another protocol may ask it. */
export interface Rule { owner: 'allow'; botSession: BotSessionRule; maintenance: boolean }
export type Decision = { ok: true } | { ok: false; code: 'permission_denied' | 'protocol_mismatch' | 'scope_required' | 'not-dm' | 'not_in_session'; message: string };
/** D4a adds what its checks read (a bot's groups, the Bot process for ★). */
export type AuthzDeps = Record<string, never>;
const MAINTENANCE = new Set<string>(MAINTENANCE_KINDS);
const rows = (method: string, types: string): Array<[string, Rule]> => types.split(/\s+/).filter(Boolean).map(type => {
  const kind = `${method}.${type}`;
  return [kind, { owner: 'allow', botSession: 'deny', maintenance: MAINTENANCE.has(kind) }];
});
/** devices 5.2: one row per `rpcKinds()` name, written out, so a new RPC is refused until it gets a row here (test/authz.test.ts
 * checks both ways). D1: the owner may do everything, a bot session nothing yet (D4a fills that column). */
export const RULES: ReadonlyMap<string, Rule> = new Map([
  ...rows('snapshot', 'get'),
  ...rows('command', `refresh listPendingGroups registerAgent refreshAgentCredentials restartHost
    listJoinedGroups listGroupMembers bindGroup setResponse setPermission setAgentEnabled deleteAgent cancelJob`),
  ...rows('settings', `read.host read.agent read.project read.session save.host save.agent save.project save.session
    act.voice act.adminMember act.projectMember act.projectAudience act.commentInstructions models sessions`),
  ...rows('collaboration', `providerModels createProject project editProject removeProject history context clear compact resume startGoal stop
    stopSubagent endGoal reminder usage shareUsage`),
  ...rows('environment', `scan backendCatalog backendVersion backendInstall backendInstallStatus cancelBackendInstall backendUninstall backendLogin
    install update toolInstallStatus cancelInstall uninstall authStatus startLogin loginStatus cancelLogin
    profileList profileUse profileAdd profileInit profileInitStatus profileInitCancel`),
  ...rows('machine', `mcp.list mcp.add mcp.remove bridgeImport.detect bridgeImport.preflight bridgeImport.start bridgeImport.status bridgeImport.rollback
    status service.install service.start service.stop service.uninstall setServiceSkipped startHost stopHost logs
    checkCoreUpdate applyCoreUpdate coreUpdateStatus`),
  ...rows('admin', `judgeUsage state diagnosis hostDoctor setupStatus cardCallbackStatus confirmCardCallback daemonStatus codexSetup logs followLogs
    switchBackend secrets setSecret removeSecret testSecret negotiate`),
  ...rows('directory', 'list suggest choose'),
  ...rows('library', 'list workspace rename previous delete'),
  ...rows('memory', 'list add edit archive restore promote move branchRename branchMerge confirm purge undo export reseal events seen newCounts'),
  ...rows('contextPreview', 'get'),
  ...rows('schedule', 'list listBot create edit pause resume delete runNow'),
  ...rows('device', 'status enable disable setPort pair clients renameClient revokeClient rename'),
]);

const denied = (message: string): Decision => ({ ok: false, code: 'permission_denied', message });
/** Before every request is dispatched (http.ts). D4a replaces the refusals of the other principals with its real checks. */
export async function authorize(peer: Pick<Peer, 'principal' | 'protocolVersion' | 'negotiated' | 'scope'>, request: Request, _deps: AuthzDeps = {}): Promise<Decision> {
  const kind = rpcKindOf(request);
  const rule = RULES.get(kind);
  if (!rule) return denied(`这个 daemon 没有登记 ${kind} 的权限，不处理它。`);
  switch (peer.principal.kind) {
    case 'owner': return { ok: true };
    case 'maintenance':
      return rule.maintenance ? { ok: true } : denied(`这个客户端用的协议版本是 ${peer.protocolVersion}，daemon 的是 ${PROTOCOL_VERSION}，这条连接只能查状态、升级或停止 daemon。把较旧的那一边升级到同一个版本。`);
    default: return denied('这个操作不能从这条连接里做。');
  }
}
