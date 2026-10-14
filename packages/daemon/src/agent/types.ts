import type { ModelInfo, ThreadHistory, ThreadSummary } from '../provider/model';

/** Request rejected locally before any transport write: safe to resubmit. */
export class UnsentRequestError extends Error {}

/**
 * Backend-agnostic agent interface. The codex app-server implementation lives
 * in ./codex-appserver; this layer lets the bot orchestrator stay decoupled
 * from codex internals (and lets us swap to exec / SDK / remote later).
 */

/** The backend used when nothing picked one (`Project.backend` / 旧
 * SessionRecord 缺省)——the historical codex app-server path, which must stay
 * behavior-identical. Declared here (not index.ts) so pure-type consumers like
 * session-store can backfill old records without importing the registry. */
export const DEFAULT_BACKEND_ID = 'codex';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Permission tier for a project's codex sandbox:
 *   'qa'    — read-only, confined to the project folder (cwd). External-group Q&A.
 *   'write' — read/write, confined to the project folder.
 *   'full'  — danger-full-access (whole machine + network); the historical default.
 * 'qa'/'write' are enforced via a custom codex permissions profile (see backend),
 * whose read-confinement codex can enforce on macOS (Seatbelt) and native Windows
 * (restricted token); on Linux/WSL it can't, so those tiers fail-closed there.
 */
export type PermissionMode = 'qa' | 'write' | 'full';

/** What a turn runs as when no project policy resolved a mode: the middle tier —
 * confined to the project folder, never the historical whole-machine `full`.
 * Consumers that receive an OPTIONAL mode (a caller may not have a project yet)
 * read this ONE constant instead of each carrying its own `?? 'write'`. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'write';

export interface AgentInput {
  text?: string;
  /** absolute local paths of images the user sent — codex reads them directly as
   * `localImage`; the claude backend base64-encodes them into image blocks. */
  images?: string[];
}

/**
 * Coarse tool category, set by each backend's event-map so the card can render
 * a tool correctly without re-parsing its title. `command` — a shell command
 * whose `title` IS the full command line (rendered as a ```bash block in the
 * panel body so a long/multi-line command stays fully readable, not clipped to
 * the one-line header). `file` — a file read/edit (title is a path label).
 * `search` — grep/glob/web. `tool` — everything else (mcp / generic). Absent ⇒
 * treated as `tool`.
 */
export type ToolKind = 'command' | 'file' | 'search' | 'tool';

/** Normalized stream events, mapped from app-server notifications. */
export type AgentEvent =
  | { type: 'system'; threadId: string }
  | { type: 'turn_started'; turnId: string }
  | { type: 'text_delta'; itemId: string; delta: string }
  | { type: 'text'; itemId: string; text: string }
  | { type: 'thinking_delta'; itemId: string; delta: string }
  | { type: 'thinking'; itemId: string; text: string }
  | { type: 'tool_use'; itemId: string; title: string; detail?: string; kind?: ToolKind }
  | { type: 'tool_result'; itemId: string; output?: string; exitCode?: number | null }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  // Context-window usage for this thread (from thread/tokenUsage/updated). Drives
  // the run card's threshold gauge + the /context command. `contextWindow` is the
  // model's total window (null when codex doesn't report one → percent unknown).
  | { type: 'context_usage'; usedTokens: number; contextWindow: number | null }
  // codex compacted the thread's history (thread/compacted). Auto-compaction
  // surfaces a notice; a manual /compact is suppressed (see handle-message).
  | { type: 'context_compacted' }
  | { type: 'done'; turnId: string }
  // A codex goal's state changed (thread/goal/updated). Only emitted during a
  // goal run (runGoal); the normal turn loop ignores it. `status` is an open
  // string — see {@link isGoalTerminal}.
  | {
      type: 'goal_update';
      status: string;
      objective: string;
      tokensUsed: number;
      timeUsedSeconds: number;
      tokenBudget: number | null;
    }
  // A backend tool call awaits user approval —— 占位（L-1 审批转发切片）：
  // 将来支持工具审批的后端可挂起工具调用并 emit 这个事件，由 orchestrator
  // 渲染飞书审批卡（先响应再延迟更新），用 requestId 把批/拒回执关联回去。
  // codex 后端在 approvalPolicy 'never' 下永不 emit；run-state 的 reduce 对
  // 未知事件走 default no-op，所以提前声明是安全的。
  | { type: 'approval_request'; requestId: string; title: string; detail?: string }
  | { type: 'error'; message: string; willRetry: boolean };

/**
 * A codex goal's lifecycle status (thread/goal/updated). The vendored protocol
 * type lists only active|paused|budgetLimited|complete, but codex 0.139 also
 * emits `usageLimited` and `blocked` at runtime (observed) — so treat it as an
 * open string and decide terminality defensively here, never by exhaustive enum.
 */
