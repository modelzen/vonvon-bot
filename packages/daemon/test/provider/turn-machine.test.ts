import { describe, expect, it } from 'vitest';
import { stopBoundMs, type SignalResult, type StopProfile } from '../../src/provider/engines/engine';
import type { StopBy, TurnId } from '../../src/provider/model';
import { deadlineOf, stepTurn, type Effect, type TurnInput, type TurnState } from '../../src/provider/runtime/turn-machine';

const codex: StopProfile = { needsTurnId: true, openWaitMs: 5000, graceMs: 5000 };
const claude: StopProfile = { needsTurnId: false, openWaitMs: 0, graceMs: 3000 };
const turnId = 'turn-1' as TurnId;
const other = 'turn-2' as TurnId;

type Stopping = Extract<TurnState, { phase: 'stopping' }>;
const opening: TurnState = { phase: 'opening' };
const running: TurnState = { phase: 'running', turnId };
const stopping = (over: Partial<Stopping> = {}): Stopping =>
  ({ phase: 'stopping', turnId, by: 'user', rung: 'interrupt', deadline: 3000, signalled: false, ...over });
const awaiting = stopping({ turnId: undefined, rung: 'await-turn', deadline: 5000 });
const interrupted = (tree: string, by: StopBy = 'user') => ({ phase: 'settled', outcome: { state: 'interrupted', by, tree } });

const stop: TurnInput = { kind: 'stop', by: 'user' };
const tick: TurnInput = { kind: 'tick' };
const started: TurnInput = { kind: 'started', turnId };
const cancelled: TurnInput = { kind: 'verdict', verdict: { kind: 'cancelled' } };
const exited: TurnInput = { kind: 'exit', exit: { observed: 'containment' } };
const lost: TurnInput = { kind: 'transport-lost' };
const signal = (rung: 'term' | 'kill', result: SignalResult): TurnInput => ({ kind: 'signal', rung, result });
const SUB: Effect = { kind: 'stop-subagents' };
const INT: Effect = { kind: 'interrupt', turnId };
const TERM: Effect = { kind: 'term-tree' };
const KILL: Effect = { kind: 'kill-tree' };

