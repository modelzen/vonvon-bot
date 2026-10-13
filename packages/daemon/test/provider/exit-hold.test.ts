import { describe, expect, it } from 'vitest';
import type { ExitFact, ProcessFact } from '../../src/provider/engines/engine';
import { EXIT_HOLD_START, EXIT_REPORT_HOLD_MS, stepExitHold, type ExitHoldInput } from '../../src/provider/process/exit-hold';

const crash: ExitFact = { observed: 'parent', code: null, signal: 'SIGSEGV' };
const eof: ExitHoldInput = { kind: 'eof' };
const exit = (fact: ExitFact = crash): ExitHoldInput => ({ kind: 'exit', exit: fact });
const tick: ExitHoldInput = { kind: 'tick' };

/** Feeds timed inputs, honouring every deadline the machine asks for, and collects what it reports. */
function run(inputs: Array<[number, ExitHoldInput]>, until: number): ProcessFact[] {
  let state = EXIT_HOLD_START;
  let deadline: number | undefined;
  const facts: ProcessFact[] = [];
  const apply = (input: ExitHoldInput, now: number) => {
    const step = stepExitHold(state, input, now);
    state = step.state;
    deadline = step.deadline;
    facts.push(...step.facts);
  };
  for (const [at, input] of inputs) {
    while (deadline !== undefined && deadline <= at) apply(tick, deadline);
    apply(input, at);
  }
  while (deadline !== undefined && deadline <= until) apply(tick, deadline);
  return facts;
}

describe('exit-report hold', () => {
  it('reports only the exit when it arrives inside the hold after EOF', () => {
    expect(run([[0, eof], [EXIT_REPORT_HOLD_MS - 1, exit()]], 10_000)).toEqual([{ kind: 'exit', exit: crash }]);
  });

  it('reports transport-lost at the end of the hold, then a later exit', () => {
    expect(run([[100, eof]], 10_000)).toEqual([{ kind: 'transport-lost' }]);
    expect(run([[100, eof], [100 + EXIT_REPORT_HOLD_MS + 5, exit()]], 10_000))
      .toEqual([{ kind: 'transport-lost' }, { kind: 'exit', exit: crash }]);
  });

  it('reports transport-lost before a late exit that arrives ahead of the overdue tick', () => {
    const held = stepExitHold(EXIT_HOLD_START, eof, 0);
    expect(stepExitHold(held.state, exit(), EXIT_REPORT_HOLD_MS + 1).facts).toEqual([{ kind: 'transport-lost' }, { kind: 'exit', exit: crash }]);
    expect(stepExitHold(held.state, exit(), EXIT_REPORT_HOLD_MS - 1).facts).toEqual([{ kind: 'exit', exit: crash }]);
  });

  it('does not report transport-lost a moment before the hold ends', () => {
    const held = stepExitHold(EXIT_HOLD_START, eof, 0);
    expect(held.deadline).toBe(EXIT_REPORT_HOLD_MS);
    expect(stepExitHold(held.state, tick, EXIT_REPORT_HOLD_MS - 1).facts).toEqual([]);
    expect(stepExitHold(held.state, tick, EXIT_REPORT_HOLD_MS).facts).toEqual([{ kind: 'transport-lost' }]);
  });

  it('never reports transport-lost after an exit, whenever EOF comes', () => {
    expect(run([[0, exit()], [1, eof]], 10_000)).toEqual([{ kind: 'exit', exit: crash }]);
    expect(run([[0, exit()], [5_000, eof], [5_000 + EXIT_REPORT_HOLD_MS, tick]], 10_000)).toEqual([{ kind: 'exit', exit: crash }]);
  });

  it('reports each fact at most once and keeps the first exit', () => {
    const containment: ExitFact = { observed: 'containment' };
    expect(run([[0, eof], [1, eof], [2_000, eof], [2_001, exit()], [2_002, exit(containment)], [9_000, eof]], 20_000))
      .toEqual([{ kind: 'transport-lost' }, { kind: 'exit', exit: crash }]);
  });

  it('does not start the hold until EOF', () => {
    expect(run([[0, tick], [50_000, tick]], 100_000)).toEqual([]);
  });
});
