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
