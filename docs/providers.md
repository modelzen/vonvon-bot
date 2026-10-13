# Provider layer

This document is the design for the provider layer that replaces the V6 and V7 sections of `plan.md` as they stood on 2026-10-11. The delivery plan is in `plan.md` under V6a to V6d and V7a to V7c. The Chinese summary is in `architecture.md`. It was produced by an arena of four candidate designs with a cross-judge verdict, then synthesized by hand. The synthesis decision is recorded below.

Facts cite one of these sources. `CX` is the generated Codex app-server protocol under `packages/daemon/src/agent/codex-appserver/protocol/generated/` (managed install pinned at 0.156.1, `codex-install-lock.json:12`). `VB` is `packages/daemon/src/agent/codex-appserver/backend.ts` on `main` 7a101ce. `SDK` is `@anthropic-ai/claude-agent-sdk` 0.3.246 `sdk.d.ts`. `ACP` is `@agentclientprotocol/sdk` 0.17.1 `schema/types.gen.d.ts`. `GF` and `GD` are Orca's recorded Grok 1.0.46 fixtures and dialect files. `CUR` is Cursor's ACP documentation at `cursor.com/docs/cli/acp`, read 2026-10-12. `PIR` and `PIS` are Pi 0.99.1 `rpc-types.d.ts` and `agent-session.d.ts`. `audit row N` is row N of the native capability audit `native-capabilities.md` (2026-10-12), which is the authoritative 44-row matrix.

## Problem

Vonvon runs one agent per Feishu group and shows the agent's work as a run card. Today the bot talks to agents through `AgentBackend`, `AgentThread`, and `AgentRun` in `packages/daemon/src/agent/types.ts`. That contract has a Codex implementation and a Claude Code implementation. Thirty-nine source files outside `agent/` import from it, and 72 test files under `packages/daemon/test` (`git grep -lE "['\"](\.\.?/)+(\.\./)*agent(/[^'\"]*)?['\"]" origin/main -- packages/daemon/src`, and `git grep -l "src/agent" origin/main -- packages/daemon/test`). Three things are wrong with it.

1. Capabilities are declared loosely. `AgentBackend.capabilities` is optional and `supportedModes` undefined means every tier (`agent/types.ts:410-414`, `agent/catalog.ts:58-59`). Consumers read `capabilities?.x ?? true`. Nothing stops a feature from being emulated. The current Claude backend emulates `goal` as a prompt loop.
2. The five baseline capabilities the product needs are missing from the contract. Subagents, a todo list, image output, a turn outcome with a reason, and a robust interrupt have no event shape, so each card feature was built against one provider's quirks. Issue #114 shows the image path has a lexical containment check that a symlink defeats (`card/outbound-images.ts:128-135`) and an ungated remote fetch (`:181`).
3. Permission tiers are not enforced where they are promised. The Claude sandbox covers Bash only. `Read`, `Grep`, and `Glob` in a `qa` session can read any file (audit row 34). Codex itself does not confine reads on Linux (VB:43-48). `main` keeps the promise only by refusing every Codex `qa` and `write` run on Linux before spawn (VB:76-82, `throw` at :79), including runs whose reads could be unrestricted. The product promises `qa`, `write`, and `full`, and a read scope of project or unrestricted, with no approval cards. A tier the host cannot enforce must refuse with a Chinese message, not degrade.

The user decided the following, recorded in the arena frame. Exactly three tiers, `qa`, `write`, `full`, and no approval cards. Read scope is a per-project setting, project only or unrestricted, and an unenforceable combination fails closed with a Chinese refusal. Every capability, the five baselines included, is supported exactly when the provider has it natively. Nothing is emulated. Plan mode is not supported. The Paseo chat mode is the parity floor for what the card shows from native signals. Providers are Codex, Claude Code, Cursor, Grok, Pi, and a custom ACP command. Copilot and OpenCode are deferred. DeepSeek, Kimi, GLM, and Qwen reach the model through Claude Code's user settings and need no provider of their own.

## Usage

The bot sees one object, `ProviderRuntime`. It opens a `Conversation` for a project and a chat, sends a `UserInput`, and reads one `Run` as an async iterable of `RunEvent`. The card folds the events with `foldRun` into a `RunView` and renders it. Nothing outside `provider/` names a provider id, a tool name, or a wire field.

```ts
const runtime = createProviderRuntime({ dataDir, processHost, registry: REGISTRY }); // REGISTRY from provider/registry.ts

const opened = await runtime.open({
  provider: project.provider,
  cwd: project.cwd,
  grant: { tier: project.mode, readScope: project.readScope, network: project.network, root: project.cwd },
  resume: session?.providerSessionId,
});
if (!opened.ok) return postRefusal(chat, opened.refusal); // Chinese text, nothing spawned

const run = opened.conversation.send({ text, images });
let view = emptyRunView();
for await (const event of run.events) {
  view = foldRun(view, event);
  await card.update(renderRunCard(view, opened.conversation.features));
}
// run.events has ended. The last event was `outcome`, exactly once.
```

Stop is `run.stop('user')`. It resolves within the engine's stop bound even before the provider has announced a turn id, and the run ends with `interrupted`. The 查看完整过程 button reads `run.subagents().history(id)`. A provider feature such as `/compact` or `/goal` exists on `Conversation` only when `features.compact` or `features.goal` is `native` or `partial`, and the command list is built from `features`, so a command the provider lacks is never offered. A message that arrives while a run is live goes to `conversation.steer` when it exists and accepts; otherwise the bot queues it as the next turn (see *Follow-ups during a run*). The bot never calls `send` while a run is live.

## Shape

### Data types

Identifiers and the grant come first. The grant is the only permission input an engine ever sees.

```ts
/** Grows with the registrations: V6a and V6b 'codex' | 'claude', V7a adds 'cursor' | 'grok' | 'custom-acp', V7b adds 'pi'. */
export type ProviderId = 'codex' | 'claude' | 'cursor' | 'grok' | 'pi' | 'custom-acp';
export type Tier = 'qa' | 'write' | 'full';
export type ReadScope = 'project' | 'unrestricted';
export type Os = 'darwin' | 'linux' | 'win32';

/** Resolved per project. `root` is realpath(cwd), resolved once at open. */
export type Grant =
  | { tier: 'full'; root: string; network: boolean }
  | { tier: 'qa' | 'write'; root: string; readScope: ReadScope; network: boolean };
export const DEFAULT_READ_SCOPE: ReadScope = 'project';
```

`network` is the project network switch, stored for every tier. Engines consult it only for `qa` and `write`. In `full` the switch does not limit the agent, which has unrestricted network. Vonvon's own remote image fetch consults it in every tier, `full` included, so a remote image is fetched only when the switch is on (see Outbound).

The run event stream is the one contract the card depends on.

```ts
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
  task: string;              // capped at 120 chars
  startedAt: number;
  endedAt?: number;
  stepCount: number;
  currentStep?: string;
  recentSteps: Step[];       // at most 5, newest last
  result?: string;           // capped at 600 chars
}

export type Failure =
  | { kind: 'refused' }
  | { kind: 'auth'; hint: string }
  | { kind: 'limit'; limit: 'max-tokens' | 'max-turns' | 'context-window' | 'rate-limit' | 'usage-limit' }
  | { kind: 'provider-error'; message: string }
  | { kind: 'process-exit'; code: number | null; signal: string | null }
  | { kind: 'transport-lost' };   // the provider's stream closed and no exit fact followed; see *Engine and runtime*

/** Who asked for a stop. 'daemon' is daemon shutdown or restart only, never a forced user or watchdog stop. */
export type StopBy = 'user' | 'watchdog' | 'daemon';

export type Outcome =
  | { state: 'completed' }
  | { state: 'failed'; failure: Failure }
  | { state: 'interrupted'; by: StopBy | 'agent'; tree: TreeFate };    // what the stop did to the process tree
/**
 * live: settled by a verdict, no `sent` receipt. signalled: settled by a verdict after a `sent` receipt (a dispatch fact,
 * never death). exited: an exit fact of *Process host* arrived. unconfirmed: the confirm deadline after kill-tree passed
 * with neither; ProcessHost keeps the tree. No value is derived from emitting an effect. Rules in *Engine and runtime*.
 */
export type TreeFate = 'live' | 'signalled' | 'exited' | 'unconfirmed';

export type RunEvent =
  | { type: 'session'; providerSessionId: string }                       // first, once
  | { type: 'started'; turnId: TurnId }                                   // may be late or absent
  | { type: 'text'; lane: Lane; itemId: ItemId; channel: 'answer' | 'reasoning'; delta: string }
  | { type: 'text-final'; lane: Lane; itemId: ItemId; channel: 'answer' | 'reasoning'; text: string }
  | { type: 'step'; lane: Lane; step: Step }                              // upsert by step.id
  | { type: 'subagent'; agent: SubagentState }                            // roster upsert
  | { type: 'todo'; items: TodoItem[] | null }                            // whole-list replacement
  | { type: 'image'; image: ImageRef }
  | { type: 'context'; used: number; window: number | null }
  | { type: 'compaction'; phase: 'start' | 'end'; trigger: 'auto' | 'manual' }
  | { type: 'goal'; status: string; objective: string; tokensUsed: number; timeUsedSeconds: number; tokenBudget: number | null }
  | { type: 'notice'; kind: 'retry' | 'bash-off' | 'mcp-off' | 'question-declined' | 'resume-failed' | 'image-cap' | 'other'; text: string }
  | { type: 'provider-message'; level: 'info' | 'warn'; text: string }
  | { type: 'outcome'; outcome: Outcome; usage?: { input?: number; output?: number; cached?: number } }; // last, once
```

Rules the runtime enforces, not the engines. `outcome` is emitted exactly once and last, including after a kill or a crash. A `step` whose lane is a subagent never appears in `Run.events`; it is folded into that subagent's row. A todo tool call never produces a `step`. `text` for a subagent lane is folded into that subagent's row, never into the answer. An `image` whose payload arrived as base64 is on disk before the event exists.

The capability record is typed data. A cell is `native` when the provider emits the signal and the engine maps it, `partial` when the provider emits it in some situations and the engine maps it when present, `none` when the provider never emits it. A cell the audit marks unknown ships `none` and names its probe in `pending`.

```ts
export type Support = 'native' | 'partial' | 'none';
export type ProbeId = string; // e.g. 'cursor.initialize', 'grok.three-turns'

