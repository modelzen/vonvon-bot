import { log } from '../../core/logger';
import { codexErrorKind, errorKindFromText } from '../error-kind';
import { JudgeCallError, type JudgeCall, type JudgeCallOutput } from '../types';
import { AppServerClient, JsonRpcError } from './app-server-client';
import { binFingerprint, closeDiscarded, CONNECT_TIMEOUT_MS, poolAccepting, trackResident, withDeadline } from './client-pool';
import { codexVersionAsync, resolveCodexBin } from './locate';
import type { ServerNotification, TurnStartResponse } from './protocol';
import type { CodexErrorInfo } from './protocol/generated/v2/CodexErrorInfo';
import { CODEX_MIN_VERSION, compareCodexVersions, parseCodexVersion } from './version';

/**
 * The Codex judge process (s23b, design 3.2): one resident `codex app-server` per bot process, apart
 * from the session, utility and prewarm processes. It comes up on the first judgement and closes
 * after 10 idle minutes. Each judgement runs one turn on its own ephemeral thread and ends with
 * `thread/unsubscribe`; notifications are routed by threadId.
 *
 * Two deadlines are kept apart. The caller's (timeout, abort, shutdown) only makes this judgement
 * give up: its RPCs still wait for their replies in the background, so a late `thread/start` reply
 * still gets its `thread/unsubscribe` and a running turn its `turn/interrupt`. A process is judged
 * stuck only when one RPC goes {@link JUDGE_RPC_STUCK_MS} without a reply, however little time the
 * caller had left; then it is killed and the judgements on it fail.
 */

/** One RPC without a reply this long means the process is wedged. */
export const JUDGE_RPC_STUCK_MS = 15_000;
export const JUDGE_IDLE_MS = 10 * 60_000;
/** No new process this long after a connect failure, an unexpected exit or a stuck kill. */
export const JUDGE_BACKOFF_MS: readonly number[] = [5_000, 15_000, 60_000];
const INVENTORY_TIMEOUT_MS = 5_000;

/** Replaces Codex's own ~18k-character system prompt (s23b spike: 9.1k → 5.6k input tokens). */
export const JUDGE_BASE_INSTRUCTIONS =
  '你是群消息分诊器，只按开发者指令判断一条群消息要不要回、回在哪里。\n不调用工具，只输出要求的 JSON。';

/** The keys that made the tool list shorter on 0.156.1 and 0.163.0 against a fake Responses
 * server (s23b spike). Misspelt keys are ignored silently, so only measured ones are here. */
export const TOOL_OFF_KEYS = {
  'features.shell_tool': false, // exec_command, write_stdin
  'features.goals': false, // get_goal, create_goal, update_goal
  'features.view_image': false, // view_image
  'features.sleep_tool': false, // clock.sleep (code mode)
} as const;

export interface JudgeProcessOptions {
  stuckMs: number;
  /** spawn to `initialize` reply */
  connectMs: number;
  idleMs: number;
  backoffMs: readonly number[];
  resolveBin(): string | null;
  /** read once per process, only when a "not supported" error needs it; forced past the locate
   * cache, which cannot see an in-place upgrade */
  version(bin: string): Promise<string | null>;
  now(): number;
}

const DEFAULTS: JudgeProcessOptions = {
  stuckMs: JUDGE_RPC_STUCK_MS,
  connectMs: CONNECT_TIMEOUT_MS,
  idleMs: JUDGE_IDLE_MS,
  backoffMs: JUDGE_BACKOFF_MS,
  resolveBin: () => resolveCodexBin(),
  version: bin => codexVersionAsync(bin, { force: true }),
  now: Date.now,
};
let opts = DEFAULTS;

/** For tests: shorter deadlines, an injected version. */
export function configureJudgeProcess(overrides: Partial<JudgeProcessOptions>): void {
  opts = { ...DEFAULTS, ...overrides };
}

const stats = { spawned: 0, interrupts: 0, unsubscribes: 0, stuck: 0 };

/** For tests (judge-real-codex): what the judge process did so far. */
export function judgeProcessStats(): typeof stats & { pid: number | undefined } {
  return { ...stats, pid: current?.client.pid };
}

interface Slot {
  client: AppServerClient;
  bin: string;
  fingerprint: string | null;
  inflight: number;
  /** why we closed it; unset = it exited on its own */
  ending?: 'idle' | 'retired' | 'stuck';
  watches: Map<string, Watch>;
  idleTimer?: NodeJS.Timeout;
  version?: Promise<string | null>;
  inventoryLogged?: string;
}

