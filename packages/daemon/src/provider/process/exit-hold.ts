import type { ExitFact, ProcessFact } from '../engines/engine';

/** How long stdout EOF waits for an exit fact before it is reported as transport-lost. Below TERM_WAIT_MS. */
export const EXIT_REPORT_HOLD_MS = 1000;

export type ExitHoldState =
  | { phase: 'open' }                  // neither EOF nor an exit fact yet
  | { phase: 'held'; until: number }   // EOF seen; an exit fact before `until` is reported alone
  | { phase: 'lost' }                  // transport-lost reported; a later exit fact is still reported
  | { phase: 'exited' };               // the exit fact was reported; nothing follows
export type ExitHoldInput = { kind: 'eof' } | { kind: 'exit'; exit: ExitFact } | { kind: 'tick' };
/** `deadline` is when the caller must tick next; absent when no timer is needed. */
export type ExitHoldStep = { state: ExitHoldState; facts: ProcessFact[]; deadline?: number };

export const EXIT_HOLD_START: ExitHoldState = { phase: 'open' };

export function stepExitHold(state: ExitHoldState, input: ExitHoldInput, now: number): ExitHoldStep {
  if (state.phase === 'exited') return { state, facts: [] };
  if (input.kind === 'exit') return { state: { phase: 'exited' }, facts: [{ kind: 'exit', exit: input.exit }] };
  switch (state.phase) {
    case 'open': {
      if (input.kind === 'tick') return { state, facts: [] };
      const until = now + EXIT_REPORT_HOLD_MS;
      return { state: { phase: 'held', until }, facts: [], deadline: until };
    }
    case 'held':
      if (input.kind === 'tick' && now >= state.until) return { state: { phase: 'lost' }, facts: [{ kind: 'transport-lost' }] };
      return { state, facts: [], deadline: state.until };
    case 'lost':
      return { state, facts: [] };
  }
}
