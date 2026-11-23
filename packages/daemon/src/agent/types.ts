import type { BackendAccount } from '@vonvon/protocol';
import type { AgentToolSpec } from './entry/tools';
import type { SessionProfile, SessionProfileCapabilities } from './session-profile';
import { z } from 'zod';
import type { AgentErrorKind, JudgeErrorKind } from './error-kind';

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
export const DEFAULT_BACKEND_ID = 'codex-appserver';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

/** Native providers may introduce effort IDs between releases. */
export type ReasoningEffort = string;

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
export type ServiceTier = 'standard' | 'fast' | 'ultrafast';

export interface AgentInput {
  text?: string;
  /** absolute local paths of images the user sent — codex reads them directly as
   * `localImage`; the claude backend base64-encodes them into image blocks. */
  images?: string[];
}

export interface ModelInfo {
  id: string;
  displayName: string;
  description: string;
  supportedEfforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
  isDefault: boolean;
  hidden: boolean;
  serviceTiers?: { id: string; name: string; description: string }[];
}

/** A past agent session, for the "恢复历史会话" picker (codex: thread/list). */
export interface ThreadSummary {
  /** backend session id（codex 的 thread id，其它后端可能是 session UUID），传给 resumeThread */
  sessionId: string;
  /** first user message preview */
  preview: string;
  /** unix seconds */
  createdAt: number;
  updatedAt: number;
  /** optional user-facing title */
  name?: string;
}

/** One past tool/command/file/web call in a resumed session's transcript. */
export interface HistoryTool {
  /** short header — the shell command, or a label like '编辑文件' / '联网搜索' */
  title: string;
  /** aggregated stdout/stderr, if any (renderer truncates) */
  output?: string;
  /** process exit code for command executions */
  exitCode?: number | null;
  /** the call errored / was declined */
  failed?: boolean;
}

/** One user→assistant exchange in a resumed session (a codex Turn). */
export interface HistoryTurn {
  /** the user's prompt for this turn ('' for a tool-only / boilerplate turn) */
  userText: string;
  /** the assistant's reply (agent messages concatenated) */
  assistantText: string;
  /** the assistant's reasoning, if surfaced ('' if none) */
  reasoning: string;
  /** tool/command/file/web calls in this turn, in arrival order */
  tools: HistoryTool[];
  /** unix seconds when the turn started, if known */
  startedAt?: number;
}

/**
 * A resumed codex thread's transcript, for the "恢复历史会话" history card —
 * normalized off the app-server `thread/read` (includeTurns) turns so the card
 * layer never touches codex protocol shapes.
 */
export interface ThreadHistory {
  /** turns kept for display, oldest→newest (the most recent `turns.length`) */
  turns: HistoryTurn[];
  /** total non-empty turns in the thread before truncation (>= turns.length) */
  totalTurns: number;
  /** user-facing thread title, if set */
  name?: string;
  /** first user message preview */
  preview?: string;
  /** unix seconds */
  createdAt?: number;
  updatedAt?: number;
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

const askText = z.string().trim().min(1);
const askOptionSchema = z.object({ id: askText, label: askText, description: z.string() }).strict();
const askChoiceQuestion = z.object({
  id: askText,
  title: askText,
  detail: z.string(),
  selection: z.enum(['single', 'multiple']),
  options: z.tuple([askOptionSchema]).rest(askOptionSchema),
  /** Allow a typed answer outside the options (Codex isOther). */
  other: z.boolean().default(false),
}).strict();
const askTextQuestion = z.object({
  id: askText, title: askText, detail: z.string(), selection: z.literal('text'),
  /** Sensitive text moves to private chat in s33b. */
  sensitive: z.boolean().default(false),
}).strict();
const askQuestionSchema = z.discriminatedUnion('selection', [askChoiceQuestion, askTextQuestion]);
const askBase = {
  id: askText,
  title: askText,
  acceptedConsequence: askText,
  declinedConsequence: askText,
};

/** Provider asks are separate messages; permission asks only occur in full access. */
export const askRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...askBase, kind: z.literal('choices'), questions: z.tuple([askQuestionSchema]).rest(askQuestionSchema) }).strict(),
  z.object({ ...askBase, kind: z.literal('confirmation'), detail: askText }).strict(),
  z.object({ ...askBase, kind: z.literal('permission'), permissionMode: z.literal('full'), detail: askText }).strict(),
]).superRefine((request, ctx) => {
  if (request.kind !== 'choices') return;
  const questionIds = new Set<string>();
  request.questions.forEach((question, index) => {
    if (questionIds.has(question.id)) ctx.addIssue({ code: 'custom', path: ['questions', index, 'id'], message: 'Duplicate question id' });
    questionIds.add(question.id);
    if (question.selection === 'text') return;
    const optionIds = new Set<string>();
    question.options.forEach((option, optionIndex) => {
      if (optionIds.has(option.id)) ctx.addIssue({ code: 'custom', path: ['questions', index, 'options', optionIndex, 'id'], message: 'Duplicate option id' });
      optionIds.add(option.id);
    });
  });
});