let current: Slot | null = null;
let creating: Promise<Slot> | null = null;
let backoffStep = 0;
let backoffUntil = 0;

const closedError = (): JudgeCallError => new JudgeCallError('closed', 'bot 正在关闭', false);
const goneError = (): JudgeCallError => poolAccepting()
  ? new JudgeCallError('failed', 'Codex 判断进程退出了', false)
  : closedError();
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** The turn id of a `turn/start` reply, if the reply has one (a malformed reply must not throw). */
const turnIdOf = (reply: TurnStartResponse | null | undefined): string | undefined => {
  const id = (reply as { turn?: { id?: unknown } } | null | undefined)?.turn?.id;
  return typeof id === 'string' && id ? id : undefined;
};

function startBackoff(): void {
  const ms = opts.backoffMs[Math.min(backoffStep, opts.backoffMs.length - 1)] ?? 0;
  backoffStep++;
  backoffUntil = opts.now() + ms;
  log.info('judge', 'backoff', { backoffMs: ms });
}

/** Classifies a failed turn or RPC (design 3.1). */
async function classify(slot: Slot, message: string, info?: CodexErrorInfo | null): Promise<JudgeCallError> {
  const coded = codexErrorKind(info);
  if (coded) return new JudgeCallError(coded, message, true);
  if (/not supported when using Codex with a ChatGPT account/i.test(message)) {
    // Both e05 cases were a Codex too old for the model; the server's line keeps moving up.
    slot.version ??= opts.version(slot.bin).catch(() => null);
    const version = parseCodexVersion(await slot.version);
    let old = false;
    try { old = version !== null && compareCodexVersions(version, CODEX_MIN_VERSION) < 0; } catch { /* unparsable: model */ }
    return new JudgeCallError(old ? 'version' : 'model', message, true);
  }
  const kind = errorKindFromText(message);
  if (kind === 'version') return new JudgeCallError('version', message, true);
  return new JudgeCallError(kind ?? 'failed', message, false);
}

/** Collects one judgement's turn from the routed notifications. */
class Watch {
  finished = false;
  private finalText: string | undefined;
  private lastText: string | undefined;
  private readonly deltas = new Map<string, string>();
  private usage: JudgeCallOutput['usage'];
  private resolveDone!: (value: { text: string; usage: JudgeCallOutput['usage'] }) => void;
  private rejectDone!: (error: unknown) => void;
  readonly done = new Promise<{ text: string; usage: JudgeCallOutput['usage'] }>((resolve, reject) => {
    this.resolveDone = resolve;
    this.rejectDone = reject;
  });
  private resolveTurnId!: (id: string) => void;
  /** from the `turn/start` reply or `turn/started`, whichever comes first */
  readonly turnId = new Promise<string>(resolve => { this.resolveTurnId = resolve; });

  constructor(private readonly slot: Slot) {
    this.done.catch(() => undefined);
  }

  setTurnId(id: string): void {
    this.resolveTurnId(id);
  }

  fail(error: JudgeCallError | Promise<JudgeCallError>): void {
    if (this.finished) return;
    this.finished = true;
    void Promise.resolve(error).then(this.rejectDone);
  }

  accept(n: ServerNotification): void {
    switch (n.method) {
      case 'turn/started':
        this.setTurnId(n.params.turn.id);
        break;
      case 'item/agentMessage/delta':
        this.deltas.set(n.params.itemId, (this.deltas.get(n.params.itemId) ?? '') + n.params.delta);
        break;
      case 'item/completed':
        if (n.params.item.type !== 'agentMessage') break;
        // the final answer wins; commentary only when there is nothing else (e11)
        if (n.params.item.phase === 'final_answer') this.finalText = n.params.item.text;
        else this.lastText = n.params.item.text;
        break;
      case 'thread/tokenUsage/updated': {
        const last = n.params.tokenUsage.last;
        this.usage = { input: last.inputTokens, cached: last.cachedInputTokens, output: last.outputTokens };
        break;
      }
      case 'error':
        if (!n.params.willRetry) this.fail(classify(this.slot, n.params.error.message, n.params.error.codexErrorInfo));
        break;
      case 'turn/completed': {
        const turn = n.params.turn;
        if (turn.status !== 'completed') {
          this.fail(classify(this.slot, turn.error?.message ?? `Codex 判断回合以 ${turn.status} 结束`, turn.error?.codexErrorInfo));
          break;
        }
        if (this.finished) break;
        this.finished = true;
        this.resolveDone({ text: this.finalText ?? this.lastText ?? [...this.deltas.values()].join(''), usage: this.usage });
        break;
      }
      default:
        break;
    }
  }
}

