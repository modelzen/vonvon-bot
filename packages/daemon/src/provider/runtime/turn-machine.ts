import type { Outcome, StopBy, TreeFate, TurnId } from '../model';
import {
  KILL_CONFIRM_MS, TERM_WAIT_MS, type ExitFact, type SignalResult, type StopProfile, type TurnVerdict,
} from '../engines/engine';

/** The escalation stage the machine has issued. Only the machine advances it; a receipt never does. */
export type Rung = 'await-turn' | 'interrupt' | 'term' | 'kill';

export type TurnState =
  | { phase: 'opening' }
  | { phase: 'running'; turnId: TurnId }
  /** deadline is absolute and belongs to rung. signalled is set only by a `sent` receipt for an issued rung. */
  | { phase: 'stopping'; turnId?: TurnId; by: StopBy; rung: Rung; deadline: number; signalled: boolean }
  | { phase: 'settled'; turnId?: TurnId; outcome: Outcome };

export type TurnInput =
  | { kind: 'started'; turnId: TurnId } | { kind: 'verdict'; verdict: TurnVerdict } | { kind: 'stop'; by: StopBy } | { kind: 'tick' }
  | { kind: 'signal'; rung: 'term' | 'kill'; result: SignalResult }   // the receipt of a term() or kill() call
  | { kind: 'exit'; exit: ExitFact } | { kind: 'transport-lost' };     // facts from OwnedProcess.watch

/** Commands to the outside. Timers and the outcome are not effects: the shell derives both from the state. */
export type Effect = { kind: 'stop-subagents' } | { kind: 'interrupt'; turnId?: TurnId } | { kind: 'term-tree' } | { kind: 'kill-tree' };

export interface Transition { state: TurnState; effects: Effect[] }

type Live = Exclude<TurnState, { phase: 'settled' }>;
type LivePhase = Live['phase'];
// Mapped over their keys so `ON[phase][kind]` stays correlated with its arguments without a cast (TS #47109).
type StateOf = { [P in LivePhase]: Extract<TurnState, { phase: P }> };
type Stopping = StateOf['stopping'];
type InputKind = TurnInput['kind'];
type InputOf = { [K in InputKind]: Extract<TurnInput, { kind: K }> };
interface Ctx { profile: StopProfile; now: number }
type Row<P extends LivePhase> = { [K in InputKind]?: (state: StateOf[P], input: InputOf[K], ctx: Ctx) => Transition };

/** Each next deadline is the passed one plus `wait`, so a late tick replays the schedule instead of restarting it. */
const LADDER: Record<Rung, { emit: 'term-tree' | 'kill-tree'; next: 'term' | 'kill'; wait: number } | 'settle-unconfirmed'> = {
  'await-turn': { emit: 'term-tree', next: 'term', wait: TERM_WAIT_MS },
  interrupt: { emit: 'term-tree', next: 'term', wait: TERM_WAIT_MS },
  term: { emit: 'kill-tree', next: 'kill', wait: KILL_CONFIRM_MS },
  kill: 'settle-unconfirmed',
};

const TRANSPORT_LOST: Outcome = { state: 'failed', failure: { kind: 'transport-lost' } };

/** A missing cell means the input is ignored. */
const ON: { [P in LivePhase]: Row<P> } = {
  opening: {
    started: (_s, i) => ({ state: { phase: 'running', turnId: i.turnId }, effects: [] }),
    stop: (_s, i, ctx) => beginStop(undefined, i.by, ctx),
    verdict: (s, i) => settle(s, byVerdict(s, i.verdict)),
    exit: (s, i) => settle(s, processExit(i.exit)),
    'transport-lost': s => settle(s, TRANSPORT_LOST),
  },
  running: {
    stop: (s, i, ctx) => beginStop(s.turnId, i.by, ctx),
    verdict: (s, i) => settle(s, byVerdict(s, i.verdict)),
    exit: (s, i) => settle(s, processExit(i.exit)),
    'transport-lost': s => settle(s, TRANSPORT_LOST),
  },
  stopping: {
    started: (s, i, ctx) => startedWhileStopping(s, i.turnId, ctx),
    tick: (s, _i, ctx) => escalateOverdue(s, [], ctx.now),
    verdict: (s, i) => settle(s, byVerdict(s, i.verdict)),
    signal: (s, i) => ({ state: i.result === 'sent' && issued(s.rung, i.rung) ? { ...s, signalled: true } : s, effects: [] }),
    // Only the ladder and an exit fact can say what happened to the tree, so a lost stream changes nothing here.
    exit: s => settle(s, { state: 'interrupted', by: s.by, tree: 'exited' }),
  },
};

