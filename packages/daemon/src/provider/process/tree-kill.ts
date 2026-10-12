import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { OwnedPidRecord } from './ledger';

export type TreeState =
  | { kind: 'empty' }
  | { kind: 'live' }
  | { kind: 'unknown'; reason: string };

export type SignalResult =
  | { kind: 'sent' }
  | { kind: 'empty' }
  | { kind: 'refused'; reason: string };

export interface ProcessTree {
  inspect(deadlineMs: number): Promise<TreeState>;
  signal(signal: 'SIGTERM' | 'SIGKILL', deadlineMs: number): Promise<SignalResult>;
}

export type Recovery =
  | { kind: 'owned'; tree: ProcessTree }
  | { kind: 'gone' }
  | { kind: 'mismatch' }
  | { kind: 'unverified'; reason: string };

export interface ProcessDriver {
  /** Fails before spawn when the platform cannot establish process ownership. */
  available(deadlineMs: number): Promise<void>;
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  bind(child: ChildProcess, deadlineMs: number): Promise<{ startedAtMs: number; tree: ProcessTree }>;
  /** Must not return owned unless signalling preserves the recorded OS identity. */
  recover(record: OwnedPidRecord, deadlineMs: number): Promise<Recovery>;
  owesWork(): boolean;
  close(deadlineMs: number): Promise<ResourceCloseResult>;
}

export type TerminationResult = 'exited' | 'timeout';
export type ResourceCloseResult = 'closed' | 'timeout';

export class UnconfirmedProcessTreeError extends Error {}

export function assertDeadline(deadlineMs: number): void {
  if (!Number.isFinite(deadlineMs)) throw new RangeError('A finite absolute process deadline is required');
}

// Keep observing late failures without extending the caller's wait.
export function beforeDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<
  { kind: 'completed'; value: T } | { kind: 'timeout' }
> {
  assertDeadline(deadlineMs);
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    function checkDeadline(): void {
      const remaining = deadlineMs - performance.now();
      if (remaining <= 0) resolve({ kind: 'timeout' });
      else timer = setTimeout(checkDeadline, Math.min(0x7fffffff, remaining));
    }
    checkDeadline();
    void work.then(value => {
      clearTimeout(timer);
      resolve(performance.now() < deadlineMs ? { kind: 'completed', value } : { kind: 'timeout' });
    }, error => {
      clearTimeout(timer);
      if (performance.now() >= deadlineMs) resolve({ kind: 'timeout' });
      else reject(error);
    });
  });
}

export async function waitForTree(tree: ProcessTree, { deadlineMs }: { deadlineMs: number }): Promise<TerminationResult> {
  assertDeadline(deadlineMs);
  for (;;) {
    if (performance.now() >= deadlineMs) return 'timeout';
    const result = await beforeDeadline(tree.inspect(deadlineMs), deadlineMs);
    if (result.kind === 'timeout' || performance.now() >= deadlineMs) return 'timeout';
    if (result.value.kind === 'empty') return 'exited';
    const remaining = deadlineMs - performance.now();
    if (remaining <= 0) return 'timeout';
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, remaining)));
  }
}

export async function signalTree(tree: ProcessTree, signal: 'SIGTERM' | 'SIGKILL', deadlineMs: number): Promise<SignalResult> {
  assertDeadline(deadlineMs);
  if (performance.now() >= deadlineMs) throw new UnconfirmedProcessTreeError('Process signal deadline expired');
  const result = await beforeDeadline(tree.signal(signal, deadlineMs), deadlineMs);
  if (result.kind === 'timeout' || performance.now() >= deadlineMs) throw new UnconfirmedProcessTreeError('Process signal deadline expired');
  if (result.value.kind === 'refused') throw new UnconfirmedProcessTreeError(result.value.reason);
  return result.value;
}