export interface ProviderFeatures {
  // baseline (FRAME). The card shows an area iff the cell is not 'none'.
  subagents: Support; subagentStop: Support; todo: Support; images: Support;
  outcomeReason: Support; reasoning: Support;
  // extras. A Conversation member exists iff its cell is 'native' or 'partial'.
  steer: Support; compact: Support; compaction: Support; goal: Support;
  history: Support; titles: Support; usage: Support;
  /** A tool-less one-shot run the daemon can use for Vonvon-owned work such as session titles. Not a run feature. */
  oneShot: Support;
  contextUsage: Support; models: Support; effort: Support; retryNotice: Support;
  imageInput: Support; webSearch: Support;
  /** Cells shipped 'none' because the audit says unknown. Flipped by one commit when the probe lands. */
  pending: Partial<Record<keyof Omit<ProviderFeatures, 'pending'>, ProbeId>>;
}
```

The enforcement table is typed data too. A cell is `enforced` only with a `Proof`. A `live` proof names a probe that ran on that OS against the installed provider version. A `doc` proof is allowed for exactly two kinds of cell, and `auditTable` rejects it anywhere else.

- **Unrestricted.** The key's tier is `full`, `mechanisms` is `[]`, and `native` is that family's unrestricted setting and nothing narrower: Codex `sandbox: 'danger-full-access'`, Claude `mode: 'bypass'`, ACP `bypass: true`, Pi with `tools` absent. `ref` names the provider document for that setting. The cell claims only that Vonvon confines nothing, so no probe has a confinement to observe. A wrong reading of the document can only leave the provider narrower than `full`: it asks, which the daemon answers at once (*Auto-answered requests*); it denies a tool; or it rejects the setting and the turn fails visibly. None of these grants more than `full`, which is already the widest grant. So the proof needs no OS or version check, and one cell serves every OS. The install and login refusals still apply at run time.
- **Launch-args.** The key's tier is `qa` or `write`, and `mechanisms` is exactly `['launch-args']`: the confinement is a narrower tool list passed at launch and nothing else.

Every other `enforced` cell needs a `live` proof. That covers every cell whose confinement is an OS sandbox, a tool gate, or a provider gate, and every `qa` and `write` cell that names one of them beside `launch-args`.

```ts
export type Mechanism = 'os-sandbox' | 'tool-gate' | 'launch-args' | 'provider-gate';
export type Proof =
  | { kind: 'live'; probe: ProbeId; os: Os; provenFor: string }   // provider version range
  | { kind: 'doc'; ref: string };

export type RefuseReason =
  | 'read-scope-unenforceable' | 'tier-unenforceable' | 'sandbox-dependency-missing'
  | 'unverified-combination' | 'windows-sandbox-not-ready' | 'sandbox-not-confirmed'
  | 'provider-not-installed' | 'not-logged-in' | 'custom-command-unset' | 'custom-command-invalid';

export type NativeSettings =
  | { family: 'codex'; sandbox: 'danger-full-access' }
  /** Thread-level `sandbox` carries no network flag. Network goes in the turn-level `sandboxPolicy` of every `turn/start`. */
  | { family: 'codex'; sandbox: 'read-only'; sandboxPolicy: { type: 'readOnly'; networkAccess: boolean } }
  | { family: 'codex'; sandbox: 'workspace-write'; sandboxPolicy: { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeSlashTmp: true; excludeTmpdirEnvVar: true } }
  | { family: 'codex'; sandbox: 'profile'; profile: 'feishu'; rootAccess: 'read' | 'write'; network: boolean }
  | { family: 'claude'; mode: 'bypass'; permissionMode: 'bypassPermissions'; allowDangerouslySkipPermissions: true }
  | { family: 'claude'; mode: 'gated'; permissionMode: 'default'; tools: string[]; sandbox: Record<string, unknown> | null; managedSettings: Record<string, unknown>; shell: 'sandboxed' | 'off' }
  | { family: 'acp'; bypass: boolean }
  | { family: 'pi'; tools?: string[] };

export type Cell =
  | { mode: 'enforced'; mechanisms: Mechanism[]; native: NativeSettings; proof: Proof; loss?: 'bash-off' }
  | { mode: 'refuse'; reason: RefuseReason };

export type CellKey = `${ProviderId}:${Tier}:${ReadScope | '-'}:${Os}`;
export type EnforcementTable = Readonly<Partial<Record<CellKey, Cell>>>;

export interface EnforcementPlan {
  readonly provider: ProviderId;
  readonly grant: Grant;
  readonly readableRoots: string[] | 'unrestricted';
  readonly writableRoots: string[] | 'unrestricted';
  readonly native: NativeSettings;
  readonly notices: string[];      // Chinese, e.g. the Bash-off notice
}

export type Refusal = { reason: RefuseReason; message: string; hint: string }; // Chinese
export type PlanResult = { ok: true; plan: EnforcementPlan } | { ok: false; refusal: Refusal };

/** Pure. Never spawns. A missing key is a refusal with 'unverified-combination'. */
export function planEnforcement(table: EnforcementTable, provider: ProviderId, grant: Grant, os: Os, host: HostFacts): PlanResult;
/**
 * Build-time test. Returns every 'enforced' cell without a Proof; every 'full' cell whose mechanisms are not []
 * or whose native is not its family's unrestricted setting; and every 'doc' proof on a cell that is neither
 * unrestricted (tier 'full') nor launch-args (tier 'qa' or 'write' with mechanisms exactly ['launch-args']).
 */
export function auditTable(table: EnforcementTable): CellKey[];
```

`HostFacts` carries what changes per boot. `commandSandbox` is `seatbelt`, `bwrap`, or `none`, from a probe that runs `sandbox-exec` or `bwrap --unshare-user true` once per daemon boot and again on `doctor`. `windowsSandboxReady` is Codex `windowsSandbox/readiness`. `installed` is the provider probe result with its version.

### Supporting types

These complete the listings. The ones written out are contract. The ones in the list after them are free for Codex to shape, provided no provider id, tool name, or wire field leaves `provider/` through them and no listed contract gains a field.

```ts
export class ConversationBusy extends Error {}           // send() or GoalControl.start() while a run or a goal is live; the bot never triggers it
export interface HostFacts {
  os: Os; commandSandbox: 'seatbelt' | 'bwrap' | 'none'; windowsSandboxReady?: boolean;
  installed: Partial<Record<ProviderId, InstallProbe>>;
}
export interface InstallProbe { installed: boolean; version?: string; auth: 'ok' | 'logged-out' | 'unknown'; hint?: string } // hint is Chinese
export interface ProviderStatus { id: ProviderId; displayName: string; probe: InstallProbe; features: ProviderFeatures; tiers: Tier[] } // tiers: cells this host can plan
export interface UserInput { text: string; images: { path: string; mime: ImageRef['mime'] }[] }
export interface TurnOptions { model?: string; effort?: string }
export interface ProviderRequest { method: string; params: unknown }
export type ProviderAnswer =
  | { kind: 'result'; result: unknown; notice?: Extract<RunEvent, { type: 'notice' }> }
  | { kind: 'error'; code: number; message: string; notice?: Extract<RunEvent, { type: 'notice' }> };
export interface TitleControl { read(providerSessionId: string): Promise<string | undefined>; set?(providerSessionId: string, title: string): Promise<void> }
export type AcpStopReason = string;                      // raw ACP stopReason; an unknown value maps to failed{provider-error}

/** Why a goal ended. Chosen once by the first trigger; nothing afterwards changes it. Behavior in *Goals*. */
export type GoalEnd =
  | { kind: 'terminal'; status: string }   // the provider's own terminal goal status
  | { kind: 'failed'; failure: Failure }    // goal-level failure, or the session's process fact (process-exit, transport-lost)
  | { kind: 'cleared' }                     // GoalRun.end(), or GoalRun.stop('user' | 'daemon')
  | { kind: 'timeout' };                    // GoalRun.stop('watchdog'), which the goal idle bound calls

/** On Conversation iff features.goal !== 'none'. Behavior in *Goals*. */
export interface GoalControl {
  /** Throws ConversationBusy while a run or a goal is live. */
  start(objective: string, opts?: TurnOptions): GoalRun;
}
export interface GoalRun {
  /** One Run per provider turn, in order, each with its own outcome. Ends when the goal has ended, possibly with no Run. */
  readonly runs: AsyncIterable<Run>;
  /** The latest goal event, undefined before the first. Keeps its last value after runs ends. */
  status(): Extract<RunEvent, { type: 'goal' }> | undefined;
  /** Why the goal ended. Settles the moment the end is chosen, before runs ends. Never rejects. The terminal card reads it. */
  result(): Promise<GoalEnd>;
  /** Choose cleared and let the ending run finish on its own. Resolves when runs has ended. Never rejects. The 🎯 结束目标 button. */
  end(): Promise<void>;
  /** Chooses the reason, then runs the ladder on the ending run once clear settled. Every call resolves with the ending run's outcome, or `undefined` with none. The ⏹ 终止 button. */
  stop(by: StopBy): Promise<Outcome | undefined>;
}
```

Free for Codex to shape: `OpenSpec`, `ProcessHost` (behavior in *Process host*), `AcpCommand`, `HostSettings`, `DialectState`, `RunView` and `emptyRunView` (the fold target of the card).

### Engine and runtime

An `Engine` is one provider's adapter. It is small because the runtime owns the turn, the stop ladder, the ledgers, and the process.

```ts
export interface StopProfile { needsTurnId: boolean; openWaitMs: number; graceMs: number }
export const TERM_WAIT_MS = 1500;      // term-tree to kill-tree, every engine
export const KILL_CONFIRM_MS = 2000;   // kill-tree to local settlement as `unconfirmed`, every engine

/** The engine's view of how a turn ended. An exit is never a verdict: exit facts come only from OwnedProcess. */
export type TurnVerdict = { kind: 'completed' } | { kind: 'failed'; failure: Failure } | { kind: 'cancelled' };

export interface SignalSink {
  frame(): void;                        // every inbound frame, event or not; feeds the watchdog
  emit(event: Exclude<RunEvent, { type: 'outcome' }>): void;
  verdict(v: TurnVerdict): void;
}

/** sent: the group call returned success, never death. refused: it returned an error. accepted: a pre-call acknowledgement, only the Windows term rung. unknown: no receipt. */
export type SignalResult = 'sent' | 'refused' | 'accepted' | 'unknown';
/** parent: the retaining parent's own wait. containment: the sealed group or Job was proven empty, so no code is known. */
export type ExitFact = { observed: 'parent'; code: number | null; signal: string | null } | { observed: 'containment' };
/** At most one of each. transport-lost may precede an exit; an exit is never followed by transport-lost. */
export type ProcessFact = { kind: 'exit'; exit: ExitFact } | { kind: 'transport-lost' };

export interface OwnedProcess {
  term(): Promise<SignalResult>;                            // the term-tree effect; never rejects
  kill(): Promise<SignalResult>;                            // the kill-tree effect; never rejects
  watch(listener: (fact: ProcessFact) => void): () => void;  // replays past facts synchronously; returns unsubscribe
}

/** iff features.goal !== 'none'. Codex: thread/goal/set and thread/goal/clear. Behavior in *Goals*. */
export interface EngineGoal {
  set(objective: string, opts: TurnOptions, sink: GoalSink): Promise<void>;   // resolves once the provider accepted the goal
  clear(): Promise<void>;                                                     // idempotent, also while set is pending
}
export interface GoalSink {
  frame(): void;                        // goal traffic outside a turn; feeds the goal idle bound while the goal is open
  turn(): SignalSink | undefined;       // at each turn start; undefined once the end is chosen, and that turn is an orphan
  goal(event: Extract<RunEvent, { type: 'goal' }>): void;
  ended(end: Extract<GoalEnd, { kind: 'terminal' | 'failed' }>): void;   // ignored once the end is chosen
}

