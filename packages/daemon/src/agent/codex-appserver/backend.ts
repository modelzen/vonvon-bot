import { accessSync, constants } from 'node:fs';
import { codexAccountMetadata } from './login';
import { log } from '../../core/logger';
import type {
  AgentBackend,
  AgentSkill,
  AgentEntry,
  AgentEvent,
  AgentInput,
  AgentRun,
  AgentThread,
  BackendProbe,
  CompactResult,
  GenerateSessionTitleOptions,
  HistoryTool,
  JudgeCall,
  JudgeCallOutput,
  HistoryTurn,
  ModelInfo,
  PermissionMode,
  ReasoningEffort,
  ResumeThreadOptions,
  StartThreadOptions,
  ThreadHistory,
  ThreadSummary,
  TurnOptions,
} from '../types';
import { isGoalTerminal, SessionInUseError } from '../types';
import { resolveSessionProfile, type SessionProfile, type SessionProfileCapabilities } from '../session-profile';
import { AppServerClient } from './app-server-client';
import { admitCodexWorkspaceLayout } from './workspace-admission';
import { codexFilesystem, codexInstallRoot, codexShellReadRoot, type CodexInstallRoot, codexWorkspaceRoots, verifyCodexWorkspaceEcho } from './workspace-policy';
import { CONNECTOR_SCHEDULING_OFF, NATIVE_MEMORY_OFF, NATIVE_SCHEDULING_OFF } from './memory-config';
import { startDynamicTools } from './dynamic-tools';
import { connectGated, refillWarmPool, takeWarmClient, utilityRequest } from './client-pool';
import { mapChildNotification, mapNotification, readSubAgentActivity, readSubagentSpawn, type Child } from './event-map';
import { runCodexJudge } from './judge-process';
import { CodexFullOnlyError, codexTierUnavailable, type WindowsSandboxCapability } from './full-only';
import { cachedCodexVersion, codexVersionAsync, refreshCodexResolution, resolveCodexBin } from './locate';
import { cachedWindowsSandbox, refreshWindowsSandbox, windowsShellPath } from './windows-sandbox';
import type { ServerNotification, Thread, ThreadItem, Turn, TurnStartResponse } from './protocol';
import { codexCatalogCache, constrainCodexModelTiers } from './models';

const APPROVAL_POLICY = 'never';

/** Keep the existing session when Codex cannot safely apply an inherited tier. */
export class CodexServiceTierError extends Error {
  constructor(message: string) { super(message); this.name = 'CodexServiceTierError'; }
}

/** Build the native profile only for tiers verified on this host and version. */
export function sandboxParams(
  mode: PermissionMode | undefined,
  network: boolean | undefined,
  platform: NodeJS.Platform = process.platform,
  roots?: ReturnType<typeof codexWorkspaceRoots>,
  version: string | null = null,
  installRoot?: CodexInstallRoot,
  windows?: WindowsSandboxCapability,
  shellRoot?: CodexInstallRoot,
  capabilityRoots?: readonly string[],
): Record<string, unknown> {
  if ((mode ?? 'full') === 'full') return { sandbox: 'danger-full-access' };
  const unavailable = codexTierUnavailable(mode ?? 'full', platform, version, windows);
  if (unavailable) throw new CodexFullOnlyError(unavailable);
  return {
    config: {
      ...(platform === 'win32' ? { windows: { sandbox: 'mxc' }, features: { prefer_mxc: false } } : {}),
      default_permissions: 'feishu',
      permissions: {
        feishu: {
          filesystem: codexFilesystem(roots ?? [], mode === 'write' ? 'write' : 'qa', installRoot, platform, network, shellRoot, capabilityRoots),
          network: { enabled: Boolean(network) },
        },
      },
    },
  };
}

/**
 * `skills/list` does not list a capability root's skills, so whether Codex found the package is only seen in a real
 * turn (T4b 4.4). What the code can check is that the directory is there and readable; one that is not is left out.
 */
function readablePackages(packages: SessionProfile['capabilityPackages']): SessionProfile['capabilityPackages'] {
  return packages.filter(pkg => {
    const {path} = pkg;
    try { accessSync(path, constants.R_OK | constants.X_OK); return true; }
    catch (error) { if (pkg.kind === 'recipe') throw error; log.fail('agent', error, { backend: 'codex-appserver', phase: 'capability-root' }); return false; }
  });
}

/** Rebuilt for every start/resume; never persists workspace trust to user config. */
export function codexSessionParams(opts: StartThreadOptions, version: string | null = null, selectedBin?: string | null): Record<string, unknown> {
  const profile = resolveSessionProfile(opts.profile, { additionalRoots: true, capabilityPackages: true });
  const roots = codexWorkspaceRoots(opts);
  const packages = readablePackages(profile.capabilityPackages);
  const bin = selectedBin === undefined ? resolveCodexBin() : selectedBin;
  const installRoot = bin && opts.mode !== 'full' ? codexInstallRoot(bin, roots) : undefined;
  const shell = bin && process.platform === 'win32' && (opts.mode ?? 'full') !== 'full' ? windowsShellPath(bin) : undefined;
  const shellRoot = shell ? codexShellReadRoot(shell, roots) : undefined;
  const sandbox = sandboxParams(opts.mode, opts.network, process.platform, roots, version, installRoot,
    bin && process.platform === 'win32' ? cachedWindowsSandbox(bin) : undefined, shellRoot, packages.map(pkg => pkg.path));
  const sandboxConfig = typeof sandbox.config === 'object' ? sandbox.config as { features?: object } : {};
  return {
    ...sandbox,
    cwd: opts.cwd,
    runtimeWorkspaceRoots: roots.map(root => root.path),
    // Resume has no such field and keeps the thread's roots from its rollout; sending it there does no harm.
    ...(packages.length ? { selectedCapabilityRoots: packages.map(({ path, kind }) => ({ id: `vonvon-${kind}`, location: { type: 'environment', environmentId: 'local', path } })) } : {}),
    approvalPolicy: APPROVAL_POLICY,
    developerInstructions: profile.instructions,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.serviceTier !== undefined ? { serviceTier: opts.serviceTier === 'standard' ? null : opts.serviceTier === 'fast' ? 'priority' : opts.serviceTier } : {}),
    config: {
      ...sandboxConfig,
      projects: { [opts.cwd]: { trust_level: 'trusted' } },
      ...NATIVE_MEMORY_OFF,
      // One merge: the sandbox's (Windows `prefer_mxc: false` below full access), memory and scheduling switches.
      features: { ...sandboxConfig.features, ...NATIVE_MEMORY_OFF.features, ...NATIVE_SCHEDULING_OFF.features },
      ...CONNECTOR_SCHEDULING_OFF,
      ...(profile.skills?.disabledPaths.length ? { skills: { config: profile.skills.disabledPaths.map(path => ({ path, enabled: false })) } } : {}),
      shell_environment_policy: { set: profile.env },
    },
  };
}

