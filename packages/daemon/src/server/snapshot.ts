import { isDeepStrictEqual } from 'node:util';
import type { ApplicationCrashes, ApplicationService, BotDiagnostics, CrashPause, DesktopSnapshot, Job, LockHeld, ServiceActionReport, ToolState } from '@vonvon/protocol';
import { createBackend } from '../agent';
import { cachedClaudeLogin, type ClaudeLogin } from '../agent/claude-agent/login';
import { probeClaudeSandbox } from '../agent/claude-agent/sandbox-probe';
import { CODEX_MIN_VERSION, CODEX_VERIFIED_VERSION, classifyCodexVersion } from '../agent/codex-appserver/version';
import { managedCommand, managedToolCommand } from '../environment/tool-command';
import type { AdminService } from '../admin/service';
import { paths } from '../config/paths';
import type { RunningServiceAction } from '../host/service-action';
import { controlDesktopService, type DesktopServiceStatus } from '../host/service';
import { liveServiceActionRecord, readServiceSkipped } from '../service/action-report';
import { isTranslocated, runtimeDistribution, type Distribution } from '../service/distribution';
import { bridgeVersion } from '../core/version';
import { projectLibrary, projectState } from './projection';
import { libraryLocation, readLibrary } from '../project/library';
import { readAdminState } from './state';
import {readRecentConversations} from './recent-conversations';

export interface SnapshotStore {
  current(): DesktopSnapshot;
  rebuild(committed?: (snapshot: DesktopSnapshot) => void): Promise<void>;
  refreshTools(): Promise<void>;
  /** Asks the service manager again (after a service action, 重新检测, or a skip), then rebuilds. */
  refreshService(): Promise<void>;
  /** Takes a manager read someone else started (machine `status`) instead of asking again; it counts from when it began. */
  observeService(read: Promise<DesktopServiceStatus>): void;
  close(): Promise<void>;
}

/** The platform the snapshot and the server info report (devices 4.5). */
/** The snapshot's and serverInfo's platform name (devices 第 19 节: win32 is `windows`, only the name; services stay unsupported there). */
export const hostPlatform = (platform: NodeJS.Platform = process.platform): 'macos' | 'linux' | 'windows' | 'unsupported' =>
  platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'windows' : 'unsupported';
