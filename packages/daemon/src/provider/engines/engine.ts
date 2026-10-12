import type { Failure, RunEvent } from '../model';

export interface StopProfile { needsTurnId: boolean; openWaitMs: number; graceMs: number }
export const TERM_WAIT_MS = 1500;

export type TurnVerdict =
  | { kind: 'completed' } | { kind: 'failed'; failure: Failure } | { kind: 'cancelled' }
  | { kind: 'exit'; code: number | null; signal: string | null };

export interface SignalSink {
  frame(): void;
  emit(event: Exclude<RunEvent, { type: 'outcome' }>): void;
  verdict(v: TurnVerdict): void;
}