function threadOf(n: ServerNotification): string | undefined {
  const params = (n as { params?: unknown }).params;
  const id = params && typeof params === 'object' ? (params as { threadId?: unknown }).threadId : undefined;
  return typeof id === 'string' ? id : undefined;
}

/** Routes notifications by threadId; when the stream ends the process is gone. */
async function dispatch(slot: Slot): Promise<void> {
  try {
    for await (const n of slot.client.stream()) {
      const id = threadOf(n);
      const watch = id ? slot.watches.get(id) : undefined;
      if (!watch) continue;
      try {
        watch.accept(n);
      } catch (error) {
        // A notification in a shape we don't expect fails only its own judgement; the process is fine.
        if (watch.finished) continue;
        log.fail('judge', error, { phase: 'notification', method: n.method });
        watch.fail(new JudgeCallError('failed', `Codex 通知回包异常（${n.method}）：${messageOf(error).slice(0, 120)}`, false));
      }
    }
  } catch (error) {
    log.fail('judge', error, { phase: 'dispatch' });
  }
  if (current === slot) current = null;
  clearTimeout(slot.idleTimer);
  for (const watch of slot.watches.values()) watch.fail(goneError());
  const shuttingDown = !poolAccepting();
  // No exit code or signal here: the stream can end (stdout closed) before the child's exit event.
  // They are in the `agent exit` line with the same pid, logged by AppServerClient.
  log.info('judge', 'process-exit', {
    pid: slot.client.pid ?? null, inflight: slot.inflight, reason: slot.ending ?? (shuttingDown ? 'shutdown' : 'exit'),
  });
  if (slot.ending === 'stuck' || (!slot.ending && !shuttingDown)) startBackoff();
  closeDiscarded(slot.client);
}

/** An RPC without a jsonrpc-layer timeout (that would drop a late reply); a fixed stuck deadline kills the process. */
function rpc<T>(slot: Slot, method: string, params: unknown): Promise<T> {
  const reply = slot.client.request<T>(method, params);
  const timer = setTimeout(() => {
    if (slot.client.exited) return;
    slot.ending = 'stuck';
    stats.stuck++;
    if (current === slot) current = null;
    log.info('judge', 'process-stuck', { pid: slot.client.pid ?? null, method, inflight: slot.inflight });
    closeDiscarded(slot.client);
  }, opts.stuckMs);
  timer.unref?.();
  const clear = (): void => clearTimeout(timer);
  reply.then(clear, clear);
  return reply;
}

/** Sends and forgets: the reply is not awaited, only watched by the stuck deadline. */
function sendQuietly(slot: Slot, method: 'turn/interrupt' | 'thread/unsubscribe', params: unknown): void {
  if (slot.client.exited) return;
  stats[method === 'turn/interrupt' ? 'interrupts' : 'unsubscribes']++;
  rpc(slot, method, params).catch(() => undefined);
}

/** Closes the process after `idleMs` without a judgement (unref: never keeps the daemon up). */
function idleLater(slot: Slot): void {
  clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => {
    if (slot.inflight > 0 || slot.client.exited) return;
    slot.ending = 'idle';
    if (current === slot) current = null;
    log.info('judge', 'process-idle-close', { pid: slot.client.pid ?? null });
    closeDiscarded(slot.client);
  }, opts.idleMs);
  slot.idleTimer.unref?.();
}

function retire(slot: Slot): void {
  slot.ending = 'retired';
  if (current === slot) current = null;
  log.info('judge', 'process-retire', { pid: slot.client.pid ?? null, inflight: slot.inflight });
  if (slot.inflight === 0) closeDiscarded(slot.client);
}