/** Snapshot the provider's own default so an in-memory fast override can later
 * return to inheritance without accidentally retaining acceleration. */
async function readNativeServiceTier(client: AppServerClient, cwd: string): Promise<string | null | undefined> {
  try {
    const reply = await client.request<{ config?: { service_tier?: unknown } }>('config/read', { includeLayers: false, cwd });
    const tier = reply.config?.service_tier;
    return typeof tier === 'string' ? tier : tier == null ? null : undefined;
  } catch {
    return undefined;
  }
}

/** Hard ceiling on a history read so a wedged codex can't hang the resume card. */
const READ_HISTORY_TIMEOUT_MS = 20_000;

/** Hard ceiling on a manual compaction (an LLM summarization turn) so a wedged
 * codex can't hang the "压缩中" card forever. */
const COMPACT_TIMEOUT_MS = 120_000;

/** Keep the auxiliary title turn bounded. This mirrors Codex App's short-lived
 * background title job; the dedicated app-server process is always closed in a
 * finally block, so a wedged model request cannot leave an orphan behind. */
const TITLE_GENERATION_TIMEOUT_MS = 30_000;

const TITLE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string', maxLength: 36 } },
  required: ['title'],
  additionalProperties: false,
} as const;

function toUserInput(input: AgentInput): unknown[] {
  const out: unknown[] = [];
  if (input.text) out.push({ type: 'text', text: input.text, text_elements: [] });
  for (const path of input.images ?? []) out.push({ type: 'localImage', path });
  return out;
}

/** Narrow structural surface used by the isolated title job (and its mocks). */
export interface CodexTitleClient {
  connect(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  stream(): AsyncIterable<ServerNotification>;
  close(): Promise<void>;
}

export interface CodexTitleBackendDeps {
  utilityRequest: typeof utilityRequest;
  resolveBin: typeof resolveCodexBin;
  createClient(bin: string, cwd: string): CodexTitleClient;
}

const DEFAULT_TITLE_DEPS: CodexTitleBackendDeps = {
  utilityRequest,
  resolveBin: resolveCodexBin,
  createClient: (bin, cwd) =>
    new AppServerClient({ bin, cwd, clientName: 'feishu-codex-bridge-title' }),
};

function parseGeneratedTitle(text: string): string | undefined {
  const clean = text.trim();
  if (!clean) return undefined;
  try {
    const parsed = JSON.parse(clean) as { title?: unknown };
    if (typeof parsed.title === 'string') return parsed.title.trim() || undefined;
  } catch {
    // Older app-server/model combinations may ignore outputSchema. Preserve the
    // final assistant text and let the coordinator sanitize/fallback centrally.
  }
  return clean;
}

/**
 * Run one already-connected, ephemeral app-server title thread. Exported only
 * to make the protocol/stream behavior testable without spawning Codex.
 */
export async function generateCodexSessionTitleWithClient(
  client: CodexTitleClient,
  opts: GenerateSessionTitleOptions,
): Promise<string | undefined> {
  const started = await client.request<{ thread: { id: string } }>('thread/start', {
    cwd: opts.cwd,
    model: opts.model,
    approvalPolicy: APPROVAL_POLICY,
    sandbox: 'read-only',
    ephemeral: true,
    // Match Codex App's isolated background job: no web search, hooks, fanout,
    // or subagents. Read-only still lets the core runtime initialize safely.
    // The turn runs on the user's first message, so both scheduling switches stay closed too.
    config: {
      ...NATIVE_MEMORY_OFF,
      features: { ...NATIVE_MEMORY_OFF.features, ...NATIVE_SCHEDULING_OFF.features },
      ...CONNECTOR_SCHEDULING_OFF,
      projects: { [opts.cwd]: { trust_level: 'trusted' } },
      web_search: 'disabled',
      'features.enable_fanout': false,
      'features.hooks': false,
      'features.multi_agent': false,
      'features.multi_agent_v2': false,
    },
  });
  const threadId = started.thread.id;
  const iterator = client.stream()[Symbol.asyncIterator]();

  type StartState = { kind: 'start-ok' } | { kind: 'start-error'; error: unknown };
  let startState: Promise<StartState> | null = client
    .request('turn/start', {
      threadId,
      input: toUserInput({ text: opts.prompt }),
      model: opts.model,
      effort: opts.effort,
      outputSchema: TITLE_OUTPUT_SCHEMA,
    })
    .then<StartState, StartState>(
      () => ({ kind: 'start-ok' }),
      (error: unknown) => ({ kind: 'start-error', error }),
    );

  let turnId: string | undefined;
  let finalText = '';
  const deltas = new Map<string, string>();
  let nextNotification = iterator.next().then((step) => ({ kind: 'notification' as const, step }));

  while (true) {
    const next = await Promise.race(
      startState ? [nextNotification, startState] : [nextNotification],
    );
    if (next.kind === 'start-error') throw next.error;
    if (next.kind === 'start-ok') {
      startState = null;
      continue;
    }
    if (next.step.done) throw new Error('Codex title stream closed before turn completion');

    const n = next.step.value;
    nextNotification = iterator.next().then((step) => ({ kind: 'notification' as const, step }));
    switch (n.method) {
      case 'turn/started':
        if (n.params.threadId === threadId) turnId = n.params.turn.id;
        break;
      case 'item/agentMessage/delta':
        if (n.params.threadId === threadId && (!turnId || n.params.turnId === turnId)) {
          deltas.set(n.params.itemId, (deltas.get(n.params.itemId) ?? '') + n.params.delta);
        }
        break;
      case 'item/completed':
        if (
          n.params.threadId === threadId &&
          (!turnId || n.params.turnId === turnId) &&
          n.params.item.type === 'agentMessage'
        ) {
          finalText = n.params.item.text;
        }
        break;
      case 'turn/completed':
        if (n.params.threadId !== threadId || (turnId && n.params.turn.id !== turnId)) break;
        if (n.params.turn.status !== 'completed') {
          throw new Error(
            n.params.turn.error?.message ?? `Codex title turn ended with ${n.params.turn.status}`,
          );
        }
        if (!finalText) finalText = [...deltas.values()].join('');
        return parseGeneratedTitle(finalText);
      case 'error':
        if (!n.params.willRetry) throw new Error(n.params.error.message);
        break;
      default:
        break;
    }
  }
}

function withTitleDeadline<T>(work: Promise<T>, timeoutMs = TITLE_GENERATION_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Codex title generation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class CodexThread implements AgentThread {
  private currentTurnId: string | undefined;
  private parentDoneTurnId: string | undefined;
  /** Turns whose turn/start answered; a tool call can come in before its turn's answer and waits (定时任务 T3b). */
  private readonly ackedTurns = new Set<string>();
  private readonly ackWaiters = new Set<{ turnId: string; wake(): void }>();

  private runningChildren(): number {
    return [...this.children.values()].filter(child => child.running).length;
  }
  private children = new Map<string, Child>();

  constructor(
    private readonly client: AppServerClient,
    readonly sessionId: string,
    private model: string | undefined,
    private effort: ReasoningEffort | undefined,
    private serviceTier: StartThreadOptions['serviceTier'],
    private readonly nativeServiceTier: string | null | undefined,
    /** Resumed, or a turn was started: codex has it on disk. A thread that only had
     * thread/start resumes as `thread not loaded`, so it is kept until its first turn. */
    private onDisk: boolean,
    readonly lastCompaction?: string,
    private readonly entry?: AgentEntry,
    private readonly supportsEffort?: (model: string) => boolean,
  ) {
    if (entry) client.hostTools(sessionId, { entry, turnAcked: (turnId, ms) => this.turnAcked(turnId, ms) });
  }

  get releaseAfterRun(): boolean {
    return this.onDisk;
  }

  private turnAcked(turnId: string, ms: number): Promise<boolean> {
    if (this.ackedTurns.has(turnId)) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = (acked: boolean) => { clearTimeout(timer); this.ackWaiters.delete(waiter); resolve(acked); };
      const waiter = { turnId, wake: () => done(true) };
      const timer = setTimeout(done, ms, false);
      this.ackWaiters.add(waiter);
    });
  }

