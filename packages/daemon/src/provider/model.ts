import type { ModelCatalog } from '@vonvon/protocol';

export type ProviderId = 'codex' | 'claude';
export type Tier = 'qa' | 'write' | 'full';
export type ReadScope = 'project' | 'unrestricted';
export type Os = 'darwin' | 'linux' | 'win32';

export type Grant =
  | { tier: 'full'; root: string; network: boolean }
  | { tier: 'qa' | 'write'; root: string; readScope: ReadScope; network: boolean };
export const DEFAULT_READ_SCOPE: ReadScope = 'project';

export type TurnId = string & { __brand: 'TurnId' };
export type ItemId = string & { __brand: 'ItemId' };
export type StepId = string & { __brand: 'StepId' };
export type SubagentId = string & { __brand: 'SubagentId' };

export type Lane = { kind: 'main' } | { kind: 'subagent'; id: SubagentId };

export type StepDetail =
  | { type: 'shell'; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: 'read'; path: string; content?: string }
  | { type: 'edit'; path: string; unifiedDiff?: string }
  | { type: 'write'; path: string; content?: string }
  | { type: 'search'; query: string; tool: 'grep' | 'glob' | 'web'; paths?: string[]; matches?: number }
  | { type: 'fetch'; url: string; status?: number; result?: string }
  | { type: 'mcp'; server: string; tool: string; args?: unknown; result?: string }
  | { type: 'plan'; text: string }
  | { type: 'other'; toolName: string; input?: unknown; output?: unknown };

export type StepStatus = 'running' | 'ok' | 'failed' | 'denied' | 'interrupted';
export interface Step { id: StepId; title: string; status: StepStatus; detail: StepDetail; reason?: string }

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface TodoItem { text: string; status: TodoStatus }

export interface ImageRef {
  id: string;
  /** Absolute path under <dataDir>/images/<runId>/. Base64 payloads are written here first. Never a data URI. */
  path: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  placement: { kind: 'step'; stepId: StepId } | { kind: 'answer' };
}

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export interface SubagentState {
  id: SubagentId;
  status: SubagentStatus;
  task: string;
  startedAt: number;
  endedAt?: number;
  stepCount: number;
  currentStep?: string;
  recentSteps: Step[];
  result?: string;
}

export type Failure =
  | { kind: 'refused' }
  | { kind: 'auth'; hint: string }
  | { kind: 'limit'; limit: 'max-tokens' | 'max-turns' | 'context-window' | 'rate-limit' | 'usage-limit' }
  | { kind: 'provider-error'; message: string }
  | { kind: 'process-exit'; code: number | null; signal: string | null }
  /** The provider's stream closed and no exit fact followed. Reported by OwnedProcess.watch, never by an engine. */
  | { kind: 'transport-lost' };

export type StopBy = 'user' | 'watchdog' | 'daemon';
/** What a stop did to the owned process tree, as far as the turn machine knows. Rules in providers.md *Engine and runtime*. */
export type TreeFate = 'live' | 'signalled' | 'exited' | 'unconfirmed';
/** Why the host has not confirmed an ending: a diagnostic on its snapshot for doctor and the log; admission never reads it. */
export type UnconfirmedReason = 'signal-refused' | 'no-exit' | 'children-alive' | 'tree-unknown';
export type Outcome =
  | { state: 'completed' }
  | { state: 'failed'; failure: Failure }
  | { state: 'interrupted'; by: StopBy | 'agent'; tree: TreeFate };

export type RunEvent =
  | { type: 'session'; providerSessionId: string }
  | { type: 'started'; turnId: TurnId }
  | { type: 'text'; lane: Lane; itemId: ItemId; channel: 'answer' | 'reasoning'; delta: string }
  | { type: 'text-final'; lane: Lane; itemId: ItemId; channel: 'answer' | 'reasoning'; text: string }
  | { type: 'step'; lane: Lane; step: Step }
  | { type: 'subagent'; agent: SubagentState }
  | { type: 'todo'; items: TodoItem[] | null }
  | { type: 'image'; image: ImageRef }
  | { type: 'context'; used: number; window: number | null }
  | { type: 'compaction'; phase: 'start' | 'end'; trigger: 'auto' | 'manual' }
  | { type: 'goal'; status: string; objective: string; tokensUsed: number; timeUsedSeconds: number; tokenBudget: number | null }
  | { type: 'notice'; kind: 'retry' | 'bash-off' | 'mcp-off' | 'question-declined' | 'resume-failed' | 'image-cap' | 'other'; text: string }
  | { type: 'provider-message'; level: 'info' | 'warn'; text: string }
  | { type: 'outcome'; outcome: Outcome; usage?: { input?: number; output?: number; cached?: number } };

/** Why a goal ended. Chosen once by the first trigger; nothing afterwards changes it. Behavior in providers.md *Goals*. */
export type GoalEnd =
  | { kind: 'terminal'; status: string }
  | { kind: 'failed'; failure: Failure }
  | { kind: 'cleared' }
  | { kind: 'timeout' };

export type Support = 'native' | 'partial' | 'none';
export type ProbeId = string;
export interface ProviderFeatures {
  subagents: Support; subagentStop: Support; todo: Support; images: Support;
  outcomeReason: Support; reasoning: Support;
  steer: Support; compact: Support; compaction: Support; goal: Support;
  history: Support; titles: Support; usage: Support;
  oneShot: Support;
  contextUsage: Support; models: Support; effort: Support; retryNotice: Support;
  imageInput: Support; webSearch: Support;
  pending: Partial<Record<keyof Omit<ProviderFeatures, 'pending'>, ProbeId>>;
}