export function stepTurn(state: TurnState, input: TurnInput, profile: StopProfile, now: number): Transition {
  if (state.phase === 'settled') return { state, effects: [] };
  return dispatch(state.phase, state, input.kind, input, { profile, now });
}

function dispatch<P extends LivePhase, K extends InputKind>(
  phase: P, state: StateOf[P], kind: K, input: InputOf[K], ctx: Ctx,
): Transition {
  const row: Row<P> = ON[phase];
  const handler = row[kind];
  return handler ? handler(state, input, ctx) : { state, effects: [] };
}

/** The one timer the shell keeps. undefined outside stopping. */
export function deadlineOf(state: TurnState): number | undefined {
  return state.phase === 'stopping' ? state.deadline : undefined;
}

function beginStop(turnId: TurnId | undefined, by: StopBy, { profile, now }: Ctx): Transition {
  if (profile.needsTurnId && turnId === undefined) {
    return {
      state: { phase: 'stopping', by, rung: 'await-turn', deadline: now + profile.openWaitMs, signalled: false },
      effects: [{ kind: 'stop-subagents' }],
    };
  }
  return {
    state: { phase: 'stopping', turnId, by, rung: 'interrupt', deadline: now + profile.graceMs, signalled: false },
    effects: [{ kind: 'stop-subagents' }, { kind: 'interrupt', turnId }],
  };
}

function startedWhileStopping(s: Stopping, turnId: TurnId, { profile, now }: Ctx): Transition {
  if (s.turnId !== undefined) return { state: s, effects: [] };
  const recorded: Stopping = { ...s, turnId };
  if (s.rung !== 'await-turn') return { state: recorded, effects: [] };
  // An overdue started takes the deadline branch: interrupting now would push the bound past its schedule.
  if (now >= s.deadline) return escalateOverdue(recorded, [], now);
  return {
    state: { ...recorded, rung: 'interrupt', deadline: now + profile.graceMs },
    effects: [{ kind: 'interrupt', turnId }],
  };
}

function escalateOverdue(s: Stopping, effects: Effect[], now: number): Transition {
  if (now < s.deadline) return { state: s, effects };
  const step = LADDER[s.rung];
  if (step === 'settle-unconfirmed') return settle(s, { state: 'interrupted', by: s.by, tree: 'unconfirmed' }, effects);
  return escalateOverdue({ ...s, rung: step.next, deadline: s.deadline + step.wait }, [...effects, { kind: step.emit }], now);
}

function issued(current: Rung, receipt: 'term' | 'kill'): boolean {
  return receipt === 'term' ? current === 'term' || current === 'kill' : current === 'kill';
}

function byVerdict(s: Live, verdict: TurnVerdict): Outcome {
  switch (verdict.kind) {
    case 'completed': return { state: 'completed' };
    case 'failed': return { state: 'failed', failure: verdict.failure };
    case 'cancelled': return { state: 'interrupted', by: s.phase === 'stopping' ? s.by : 'agent', tree: treeOf(s) };
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function treeOf(s: Live): TreeFate {
  return s.phase === 'stopping' && s.signalled ? 'signalled' : 'live';
}

function processExit(exit: ExitFact): Outcome {
  return exit.observed === 'parent'
    ? { state: 'failed', failure: { kind: 'process-exit', code: exit.code, signal: exit.signal } }
    : { state: 'failed', failure: { kind: 'process-exit', code: null, signal: null } };
}

function settle(s: Live, outcome: Outcome, effects: Effect[] = []): Transition {
  return { state: { phase: 'settled', turnId: s.phase === 'opening' ? undefined : s.turnId, outcome }, effects };
}