  /** The entry learns the turn by its id, so `item/tool/call` is authorized as this turn, not the thread's first. */
  private ackTurn(turnId: string): void {
    this.ackedTurns.add(turnId);
    this.entry?.noteToolUse(turnId);
    for (const waiter of this.ackWaiters) if (waiter.turnId === turnId) waiter.wake();
  }

  runStreamed(input: AgentInput, turn?: TurnOptions): AgentRun {
    const self = this;
    this.currentTurnId = undefined;
    // Per-turn overrides persist for subsequent turns (matches turn/start semantics).
    if (turn?.model) this.model = turn.model;
    if (turn?.effort) this.effort = turn.effort;
    const restoreNativeTier = turn && 'serviceTier' in turn && turn.serviceTier === undefined && this.serviceTier !== undefined;
    if (restoreNativeTier && this.nativeServiceTier === undefined) throw new CodexServiceTierError('无法读取 Codex 原生响应速度，当前会话未切换档位，请稍后重试。');
    // Liveness clock for the idle watchdog: refreshed on EVERY raw notification
    // below (even ones mapNotification drops, like command output deltas), so a
    // long-running shell command doesn't read as "wedged".
    let lastActivityAt = Date.now();
    const params: Record<string, unknown> = {
      threadId: self.sessionId,
      input: toUserInput(input),
    };
    if (self.model) params.model = self.model;
    if (turn?.serviceTier !== undefined) params.serviceTier = turn.serviceTier === 'standard' ? null : turn.serviceTier === 'fast' ? 'priority' : turn.serviceTier;
    else if (restoreNativeTier) params.serviceTier = self.nativeServiceTier;
    // A configured custom model may have no native effort metadata. Leave its
    // reasoning settings to Codex instead of sending our generic medium fallback.
    if (self.effort && (!self.model || self.supportsEffort?.(self.model) !== false)) params.effort = self.effort;

    // Fire turn/start NOW — at runStreamed() call time, NOT lazily on the first
    // next() — so model inference runs in parallel with the caller's card setup
    // (stream.create + adoptThreadId cost 2-3 RTTs before the for-await begins).
    // Early notifications buffer in the client's AsyncQueue, so nothing is lost.
    // The caller owns the new failure mode (card setup throws after the turn
    // started): launchRun aborts+closes the thread on that path.
    //
    // Live probe (2026-09-15): ACK returned in 12ms, before turn/started.
    // The response identifies THIS request's turn. Notifications can arrive
    // before it and stay buffered in the client; never infer identity from the
    // first turn/started (it may belong to an old turn or a subagent).
    // Observe rejection eagerly, even if card creation delays consumption.
    const requests = self.client.openRequestScope(self.sessionId, id => {
      const child = self.children.get(id);
      return child?.running ? child.turnId : undefined;
    });
    let activeTurnId: string | undefined;
    const started = self.client.request<TurnStartResponse>('turn/start', params)
      .then((result) => {
        if (!result.turn?.id) throw new Error('turn/start response missing turn id');
        activeTurnId = result.turn.id;
        self.ackTurn(result.turn.id);
        if (turn && 'serviceTier' in turn) self.serviceTier = turn.serviceTier;
        self.onDisk = true; // accepted: codex writes the turn, so the thread resumes
        return { turnId: result.turn.id };
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        requests.close();
        log.fail('agent', error, { phase: 'turn/start' });
        return { error };
      });
    async function* gen(): AsyncGenerator<AgentEvent> {
      let deferred: Extract<AgentEvent, { type: 'done' }> | undefined;
      try {
        const result = await started;
        if ('error' in result) {
          yield { type: 'error', message: result.error.message, willRetry: false };
          return;
        }
        // Do not race stream.next() with start failure: the losing read would
        // remain queued and steal the next request's first notification.
        for await (const notification of self.client.events()) {
          if (!('method' in notification)) {
            if (notification.kind === 'request_cancelled') {
              if (notification.owner === requests) yield { type: 'ask_cancelled', requestId: notification.requestId };
              continue;
            }
            if (requests.accepts(notification, activeTurnId)) {
              lastActivityAt = Date.now();
              yield { type: 'ask', request: notification.request, subagentId: notification.threadId === self.sessionId ? undefined : notification.threadId };
            }
            continue;
          }
          const routed = self.routeNotification(notification, result.turnId);
          if (!routed) continue;
          lastActivityAt = Date.now();
          for (const ev of routed) {
            if (ev.type === 'subagent_status' && ev.status !== 'running') {
              for (const id of requests.finishThread(ev.id)) yield { type: 'ask_cancelled', requestId: id };
            }
            if (ev.type === 'done' && self.runningChildren() > 0) {
              if (deferred) continue;
              deferred = ev;
              activeTurnId = undefined;
              self.parentDoneTurnId = result.turnId;
              requests.finishTurn(result.turnId);
              yield { type: 'awaiting_subagents' };
              continue;
            }
            if (ev.type === 'done' || (ev.type === 'error' && !ev.willRetry)) {
              requests.close();
              activeTurnId = undefined; // no steering during terminal-card I/O
              yield ev;
              return;
            }
            yield ev;
          }
          if (deferred && self.runningChildren() === 0) {
            requests.close();
            yield deferred;
            return;
          }
        }
      } finally {
        self.parentDoneTurnId = undefined;
        requests.close();
        for (const child of self.children.values()) child.stopRequested = false;
        activeTurnId = undefined;
      }
    }
    return { events: gen(), askPending: id => requests.isPending(id), stopSubagent: (id) => self.stopSubagent(id), respondToAsk: (id, resolution) => requests.respond(id, resolution), turnId: () => activeTurnId, lastActivity: () => lastActivityAt };
  }