/** The registry key is the provider id; an engine does not carry one. */
export interface Engine {
  readonly features: ProviderFeatures;
  readonly stop: StopProfile;
  readonly table: EnforcementTable;
  probe(host: HostFacts): Promise<InstallProbe>;             // installed, version, auth, Chinese hint
  open(spec: OpenSpec, plan: EnforcementPlan, host: ProcessHost): Promise<EngineSession>;
  titles?: TitleControl;                                      // iff features.titles !== 'none'
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
  stopSubagent?(id: SubagentId): Promise<void>;
  answerAutomatic(request: ProviderRequest): ProviderAnswer;  // pure; see Auto-answered requests
  close(): Promise<void>;                                     // hands the process to ProcessHost; never waits on the tree
}
```

A session owns one provider process, and the runtime reaches it only through `OwnedProcess`. `term()` and `kill()` are the two tree effects; each resolves with the host's receipt and never rejects. `watch()` delivers the exit fact and `transport-lost`, at most one of each, and replays them to a late listener. A closed stream is reported as `transport-lost` only when no exit fact follows within the host's exit-report hold, so a crash reads as an exit. No engine reports an exit. A provider's error answer is a `failed` verdict. `startTurn` rejects only when the transport failed, and the runtime then waits for the process fact. A protocol error that leaves the stream open is the engine's `failed{provider-error}` on the live turn, after which the engine closes the session.

Every engine's frame handling is a pure function `translate(state, frame) -> { state, events, verdict? }`. It is tested by replaying recorded `.jsonl` fixtures and comparing the event sequence to a golden file. The impure part of an engine is the transport and the process, which it gets from `ProcessHost` and the shared `JsonRpcPeer` or `JsonlPeer`.

The turn machine is pure as well.

```ts
export type Rung = 'await-turn' | 'interrupt' | 'term' | 'kill';   // the stage the machine has issued; a receipt never moves it
export type TurnState =
  | { phase: 'opening' }
  | { phase: 'running'; turnId: TurnId }
  | { phase: 'stopping'; turnId?: TurnId; by: StopBy; rung: Rung; deadline: number; signalled: boolean }   // deadline is absolute
  | { phase: 'settled'; turnId?: TurnId; outcome: Outcome };
export type TurnInput =
  | { kind: 'started'; turnId: TurnId } | { kind: 'verdict'; verdict: TurnVerdict } | { kind: 'stop'; by: StopBy } | { kind: 'tick' }
  | { kind: 'signal'; rung: 'term' | 'kill'; result: SignalResult }   // the receipt of a term() or kill() call
  | { kind: 'exit'; exit: ExitFact } | { kind: 'transport-lost' };     // facts from OwnedProcess.watch
export type Effect = { kind: 'stop-subagents' } | { kind: 'interrupt'; turnId?: TurnId } | { kind: 'term-tree' } | { kind: 'kill-tree' };

export function stepTurn(state: TurnState, input: TurnInput, profile: StopProfile, now: number): { state: TurnState; effects: Effect[] };
export function deadlineOf(state: TurnState): number | undefined;   // the one timer; undefined outside stopping
export function stopBoundMs(profile: StopProfile): number;          // the bound column below
```

The machine has no timer effect and no outcome effect. `RunChannel` keeps one timer at `deadlineOf(state)` and appends the outcome the first time the state is `settled`. It executes the effects: `stop-subagents` calls `EngineSession.stopSubagent` for every running roster entry when the engine has it, without awaiting; `interrupt` calls `EngineSession.interrupt`, and a failure is logged; `term-tree` and `kill-tree` call `OwnedProcess.term()` and `kill()` and feed each receipt back as `signal`. Exit facts and `transport-lost` from `watch()` become the `exit` and `transport-lost` inputs.

| input | `opening` | `running` | `stopping` |
|---|---|---|---|
| `started` | `running` | ignored; a different id is logged | records the id if none. In `await-turn` before the deadline: `interrupt`, rung `interrupt`, deadline now + `graceMs`. At or after it: the `tick` rule |
| `stop` | `stop-subagents`. With `needsTurnId`: rung `await-turn`, deadline now + `openWaitMs`. Otherwise: `interrupt`, rung `interrupt`, deadline now + `graceMs` | `stop-subagents`, `interrupt` with the id, rung `interrupt`, deadline now + `graceMs` | ignored; the first `by` stays |
| `tick` | ignored | ignored | every passed ladder row, in order |
| `verdict` | the outcome table | the outcome table | `completed` and `failed` keep their outcome. `cancelled` is `interrupted{by, tree}` |
| `signal` | ignored | ignored | `sent` for an issued rung sets `signalled`. Anything else is logged |
| `exit` | `failed{process-exit}` | `failed{process-exit}` | `interrupted{by, tree: 'exited'}` |
| `transport-lost` | `failed{transport-lost}` | `failed{transport-lost}` | ignored and logged |

| rung | deadline | when it passes |
|---|---|---|
| `await-turn` | stop + `openWaitMs` | `term-tree`; rung `term`; deadline + `TERM_WAIT_MS` |
| `interrupt` | interrupt sent + `graceMs` | `term-tree`; rung `term`; deadline + `TERM_WAIT_MS` |
| `term` | previous deadline + `TERM_WAIT_MS` | `kill-tree`; rung `kill`; deadline + `KILL_CONFIRM_MS` |
| `kill` | previous deadline + `KILL_CONFIRM_MS` | settles `interrupted{by, tree: 'unconfirmed'}` |

Every deadline is absolute. Each is the previous deadline plus its wait, so one late `tick` emits every overdue effect in order and can settle in the same step. Only the grace deadline is anchored where `interrupt` was sent, because that is the provider's time to answer it. The bound is `openWaitMs + graceMs + TERM_WAIT_MS + KILL_CONFIRM_MS` of scheduled time, and the machine reaches it with no input from the host. Host facts can only settle earlier. Settled ignores every input, so there is one outcome.

`tree` is read from the state at settlement. A verdict gives `signalled` when a `sent` receipt for an issued rung was recorded, and `live` otherwise, including after `refused`, `accepted`, `unknown`, or no receipt. An exit fact gives `exited` whatever came before. The kill row gives `unconfirmed`. The run is settled locally, `ProcessHost` keeps the record, and `owesWork()` stays true for it. Emitting `term-tree` or `kill-tree` records nothing. `transport-lost` while stopping changes nothing, because only the ladder and an exit fact can say what happened to the tree. After `failed{process-exit}`, `failed{transport-lost}`, or `tree: 'unconfirmed'`, the runtime closes the conversation, and the next message opens a new one with `resume`. `by` is the first stop's `by` in every case. `by: 'daemon'` comes only from `closeAll()`.

Subagents and the outcome. When `outcome` is emitted, every roster entry still `running` is settled as `interrupted`, and `run.events` carries that final `subagent` upsert before the `outcome`. No subagent outlives its run in the roster. Roster `interrupted` is local state: it says the run stopped tracking the entry, not that the child process ended. Where `subagentStop` is `none`, nothing addresses a child individually; its fate is the tree's fate, which only `tree` on the outcome and `ProcessHost` can state, and the card says so on each row (see *Feishu run card*).

| Engine | needsTurnId | openWaitMs | graceMs | bound | interrupt mechanism |
|---|---|---|---|---|---|
| codex | true | 5000 | 5000 | 13.5 s | `turn/interrupt` with the turn id (VB:465) |
| claude | false | 0 | 3000 | 6.5 s | `Query.interrupt()` (SDK:2425) |
| cursor, grok, custom-acp | false | 0 | 4000 | 7.5 s | `session/cancel` (ACP index.d.ts:6) |
| pi | false | 0 | 2000 | 5.5 s | `abort` (PIR:32) |

The bound column is `openWaitMs + graceMs + TERM_WAIT_MS + KILL_CONFIRM_MS` with `openWaitMs` counted only when `started` has not arrived; a stop after `started` on Codex settles within 8.5 s.

The runtime also owns these ledgers, with caps so the card budget has a worst case.

- `SubagentLedger`. At most 64 agents per run. Each keeps the last 5 steps in `recentSteps`, a history of at most 200 steps for 查看完整过程, and a result of at most 600 chars. Oldest history entries are dropped and `truncated` is set.
- `TodoTracker`. Whole-list replacement. At most 50 items, each 80 chars on the card.
- `ImageSink`. Writes base64 payloads to `<dataDir>/images/<runId>/` before emitting `image`. At most 12 images per run; later ones become one `notice{image-cap}`.

`ProviderRuntime`, `Conversation`, and `Run` are the public facade.

```ts
/** The registry parameter is typed by its own keys, so a test can inject a fake id without editing ProviderId. */
export function createProviderRuntime<Id extends string = ProviderId>(opts: {
  dataDir: string; processHost: ProcessHost; registry: Readonly<Record<Id, Registration>>;
}): ProviderRuntime<Id>;