function drive(profile: StopProfile, from: TurnState, steps: [number, TurnInput][]) {
  let state = from;
  const effects: Effect[] = [];
  for (const [at, input] of steps) {
    const next = stepTurn(state, input, profile, at);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

type Row = [name: string, profile: StopProfile, from: TurnState, steps: [number, TurnInput][], effects: Effect[], state: object];
const rows: Row[] = [
  ['opening: started runs the turn', claude, opening, [[0, started]], [], running],
  ['opening: stop on needsTurnId waits for the id', codex, opening, [[100, stop]], [SUB], { phase: 'stopping', rung: 'await-turn', deadline: 5100, signalled: false }],
  ['opening: stop without needsTurnId interrupts at once', claude, opening, [[100, stop]], [SUB, { kind: 'interrupt', turnId: undefined }], { rung: 'interrupt', deadline: 3100 }],
  ['running: a second started is ignored', claude, running, [[0, { kind: 'started', turnId: other }]], [], running],
  ['running: stop interrupts by id, stop-subagents first', codex, running, [[100, stop]], [SUB, INT], stopping({ deadline: 5100 })],
  ['stopping: stop keeps the first by', claude, stopping({ by: 'watchdog' }), [[2000, { kind: 'stop', by: 'daemon' }]], [], stopping({ by: 'watchdog' })],
  ['stopping: started before the open deadline interrupts; grace runs from it', codex, awaiting, [[4000, started]], [INT], stopping({ deadline: 9000 })],
  ['stopping: an overdue started takes the deadline branch', codex, awaiting, [[5000, started]], [TERM], stopping({ rung: 'term', deadline: 6500 })],
  ['stopping: started in rung interrupt only records the id', claude, stopping({ turnId: undefined }), [[100, started]], [], stopping()],
  ['stopping: started in rung term only records the id', claude, stopping({ turnId: undefined, rung: 'term' }), [[100, started]], [], stopping({ rung: 'term' })],
  ['stopping: started in rung kill only records the id', claude, stopping({ turnId: undefined, rung: 'kill' }), [[100, started]], [], stopping({ rung: 'kill' })],
  ['stopping: started naming a second turn is ignored', claude, stopping(), [[100, { kind: 'started', turnId: other }]], [], stopping()],
  ['ladder: every rung at its deadline, then unconfirmed', claude, running, [[0, stop], [2999, tick], [3000, tick], [4500, tick], [6499, tick], [6500, tick]], [SUB, INT, TERM, KILL], interrupted('unconfirmed')],
  ['ladder: await-turn reaches term-tree at the open deadline', codex, opening, [[0, stop], [5000, tick], [6500, tick]], [SUB, TERM, KILL], { rung: 'kill', deadline: 8500 }],
  ['ladder: a late tick does not push the next deadline', claude, running, [[0, stop], [3200, tick]], [SUB, INT, TERM], { rung: 'term', deadline: 4500 }],
  ['ladder: one late tick emits every overdue effect in order', claude, running, [[0, stop], [5000, tick]], [SUB, INT, TERM, KILL], { rung: 'kill', deadline: 6500 }],
  ['ladder: a tick between grace and term emits only term-tree', claude, running, [[0, stop], [4000, tick]], [SUB, INT, TERM], { rung: 'term', deadline: 4500 }],
  ['ladder: a very late tick settles in the same step', codex, opening, [[0, stop], [4000, started], [99_999, tick]], [SUB, INT, TERM, KILL], interrupted('unconfirmed')],
  ['ladder: a last-moment started on codex settles by 13.499 s', codex, opening, [[0, stop], [4999, started], [9999, tick], [11_499, tick], [13_499, tick]], [SUB, INT, TERM, KILL], interrupted('unconfirmed')],
  ['signal: term sent in rung term sets signalled', claude, stopping({ rung: 'term' }), [[0, signal('term', 'sent')]], [], { signalled: true }],
  ['signal: a late term sent in rung kill sets signalled', claude, stopping({ rung: 'kill' }), [[0, signal('term', 'sent')]], [], { signalled: true }],
  ['signal: kill sent in rung kill sets signalled', claude, stopping({ rung: 'kill' }), [[0, signal('kill', 'sent')]], [], { signalled: true }],
  ['signal: term sent before term-tree was issued is ignored', claude, stopping(), [[0, signal('term', 'sent')]], [], stopping()],
  ['signal: kill sent before kill-tree was issued is ignored', claude, stopping({ rung: 'term' }), [[0, signal('kill', 'sent')]], [], stopping({ rung: 'term' })],
  ...(['refused', 'accepted', 'unknown'] as const).map((result): Row =>
    [`signal: term ${result} leaves signalled unset`, claude, stopping({ rung: 'kill' }), [[0, signal('term', result)]], [], stopping({ rung: 'kill' })]),
  ['tree: cancel after term-tree with no receipt is live', claude, running, [[0, stop], [3000, tick], [3100, cancelled]], [SUB, INT, TERM], interrupted('live')],
  ...(['refused', 'accepted', 'unknown'] as const).map((result): Row =>
    [`tree: cancel after receipt ${result} is live`, claude, running, [[0, stop], [3000, tick], [3050, signal('term', result)], [3100, cancelled]], [SUB, INT, TERM], interrupted('live')]),
  ['tree: cancel after a sent receipt is signalled', claude, running, [[0, stop], [3000, tick], [3050, signal('term', 'sent')], [3100, cancelled]], [SUB, INT, TERM], interrupted('signalled')],
  ['tree: completed after interrupt stays completed', claude, running, [[0, stop], [100, { kind: 'verdict', verdict: { kind: 'completed' } }]], [SUB, INT], { outcome: { state: 'completed' } }],
  ['tree: failed while stopping keeps its failure', claude, stopping({ signalled: true }), [[0, { kind: 'verdict', verdict: { kind: 'failed', failure: { kind: 'refused' } } }]], [], { outcome: { state: 'failed', failure: { kind: 'refused' } } }],
  ...(['user', 'watchdog', 'daemon'] as const).flatMap(by => [[], [signal('term', 'sent')], [signal('term', 'refused')]].map((receipts, i): Row =>
    [`tree: exit while stopping by ${by} is exited (receipts ${i})`, claude, running, [[0, { kind: 'stop', by }], [3000, tick], ...receipts.map((r): [number, TurnInput] => [3100, r]), [3200, exited]], [SUB, INT, TERM], interrupted('exited', by)])),
  ['transport-lost while stopping changes nothing; the ladder decides', claude, stopping({ rung: 'term', deadline: 4500 }), [[4000, lost], [4500, tick], [6500, tick]], [KILL], interrupted('unconfirmed')],
];

describe('stepTurn', () => {
  it.each(rows)('%s', (_name, profile, from, steps, effects, state) => {
    const t = drive(profile, from, steps);
    expect(t.effects).toEqual(effects);
    expect(t.state).toMatchObject(state);
  });

  it.each([['opening', opening], ['running', running]] as const)('settles verdicts, exits, and transport loss in %s', (_name, from) => {
    const outcome = (input: TurnInput) => {
      const next = stepTurn(from, input, codex, 0).state;
      return next.phase === 'settled' ? next.outcome : undefined;
    };
    expect(outcome({ kind: 'verdict', verdict: { kind: 'completed' } })).toEqual({ state: 'completed' });
    expect(outcome(cancelled), 'a cancel nobody asked for is the agent').toEqual({ state: 'interrupted', by: 'agent', tree: 'live' });
    expect(outcome({ kind: 'exit', exit: { observed: 'parent', code: 137, signal: 'SIGKILL' } })).toEqual({ state: 'failed', failure: { kind: 'process-exit', code: 137, signal: 'SIGKILL' } });
    expect(outcome(exited), 'containment knows no code').toEqual({ state: 'failed', failure: { kind: 'process-exit', code: null, signal: null } });
    expect(outcome(lost)).toEqual({ state: 'failed', failure: { kind: 'transport-lost' } });
    for (const input of [tick, signal('term', 'sent'), signal('kill', 'sent')]) {
      expect(stepTurn(from, input, codex, 99_999), `${input.kind} is ignored`).toEqual({ state: from, effects: [] });
    }
  });

  it('ignores every input once settled', () => {
    const done: TurnState = { phase: 'settled', turnId, outcome: { state: 'completed' } };
    for (const input of [started, stop, tick, cancelled, signal('term', 'sent'), exited, lost]) {
      expect(stepTurn(done, input, claude, 99_999), input.kind).toEqual({ state: done, effects: [] });
    }
  });

  it('names one timer, only while stopping, and the bound per engine', () => {
    expect([opening, running, stopping({ deadline: 42 })].map(deadlineOf)).toEqual([undefined, undefined, 42]);
    const acp = { needsTurnId: false, openWaitMs: 0, graceMs: 4000 };
    const pi = { needsTurnId: false, openWaitMs: 0, graceMs: 2000 };
    expect([codex, claude, acp, pi].map(stopBoundMs)).toEqual([13_500, 6500, 7500, 5500]);
  });
});
