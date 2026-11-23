import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { NATIVE_RECIPE_PREVIEW_CAPABILITY, recipeAuthoringReplySchema, CLOSE_CODES, DRAIN_KINDS, PROTOCOL_VERSION, rpcKindOf, serverInfoSessionSchema, serverInfoV1Schema, serverInfoV2Schema, type Request, type Response } from '@vonvon/protocol';
import type { AdminService } from '../admin/service';
import type { ShutdownControl } from '../host/lifecycle';
import { createServiceActionLauncher } from '../host/service-action';
import { paths } from '../config/paths';
import { bridgeVersion } from '../core/version';
import { createDirectoryBrowser } from './directory-browser';
import { memoryRpc } from './rpc/memory';
import { memoryStoreFor } from '../admin/memory';
import { SESSION_TURN_ENDED } from '../agent/entry/registry';
import { contextPreviewRpc } from './rpc/context-preview';
import { scheduleRpc } from './rpc/schedule';
import { Jobs } from './jobs';
import { LogFollowers } from './logs';
import { createSnapshotStore, hostPlatform, type SnapshotStore } from './snapshot';
import { createSocketServer, type Peer, type PeerView } from './ws';
import { createPeerHub } from './peer-hub';
import type { SecureDeps } from './secure-socket';
import type { RpcOutcome } from './rpc';
import { adminRpc } from './rpc/admin';
import { commandRpc } from './rpc/command';
import { collaborationRpc } from './rpc/collaboration';
import { environmentRpc } from './rpc/environment';
import { libraryRpc } from './rpc/library';
import { isDesktopShell, machineRpc } from './rpc/machine';
import { createBundledUpdate, type BundledUpdate } from '../service/bundled-update';
import type {BridgeImporter} from '../import/bridge/transaction';
import { settingsRpc } from './rpc/settings';
import { createLocalIdentity } from './local-credential';
import { drainingError, errorEnvelope, RpcError } from './errors';
import { authorize, MAINTENANCE_STRIKES, type AuthzDeps } from './authz';
import { filterSnapshot, scopedOwner, sessionSnapshot } from './snapshot-filter';
import { createSessionTokens, type SessionTokens } from '../host/session-tokens';
import { principalWire } from './principal';
import { deviceRpc } from './rpc/device';
import { deviceKeyPair, holdDevice, loadOrCreateDevice } from '../remote/device';
import { createClientRegistry, type ClientRegistry } from '../remote/clients';
import { completePairing, followRevocations, createInviteBook } from '../remote/pairing';
import { networkIdentity, type EnableDeps } from '../remote/address';
import { readRemoteConfig, type RemoteConfig } from '../remote/config';
import { createRateLimiter } from '../remote/rate-limit';
import { tailscaleIps } from '../remote/tailscale';
import { createCandidates } from '../remote/candidates';
import { peerOwner } from './peer-label';
import { createRemoteListeners, type RemoteListenerDeps, type RemoteListeners } from './remote-listeners';
import { log } from '../core/logger';
import { serveWebUi } from './web-ui';
import { getPidLockInfo, type PidLockInfo } from './pid-lock';
import { runtimeDistribution } from '../service/distribution';
import { EnvironmentService, type EnvironmentServiceOptions } from '../environment/service';
import { refreshCodexResolution } from '../agent/codex-appserver/locate';
import { RecipeInstaller } from '../recipe/installer';
import { recipeInstallRpc } from './rpc/recipe-install';
import { configuredRecipeApiOrigin } from '../config/account-deployment';

export interface ApiLifetime {
  beginDrain(): Promise<void>;
  release(): Promise<void>;
}

export class ApiCleanupError extends AggregateError {
  constructor(errors: Iterable<unknown>) {
    super(errors, 'API listener closed with cleanup errors');
    this.name = 'ApiCleanupError';
  }
}