export async function createSnapshotStore(options: {
  service: Pick<AdminService, 'listBots' | 'listProjects' | 'dmRow' | 'codexSetup'>;
  jobs: () => Job[];
  publish: (snapshot: DesktopSnapshot) => void;
  readTools?: (refresh?: boolean) => Promise<ToolState[]>;
  /** The background service as its manager reports it (3.10); read at startup, with the tools every 60 s, and on refreshService(). */
  readService?: () => Promise<DesktopServiceStatus>;
  /** Read once: a development checkout or a translocated app cannot install the service. An unrecognized layout (`npm root -g`
   * timed out or missing at login) is left to the install transaction, which reads the distribution again. */
  distribution?: () => Promise<Distribution>;
  /** The helper this daemon is running, which the report file may not show yet. */
  serviceAction?: () => RunningServiceAction | undefined;
  /** Holds `service-action.json` and `setup.json`; the data root. */
  root?: string;
  /** Each bot's not-replied records and scope denials (bot/diagnostics.ts), read on every rebuild. */
  diagnostics?: { view(appId: string): BotDiagnostics | undefined; retain(appIds: ReadonlySet<string>): void };
  /** The daemon's pause and crash records, and each bot's own pause, from the supervisor (s18a); read on every rebuild. */
  crashes?: { application(now: number): ApplicationCrashes; paused(appId: string): CrashPause | undefined; lockHeld?(appId: string): LockHeld | undefined };
  /** The cached Claude login, read on every rebuild so a check or a failed turn shows at once; defaults to
   * the login cache when the tools are the real ones. */
  claudeLogin?: () => ClaudeLogin | undefined;
}): Promise<SnapshotStore> {
  const version = bridgeVersion();
  const root = options.root ?? paths.appDir;
  const base = { platform: hostPlatform(), version, dataPath: paths.appDir } as const;
  let snapshot: DesktopSnapshot = {
    attentionModel: 'group',
    revision: 0, observedAt: 0, stale: false,
    host: { kind: 'connected', ownership: 'owned', version },
    agents: [], groups: [], memberships: [], tools: [], jobs: [],
    application: { ...base, loginItem: false },
  };
  let tools: ToolState[] = [];
  let loginItem = false;
  // The last manager answer; none before the first read or where there is no manager (Windows).
  let manager: Pick<ApplicationService, 'state' | 'detail' | 'linger' | 'hint'> | undefined;
  let blocked: ApplicationService['blocked'];
  const readService = options.readService ?? (() => controlDesktopService('status'));
  // Reads overlap (startup, the 60 s poll, 重新检测, a helper's exit) and launchctl can take seconds: the read that
  // began last wins, so a slow older answer cannot undo a newer one.
  let readsBegun = 0;
  let readShown = 0;
  function readManager(read: Promise<DesktopServiceStatus>): Promise<void> {
    const order = ++readsBegun;
    return read.then(status => {
      if (order < readShown) return;
      readShown = order;
      observeService(status);
    });
  }
  function observeService(status: DesktopServiceStatus): void {
    if (!status.supported || !status.state) return;
    // An unknown answer keeps the last login item, as before s08; the step says it cannot tell.
    if (status.state !== 'unknown') loginItem = status.state === 'running' || status.state === 'stopped' || status.state === 'detached';
    manager = { state: status.state, ...(status.detail ? { detail: status.detail } : {}), ...(status.linger ? { linger: status.linger.state } : {}), ...(status.hint ? { hint: status.hint } : {}) };
  }
  function serviceAction(): ServiceActionReport | undefined {
    const running = options.serviceAction?.();
    if (running) return { action: running.action, phase: 'running', startedAt: running.startedAt };
    const record = liveServiceActionRecord(root);
    if (!record) return undefined;
    const { pid: _pid, leftovers: _leftovers, ...report } = record;
    return report;
  }
  function serviceView(): ApplicationService | undefined {
    if (!manager) return undefined;
    const action = serviceAction();
    return { ...manager, ...(blocked ? { blocked } : {}), skipped: readServiceSkipped(root), ...(action ? { action } : {}) };
  }
  const claudeLogin = options.claudeLogin ?? (options.readTools ? undefined : cachedClaudeLogin);
  let queue = Promise.resolve();
  let refreshing: Promise<void> | undefined;
  let followUp: Promise<void> | undefined;
  let forceFollowUp = false;
  let closed = false;
  const readTools = options.readTools ?? (async (refresh = false): Promise<ToolState[]> => {
    const [codex, claude, sandbox] = await Promise.all([
      Promise.resolve().then(() => options.service.codexSetup?.({ refresh })).catch((error: unknown) => ({
        installation: 'unknown' as const, authentication: 'unknown' as const, version: null,
        message: error instanceof Error ? error.message : 'Codex 状态检测失败，请重新检测。',
      })),
      createBackend('claude-agent').doctor({ force: true }).catch(() => undefined),
      // Linux only: two PATH scans and one 8 ms bwrap run, cheaper than the Codex processes above.
      probeClaudeSandbox().catch(() => undefined),
    ]);
    // The login is not probed here: the probe starts a ~250 MB Claude CLI, and this runs every
    // 60 s even when no window is open. build() lays the cached answer over it.
    const compatibility = codex?.installation === 'installed' ? { status: classifyCodexVersion(codex.version), minimum: CODEX_MIN_VERSION, verified: CODEX_VERIFIED_VERSION } : undefined;
    // A managed copy is on no PATH: the setup steps name what starts it (0.9.0 Linux acceptance).
    const codexCommand = codex && 'executable' in codex && codex.executable ? managedCommand(codex.executable, root) : undefined;
    const claudeCommand = managedToolCommand('claude', root);
    return [
      { tool: 'codex', installation: codex?.installation ?? 'unknown', authentication: codex?.authentication ?? 'unknown', version: codex?.version ?? null, ...(codex?.message ? { message: codex.message } : {}), ...(compatibility ? { compatibility } : {}), ...(codexCommand ? { command: codexCommand } : {}) },
      { tool: 'claude', installation: claude ? (claude.ok ? 'installed' : claude.depState === 'not-installed' || claude.depState === 'external-missing' ? 'missing' : 'unknown') : 'unknown', authentication: 'unknown', version: claude?.version ?? null, ...(claude?.hint ? { message: claude.hint } : {}), ...(sandbox ? { sandbox } : {}), ...(claudeCommand ? { command: claudeCommand } : {}) },
    ];
  });
  async function build(committed?: (snapshot: DesktopSnapshot) => void): Promise<void> {
    const state = await readAdminState(options.service);
    // The report and the skip flag are files, re-read here: a helper's result shows within one 5 s rebuild.
    const service = serviceView();
    const projected = projectState(state, snapshot, new Set());
    // An unreadable library keeps the last list: the bindings still show, and the next read tries again.
    const projects = await readLibrary(libraryLocation(root)).then(library => projectLibrary(library.projects, projected.memberships), () => snapshot.projects ?? []);
    options.diagnostics?.retain(new Set(projected.agents.map(agent => agent.id)));
    const agents = projected.agents.map(agent => {
      const diagnostics = options.diagnostics?.view(agent.id);
      // A paused bot is enabled and not running on purpose: not a switch waiting for a restart.
      const paused = options.crashes?.paused(agent.id);
      const lockHeld = options.crashes?.lockHeld?.(agent.id);
      return { ...agent, ...(diagnostics ? { diagnostics } : {}), ...(paused ? { paused, activation: 'active' as const } : {}), ...(lockHeld ? { lockHeld } : {}) };
    });
    const login = claudeLogin?.();
    const shownTools = login ? tools.map(tool => tool.tool === 'claude' && tool.installation === 'installed' ? { ...tool, authentication: login.state, message: login.message } : tool) : tools;
    const next = {
      ...snapshot, ...projected, projects, agents, tools: shownTools,
      application: { ...base, loginItem, ...(service ? { service } : {}), ...(options.crashes ? { crashes: options.crashes.application(Date.now()) } : {}) },
      jobs: options.jobs(),
      recentConversations: await readRecentConversations(root,projected.memberships),
      observedAt: Date.now(),
    };
    const changed = snapshot.revision === 0 || !isDeepStrictEqual(
      { ...snapshot, revision: 0, observedAt: 0 }, { ...next, revision: 0, observedAt: 0 },
    );
    next.revision = snapshot.revision + Number(changed);
    const initial = snapshot.revision === 0;
    snapshot = next;
    if (changed && !initial) options.publish(snapshot);
    committed?.(snapshot);
  }
  function rebuild(committed?: (snapshot: DesktopSnapshot) => void): Promise<void> {
    if (closed) return Promise.reject(new Error('Snapshot store is closed'));
    const pending = queue.then(() => build(committed));
    queue = pending.catch(() => undefined);
    return pending;
  }
  function refreshTools(refresh = true): Promise<void> {
    if (closed) return Promise.resolve();
    // A read already running may have looked before the caller's change (a login check
    // that just finished), so callers during it share one more read after it.
    if (refreshing) {
      forceFollowUp ||= refresh;
      return followUp ??= refreshing.catch(() => undefined).then(() => { const force = forceFollowUp; forceFollowUp = false; followUp = undefined; return refreshTools(force); });
    }
    refreshing = Promise.all([readTools(refresh), readManager(readService()).catch(() => undefined)]).then(async ([values]) => {
      tools = values;
      if (!closed) await rebuild();
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  }
  async function refreshService(): Promise<void> {
    if (closed) return;
    await readManager(readService());
    if (!closed) await rebuild();
  }
  tools = await readTools();
  await rebuild();
  // Not awaited: launchctl may take up to 30 s just after login, and the API should listen first.
  void refreshService().catch(() => undefined);
  void (options.distribution ?? runtimeDistribution)().then(distribution => {
    if (isTranslocated(process.execPath) || isTranslocated(distribution.cliPath)) blocked = 'translocated';
    else if (distribution.kind === 'development') blocked = 'development';
    if (blocked && !closed) return rebuild();
  }).catch(() => undefined);
  const poll = setInterval(() => { void rebuild().catch(() => undefined); }, 5_000);
  const toolPoll = setInterval(() => { void refreshTools(false).catch(() => undefined); }, 60_000);
  poll.unref();
  toolPoll.unref();
  return {
    current: () => snapshot,
    rebuild,
    refreshTools,
    refreshService,
    observeService: read => { void readManager(read).then(() => { if (!closed) return rebuild(); }).catch(() => undefined); },
    async close() {
      closed = true;
      clearInterval(poll);
      clearInterval(toolPoll);
      await Promise.all([queue, refreshing]);
    },
  };
}