  runGoal(objective: string, turn?: TurnOptions): AgentRun {
    // Native goals have no turn/start tier override. A loaded same-client
    // resume does not apply serviceTier; the orchestrator reopens it in a fresh
    // app-server process before beginning a goal with a changed tier.
    if (turn && 'serviceTier' in turn && turn.serviceTier !== this.serviceTier) {
      throw new CodexServiceTierError('新目标的响应速度已变化，需要重新打开原会话后再开始目标。');
    }
    const self = this;
    const requests = self.client.openRequestScope(self.sessionId, id => {
      const child = self.children.get(id);
      return child?.running ? child.turnId : undefined;
    });
    this.currentTurnId = undefined;
    // Same liveness clock as runStreamed — the goal's 30min idle backstop must
    // also see raw activity, not just mapped events.
    let lastActivityAt = Date.now();
    async function* gen(): AsyncGenerator<AgentEvent> {
      // Clear any leftover goal on this thread FIRST. codex keeps a goal attached
      // even after it completes and re-broadcasts it on every resume (verified);
      // worse, a thread/goal/set whose objective is IDENTICAL to an already-complete
      // goal is a NO-OP — so re-running the same goal would do nothing and report
      // stale stats. And a leftover ACTIVE goal (from a crashed/killed run, or
      // pre-fix dirty data) auto-continues on resume. runGoal only runs when STARTING
      // a fresh goal (a busy session is gated out upstream), so any goal currently on
      // the thread is leftover — clearing it guarantees the set below makes a fresh,
      // actually-running goal and self-heals every leftover case.
      await self.client.request('thread/goal/clear', { threadId: self.sessionId }).catch(() => undefined);

      // thread/goal/set registers the goal AND auto-starts the first turn (codex
      // idle-continuation) — verified on 0.139, so we never call turn/start; codex
      // drives every turn. Race the set rejection so a disabled-feature / bad-param
      // error surfaces instead of hanging (mirrors runStreamed's start-race).
      let setError: Error | undefined;
      const setFailed: Promise<'set-failed'> = new Promise((resolve) => {
        self.client
          .request('thread/goal/set', { threadId: self.sessionId, objective })
          .then(undefined, (err: unknown) => {
            requests.close();
            setError = err instanceof Error ? err : new Error(String(err));
            log.fail('agent', setError, { phase: 'thread/goal/set' });
            resolve('set-failed');
          });
      });

      const stream = self.client.events()[Symbol.asyncIterator]();
      // Guard against a STALE goal snapshot: resuming a thread that had a prior
      // goal re-emits a thread/goal/updated for THAT goal (often already complete)
      // around resume time — before ours runs. If we honored it we'd "complete"
      // instantly with the old goal's stats and never do the work. So: ignore
      // goal_updates whose objective isn't ours, and don't honor a terminal status
      // until our goal has actually started (a turn started, or it went active).
      let armed = false;
      let ownedTurnId: string | undefined;
      let turnActive = false;
      let goalDone = false; // a terminal goal status was seen; drain the live turn, then stop
      try {
        while (true) {
          const step = await Promise.race([stream.next(), setFailed]);
          if (step === 'set-failed') {
            yield { type: 'error', message: setError?.message ?? 'thread/goal/set 请求失败', willRetry: false };
            return;
          }
          if (step.done) return;
          if (!('method' in step.value)) {
            if (step.value.kind === 'request_cancelled') {
              if (step.value.owner === requests) yield { type: 'ask_cancelled', requestId: step.value.requestId };
              continue;
            }
            if (requests.accepts(step.value, ownedTurnId)) {
              lastActivityAt = Date.now();
              yield { type: 'ask', request: step.value.request, subagentId: step.value.threadId === self.sessionId ? undefined : step.value.threadId };
            }
            continue;
          }
          const routed = self.routeNotification(step.value, ownedTurnId, true);
          if (!routed) continue;
          lastActivityAt = Date.now();
          for (const ev of routed) {
            if (ev.type === 'subagent_status' && ev.status !== 'running') {
              for (const id of requests.finishThread(ev.id)) yield { type: 'ask_cancelled', requestId: id };
            }
            if (ev.type === 'turn_started') {
              self.currentTurnId = ev.turnId;
              if (ownedTurnId && ownedTurnId !== ev.turnId) requests.finishTurn(ownedTurnId);
              ownedTurnId = ev.turnId;
              armed = true; // a real turn for our goal is running
              turnActive = true;
              yield ev;
              continue;
            }
            if (ev.type === 'done') {
              if (ownedTurnId) requests.finishTurn(ownedTurnId);
              ownedTurnId = undefined;
              turnActive = false;
              yield ev;
              // The goal is terminal AND its final turn just finished — now stop.
              if (goalDone) return;
              continue;
            }
            if (ev.type === 'goal_update') {
              if (ev.objective !== objective) continue; // stale snapshot for a different goal
              if (!armed && isGoalTerminal(ev.status)) continue;
              if (ev.status === 'active' || ev.status === 'paused') armed = true;
              yield ev;
              // A goal spans many auto-continued turns — a per-turn `done` is NOT the
              // end. On a terminal goal status: codex emits update_goal(complete) BEFORE
              // the model's closing answer (verified — the final agentMessage arrives a
              // couple seconds AFTER goal/complete), so returning here would cut the
              // result off. If a turn is in flight, keep consuming until its turn/completed
              // so the final answer renders; otherwise stop now.
              if (armed && isGoalTerminal(ev.status)) {
                if (turnActive) goalDone = true;
                else return;
              }
              continue;
            }
            if (ev.type === 'error' && !ev.willRetry) requests.close();
            yield ev;
            if (ev.type === 'error' && !ev.willRetry) return; // a fatal error kills the run
          }
        }
      } finally {
        requests.close();
        for (const child of self.children.values()) child.stopRequested = false;
        await stream.return?.();
        self.currentTurnId = undefined;
      }
    }
    return { events: gen(), askPending: id => requests.isPending(id), stopSubagent: (id) => self.stopSubagent(id), respondToAsk: (id, resolution) => requests.respond(id, resolution), turnId: () => self.currentTurnId, lastActivity: () => lastActivityAt };
  }

  private registerChild(id: string, child: Child, task = ''): AgentEvent[] {
    const existing = this.children.get(id);
    if (existing) {
      existing.running = true;
      existing.closed = false;
      if (child.nickname) existing.nickname = child.nickname;
      if (child.role) existing.role = child.role;
      if (child.parentId) existing.parentId = child.parentId;
      return [];
    }
    for (const [key, value] of this.children) if (value.closed) this.children.delete(key);
    while (this.children.size >= 64) {
      const oldest = [...this.children].find(([, value]) => !value.running);
      if (!oldest) break; // All live children must remain stoppable, even above the history budget.
      this.children.delete(oldest[0]);
    }
    this.children.set(id, child);
    return [{ type: 'subagent_start', id, parentId: child.parentId, name: child.nickname ?? child.role ?? '子 agent', task: task.slice(0, 120), stoppable: true }];
  }