export type AskRequest = z.infer<typeof askRequestSchema>;

export function isSensitiveAsk(request: AskRequest): boolean {
  return request.kind === 'choices' && request.questions.some(q => q.selection === 'text' && q.sensitive);
}

export type AskChoiceAnswer = { questionId: string; selected: [string, ...string[]] } | { questionId: string; text: string };
export type AskAnswer =
  | { kind: 'choices'; answers: [AskChoiceAnswer, ...AskChoiceAnswer[]] }
  /** Typed reply to the whole choices request; confirmation and permission require buttons. */
  | { kind: 'text'; text: string }
  | { kind: 'confirmation'; decision: 'proceed' | 'explain' }
  | { kind: 'permission'; decision: 'allow-once' | 'deny' };

/** Validate once where a provider request enters the bot. */
export function parseAskRequest(raw: unknown): AskRequest {
  return askRequestSchema.parse(raw);
}

/** Normalized stream events, mapped from app-server notifications. */
export type AgentEvent =
  | { type: 'subagent_start'; id: string; parentId?: string; name: string; task: string; stoppable: boolean }
  | { type: 'subagent_step'; id: string; stepId: string; title: string; status: 'running' | 'done' | 'failed'; kind?: ToolKind; detail?: string }
  | { type: 'subagent_status'; id: string; status: 'running' | 'completed' | 'failed' | 'stopped'; result?: string }
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
  // the run card's context meter + the /context command. `contextWindow` is the
  // model's total window (null when codex doesn't report one → percent unknown).
  | { type: 'context_usage'; usedTokens: number; contextWindow: number | null }
  // The backend's own compaction of the thread's history. Codex: the
  // contextCompaction item (start/end by itemId), plus the deprecated
  // thread/compacted (`legacy`) that repeats the end on versions still sending it.
  // Claude: status 'compacting' starts it, compact_boundary ends it with the token
  // counts before and after. The run card shows one line per compaction.
  | {
      type: 'compaction';
      phase: 'start' | 'end';
      itemId?: string;
      legacy?: boolean;
      preTokens?: number;
      postTokens?: number;
      contextWindow?: number | null;
      failed?: boolean;
    }
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
  | { type: 'ask'; request: AskRequest; subagentId?: string }
  | { type: 'awaiting_subagents' }
  | { type: 'ask_cancelled'; requestId: string }
  | { type: 'error'; message: string; willRetry: boolean; kind?: AgentErrorKind };

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

export type AskResolution =
  | { kind: 'answered'; answer: AskAnswer }
  | { kind: 'unanswered'; reason: 'timeout' | 'stopped' | 'turn-ended' | 'unavailable' };

export interface AgentRun {
  /** Resolves once the stop request is sent, without waiting for termination.
   * Rejects with a Chinese reason when ended or no turn has started. */
  stopSubagent?(id: string): Promise<void>;
  /** Claim/release the local continuation synchronously before returning delivery work. */
  respondToAsk?(requestId: string, resolution: AskResolution): Promise<void>;
  /** Synchronous provider claim state, including terminal events not yet consumed by the UI. */
  askPending?(requestId: string): boolean;
  /** Ordinary runs emit done after all running children settle; goal runs carry children across turns. */
  events: AsyncIterable<AgentEvent>;
  /** current turn id, available after `turn_started` */
  turnId(): string | undefined;
  /** epoch ms of the last RAW backend activity — refreshed on EVERY server
   * notification, including ones the event map drops (e.g. command output
   * deltas). Lets the idle watchdog tell a busy-but-quiet turn (long shell
   * command, a long npm install) from a truly wedged one. */
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
  serviceTier?: ServiceTier;
}