export type GoalStatus = string;

/** Terminal goal states — the goal run is over (no more auto-continuation). */
export function isGoalTerminal(status: string): boolean {
  return (
    status === 'complete' ||
    status === 'budgetLimited' ||
    status === 'usageLimited' ||
    status === 'blocked'
  );
}

/** The goal finished successfully (vs an abnormal stop). */
export function isGoalSuccess(status: string): boolean {
  return status === 'complete';
}

export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  /** current turn id, available after `turn_started` */
  turnId(): string | undefined;
  /** epoch ms of the last RAW backend activity — refreshed on EVERY server
   * notification, including ones the event map drops (e.g. command output
   * deltas). Lets the idle watchdog tell a busy-but-quiet turn (long shell
   * command, >120s npm install) from a truly wedged one. */
  lastActivity?(): number;
}

/** Outcome of a manual {@link AgentThread.compact}. `compacted` is true iff codex
 * emitted a thread/compacted notice (false ⇒ nothing to compact). `usage` is the
 * post-compaction token usage when codex reported one, else null. */
export interface CompactResult {
  compacted: boolean;
  usage: { usedTokens: number; contextWindow: number | null } | null;
}

/** Per-turn overrides (apply to this turn and persist for subsequent turns). */
export interface TurnOptions {
  model?: string;
  effort?: ReasoningEffort;
}

export interface AgentThread {
  /** backend session id（codex 的 thread id，其它后端可能是 session UUID）——持久化进
   * SessionRecord.sessionId，重启后经 resumeThread 找回同一会话。 */
  readonly sessionId: string;
  /** start a turn, streaming events until turn completion/error */
  runStreamed(input: AgentInput, turn?: TurnOptions): AgentRun;
  /**
   * Set a persistent goal on this thread (thread/goal/set) and stream its
   * autonomous, multi-turn execution until the goal reaches a terminal status.
   * codex auto-starts AND auto-continues every turn — we do NOT call turn/start;
   * we set the goal and consume. Emits the normal turn events PLUS `goal_update`
   * on each state change; the stream ends on a terminal goal status or a fatal
   * error. (Verified on codex 0.139: set alone kicks off turn 1.)
   */
  runGoal(objective: string): AgentRun;
  /** Clear this thread's goal (thread/goal/clear) so a non-complete goal won't
   * reactivate when the thread is later resumed. Best-effort. */
  clearGoal(): Promise<void>;
  /** inject input into the in-flight turn (引导) */
  readonly supportsSteer?: boolean;
  steer(input: AgentInput, expectedTurnId: string): Promise<void>;
  /** interrupt the in-flight turn (watchdog 中止) */
  abort(turnId: string): Promise<void>;
  /** Summarize the thread's history to free context (thread/compact/start) and
   * resolve only once it actually finishes — compaction runs as a background
   * turn, so this drains the event stream to turn/completed. */
  compact(): Promise<CompactResult>;
  /** false once the underlying agent process has died (crash / kill / close) —
   * the thread is unusable and must be evicted from the live cache so
   * resolveThread's resume fallback can take over. */
  isAlive(): boolean;
  /** terminate the underlying app-server process */
  close(): Promise<void>;
}

export interface StartThreadOptions {
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
  /** permission tier; undefined → 'full' (preserves legacy danger-full-access) */
  mode?: PermissionMode;
  /** let the sandboxed agent's shell reach the network (qa/write only; full is
   * always networked). Default false. */
  network?: boolean;
  /** codex's built-in auto-compaction (on by default). `false` disables it by
   * pushing the auto-compact token limit past any real usage. Undefined → leave
   * codex's default (on). */
  autoCompact?: boolean;
}

export interface ResumeThreadOptions extends StartThreadOptions {
  /** the session to resume (a prior {@link AgentThread.sessionId}) */
  sessionId: string;
}

/** Isolated one-shot title generation. The caller supplies the complete prompt
 * (including title rules and the already-cleaned first user message); backends
 * must use the selected model/effort verbatim and must not silently substitute
 * a cheaper/default model. */
export interface GenerateSessionTitleOptions {
  cwd: string;
  prompt: string;
  model: string;
  effort: ReasoningEffort;
}

/** 一个按需后端依赖的安装态（doctor 三态的细分；catalog/Web 据此决定渲染）。
 *   'installed'        —— 解析得到，已装（codex 这类 external-cli 装了也算 installed）
 *   'not-installed'    —— npm-ondemand 包未装，但可一键下载（installable=true）
 *   'external-missing' —— external-cli / npm-external 缺失，需用户手动装（给 hint，不出下载按钮）
 */