  private registerFromItem(n: ServerNotification, parentId: string): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (n.method !== 'item/started' && n.method !== 'item/completed') return events;
    if (!n.params.item || typeof n.params.item !== 'object') return events;
    if (n.method === 'item/started' || n.method === 'item/completed') {
      const activity = readSubAgentActivity(n.params.item);
      if (activity?.kind === 'started') events.push(...this.registerChild(activity.agentThreadId, { parentId: parentId === this.sessionId ? undefined : parentId, running: true, nickname: activity.agentPath.split('/').pop() }));
    }
    if ((n.method === 'item/started' || n.method === 'item/completed') && n.params.item.type === 'collabAgentToolCall') {
      const item = n.params.item;
      if (item.tool === 'spawnAgent' || item.tool === 'sendInput' || item.tool === 'resumeAgent') {
        const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter(id => typeof id === 'string') : [];
        for (const id of receivers) events.push(...this.registerChild(id, { parentId: parentId === this.sessionId ? undefined : parentId, running: true }, item.prompt ?? ''));
      }
      if (n.method === 'item/completed') {
        const states = item.agentsStates && typeof item.agentsStates === 'object' && !Array.isArray(item.agentsStates) ? item.agentsStates : {};
        for (const [id, state] of Object.entries(states)) {
          const child = this.children.get(id);
          if (!child?.running || !state || typeof state !== 'object' || !['errored', 'shutdown', 'notFound'].includes(state.status)) continue;
          child.running = false;
          child.stopRequested = false;
          events.push({ type: 'subagent_status', id, status: state.status === 'errored' ? 'failed' : 'stopped' });
        }
      }
    }
    return events;
  }

  /** undefined means foreign/stale activity; an empty array still refreshes liveness. */
  private routeNotification(n: ServerNotification, ownedTurnId?: string, goal = false): AgentEvent[] | undefined {
    const p = n.params;
    if (!p || typeof p !== 'object') return;
    if (n.method === 'thread/started' && (!n.params.thread || typeof n.params.thread !== 'object')) return;
    if ((n.method === 'item/started' || n.method === 'item/completed') && (!n.params.item || typeof n.params.item !== 'object')) return;
    if ((n.method === 'turn/started' || n.method === 'turn/completed') && (!n.params.turn || typeof n.params.turn !== 'object' || typeof n.params.turn.id !== 'string')) return;
    if ('turn' in p && (!p.turn || typeof p.turn !== 'object' || !('id' in p.turn) || typeof p.turn.id !== 'string')) return;
    if (n.method === 'thread/started') {
      const spawn = readSubagentSpawn(n.params.thread.source);
      if (!spawn) return;
      if (spawn.parent_thread_id !== this.sessionId && !this.children.has(spawn.parent_thread_id)) return;
      return this.registerChild(n.params.thread.id, { parentId: spawn.parent_thread_id === this.sessionId ? undefined : spawn.parent_thread_id, running: true, nickname: spawn.agent_nickname ?? undefined, role: spawn.agent_role ?? undefined });
    }
    if (!('threadId' in p) || typeof p.threadId !== 'string') return;
    if (p.threadId === this.sessionId) {
      if ('turnId' in p && p.turnId !== ownedTurnId && !(goal && n.method === 'thread/goal/updated' && p.turnId === null)) return;
      if ('turn' in p && p.turn && typeof p.turn === 'object' && !(goal && n.method === 'turn/started') && p.turn.id !== ownedTurnId) return;
      const events = this.registerFromItem(n, this.sessionId);
      const mapped = mapNotification(n);
      if (mapped) events.push(mapped);
      return events;
    }
    const threadId = p.threadId;
    const child = this.children.get(threadId);
    if (!child) return;
    if (n.method !== 'turn/started' && child.turnId) {
      if ('turnId' in p && p.turnId !== child.turnId) return;
      if ('turn' in p && p.turn && typeof p.turn === 'object' && p.turn.id !== child.turnId) return;
    }
    const events = this.registerFromItem(n, p.threadId);
    const mapped = mapChildNotification(p.threadId, n, child);
    Object.assign(child, mapped.patch);
    if (n.method === 'turn/started' && child.stopRequested && child.turnId) {
      void this.client.request('turn/interrupt', { threadId: p.threadId, turnId: child.turnId })
        .catch(() => log.warn('agent', 'subagent-interrupt-failed', { id: threadId.slice(-6) }));
    }
    return [...events, ...mapped.events];
  }

  async injectContext(text: string): Promise<void> {
    await this.client.request('thread/inject_items', { threadId: this.sessionId,
      items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }] });
  }

  async clearGoal(): Promise<void> {
    await this.client.request('thread/goal/clear', { threadId: this.sessionId });
  }

  async steer(input: AgentInput, expectedTurnId: string): Promise<void> {
    await this.client.request('turn/steer', {
      threadId: this.sessionId,
      expectedTurnId,
      input: toUserInput(input),
    }, 30_000);
  }

  async stopSubagent(id: string): Promise<void> {
    const child = this.children.get(id);
    if (!child?.running) throw new Error('这个子 agent 已经结束');
    if (!child.turnId) throw new Error('这个子 agent 还没开始回合');
    await this.client.request('turn/interrupt', { threadId: id, turnId: child.turnId });
  }

  async abort(turnId: string): Promise<void> {
    const parentLive = turnId !== this.parentDoneTurnId;
    if (parentLive) this.client.cancelRequests(this.sessionId, turnId);
    const stops = parentLive ? [this.client.request('turn/interrupt', { threadId: this.sessionId, turnId })] : [];
    for (const [threadId, child] of this.children) {
      if (!child.running) continue;
      child.stopRequested = true;
      if (child.turnId) stops.push(this.client.request('turn/interrupt', { threadId, turnId: child.turnId }));
    }
    const results = await Promise.allSettled(stops);
    for (const result of results.slice(parentLive ? 1 : 0)) {
      if (result.status === 'rejected') log.warn('agent', 'subagent-interrupt-failed');
    }
    const main = results[0];
    if (parentLive && main?.status === 'rejected') throw main.reason;
  }

  async compact(): Promise<CompactResult> {
    // thread/compact/start only ACKS the kickoff; compaction then runs as a
    // background turn and ends with turn/completed (done). We MUST drain the
    // stream to that terminal — both so the caller knows compaction truly
    // finished (its "压缩中" card can flip to "压缩完成"), and so a trailing
    // turn/completed doesn't leak into the NEXT real turn's stream (which would
    // read a premature `done` and reply "未返回内容"). Mirrors runStreamed's
    // start-race so an immediate rejection (e.g. unsupported on old codex)
    // surfaces instead of hanging.
    let startError: Error | undefined;
    const startFailed: Promise<'start-failed'> = new Promise((resolve) => {
      this.client.request('thread/compact/start', { threadId: this.sessionId }).then(undefined, (err: unknown) => {
        startError = err instanceof Error ? err : new Error(String(err));
        log.fail('agent', startError, { phase: 'thread/compact/start' });
        resolve('start-failed');
      });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout: Promise<'timeout'> = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), COMPACT_TIMEOUT_MS);
    });

    const stream = this.client.stream()[Symbol.asyncIterator]();
    let compacted = false;
    let usage: CompactResult['usage'] = null;
    try {
      while (true) {
        const step = await Promise.race([stream.next(), startFailed, timeout]);
        if (step === 'start-failed') throw startError ?? new Error('thread/compact/start 请求失败');
        if (step === 'timeout') {
          void this.close().catch(error => log.fail('agent', error, { phase: 'compact-close' }));
          throw new Error(`压缩超时（codex 未在 ${COMPACT_TIMEOUT_MS / 1000}s 内完成）`);
        }
        if (step.done) break;
        const ev = mapNotification(step.value);
        if (!ev) continue;
        if (ev.type === 'context_usage') usage = { usedTokens: ev.usedTokens, contextWindow: ev.contextWindow };
        else if (ev.type === 'compaction' && ev.phase === 'end' && !ev.failed) compacted = true;
        else if (ev.type === 'error' && !ev.willRetry) throw new Error(ev.message);
        else if (ev.type === 'done') break;
      }
    } finally {
      if (timer) clearTimeout(timer);
      await stream.return?.();
    }
    return { compacted, usage };
  }

  isAlive(): boolean {
    return !this.client.exited;
  }

  close(): Promise<void> {
    this.entry?.revoke('closed');
    return this.client.close();
  }
}