export interface AgentThread {
  /** Update daemon-owned context in native history before the next task, without a model turn. */
  injectContext?(text: string): Promise<void>;
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
  runGoal(objective: string, turn?: TurnOptions): AgentRun;
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
  /** The newest compaction in the native session (s15b): an id that changes with every
   * compaction, whoever made it (vonvon, the agent on its own, a terminal or the Codex app).
   * Read on resume and by {@link checkNative}; unset when there is none or it is unknown. */
  readonly lastCompaction?: string;
  /** Look at the native session before a turn (s15b). `foreign` means something other than
   * this thread wrote a turn or a compaction there since it last looked (the owner in a
   * terminal), so the caller resumes it from disk. Claude only: a live Codex thread holds
   * the only writer, and is let go after every run instead ({@link releaseAfterRun}). */
  checkNative?(): Promise<{ foreign: boolean }>;
  /** Let the session go once a run ends (s15b): while an app-server holds a Codex thread, a
   * terminal or the Codex app cannot open it, and only closing the process lets go
   * (`thread/unsubscribe` keeps the writer). */
  readonly releaseAfterRun?: boolean;
  /** Codex accepted feedback_prepare on thread/start. A resumed rollout uses its stored tool set. */
  readonly startedWithFeedbackTool?: boolean;
  /** false once the underlying agent process has died (crash / kill / close) —
   * the thread is unusable and must be evicted from the live cache so
   * resolveThread's resume fallback can take over. */
  isAlive(): boolean;
  /** terminate the underlying app-server process */
  close(): Promise<void>;
}

/** Resuming a session another program is writing (s15b): Codex lets one writer hold a
 * thread, so while a terminal or the Codex app has it open the bot cannot continue it.
 * The caller says so and keeps the session; starting a new one would lose the conversation. */
export class SessionInUseError extends Error {
  constructor(readonly sessionId: string, cause?: unknown) {
    super('这条会话正在终端或 Codex 应用里打开着，bot 接不上。关掉那边以后再发一次。', { cause });
    this.name = 'SessionInUseError';
  }
}

export type AgentToolReply =
  | { ok: true; result: unknown }
  | { ok: false; code: 'not-ready' | 'revoked' | 'unknown-tool' | 'refused' | 'bad-args' | 'busy' | 'timeout' | 'failed';
      reason?: 'not-dm' | 'not-human-turn' | 'not-admin' | 'turn-ended' | 'unknown-origin'
        | 'not-group' | 'no-human-create' | 'scheduled-run-scope'; message: string };

export interface AgentEntry {
  /** devices 5.3: names this session's token in the host (`ses_` + 16 hex). */
  readonly sessionId: string;
  tools(): readonly AgentToolSpec[];
  call(name: string, args: unknown, origin?: { toolUseId?: string }): Promise<AgentToolReply>;
  noteToolUse(toolUseId: string): void;
  attach(thread: AgentThread): void;
  revoke(reason: 'closed' | 'start-failed' | 'dead' | 'shutdown'): void;
}

/** Claude restricted tiers deny these paths and reopen only their allowed subtrees. */
export interface ReadScope { deny: string[]; allow: string[] }

