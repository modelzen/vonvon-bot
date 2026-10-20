import { log } from '../../core/logger';
import type {
  AgentBackend,
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
import { resolveSessionProfile, type SessionProfileCapabilities } from '../session-profile';
import { AppServerClient } from './app-server-client';
import { NATIVE_MEMORY_OFF } from './memory-config';
import { connectGated, refillWarmPool, takeWarmClient, utilityRequest } from './client-pool';
import { mapChildNotification, mapNotification, readSubAgentActivity, readSubagentSpawn, type Child } from './event-map';
import { runCodexJudge } from './judge-process';
import { CODEX_FULL_ONLY, CodexFullOnlyError, codexConfinesReads } from './full-only';
import { codexVersionAsync, resolveCodexBin } from './locate';
import type { ServerNotification, Thread, ThreadItem, Turn, TurnStartResponse } from './protocol';

const APPROVAL_POLICY = 'never';

/**
 * Map a permission tier to the thread/start|resume params that enforce it.
 * 'full' (or unset) keeps the historical danger-full-access. 'qa'/'write' send a
 * custom codex permissions profile ("feishu") whose filesystem rules confine
 * BOTH reads and writes to the workspace roots (cwd). Only macOS enforces that,
 * with Seatbelt (verified: thread/start reports activePermissionProfile
 * .id="feishu", reads outside cwd like ~/.ssh are denied).
 * `:minimal` keeps the read access codex needs to run commands at all.
 *
 * fail-closed: on Linux codex's sandbox only ro-binds the disk (writes blocked,
 * READS still open — Landlock read-restriction is unimplemented) AND it does NOT
 * refuse, so a privacy tier there would silently run unconfined. We must NEVER
 * do that — so 'qa'/'write' throw {@link CodexFullOnlyError} BEFORE spawn on any
 * platform but macOS (a clear run error, never a downgrade). Group turns are
 * refused earlier, with a reply (handle-message's refuseFullOnly).
 */
export function sandboxParams(
  mode: PermissionMode | undefined,
  network: boolean | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
  if ((mode ?? 'full') === 'full') return { sandbox: 'danger-full-access' };
  if (!codexConfinesReads(platform)) throw new CodexFullOnlyError();
  return {
    config: {
      default_permissions: 'feishu',
      permissions: {
        feishu: {
          filesystem: {
            ':minimal': 'read',
            ':workspace_roots': { '.': mode === 'write' ? 'write' : 'read' },
          },
          network: { enabled: Boolean(network) },
        },
      },
    },
  };
}

/** Rebuilt for every start/resume; never persists workspace trust to user config. */
export function codexSessionParams(opts: StartThreadOptions): Record<string, unknown> {
  const profile = resolveSessionProfile(opts.profile);
  const sandbox = sandboxParams(opts.mode, opts.network);
  return {
    ...sandbox,
    cwd: opts.cwd,
    approvalPolicy: APPROVAL_POLICY,
    developerInstructions: profile.instructions,
    ...(opts.model ? { model: opts.model } : {}),
    config: {
      ...(typeof sandbox.config === 'object' ? sandbox.config : {}),
      projects: { [opts.cwd]: { trust_level: 'trusted' } },
      ...NATIVE_MEMORY_OFF,
      shell_environment_policy: { set: profile.env },
    },
  };
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
    config: {
      ...NATIVE_MEMORY_OFF,
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

  private runningChildren(): number {
    return [...this.children.values()].filter(child => child.running).length;
  }
  private children = new Map<string, Child>();

  constructor(
    private readonly client: AppServerClient,
    readonly sessionId: string,
    private model: string | undefined,
    private effort: ReasoningEffort | undefined,
    /** Resumed, or a turn was started: codex has it on disk. A thread that only had
     * thread/start resumes as `thread not loaded`, so it is kept until its first turn. */
    private onDisk: boolean,
    readonly lastCompaction?: string,
    private readonly entry?: AgentEntry,
  ) {}

  get releaseAfterRun(): boolean {
    return this.onDisk;
  }

  runStreamed(input: AgentInput, turn?: TurnOptions): AgentRun {
    const self = this;
    this.currentTurnId = undefined;
    // Per-turn overrides persist for subsequent turns (matches turn/start semantics).
    if (turn?.model) this.model = turn.model;
    if (turn?.effort) this.effort = turn.effort;
    // Liveness clock for the idle watchdog: refreshed on EVERY raw notification
    // below (even ones mapNotification drops, like command output deltas), so a
    // long-running shell command doesn't read as "wedged".
    let lastActivityAt = Date.now();
    const params: Record<string, unknown> = {
      threadId: self.sessionId,
      input: toUserInput(input),
    };
    if (self.model) params.model = self.model;
    if (self.effort) params.effort = self.effort;

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

  runGoal(objective: string): AgentRun {
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
    additionalRoots: false, directoryAccess: false, capabilityPackages: false, mcpServers: false,
    env: true, disableNativeMemory: true,
    reapplyOnResume: ['env', 'nativeSettings', 'workspaceTrust'],
  } satisfies SessionProfileCapabilities;
  readonly id = 'codex-appserver';
  readonly displayName = 'Codex (app-server)';
  private modelCache: ModelInfo[] | null = null;

  constructor(private readonly titleDeps: CodexTitleBackendDeps = DEFAULT_TITLE_DEPS) {}

  fullAccessOnly(): string | undefined {
    return codexConfinesReads() ? undefined : CODEX_FULL_ONLY;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.doctor()).ok;
  }

  async doctor(opts?: { force?: boolean }): Promise<BackendProbe> {
    // async 版本探测：DM 体检等卡片回调会 await 这里，同步 spawn 会冻结事件循环。
    // force 绕过 locate 模块缓存重新探测（体检要看「现在」的状态）。
    const probe = opts?.force ? { force: true as const } : undefined;
    const bin = resolveCodexBin(probe);
    if (!bin) {
      return {
        ok: false,
        version: null,
        hint: '未找到。设置 CODEX_BIN，或安装 @openai/codex，或装 Codex.app',
      };
    }
    const version = await codexVersionAsync(bin, probe);
    if (!version) {
      return { ok: false, version: null, location: bin, hint: `codex --version 执行失败（${bin}）` };
    }
    return { ok: true, version, location: bin };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache) return this.modelCache;
    if (!resolveCodexBin()) return STATIC_MODELS;
    try {
      // 常驻 utility client（M-2）：原本每次付一套 spawn+initialize，现在共享复用。
      const res = await utilityRequest<{ data?: RawModel[] }>('model/list', { limit: 50 });
      const models = (res.data ?? []).map(mapModel);
      // 空列表和失败一样：回落兜底但不缓存，下次再问（handle-message 的 listModels 注释）。
      if (!models.length) return STATIC_MODELS;
      this.modelCache = models;
      return models;
    } catch (err) {
      log.fail('agent', err, { phase: 'model/list' });
      return STATIC_MODELS;
    }
  }

  /** The cached `model/list`, or undefined; never fetches (the judge path must not wait for it). */
  peekModels(): ModelInfo[] | undefined {
    return this.modelCache ?? undefined;
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
    const params = codexSessionParams(opts);
    const client = await this.spawn(opts.cwd);
    let res: { thread: { id: string } };
    try {
      res = await client.request<{ thread: { id: string } }>('thread/start', params);
    } catch (err) {
      await client.close().catch((closeErr: unknown) => log.fail('agent', closeErr, { phase: 'start-close' }));
      throw err;
    }
    return new CodexThread(client, res.thread.id, opts.model, opts.effort, false, undefined, opts.entry);
  }

  async resumeThread(opts: ResumeThreadOptions): Promise<AgentThread> {
    const params = codexSessionParams(opts);
    const client = await this.spawn(opts.cwd);
    let res: { thread: { id: string; turns?: Turn[] } };
    try {
      res = await client.request<{ thread: { id: string; turns?: Turn[] } }>('thread/resume', {
        threadId: opts.sessionId,
        ...params,
      });
    } catch (err) {
      // This process holds nothing yet; a refused resume must not leave it running.
      await client.close().catch((closeErr: unknown) => log.fail('agent', closeErr, { phase: 'resume-close' }));
      if (isWriterConflict(err)) throw new SessionInUseError(opts.sessionId, err);
      throw err;
    }
    return new CodexThread(client, res.thread.id, opts.model, opts.effort, true, lastCompactionOf(res.thread.turns), opts.entry);
  }

  private async spawn(cwd: string): Promise<AppServerClient> {
    const bin = resolveCodexBin();
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

interface RawModel {
  id: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: ReasoningEffort }[];
  defaultReasoningEffort?: ReasoningEffort;
}

function mapModel(m: RawModel): ModelInfo {
  return {
    id: m.id,
    displayName: m.displayName ?? m.id,
    description: m.description ?? '',
    hidden: m.hidden ?? false,
    isDefault: m.isDefault ?? false,
    supportedEfforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
    defaultEffort: m.defaultReasoningEffort ?? 'medium',
  };
}

const STATIC_MODELS: ModelInfo[] = [
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
