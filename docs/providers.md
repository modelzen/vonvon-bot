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
export type TreeFate = 'live' | 'signalled' | 'exited' | 'unconfirmed';   // read at settlement; see *Engine and runtime*
/** Why the host has not confirmed an ending: a diagnostic on its snapshot for doctor and the log; admission never reads it. See *Process host*. */
export type UnconfirmedReason = 'signal-refused' | 'no-exit' | 'children-alive' | 'tree-unknown';

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

Rules the runtime enforces, not the engines. `outcome` is emitted exactly once and last, including after a kill or a crash. A `step` whose lane is a subagent never appears in `Run.events`; it is folded into that subagent's row. A todo tool call never produces a `step`. `text` for a subagent lane is folded into that subagent's row, never into the answer: the row's `result` is its latest answer item, deltas append and `text-final` replaces, reasoning is dropped, and text for an unknown subagent or after the outcome is dropped. An `image` whose payload arrived as base64 is on disk before the event exists.

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
  | 'provider-not-installed' | 'not-logged-in' | 'custom-command-unset' | 'custom-command-invalid'
  | 'owned-work-unverified';   // from ProcessHost admission, not from a cell

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

// Goals, behavior in *Goals*. GoalEnd is in model.ts. start() throws ConversationBusy while a run or a goal is live.
export interface GoalControl { start(objective: string, opts?: TurnOptions): GoalRun }
export interface GoalRun {
  readonly runs: AsyncIterable<Run>;                           // one Run per provider turn; may end with none
  status(): Extract<RunEvent, { type: 'goal' }> | undefined;   // the latest goal event; kept after runs ends
  result(): Promise<GoalEnd>;                                  // settles when the end is chosen; the terminal card reads it
  end(): Promise<void>;                                        // 🎯 结束目标
  stop(by: StopBy): Promise<Outcome | undefined>;              // ⏹ 终止
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

// The process port (OwnedProcess, SignalResult, ExitFact, ProcessFact) and the goal port (EngineGoal, GoalSink) are
// written out with their contract comments in packages/daemon/src/provider/engines/engine.ts.

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
// Rung, TurnState (opening, running, stopping{by, rung, deadline, signalled}, settled{outcome}), TurnInput, and Effect
// are written out in packages/daemon/src/provider/runtime/turn-machine.ts.

export function stepTurn(state: TurnState, input: TurnInput, profile: StopProfile, now: number): { state: TurnState; effects: Effect[] };
export function deadlineOf(state: TurnState): number | undefined;   // the one timer; undefined outside stopping
export function stopBoundMs(profile: StopProfile): number;          // the bound column below
```

The machine has no timer effect and no outcome effect. `RunChannel` keeps one timer at `deadlineOf(state)` and appends the outcome the first time the state is `settled`. It executes the effects: `stop-subagents` calls `EngineSession.stopSubagent` for every running roster entry when the engine has it, without awaiting; `interrupt` calls `EngineSession.interrupt`, and a failure is logged; `term-tree` and `kill-tree` call `OwnedProcess.term()` and `kill()` and feed each receipt back as `signal`. Exit facts and `transport-lost` from `watch()` become the `exit` and `transport-lost` inputs. An effect may call back into the channel synchronously. Once such a later input settles the run, no further call is made, including the remaining children of `stop-subagents`; an input that only records the turn id leaves every owed call to run, and a transition that settles by itself still makes its own calls.

| input | `opening` | `running` | `stopping` |
|---|---|---|---|
| `started` | `running` | ignored; a different id is logged | records the id if none. In `await-turn` before the deadline: `interrupt`, rung `interrupt`, deadline now + `graceMs`. At or after it: the `tick` rule |
| `stop` | `stop-subagents`. With `needsTurnId`: rung `await-turn`, deadline now + `openWaitMs`. Otherwise: `interrupt`, rung `interrupt`, deadline now + `graceMs` | `stop-subagents`, `interrupt` with the id, rung `interrupt`, deadline now + `graceMs` | ignored; the first `by` stays |
| `tick` | ignored | ignored | every passed ladder row, in order |
| `verdict` | the outcome table | the outcome table | `completed` and `failed` keep their outcome. `cancelled` is `interrupted{by, tree}` |
| `signal` | ignored | ignored | `sent` for an issued rung sets `signalled`. A receipt other than `sent` is logged; a `sent` for an unissued rung is ignored |
| `exit` | `failed{process-exit}` | `failed{process-exit}` | `interrupted{by, tree: 'exited'}` |
| `transport-lost` | `failed{transport-lost}` | `failed{transport-lost}` | ignored and logged |

The ladder rows: when the `await-turn` or `interrupt` deadline passes, `term-tree`, rung `term`, deadline + `TERM_WAIT_MS`; when the `term` deadline passes, `kill-tree`, rung `kill`, deadline + `KILL_CONFIRM_MS`; when the `kill` deadline passes, the run settles `interrupted{by, tree: 'unconfirmed'}`. Every deadline is absolute. Each is the previous deadline plus its wait, so one late `tick` emits every overdue effect in order and can settle in the same step. Only the grace deadline is anchored where `interrupt` was sent, because that is the provider's time to answer it. The bound, the column of the table below, is `openWaitMs + graceMs + TERM_WAIT_MS + KILL_CONFIRM_MS` of scheduled time, with `openWaitMs` counted only before `started` (a Codex stop after `started` settles within 8.5 s), and the machine reaches it with no input from the host. Host facts can only settle earlier. Settled ignores every input, so there is one outcome.

`tree` is read from the state at settlement. A verdict gives `signalled` when a `sent` receipt for an issued rung was recorded, and `live` otherwise, including after `refused`, `accepted`, `unknown`, or no receipt. An exit fact gives `exited` whatever came before. The kill row gives `unconfirmed`. The run is settled locally, `ProcessHost` keeps the record, and `owesWork()` stays true for it. Emitting `term-tree` or `kill-tree` records nothing. `transport-lost` while stopping changes nothing, because only the ladder and an exit fact can say what happened to the tree. After `failed{process-exit}`, `failed{transport-lost}`, or `tree: 'unconfirmed'`, the runtime closes the conversation, and the next message opens a new one with `resume`. `by` is the first stop's `by` in every case. `by: 'daemon'` comes only from `closeAll()`.

Subagents and the outcome. When `outcome` is emitted, every roster entry still `running` is settled as `interrupted`, and `run.events` carries that final `subagent` upsert before the `outcome`. No subagent outlives its run in the roster. Roster `interrupted` is local state: it says the run stopped tracking the entry, not that the child process ended. Where `subagentStop` is `none`, nothing addresses a child individually; its fate is the tree's fate, which only `tree` on the outcome and `ProcessHost` can state, and the card says so on each row (see *Feishu run card*).

| Engine | needsTurnId | openWaitMs | graceMs | bound | interrupt mechanism |
|---|---|---|---|---|---|
| codex | true | 5000 | 5000 | 13.5 s | `turn/interrupt` with the turn id (VB:465) |
| claude | false | 0 | 3000 | 6.5 s | `Query.interrupt()` (SDK:2425) |
| cursor, grok, custom-acp | false | 0 | 4000 | 7.5 s | `session/cancel` (ACP index.d.ts:6) |
| pi | false | 0 | 2000 | 5.5 s | `abort` (PIR:32) |

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

A goal is native only, today Codex `thread/goal/*`. It is a sequence of `Run`s, one per provider turn, each a `RunChannel` with the same ladder and the same one-outcome rule. `EngineGoal.set` gets a `GoalSink`. At each turn start the engine calls `sink.turn()`, which opens the next `Run` on `GoalRun.runs` and returns its `SignalSink`. `sink.goal()` carries each status change, which `status()` keeps and the live `Run` also carries. `sink.ended()` reports the provider's own end. A goal is `open`, then `ending`, then `ended`. The first trigger chooses the reason, settles `result()` at that moment, and moves the goal to `ending`. Nothing afterwards changes the reason.

| first trigger | `result()` | clear | ending run |
|---|---|---|---|
| `sink.ended(terminal)` or `sink.ended(failed)` | that end | `clear()` | drains to its own verdict |
| `GoalRun.end()` | `cleared` | `clear()` | drains |
| `GoalRun.stop(by)`; the idle bound as `stop('watchdog')`; `closeAll()` as `stop('daemon')` | `timeout` for `watchdog`, else `cleared` | `clear()`, then `stop(by)` on the ending run if still live | the ladder |
| an exit fact from `OwnedProcess.watch` | `failed{process-exit}` | skipped | settles from the same fact |
| `transport-lost` from `OwnedProcess.watch` | `failed{transport-lost}` | skipped | settles from the same fact |

The goal watches `OwnedProcess` from `start` until `runs` ends, so a process fact ends it before the first turn, between turns, or inside a turn. A peer that closes between turns does not wait for the idle bound. Entering `ending` closes the gate at once. `sink.turn()` returns `undefined`, so a turn the provider starts afterwards is an orphan. The engine interrupts it without waiting and drops its frames, and the runtime counts it. `sink.ended()`, a late `set` result, and `GoalSink.frame()` are ignored. The run live at that moment, if any, is the ending run, the last item of `runs`.

Clear starts at once, also while `set` is pending, bounded by `GOAL_CLEAR_MS` (5 s, a policy). A failure is logged with its cause (`timeout`, `rejected`, `transport`) and the JSON-RPC code, never the provider's message. A goal stop sends `stop` to the ending run only after clear settled, so the provider is not asked to stop a turn while it may still start the next one. The first `by` is held across that wait. A verdict or process fact that settles the ending run during the wait stands. The goal never writes an outcome. When the ending run has settled, or at once without one, and clear has settled, the goal keeps the process only if clear resolved within its bound, no orphan was counted, no process fact arrived, and no outcome of the goal has `tree` `signalled`, `exited`, or `unconfirmed`. Otherwise it closes the conversation, which hands the process to `ProcessHost` for termination of that record. Nothing in the goal waits on the tree. `runs` then ends. An orphan counted after `runs` ended closes the conversation if it is still open. Order is fixed: `result()`, then the ending run's `outcome`, then `runs` ends, then every pending `end()` and `stop()` resolves. Every `stop()` resolves with the ending run's outcome, or `undefined` without one. `end()` resolves with nothing. Neither rejects. Busy, stop, idle, bound, and card rules are in plan.md V6b.

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

Grok dialect. `subagent_spawned`, `subagent_progress`, `subagent_finished` become the roster, keyed by the child session id (GD `grok-subagents.ts:2-3`, `:15`; fixtures `s7-subagent-*.jsonl`). `_meta["x.ai/tool"].name` refines `StepDetail` (GD `grok-dialect.ts:12`, `:202`). `turn_completed.stop_reason` `error` and `rate_limit` become `failed` (GD `grok-dialect.ts:18`, `:37`, `:214`). `retry_state` becomes `notice{retry}` (`:25`). `_x.ai/subagent/cancel` is `subagentCancel` (GD `grok-subagent-stop.ts:15-21`). `x.ai/ask_user_question` and `_x.ai/exit_plan_mode` are refused (GD `grok-requests.ts:122`, `:128`). `authMethods` non-empty and `-32000` on `session/new` is `not-logged-in` with 已安装但未登录，请在这台机器上运行 grok login. `--always-approve` is passed only for `full` (Orca `acp-launch-specs.ts:100-103`). `todo` and `images` ship `none` with `pending: grok.three-turns` because the fixtures show a `todo_write` tool and `image_gen` tool but no `plan` update and no image result (audit rows 15, 16). A `todo_write` tool call is still dropped by translation and never becomes a `step`, so no todo update appears as a tool row. Grok's `compact` follows the slash-command rule of the Claude engine: it is `native` when `available_commands_update` declares a compact command, which probe `grok.three-turns` records, and `none` until then. The Grok test fixtures are recorded fresh from the installed `grok` with `scripts/record-fixture.mjs --provider grok`. Orca's MIT fixtures under `/home/operator/orca/src/main/acp/fixtures/` are evidence for this design only and are not copied.

Cursor dialect. CUR documents `cursor/task` as "Notify client about subagent task completion", a completion signal, not a start or step signal (fetched 2026-10-12). It can therefore give at most a `completed` roster row with its task and result, so the best `subagents` cell it can reach is `partial`, with no live rows and `subagentStop: none`. `cursor/update_todos` becomes `todo`, with `merge:true` merging into the tracker and `false` replacing (CUR, audit row 15). `cursor/generate_image` becomes `image` (CUR, audit row 16). Payload shapes for the three `cursor/*` notifications are not documented, so all three cells ship `none` with `pending: cursor.full-turn` and flip only when that probe records the payloads. `cursor/create_plan` and `cursor/ask_question` are answered at once, because CUR warns the tool hangs otherwise (see Auto-answered requests). `cursor/list_available_models` feeds `models`. `authenticate` with `methodId: "cursor_login"`; the failure hint is 已安装但未登录，请在这台机器上运行 cursor-agent login. Reasoning, context usage, titles, compact, and effort are `none` pending `cursor.initialize` and `cursor.full-turn` (audit rows 7, 19 to 22, 25, 27).

Custom ACP dialect. Base translation only. `features` are derived at `initialize` from `agentCapabilities` and `sessionCapabilities` (ACP:36, :2600). Only `full` is offered. The command comes from host settings `execution.customAcpCommand`, shaped `{ command: string; args: string[]; env?: Record<string, string> }`. An unset or invalid command is a refusal at open, not at bind.

### Codex engine

Re-homed from `agent/codex-appserver/`. `turn/start` with `approvalPolicy: 'never'` and the sandbox from the plan. `ThreadItem` kinds map to `StepDetail` by type (CX `v2/ThreadItem.ts:26-101`). `turn/plan/updated` becomes `todo` (CX `v2/TurnPlanUpdatedNotification.ts`). `imageGeneration`, `imageView`, MCP image results, and `dynamicToolCall` `inputImage` become `image` (audit row 16). Child threads are subagents. `collabAgentToolCall` with `spawnAgent` opens a roster entry, every `item/*` notification carrying a child `threadId` is a subagent-lane step, and `Thread.source.thread_spawn` identifies the parent (CX `v2/ThreadItem.ts:64-101`, `v2/SubAgentSource.ts`). `stopSubagent` sends `turn/interrupt` to the child thread's active turn, the way Orca does, and the cell is `partial` because there is no dedicated method (audit row 14). `thread/tokenUsage/updated` feeds `context`. `thread/compacted` and the `contextCompaction` item feed `compaction`. `thread/goal/*` is experimental and needs `experimentalApi: true` at `initialize` (`app-server-client.ts:155-161`); `goal` ships `native` as today. `thread/goal/set` and `thread/goal/clear` are `EngineGoal`; `thread/goal/updated` is the `goal` event with `ThreadGoal.timeUsedSeconds`, and every goal turn is its own `Run` (see *Goals*). `error.willRetry` becomes `notice{retry}` (CX `v2/ErrorNotification.ts`). `account/rateLimits/read` replaces the direct ChatGPT `wham` request for the usage card. `thread/name/set` and `Thread.name` are titles (audit row 27). `oneShot` is `native`: the ephemeral read-only utility thread with `outputSchema` that `main` uses for titles (VB:163-194), now serving `TitleService`. The warm pool, the managed install at 0.156.1, and `codex-install-lock.json` move unchanged.

### Claude engine

Replaces `agent/claude-agent/`. The engine spawns the CLI through `spawnClaudeCodeProcess` so the pid is owned by `ProcessHost` (SDK:2181). `includePartialMessages` is on. `stream_event` deltas become `text`. `tool_use` becomes `step` classified by tool name, which is Claude's native form (audit row 8). `TodoWrite`, `TaskCreate`, `TaskUpdate` inputs become `todo` and never a step (TOOLS:999, :2692, :2718). `TaskList` and `TaskGet` calls are dropped and never a step either. `task_started`, `task_progress`, `task_notification` drive the roster only when `task_type` is `local_agent` or `subagent_type` is set (SDK:4924-4945). Other task types, `local_bash` and `local_workflow`, never create a roster entry: a backgrounded Bash command already shows as its `Bash` step on the main lane, and its task frames are dropped. Frames with `parent_tool_use_id` are subagent-lane steps (SDK:5026). `stopSubagent` is `stopTask(taskId)` (SDK:2703). `tool_result` image blocks become `image` through the sink. `compact_boundary` becomes `compaction` (SDK:3187). `rate_limit_event` feeds the usage card (SDK:4610-4640). `api_retry` becomes `notice{retry}` (SDK:3071). Steer sends `streamInput` with `priority: 'next'` and ships `partial` with the note that it lands at the next model turn (SDK:5032, :2698). Compact is native. By the user's decision of 2026-10-12, an agent slash command counts as native when the agent declares it, and Claude declares `/compact` in `supportedCommands()` (SDK:2546). The engine sends that command as the prompt and reports `compaction` from `compact_boundary`, which is what `main` already does (`main:agent/claude-agent/thread.ts:560`, :568). `features.compact` is `native` when `supportedCommands()` lists `compact` at session start, and probe `claude.commands` records it. Titles are `renameSession` and `SDKSessionInfo.summary` (SDK:2739, :4736-4746). `oneShot` is `native`: `query` with `tools: []` and `maxTurns: 1` (see *Session titles*). `goal` is `none` pending `claude.goal-review` (audit row 18). `settingSources` is `['user']` so `~/.claude/settings.json` model routing for DeepSeek, Kimi, GLM, and Qwen reaches the child. The `@anthropic-ai/claude-agent-sdk` dependency moves to `dependencies` at exactly `0.3.246`.

### Pi engine

`pi --mode rpc` over `JsonlPeer`. `text_delta` and `thinking_delta` are `text`. `tool_execution_start/update/end` are `step` by tool name. `ToolResultMessage.content` `ImageContent` is `image` (PIA:421, :275). `compaction_start/end` is `compaction` (PIS:60, :72). `auto_retry_start/end` is `notice{retry}` (PIS:79-89). `agent_end.stopReason` maps as in Outcomes, and `willRetry: true` is not terminal (PIS:48-52, PIA:311). `steer` and `compact` are native RPCs (PIR:22, :74). `get_session_stats` feeds `context` (PIR:97). `set_session_name` is titles (PIR:128). `oneShot` is `none` with `pending: pi.no-tools-title` (see *Session titles*). `extension_ui_request` is cancelled (PIR:407-458). Subagents, todo, and goal are `none`.

### Process host

One `ProcessHost` for every engine, re-homed from `agent/codex-appserver/owned-process.ts` and `windows-job.ts`. V6a PR 5 settled this section: it adds a Vonvon-owned retaining parent on POSIX, two changes to the existing Windows supervisor, a new ledger file, and one ownership type, because the previous drafts assumed a capability the source disproves. A held Node `ChildProcess` reference is not a kernel binding: Node reaps the child, the numeric pid and group id become reusable, and `process.kill(-pid)` after any check is the non-atomic read-then-signal that #117's own POSIX driver labelled as such. No draft may rely on it again. The design below never sends a signal to a numeric id from the daemon.

- Actors and topology. The daemon spawns one *holder* per provider, and the holder is the provider's OS parent, stays outside the containment it terminates, and retains the provider's kernel identity until it has finished signalling. On POSIX the holder is `vonvon-holder`, a small native executable proposed below, because a Node holder loses its authority the moment libuv reaps the provider (review R1, R5): Node reaps every child on `SIGCHLD`, and a reaped pid is no longer reserved, so no JavaScript parent can both observe the provider's exit and keep signalling the group that exit left behind. The native holder separates three things the Node runtime fuses: observing termination, retaining identity, and reaping. The daemon spawns it `detached: true` with six pipe slots: 0 commands in, 1 receipts out, 2 holder log, 3 provider stdin, 4 provider stdout, 5 provider stderr. It marks slots 0, 1, and 2 close-on-exec, sets `SIGCHLD` to `SIG_DFL` explicitly, because an inherited `SIG_IGN` would make the kernel reap on its behalf, ignores `SIGTERM`, `SIGINT`, `SIGHUP`, and `SIGPIPE`, has no threads and no runtime, and reaps only at the sites named under *Reap and continuation*. It creates the provider by `fork` followed by the child's pre-exec sequence of *Child setup*, which ends in `execve` with no shell; the provider therefore leads its own session and group, whose id is its pid, and that group is the containment. The descriptor ownership after `fork` is fixed by the table under *Child setup*: the holder keeps commands, receipts, log, its self-pipe, the status reader, and the go writer, and nothing else, so the daemon's EOF on the provider pipes means every writer has closed, the provider and any descendant that inherited them; the holder never writes to them and its log goes to slot 2 only. On Windows the holder is the C# supervisor embedded in `windows-job.ts`, rewritten to be the provider's direct parent: it creates the provider with `CreateProcessW` whose `STARTUPINFOEX` carries `PROC_THREAD_ATTRIBUTE_JOB_LIST` naming the Job it just created, so the provider is a Job member from its first instruction; the `node -e` wrapper of the current source is removed. The Job is created without `JOB_OBJECT_LIMIT_BREAKAWAY_OK` and without `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`, so no descendant leaves it: a `CREATE_BREAKAWAY_FROM_JOB` request fails with `ERROR_ACCESS_DENIED` when the Vonvon Job is the caller's immediate Job, and when a nested Job that allows breakaway sits below it, such as the Job libuv puts a Node process's children in, which permits breakaway, the request succeeds but the new process leaves only up to the Vonvon Job and stays its member (Microsoft, nested jobs). The guarantee is membership, not a failed create. A real-process test on the Windows CI job pins it against today's supervisor by `IsProcessInJob` on the exact Job, then requires the Job's empty proof and the requested process gone after the kill, and keeps pinning it after the rewrite. The supervisor is not a Job member and holds the only Job handle. The daemon spawns it with descriptors 0, 1, and 2 ignored and the provider's stdin, stdout, and stderr on descriptors 3, 4, and 5, which libuv passes in the C runtime block of `STARTUPINFO.lpReserved2`; the supervisor reads those three handles from `GetStartupInfoW` before its hello and exits `never-launched` when any is missing. Its standard handles are never the provider's, because the PowerShell host and the CLR share them and the supervisor cannot prove it holds the only copy; a 6b run in which the provider inherited the supervisor's standard handles saw the provider exit and its stdout never reach EOF while the supervisor lived. The provider inherits slots 3, 4, and 5 as its standard handles; after `CreateProcessW` returns the supervisor closes its copies, which nothing else in it references, and logs any close that fails, so stdout EOF has the same meaning as on POSIX; its control channel is the named pipe below and its log is a file named on its command line, so provider bytes, control bytes, and log bytes never share a stream on either platform. The daemon's Node process holds no Job handle, no group capability, and never signals a number.
- The retained-parent primitive, POSIX. The holder runs one `poll` loop over four inputs, all nonblocking: the command fd, the self-pipe its `SIGCHLD` handler writes, the status reader for as long as it exists, and the receipt fd for writability whenever its bounded receipt queue is non-empty. The command parser is incremental, so a partial length-prefixed `launch` frame never blocks EOF, cancellation, or the `SIGCHLD` path; the status parser is incremental too, so `S`, `C`, a complete `E` frame, and status EOF are each delivered by the loop without any other event, which is what lets `created` follow `S` with no further command and no child state change; receipts are appended to a queue that grows and never drops a receipt, and are written only when the receipt fd is writable; the command fd stays in the poll set whatever the queue holds, so an unread receipt never hides command EOF or freezes daemon-death handling. The queue is bounded in practice because the daemon issues a command only for a receipt it awaits; a holder that cannot grow it exits 1, which proves nothing. The only blocking read anywhere is the child's own read of the go pipe. On the self-pipe it observes the provider's termination with `waitid(P_PID, pid, &si, WEXITED | WNOHANG | WNOWAIT)`; `WNOWAIT` returns the status and leaves the child waitable, so the provider stays a zombie, its pid stays reserved, and a group id equal to that pid cannot be created by anyone, because `setsid` and `setpgid` can only produce a group id equal to a live or unreaped pid. Linux documents `WNOWAIT` for `waitid` (man-pages waitid(2)); Apple documents it for `waitid(2)` on macOS, and the implementer confirms it on the Mac before the native lanes, with the kqueue `EVFILT_PROC` `NOTE_EXIT` route as the fallback observation if `WNOWAIT` is found wanting there. While the child is unreaped, every `kill(-pid, sig)` the holder issues is bound: the target group is the one its own retained child leads. When the retained zombie is the group's only member, Linux answers 0 and macOS answers `EPERM`; the holder reports the call as it returned, so on macOS a final `kill` after the exit reads `refused kill <nonce> 1`. That receipt is truthful and final: the continuation counts a validated `sent` or `refused` as the final `kill` receipt and moves on to the reap, and only the probe after the reap is a proof, so an `EPERM` is never read as success. The holder reaps, with `waitid(..., WEXITED | WNOHANG)` without `WNOWAIT`, only after a validated `WNOWAIT` observation of that child, at the sites named under *Reap and continuation*, and a `reap` command that arrives before the observation answers `not-ready <nonce>` and blocks nothing; no branch of the holder ever calls a blocking wait. The empty-group probe `kill(-pid, 0)` is meaningful only after the reap, because an unreaped zombie still answers for its group; after the reap the pid is reusable and the probe can be falsely live, never falsely empty. So the order of the ordinary ending is fixed: observe the exit, signal the group as many times as the ladder needs, reap, probe. After the reap no destructive signal is ever issued again; a member that survives `SIGKILL`, which only an uninterruptible kernel state can do, is found by the probe and retried by probing alone. A direct child that has not become waitable by any local deadline, the same uninterruptible case, is never reaped by a timeout: the holder keeps the identity and keeps observing beyond the daemon's bounds, so the daemon's `unconfirmed` settlement and the holder's retained authority coexist, and the tail below resumes from the observation whenever it arrives. The holder's own death is the residual: a holder killed by `SIGKILL` or the OOM killer, or crashed, loses the zombie to init, which reaps it and releases the identity; the daemon sees the holder's exit on its child handle, the record goes `unknown`, nothing is signalled, and only the probe can end it. That residual is disclosed in *Platform limitations* and no crash lane claims otherwise.
- The durable record, a union keyed by the reservation. `<dataDir>/process-owners.json` holds one record per reservation, written by synchronous write-and-rename at each transition. It is a new file, so a record's source is told apart by its file and never by its values; #117's positive-pid `owned-pids.json` is legacy, below.

```ts
export type ReservationId = string;                                    // uuid chosen by the daemon before anything exists
export type StartToken = string & { readonly __brand: 'StartToken' };   // opaque OS birth mark, compared only with a token read for the same pid by the same reader on the same host
export interface HolderIdentity { pid: number; start?: StartToken }      // pid from the daemon's own child; start absent when the identity reader failed
export type WindowsControl = { pipe: string; jobName: string; osSession?: number };   // osSession from the supervisor's hello; absent until authenticated
export type LedgerRecord = { id: ReservationId; daemonBootId: string; providerId: ProviderId; sessionId?: string; control?: WindowsControl } & (
  | { stage: 'intent' }                                                  // written before the holder is spawned; carries no pid because none exists
  | { stage: 'born'; holder: HolderIdentity }                            // the inert holder is alive; it cannot create a provider without `launch`
  | { stage: 'attempting'; holder: HolderIdentity }                      // written before `launch` is sent; irreversible; the holder may have forked
  | { stage: 'launched'; holder: HolderIdentity; provider: { pid: number } }   // POSIX only: the containment identity is durable and GO has not been sent; Windows goes from attempting to running
  | { stage: 'running'; holder: HolderIdentity; provider: { pid: number } }    // no pre-exec error was reported, so the provider may have run; the holder creates nothing further, ever
);
export type Ownership = 'inert' | 'bound' | 'unknown' | 'gone';
```

  The start token is read per platform, and it is only ever compared with a token read for the same pid. A different token, or `absent`, proves the recorded process is gone; an equal token proves nothing more, because every reader has a clock resolution, 10 ms ticks on Linux and one second on macOS, and a pid reused within one step carries the same token. Nothing is released on equality, so a collision can only keep a record `unknown` and admission closed until the reusing process exits; it never seals a live holder. Linux: `/proc/sys/kernel/random/boot_id` joined with field 22 of `/proc/<pid>/stat`, the start in clock ticks since boot, which never repeats across reboots. macOS: `ps -o lstart= -p <pid>` under `LC_ALL=C` and `TZ=UTC`, one-second resolution independent of the daemon timezone, the only reader that needs no native code; `ps` exits 1 both for a missing pid and for its own failures, so the reader answers `absent` only when `kill(pid, 0)` then fails with `ESRCH`, and `unreadable` for anything else, including output on stderr. Windows: the process creation `FILETIME` in decimal, read by the recovery reader through `[Diagnostics.Process]::GetProcessById(pid).StartTime.ToFileTimeUtc()`; at birth the supervisor reports the same value for itself in its `hello`, so a spawn never waits on PowerShell. The reader answers a token, `absent` when no process has the pid, or `unreadable`; only `absent` or a different token seals a holder. `Ownership` is derived, never stored: `intent` and `born` are `inert`, a record that cannot own a provider by construction; `attempting`, `launched`, or `running` with the holder alive and its retained identity intact is `bound`; any of those with the holder gone, or with the identity reaped and the probe not empty, is `unknown`; the proof held is `gone`, and only then is the record removed. `inert` never blocks admission, is shown by `doctor`, and is retired as *Recovery* says. The reservation is single-use in both actors: the daemon's `Reservation` accepts one `spawn` and one `release`, and the holder keeps a `created` flag that makes a second `launch` answer `refused launch <nonce> already-created` before any `fork`; the Windows supervisor keeps the same flag before `CreateJobObjectW`.
- Startup, one ordered state per record. Each row names what is durable before the next row may begin. A failure or daemon death in any row latches in the holder: it creates nothing afterwards and ends what it already created.

| row | POSIX | Windows | failure here |
|---|---|---|---|
| `intent` | write the record; no holder exists | write the record with `control.pipe`, a fresh `\\.\pipe\vonvon-<id>` the daemon already listens on, and `control.jobName`, `Local\vonvon-<id>` | record stays `intent`, retired at the next sweep |
| `born` | spawn `vonvon-holder` with the six slots; the holder's first receipt is `hello vonvon-holder <protocol version>`; read `pid` from the returned child and `start` through the identity reader, absent if it fails; write `born` | spawn the supervisor with the pipe name as an argument and the token in `VONVON_CONTROL_TOKEN`, which it strips from the provider's environment; write `born` | spawn error or wrong `hello`: the record is removed only when no child exists; a child that exists is sent `abandon` and the record is retired on its `never-launched` exit |
| `authenticated` | implicit: slot 1 is the daemon's own pipe | the supervisor connects a `NamedPipeClientStream` and writes `hello <token> <own pid> <os session> <start>` where the session comes from `ProcessIdToSessionId`; the hello ends with the supervisor's own creation `FILETIME` from `GetProcessTimes`; the daemon checks the token and that the pid equals its child's, writes `control.osSession` and `holder.start`, then writes `ok` | wrong token, second connection, or silence past the spawn deadline: the socket is closed, the supervisor exits `never-launched`, the record is retired on that exit |
| `armed` | the holder reads slot 0 until EOF from birth | the supervisor's single reader thread parses lines on the authenticated socket and treats `PipeStream.Read` returning 0 and `IOException` alike as EOF | EOF before `launch`: exit `never-launched` |
| `attempting` | the daemon writes `attempting`, then sends `launch <nonce>` with the framed command, argv, environment, and cwd; the holder creates the go and status pipes, `fork`s, closes its go reader and status writer, and the child closes its go writer and status reader; the child runs *Child setup* up to and including `setsid` and writes the frame `S` on the status pipe, then blocks reading the go pipe; the holder writes `created <nonce> <pid>` only after `S`, so a created identity is always a group the child leads | the daemon writes `attempting`, then sends `launch`; the supervisor calls `CreateJobObjectW(Local\<name>)`, and on `ERROR_ALREADY_EXISTS` closes the handle it received without setting any limit, writes `job-collision <nonce>`, and exits `launch-failed`; otherwise it sets `KILL_ON_JOB_CLOSE` and calls `CreateProcessW` with the Job in `PROC_THREAD_ATTRIBUTE_JOB_LIST` | `fork` or `CreateProcessW` fails: `launch-failed <nonce> <errno>` and exit `launch-failed`, a trusted no-provider fact, because no child exists; a crash is whatever the OS reports and is `unknown` until the probe holds |
| `launched` | the daemon writes `launched` with `provider.pid`, then sends `go <nonce>` unless its own cancel latch is set; the holder writes the single GO token byte `G` on the go pipe and closes it; the child reads the go pipe to EOF and proceeds only when the whole content was exactly one byte `G`: empty input, a different first byte, or any byte after `G`, as in `GG`, is cancellation, and the child writes `C` on the status pipe and `_exit`s without running anything; a second `go` for the same nonce is answered `refused go <nonce> already-sent` and writes nothing | not a Windows stage: Windows needs no go step because the Job name, durable at `intent`, is the containment identity, and the supervisor's `CreateProcessW` is the launch | cancellation latch: daemon death (EOF), `abandon`, or a `term` or `kill` command before `go` makes the holder close the go pipe without writing, so the child cancels; the holder observes and reaps that stub, writes `cancelled <nonce>`, and exits `never-launched`. The holder's latch is terminal command state: after it, `launch` and `go` are answered `refused <command> <nonce> cancelled` whether or not a child was ever created, and nothing reopens authorization. The daemon sets its own latch when `end(record)` starts or `closeAll()` runs, so a `created` receipt arriving after a local stop never earns a `go` |
| `running` | the status pipe is close-on-exec; after `G` the child finishes *Child setup* and calls `execve`, which closes the pipe on success; the status stream grammar is `S`, `C`, or `E <step> <errno>\n`, one frame per child lifetime after `S`, parsed incrementally; a complete `C` or `E` frame latches before any EOF classification, so `ready` is never written after a complete `C` or `E`, and the facade's `ready` rejects with `cancelled` or `launch-failed` on that path instead of waiting for the readiness timer; EOF after `S` with no complete `C` or `E` makes the holder write `ready <nonce>`, which means no pre-exec error was reported and the provider may have run, nothing more; a complete `E` frame followed by the stub's observed exit makes the holder reap the stub and write `launch-failed <nonce> <step> <errno>`, a trusted no-provider fact; a partial `E` is not an errno and is treated as EOF | the supervisor writes `ready <nonce> <provider pid>` after `CreateProcessW` returned | no `ready` and no `launch-failed` within the spawn deadline: the record stays `launched`, the facade reports `holder-not-ready`, and the record is `unknown` once the holder is gone; a stub that dies after `S` without `E` or `C` is a may-have-run case and takes the ordinary exit-fact path, never the no-provider path |

  Holder exit codes, the same on both platforms: 0 after `exit <nonce>` or after the daemon-death path has proven the group empty, 10 `never-launched`, 11 `launch-failed`, and 1 for an internal error, which proves nothing. `never-launched` has one meaning on both platforms: the holder never let a provider program run, which it can state because it exits with that code only before `fork` or `CreateProcessW`, or after its stub wrote `C` and was reaped. `launch-failed` is the other no-provider terminal fact: `fork` or `CreateProcessW` failed, or the stub reported a complete `E` frame and was reaped. These two, and only these two, retire a record without a containment proof, because they rest on the holder's own explicit receipt plus its reap of the only child it had; an exit code, an empty status pipe, a holder exit, or output that resembles an error never does. Neither is ever reported as `provider-exit`. The launch command carries the command, argv, environment, and cwd as length-prefixed byte strings, one length line then the bytes, with no shell and no quoting; the holder never echoes the environment on any channel, and the daemon's log records the command name only.
- Child setup, the pre-exec sequence and descriptor ownership. The child performs these steps in order, and a failure at any step writes `E <step> <errno>` on the status pipe and `_exit`s: `sigset` resets every disposition the holder changed, `SIGTERM`, `SIGINT`, `SIGHUP`, `SIGPIPE`, and `SIGCHLD`, to `SIG_DFL`, and `sigprocmask` installs an empty mask, so the provider starts with the defaults Node's own spawn gives it; `setsid`; the `S` frame; the GO read; `chdir` to the requested cwd when one was supplied; `dup2` of slots 3, 4, 5 onto fds 0, 1, 2; `close` of the original slots 3, 4, and 5 and of every other descriptor numbered 3 or higher, by `close_range` where available and by iteration up to the descriptor limit otherwise, which the close-on-exec status writer survives; command resolution; `execve`. Resolution follows the pinned Node v22.12.0 libuv contract, with one named exception: a command containing a slash is used as given, relative to the cwd just entered; a slash-free command is searched along a search path by trying `execve` on each candidate, and the search path is the `PATH` entry of the supplied environment when one is present, including an intentionally empty value, which yields no candidates and so `ENOENT` even when the cwd holds an executable of that name, or the libc default search path when the supplied environment has no `PATH` entry, `confstr(_CS_PATH)` on Linux and `_PATH_DEFPATH` on macOS, which is what libc `execvp` uses with `PATH` unset; the daemon's own `PATH` is consulted only when the engine supplied the daemon's inherited environment, and never as a fallback for an explicit environment. Per candidate, `ENOENT` and `ENOTDIR` continue; `EACCES` is remembered and the search continues, and it is the reported error only when no later candidate executes and no other error occurred; any other error stops the search and is reported. The one exception is `ENOEXEC`: libc `execvp` retries such a file through `/bin/sh`, and this holder does not, so a file without a valid header fails with `ENOEXEC` and no shell is ever executed; that restriction is deliberate and is the only place the holder's resolution differs from libc. `argv[0]` is the command as requested and the environment is passed unchanged. Descriptor ownership after `fork`:

| descriptor | holder after fork | child before exec | child after exec |
|---|---|---|---|
| slot 0 commands, slot 1 receipts, slot 2 log | kept | closed by the close step | absent |
| slots 3, 4, 5 provider stdin, stdout, stderr | closed immediately after fork | `dup2` onto 0, 1, 2 replaces the child's inherited 0, 1, 2 endpoints, then the originals at 3, 4, 5 are closed; the new 0, 1, 2 are kept | fds 0, 1, 2 are the provider pipes; what the provider opens afterwards is its own |
| go pipe | writer kept until GO or cancel, reader closed | reader kept until the GO read, writer closed immediately | absent |
| status pipe | reader kept until EOF, writer closed | writer kept, close-on-exec, reader closed | absent |
| self-pipe | both ends kept | closed by the close step | absent |

  A provider that closes its fd 1 therefore closes its only copy of the stdout pipe; EOF at the daemon still waits for any descendant that inherited fd 1, which the contract does not promise to detect individually.
- Holder protocol, the wire grammar both holders speak and `process/holder-protocol.ts` encodes and parses. Every line is ASCII, ends in `\n`, and separates fields by one space. A nonce is 1 to 32 characters of `[A-Za-z0-9-]`, fresh per command. Commands: `launch <nonce>` followed by framed fields, `go`, `abandon`, `term`, `kill`, `reap`, `probe`, and `exit`, each as `<command> <nonce>`. A frame is `<decimal byte length>\n` then exactly that many bytes, so no field is quoted or escaped; `launch` sends the command as one frame, a line with the argument count and one frame per argument, a line with the environment count and one `KEY=VALUE` frame per entry, and one frame for the cwd, empty meaning none. Receipts: `hello vonvon-holder <protocol version>` (POSIX, slot 1), `created <nonce> <pid>`, `ready <nonce>` (Windows adds `<pid>`), `cancelled <nonce>`, `launch-failed <nonce> <errno>` or `launch-failed <nonce> <step> <errno>`, `job-collision <nonce>`, `sent <rung> <nonce>`, `accepted term <nonce>`, `refused <command> <nonce> <reason>` where the reason is a decimal errno or Win32 error, `reaped`, `not-launched`, `already-created`, `already-sent`, or `cancelled`, `reaped <nonce>`, `not-ready <nonce>`, `empty <nonce>`, `live <nonce>`, `probe-unknown <nonce> <errno>`, and the unsolicited `provider-exit <code> <signal>`, with `-` for an absent code or signal and the signal as its `SIG` name. Every number is plain decimal within 0 to 2^32 − 1, the DWORD range Windows pids, exit codes, and errors need; a pid is at least 1 and the protocol version is 1 to 65535. On Windows `term` is answered only by `accepted` and `kill` only by `sent` or `refused`; on POSIX both rungs are answered only by `sent` or `refused`. Three answers the grammar leaves to the holder are fixed here: `probe` while the identity is still retained answers `not-ready <nonce>` without calling `kill`, because the retained zombie answers for its group with 0 on Linux and `EPERM` on macOS and neither is a proof, and before any launch answers `refused probe <nonce> not-launched`; `go` before `created` answers `refused go <nonce> not-launched`; and once the cancellation latch is set, `cancelled` wins over `already-created` and `already-sent`. The `E` step names are `sigset`, `setsid`, `go`, `chdir`, `dup2`, `close`, and `exec`. A line that does not parse or holds a number out of range, or a receipt whose nonce, command, or platform does not match an issued command, is dropped and logged, never guessed at; a dropped `term` or `kill` receipt therefore resolves as `unknown` at its deadline.
- Signals and receipts. Every command carries a daemon nonce and every receipt echoes it; the host validates each receipt against the issued command, nonce, and platform before it becomes a `signal` input. The POSIX holder answers `kill` by `kill(-providerPid, SIGKILL)` and `term` by `kill(-providerPid, SIGTERM)` followed at once by `kill(-providerPid, SIGCONT)`, so a stopped member wakes to act on the TERM, while the child is unreaped; the receipt reports the `SIGTERM` call and the `SIGCONT` result goes to the holder log only. Post-call receipts are `sent <rung> <nonce>` on zero and `refused <rung> <nonce> <errno>` otherwise, where zero means at least one member was signalled, possibly not the provider, and `EPERM` means none was; after the reap it answers `refused <rung> <nonce> reaped` without calling `kill`, and before `go` it answers `refused <rung> <nonce> not-launched`, sets the cancellation latch, and closes the go pipe. The Windows supervisor answers `term` with `accepted term <nonce>` and does nothing, because a Job has no graceful signal, and `kill` with `TerminateJobObject` on its held handle followed by `sent kill <nonce>` or `refused kill <nonce> <error>`. `accepted` therefore occurs only for the Windows term rung, and the host drops any other `accepted`. The daemon's facade keeps a command queue: a command is *queued* when written to the channel, which `Writable.write` may report as backpressure without rejecting it, and that is what `killed` on the facade means; a command is *sent* only when its post-call receipt arrives, and that is the only signal truth. Failure traces: holder exits before reading the command, `unknown`; holder reads the command and exits before the call, `unknown`; holder makes the call and exits before writing, `unknown`, though the signal may have been delivered; call returns an error, `refused`; call returns zero, `sent`; the daemon cannot write because the channel is closed, `unknown`. No receipt is death.
- The Windows supervisor, settled in V6a 6b. It speaks the *Holder protocol* grammar line for line over the authenticated pipe, with these Windows meanings. The C# source ships inside `process/windows-supervisor.ts` and is written, with a fixed `.ps1` loader, to a content-addressed directory under the OS temp directory before the first spawn, so no command line approaches the 32,767-character `CreateProcessW` limit; the loader compiles it with `Add-Type -Path` and calls one entry point with the pipe name, the Job name from `control.jobName`, and the log path. Every receipt is written under one lock and the write blocks while the pipe is full; that is safe because the authenticated pipe is one duplex handle, so daemon death breaks the write and the read together and the blocked writer sees it as EOF. `launch` carries the complete Windows command line as its single argument frame, built by the daemon in `process/windows-command-line.ts`: libuv's quoting for an executable, and cross-spawn's escaping behind `cmd.exe /d /s /c` for a `.cmd` or `.bat` shim, so `node -e` and cross-spawn no longer sit in the tree. The supervisor passes it verbatim to `CreateProcessW`, with the environment frames as a `CREATE_UNICODE_ENVIRONMENT` block, `PROC_THREAD_ATTRIBUTE_JOB_LIST` naming its Job, and `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` naming only the three provider handles from slots 3, 4, and 5, so no other handle is inherited. One thread reads commands and one waits on the provider handle; every receipt goes through one lock, so receipts never interleave. `provider-exit <code> -` comes from `WaitForSingleObject` and `GetExitCodeProcess`. A Windows process is never a zombie, so `reap` answers `not-ready` before the exit is observed and `reaped` after it with nothing to release, and `probe` answers from the Job's active-process count on the held handle, `empty` at zero and `live` otherwise. `exit` closes the Job handle and exits 0. Pipe EOF or an `IOException` before `launch` exits 10; after it, the supervisor calls `TerminateJobObject`, waits until the Job reports zero active processes, and exits 0. The read-only recovery probe by Job name and session lands with `sweepOrphans` in 6c.
- Exit facts, the only sources of `exit`. `observed: 'parent'`: the holder's `provider-exit <code> <signal>` receipt from its `WNOWAIT` observation on POSIX, written before any reap, or from `WaitForSingleObject` and `GetExitCodeProcess` on Windows. The holder is outside the containment, so this report survives the `kill` rung on both platforms. `observed: 'containment'`: the holder's report was lost because the holder itself was gone, and the sealed containment was then proven empty by the probe; the provider was a member from its first instruction and, being its session leader, could not leave it, so emptiness includes the provider's exit, with `code: null, signal: null`. The exit-report hold is the rule behind `OwnedProcess.watch()`: when the provider's stdout reaches EOF with no exit fact, the host waits `EXIT_REPORT_HOLD_MS` (1000 ms, a policy figure below `TERM_WAIT_MS`) from that EOF, and reports `transport-lost` only if no exit fact arrived inside the hold; an exit fact inside the hold is reported alone, so a crash reads as an exit, and an exit fact after `transport-lost` is still reported, never the reverse. Nothing else is an exit: a closed pipe, a closed peer, a holder exit, `launch-failed`, `cancelled`, and `never-launched` are not. A stub that died after `S` without a complete `E` or `C` frame is observed and reported as `provider-exit` like any child, because it may have run. A `reaped <nonce>` receipt states that identity retention has ended and is never an exit either.
- Empty-group proof and sealing. A proof is final only once the record's launcher is sealed: a `running` holder is sealed by construction; an `attempting` or `launched` holder is sealed only by its exit, which the live daemon sees on its child handle and a later daemon establishes through the identity reader reporting the recorded holder pid `absent` or carrying a different start token, a liveness read that releases nothing by itself; a `born` holder whose `start` is absent can only be sealed by the live daemon's child exit, and a later daemon retains it as `inert` and logs it. The POSIX probe target is `provider.pid` from `launched` or `running`, never the holder pid; a POSIX record in `attempting` has no target and is `unknown` until the holder is sealed, after which it is retired, because a holder sealed before `launched` was persisted never wrote GO, so its child could only have cancelled. That rule is POSIX only. A Windows record in `attempting` may already own a running provider, because `CreateProcessW` is the launch, so it is recovered exactly as `running`: by the durable `control.jobName` and `control.osSession`, with the same sealed-generation, empty, and unknown rules, and it is retired without a Job proof only on the supervisor's explicit `launch-failed` or `never-launched` exit observed by the live daemon. The probe `kill(-providerPid, 0)` with `ESRCH` is empty; a reused pid that became a group id answers live, so the probe can be falsely unknown, never falsely empty; `EPERM` and every other answer are unknown. Windows probe, by a read-only helper embedded beside the supervisor and run only when the current process's `ProcessIdToSessionId` equals `control.osSession`: `OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, Local\<name>)` failing with `ERROR_FILE_NOT_FOUND` after the supervisor is sealed is empty, because the supervisor held the only handle and `KILL_ON_JOB_CLOSE` terminated every member before the object went away; the object opening with zero active processes from `QueryInformationJobObject` is empty; nonzero is live; any other result is unknown. A daemon in a different Windows session, or a record without `osSession`, returns unknown and retains the record: `Local\` names are per session, and absence in another session is not evidence (Microsoft, kernel object namespaces). A same-name Job created after the supervisor died is a foreign object whose count is only diagnostic, because the supervisor's death retired the original generation by itself; the probe is consulted only after sealing, so an empty replacement cannot be mistaken for the original. Job membership binds processes created through `CreateProcess` inheritance and the attribute list; Microsoft documents that `Win32_Process.Create` does not associate, so the contract speaks of Job members, and a POSIX descendant that calls `setsid` leaves the group as V3 accepted.
- Ownership transitions and admission. `inert` records never block. While any record is `unknown`, `spawn`, `reserve`, `Reservation.spawn`, and `adopt` refuse, `ProviderRuntime.open` returns `{ ok: false, refusal }` with reason `owned-work-unverified` and the message 上次运行留下的 agent 进程尚未确认退出，暂不能启动新的 agent。请运行 doctor 查看。, `host/lifecycle` keeps its release gate closed, and no update completes. `Reservation.spawn` rechecks that rule and the host's closing state at the moment of `launch`, not only at `reserve`. The daemon still boots so that `doctor`, status, the admin surface, and the log can show the reservation, the stage, the pids, and the reason, but it starts no agent. `bound` moves to `unknown` when the holder exits without the record reaching `gone`, or when the identity has been reaped and the probe is not empty, and to `gone` when an exit fact or a no-provider fact and the proof both hold; `unknown` ends only through `gone`. A stale record is never deleted as a shortcut, a holder whose pid answers with a different start token is sealed but its record stays `unknown` until the probe is empty, which reverses #117's sweep, where a mismatch removed the record, and `UnconfirmedReason` on a snapshot is a diagnostic of one ending that admission never reads. A `process-owners.json` that does not parse as the union is `unknown` as a whole: admission refuses with `owned-work-unverified`, the file is never rewritten, and `doctor` shows its path until the operator moves it aside.
- `reserve(providerId, sessionId)` runs *Startup* through `armed` and resolves with a `Reservation`. `Reservation.spawn(spec): HostedProcess` is synchronous: it writes `attempting`, queues `launch`, and returns the handle at once, and `Reservation.adopt(options: SpawnOptions, extras?: { onStderr?: (chunk: string) => void }): HolderProcess` wraps the same call in the facade; `ready: Promise<void>` resolves at `running` and rejects with `launch-failed`, `cancelled` when the launch was ended before `go`, `holder-lost`, or `holder-not-ready`. `Reservation.release()` on a reservation whose `spawn` was never called queues `abandon`, on which the holder exits `never-launched`, and the record is retired. `ProcessHost.spawn()` for engines that own their command is `reserve`, `spawn`, then `await ready`; the returned `HostedProcess.stderr` belongs to that caller, who must keep reading it, because a provider that fills the pipe blocks before it exits. `closeAll()` releases every unused reservation before `owesWork()` is read, so an inert record never survives shutdown as a reusable authorization.
- `adopt()` is the Claude SDK path, built on the same reservation because the SDK's spawn hook is synchronous. The published 0.3.246 `sdk.d.ts` declares `spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess` (SDK:2181), with `SpawnOptions { command, args, cwd?, env, signal }` (SDK:7952-7962) and `SpawnedProcess { stdin: Writable; stdout: Readable; readonly killed; readonly exitCode; readonly signalCode?; kill(signal): boolean; on/once/off('exit' | 'error') }` (SDK:7900-7947). The bundled `ProcessTransport` calls the hook inside its own synchronous spawn path, assigns `stdin` and `stdout` at once, attaches `error` and `exit` listeners at once, and its `readMessages()` drains `stdout` and then `waitForExit()`, which rejects on an `error` event and otherwise waits for `exit`. Its `close()` ends stdin and, while `exitCode` is `null` and `killed` is false, after 2 s: on `win32` it waits 5 s more and calls `kill('SIGKILL')` if `exitCode` is still `null`, never `SIGTERM`; elsewhere it calls `kill('SIGTERM')` and 5 s later `kill('SIGKILL')` if `exitCode` is still `null`. Its process-exit tracker calls `stdin.end()` on `win32` and `kill('SIGTERM')` elsewhere. 6d rechecked this close path against the installed 0.3.296, whose `close()` also skips the delayed kills once `signalCode` is set and whose tracker forgets the process only on `exit`. The forwarded `options.signal` aborts only after that close path when the caller's own signal was aborted. The engine awaits `host.reserve()` before `query()` and passes `spawnClaudeCodeProcess: options => reservation.adopt(options)`. `HolderProcess implements SpawnedProcess` is an `EventEmitter` bound to one `ReservationId`: `stdin` is slot 3 and `stdout` is slot 4 on both platforms; `exitCode` and `signalCode` are `null` until an exit fact and then carry its values, `null` and `null` for `observed: 'containment'`; `killed` is `true` once a `term` or `kill` command was queued; `kill('SIGTERM')` queues `term`, `kill('SIGKILL')` queues `kill`, any other signal queues `term`, each joins `end(record)` and returns whether a command was queued, which is `false` once the record is terminal or the channel is closed, so a delayed SDK `SIGKILL` seven seconds after `close()` reaches a settled record and does nothing, and can never reach a replacement, because the facade holds the reservation id and not a pid; `on('exit')` fires once from the exit fact, preceded by a `holder-lost` error when the fact carries neither a code nor a nameable signal, as `observed: 'containment'` does, and the exit fact joins `end(record)`, because after an exit the SDK sends no further signal that would carry the record to `gone`; `on('error')` fires once with `code: 'transport-lost'` when the exit-report hold after slot 4's EOF ends with no exit fact, which the holder's closed copy makes possible and which rejects the SDK's `waitForExit` and unblocks `readMessages` without any fabricated exit, with `code: 'holder-lost'` when the holder exits before an exit fact, with `code: 'launch-failed'` on that receipt or when the ledger refused the `attempting` write, with the write error as `cause`, with `code: 'cancelled'` when a `kill` or an abort before `go` cancelled the launch, and with `code: 'holder-not-ready'` at the spawn deadline; `ready`, `exit`, and `error` raised before a listener is attached are buffered and replayed on the first `on` or `once` for that event; `options.signal` aborting queues `term`, and a signal already aborted when `adopt` is called never launches: the reservation is released and the facade raises `cancelled`, because Windows has no `go` fence and its `term` does nothing. The SDK's `SpawnedProcess` has no `stderr` and its custom-spawn branch never wires `options.stderr`, so the facade reads slot 5 from construction, decodes it as UTF-8, and passes each chunk to `extras.onStderr` when given, or drops it; provider stderr is never logged, since it can carry tokens, and never joins `stdout`. The runtime raises `transport-lost` from the same stdout EOF, and the engine's `JsonRpcPeer` closure on Codex and the ACP engines raises it likewise, so the SDK error and the runtime input are one event seen twice. `pid` is not part of the interface and the facade exposes none. The hook is required, not optional, and `features` records `claude.spawn-hook` as a probe.
- `terminateTree(ms)` then `killTree()` are the two kill effects of the turn machine. Each queues its command with a fresh nonce, feeds the validated receipt or its absence back as the `signal` input, and resolves on its own clock within its deadline whether or not a receipt arrived, with the `SignalResult` that `OwnedProcess.term()` and `kill()` return; how far the cleanup got after the receipt is the record's continuation below, and an ending that is not confirmed carries an `UnconfirmedReason` on the host's snapshot for `doctor` and the log, never as a turn input. Confirmed means an exit fact holds and the proof holds after the launcher is sealed. `killTree()` drives one idempotent continuation per record over two separate variables: the identity, `retained`, `reaped`, or `lost`, which is what the holder currently holds, and the phase, `signalling`, `observed`, `receipted`, `reaped`, `probed`, which is how far the physical cleanup has progressed. The next action is a function of both: while the identity is `retained` and no validated final `kill` receipt exists, resend `kill` with a fresh nonce, whether or not the exit has been observed, so a lost receipt after an observed exit is retried rather than stranded; once the observation and a validated final receipt both exist, send `reap <nonce>` and retry it until acknowledged, where the holder answers `reaped <nonce>` from its recorded state on every repeat after the first without any wait or further action, `not-ready <nonce>` before the observation, and never destroys anything; once `reaped`, send `probe <nonce>` and nothing else, and the holder answers `empty <nonce>`, `live <nonce>`, or `probe-unknown <nonce> <errno>`; once the identity is `lost`, the holder being gone, the record is `unknown` and only the daemon's own probe of `provider.pid` applies. A fact that arrives after the local deadline, the observation, the receipt, or the `reaped` acknowledgement, resumes the continuation from that step; the Run's `unconfirmed` outcome is unchanged by it. Neither rejects. An unconfirmed record stays owned: kept in the ledger, `owesWork()` `true`, retried below. A cleanup error after a confirmed exit is logged as residue and owes no work; residue is never written without the proof.
- `end(record)` is the host-owned termination of one exact record: `term`, `TERM_WAIT_MS`, `kill`, `KILL_CONFIRM_MS`, reap, probe, then the retry tail, every signal through the holder while it retains the identity and none afterwards. It is idempotent and joinable; a goal's process step, `Conversation.close()`, a late orphan, the facade's `kill` and abort, and `closeAll()` all join the same termination of the same record, and none of them can start a second one or reach a different record. After `gone` the host sends `exit <nonce>` and the holder exits 0; that retirement is logged and is not process work. `closeAll()` does not wait for that exit, so a holder, and on Windows its supervisor, can still hold `holder-logs/<id>.log` briefly after `closeAll()` resolves. Nothing in the daemon removes `holder-logs` or the data dir; a caller that ever does must first see each recorded holder pid gone or carrying another start token, as the provider test fixture does.
- The retry tail. An unconfirmed record is retried by the host alone, every 5 seconds, a policy figure, until `gone` or daemon exit, by resuming the continuation at its current identity and phase: `kill` while the identity is `retained` and no validated final receipt exists, including after the exit was observed; `reap`, repeated until acknowledged, once observed and receipted; `probe` only once `reaped`; it never probes a retained zombie, which would answer live forever, never signals after `reaped`, and on a `lost` identity only probes. An `unknown` record is only re-probed; nothing is ever signalled on its behalf, and no metadata read on the tail upgrades it to `bound`. The tail is observable through `owesWork()`, `doctor`, and the daemon log, and never blocks a run, a goal, or a control.
- Reap and continuation, the only reap sites. The holder reaps at three sites, each only after its own validated `WNOWAIT` observation of the child in question: on `reap <nonce>` for the provider; at the end of its daemon-death path for the provider; and for a stub that wrote `C` or a complete `E` frame, before writing `cancelled` or `launch-failed`. There is no fourth site and no blocking wait anywhere.
- Recovery. `sweepOrphans()` runs at daemon boot and on each retry of a record whose `daemonBootId` differs, and resolves each stage by the rules above: `intent` is retired with a log line, because no holder was ever authorized; `born` is retired once the holder is sealed and stays `inert` while it is alive or unsealable, since an inert holder on a dead command channel exits `never-launched` on its own; a POSIX `attempting` is `unknown` until the holder is sealed and then retired, because GO was never written; a Windows `attempting` is recovered as `running` through its Job name and session; `launched` and `running` probe `provider.pid` or the Job: `gone` when the launcher is sealed and the probe is empty, then the record is removed; never `bound`, on either platform, because no previous holder has a channel the new daemon can authenticate; anything else is kept as `unknown` with nothing signalled. The holder's daemon-death path keeps this honest: on command EOF after `go` it runs `term`, `TERM_WAIT_MS`, `kill`, then keeps observing until its `WNOWAIT` observation arrives, however long that takes, reaps, probes until empty, and exits, so the normal next boot finds `gone`; `TERM_WAIT_MS` plus twice `KILL_CONFIRM_MS` is the bound for a responsive tree, which is what Lane 10's fixture is, and not a promise about a tree in an uninterruptible state; a holder killed first leaves `unknown` work that blocks until its members die on their own. Daemon death is EOF on the inherited command channel on POSIX and EOF on the authenticated socket on Windows; `net.Server.close()` stops new connections and keeps accepted sockets open, so it is not the death signal, and the test for death closes the accepted socket itself.
- `owesWork()` answers `host/lifecycle` before a restart, replacing `unconfirmedCodexPids()`. It is `true` while any record is `bound` or `unknown` and has no live run or goal accounting for it, which covers unconfirmed snapshots and any `end(record)` in its ladder; `inert` records do not count once `closeAll()` has released them. A resolved `end()`, `stop()`, `closeAll()`, or `Conversation.close()` is not permission to release: the lifecycle release gate reads `owesWork()` after `closeAll()` resolves, and while it is `true` the daemon reports `owned_work_unconfirmed` with the reservations and pids, keeps its locks, and does not start a replacement or complete an update, as `host/lifecycle.ts` `closeOwnedProviders` does today. Local settlement of every run and goal is a separate fact from this gate.
- Native distribution. `vonvon-holder` is one C source file under `packages/daemon/native/holder/holder.c`, C11 with only libc, no threads, no third-party code, and no shell. It is built ahead of time, not at install: the daemon package ships `dist/native/<platform>-<arch>/vonvon-holder` for `darwin-arm64`, `darwin-x64`, `linux-x64`, and `linux-arm64`, produced by a prebuild job with `clang` on macOS and `gcc` on Linux that runs after tsup, because tsup's `clean: true` empties `dist/` first; the Linux binaries are linked against glibc with a helper floor of 2.17 and the macOS binaries are built for a deployment target of macOS 11, and both floors are below the floors of every Node release the daemon's `engines` admits, glibc 2.28 and macOS 11 for Node 22, 13.5 for Node 24 and 26 per Node's platform list, so the effective product support is Node's and the helper narrows nothing; an architecture or libc outside the four targets fails `ProcessHost.available` explicitly and is never reported as supported. The macOS binaries are signed and notarized by the Mac packaging pipeline, and the per-binary SHA256 manifest `dist/native/manifest.json` is written as the last step after signing, over the final shipped bytes, so that a signature applied after hashing cannot make the shipped binary fail the check; the Mac integration owner, Codex, owns the prebuild, signing, staging, and the artifact tests, none of which exist in the checkout today. Tests do not wait for the prebuild: the native test cases compile `holder.c` with the runner's `cc` into a temporary directory, and the macOS and Linux CI runners and both development hosts have one. `ProcessHost.available` checks the manifest together with the executable bit; a missing or mismatching binary fails availability, `doctor` reports it, and no spawn happens; there is no source build at install time and no download. The resolver is `new URL('./native/<platform>-<arch>/vonvon-holder', import.meta.url)` from the three tsup entries, which all sit at the top of `dist/`, so it resolves to the same file from each; a packaging test asserts the four binaries and the manifest in the built `dist`, the packed tarball, and the staged desktop payload. The Windows supervisor and probe need no new file; their C# source is embedded in `windows-job.ts` as today, and `PROC_THREAD_ATTRIBUTE_JOB_LIST` requires Windows 10 or Windows Server 2016 per Microsoft's attribute documentation, so `ProcessHost.available` fails on older Windows with no suspended-create downgrade; the floor is Windows 10 and Windows Server 2016, the same floor Node 22's platform list sets, so the attribute narrows nothing. A Node-API addon was considered and rejected: the parent must be a separate process that survives the daemon, and an addon would make the daemon the parent. The former `group-leader.mjs` is withdrawn.
- Trust boundary, stated. Everything above trusts the kernel, the daemon's own child handles, and the holder's standing as the provider's retaining parent, and nothing a same-user process can forge: the POSIX group signal is bound by the unreaped child, the Windows socket by the token and the child-pid check, the Job by exclusive creation and atomic assignment, and the exit facts by the parent's wait or by sealed containment. Same-user code can still leave the POSIX group with `setsid`, which V3 accepted as outside observation; connect to the pipe, which the token rejects; create a same-name Job before the supervisor, which the supervisor detects and refuses without touching it; create a same-name Job after the supervisor died, which the probe reports as unknown; and read the supervisor's memory, which no user-mode design prevents. This design relaxes nothing V3 promised and adds no reliance on metadata for any signal; the liveness reads it uses at recovery release nothing by themselves.
- Platform limitations, stated. A POSIX holder that is killed or crashes loses the retained identity to init, which reaps it; from then on the record is `unknown`, nothing is signalled, and only the probe can end it; the daemon-death lane is unaffected because the holder survives the daemon, but a lane that kills the holder cannot show cleanup and is not claimed. After the holder's own reap no destructive signal exists; survivors of `SIGKILL` are probed, not re-signalled. Windows has no graceful rung, and a Windows record is recoverable only from the Windows session that created it. Neither limitation is hidden behind a fake, and the native lanes in `plan.md` stay open until the real holder passes them.
- Legacy records. `<dataDir>/owned-pids.json` was written only by unreleased #117 builds; `main` never wrote it. Its records are legacy because of the file they sit in. They are never signalled, never matched against a start token, because their `startedAtMs` may come from `Date.now()`, and never block admission. `doctor` lists each as `legacy` until the host has rebooted since its `startedAtMs`, with the boot time read as `Date.now() - os.uptime() * 1000`; it is then removed, and the file is deleted once empty.
- Decisions settled in V6a PR 5. First, the native holder: a C11, libc-only POSIX executable with the four prebuilt targets and floors above. The alternative, a Node holder with a post-reap fail-closed guard, keeps every record `unknown` once a provider exits with survivors, so it cannot deliver the same-group cleanup V3 promised. Second, the Windows floor for `PROC_THREAD_ATTRIBUTE_JOB_LIST` is Windows 10 and Server 2016; suspended creation then `AssignProcessToJobObject` reopens the unassigned interval and is rejected. Third, a Windows record is recoverable only from its own session and is `unknown` elsewhere; a `Global\` name with an explicit security descriptor is not adopted. Fourth, the holder identity is an opaque start token, not epoch milliseconds, because Linux `btime` moves by a second between reads and only `boot_id` with the tick count is exact.
- Code ownership. PR 5 lands the shapes and the pure rules: `process/ledger.ts` (the record union, stage order, `ownershipOf`, the file codec, the legacy rule), `process/identity.ts` (the start-token reader and the host boot time), `process/holder-protocol.ts` (command framing, the incremental receipt parser, and receipt validation into `SignalResult`), and `process/exit-hold.ts` (the exit-report hold as a pure step function). PR 6 is three PRs. 6a lands `holder.c`. 6b lands the Windows supervisor in `process/windows-supervisor.ts`, `process/windows-command-line.ts`, and `process/holder-channel.ts`, which spawns either holder, checks its `hello`, and gives the host one command and receipt channel on both platforms. 6c lands `ProcessHost` in `process/process-host.ts`: `reserve`, `Reservation.spawn` and `release`, `spawn`, `end(record)` with the continuation and the retry tail, `owesWork`, `closeAll`, `snapshot` for `doctor`, admission with `owned-work-unverified`, `sweepOrphans` with the Windows recovery probe, `fake-child.mjs`, and the boot sweep with the env-gated hook Lane 10 drives. 6d lands the `HolderProcess` facade that implements the Claude SDK's `SpawnedProcess` over a hosted process, and `adopt`. Neither PR moves a consumer: `host/lifecycle.ts`, `bot/handle-message.ts`, and today's `agent/codex-appserver/owned-process.ts` and `windows-job.ts` stay until the V6b cut-over, as V6a's *Build* box requires.

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
| owned-work-unverified | 上次运行留下的 agent 进程尚未确认退出，暂不能启动新的 agent。请运行 doctor 查看。 |

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

A 子 agent row shows a status icon, the task, `N 步`, elapsed time, and the current step. Its collapsible panel holds the last 5 steps and the result. In the panel, a 查看完整过程 button posts a separate card with the ledger history, up to 200 steps. In s34b, the conversation panel shows a 停止 button for each running, stoppable row and calls `AgentRun.stopSubagent(id)`; unsupported or finished tasks reject with a reason. The current implementation has no `features.subagentStop` field. Current s35 run cards show 8 complete rows and page active overflow in groups of 24, with stable panel and stop identities. The section uses at most 84 components and subtracts them, including panel header overhead, from the existing process budget. Plain and terminal cards show every remaining active identity without controls. Ordinary Codex runs defer done until children settle; goal runs carry live rows and restore known identities on reuse. Child questions retain their origin, placement, and existing authorization. The ledger-history button and allocation table above describe the future provider runtime, not the current s35 card. A row settled `interrupted` reads 已停止 when the provider has a per-subagent stop, and 已随主任务中断 when it does not, because the row is roster state and no one addressed that child; whether its process ended is the main outcome's `tree` fact, and with `tree: 'unconfirmed'` the row adds 进程尚未确认退出.

A worst-case fixture, 6 running plus 3 completed subagents at every cap, 50 todo items, 40 tool rows, 2 compaction markers, 4 notice kinds, a 1,500-byte reasoning text, a 10,000-byte answer, 12 images, and every string at its cap, must render under both whole-card limits and under each area's allocation after the pass-through rule. Over-budget content is cut by the rule of its area and marked, never silently.

Outcome notes.

| outcome | note |
|---|---|
| interrupted user, tree live | ⏹ 已停止 |
| interrupted user, tree not live | ⏹ 已强制停止（agent 未响应，{tree}） |
| interrupted watchdog, tree live | ⏱ 超过 N 分钟没有任何进展，已自动停止 |
| interrupted watchdog, tree not live | ⏱ 超过 N 分钟没有任何进展，已自动停止（agent 未响应，{tree}） |
| {tree} | signalled 已向其进程组发出结束信号，exited 其进程已退出，unconfirmed 进程尚未确认退出，Vonvon 会继续清理 |
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

Verdict items on the audit that this design fixes. D marked Grok todo as native; the fixtures show no `plan` update, so it is `none` pending `grok.three-turns`. D had no per-subagent stop for Claude; `stopTask` is native. Codex child threads are registered from `thread/started`, spawn `collabAgentToolCall.receiverThreadIds`, or code-mode `subAgentActivity` items. Parent spawn calls keep one process row; child `item/*` notifications feed the separate step stream.

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
