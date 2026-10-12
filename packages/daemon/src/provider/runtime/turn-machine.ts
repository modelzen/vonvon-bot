import type { Outcome, StopBy, TurnId } from '../model';
import { TERM_WAIT_MS, type StopProfile, type TurnVerdict } from '../engines/engine';

export type TurnPhase = 'opening' | 'running' | 'stopping' | 'settled';
export interface TurnState { phase: TurnPhase; turnId?: TurnId; stopRequested?: { by: StopBy; at: number }; signalled?: boolean; deadline?: number; verdict?: TurnVerdict }
export type TurnInput =
  | { kind: 'started'; turnId: TurnId } | { kind: 'verdict'; verdict: TurnVerdict }
  | { kind: 'stop'; by: StopBy } | { kind: 'tick' } | { kind: 'exit'; code: number | null; signal: string | null };
export type Effect =
  | { kind: 'stop-subagents' } | { kind: 'interrupt'; turnId?: TurnId } | { kind: 'term-tree' } | { kind: 'kill-tree' }
  | { kind: 'arm'; at: number } | { kind: 'outcome'; outcome: Outcome };

function outcomeFor(verdict: TurnVerdict, state: TurnState): Outcome {
  switch (verdict.kind) {
    case 'completed': return { state: 'completed' };
    case 'failed': return { state: 'failed', failure: verdict.failure };
    case 'cancelled': return { state: 'interrupted', by: state.stopRequested?.by ?? 'agent', forced: state.signalled ?? false };
    case 'exit':
      return state.stopRequested
        ? { state: 'interrupted', by: state.stopRequested.by, forced: state.signalled ?? false }
        : { state: 'failed', failure: { kind: 'process-exit', code: verdict.code, signal: verdict.signal } };
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function escalate(state: TurnState, now: number): { state: TurnState; effects: Effect[] } {
  if (state.deadline === undefined || now < state.deadline) return { state, effects: [] };
  if (state.signalled) return { state: { ...state, deadline: undefined }, effects: [{ kind: 'kill-tree' }] };

  const deadline = now + TERM_WAIT_MS;
  const next: TurnState = { ...state, signalled: true, deadline };
  return { state: next, effects: [{ kind: 'term-tree' }, { kind: 'arm', at: deadline }] };
}

export function stepTurn(state: TurnState, input: TurnInput, profile: StopProfile, now: number): { state: TurnState; effects: Effect[] } {
  if (state.phase === 'settled') return { state, effects: [] };

  switch (input.kind) {
    case 'started': {
      if (state.turnId !== undefined) return { state, effects: [] };
      if (state.phase === 'stopping' && state.deadline !== undefined && now >= state.deadline) {
        const escalated = escalate(state, now);
        return { state: { ...escalated.state, turnId: input.turnId }, effects: escalated.effects };
      }
      if (state.phase === 'stopping' && profile.needsTurnId && !state.signalled) {
        const deadline = now + profile.graceMs;
        return {
          state: { ...state, turnId: input.turnId, deadline },
          effects: [{ kind: 'interrupt', turnId: input.turnId }, { kind: 'arm', at: deadline }],
        };
      }
      return { state: { ...state, phase: state.phase === 'opening' ? 'running' : state.phase, turnId: input.turnId }, effects: [] };
    }
    case 'stop': {
      if (state.stopRequested) return { state, effects: [] };
      const stopRequested = { by: input.by, at: now };
      const deadline = now + (profile.needsTurnId && state.turnId === undefined ? profile.openWaitMs : profile.graceMs);
      const effects: Effect[] = [{ kind: 'stop-subagents' }];
      if (!profile.needsTurnId || state.turnId !== undefined) effects.push({ kind: 'interrupt', turnId: state.turnId });
      effects.push({ kind: 'arm', at: deadline });
      return { state: { ...state, phase: 'stopping', stopRequested, deadline }, effects };
    }
    case 'tick': {
      if (state.phase !== 'stopping') return { state, effects: [] };
      return escalate(state, now);
    }
    case 'verdict': {
      const outcome = outcomeFor(input.verdict, state);
      return { state: { ...state, phase: 'settled', deadline: undefined, verdict: input.verdict }, effects: [{ kind: 'outcome', outcome }] };
    }
    case 'exit': {
      const verdict: TurnVerdict = { kind: 'exit', code: input.code, signal: input.signal };
      const outcome = outcomeFor(verdict, state);
      return { state: { ...state, phase: 'settled', deadline: undefined, verdict }, effects: [{ kind: 'outcome', outcome }] };
    }
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}