export interface ProviderRuntime<Id extends string = ProviderId> {
  open(spec: { provider: Id; cwd: string; grant: Grant; resume?: string; model?: string; effort?: string }): Promise<{ ok: true; conversation: Conversation } | { ok: false; refusal: Refusal }>;
  list(): (Omit<ProviderStatus, 'id'> & { id: Id })[];   // for the picker, doctor, and status: from the registry and probes
  /** Tool-less one-shot for Vonvon-owned work. Tries `preferred`, then every installed engine with `oneShot`, in registry order. */
  oneShot(preferred: Id, prompt: string, timeoutMs: number): Promise<string | undefined>;
  titles(provider: Id): TitleControl | undefined;          // the engine's native title read and set, when it has one
  closeAll(): Promise<void>;                               // stop('daemon') on every live run and GoalRun.stop('daemon') on every goal whose runs has not ended, then close
  owesWork(): boolean;                                     // any live run, one-shot, or goal whose runs has not ended, or ProcessHost.owesWork(); host/lifecycle asks before restart
}
export interface Conversation {
  readonly provider: ProviderId; readonly providerSessionId: string; readonly features: ProviderFeatures; readonly plan: EnforcementPlan;
  send(input: UserInput, opts?: TurnOptions): Run;   // throws ConversationBusy while a run is live
  steer?(input: UserInput): Promise<'accepted' | 'rejected'>;   // 'rejected' also when no run is live
  compact?(): Promise<void>;
  goal?: GoalControl;                                 // iff features.goal !== 'none'; see *Goals*
  close(): Promise<void>;
}
export interface Run {
  readonly id: string;
  readonly events: AsyncIterable<RunEvent>;
  turnId(): TurnId | undefined;
  lastActivity(): number;
  stop(by: StopBy): Promise<Outcome>;
  stopSubagent?(id: SubagentId): Promise<void>;
  subagents(): { list(): SubagentState[]; history(id: SubagentId): { steps: Step[]; truncated: boolean } | undefined };
  todo(): TodoItem[] | null;
}
```

### Goals

A goal is native only, today Codex `thread/goal/*`. It is a sequence of `Run`s, one per provider turn, each a `RunChannel` with the same ladder and the same one-outcome rule. `EngineGoal.set` gets a `GoalSink`. At each turn start the engine calls `sink.turn()`, which opens the next `Run` on `GoalRun.runs` and returns its `SignalSink`. `sink.goal()` carries each status change, which `status()` keeps and the live `Run` also carries. `sink.ended()` reports the provider's own end.

A goal is `open`, then `ending`, then `ended`. The first trigger chooses the reason, settles `result()` at that moment, and moves the goal to `ending`. Nothing afterwards changes the reason.

| first trigger | `result()` | clear | ending run |
|---|---|---|---|
| `sink.ended(terminal)` or `sink.ended(failed)` | that end | `clear()` | drains to its own verdict |
| `GoalRun.end()` | `cleared` | `clear()` | drains |
| `GoalRun.stop(by)`; the idle bound as `stop('watchdog')`; `closeAll()` as `stop('daemon')` | `timeout` for `watchdog`, else `cleared` | `clear()`, then `stop(by)` on the ending run if still live | the ladder |
| an exit fact from `OwnedProcess.watch` | `failed{process-exit}` | skipped | settles from the same fact |
| `transport-lost` from `OwnedProcess.watch` | `failed{transport-lost}` | skipped | settles from the same fact |

The goal watches `OwnedProcess` from `start` until `runs` ends, so a process fact ends it before the first turn, between turns, or inside a turn. A peer that closes between turns does not wait for the idle bound.

Entering `ending` closes the gate at once. `sink.turn()` returns `undefined`, so a turn the provider starts afterwards is an orphan. The engine interrupts it without waiting and drops its frames, and the runtime counts it. `sink.ended()`, a late `set` result, and `GoalSink.frame()` are ignored. The run live at that moment, if any, is the ending run, the last item of `runs`.

Clear starts at once, also while `set` is pending, bounded by `GOAL_CLEAR_MS` (5 s, a policy). A failure is logged with its cause (`timeout`, `rejected`, `transport`) and the JSON-RPC code, never the provider's message. A goal stop sends `stop` to the ending run only after clear settled, so the provider is not asked to stop a turn while it may still start the next one. The first `by` is held across that wait. A verdict or process fact that settles the ending run during the wait stands. The goal never writes an outcome.

When the ending run has settled, or at once without one, and clear has settled, the goal keeps the process only if clear resolved within its bound, no orphan was counted, no process fact arrived, and no outcome of the goal has `tree` `signalled`, `exited`, or `unconfirmed`. Otherwise it closes the conversation, which hands the process to `ProcessHost` for termination of that record. Nothing in the goal waits on the tree. `runs` then ends. An orphan counted after `runs` ended closes the conversation if it is still open.

Order is fixed: `result()`, then the ending run's `outcome`, then `runs` ends, then every pending `end()` and `stop()` resolves. Every `stop()` resolves with the ending run's outcome, or `undefined` without one. `end()` resolves with nothing. Neither rejects. Busy, stop, idle, bound, and card rules are in plan.md V6b.

### Follow-ups during a run

A message that arrives while a run is live takes one of two paths. Both are tested in `provider-runtime.test.ts` and the ported `message-queue-races.test.ts`.

- Steer. When `conversation.steer` exists, the bot calls it. `accepted` joins the live turn, and the card shows 已接收补充，继续处理 as today.
- Queue. When `features.steer` is `none`, or `steer` returns `rejected` because the turn ended or the provider refused, the message joins the bot's existing queue. That is `QueuedTurn` in `bot/handle-message.ts` (`main:bot/handle-message.ts:407-474`) with its queued card, and it runs as the next turn after `outcome`. The queue is the bot's own feature, present for every provider. It is not emulated steer, because the message starts a new turn and never enters the live one.

### Session titles

Session titles are a Vonvon-owned feature for every provider, by the user's decision of 2026-10-12. A generated title is not a provider capability and not an emulation of one. `features.titles` says only whether the provider can read and set a title natively.

`TitleService` replaces the generation path of `bot/session-title-coordinator.ts` and keeps its durable `titleJobs` ledger. After the first turn of a session starts, it builds the prompt from the first user message as today (`main:bot/session-title.ts:312`) and gets a title in this order.

1. The project's provider, when its engine has `oneShot`. Codex runs an ephemeral thread with `sandbox: 'read-only'`, web search, hooks, fan-out, and multi-agent off, and `outputSchema`, as `main` does (VB:163-194). Claude runs `query` with `tools: []`, `maxTurns: 1`, `strictMcpConfig: true`, and `settingSources: ['user']` (SDK:1482, :1749, :2087, :2038). Pi has `--no-tools` (`pi --help`, 0.99.1); its `oneShot` ships `none` with `pending: pi.no-tools-title` until a probe proves a one-shot under it.
2. Otherwise `runtime.oneShot` falls through to any installed Codex or Claude on the machine.
3. Otherwise the first user message truncated to 36 characters with `truncateFirstSentenceTitle` (`main:bot/session-title.ts:287`). This is acceptable here because the whole title feature is Vonvon's own.

Each attempt is capped at 30 s, as `TITLE_GENERATION_TIMEOUT_MS` is today (VB:109), and the result is cut to `SESSION_TITLE_MAX_CHARS` 36 (`main:bot/session-title.ts:2`). The title is then written back through `runtime.titles(provider).set` where the provider has a native set, and stored in the `SessionRecord` `title` field otherwise. A `oneShot` process is owned by `ProcessHost` like any other and counts in `owesWork()`.

### Registry

```ts
export type Registration =
  | { kind: 'codex'; engine: () => Engine }
  | { kind: 'claude'; engine: () => Engine }
  | { kind: 'acp'; dialect: AcpDialect; command: (settings: HostSettings) => AcpCommand | Refusal }
  | { kind: 'pi'; engine: () => Engine };

export const REGISTRY = { codex, claude, cursor, grok, pi, 'custom-acp': customAcp } as const satisfies Record<ProviderId, Registration>;
```

The listing shows the registry after V7b. Each PR grows `ProviderId`, `REGISTRY`, and `toolSchema` together, so the `satisfies` check holds at every head: V6b creates `REGISTRY` with `codex` and `claude`, V7a adds `cursor`, `grok`, and `custom-acp`, and V7b adds `pi`. V6a defines `Registration` only and creates no `REGISTRY`.

Adding a provider is one registration and, for an ACP agent, one dialect. The picker, `doctor`, the status list, and the command list are generated from the registry and `features`. `registry.test.ts` passes `createProviderRuntime` a registry with an extra fake id and asserts all four show it, with no edit outside the test. Shipping a real provider needs these edits as well: its id in `ProviderId`, its `REGISTRY` entry, its enforcement cells, its id in `packages/protocol/src/domain.ts` `toolSchema`, and its display name and login hint in `policy/messages.zh.ts`. A test asserts `toolSchema` equals the `REGISTRY` keys at every head.

### ACP engine and dialects

One ACP engine serves Cursor, Grok, and the custom command. The stock SDK `ClientSideConnection` validates every `session/update` with zod and rejects kinds it does not know. Grok's `subagent_spawned` fails there (`acp.js:427`, confirmed with `safeParse` by the judge). The engine therefore uses its own thin client over `JsonRpcPeer`. It parses the envelope, validates the kinds it knows against the SDK types, and hands every unknown `session/update` kind, every `_meta` field, and every non-standard method to the dialect. `@agentclientprotocol/sdk` is a type-only dev dependency for the schema types.

```ts
export interface AcpDialect {
  readonly features: ProviderFeatures;
  readonly authHint: string;                                   // Chinese login hint
  /** Called for every session/update the base translation did not consume, and for every _meta it saw. */
  sessionUpdate(state: DialectState, update: unknown): { state: DialectState; events: RunEvent[] };
  /** Agent-initiated requests the base protocol does not define (cursor/*, x.ai/*). Must return an answer or the turn hangs. */
  request(method: string, params: unknown): ProviderAnswer | undefined;
  notification?(method: string, params: unknown): RunEvent[];
  verdictFromStop(stop: AcpStopReason, meta: unknown): TurnVerdict;
  subagentCancel?(id: SubagentId): { method: string; params: unknown };
  launch(command: AcpCommand, plan: EnforcementPlan): { argv: string[]; env: Record<string, string> };
}
```

Base translation, shared by every dialect. `agent_message_chunk` and `agent_thought_chunk` become `text` (ACP:3053-3055). `tool_call` and `tool_call_update` become `step` with `StepDetail` from `kind`, `content`, and `locations` (ACP:3424-3450, `ToolKind` ACP:3571). `plan` becomes `todo` (ACP:2096, :2161). An `image` content block becomes `image` through the sink (ACP:689). `session_info_update.title` feeds titles (ACP:2880). `usage_update` feeds `context` when present (unstable, ACP:3648). `StopReason` maps as in Outcomes below (ACP:3216), and a value the table does not name is `failed{provider-error}` carrying the raw value. `session/request_permission` is answered by the runtime from the plan (see Auto-answered requests). The client advertises no `fs` and no `terminal` capability, so the agent cannot read files through the daemon.

Grok dialect. `subagent_spawned`, `subagent_progress`, `subagent_finished` become the roster, keyed by the child session id (GD `grok-subagents.ts:2-3`, `:15`; fixtures `s7-subagent-*.jsonl`). `_meta["x.ai/tool"].name` refines `StepDetail` (GD `grok-dialect.ts:12`, `:202`). `turn_completed.stop_reason` `error` and `rate_limit` become `failed` (GD `grok-dialect.ts:18`, `:37`, `:214`). `retry_state` becomes `notice{retry}` (`:25`). `_x.ai/subagent/cancel` is `subagentCancel` (GD `grok-subagent-stop.ts:15-21`). `x.ai/ask_user_question` and `_x.ai/exit_plan_mode` are refused (GD `grok-requests.ts:122`, `:128`). `authMethods` non-empty and `-32000` on `session/new` is `not-logged-in` with 已安装但未登录，请在这台机器上运行 grok login. `--always-approve` is passed only for `full` (Orca `acp-launch-specs.ts:100-103`). `todo` and `images` ship `none` with `pending: grok.three-turns` because the fixtures show a `todo_write` tool and `image_gen` tool but no `plan` update and no image result (audit rows 15, 16). A `todo_write` tool call is still dropped by translation and never becomes a `step`, so no todo update appears as a tool row. Grok's `compact` follows the slash-command rule of the Claude engine: it is `native` when `available_commands_update` declares a compact command, which probe `grok.three-turns` records, and `none` until then. The Grok test fixtures are recorded fresh from the installed `grok` with `scripts/record-fixture.mjs --provider grok`. Orca's MIT fixtures under `/home/ops/orca/src/main/acp/fixtures/` are evidence for this design only and are not copied.

Cursor dialect. CUR documents `cursor/task` as "Notify client about subagent task completion", a completion signal, not a start or step signal (fetched 2026-10-12). It can therefore give at most a `completed` roster row with its task and result, so the best `subagents` cell it can reach is `partial`, with no live rows and `subagentStop: none`. `cursor/update_todos` becomes `todo`, with `merge:true` merging into the tracker and `false` replacing (CUR, audit row 15). `cursor/generate_image` becomes `image` (CUR, audit row 16). Payload shapes for the three `cursor/*` notifications are not documented, so all three cells ship `none` with `pending: cursor.full-turn` and flip only when that probe records the payloads. `cursor/create_plan` and `cursor/ask_question` are answered at once, because CUR warns the tool hangs otherwise (see Auto-answered requests). `cursor/list_available_models` feeds `models`. `authenticate` with `methodId: "cursor_login"`; the failure hint is 已安装但未登录，请在这台机器上运行 cursor-agent login. Reasoning, context usage, titles, compact, and effort are `none` pending `cursor.initialize` and `cursor.full-turn` (audit rows 7, 19 to 22, 25, 27).

Custom ACP dialect. Base translation only. `features` are derived at `initialize` from `agentCapabilities` and `sessionCapabilities` (ACP:36, :2600). Only `full` is offered. The command comes from host settings `execution.customAcpCommand`, shaped `{ command: string; args: string[]; env?: Record<string, string> }`. An unset or invalid command is a refusal at open, not at bind.

### Codex engine

Re-homed from `agent/codex-appserver/`. `turn/start` with `approvalPolicy: 'never'` and the sandbox from the plan. `ThreadItem` kinds map to `StepDetail` by type (CX `v2/ThreadItem.ts:26-101`). `turn/plan/updated` becomes `todo` (CX `v2/TurnPlanUpdatedNotification.ts`). `imageGeneration`, `imageView`, MCP image results, and `dynamicToolCall` `inputImage` become `image` (audit row 16). Child threads are subagents. `collabAgentToolCall` with `spawnAgent` opens a roster entry, every `item/*` notification carrying a child `threadId` is a subagent-lane step, and `Thread.source.thread_spawn` identifies the parent (CX `v2/ThreadItem.ts:64-101`, `v2/SubAgentSource.ts`). `stopSubagent` sends `turn/interrupt` to the child thread's active turn, the way Orca does, and the cell is `partial` because there is no dedicated method (audit row 14). `thread/tokenUsage/updated` feeds `context`. `thread/compacted` and the `contextCompaction` item feed `compaction`. `thread/goal/*` is experimental and needs `experimentalApi: true` at `initialize` (`app-server-client.ts:155-161`); `goal` ships `native` as today. `thread/goal/set` and `thread/goal/clear` are `EngineGoal`; `thread/goal/updated` is the `goal` event with `ThreadGoal.timeUsedSeconds`, and every goal turn is its own `Run` (see *Goals*). `error.willRetry` becomes `notice{retry}` (CX `v2/ErrorNotification.ts`). `account/rateLimits/read` replaces the direct ChatGPT `wham` request for the usage card. `thread/name/set` and `Thread.name` are titles (audit row 27). `oneShot` is `native`: the ephemeral read-only utility thread with `outputSchema` that `main` uses for titles (VB:163-194), now serving `TitleService`. The warm pool, the managed install at 0.156.1, and `codex-install-lock.json` move unchanged.

### Claude engine

Replaces `agent/claude-agent/`. The engine spawns the CLI through `spawnClaudeCodeProcess` so the pid is owned by `ProcessHost` (SDK:2181). `includePartialMessages` is on. `stream_event` deltas become `text`. `tool_use` becomes `step` classified by tool name, which is Claude's native form (audit row 8). `TodoWrite`, `TaskCreate`, `TaskUpdate` inputs become `todo` and never a step (TOOLS:999, :2692, :2718). `TaskList` and `TaskGet` calls are dropped and never a step either. `task_started`, `task_progress`, `task_notification` drive the roster only when `task_type` is `local_agent` or `subagent_type` is set (SDK:4924-4945). Other task types, `local_bash` and `local_workflow`, never create a roster entry: a backgrounded Bash command already shows as its `Bash` step on the main lane, and its task frames are dropped. Frames with `parent_tool_use_id` are subagent-lane steps (SDK:5026). `stopSubagent` is `stopTask(taskId)` (SDK:2703). `tool_result` image blocks become `image` through the sink. `compact_boundary` becomes `compaction` (SDK:3187). `rate_limit_event` feeds the usage card (SDK:4610-4640). `api_retry` becomes `notice{retry}` (SDK:3071). Steer sends `streamInput` with `priority: 'next'` and ships `partial` with the note that it lands at the next model turn (SDK:5032, :2698). Compact is native. By the user's decision of 2026-10-12, an agent slash command counts as native when the agent declares it, and Claude declares `/compact` in `supportedCommands()` (SDK:2546). The engine sends that command as the prompt and reports `compaction` from `compact_boundary`, which is what `main` already does (`main:agent/claude-agent/thread.ts:560`, :568). `features.compact` is `native` when `supportedCommands()` lists `compact` at session start, and probe `claude.commands` records it. Titles are `renameSession` and `SDKSessionInfo.summary` (SDK:2739, :4736-4746). `oneShot` is `native`: `query` with `tools: []` and `maxTurns: 1` (see *Session titles*). `goal` is `none` pending `claude.goal-review` (audit row 18). `settingSources` is `['user']` so `~/.claude/settings.json` model routing for DeepSeek, Kimi, GLM, and Qwen reaches the child. The `@anthropic-ai/claude-agent-sdk` dependency moves to `dependencies` at exactly `0.3.246`.

### Pi engine

`pi --mode rpc` over `JsonlPeer`. `text_delta` and `thinking_delta` are `text`. `tool_execution_start/update/end` are `step` by tool name. `ToolResultMessage.content` `ImageContent` is `image` (PIA:421, :275). `compaction_start/end` is `compaction` (PIS:60, :72). `auto_retry_start/end` is `notice{retry}` (PIS:79-89). `agent_end.stopReason` maps as in Outcomes, and `willRetry: true` is not terminal (PIS:48-52, PIA:311). `steer` and `compact` are native RPCs (PIR:22, :74). `get_session_stats` feeds `context` (PIR:97). `set_session_name` is titles (PIR:128). `oneShot` is `none` with `pending: pi.no-tools-title` (see *Session titles*). `extension_ui_request` is cancelled (PIR:407-458). Subagents, todo, and goal are `none`.

### Process host

One `ProcessHost` for every engine, re-homed from `agent/codex-appserver/owned-process.ts` and `windows-job.ts`.

- `spawn()` starts a detached process group on POSIX or a Job Object on Windows and writes `{pid, startedAtMs, daemonBootId, providerId, sessionId}` to `<dataDir>/owned-pids.json` before returning.
- `adopt(child)` wraps the Claude SDK child so it is in the same ledger.
- Each owned process implements the runtime's `OwnedProcess` (*Engine and runtime*). The exit-report hold behind `watch()` is this section's rule. PR 5 of V6a revises the rest of this section.
- `sweepOrphans()` runs at daemon boot. A record whose `daemonBootId` differs, whose pid is alive, and whose start time matches is an orphan of a dead daemon and its tree is killed. A pid with a different start time is left alone.
- `owesWork()` answers `host/lifecycle` before a restart, replacing `unconfirmedCodexPids()`.

### Outbound

`outbound/policy.ts` is the single path decision shared by the Claude PreToolUse gate and the image and file uploaders. `judgePath(plan, op, path)` realpaths the path and requires containment in `readableRoots` or `writableRoots`. A symlink that leaves the root is denied. `Glob` patterns beginning with `/` or `~` or containing `..` are denied under `project`. `fetchRemoteImage(url, plan)` runs only when `plan.grant.network` is true, in every tier, `full` included. It resolves the host first, refuses loopback, private, link-local, `0.0.0.0`, `::ffff:` mapped, and `100.64/10` addresses, re-checks each redirect hop, and allows at most 3 redirects. This closes issue #114. `bot/outbound-files.ts:105-106` already does the realpath form and moves to the same function.

## Native capability matrix

The audit's 44 rows are authoritative. This table summarizes the rows the card and the commands depend on, with the native mechanism per cell. `probe:` marks a cell that ships `none` until the named live probe records the payload.

| Capability | Codex | Claude Code | Cursor | Grok | Pi | Custom ACP |
|---|---|---|---|---|---|---|
| Subagent start (row 12) | native `collabAgentToolCall` | native `task_started` (`local_agent` only) | none (pending cursor.full-turn); `cursor/task` is a completion signal | native `subagent_spawned` | none | none |
| Subagent steps (row 13) | native child-thread `item/*` | native `parent_tool_use_id`, `task_progress` | none (pending cursor.full-turn) | partial `subagent_progress` | none | none |
| Stop one subagent (row 14) | partial `turn/interrupt` on the child thread | native `stopTask()` | none | native `_x.ai/subagent/cancel` | none | none |
| Todo (row 15) | native `turn/plan/updated` | partial `TodoWrite`, `Task*` inputs | none (pending cursor.full-turn) | none, probe: grok.three-turns | none | partial ACP `plan` when sent |
| Image output (row 16) | native `imageGeneration`, `imageView`, MCP images | partial `tool_result` image blocks | none (pending cursor.full-turn) | none, probe: grok.three-turns | partial tool-result `ImageContent` | partial `image` content block |
| Turn outcome and reason (row 11) | native `TurnStatus` and `codexErrorInfo` | native `subtype`, `terminal_reason` | partial 5 ACP stop reasons | native ACP stop reasons plus `turn_completed.stop_reason` | native `StopReason` | partial 5 ACP stop reasons |
| Interrupt (row 10) | native `turn/interrupt` | native `interrupt()` | native `session/cancel` | native `session/cancel` | native `abort` | native `session/cancel` |
| Reasoning (row 7) | native `item/reasoning/*Delta` | native thinking delta | none, probe: cursor.full-turn | none, probe: grok.three-turns | native `thinking_delta` | partial `agent_thought_chunk` |
| Steer (row 9) | native `turn/steer` | partial `priority: next` | none | none, probe: grok.three-turns | native `steer` | none |
| Manual compact (row 19) | native `thread/compact/start` | native, declared `/compact` in `supportedCommands()` | none, probe: cursor.full-turn | none until `available_commands_update` declares it, probe: grok.three-turns | native `compact` | none |
| Compaction notice (row 20) | native `thread/compacted` | native `compact_boundary` | none, probe: cursor.full-turn | none, probe: grok.three-turns | native `compaction_start/end` | none |
| Context usage (row 21) | native `thread/tokenUsage/updated` | native `getContextUsage()` | none, probe: cursor.full-turn | partial window size only | native `get_session_stats` | partial `usage_update` when sent |
| Account usage (row 23) | native `account/rateLimits/read` | partial `rate_limit_event` | none | partial `rate_limit` stop reason | none | none |
| Goal (row 18) | native `thread/goal/*` (experimental API) | none, probe: claude.goal-review | none | none | none | none |
| History (rows 4, 5) | native `thread/list`, `thread/read` | native `listSessions()`, `getSessionMessages()` | partial `session/load` replay, list probe: cursor.initialize | native `session/list`, `session/load` | partial session files, `get_messages` | partial by `sessionCapabilities` |
| Native titles (row 27) | partial read and set | native read and set | none, probe: cursor.full-turn | partial read | partial read and set | partial read only |
| Tool-less one-shot (`oneShot`) | native utility thread with `outputSchema` | native `query`, `tools: []`, `maxTurns: 1` | none | none | none, probe: pi.no-tools-title | none |
| Models and effort (rows 24, 25) | native `model/list`, `effort` | native `supportedModels()`, `effort` | native `cursor/list_available_models`; effort probe: cursor.full-turn | native `x.ai/models/list`; effort set probe: grok.three-turns | native `get_available_models`, `set_thinking_level` | partial `configOptions` |
| Retry notice (row 41) | native `error.willRetry` | native `api_retry` | none, probe: cursor.full-turn | native `retry_state` | native `auto_retry_*` | none |
| Image input (row 17) | native `image`, `localImage` | native image block | none, probe: cursor.initialize | none (1.0.46 declares false) | native `prompt.images` | partial `promptCapabilities.image` |

Every audit row has a decision.

- Row 1, new session. Included. `open` without `resume`.
- Row 2, resume. Included. `open` with `resume`; a failed resume starts a new session with `notice{resume-failed}`.
- Row 3, fork. Deferred. No Vonvon command forks a topic, and adding one is a new product feature, not part of this redesign.
- Rows 4 and 5, history list and content. Included as `features.history` for the history browser.
- Row 6, answer deltas. Included as `text` on the `answer` channel.
- Row 7, reasoning deltas. Included as `text` on the `reasoning` channel, shown in the reasoning area of the card.
- Row 8, structured tool calls. Included as `step` with `StepDetail`.
- Row 9, steer. Included as `features.steer`. Without it the bot queues the message (see *Follow-ups during a run*).
- Rows 10 and 11, interrupt and outcome. Included as baseline.
- Rows 12 to 14, subagents. Included as baseline, with the Cursor cells pending as above.
- Row 15, todo. Included as baseline.
- Row 16, image output. Included as baseline.
- Row 17, image input. Included as `features.imageInput`. Images in a Feishu message reach the provider only where the cell is not `none`.
- Row 18, goal. Included where native, which today is Codex only.
- Row 19, manual compact. Included where native, Claude through its declared `/compact` and Grok once `available_commands_update` declares one.
- Row 20, compaction notice. Included as `compaction`, shown as one marker row in the process area.
- Row 21, context usage. Included as `context`, shown in the existing context gauge.
- Row 22, per-turn tokens. Included as `outcome.usage`.
- Row 23, account usage. Included as `features.usage` for the usage card.
- Rows 24 and 25, models and effort. Included as `features.models` and `features.effort` for the model card.
- Row 26, runtime mode switch. Excluded. The tier is fixed at `open` from the enforcement plan, and a mid-session switch would bypass the cell. A tier change in settings applies from the next `open`.
- Row 27, titles. Included as the provider's native read and set. Generation is Vonvon's `TitleService` (see *Session titles*), not a provider capability.
- Row 28, MCP configuration. Excluded as a Vonvon setting. Under `full` every provider loads the user's own MCP servers as it does today. Under Claude `qa` and `write`, `strictMcpConfig: true` with no servers loads none, because an MCP server runs outside the Bash sandbox and the path gate cannot see its file access. When the user has MCP servers configured in `~/.claude.json` or `<root>/.mcp.json`, the card shows `notice{mcp-off}` with 此档位已停用你配置的 MCP 服务器，完全访问下可用。 This loss is accepted (see *Tradeoffs accepted*). Codex keeps its `config.toml` servers in every tier, as `main` does.
- Row 29, slash commands and skills. Included only as the source of native `compact` (Claude `supportedCommands()`, Grok `available_commands_update`). A general provider command menu is deferred. A message starting with `/` that the bot does not own is sent to the provider as text, as today.
- Row 30, rewind and checkpoints. Deferred. The card has no control to pick a point, and file rewind exists only for Claude.
- Row 31, review mode. Deferred. Only Codex has it; a later `features.review` cell can add a `/review` command without a contract change elsewhere.
- Row 32, background tasks. Excluded as a feature. Claude `local_bash` tasks show as their `Bash` step, and background subagents end with the run (see *Engine and runtime*).
- Row 33, web search. Included as `step` with `search` detail and `tool: 'web'`. Claude `qa` and `write` allow `WebFetch` and `WebSearch` only when the network switch is on.
- Rows 34 to 36, read, write, and network limits. Included as the enforcement matrix.
- Row 37, approval requests. Included as automatic answers; no approval card exists.
- Row 38, login detection. Included as `InstallProbe.auth` and the `not-logged-in` hint.
- Row 39, developer instructions. Included where native. The content of `agent/bridge-instructions.ts` (Feishu formatting and image output) goes to Codex `developerInstructions`, Claude `systemPrompt` append, and Pi `--append-system-prompt`. Cursor and custom ACP have no field and Grok's is unknown, so they get none, and their answers may use Markdown the card renders imperfectly and may not know the `![](path)` image convention. The text is not prepended to the user's prompt.
- Row 40, questions to the user. Excluded as a feature. The daemon declines every question at once, never picks an option, and the card shows one notice line. See Auto-answered requests.
- Row 41, retry status. Included as `notice{retry}` with the text 正在重试（第 N 次）. One line per retry, collapsed into the latest.
- Row 42, whole-turn diff. Deferred. Only Codex has it, the card already shows each `edit` step with its diff, and a whole-turn diff can exceed the card budget on its own.
- Row 43, structured output. Excluded from the run contract. Codex `oneShot` uses `outputSchema` internally for titles, which is not a run feature.
- Row 44, hooks. Excluded. User hooks belong to the user; the daemon neither configures nor renders them. Codex `hook/*` and Grok `hook_execution` frames are dropped by translation.

## Outcome mapping

Every provider verdict maps to one `Outcome`. ACP `refusal`, `max_tokens`, and `max_turn_requests` are distinct failures, not completions, which fixes the Paseo floor that merged them (audit, Paseo section item 3).

| Provider signal | Outcome |
|---|---|
| Codex `TurnStatus` completed (CX `v2/TurnStatus.ts`) | completed |
| Codex `interrupted` after our `turn/interrupt` | interrupted{user or watchdog or daemon} |
| Codex `interrupted` without our request | interrupted{agent} |
| Codex `failed` with `codexErrorInfo` contextWindowExceeded, usageLimitExceeded, unauthorized, serverOverloaded, other (CX `v2/CodexErrorInfo.ts`) | failed limit{context-window}, limit{usage-limit}, auth, provider-error, provider-error |
| Claude `subtype` success (SDK:4643-4700) | completed |
| Claude `error_max_turns` | failed limit{max-turns} |
| Claude `terminal_reason` prompt_too_long | failed limit{context-window} |
| Claude `terminal_reason` blocking_limit | failed limit{context-window}. Inferred from the name, not verified; a recording that shows otherwise changes this row |
| Claude `terminal_reason` aborted_streaming or aborted_tools after our `interrupt()` | interrupted{by} |
| Claude any other `terminal_reason` with `is_error` | failed provider-error{the raw value} |
| Claude `stop_reason` refusal | failed refused |
| Claude other `is_error` | failed provider-error{message} |
| ACP `end_turn` (ACP:3216) | completed |
| ACP `refusal`, `max_tokens`, `max_turn_requests` | failed refused, limit{max-tokens}, limit{max-turns} |
| ACP `cancelled` after our `session/cancel` | interrupted{by} |
| ACP `stopReason` not named in this table | failed provider-error{the raw value} |
| ACP `cancelled` without our request | interrupted{agent} |
| ACP JSON-RPC error on `session/prompt`, `-32000` | failed provider-error, failed auth |
| Grok `turn_completed.stop_reason` error, rate_limit | failed provider-error, limit{rate-limit} |
| Pi `StopReason` stop, toolUse (PIA:311) | completed |
| Pi `length`, `error`, `aborted` | failed limit{max-tokens}, failed provider-error, interrupted |
| Pi `agent_end.willRetry: true` | not terminal; `notice{retry}` |
| Any provider exit before a verdict, as an exit fact of *Process host* | failed process-exit, or interrupted{by, tree: exited} when a stop was in flight |
| Provider stream closed with no exit fact (`transport-lost`) | in opening or running, failed transport-lost; in stopping, nothing, the ladder continues |
| No verdict and no exit fact when the `kill` rung's deadline passes | interrupted{by, tree: unconfirmed}; ProcessHost keeps the tree |

## Permission enforcement matrix

Rules that apply to every cell.

1. `full` has no read scope and reads anywhere. `qa` and `write` carry a read scope. A new project defaults to `project`. A project stored before V6b loads as `unrestricted`, by the user's decision of 2026-10-12, through the load-time migration in `plan.md` V6b *Stored data*.
2. `project` means no reads of user data outside `root`. System paths needed to run commands stay readable. This is the line Codex `:minimal` draws.
3. A cell is `enforced` only with a `Proof`, under the two `doc` cases of *Data types*: an unrestricted `full` cell, and a `launch-args` cell. Every other enforced cell needs a `live` proof. Unproven cells ship `refuse` and flip by one commit when the probe lands. `auditTable` fails the build otherwise. Nothing in this document was live-verified on the design host; `codex`, `cursor-agent`, `grok`, `bwrap`, and `sandbox-exec` are absent there.
4. A refusal spawns nothing. The bot posts the Chinese message in the group. The hint that names the setting goes to admins only.
5. The engine checks what it can observe and refuses with `sandbox-not-confirmed` otherwise. Codex. The generated 0.156.1 `ThreadStartResponse` has no `activePermissionProfile` field; its fields are `model`, `modelProvider`, `serviceTier`, `cwd`, `instructionSources`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, and `reasoningEffort`, and only a doc comment names `activePermissionProfile` (CX `v2/ThreadStartResponse.ts`). For profile cells the engine parses the raw `thread/start` response at the boundary, under `experimentalApi: true`, requires `activePermissionProfile.id === 'feishu'`, and kills the process and refuses when the field is absent or differs. Claude. Before spawn, the engine calls `resolveSettings` with the same options it will pass to `query` (SDK:2774-2795). It refuses when a required lock of *Claude Code* is missing from `effective`, or when `sources` shows a policy tier Vonvon did not supply, because such a tier drops `managedSettings` by default (SDK:2005-2027). `resolveSettings` reports the settings cascade without spawning the CLI; it does not show that the sandbox took effect. The sandbox is held by `failIfUnavailable: true`, which errors the turn instead of running unsandboxed, and by the live probes of each cell.
6. Guests are clamped to the project's guest tier and cannot change read scope or network.

### Codex

The `feishu` permission profile is `permissions.feishu.filesystem {':minimal': 'read', ':workspace_roots': {'.': 'read' | 'write'}}` with `network.enabled` (VB:28-100). macOS Seatbelt enforcement was verified (VB:38-39). Windows is unverified (VB:40-41). Linux Landlock does not confine reads (VB:43-48). `SandboxPolicy.readOnly` carries `networkAccess` (CX `v2/SandboxPolicy.ts`), so read-only does not imply offline.

| tier | reads | macOS | Linux | Windows |
|---|---|---|---|---|
| full | - | `danger-full-access`, no mechanism. unrestricted doc proof (CX `v2/SandboxMode.ts`) | same | same |
| qa | project | profile `feishu`, root `read`. live `codex.profile.read-denied` | refuse `read-scope-unenforceable` | profile as macOS plus `windowsSandbox/readiness` `ready`. live `codex.profile.read-denied` on win32, else refuse `unverified-combination` |
| qa | unrestricted | thread `sandbox: 'read-only'`, turn `sandboxPolicy {type:'readOnly', networkAccess: network}`. live `codex.readonly.write-denied` | same. live on linux in V6b | same plus readiness. live on win32 |
| write | project | profile `feishu`, root `write`, `network.enabled` = network. live `codex.profile.write-scope` | refuse `read-scope-unenforceable` | profile plus readiness. live on win32 |
| write | unrestricted | thread `sandbox: 'workspace-write'`, turn `sandboxPolicy {type:'workspaceWrite', writableRoots: [root], networkAccess: network, excludeSlashTmp: true, excludeTmpdirEnvVar: true}`. live `codex.workspace-write.scope` | same. live on linux in V6b | same plus readiness. live on win32 |

Temporary directories. `workspaceWrite` makes `/tmp` and `$TMPDIR` writable unless `excludeSlashTmp` and `excludeTmpdirEnvVar` are set (CX `v2/SandboxPolicy.ts`). Vonvon sets both, so `write` means writes inside the project only. "Outside" in probe `codex.workspace-write.scope` and in V7c lane 8 means a path outside `root`, `/tmp`, and `$TMPDIR`, and all three must be denied. A tool that needs a temporary directory must use one inside the project; the probe records whether `npm install` and `git commit` still work, and the PR reports it.

### Claude Code

Three layers, because no single one covers everything. The sandbox covers Bash only (audit row 34). `Read`, `Grep`, `Glob`, `Edit`, `Write`, and `NotebookEdit` are confined by the daemon's `PreToolUse` gate, which returns an explicit `allow` or `deny` for every call from `judgePath` (SDK:2380-2390). `canUseTool` denies anything the hook did not allow, so a tool never prompts (SDK:1431). Hooks fire inside subagents with `agent_id` set (SDK:179-181); probe `claude.subagent-gate` proves it.

Permission mode. Every gated cell passes `permissionMode: 'default'` explicitly (SDK:1810, `PermissionMode` :2220), so a `defaultMode` in the user's `~/.claude/settings.json` does not apply. Under `default`, a file tool runs only when the hook returns `allow`, sandboxed Bash runs through `autoAllowBashIfSandboxed`, and any other call reaches `canUseTool` and is denied. Every `full` cell passes `permissionMode: 'bypassPermissions'` with `allowDangerouslySkipPermissions: true` (SDK:1822), as `main` does (`main:agent/claude-agent/permission.ts:55-57`). The existing probes `claude.hook-under-lock` and `claude.subagent-gate` run under `permissionMode: 'default'` and record that the hook fires for the main agent and inside a subagent; a cell flips only with both recorded.

1. Allowlist. `tools` is set explicitly per tier, never `'default'` (SDK:1482). qa is `Read, Grep, Glob, TodoWrite, TaskCreate, TaskUpdate, TaskList, TaskGet, Agent`, plus `WebFetch, WebSearch` when network is on, plus `Bash` only when the host has a command sandbox. write adds `Edit, Write, NotebookEdit`. full is the SDK default. `AskUserQuestion`, `EnterPlanMode`, and `ExitPlanMode` are in `disallowedTools` for every tier (SDK:1446).
2. Gate. The hook realpaths every path argument and compares it with the plan's roots. Under `project`, `denyRead` of home directories and mounted volumes is also written into `sandbox.filesystem` so Bash cannot read them (SDK:2914-2920). Whether `allowRead` of the root overrides a `denyRead` parent is probe `claude.sandbox.allowread-override`.
3. Command sandbox for Bash, only when `commandSandbox` is `seatbelt` or `bwrap`. `Options.sandbox` is `{enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem, network}` (SDK:1985), the path `main` verified by spikes (`main:agent/claude-agent/permission.ts:9-20`, :59-65). qa sets `filesystem.denyWrite: [root]`. write sets `filesystem.allowWrite: [root]`. Network off sets `network: {allowedDomains: [], strictAllowlist: true}`, best effort for Bash. With no command sandbox, `sandbox` is `null` and `Bash` is not in `tools`.

Locks. `managedSettings` carries only restrictive keys, which survive its restrictive-only filter: `allowManagedPermissionRulesOnly: true`, `allowManagedMcpServersOnly: true`, and `permissions.deny` for the tools a tier excludes (SDK:2005-2027, :2818-2824). Nothing that widens behavior goes there. `settingSources` is `['user']` (SDK:2038). `strictMcpConfig: true` with no servers for qa and write (SDK:2087), with `notice{mcp-off}` as in row 28 above. `allowManagedHooksOnly` is not set because it may disable our hook; probe `claude.hook-under-lock` checks. Probe `claude.managed-settings-keys` records which of these keys `resolveSettings` reports in `effective` with no foreign policy tier present, and a cell flips only with it recorded.

| tier | reads | macOS | Linux | Windows |
|---|---|---|---|---|
| full | - | `bypassPermissions`, no mechanism. unrestricted doc proof (SDK:1822) | same | same |
| qa | project | allowlist, gate, Bash under Seatbelt with `denyWrite` and the read deny set. live `claude.qa.project` | same with bwrap, else Bash off with notice. live `claude.qa.project` on linux | allowlist, gate, Bash off with notice. live on win32 |
| qa | unrestricted | allowlist, gate for writes only, Bash under Seatbelt `denyWrite`. live `claude.qa.unrestricted` | bwrap, else Bash off | Bash off |
| write | project | qa set plus write tools, gate on both roots, Bash `allowWrite: [root]` plus read deny set. live `claude.write.project` | bwrap, else Bash off | Bash off |
| write | unrestricted | gate writes to root, Bash `allowWrite: [root]`. live `claude.write.unrestricted` | bwrap, else Bash off | Bash off |

Bash off is a capability loss, not a confinement loss, and the user decided on 2026-10-12 that it runs rather than refuses. On a host without a command sandbox (native Windows, Linux without bwrap), `qa` and `write` start with `Bash` absent from `tools`, the file tools stay confined by the `PreToolUse` gate, and the card carries `notice{bash-off}` 此机器没有命令沙箱，已关闭 Bash。可读写项目文件，不能运行命令。

### ACP agents and Pi

ACP agents and Pi have no sandbox. The daemon answers `session/request_permission` from the plan, which holds only if the agent asks before acting. Grok asks before edits and executes when launched without `--always-approve`; this is unproven until `grok.qa-gate` runs. Cursor's ask and plan modes are agent conventions, not isolation (audit row 35).

| provider | tier | reads | all OS |
|---|---|---|---|
| grok | full | - | `--always-approve`, `bypass: true`, no mechanism. unrestricted doc proof (Orca `acp-launch-specs.ts:100-103`) |
| grok | qa | unrestricted | no `--always-approve`; gate rejects edit, delete, move, execute, other. refuse `tier-unenforceable` until live `grok.qa-gate` |
| grok | qa, write | project, and write any | refuse `read-scope-unenforceable`, `tier-unenforceable` |
| cursor | full | - | `cursor-agent acp`, answer allow, `bypass: true`, no mechanism. unrestricted doc proof (ACP `session/request_permission`) |
| cursor | qa, write | any | refuse `tier-unenforceable` until live `cursor.acp-permissions` records what the agent asks for |
| custom-acp | full | - | answer allow, `bypass: true`, no mechanism. unrestricted doc proof (ACP `session/request_permission`) |
| custom-acp | qa, write | any | refuse `tier-unenforceable` |
| pi | full | - | default tools, `tools` absent, no mechanism. unrestricted doc proof (`pi --help`) |
| pi | qa | unrestricted | `--tools read,grep,find,ls --no-extensions` (`pi --help`). doc proof, launch-args |
| pi | qa | project | refuse `read-scope-unenforceable` |
| pi | write | any | refuse `tier-unenforceable` |

### Refusal messages

Stored once in `provider/policy/messages.zh.ts`, keyed by reason. `{名称}` is the provider display name.

| reason | message |
|---|---|
| read-scope-unenforceable | 此项目设置为「仅读取项目目录」，但 {名称} 在这台机器上无法限制读取范围，已拒绝启动。管理员可在私聊的项目设置卡或网页的项目设置里改为「不限读取」，或改用 Claude Code。 |
| tier-unenforceable | {名称} 没有自己的沙箱，暂时只支持「完全访问」。请把此项目改为完全访问，或改用 Claude Code / Codex。 |
| sandbox-dependency-missing | 这台机器缺少 {依赖}，{名称} 的沙箱无法启动，已拒绝运行。请安装后重试。 |
| unverified-combination | {名称} 在 {系统} 上的「{档位}」尚未经过实机验证，已拒绝运行，没有降级。 |
| windows-sandbox-not-ready | Codex 的 Windows 沙箱尚未就绪（{状态}）。请在这台机器上完成 Codex 沙箱设置后重试。 |
| sandbox-not-confirmed | {名称} 启动后未确认沙箱设置已生效，已结束进程并拒绝本次运行。 |
| provider-not-installed | 未检测到 {名称}。{安装提示} |
| not-logged-in | {名称} 已安装但未登录，请在这台机器上运行 {登录命令}。 |
| custom-command-unset | 还没有设置自定义 ACP 命令。请在主机设置的「执行」里填写命令。 |
| custom-command-invalid | 自定义 ACP 命令无法执行：{原因}。 |

### Auto-answered requests

No approval cards exist. Every provider request is answered at once from the plan, and the card never waits. A question to the user is always declined; the daemon never picks an option on the user's behalf. Every `notice{question-declined}` carries the same text, agent 想向你提问。Vonvon 不支持在飞书里回答提问，已拒绝这个问题，agent 会自行继续或结束本轮。

| provider | request | answer |
|---|---|---|
| Codex | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` (CX `ServerRequest.ts`) | never reached under `approvalPolicy: 'never'`; declined if seen |
| Codex | `execCommandApproval`, `applyPatchApproval` (legacy approvals) | declined |
| Codex | `item/tool/requestUserInput`, `mcpServer/elicitation/request` | cancelled; `notice{question-declined}` |
| Codex | `item/tool/call` | JSON-RPC error; Vonvon registers no dynamic tools |
| Codex | `account/chatgptAuthTokens/refresh`, `attestation/generate` | JSON-RPC error; Vonvon manages no ChatGPT tokens and no attestation, so Codex uses its own login |
| Claude | `canUseTool` | deny unless the hook allowed; `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` disallowed |
| Claude | `onUserDialog` (SDK:1607) | cancel; `notice{question-declined}` |
| ACP | `session/request_permission` | `full`: allow_once, or allow_always when no once option. `qa`: allow for kind read, search, think, fetch when network on; reject otherwise. Never pending |
| ACP | `session/elicitation` (unstable) | cancel; `notice{question-declined}` |
| Grok | `x.ai/ask_user_question`, `_x.ai/exit_plan_mode` | refuse; `notice{question-declined}` |
| Cursor | `cursor/ask_question` | the payload's cancel or skip value when probe `cursor.full-turn` records that the schema has one, else a JSON-RPC error; never an option; `notice{question-declined}` |
| Cursor | `cursor/create_plan` | reject; `notice{other}` 不支持计划模式 |
| Pi | `extension_ui_request` (PIR:407-458) | cancel; `notice{question-declined}` |

## Feishu run card

The card has these areas, top to bottom. All strings are Chinese. Each area has a component and a byte allocation, and the allocations add up to the whole-card limits of 170 components and 28,000 bytes. Components count as `fileComponentCount` counts them today, a collapsible panel as 3 (`main:card/inline-files.ts`). Bytes are the UTF-8 bytes of the area's serialized elements.

| # | Area | What renders there | Components | Bytes | Over budget |
|---|---|---|---|---|---|
| 1 | Frame | Header, the stop button, and the existing context gauge fed by `context` | 3 | 300 | Fixed size |
| 2 | Progress line | Shown iff the run has a todo. `进度 3/7 · 正在改接口`, and a collapsible checklist with ☐, ◐, ☑ per item. No todo tool row ever exists | 4 | 3,000 | The checklist lists the in-progress item, then pending items in order, then completed ones, each cut at 80 chars, and ends with 另有 N 项 when the next item would not fit |
| 3 | Notices | One markdown element, at most 4 lines: `notice` events (retry, Bash-off, MCP-off, question-declined, resume-failed, image cap) and `provider-message` lines | 1 | 800 | One line per notice kind, the latest of each; the oldest kind drops first |
| 4 | Reasoning | One collapsed panel with the latest `reasoning` text, above the process area as today (`main:card/run-process.ts:10`) | 2 | 1,500 | Keeps the tail, with … at the head |
| 5 | Process | Main-lane steps as today, a screenshot collapsed under its step, and one marker row per `compaction` at its position, 上下文已自动压缩 or 上下文已手动压缩. A step still `running` at `outcome` renders as 已停止 | 113 | 10,000 | The existing `buildProcessBody` order, rich then compact (`main:card/run-process.ts:21-30`). Before any step folds, screenshots become the text 截图已省略. Compaction markers never drop |
| 6 | 子 agent | Shown iff the roster is non-empty. At most 6 running rows and 3 completed rows, then 另有 N 个已完成 | 30 | 5,000 | Completed rows' panels drop first, then each running row keeps only its current step; the 查看完整过程 and 停止 buttons always stay |
| 7 | Answer text | Markdown of the main-lane answer | 4 | 6,000 | Unused components and bytes of areas 2 to 6 pass to the answer first. Beyond that the text is cut at a paragraph boundary and ends with ……（回答过长，已截断） |
| 8 | Answer images | Generated or requested images, expanded after the text | 12 | 1,200 | At most 12 per run; later ones are counted in `notice{image-cap}` |
| 9 | Outcome note | One line, absent for `completed` | 1 | 200 | Fixed size |
| | Total | | 170 | 28,000 | |

`goal` events update the separate goal card (`card/goal-card.ts`), not the run card.

A 子 agent row shows a status icon, the task, `N 步`, elapsed time, and the current step. Its collapsible panel holds the last 5 steps and the result. In the panel, a 查看完整过程 button posts a separate card with the ledger history, up to 200 steps. A running row's panel also has a 停止 button iff `features.subagentStop !== 'none'`; it calls `Run.stopSubagent(id)`. A row settled `interrupted` reads 已停止 when the provider has a per-subagent stop, and 已随主任务中断 when it does not, because the row is roster state and no one addressed that child; whether its process ended is the main outcome's `tree` fact, and with `tree: 'unconfirmed'` the row adds 进程尚未确认退出.

A worst-case fixture, 6 running plus 3 completed subagents at every cap, 50 todo items, 40 tool rows, 2 compaction markers, 4 notice kinds, a 1,500-byte reasoning text, a 10,000-byte answer, 12 images, and every string at its cap, must render under both whole-card limits and under each area's allocation after the pass-through rule. Over-budget content is cut by the rule of its area and marked, never silently.

Outcome notes.

| outcome | note |
|---|---|
| interrupted user, tree live | ⏹ 已停止 |
| interrupted user, tree signalled | ⏹ 已强制停止（agent 未响应，已向其进程组发出结束信号） |
| interrupted user, tree exited | ⏹ 已强制停止（agent 未响应，其进程已退出） |
| interrupted user, tree unconfirmed | ⏹ 已强制停止（agent 未响应，进程尚未确认退出，Vonvon 会继续清理） |
| interrupted watchdog, tree live | ⏱ 超过 N 分钟没有任何进展，已自动停止 |
| interrupted watchdog, tree signalled | ⏱ 超过 N 分钟没有任何进展，已自动停止（agent 未响应，已向其进程组发出结束信号） |
| interrupted watchdog, tree exited | ⏱ 超过 N 分钟没有任何进展，已自动停止（agent 未响应，其进程已退出） |
| interrupted watchdog, tree unconfirmed | ⏱ 超过 N 分钟没有任何进展，已自动停止（agent 未响应，进程尚未确认退出，Vonvon 会继续清理） |
| interrupted daemon | ⏹ Vonvon 正在停止或重启，本轮已中断 |
| interrupted agent | ⏹ agent 自行中断了本轮 |
| failed transport-lost | ⚠ 与 agent 进程的连接中断，本轮未完成。下一条消息会自动恢复会话 |
| failed limit max-tokens | ⚠ 输出达到长度上限，回答可能不完整 |
| failed limit max-turns | ⚠ 达到单轮步数上限 |
| failed limit context-window, provider has compact | ⚠ 上下文已满，请发送 /compact 或开启新话题 |
| failed limit context-window, no compact | ⚠ 上下文已满，请开启新话题 |
| failed limit rate-limit | ⚠ 触发速率限制，请稍后再试 |
| failed limit usage-limit | ⚠ 账户额度已用完 |
| failed refused | ⚠ 模型拒绝了这个请求 |
| failed auth | ⚠ {hint} |
| failed provider-error | ⚠ agent 出错：{message} |
| failed process-exit | ⚠ agent 进程意外退出：{原因}。下一条消息会自动恢复会话 |
| notice resume-failed | 之前的会话无法恢复，已开始新会话 |

## Synthesis decision

Base. Candidate D (the Opus base). Its runtime-owned turn machine, `Grant`, `RunEvent` with lanes, `StepDetail` adapted from Paseo's `ToolCallDetail`, `ProcessHost` with the pid ledger, `AcpDialect` hooks, and the seven-PR delivery (V6a to V6d, V7a to V7c) are the spine. The cross-judge verdict ranked D first and required three fixes, all applied here. The ACP client is tolerant of unknown `session/update` kinds. The Claude section states that the sandbox covers Bash only and that the gate confines the file tools. ACP `refusal`, `max_tokens`, and `max_turn_requests` are distinct failures.

Grafts, by source.

- From A (Sonnet). The typed `EnforcementTable` whose `enforced` cells carry a `Proof`, with `auditTable` as a build test. `doc` proofs are allowed only for `launch-args` cells and, since issue #119, for unrestricted `full` cells, which claim no confinement. This replaces D's string `VERIFIED` record. A single path gate shared by the Claude hook and the outbound uploader. The orphan sweep at daemon boot keyed on pid plus start time. A's own tolerant ACP client idea, written here as a thin client over `JsonRpcPeer`.
- From B (Fable). Time-bounded stop ladder with the bound stated per engine. `SubagentLedger` caps (64 agents, 5 recent, 200 history, 600-char result) and the worst-case card budget test. `as const satisfies Record<ProviderId, Registration>` on the registry. `partial` as a third support value and the `pending` probe record for unknown cells.
- From C (Haiku). Pure `translate(state, frame)` per engine tested against recorded fixtures, and `stepTurn` as the unit-test target with a fake clock. The `channel` field folding reasoning into `text`.

Rejected.

- A's thirteen-PR plan and its Claude gap between cut-over and the Claude driver. Seven PRs keep the Claude engine in the same PR as the cut-over.
- A's and C's claim that Codex `read-only` disables network. `SandboxPolicy.readOnly` has `networkAccess`.
- B's `SubagentSupport = 'full' | 'roster' | 'none'`. Two cells, `subagents` and `subagentStop`, say the same thing with the common `Support` type.
- C's `full_with_project_scope` refusal. `full` carries no read scope, so the combination cannot be stored.
- C's dev switch `VONVON_PROVIDER_RUNTIME` and parallel runtimes. The cut-over is one PR.
- D's Cursor `subagents: no` as a final answer. CUR documents `cursor/task` as a completion notification, so the cell can reach `partial`, completed rows only, after probe `cursor.full-turn` records the payload. It ships `none` until then.
- Orca's lease and fence, SQLite journal, recovery capsule, and supervisor script. One daemon per machine has no second writer to fence.
- Any emulation. The prompt-loop goal is deleted, not ported. Claude `/compact` is kept because Claude declares the command, which makes it native (decided 2026-10-12). Session titles stay as a Vonvon-owned feature, not as an emulated provider capability (see *Session titles*).

Verdict items on the audit that this design fixes. D marked Grok todo as native; the fixtures show no `plan` update, so it is `none` pending `grok.three-turns`. D had no per-subagent stop for Claude; `stopTask` is native. D's Codex child-thread handling named `collabAgentToolCall` only; child `item/*` notifications are the step stream.

## Tradeoffs accepted

- Unproven cells refuse. On a fresh host most `qa` and `write` cells refuse until the probes land in V6d and V7c. The cost is a one-tap setting change; the alternative is a tier that is promised and not kept.
- Claude Bash is off where the host has no command sandbox. Reads and writes stay confined. The run starts with a notice instead of refusing (decided 2026-10-12).
- Codex `qa` and `write` with `project` reads refuse on Linux. There is no mechanism to confine reads there.
- Claude `qa` and `write` load no MCP server. The user's servers work under `full` only, and the card says so with `notice{mcp-off}`.
- Cursor, Grok, and custom ACP get no Vonvon instructions, because they have no native instruction field (audit row 39).
- Codex `write` with unrestricted reads cannot write `/tmp` or `$TMPDIR`. Tools that need a temporary directory must use one inside the project.
- Cursor and Grok ship most extras as `none` pending probes that need user-supplied accounts.
- One PR for the consumer cut-over touches 39 source files and maps 72 test files. Splitting it would mean two live contracts.
- From V6b until V6d merges, existing Claude `qa` and `write` projects refuse with `unverified-combination`. They ran under the Bash sandbox on `main`.

## Alternatives considered

- Keep `AgentBackend` and add fields. The optional capability shape is the problem; a new field would be optional too.
- Copy Paseo's provider closure, the V6 and V7 of 2026-10-11. About 40,000 lines Vonvon would own but did not write, a type-edit ledger to compile them, and Paseo's merged ACP outcomes as the floor.
- A Vonvon-owned OS sandbox launcher (Seatbelt, bwrap) around Pi, Grok, and Cursor to turn their refusals into enforced cells. The largest single extension; out of scope here and recorded as future work.
- Approval cards in Feishu. Excluded by the user.

## Decisions and open questions

The user decided these on 2026-10-12. They are design, not defaults.

1. Read scope at upgrade. New projects default to `project`. A stored project without the field loads as `unrestricted`, through the explicit load-time migration in `plan.md` V6b *Stored data*, so no running project starts refusing after the upgrade.
2. Claude on a host without a command sandbox. `qa` and `write` run with Bash off and `notice{bash-off}`. File tools stay confined by the `PreToolUse` gate.
3. Agent-native slash commands. A slash command counts as native when the agent declares it. Claude declares `/compact` in `supportedCommands()`, so Claude compact is native. Grok compact follows the same rule through `available_commands_update`, pending probe `grok.three-turns`.
4. Session titles. Vonvon generates titles for every provider as its own feature (see *Session titles*).

Open, each with the default this design assumes.

1. Vendor HTTP account usage for Cursor and Grok, as Orca does. Not in the agent protocol and undocumented. Default here: excluded; the usage card says 该 provider 不提供用量.
2. Live lanes for Cursor and Grok need a Cursor account and a SuperGrok account on the Mac. Until provided, those lanes are recorded as not run and the cells stay `none` or `refuse`.

Risks.

- `allowRead` may not override a `denyRead` parent in the Claude sandbox. If probe `claude.sandbox.allowread-override` fails, `project` reads with Bash refuse and Bash stays off under `project`.
- The `PreToolUse` hook may be disabled by a future `allowManagedHooksOnly` default. Probe `claude.hook-under-lock` guards it.
- Cursor `cursor/*` payloads are undocumented. The dialect is written against the probe recording, not the docs.
- Windows: the Codex restricted-token sandbox and the Job Object helper are unverified until a Windows host runs V7c.

## Next implementation step

V6a in `plan.md`. Pure types, `stepTurn`, the ledgers, the enforcement table with `auditTable`, the path gate, `ProcessHost`, the two transports, and the outbound fix for issue #114. No consumer changes beyond the uploaders.