export class CodexAppServerBackend implements AgentBackend {
  readonly profileCapabilities = {
    instructions: { channel: 'developer', replaceOnResume: false },
    additionalRoots: true, directoryAccess: true, capabilityPackages: true, mcpServers: false,
    env: true, disableNativeMemory: true,
    reapplyOnResume: ['env', 'nativeSettings', 'workspaceTrust', 'additionalRoots', 'directoryAccess'],
  } satisfies SessionProfileCapabilities;
  readonly id = 'codex-appserver';
  readonly displayName = 'Codex (app-server)';
  private modelCache: ModelInfo[] | null = null;
  private modelReadGeneration = 0;

  async listSkills({ cwd }: { cwd: string; directories?: string[] }): Promise<AgentSkill[]> {
    const result = await utilityRequest<{ data: Array<{ cwd: string; skills: Array<{ path: string; name: string; description: string; scope: string; enabled: boolean }>; errors?: Array<{ message: string }> }> }>('skills/list', { cwds: [cwd], forceReload: true });
    const row = result.data.find(item => item.cwd === cwd) ?? result.data[0];
    if (!row) throw new Error('Codex 未返回技能目录');
    if (row.errors?.length) throw new Error(`Codex 技能目录读取失败：${row.errors.map(error => error.message).join('；')}`);
    return row.skills.map(skill => ({ path: skill.path, name: skill.name, description: skill.description,
      source: skill.scope === 'repo' ? 'workspace' : skill.scope === 'user' ? 'user' : 'provider', enabled: skill.enabled }));
  }

  constructor(private readonly titleDeps: CodexTitleBackendDeps = DEFAULT_TITLE_DEPS) {}

  fullAccessOnly(): string | undefined {
    const bin = resolveCodexBin();
    const version = bin ? cachedCodexVersion(bin) : undefined;
    if (version === undefined && process.platform !== 'win32') return undefined;
    const reason = codexTierUnavailable('qa', process.platform, version ?? null,
      bin && process.platform === 'win32' ? cachedWindowsSandbox(bin) : undefined);
    if (!reason && bin && process.platform === 'win32') {
      const shell = windowsShellPath(bin);
      if (shell) {
        try { codexShellReadRoot(shell); } catch (error) { return error instanceof Error ? error.message : '无法确认 PowerShell 运行时读取范围，请重新检测。'; }
      }
    }
    return reason;
  }

  async refreshPermissions(opts?: { force?: boolean; cached?: boolean; selectedBin?: string | null }): Promise<void> {
    if (process.platform !== 'win32') return;
    const bin = opts?.selectedBin === undefined ? await refreshCodexResolution(opts) : opts.selectedBin;
    if (!bin) return;
    if (opts?.cached && !opts.force && cachedWindowsSandbox(bin)) return;
    const version = await codexVersionAsync(bin, opts);
    // A version-only check is cheap and cannot accidentally start sandbox setup.
    if (!codexTierUnavailable('qa', 'win32', version, { status: 'ready', implementation: 'mxc' })) {
      await refreshWindowsSandbox(bin, opts);
    }
  }

  async isAvailable(): Promise<boolean> {
    return (await this.doctor()).ok;
  }

  async doctor(opts?: { force?: boolean; permissions?: boolean }): Promise<BackendProbe> {
    // async 版本探测：DM 体检等卡片回调会 await 这里，同步 spawn 会冻结事件循环。
    // force 绕过 locate 模块缓存重新探测（体检要看「现在」的状态）。
    const probe = opts?.force ? { force: true as const } : undefined;
    const bin = await refreshCodexResolution(probe);
    if (!bin) {
      return {
        ok: false,
        version: null,
        hint: '未找到。设置 CODEX_BIN，或安装 @openai/codex，或装 Codex.app',
      };
    }
    const version = await codexVersionAsync(bin, process.env.CODEX_BIN ? probe : undefined);
    if (!version) {
      return { ok: false, version: null, location: bin, hint: `codex --version 执行失败（${bin}）` };
    }
    // Resolution/version above already established this binary's version evidence.
    if (opts?.permissions !== false) {
      if (process.platform === 'win32' && !codexTierUnavailable('qa', 'win32', version, { status: 'ready', implementation: 'mxc' })) {
        await refreshWindowsSandbox(bin, opts);
      }
    }
    return { ok: true, version, location: bin,
      ...(process.platform === 'win32' ? { hint: this.fullAccessOnly() } : {}) };
  }

  async loginStatus(opts?: { refresh?: boolean }): Promise<import('../types').BackendLogin> {
    try {
      const account = await utilityRequest<{ requiresOpenaiAuth: boolean; account: unknown }>('account/read', { refreshToken: opts?.refresh === true });
      if (account.requiresOpenaiAuth === false) return { state: 'notRequired', message: '用的是自定义 Provider，可用。', account: {kind: 'api', apiProvider: 'custom'} };
      if (account.requiresOpenaiAuth === true && account.account && typeof account.account === 'object') return { state: 'signedIn', message: '可用（OpenAI 账号）。', account: codexAccountMetadata(account.account) ?? {kind: 'unknown'} };
      if (account.requiresOpenaiAuth === true && account.account === null) return { state: 'signedOut', message: '没配置好。' };
    } catch { /* preserve an unknown state; callers must not treat it as signed in */ }
    return { state: 'unknown', message: '无法确认 Codex 的配置。' };
  }