export class ConversationBusy extends Error {}
export interface HostFacts {
  os: Os; commandSandbox: 'seatbelt' | 'bwrap' | 'none'; windowsSandboxReady?: boolean;
  installed: Partial<Record<ProviderId, InstallProbe>>;
}
export interface InstallProbe { installed: boolean; version?: string; auth: 'ok' | 'logged-out' | 'unknown'; hint?: string }
export interface ProviderStatus { id: ProviderId; displayName: string; probe: InstallProbe; features: ProviderFeatures; tiers: Tier[] }
export interface UserInput { text: string; images: { path: string; mime: ImageRef['mime'] }[] }
export interface TurnOptions { model?: string; effort?: string }
export interface ProviderRequest { method: string; params: unknown }
export type ProviderAnswer =
  | { kind: 'result'; result: unknown; notice?: Extract<RunEvent, { type: 'notice' }> }
  | { kind: 'error'; code: number; message: string; notice?: Extract<RunEvent, { type: 'notice' }> };
export interface TitleControl { read(providerSessionId: string): Promise<string | undefined>; set?(providerSessionId: string, title: string): Promise<void> }
export type AcpStopReason = string;
/** On Engine and ProviderRuntime iff features.history !== 'none'. Range rule in providers.md *History*. Neither method starts a turn or holds a process. */
export interface HistoryControl {
  /** Sessions whose cwd is this project, newest first. Never throws; [] on failure. Default limit 15. */
  list(cwd: string, limit?: number): Promise<ThreadSummary[]>;
  /** A transcript summary of one session. Never throws; an empty transcript on failure. Default maxTurns 10. */
  read(cwd: string, providerSessionId: string, maxTurns?: number): Promise<ThreadHistory>;
}

/** One entry of the wire model catalog, so the desktop and the model card read the provider's list unchanged. */
export type ModelInfo = ModelCatalog['models'][number];

/** A past session for the resume picker. */
export interface ThreadSummary {
  /** The provider session id, passed back as `resume`. */
  sessionId: string;
  /** The first user message. */
  preview: string;
  /** Unix seconds. */
  createdAt: number;
  updatedAt: number;
  name?: string;
}

/** One tool, command, file, or web call in a past session's transcript. */
export interface HistoryTool {
  /** The shell command, or a label such as 编辑文件 or 联网搜索. */
  title: string;
  /** Aggregated stdout and stderr; the renderer truncates. */
  output?: string;
  exitCode?: number | null;
  /** The call errored or was declined. */
  failed?: boolean;
}

/** One user-to-assistant exchange in a past session. */
export interface HistoryTurn {
  /** '' for a tool-only or boilerplate turn. */
  userText: string;
  assistantText: string;
  /** '' when the provider surfaced none. */
  reasoning: string;
  /** In arrival order. */
  tools: HistoryTool[];
  /** Unix seconds. */
  startedAt?: number;
}

/** A past session's transcript for the history card, normalized so the card never reads a provider's wire shape. */
export interface ThreadHistory {
  /** The most recent turns kept for display, oldest first. */
  turns: HistoryTurn[];
  /** Non-empty turns before truncation, at least turns.length. */
  totalTurns: number;
  name?: string;
  preview?: string;
  /** Unix seconds. */
  createdAt?: number;
  updatedAt?: number;
}

export type UsageErrorKind =
  /** No login on this machine. */
  | 'no-auth'
  /** The login mode has no usage data, such as a Codex API key. */
  | 'api-key-mode'
  /** The server rejected the login for good; the user must log in again. */
  | 'need-relogin'
  /** A network or service blip; retry later. */
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
  /** An integer 0 to 100. */
  usedPercent: number;
  /** 5h is 18000, 7d is 604800. */
  windowSeconds?: number;
  /** Unix seconds. */
  resetAt?: number;
}

export interface RateBucket {
  /** The extra limit's name, such as GPT-5.3-Codex-Spark; undefined for the main limit. */
  name?: string;
  primary?: RateWindow;
  secondary?: RateWindow;
}

export interface AccountUsageSnapshot {
  planType?: string;
  /** The main limit, with its 5h and 7d windows. */
  main: RateBucket;
  /** Per-feature extra limits, each with its own windows. */
  extras: RateBucket[];
  /** Milliseconds. */
  fetchedAt: number;
}

export interface DailyBucket {
  /** YYYY-MM-DD on the server's day boundary. Only days with usage; the heat map fills the gaps with 0. */
  date: string;
  tokens: number;
}

export interface AccountProfileStats {
  displayName?: string;
  lifetimeTokens?: number;
  peakDailyTokens?: number;
  currentStreakDays?: number;
  longestStreakDays?: number;
  /** Seconds. */
  longestTurnSec?: number;
  totalThreads?: number;
  fastModePct?: number;
  totalSkillsUsed?: number;
  uniqueSkillsUsed?: number;
  mostUsedEffort?: string;
  mostUsedEffortPct?: number;
  /** At most 5. */
  topInvocations: { name: string; count: number; kind: 'plugin' | 'skill' }[];
  dailyBuckets: DailyBucket[];
  statsAsOf?: string;
}

/** The usage card's data: account limits and profile statistics. */
export interface AccountUsage {
  profile: AccountProfileStats;
  usage: AccountUsageSnapshot;
}