async function create(bin: string, cwd: string): Promise<Slot> {
  const started = opts.now();
  const fingerprint = binFingerprint(bin);
  const client = new AppServerClient({ bin, cwd, clientName: 'vonvon-judge' });
  trackResident(client);
  try {
    await withDeadline(client.connect(), opts.connectMs, 'judge connect');
    if (!poolAccepting()) throw closedError();
  } catch (error) {
    // A connect that loses to shutdown closes itself here.
    closeDiscarded(client);
    if (!poolAccepting()) throw closedError();
    startBackoff();
    throw error instanceof JudgeCallError ? error : new JudgeCallError('failed', `Codex 判断进程起不来：${messageOf(error)}`, false);
  }
  const slot: Slot = { client, bin, fingerprint, inflight: 0, watches: new Map() };
  stats.spawned++;
  current = slot;
  idleLater(slot); // the judgement that started it may already have given up
  void dispatch(slot);
  log.info('judge', 'process-up', { pid: client.pid ?? null, ms: opts.now() - started });
  return slot;
}

async function acquire(cwd: string): Promise<{ slot: Slot; cold: boolean }> {
  if (!poolAccepting()) throw closedError();
  const bin = opts.resolveBin();
  if (!bin) throw new JudgeCallError('unavailable', 'codex CLI not found (set CODEX_BIN or install @openai/codex)', false);
  const slot = current;
  if (slot && !slot.client.exited) {
    // Codex upgraded in place or moved: new judgements go to a new process, the old one finishes its own.
    if (slot.bin === bin && slot.fingerprint === binFingerprint(bin)) return { slot, cold: false };
    retire(slot);
  }
  // cold only for the judgement that started the process; the others share its single flight
  if (creating) return { slot: await creating, cold: false };
  const wait = backoffUntil - opts.now();
  if (wait > 0) throw new JudgeCallError('unavailable', `Codex 判断进程刚退出，${Math.ceil(wait / 1000)} 秒后再试`, false);
  creating = create(bin, cwd).finally(() => { creating = null; });
  return { slot: await creating, cold: true };
}

/** Rejects with the abort reason when the signal fires first; `work` keeps running. */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => undefined);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Names of the MCP servers and non-system skills Codex would load in `cwd`. Read before every
 * judgement: app-server rereads config.toml on each `thread/start` (s23b spike). */
async function inventory(slot: Slot, cwd: string): Promise<{ mcp: string[]; skills: string[] }> {
  const [config, skills] = await Promise.allSettled([
    slot.client.request<{ config?: { mcp_servers?: Record<string, unknown> | null } }>('config/read', { includeLayers: false, cwd }, INVENTORY_TIMEOUT_MS),
    slot.client.request<{ data?: Array<{ skills?: Array<{ name: string; scope: string }> }> }>('skills/list', { cwds: [cwd] }, INVENTORY_TIMEOUT_MS),
  ]);
  const mcp = config.status === 'fulfilled' ? Object.keys(config.value?.config?.mcp_servers ?? {}) : [];
  const names = skills.status === 'fulfilled'
    ? [...new Set((skills.value?.data ?? []).flatMap(entry => entry.skills ?? []).filter(s => s.scope !== 'system').map(s => s.name))]
    : [];
  const errors = [config, skills].flatMap(r => r.status === 'rejected' ? [messageOf(r.reason).slice(0, 120)] : []);
  const summary = JSON.stringify([mcp.length, names.length, errors]);
  if (errors.length || summary !== slot.inventoryLogged) {
    slot.inventoryLogged = summary;
    log.info('judge', 'inventory', { mcp: mcp.length, skills: names.length, ...(errors.length ? { error: errors.join('; ') } : {}) });
  }
  return { mcp, skills: names };
}

function threadParams(call: JudgeCall, inv: { mcp: string[]; skills: string[] }): Record<string, unknown> {
  return {
    cwd: call.cwd,
    model: call.model,
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    developerInstructions: call.system,
    baseInstructions: JUDGE_BASE_INSTRUCTIONS,
    // Deep-merged into the user's config.toml: only these keys change, for this thread only.
    config: {
      web_search: 'disabled',
      'features.enable_fanout': false,
      'features.hooks': false,
      'features.multi_agent': false,
      'features.multi_agent_v2': false,
      'features.apps': false, // the owner's ChatGPT connectors (e05)
      'features.memories': false,
      memories: { use_memories: false, generate_memories: false },
      project_doc_max_bytes: 0,
      projects: { [call.cwd]: { trust_level: 'untrusted' } }, // keeps thread/start from writing config.toml (e05)
      // Nested form, inventoried names only: an unknown name fails thread/start on both tested versions.
      mcp_servers: Object.fromEntries(inv.mcp.map(name => [name, { enabled: false }])),
      skills: { bundled: { enabled: false }, config: inv.skills.map(name => ({ name, enabled: false })) },
      ...TOOL_OFF_KEYS,
    },
  };
}