  async listModels(opts?: { refresh?: boolean }): Promise<ModelInfo[]> {
    // Start before resolution/version awaits: any older call can finish after a
    // refresh, but must not erase the capabilities used by subsequently opened threads.
    const generation = ++this.modelReadGeneration;
    const bin = await refreshCodexResolution();
    if (!bin) { if (generation === this.modelReadGeneration) this.modelCache = null; return []; }
    // Explicit paths skip candidate ranking. Establish their version evidence
    // before taking the catalog key, since discovery can read it for tier access.
    await codexVersionAsync(bin);
    try {
      const models = await codexCatalogCache.read(bin, opts?.refresh);
      if (generation === this.modelReadGeneration) this.modelCache = models;
      return models;
    } catch {
      if (generation === this.modelReadGeneration) this.modelCache = null;
      // Native config errors can quote lines containing private API settings.
      log.warn('agent', 'Codex model discovery failed', { phase: 'model/list' });
      return [];
    }
  }

  /** Apply the actual session configuration without expanding account access. */
  async listModelsForCwd(cwd: string, opts?: { refresh?: boolean }): Promise<ModelInfo[]> {
    const models = await this.listModels(opts);
    const bin = resolveCodexBin();
    return bin && this.peekModels() ? constrainCodexModelTiers(bin, models, cwd)
      : models.map(({serviceTiers: _tiers, ...model}) => model);
  }

  /** The cached `model/list`, or undefined; never fetches. */
  peekModels(): ModelInfo[] | undefined {
    const bin = resolveCodexBin();
    return bin ? codexCatalogCache.peek(bin) : undefined;
  }

  private threadEffortSupport(): (model: string) => boolean {
    // A re-detection can replace/clear the picker directory while older threads
    // still run. Keep each thread's known capabilities for those models.
    const support = new Map(this.modelCache?.map(model => [model.id, model.supportedEfforts.length > 0]));
    return model => {
      if (!support.has(model)) {
        const info = this.modelCache?.find(value => value.id === model);
        if (info) support.set(model, info.supportedEfforts.length > 0);
      }
      return support.get(model) !== false;
    };
  }

  /** One smart-mode judgement on the resident judge process (s23b, judge-process.ts). */
  judge(call: JudgeCall): Promise<JudgeCallOutput> {
    return runCodexJudge(call);
  }

  async listThreads(cwd: string, limit = 15): Promise<ThreadSummary[]> {
    if (!resolveCodexBin()) return [];
    try {
      // cwd 是 thread/list 的过滤参数，与 utility 进程的 cwd 无关。
      const res = await utilityRequest<{ data?: RawThread[] }>('thread/list', {
        cwd,
        limit,
        sortKey: 'created_at',
        sortDirection: 'desc',
      });
      return (res.data ?? [])
        .filter((t) => !t.ephemeral)
        .map((t) => ({
          sessionId: t.id,
          preview: t.preview ?? '',
          createdAt: t.createdAt ?? 0,
          updatedAt: t.updatedAt ?? t.createdAt ?? 0,
          name: t.name ?? undefined,
        }));
    } catch (err) {
      log.fail('agent', err, { phase: 'thread/list' });
      return [];
    }
  }

  async readHistory(cwd: string, sessionId: string, maxTurns = 10): Promise<ThreadHistory> {
    void cwd; // thread/read 按 threadId 寻址，cwd 仅为接口形状保留
    const empty: ThreadHistory = { turns: [], totalTurns: 0 };
    if (!resolveCodexBin()) return empty;
    // 常驻 utility client（M-2）。thread/read does NOT start a turn or load the
    // thread live — it just reads the rollout, so no token cost; the session is
    // resumed lazily on the topic's first message via resolveThread. The deadline
    // keeps the old hang-protection: on timeout utilityRequest discards (SIGKILLs)
    // the wedged process, so no orphan and the resume card still resolves.
    try {
      const res = await utilityRequest<{ thread: Thread }>(
        'thread/read',
        { threadId: sessionId, includeTurns: true },
        { timeoutMs: READ_HISTORY_TIMEOUT_MS },
      );
      const thread = res.thread;
      const all = (Array.isArray(thread?.turns) ? thread.turns : [])
        .map(mapTurn)
        .filter((t) => t.userText || t.assistantText || t.tools.length);
      const totalTurns = all.length;
      const turns = totalTurns > maxTurns ? all.slice(totalTurns - maxTurns) : all;
      return {
        turns,
        totalTurns,
        name: thread?.name ?? undefined,
        preview: thread?.preview ?? undefined,
        createdAt: thread?.createdAt,
        updatedAt: thread?.updatedAt,
      };
    } catch (err) {
      log.fail('agent', err, { phase: 'thread/read', sessionId });
      return empty;
    }
  }

  async readSessionTitle(cwd: string, sessionId: string): Promise<string | undefined> {
    void cwd; // thread/read is addressed by threadId; cwd remains backend-neutral API shape.
    const res = await this.titleDeps.utilityRequest<{ thread: Thread }>(
      'thread/read',
      { threadId: sessionId, includeTurns: false },
      { timeoutMs: READ_HISTORY_TIMEOUT_MS },
    );
    const title = res.thread?.name?.trim();
    return title || undefined;
  }

  async setSessionTitle(cwd: string, sessionId: string, title: string): Promise<void> {
    void cwd;
    const clean = title.trim();
    if (!clean) throw new Error('Cannot set an empty Codex session title');
    await this.titleDeps.utilityRequest('thread/name/set', { threadId: sessionId, name: clean });
  }

  async generateSessionTitle(opts: GenerateSessionTitleOptions): Promise<string | undefined> {
    const bin = this.titleDeps.resolveBin();
    if (!bin) throw new Error('codex CLI not found (set CODEX_BIN or install @openai/codex)');
    const client = this.titleDeps.createClient(bin, opts.cwd);
    try {
      return await withTitleDeadline(
        (async () => {
          await client.connect();
          return generateCodexSessionTitleWithClient(client, opts);
        })(),
      );
    } finally {
      await client.close().catch((err: unknown) => {
        log.fail('agent', err, { phase: 'title/close' });
      });
    }
  }