export interface DaemonApi extends ApiLifetime {
  port: number;
  listen: string;
  invalidate(): void;
  close(): Promise<void>;
  /** devices-2 4.4: what a secure socket server needs of this daemon. D3's remote listeners take it; the manual probe too. */
  readonly secure?: SecureDeps;
}

/** devices 4.7: what a draining daemon still answers (`control`); the rest reads `draining`. */
const DRAINING = new Set<string>(DRAIN_KINDS);

/** Test seams for the login-time service: the platform and spawn of the helper launcher, and the manager read. */
type ServiceSeams = Pick<Parameters<typeof createServiceActionLauncher>[0], 'platform' | 'spawn'> & Pick<Parameters<typeof createSnapshotStore>[0], 'readService'>;

/** Test seams for the remote listeners (D3): this machine's interfaces, Tailscale and LAN network, the classification
 * (a loopback alias passes for a LAN address), the retry timers and the secure channel's. */
export type RemoteSeams = Partial<Pick<EnableDeps, 'interfaces' | 'tailscale' | 'networkIdentity' | 'classify'>> & Pick<RemoteListenerDeps, 'timers' | 'secureTimers'>;

/**
 * devices 4.5: what this daemon reports in a v2 server info: `remote` while an address is opened (D3); `session-scope`:
 * Bot sessions' tokens and `--scope` (D4a). A daemon that updates itself says so (devices 6.5, devices-ui-2 4.11); one
 * the desktop app carries is updated by that app (U4), except on Windows for 0.9.0 (owner 2026-11-02).
 */
export const capabilities = (distribution?: string, remoteOpen = false, platform: NodeJS.Platform = process.platform): string[] => [
  'device', 'session-scope', 'attention.group', ...remoteOpen ? ['remote'] : [],
  ...distribution === 'standalone' ? ['update.standalone'] : distribution === 'global-npm' ? ['update.npm']
    : distribution === 'bundled' && platform !== 'win32' ? ['update.bundled'] : [],
];

/** How many pages of a group's members (100 each) `knowsMember` reads before it gives up: an id it did not find is refused. */
const MEMBER_PAGES = 100;

/**
 * devices-4a 4.7: what each connection gets of a published event. The owner all of it, its snapshot cut to its `--scope`
 * if it gave one; a Bot session whose token still stands, once it negotiated its scope, its own part of the snapshot and
 * nothing else; a connection of another protocol (the maintenance subset) none: a protocol 1 client parses a snapshot
 * strictly, and a `windows` platform would break it (devices-ui-2 4.5).
 */
export const viewFor = (tokens: Pick<SessionTokens, 'active'>): PeerView => (peer, event) => {
  const principal = peer.principal;
  if (principal.kind === 'owner') return peer.scope && event.event === 'snapshot' ? { ...event, payload: filterSnapshot(event.payload, scopedOwner(peer.scope), peer.scope) } : event;
  if (principal.kind !== 'bot-session' || !tokens.active(principal.sessionId)) return null;
  if (peer.negotiated && event.event === 'snapshot') return { ...event, payload: sessionSnapshot(event.payload, principal) };
  return null;
};

/**
 * `startedAt`: when this daemon process started (epoch ms), in every daemonStatus reply (devices 4.7). `sessionTokens`: the
 * Bot sessions' tokens the host issues to its bots (devices-4a 4.1), which a session's hello is checked against.
 * `askBot`: a session's Bot process, asked about a ★ request (devices-4b 4.3); without it those are refused. `distribution`:
 * how this daemon was installed, for serverInfo's `update.*` (devices-ui-2 4.11).
 */