export type BackendDepState = 'installed' | 'not-installed' | 'external-missing';

/** A backend's environment probe（doctor / onboarding / DM 体检卡共用）。 */
export interface BackendProbe {
  /** the backend runtime is present and runnable */
  ok: boolean;
  /** human-readable version when detectable */
  version: string | null;
  /** where the runtime was found (binary path / package name) */
  location?: string;
  /** actionable install/login pointer when !ok */
  hint?: string;
  /** 本后端依赖能否在 Web 一键按需下载（npm-ondemand 且当前未装 → true）。
   * 区分「未安装·点下载」(true) 与「登录失败/外部缺失·去手动处理」(false/undefined)。 */
  installable?: boolean;
  /** 依赖安装态细分（{@link BackendDepState}）；未声明 ⇒ 由 ok 推导（ok=installed）。 */
  depState?: BackendDepState;
}

/**
 * Feature flags a backend declares so the orchestrator can guard codex-only
 * affordances instead of calling into methods a backend can't honor. Undefined
 * (the codex app-server backend) ⇒ every capability is true — the historical
 * full feature set. A backend that flags `false` MUST also make the
 * corresponding method(s) throw a clear "not supported" error (capability
 * guard + hard error, never a silent half-implementation).
 */
export interface AgentCapabilities {
  /** /goal 自治多轮（runGoal/clearGoal） */
  goal: boolean;
  /** 在飞行 turn 注入引导（steer）。false ⇒ orchestrator 的 steer try/catch 落入排队。 */
  steer: boolean;
  /** /compact 手动压缩（compact） */
  compact: boolean;
  /** /resume 历史会话选择卡（listThreads/readHistory）。注意 resumeThread 本身
   * 不在此能力位之下 —— 重启恢复路径（resolveThread）对所有后端直接调用它。 */
  resume: boolean;
  /** 后端可能 emit approval_request（工具审批转发到飞书卡片）。codex 在
   * approvalPolicy 'never' 下从不发（undefined ⇒ true 无害——事件是被动的）。 */
  approvals: boolean;
}

export interface AgentBackend {
  readonly id: string;
  readonly displayName: string;
  /** undefined ⇒ all true (codex 的完整能力面)；见 {@link AgentCapabilities}。 */
  readonly capabilities?: AgentCapabilities;
  /** 本后端支持的权限档。undefined ⇒ 全档支持（codex）。声明了的后端 MUST 同时在
   * startThread/resumeThread 里对档外 mode fail-closed（声明只是给切换 UI 提前
   * 拦截用的，硬守卫永远在启动路径——绝不静默降级）。 */
  readonly supportedModes?: readonly PermissionMode[];
  isAvailable(): Promise<boolean>;
  /** Probe the backend runtime（版本/路径/装法提示）—— doctor CLI、onboarding、
   * DM 体检卡共用，替代散落的硬编码探测。`force` 绕过探测缓存（体检要看
   * 「现在」的状态）。绝不抛错，必须全程异步（卡片回调里 spawnSync 会冻住
   * 事件循环——见 DM.doctor）。 */
  doctor(opts?: { force?: boolean }): Promise<BackendProbe>;
  listModels(): Promise<ModelInfo[]>;
  /** recent codex threads under `cwd`, newest first (for resume picker) */
  listThreads(cwd: string, limit?: number): Promise<ThreadSummary[]>;
  /**
   * A past thread's transcript for the resume history card — reads it via
   * `thread/read` (includeTurns) WITHOUT starting a turn or holding the session
   * live. Keeps the last `maxTurns` turns; never throws (returns empty on fail).
   */
  readHistory(cwd: string, sessionId: string, maxTurns?: number): Promise<ThreadHistory>;
  /** Read the backend-native user title only (not preview/auto summary). Undefined
   * means this session has no title yet. Kept optional for future backends that
   * cannot participate in native resume-title synchronization. */
  readSessionTitle?(cwd: string, sessionId: string): Promise<string | undefined>;
  /** Persist a title through the backend's native session store so its own CLI
   * resume picker sees it (codex: thread/name/set; Claude: customTitle). */
  setSessionTitle?(cwd: string, sessionId: string, title: string): Promise<void>;
  /** Run an isolated, non-persistent one-shot generation with the exact selected
   * model and effort. Empty model output is represented as undefined; runtime
   * errors intentionally propagate so the coordinator can apply its fallback. */
  generateSessionTitle?(opts: GenerateSessionTitleOptions): Promise<string | undefined>;
  startThread(opts: StartThreadOptions): Promise<AgentThread>;
  resumeThread(opts: ResumeThreadOptions): Promise<AgentThread>;
}