export interface StartThreadOptions {
  readScope?: ReadScope;
  entry?: AgentEntry;
  profile?: SessionProfile;
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
  serviceTier?: ServiceTier;
  /** permission tier; undefined → 'full' (preserves legacy danger-full-access) */
  mode?: PermissionMode;
  /** let the sandboxed agent's shell reach the network (qa/write only; full is
   * always networked). Default false. */
  network?: boolean;
  /** Validated provider-native group permission settings; only Claude consumes them. */
  native?: Readonly<Record<string, unknown>>;
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

/** One smart-mode judgement (s23): a single turn with no tools and no saved session. The judge
 * layer (`src/judge/`) builds it; the backend only runs it. */
export interface JudgeCall {
  /** SMART.md text plus the format lines vonvon appends */
  system: string;
  /** the input block: group, bot, recent messages, the message to judge */
  input: string;
  model: string;
  /** decided by the judge layer; absent = Codex sends no `effort` key, Claude turns thinking off */
  effort?: ReasoningEffort;
  /** JSON schema of the answer (Codex `outputSchema`, Claude `outputFormat`) */
  schema: Record<string, unknown>;
  /** an empty directory under the data root */
  cwd: string;
  /** timeout, the caller giving up or shutdown; the backend then cleans up on its own */
  signal: AbortSignal;
}

export interface JudgeCallOutput {
  text: string;
  /** Claude's `structured_output` */
  structured?: unknown;
  /** the whole call: input with cache reads and writes, `cached` the reads; `reasoning` (Codex reasoning,
   * Claude thinking) is already in `output` */
  usage?: { input?: number; cached?: number; output?: number; reasoning?: number };
  /** this call started a new process (Codex) */
  cold?: boolean;
}

/** A judgement the backend could not run. `structured`: the kind came from a structured error code
 * (or one of the fixed Codex sentences, design 3.1), so it may start a cooldown; a kind guessed from
 * free text by {@link errorKindFromText} never does. */
export class JudgeCallError extends Error {
  constructor(
    readonly kind: JudgeErrorKind,
    message: string,
    readonly structured: boolean,
  ) {
    super(message);
    this.name = 'JudgeCallError';
  }
}

// ── 账号用量（归一化）──────────────────────────────────────────────────
// /usage 卡的数据形状。目前只有 codex（ChatGPT 登录）后端有这份数据（实现在
// codex-appserver/usage，经 src/agent/usage 出口），但类型是后端中立的归一化
// 形状 —— 卡片层只 import 这里，绝不碰后端协议类型。

export type UsageErrorKind =
  /** 没有登录态（codex：无 auth.json）—— 本机未登录 */
  | 'no-auth'
  /** 登录模式没有用量数据（codex：API-key 模式无 profile/限额） */
  | 'api-key-mode'
  /** 登录态被服务端永久拒绝 → 需要重新登录 */
  | 'need-relogin'
  /** 网络/服务波动 → 稍后重试 */
  | 'transient';

export class UsageError extends Error {
  constructor(
    readonly kind: UsageErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface RateWindow {
  /** 已用百分比（整数 0-100） */
  usedPercent: number;
  /** 窗口长度（秒）：5h=18000，7d=604800 */
  windowSeconds?: number;
  /** 重置时刻（Unix epoch 秒） */
  resetAt?: number;
}

export interface RateBucket {
  /** 附加限额的名字（如 GPT-5.3-Codex-Spark）；主限额为 undefined */
  name?: string;
  primary?: RateWindow;
  secondary?: RateWindow;
}

export interface AccountUsageSnapshot {
  planType?: string;
  /** 主限额（5h + 7d 双窗口） */
  main: RateBucket;
  /** 按 feature 的附加限额（独立 5h/7d 双窗口） */
  extras: RateBucket[];
  /** 拉取时刻（ms） */
  fetchedAt: number;
  /** Claude：额度读不到时为什么（main、extras 为空），本机统计照常返回 */
  unavailable?: UsageErrorKind;
}

export interface DailyBucket {
  /** YYYY-MM-DD（服务端口径，疑似 UTC 日界；只含有用量的日期，热力图自己补 0） */
  date: string;
  tokens: number;
  /** Claude 本机统计：当天消息数（Claude Code /usage 的热力图口径） */
  messages?: number;
}

/** Claude Code /usage → Stats 的本机统计（daemon 读本机 Claude Code 记录算出，见 docs/plans/now-share.md N2；
 * 记录被清理掉的天由 Claude Code 自己的 stats-cache.json 补上，N2b）。 */
export interface ClaudeLocalStats {
  state: 'ready' | 'scanning' | 'unavailable';
  /** 每个模型的累计 Token（input + output + cache_read + cache_creation），按 Token 降序 */
  models: { id: string; tokens: number }[];
  sessions: number;
  messages: number;
  activeDays: number;
  longestSessionSec?: number;
  longestSessionMessages?: number;
  /** 按会话开始的本地小时计数，长度 24 */
  hourCounts?: number[];
}

export interface AccountProfileStats {
  displayName?: string;
  lifetimeTokens?: number;
  peakDailyTokens?: number;
  currentStreakDays?: number;
  longestStreakDays?: number;
  /** 最长单任务时长（秒） */
  longestTurnSec?: number;
  totalThreads?: number;
  fastModePct?: number;
  /** 技能调用总次数 */
  totalSkillsUsed?: number;
  /** 用过的不同技能数 */
  uniqueSkillsUsed?: number;
  mostUsedEffort?: string;
  mostUsedEffortPct?: number;
  /** top 调用的插件/skill（名字 + 次数 + 类型），最多 5 条 */
  topInvocations: { name: string; count: number; kind: 'plugin' | 'skill' }[];
  dailyBuckets: DailyBucket[];
  statsAsOf?: string;
  localStats?: ClaudeLocalStats;
}

export interface AccountUsageBundle {
  profile: AccountProfileStats;
  usage: AccountUsageSnapshot;
}

/** 一个按需后端依赖的安装态（doctor 三态的细分；catalog/Web 据此决定渲染）。
 *   'installed'        —— 解析得到，已装（codex 这类 external-cli 装了也算 installed）
 *   'not-installed'    —— npm-ondemand 包未装，但可一键下载（installable=true）
 *   'external-missing' —— external-cli / npm-external 缺失，需用户手动装（给 hint，不出下载按钮）
 */
export type BackendDepState = 'installed' | 'not-installed' | 'external-missing';

export type BackendLogin = { state: 'signedIn' | 'signedOut' | 'notRequired' | 'unknown'; message: string; account?: BackendAccount };

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
  /** 后端可能 emit permission ask（工具确认转发到飞书卡片）。codex 在
   * approvalPolicy 'never' 下从不发（undefined ⇒ true 无害——事件是被动的）。 */
  approvals: boolean;
}

export interface AgentSkill {
  /** Native selector; Claude names use claude:<name> when no file path is exposed. */
  path: string;
  name: string;
  description: string;
  source: 'workspace' | 'user' | 'provider';
  enabled: boolean;
}

export interface AgentBackend {
  /** Native discovery without submitting a model turn. */
  listSkills?(input: { cwd: string; directories?: string[] }): Promise<AgentSkill[]>;
  readonly profileCapabilities?: SessionProfileCapabilities;
  readonly id: string;
  readonly displayName: string;
  /** undefined ⇒ all true (codex 的完整能力面)；见 {@link AgentCapabilities}。 */
  readonly capabilities?: AgentCapabilities;
  /** 本后端支持的权限档。undefined ⇒ 全档支持（codex）。声明了的后端 MUST 同时在
   * startThread/resumeThread 里对档外 mode fail-closed（声明只是给切换 UI 提前
   * 拦截用的，硬守卫永远在启动路径——绝不静默降级）。 */
  readonly supportedModes?: readonly PermissionMode[];
  /** Set when this host runs the backend only in 完全访问: the reason the settings show. Unlike
   * {@link supportedModes}, groups are still bound and stored in 只读 or 读写; their turns are
   * refused one by one (codex on Linux, s20b). */
  fullAccessOnly?(): string | undefined;
  /** Refresh permission capabilities off the synchronous per-message path. */
  refreshPermissions?(opts?: { force?: boolean; cached?: boolean }): Promise<void>;
  isAvailable(): Promise<boolean>;
  /** Probe the backend runtime（版本/路径/装法提示）—— doctor CLI、onboarding、
   * DM 体检卡共用，替代散落的硬编码探测。`force` 绕过探测缓存（体检要看
   * 「现在」的状态）。绝不抛错，必须全程异步（卡片回调里 spawnSync 会冻住
   * 事件循环——见 DM.doctor）。 */
  doctor(opts?: { force?: boolean; permissions?: boolean }): Promise<BackendProbe>;
  /** Login state (已登录 / 未登录 / 无法确认) for backends that need one; slower than
   * {@link doctor}, so it is kept out of it (callers race doctor() against 3 s). */
  loginStatus?(opts?: { refresh?: boolean }): Promise<BackendLogin>;
  listModels(opts?: { refresh?: boolean }): Promise<ModelInfo[]>;
  /** Account-confirmed model tiers constrained by the effective session configuration. */
  listModelsForCwd?(cwd: string, opts?: { refresh?: boolean }): Promise<ModelInfo[]>;
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
  /** Run one judgement (s23). The promise settles only once the call has fully cleaned up after an
   * abort (Codex: interrupt and unsubscribe sent; Claude: the CLI closed), because the judge layer
   * gives the concurrency slot back then. Failures reject with {@link JudgeCallError}. */
  judge?(call: JudgeCall): Promise<JudgeCallOutput>;
  /** The model list this backend already holds, synchronously; undefined when it has none. Never
   * fetches: the judge path must not wait for `model/list`. */
  peekModels?(): ModelInfo[] | undefined;
}