export async function startApi(options: { service: AdminService; port?: number; control?: ShutdownControl; environmentOptions?: EnvironmentServiceOptions; serviceActions?: ServiceSeams; bridgeImport?: BridgeImporter; diagnostics?: Parameters<typeof createSnapshotStore>[0]['diagnostics']; crashes?: Parameters<typeof createSnapshotStore>[0]['crashes']; startedAt?: number; sessionTokens?: SessionTokens; askBot?: AuthzDeps['askBot']; remote?: RemoteSeams; distribution?: () => Promise<{ kind: string }>; recipeInstall?: {brokerOrigin?:string; apiOrigin: string; allowLoopbackForTests?: boolean} }): Promise<DaemonApi> {
  const startedAt = options.startedAt ?? Math.round(performance.timeOrigin);
  // How this daemon was installed, read once (it may ask npm) and kept; until it is known the server info says nothing of updates.
  let distribution: string | undefined;
  const installed: Promise<{ kind: string; cliPath?: string }> = (options.distribution ?? runtimeDistribution)();
  void installed.then(found => { distribution = found.kind; }, () => undefined);
  const sessionTokens = options.sessionTokens ?? createSessionTokens();
  /** What the bot-session checks read: a bot's bound groups and their sessions, from its files (the snapshot can be 5 s old). */
  const authzDeps: AuthzDeps = {
    groupsOf: async appId => (await options.service.listProjects(appId))
      .map(project => ({ name: project.name, chatId: project.chatId, ...(project.projectId ? { projectId: project.projectId } : {}) })),
    threadsOf: async (appId, projectName) => (await options.service.listSessions(appId, projectName)).map(session => session.threadId),
    sessionActive: sessionId => sessionTokens.active(sessionId, true),
    ...(options.askBot ? { askBot: options.askBot } : {}),
    memoryItem: async (scope, itemId) => (await memoryStoreFor(scope)).get(itemId),
    botName: async appId => (await options.service.listBots()).find(bot => bot.appId === appId)?.name ?? appId,
    knowsMember: async (appId, projectName, openId) => {
      const chatId = (await options.service.listProjects(appId)).find(project => project.name === projectName)?.chatId;
      if (!chatId || !options.service.groupMembers) return false;
      let cursor: string | undefined;
      for (let page = 0; page < MEMBER_PAGES; page++) {
        const members = await options.service.groupMembers(appId, chatId, cursor);
        if (members.members.some(member => member.openId === openId)) return true;
        if (!members.nextCursor) return false;
        cursor = members.nextCursor;
      }
      return false;
    },
  };
  /** devices 5.3: a session that ends (revoked, its bot's process gone, idle) closes the connections made with its token. */
  let stopEnding: (() => void) | undefined;
  /** Requests refused in a row to a connection of another protocol (devices 4.7: 20 close it). */
  const strikes = new WeakMap<Peer, number>();
  let acquiredServer: ReturnType<typeof createServer> | undefined;
  let acquiredJobs: Jobs | undefined;
  let acquiredLogs: LogFollowers | undefined;
  let acquiredEnvironment: EnvironmentService | undefined;
  let acquiredDirectory: Awaited<ReturnType<typeof createDirectoryBrowser>> | undefined;
  let acquiredSockets: ReturnType<typeof createSocketServer> | undefined;
  let acquiredClients: ClientRegistry | undefined;
  let acquiredRemote: RemoteListeners | undefined;
  let acquiredBundled: BundledUpdate | undefined;
  let snapshots: SnapshotStore | undefined;
  let port = options.port ?? 0;
  const invalidate = (): void => { void snapshots?.rebuild().catch(() => undefined); };
  const home = paths.appDir;
  let owner: Promise<PidLockInfo | null> | undefined;
  let draining: Promise<void> | undefined;
  let released: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const beginDrain = (): Promise<void> => {
    if (draining) return draining;
    const drains: Promise<void>[] = [];
    draining = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(drains);
      results.push(...await Promise.allSettled([Promise.resolve().then(() => snapshots?.close())]));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'API drain failed');
    });
    owner = getPidLockInfo(home);
    void owner.catch(() => undefined);
    for (const cleanup of [
      () => acquiredSockets?.beginDrain(),
      () => acquiredRemote?.beginDrain(),
      () => acquiredDirectory?.close(),
      () => Promise.resolve().then(() => options.service.close?.()),
      () => acquiredJobs?.close(),
      () => acquiredEnvironment?.close(),
      () => acquiredLogs?.close(),
    ]) {
      const drain = new Promise<void>(resolve => resolve(cleanup()));
      void drain.catch(() => undefined);
      drains.push(drain);
    }
    return draining;
  };
  const release = (): Promise<void> => {
    if (released) return released;
    let socketCleanup: Promise<void>;
    let listenerClosed: Promise<void>;
    let remoteClosed: Promise<void>;
    stopEnding?.();
    acquiredBundled?.close();
    released = Promise.resolve().then(async () => {
      await listenerClosed;
      // The remote servers are closed beside the loopback one; the clients' last-seen is written once nothing can touch it.
      const closed = await Promise.allSettled([socketCleanup, remoteClosed]);
      const results = [...closed, ...await Promise.allSettled([Promise.resolve().then(() => acquiredClients?.close())])];
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new ApiCleanupError(errors);
    });
    socketCleanup = new Promise<void>(resolve => resolve(acquiredSockets?.release()));
    remoteClosed = new Promise<void>(resolve => resolve(acquiredRemote?.release()));
    void remoteClosed.catch(() => undefined);
    listenerClosed = new Promise<void>((resolve, reject) => {
      if (!acquiredServer) { resolve(); return; }
      acquiredServer.close(error => { if (error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) reject(error); else resolve(); });
    });
    void socketCleanup.catch(() => undefined);
    void listenerClosed.catch(() => undefined);
    return released;
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let drain: Promise<void>;
    closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([drain]);
      results.push(...await Promise.allSettled([release()]));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'API shutdown failed');
    });
    drain = beginDrain();
    void drain.catch(() => undefined);
    return closing;
  };
  try {
    await mkdir(paths.appDir, { recursive: true });
    const environment = acquiredEnvironment = new EnvironmentService(options.environmentOptions ?? {
      home: homedir(), getDataRoot: () => paths.appDir,
      resolveCodex: () => refreshCodexResolution(), nodePath: process.execPath,
    });
    const { credential, machineId } = await createLocalIdentity(paths.appDir);
    const identity = holdDevice(paths.appDir, await loadOrCreateDevice(paths.appDir, machineId));
    const recipeOrigin = options.recipeInstall?.apiOrigin ?? configuredRecipeApiOrigin();
    const recipes = recipeOrigin && !options.service.readonlyPreview ? new RecipeInstaller({
      ...(options.service.richRecipe ? {rich: {brokerOrigin: options.recipeInstall?.brokerOrigin ?? recipeOrigin, bot: options.service.richRecipe}} : {}),
      apiOrigin: recipeOrigin, allowLoopbackForTests: options.recipeInstall?.allowLoopbackForTests, device: identity.current,
      isInChat: async (botId, chatId, identity) => {
        if (!options.service.assertGroupMembership) throw new Error('无法确认 Bot 群成员身份');
        await options.service.assertGroupMembership(botId, chatId, identity);
      },
    }) : undefined;
    const authoringBots = new WeakMap<Peer, Set<string>>();
    const authoringPeer = (peer: Peer) => ({id: peer.id, device: identity.current.deviceId + '/' + identity.current.keypair.publicKey});
    const clients = acquiredClients = await createClientRegistry(paths.appDir);
    const invites = createInviteBook();
    const directory = acquiredDirectory = await createDirectoryBrowser();
    const server = acquiredServer = createServer((request, response) => {
      void serveWebUi(request, response).then(served => {
        if (!served) { response.writeHead(404); response.end(); }
      }).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    const jobs = acquiredJobs = new Jobs({ service: options.service, changed: invalidate, toolsSettled: () => { void snapshots?.refreshTools().catch(() => undefined); } });
    const logs = acquiredLogs = new LogFollowers(join(paths.appDir, 'logs'));
    const { readService, ...launcher } = options.serviceActions ?? {};
    const serviceActions = createServiceActionLauncher({ root: home, ...launcher, onSettled: () => { void snapshots?.refreshService().catch(() => undefined); } });
    async function finish<T>(peer: Peer, outcome: RpcOutcome<T>, envelope: (value: T) => Response): Promise<void> {
      if (outcome.kind === 'read') { peer.send(envelope(outcome.value)); return; }
      let acted = false;
      try {
        if (!snapshots) throw new Error('Snapshot store is not ready');
        await snapshots.rebuild(snapshot => {
          peer.send(envelope(outcome.reply(snapshot)));
          if (outcome.kind === 'shutdown') { acted = true; outcome.afterReply(); }
        });
      } finally { if (outcome.kind === 'shutdown' && !acted) outcome.cancel?.(); }
    }
    async function admitted(peer: Peer, request: Request) {
      const decision = await authorize(peer, request, authzDeps);
      if (peer.principal.kind === 'maintenance') strikes.set(peer, decision.ok ? 0 : (strikes.get(peer) ?? 0) + 1);
      if (!decision.ok) throw new RpcError(decision.code, decision.message, decision.details);
      return decision;
    }
    async function dispatch(peer: Peer, request: Request): Promise<void> {
      if (!snapshots) throw new Error('Snapshot store is not ready');
      const decision = await admitted(peer, request);
      // A Bot session's reply holds only its bot and its groups (devices-4a 4.5, 4.7).
      const shown = decision.narrow ?? (<T>(payload: T): T => payload);
      const { id } = request;
      switch (request.method) {
        case 'snapshot': peer.send({ type: 'response', id, method: 'snapshot', payload: shown(snapshots.current()) }); return;
        case 'admin': {
          const outcome = await adminRpc(options.service, follow => logs.follow(peer, follow), request.payload, { startedAt, peer });
          // U4: the desktop shell is known once it declared it can update; after an update's restart, one that comes back
          // means the app did not change.
          if (request.payload.type === 'negotiate' && isDesktopShell(peer)) bundled.shellAttached(peer);
          return finish(peer, outcome, payload => ({ type: 'response', id, method: 'admin', payload }));
        }
        case 'device': return finish(peer, await deviceRpc({ home, identity, clients, invites, remote: { listeners: remote, enable, active, candidates } }, peer, request.payload), payload => ({ type: 'response', id, method: 'device', payload }));
        case 'settings': return finish(peer, await settingsRpc(options.service, request.payload), payload => ({ type: 'response', id, method: 'settings', payload: shown(payload) }));
        case 'collaboration': return finish(peer, await collaborationRpc(options.service, directory, request.payload, decision.invitee), payload => ({ type: 'response', id, method: 'collaboration', payload: shown(payload) }));
        case 'environment': return finish(peer, await environmentRpc(options.service, jobs, peer, request.payload, environment), payload => ({ type: 'response', id, method: 'environment', payload }));
        case 'machine': return finish(peer, await machineRpc(options.service, options.control, port, request.payload, { launcher: serviceActions, snapshots, root: home, bridgeImport: options.bridgeImport, environment,
          bundled: { peer, update: bundled, distribution: () => installed, clients } }), payload => ({ type: 'response', id, method: 'machine', payload }));
        case 'command': return finish(peer, await commandRpc({ service: options.service, jobs, peer, owner: ownerOf(peer), directory, snapshots, control: options.control, port, ...(decision.feishu ? { feishu: decision.feishu } : {}) }, request.payload), payload => ({ type: 'response', id, method: 'command', payload: shown(payload) }));
        case 'library': return finish(peer, await libraryRpc(options.service, request.payload), payload => ({ type: 'response', id, method: 'library', payload: shown(payload) }));
        // devices-4b 4.5: a Bot session's write lands where its Bot process said, as its turn's person.
        case 'memory': return finish(peer, await memoryRpc(options.service, request.payload, {
          origin: peer.clientKind === 'cli' ? 'cli' : 'ui', session: peer.principal.kind === 'bot-session', ...(decision.grant?.memory ? { landing: decision.grant.memory } : {}),
        }), payload => ({ type: 'response', id, method: 'memory', payload: shown(payload) }));
        case 'contextPreview': return finish(peer, await contextPreviewRpc(options.service, request.payload), payload => ({ type: 'response', id, method: 'contextPreview', payload }));
        case 'recipeAuthoring': {
          if (peer.principal.kind !== 'owner' || peer.clientKind !== 'desktop' || !peer.open) throw new RpcError('permission_denied', '请从已连接设备的 Vonvon App 操作配方草稿。');
          if (options.service.readonlyPreview || !options.service.recipeAuthoring) throw new RpcError('unsupported', '此设备尚未配置配方草稿。');
          const bots = authoringBots.get(peer) ?? new Set<string>();
          if (!bots.has(request.payload.botId) && bots.size >= 64) throw new RpcError('invalid_request', '这个连接已达到 Bot 数量上限。');
          if (request.payload.type === 'open' || request.payload.type === 'creatorOpen') { bots.add(request.payload.botId); authoringBots.set(peer,bots); }
          const value = await options.service.recipeAuthoring(request.payload.botId, {kind:'recipeAuthoring',peer:authoringPeer(peer),request:request.payload});
          peer.send({type:'response',id,method:'recipeAuthoring',payload:recipeAuthoringReplySchema.parse(value)});
          return;
        }
        case 'recipeInstall': return finish(peer, await recipeInstallRpc(recipes, peer.principal, request.payload), payload => ({type: 'response', id, method: 'recipeInstall', payload}));
        // The owner's hello says who asks: the task records it as made from the desktop or the terminal. A Bot session's
        // runs as the turn its Bot process named (devices-4b 4.4), and never as the owner.
        case 'schedule': {
          const who = peer.principal.kind !== 'bot-session' ? peer.clientKind : decision.grant?.actor;
          if (!who) throw new RpcError('permission_denied', SESSION_TURN_ENDED);
          return finish(peer, await scheduleRpc(options.service, who, request.payload), payload => ({ type: 'response', id, method: 'schedule', payload: shown(payload) }));
        }
        case 'directory': {
          if (request.payload.type === 'list') { peer.send({ type: 'response', id, method: 'directory', payload: await directory.list(request.payload.path) }); return; }
          if (request.payload.type === 'suggest') { peer.send({ type: 'response', id, method: 'directory', payload: await directory.suggest(request.payload.query) }); return; }
          const folder = await directory.choose(request.payload.path);
          return finish(peer, { kind: 'mutation', reply: () => ({ kind: 'folderChosen' as const, folder }) }, payload => ({ type: 'response', id, method: 'directory', payload }));
        }
        default: { const exhaustive: never = request; throw new Error(String(exhaustive)); }
      }
    }
    async function request(peer: Peer, request: Request): Promise<void> {
      try { await dispatch(peer, request); }
      catch (error) {
        if (!snapshots) throw error;
        await snapshots.rebuild(() => peer.send(errorEnvelope(request.id, error)));
        // devices 4.7: a client of another protocol that keeps asking for what it cannot have is closed.
        if ((strikes.get(peer) ?? 0) >= MAINTENANCE_STRIKES) peer.close(4001, 'protocol_mismatch');
      }
    }
    /**
     * devices 4.7: a draining daemon answers DRAIN_KINDS, to whoever the table lets ask them, and every other request
     * `draining`, the connection kept. Codex review 248: a client the drain closed reconnects to follow the update, and
     * its first request is the snapshot (`watchSnapshots`): it gets the last one built, marked stale, without a rebuild or
     * a word to a Bot process that is stopping; a negotiate only records on the connection. A connection of another
     * protocol is refused what it may never ask as when open, and closed 4001 after 20 in a row; nothing else is checked
     * for a request a draining daemon does not answer (a ★ row would ask a stopping Bot process).
     */
    async function control(peer: Peer, request: Request): Promise<void> {
      const answered = DRAINING.has(rpcKindOf(request));
      try {
        if (!answered && peer.principal.kind !== 'maintenance') throw drainingError();
        const decision = await admitted(peer, request);
        if (!answered) throw drainingError();
        const { id } = request;
        if (request.method === 'snapshot') {
          if (!snapshots) throw new Error('Snapshot store is not ready');
          const shown = decision.narrow ?? (<T>(payload: T): T => payload);
          peer.send({ type: 'response', id, method: 'snapshot', payload: shown({ ...snapshots.current(), stale: true }) });
        } else if (request.method === 'admin' && request.payload.type === 'negotiate') {
          // A read: answered as it is, never through a snapshot rebuild
          const outcome = await adminRpc(options.service, follow => logs.follow(peer, follow), request.payload, { startedAt, peer });
          if (outcome.kind !== 'read') throw drainingError();
          peer.send({ type: 'response', id, method: 'admin', payload: outcome.value });
        } else if (request.method === 'machine' && request.payload.type === 'coreUpdateStatus') {
          peer.send({ type: 'response', id, method: 'machine', payload: { type: 'coreUpdateStatus', status: options.service.updateStatus() } });
        } else if (request.method === 'machine' && request.payload.type === 'stopHost') {
          if (!options.control) throw new Error('Host control is unavailable');
          options.control.requestStop(request.payload.reason);
          peer.send({ type: 'response', id, method: 'machine', payload: { type: 'done', message: 'daemon 正在停止。' } });
        } else if (request.method === 'admin' && request.payload.type === 'daemonStatus') {
          const lock = await owner;
          const own = lock?.pid === process.pid && lock.listen === `127.0.0.1:${port}`;
          peer.send({ type: 'response', id, method: 'admin', payload: { kind: 'daemonStatus', status: {
            installed: false, supported: false, selfHosted: true, running: own, version: bridgeVersion(), startedAt, ...(own ? { pid: lock.pid } : {}),
          } } });
        } else throw drainingError();
      } catch (error) {
        peer.send(errorEnvelope(request.id, error));
        if ((strikes.get(peer) ?? 0) >= MAINTENANCE_STRIKES) peer.close(4001, 'protocol_mismatch');
      }
    }
    // devices 4.5: a protocol 1 client gets the three fields it parses strictly, with its own version, so a 0.8 client can still stop this daemon.
    // A Bot session (always protocol 2) gets what its command line reads and nothing of the device (Codex review 256-2).
    const info = (peer: Peer) => peer.principal.kind === 'bot-session'
      ? serverInfoSessionSchema.parse({ type: 'serverInfo', version: bridgeVersion(), protocolVersion: PROTOCOL_VERSION, principal: principalWire(peer.principal) })
      : peer.protocolVersion === 1
      ? serverInfoV1Schema.parse({ type: 'serverInfo', machineId, version: bridgeVersion(), protocolVersion: 1 })
      : serverInfoV2Schema.parse({ type: 'serverInfo', machineId, version: bridgeVersion(), protocolVersion: PROTOCOL_VERSION,
        deviceName: identity.current.name, platform: hostPlatform(), principal: principalWire(peer.principal),
        capabilities: [...capabilities(distribution, remote.status().length > 0),
          ...(options.service.recipeAuthoring && !options.service.readonlyPreview ? [NATIVE_RECIPE_PREVIEW_CAPABILITY] : [])] });
    // devices-2 4.3: every server's connections in one hub, so a publish, a drain or a release reaches all of them; its
    // view gives each connection its part of an event whoever publishes it (devices-4a 4.7).
    // devices-ui-3 4.2: whose a scan is, so the same client coming back on a new connection keeps it (`attached`).
    const ownerOf = (peer: Peer) => peerOwner(peer, clients, identity.current.name);
    const hub = createPeerHub({
      detached: peer => {
        for (const botId of authoringBots.get(peer) ?? []) void options.service.recipeAuthoring?.(botId, {kind:'recipeAuthoringDisconnect',peer:authoringPeer(peer)}).catch(() => undefined);
        authoringBots.delete(peer);
        jobs.detach(peer); logs.detach(peer); if (hub.state === 'open') bundled.shellDetached(peer); },
      attached: peer => { jobs.attach(peer, ownerOf(peer)); },
      view: viewFor(sessionTokens),
    });
    // U4: the update of a server the desktop app carries, run by this computer's desktop shell.
    const bundled = acquiredBundled = createBundledUpdate({
      shells: () => [...hub.peers].filter(isDesktopShell), version: bridgeVersion(), deviceName: () => identity.current.name, log,
    });
    // devices 4.3 (SEC-16): a revoked client's connections end now, with 4003; the hub's detach cancels its jobs and log
    // follows. Before the owner hears of it (followRevocations), so the revoked one does not get that event. Its scans
    // end first (devices-ui-3): one in its grace has no connection left to close.
    clients.onChange((_generation, revoked) => {
      for (const id of revoked) jobs.cancelOwner(`paired:${id}`);
      if (revoked.length) hub.closeWhere(peer => peer.clientId !== undefined && revoked.includes(peer.clientId), CLOSE_CODES.client_revoked, 'client_revoked');
    });
    followRevocations({ clients, invites, publish: event => hub.publish(event), log });
    const sockets = acquiredSockets = createSocketServer({ server, credential, sessions: sessionTokens, info, request, control, hub });
    const secure: SecureDeps = { hub, device: deviceKeyPair(identity.current), deviceName: () => identity.current.name, clients, invites, completePairing, info, request, control };
    stopEnding = sessionTokens.onEnd(sessionId => hub.closeWhere(peer => peer.principal.kind === 'bot-session' && peer.principal.sessionId === sessionId, 4401, 'invalid_session_token'));
    const seams = options.remote ?? {};
    const interfaces = seams.interfaces ?? networkInterfaces;
    const enable: EnableDeps = {
      interfaces, tailscale: seams.tailscale ?? (() => tailscaleIps()), networkIdentity: seams.networkIdentity ?? (iface => networkIdentity(iface)),
      ...(seams.classify ? { classify: seams.classify } : {}),
    };
    const candidates = createCandidates({ interfaces, tailscale: enable.tailscale });
    const remote = acquiredRemote = createRemoteListeners({
      secure, interfaces, networkIdentity: enable.networkIdentity, log, ...(seams.timers ? { timers: seams.timers } : {}), ...(seams.secureTimers ? { secureTimers: seams.secureTimers } : {}),
      limiter: createRateLimiter({ onBan: ip => { log.warn('remote', 'rate-limited', { ip }); } }),
    });
    /** Paired clients connected now, each once however many connections it has. */
    const active = (): number => new Set([...hub.peers].flatMap(peer => peer.open && peer.clientId !== undefined ? [peer.clientId] : [])).size;
    snapshots = await createSnapshotStore({ service: options.service, jobs: () => jobs.snapshot(), serviceAction: () => serviceActions.current(), ...(readService ? { readService } : {}), ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}), ...(options.crashes ? { crashes: options.crashes } : {}), publish: snapshot => sockets.publish({ type: 'event', event: 'snapshot', payload: snapshot }) });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('API did not bind a TCP port');
    port = address.port;
    // devices 4.2: the remote addresses bind once the loopback listens, without holding the start up: one that waits
    // for its address retries every 15 s. A remote.json that cannot be read leaves them closed, and says so in the log.
    let remoteConfig: RemoteConfig | undefined;
    try { remoteConfig = await readRemoteConfig(home); }
    catch (error) { log.warn('remote', 'remote-config-unreadable', { error: error instanceof Error ? error.message : String(error) }); }
    if (remoteConfig) void remote.sync(remoteConfig).catch(error => { log.fail('remote', error, { phase: 'sync' }); });
    return {
      port, listen: `127.0.0.1:${port}`, invalidate, close,
      beginDrain, release, secure,
    };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'API startup and cleanup failed'); }
    throw error;
  }
}
