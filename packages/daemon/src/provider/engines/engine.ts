import type {
  AccountUsage, Failure, GoalEnd, HistoryControl, HostFacts, InstallProbe, ModelInfo, ProviderAnswer, ProviderFeatures,
  ProviderRequest, RunEvent, SubagentId, TitleControl, TurnId, TurnOptions, UserInput,
} from '../model';
import type { EnforcementPlan, EnforcementTable } from '../policy/enforcement';

export interface StopProfile { needsTurnId: boolean; openWaitMs: number; graceMs: number }
export const TERM_WAIT_MS = 1500;      // term-tree to kill-tree, every engine
export const KILL_CONFIRM_MS = 2000;   // kill-tree to local settlement as `unconfirmed`, every engine

/** The scheduled time from a stop to the latest possible settlement, with no answer from the provider or the host. */
export function stopBoundMs(profile: StopProfile): number {
  return (profile.needsTurnId ? profile.openWaitMs : 0) + profile.graceMs + TERM_WAIT_MS + KILL_CONFIRM_MS;
}

/** The engine's view of how a turn ended. An exit is never a verdict: exit facts come only from OwnedProcess. */
export type TurnVerdict = { kind: 'completed' } | { kind: 'failed'; failure: Failure } | { kind: 'cancelled' };

export interface SignalSink {
  frame(): void;                        // every inbound frame, event or not; feeds lastActivity()
  emit(event: Exclude<RunEvent, { type: 'outcome' }>): void;
  verdict(v: TurnVerdict): void;
}

/** sent: the group call returned success, never death. refused: it returned an error. accepted: a pre-call acknowledgement, only the Windows term rung. unknown: no receipt. */
export type SignalResult = 'sent' | 'refused' | 'accepted' | 'unknown';
/** parent: the retaining parent's own wait. containment: the sealed group or Job was proven empty, so no code is known. */
export type ExitFact = { observed: 'parent'; code: number | null; signal: string | null } | { observed: 'containment' };
/** At most one of each. transport-lost may precede an exit; an exit is never followed by transport-lost. */
export type ProcessFact = { kind: 'exit'; exit: ExitFact } | { kind: 'transport-lost' };
/** The runtime's whole view of the provider process a session owns. The exit-report hold behind watch() is the host's rule. */
export interface OwnedProcess {
  term(): Promise<SignalResult>;                            // the term-tree effect; 'unknown' when no receipt comes; never rejects
  kill(): Promise<SignalResult>;                            // the kill-tree effect; same rule
  watch(listener: (fact: ProcessFact) => void): () => void;  // replays past facts synchronously; returns unsubscribe
}

import type { ProcessHost } from '../process/process-host';
export type { ProcessHost };

/** iff features.goal !== 'none'. Codex: thread/goal/set and thread/goal/clear. Behavior in providers.md *Goals*. */
export interface EngineGoal {
  set(objective: string, opts: TurnOptions, sink: GoalSink): Promise<void>;   // resolves once the provider accepted the goal
  clear(): Promise<void>;                                                     // idempotent, also while set is pending
}
export interface GoalSink {
  frame(): void;                        // goal traffic outside a turn; feeds the goal idle bound while the goal is open
  /** The sink for a turn the provider just started, or undefined once the goal's end is chosen: that turn is an orphan. */
  turn(): SignalSink | undefined;
  goal(event: Extract<RunEvent, { type: 'goal' }>): void;
  ended(end: Extract<GoalEnd, { kind: 'terminal' | 'failed' }>): void;   // ignored once the end is chosen
}

export interface OpenSpec { cwd: string; resume?: string; model?: string; effort?: string }

/** The registry key is the provider id; an engine does not carry one. */
export interface Engine {
  readonly features: ProviderFeatures;
  readonly stop: StopProfile;
  readonly table: EnforcementTable;
  probe(host: HostFacts): Promise<InstallProbe>;
  open(spec: OpenSpec, plan: EnforcementPlan, host: ProcessHost): Promise<EngineSession>;
  /** The native catalog. iff features.models !== 'none'. */
  models?(): Promise<ModelInfo[]>;
  history?: HistoryControl;                                   // iff features.history !== 'none'
  titles?: TitleControl;                                      // iff features.titles !== 'none'
  usage?(): Promise<AccountUsage>;                            // iff features.usage !== 'none'
  /** iff features.oneShot !== 'none'. A separate process with no tools, owned by ProcessHost, killed at timeoutMs. */
  oneShot?(prompt: string, opts: { timeoutMs: number }): Promise<string | undefined>;
}

export interface EngineSession {
  readonly providerSessionId: string;
  readonly process: OwnedProcess;
  /** Resolves once the prompt is on the wire. Rejects only when the transport failed; a provider's error answer is a `failed` verdict. */
  startTurn(input: UserInput, opts: TurnOptions, sink: SignalSink): Promise<void>;
  interrupt(turnId: TurnId | undefined): Promise<void>;
  steer?(input: UserInput): Promise<'accepted' | 'rejected'>;
  compact?(): Promise<void>;
  goal?: EngineGoal;                                          // iff features.goal !== 'none'
  stopSubagent?(id: SubagentId): Promise<void>;              // iff features.subagentStop !== 'none'
  answerAutomatic(request: ProviderRequest): ProviderAnswer;
  /** Hands the process to the host's termination of this record. Resolves when handed over; never waits on the tree. */
  close(): Promise<void>;
}
