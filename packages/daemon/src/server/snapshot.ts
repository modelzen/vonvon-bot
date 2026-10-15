import { isDeepStrictEqual } from 'node:util';
import type { ApplicationService, DesktopSnapshot, Diagnostic, Job, ServiceActionReport, ToolState } from '@vonvon/protocol';
import { createBackend } from '../agent';
import { cachedClaudeLogin } from '../agent/claude-agent/login';
import { CODEX_MIN_VERSION, CODEX_VERIFIED_VERSION, classifyCodexVersion } from '../agent/codex-appserver/version';
import type { AdminService } from '../admin/service';
import { paths } from '../config/paths';
import type { RunningServiceAction } from '../host/service-action';
import { controlDesktopService, type DesktopServiceStatus } from '../host/service';
import { liveServiceActionRecord, readServiceSkipped } from '../service/action-report';
import { isTranslocated, runtimeDistribution, type Distribution } from '../service/distribution';
import { bridgeVersion } from '../core/version';
import { projectState } from './projection';
import { readAdminState } from './state';

export interface SnapshotStore {
  current(): DesktopSnapshot;
  rebuild(committed?: (snapshot: DesktopSnapshot) => void): Promise<void>;
  refreshTools(): Promise<void>;
  /** Asks the service manager again (after a service action, 重新检测, or a skip), then rebuilds. */
  refreshService(): Promise<void>;
  /** Takes a manager read someone else just made (machine `status`) instead of asking again. */
  observeService(status: DesktopServiceStatus): void;
  diagnose(agentId: string, diagnostics: Diagnostic[]): void;
  close(): Promise<void>;
}

export async function createSnapshotStore(options: {
  service: Pick<AdminService, 'listBots' | 'listProjects' | 'codexSetup'>;
  jobs: () => Job[];
  publish: (snapshot: DesktopSnapshot) => void;
  readTools?: () => Promise<ToolState[]>;
  /** The background service as its manager reports it (3.10); read at startup, with the tools every 60 s, and on refreshService(). */
  readService?: () => Promise<DesktopServiceStatus>;
  /** Read once: a development checkout or a translocated app cannot install the service. */
  distribution?: () => Promise<Distribution>;
  /** The helper this daemon is running, which the report file may not show yet. */
  serviceAction?: () => RunningServiceAction | undefined;
  /** Holds `service-action.json` and `setup.json`; the data root. */
  root?: string;
}): Promise<SnapshotStore> {
  const version = bridgeVersion();
  const root = options.root ?? paths.appDir;
  const base = { platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'unsupported', version, dataPath: paths.appDir } as const;
  let snapshot: DesktopSnapshot = {
    revision: 0, observedAt: 0, stale: false,
    host: { kind: 'connected', ownership: 'owned', version },
    agents: [], groups: [], memberships: [], tools: [], jobs: [], diagnostics: [],
    application: { ...base, loginItem: false },
  };
  let tools: ToolState[] = [];
  let loginItem = false;
  // The last manager answer; none before the first read or where there is no manager (Windows).
  let manager: Pick<ApplicationService, 'state' | 'detail'> | undefined;
  let blocked: ApplicationService['blocked'];
  const readService = options.readService ?? (() => controlDesktopService('status'));
  function observeService(status: DesktopServiceStatus): void {
    if (!status.supported || !status.state) return;
    // An unknown answer keeps the last login item, as before s08; the step says it cannot tell.
    if (status.state !== 'unknown') loginItem = status.state === 'running' || status.state === 'stopped' || status.state === 'detached';
    manager = { state: status.state, ...(status.detail ? { detail: status.detail } : {}) };
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
  const diagnostics = new Map<string, Diagnostic[]>();
  let queue = Promise.resolve();
  let refreshing: Promise<void> | undefined;
  let followUp: Promise<void> | undefined;
  let closed = false;
  const readTools = options.readTools ?? (async (): Promise<ToolState[]> => {
    const [codex, claude] = await Promise.all([
      options.service.codexSetup?.().catch(() => undefined),
      createBackend('claude-agent').doctor({ force: true }).catch(() => undefined),
    ]);
    // Only the last answer: the probe starts a ~250 MB Claude CLI, and this runs every
    // 60 s even when no window is open. The 本机环境 page and 检查登录 probe.
    const login = claude?.ok ? cachedClaudeLogin() : undefined;
    const claudeMessage = login?.message ?? claude?.hint;
    const compatibility = codex?.installation === 'installed' ? { status: classifyCodexVersion(codex.version), minimum: CODEX_MIN_VERSION, verified: CODEX_VERIFIED_VERSION } : undefined;
    return [
      { tool: 'codex', installation: codex?.installation ?? 'unknown', authentication: codex?.authentication ?? 'unknown', version: codex?.version ?? null, ...(codex?.message ? { message: codex.message } : {}), ...(compatibility ? { compatibility } : {}) },
      { tool: 'claude', installation: claude ? (claude.ok ? 'installed' : claude.depState === 'not-installed' || claude.depState === 'external-missing' ? 'missing' : 'unknown') : 'unknown', authentication: login?.state ?? 'unknown', version: claude?.version ?? null, ...(claudeMessage ? { message: claudeMessage } : {}) },
    ];
  });
  async function build(committed?: (snapshot: DesktopSnapshot) => void): Promise<void> {
    const state = await readAdminState(options.service);
    // The report and the skip flag are files, re-read here: a helper's result shows within one 5 s rebuild.
    const service = serviceView();
    const next = {
      ...snapshot, ...projectState(state, snapshot, new Set()), tools,
      application: { ...base, loginItem, ...(service ? { service } : {}) },
      jobs: options.jobs(), diagnostics: [...diagnostics.values()].flat(),
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
  function refreshTools(): Promise<void> {
    if (closed) return Promise.resolve();
    // A read already running may have looked before the caller's change (a login check
    // that just finished), so callers during it share one more read after it.
    if (refreshing) return followUp ??= refreshing.catch(() => undefined).then(() => { followUp = undefined; return refreshTools(); });
    refreshing = Promise.all([readTools(), readService().catch(() => null)]).then(async ([values, status]) => {
      tools = values;
      if (status) observeService(status);
      if (!closed) await rebuild();
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  }
  async function refreshService(): Promise<void> {
    if (closed) return;
    observeService(await readService());
    if (!closed) await rebuild();
  }
  tools = await readTools();
  await rebuild();
  // Not awaited: launchctl may take up to 30 s just after login, and the API should listen first.
  void readService().then(status => { observeService(status); if (!closed) return rebuild(); }).catch(() => undefined);
  void (options.distribution ?? runtimeDistribution)().then(distribution => {
    blocked = isTranslocated(process.execPath) || isTranslocated(distribution.cliPath) ? 'translocated'
      : distribution.kind === 'development' || distribution.kind === 'unknown' ? 'development' : undefined;
    if (blocked && !closed) return rebuild();
  }).catch(() => undefined);
  const poll = setInterval(() => { void rebuild().catch(() => undefined); }, 5_000);
  const toolPoll = setInterval(() => { void refreshTools().catch(() => undefined); }, 60_000);
  poll.unref();
  toolPoll.unref();
  return {
    current: () => snapshot,
    rebuild,
    refreshTools,
    refreshService,
    observeService: status => { observeService(status); if (!closed) void rebuild().catch(() => undefined); },
    diagnose: (agentId, value) => { diagnostics.set(agentId, value); },
    async close() {
      closed = true;
      clearInterval(poll);
      clearInterval(toolPoll);
      await Promise.all([queue, refreshing]);
    },
  };
}