  async startThread(opts: StartThreadOptions): Promise<AgentThread> {
    // Build sandbox params first — the platform fail-closed guard throws here,
    // before we spawn, so a rejected tier leaves no orphan app-server process.
    // Auto-compaction is codex's own default and stays on (s12): no
    // model_auto_compact_token_limit override, and newer codex caps any limit at
    // 90% of the window anyway.
    const bin = await refreshCodexResolution();
    const version = bin ? await codexVersionAsync(bin) : null;
    if (bin && process.platform === 'win32' && (opts.mode ?? 'full') !== 'full') await this.refreshPermissions({ selectedBin: bin });
    const params = codexSessionParams(opts, version, bin);
    await admitCodexWorkspaceLayout(opts);
    const client = await this.spawn(opts.cwd, bin);
    let nativeServiceTier: string | null | undefined;
    let res: { thread: { id: string } };
    try {
      nativeServiceTier = await readNativeServiceTier(client, opts.cwd);
      res = await client.request<{ thread: { id: string } }>('thread/start', { ...params, ...startDynamicTools(opts) });
      verifyCodexWorkspaceEcho(res, opts);
    } catch (err) {
      await client.close().catch((closeErr: unknown) => log.fail('agent', closeErr, { phase: 'start-close' }));
      throw err;
    }
    return new CodexThread(client, res.thread.id, opts.model, opts.effort, opts.serviceTier, nativeServiceTier, false, undefined, opts.entry,
      this.threadEffortSupport());
  }

  async resumeThread(opts: ResumeThreadOptions): Promise<AgentThread> {
    const bin = await refreshCodexResolution();
    const version = bin ? await codexVersionAsync(bin) : null;
    if (bin && process.platform === 'win32' && (opts.mode ?? 'full') !== 'full') await this.refreshPermissions({ selectedBin: bin });
    const params = codexSessionParams(opts, version, bin);
    await admitCodexWorkspaceLayout(opts);
    const client = await this.spawn(opts.cwd, bin);
    let nativeServiceTier: string | null | undefined;
    let res: { thread: { id: string; turns?: Turn[] } };
    try {
      nativeServiceTier = await readNativeServiceTier(client, opts.cwd);
      // A saved Codex thread may carry an earlier explicit fast tier. A Vonvon
      // session now inheriting must resume at Codex's current configured default.
      if (opts.serviceTier === undefined) {
        if (nativeServiceTier === undefined) throw new CodexServiceTierError('无法读取 Codex 原生响应速度，原会话已保留，请稍后重试。');
        params.serviceTier = nativeServiceTier;
      }
      res = await client.request<{ thread: { id: string; turns?: Turn[] } }>('thread/resume', {
        threadId: opts.sessionId,
        ...params,
      });
      verifyCodexWorkspaceEcho(res, opts);
    } catch (err) {
      // This process holds nothing yet; a refused resume must not leave it running.
      await client.close().catch((closeErr: unknown) => log.fail('agent', closeErr, { phase: 'resume-close' }));
      if (isWriterConflict(err)) throw new SessionInUseError(opts.sessionId, err);
      throw err;
    }
    return new CodexThread(client, res.thread.id, opts.model, opts.effort, opts.serviceTier, nativeServiceTier, true, lastCompactionOf(res.thread.turns), opts.entry,
      this.threadEffortSupport());
  }

  private async spawn(cwd: string, selectedBin?: string | null): Promise<AppServerClient> {
    const bin = selectedBin === undefined ? await refreshCodexResolution() : selectedBin;
    if (!bin) throw new Error('codex CLI not found (set CODEX_BIN or install @openai/codex)');
    // 预热池（M-2）：取走（或扑空）都异步补位——下一个会话拿到的就是热进程
    // （MCP 已启动，thread/start 从 ~2.1s 冷路径降到 ~64ms）。热进程的 spawn
    // cwd 是中性目录，没关系：thread/start|resume 的 cwd 是 thread 级参数。
    // 扑空时先连上再补位：空的 CODEX_HOME 里两个进程同时首启必有一个退出（R3-1）。
    const warmed = takeWarmClient(bin);
    if (warmed) {
      void refillWarmPool();
      return warmed;
    }
    const client = new AppServerClient({ bin, cwd });
    await connectGated(client, bin);
    void refillWarmPool();
    return client;
  }
}

/** A second writer is refused with `thread-store conflict: thread … already has an active
 * writer` (-32600): codex-cli 0.162.1 (e14) and 0.163.0 (s15b, 2026-10-16). */
function isWriterConflict(err: unknown): boolean {
  return /already has an active writer/.test(err instanceof Error ? err.message : String(err));
}

/** The last compaction item in a resumed thread's turns: its id stays the same across resumes. */
function lastCompactionOf(turns: Turn[] | undefined): string | undefined {
  const items = (turns ?? []).flatMap((turn) => (turn.items ?? []) as ThreadItem[]);
  return items.filter((item) => item.type === 'contextCompaction').at(-1)?.id;
}

/** Skip codex's injected boilerplate so it never shows as a "user message". */
function isBoilerplateUserText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<environment_context>') || t.startsWith('# AGENTS.md instructions');
}

/**
 * Fold one codex {@link Turn}'s items into a renderable {@link HistoryTurn}.
 * Mirrors event-map.ts's item handling but also captures `userMessage` (the
 * stream path never emits the user's own input, so that case is unique here).
 */
function mapTurn(turn: Turn): HistoryTurn {
  const userParts: string[] = [];
  const assistantParts: string[] = [];
  const reasoningParts: string[] = [];
  const tools: HistoryTool[] = [];
  for (const item of (turn.items ?? []) as ThreadItem[]) {
    switch (item.type) {
      case 'userMessage': {
        const text = item.content
          .map((c) => (c.type === 'text' ? c.text : c.type === 'mention' ? `@${c.name}` : ''))
          .join('')
          .trim();
        if (text && !isBoilerplateUserText(text)) userParts.push(text);
        break;
      }
      case 'agentMessage':
        if (item.text.trim()) assistantParts.push(item.text);
        break;
      case 'reasoning': {
        const r = (item.content.length ? item.content : item.summary).join('\n').trim();
        if (r) reasoningParts.push(r);
        break;
      }
      case 'commandExecution':
        tools.push({
          title: item.command,
          output: item.aggregatedOutput ?? undefined,
          exitCode: item.exitCode,
          failed: item.status === 'failed' || item.status === 'declined' || (item.exitCode ?? 0) !== 0,
        });
        break;
      case 'fileChange':
        tools.push({ title: '编辑文件', failed: item.status === 'failed' || item.status === 'declined' });
        break;
      case 'webSearch':
        tools.push({ title: `联网搜索：${item.query}` });
        break;
      case 'mcpToolCall':
        tools.push({ title: `${item.server} / ${item.tool}`, failed: item.status === 'failed' || Boolean(item.error) });
        break;
      case 'dynamicToolCall':
        tools.push({ title: item.tool, failed: item.status === 'failed' || item.success === false });
        break;
      // plan / contextCompaction / review-mode / image* — omitted from the digest
      default:
        break;
    }
  }
  return {
    userText: userParts.join('\n\n'),
    assistantText: assistantParts.join('\n\n'),
    reasoning: reasoningParts.join('\n\n'),
    tools,
    startedAt: turn.startedAt ?? undefined,
  };
}

interface RawThread {
  id: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  name?: string | null;
  ephemeral?: boolean;
}

export const OFFLINE_CODEX_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    description: '默认模型',
    hidden: false,
    isDefault: true,
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
];
