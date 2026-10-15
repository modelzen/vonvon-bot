import { isDeepStrictEqual } from 'node:util';
import type { DesktopSnapshot, Diagnostic, Job, ToolState } from '@vonvon/protocol';
import { createBackend } from '../agent';
import { cachedClaudeLogin } from '../agent/claude-agent/login';
import { CODEX_MIN_VERSION, CODEX_VERIFIED_VERSION, classifyCodexVersion } from '../agent/codex-appserver/version';
import type { AdminService } from '../admin/service';
import { paths } from '../config/paths';
import { bridgeVersion } from '../core/version';
import { projectState } from './projection';
import { readAdminState } from './state';

export interface SnapshotStore {
  current(): DesktopSnapshot;
  rebuild(committed?: (snapshot: DesktopSnapshot) => void): Promise<void>;
  refreshTools(): Promise<void>;
  diagnose(agentId: string, diagnostics: Diagnostic[]): void;
  close(): Promise<void>;
}

export async function createSnapshotStore(options: {
  service: Pick<AdminService, 'listBots' | 'listProjects' | 'codexSetup'>;
  jobs: () => Job[];
  publish: (snapshot: DesktopSnapshot) => void;
  readTools?: () => Promise<ToolState[]>;
}): Promise<SnapshotStore> {
  const version = bridgeVersion();
  let snapshot: DesktopSnapshot = {
    revision: 0, observedAt: 0, stale: false,
    host: { kind: 'connected', ownership: 'owned', version },
    agents: [], groups: [], memberships: [], tools: [], jobs: [], diagnostics: [],
    application: { platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'unsupported', version, loginItem: false, dataPath: paths.appDir },
  };
  let tools: ToolState[] = [];
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
    const next = {
      ...snapshot, ...projectState(state, snapshot, new Set()), tools,
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
    refreshing = readTools().then(async values => {
      tools = values;
      if (!closed) await rebuild();
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  }
  tools = await readTools();
  await rebuild();
  const poll = setInterval(() => { void rebuild().catch(() => undefined); }, 5_000);
  const toolPoll = setInterval(() => { void refreshTools().catch(() => undefined); }, 60_000);
  poll.unref();
  toolPoll.unref();
  return {
    current: () => snapshot,
    rebuild,
    refreshTools,
    diagnose: (agentId, value) => { diagnostics.set(agentId, value); },
    async close() {
      closed = true;
      clearInterval(poll);
      clearInterval(toolPoll);
      await Promise.all([queue, refreshing]);
    },
  };
}