/** Inventory and `thread/start`; a server the inventory still named but config.toml no longer has
 * fails `thread/start`, so take stock again and retry once. */
async function startThread(slot: Slot, call: JudgeCall): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    const inv = await inventory(slot, call.cwd);
    if (call.signal.aborted) return undefined; // no thread to clean up
    let reply: { thread?: { id?: unknown } } | null | undefined;
    try {
      reply = await rpc<typeof reply>(slot, 'thread/start', threadParams(call, inv));
    } catch (error) {
      if (attempt === 0 && error instanceof JsonRpcError && /invalid transport in mcp_servers\./.test(error.message)) continue;
      throw error instanceof JsonRpcError ? await classify(slot, error.message) : goneError();
    }
    const id = reply?.thread?.id;
    if (typeof id === 'string' && id) return id;
    throw new JudgeCallError('failed', `Codex thread/start 回包异常：${JSON.stringify(reply ?? null).slice(0, 120)}`, false);
  }
}

async function judgeOn(slot: Slot, call: JudgeCall, cold: boolean): Promise<JudgeCallOutput> {
  const { signal } = call;
  const starting = startThread(slot, call);
  let threadId: string | undefined;
  try {
    threadId = await untilAbort(starting, signal);
  } catch (error) {
    if (!signal.aborted) throw error;
    // Gave up before the reply: unsubscribe once it comes (or the stuck deadline kills the process).
    const late = await starting.catch(() => undefined);
    if (late) sendQuietly(slot, 'thread/unsubscribe', { threadId: late });
    throw signal.reason;
  }
  if (!threadId) throw signal.reason;
  const watch = new Watch(slot);
  slot.watches.set(threadId, watch); // before turn/start: its notifications may beat the reply
  try {
    const turnStart = rpc<TurnStartResponse>(slot, 'turn/start', {
      threadId,
      input: [{ type: 'text', text: call.input, text_elements: [] }],
      model: call.model,
      ...(call.effort ? { effort: call.effort } : {}),
      outputSchema: call.schema,
      summary: 'none',
    });
    turnStart.then(reply => {
      const id = turnIdOf(reply);
      if (id) watch.setTurnId(id);
    }, () => undefined);
    const outcome = Promise.race([
      watch.done,
      turnStart.then(reply => {
        if (!turnIdOf(reply)) {
          throw new JudgeCallError('failed', `Codex turn/start 回包异常：${JSON.stringify(reply ?? null).slice(0, 120)}`, false);
        }
        return watch.done;
      }, async (error: unknown) => {
        throw error instanceof JsonRpcError ? await classify(slot, error.message) : goneError();
      }),
    ]);
    try {
      const { text, usage } = await untilAbort(outcome, signal);
      backoffStep = 0;
      backoffUntil = 0;
      return { text, ...(usage ? { usage } : {}), cold };
    } catch (error) {
      if (!signal.aborted) throw error;
      if (!watch.finished) {
        const turnId = await Promise.race([watch.turnId, turnStart.then(turnIdOf)]).catch(() => undefined);
        if (turnId && !watch.finished) sendQuietly(slot, 'turn/interrupt', { threadId, turnId });
      }
      throw signal.reason;
    }
  } finally {
    sendQuietly(slot, 'thread/unsubscribe', { threadId });
    slot.watches.delete(threadId);
  }
}

/**
 * Runs one judgement on the judge process. Rejects with {@link JudgeCallError}, or with the
 * signal's reason once it fired; settles only after the cleanup RPCs went out.
 */
export async function runCodexJudge(call: JudgeCall): Promise<JudgeCallOutput> {
  const { slot, cold } = await untilAbort(acquire(call.cwd), call.signal);
  slot.inflight++;
  clearTimeout(slot.idleTimer);
  try {
    return await judgeOn(slot, call, cold);
  } finally {
    slot.inflight--;
    if (slot.inflight === 0 && !slot.client.exited) {
      if (slot.ending === 'retired') closeDiscarded(slot.client);
      else idleLater(slot);
    }
  }
}
