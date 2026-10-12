import { describe, expect, it } from 'vitest';
import type { TurnId } from '../../src/provider/model';
import type { StopProfile } from '../../src/provider/engines/engine';
import { stepTurn, type Effect, type TurnInput, type TurnState } from '../../src/provider/runtime/turn-machine';

const codex: StopProfile = { needsTurnId: true, openWaitMs: 5000, graceMs: 5000 };
const claude: StopProfile = { needsTurnId: false, openWaitMs: 0, graceMs: 3000 };
const first = 'turn-1' as TurnId;
const second = 'turn-2' as TurnId;

function drive(initial: TurnState, profile: StopProfile, entries: { at: number; input: TurnInput }[]) {
  let state = initial;
  const effects: Effect[] = [];
  for (const { at, input } of entries) {
    const result = stepTurn(state, input, profile, at);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

describe('turn stop ladder', () => {
  it('waits for the first turn id, interrupts on arrival, then escalates against grace', () => {
    const result = drive({ phase: 'opening' }, codex, [
      { at: 100, input: { kind: 'stop', by: 'user' } },
      { at: 5100, input: { kind: 'tick' } },
    ]);
    expect(result.effects).toEqual([
      { kind: 'stop-subagents' }, { kind: 'arm', at: 5100 },
      { kind: 'term-tree' }, { kind: 'arm', at: 6600 },
    ]);

    const arriving = drive({ phase: 'opening' }, codex, [
      { at: 100, input: { kind: 'stop', by: 'user' } },
      { at: 5099, input: { kind: 'started', turnId: first } },
      { at: 10099, input: { kind: 'tick' } },
      { at: 11599, input: { kind: 'tick' } },
    ]);
    expect(arriving.effects).toEqual([
      { kind: 'stop-subagents' }, { kind: 'arm', at: 5100 },
      { kind: 'interrupt', turnId: first }, { kind: 'arm', at: 10099 },
      { kind: 'term-tree' }, { kind: 'arm', at: 11599 }, { kind: 'kill-tree' },
    ]);
  });

  it('reaches TERM and KILL even if started never arrives', () => {
    const result = drive({ phase: 'opening' }, codex, [
      { at: 0, input: { kind: 'stop', by: 'watchdog' } },
      { at: 4999, input: { kind: 'tick' } },
      { at: 5000, input: { kind: 'tick' } },
      { at: 6500, input: { kind: 'tick' } },
      { at: 7000, input: { kind: 'tick' } },
    ]);
    expect(result.effects).toEqual([
      { kind: 'stop-subagents' }, { kind: 'arm', at: 5000 },
      { kind: 'term-tree' }, { kind: 'arm', at: 6500 }, { kind: 'kill-tree' },
    ]);
    expect(result.state.signalled).toBe(true);
    expect(result.state.deadline).toBeUndefined();
  });

  it('interrupts a provider that needs no turn id immediately and keeps the first stop owner', () => {
    const result = drive({ phase: 'opening' }, claude, [
      { at: 10, input: { kind: 'stop', by: 'user' } },
      { at: 11, input: { kind: 'stop', by: 'daemon' } },
      { at: 12, input: { kind: 'verdict', verdict: { kind: 'cancelled' } } },
      { at: 13, input: { kind: 'exit', code: 1, signal: null } },
      { at: 14, input: { kind: 'stop', by: 'watchdog' } },
    ]);
    expect(result.effects).toEqual([
      { kind: 'stop-subagents' }, { kind: 'interrupt', turnId: undefined },
      { kind: 'arm', at: 3010 },
      { kind: 'outcome', outcome: { state: 'interrupted', by: 'user', forced: false } },
    ]);
    expect(result.state.phase).toBe('settled');
  });

  it.each(['user', 'watchdog', 'daemon'] as const)('reports a forced %s stop after TERM and exit', by => {
    const result = drive({ phase: 'running', turnId: first }, codex, [
      { at: 20, input: { kind: 'stop', by } },
      { at: 5020, input: { kind: 'tick' } },
      { at: 5021, input: { kind: 'exit', code: null, signal: 'SIGTERM' } },
      { at: 6520, input: { kind: 'tick' } },
    ]);
    expect(result.effects.at(-1)).toEqual({ kind: 'outcome', outcome: { state: 'interrupted', by, forced: true } });
    expect(result.effects.filter(effect => effect.kind === 'outcome')).toHaveLength(1);
  });

  it('fails on an unrequested process exit and marks a native cancel as agent initiated', () => {
    expect(stepTurn({ phase: 'running', turnId: first }, { kind: 'exit', code: 7, signal: null }, codex, 1).effects)
      .toEqual([{ kind: 'outcome', outcome: { state: 'failed', failure: { kind: 'process-exit', code: 7, signal: null } } }]);
    expect(stepTurn({ phase: 'running', turnId: first }, { kind: 'verdict', verdict: { kind: 'cancelled' } }, codex, 1).effects)
      .toEqual([{ kind: 'outcome', outcome: { state: 'interrupted', by: 'agent', forced: false } }]);
  });

  it('keeps a single outcome when a verdict and process exit race the stop', () => {
    const result = drive({ phase: 'running', turnId: first }, codex, [
      { at: 1, input: { kind: 'stop', by: 'user' } },
      { at: 2, input: { kind: 'verdict', verdict: { kind: 'completed' } } },
      { at: 3, input: { kind: 'exit', code: 0, signal: null } },
    ]);
    expect(result.effects.filter(effect => effect.kind === 'outcome'))
      .toEqual([{ kind: 'outcome', outcome: { state: 'completed' } }]);
  });

  it('ignores a conflicting second started id and late started after the open deadline', () => {
    const running = stepTurn({ phase: 'running', turnId: first }, { kind: 'started', turnId: second }, codex, 2);
    expect(running).toEqual({ state: { phase: 'running', turnId: first }, effects: [] });

    const late = drive({ phase: 'opening' }, codex, [
      { at: 0, input: { kind: 'stop', by: 'user' } },
      { at: 5000, input: { kind: 'started', turnId: first } },
    ]);
    expect(late.effects).toEqual([
      { kind: 'stop-subagents' }, { kind: 'arm', at: 5000 },
      { kind: 'term-tree' }, { kind: 'arm', at: 6500 },
    ]);
    expect(late.state.turnId).toBe(first);
  });

  it('gives TERM its full wait after a delayed tick and waits for an exit to settle', () => {
    const result = drive({ phase: 'running', turnId: first }, codex, [
      { at: 0, input: { kind: 'stop', by: 'user' } },
      { at: 7000, input: { kind: 'tick' } },
      { at: 8499, input: { kind: 'tick' } },
      { at: 8500, input: { kind: 'tick' } },
    ]);
    expect(result.effects.slice(-3)).toEqual([
      { kind: 'term-tree' }, { kind: 'arm', at: 8500 }, { kind: 'kill-tree' },
    ]);
    expect(result.state.phase).toBe('stopping');
    expect(result.effects.filter(effect => effect.kind === 'outcome')).toHaveLength(0);
  });

  it('leaves input state untouched', () => {
    const state: TurnState = Object.freeze({ phase: 'running', turnId: first });
    const result = stepTurn(state, { kind: 'stop', by: 'daemon' }, codex, 0);
    expect(state).toEqual({ phase: 'running', turnId: first });
    expect(result.state).not.toBe(state);
  });
});
