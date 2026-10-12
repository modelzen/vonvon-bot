import type { ChildProcess } from 'node:child_process';
import type { OwnedPidRecord } from './ledger';
import { beforeDeadline, signalTree, UnconfirmedProcessTreeError, waitForTree } from './tree-kill';
import type { ProcessTree, TerminationResult } from './tree-kill';

export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };
export class ProcessCleanupError extends Error {}
export class ProcessDeadlineError extends Error {}

export function checkDeadline(deadlineMs: number): void {
  if (!Number.isFinite(deadlineMs)) throw new RangeError('Invalid process deadline');
  if (performance.now() >= deadlineMs) throw new ProcessDeadlineError('Process operation deadline expired');
}

export async function withinDeadline<T>(operation: Promise<T>, deadlineMs: number): Promise<T> {
  if (!Number.isFinite(deadlineMs)) {
    void operation.catch(() => undefined);
    throw new RangeError('Invalid process deadline');
  }
  const result = await beforeDeadline(operation, deadlineMs);
  if (result.kind === 'timeout') throw new ProcessDeadlineError('Process operation deadline expired');
  return result.value;
}

export class ChildObservation {
  readonly spawned: Promise<void>;
  readonly exited: Promise<ProcessExit>;
  readonly closed: Promise<void>;
  exit: ProcessExit | undefined;
  error: Error | undefined;
  didClose = false;

  constructor(readonly child: ChildProcess) {
    this.closed = new Promise(resolve => child.once('close', () => {
      this.didClose = true;
      resolve();
    }));
    this.spawned = new Promise((resolve, reject) => {
      if (child.pid !== undefined) resolve();
      else child.once('spawn', resolve);
      child.once('error', reject);
    });
    this.exited = new Promise((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        this.exit = { code: child.exitCode, signal: child.signalCode };
        resolve(this.exit);
      } else child.once('exit', (code, signal) => {
        this.exit = { code, signal };
        resolve(this.exit);
      });
      child.on('error', error => {
        this.error = error;
        if (child.pid === undefined) reject(error);
      });
    });
    void this.spawned.catch(() => undefined);
    void this.exited.catch(() => undefined);
  }

  async waitForClose(deadlineMs: number): Promise<'closed' | 'timeout'> {
    checkDeadline(deadlineMs);
    if (this.didClose) return 'closed';
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.closed.then<'closed'>(() => 'closed'),
        new Promise<'timeout'>(resolve => {
          timer = setTimeout(() => resolve('timeout'), Math.max(0, Math.min(500, deadlineMs - performance.now())));
        }),
      ]);
    } finally { clearTimeout(timer); }
  }
}

export class OwnedProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<ProcessExit>;
  private settlement: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private settled = false;
  private treeEmpty = false;
  private lastFailure: unknown;
  private pipeFailure: ProcessCleanupError | undefined;
  private readonly operationDeadlines = new Map<symbol, number>();

  constructor(private readonly options: {
    observation: ChildObservation;
    record: OwnedPidRecord;
    tree: ProcessTree;
    onSettled: (failure: ProcessCleanupError | undefined) => Promise<void>;
  }) {
    this.child = options.observation.child;
    this.exited = options.observation.exited;
    const check = (): void => {
      const deadlineMs = this.operationDeadlines.size ? Math.min(...this.operationDeadlines.values()) : performance.now() + 2000;
      void this.refresh(deadlineMs).catch(error => { this.lastFailure = error; });
    };
    void this.exited.then(check, check);
    void options.observation.closed.then(check);
  }

  get pid(): number { return this.options.record.pid; }
  get record(): Readonly<OwnedPidRecord> { return this.options.record; }
  get owesWork(): boolean { return !this.settled || !this.options.observation.didClose; }
  get cleanupFailure(): unknown { return this.lastFailure; }

  async refresh(deadlineMs = performance.now() + 2000): Promise<boolean> {
    if (!Number.isFinite(deadlineMs)) throw new RangeError('Invalid process deadline');
    const operation = Symbol();
    this.operationDeadlines.set(operation, deadlineMs);
    try {
      if (this.settled) return true;
      if (performance.now() >= deadlineMs) return false;
      if (this.options.observation.exit === undefined) return false;
      if (!this.treeEmpty) {
        if ((await withinDeadline(this.options.tree.inspect(deadlineMs), deadlineMs)).kind !== 'empty') return false;
        this.treeEmpty = true;
      }
      if (performance.now() >= deadlineMs) return false;
      if (!this.settlement) {
        this.settlement = this.settle(deadlineMs);
        void this.settlement.catch(error => {
          this.lastFailure = error;
          this.settlement = undefined;
        });
      }
      await withinDeadline(this.settlement, deadlineMs);
      return this.settled;
    } finally { this.operationDeadlines.delete(operation); }
  }

  async terminateTree(timeoutMs: number): Promise<TerminationResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('Invalid process-tree timeout');
    return this.terminateUntil(performance.now() + timeoutMs);
  }

  async killTree(deadlineMs = performance.now() + 2000): Promise<void> {
    const operation = Symbol();
    this.operationDeadlines.set(operation, deadlineMs);
    try {
      if (await this.refresh(deadlineMs)) { this.checkCleanup(); return; }
      checkDeadline(deadlineMs);
      await signalTree(this.options.tree, 'SIGKILL', deadlineMs);
      if (await this.waitForExit(deadlineMs) !== 'exited' || !await this.refresh(deadlineMs)) {
        throw new UnconfirmedProcessTreeError(`Process tree ${this.pid} has not been confirmed empty`);
      }
      this.checkCleanup();
    } finally { this.operationDeadlines.delete(operation); }
  }

  close(graceMs = 1500, deadlineMs = performance.now() + graceMs + 2000): Promise<void> {
    if (!this.closing) {
      if (!Number.isFinite(graceMs) || graceMs < 0 || !Number.isFinite(deadlineMs)) {
        return Promise.reject(new RangeError('Invalid process close deadline'));
      }
      this.closing = this.terminateUntil(Math.min(deadlineMs, performance.now() + graceMs)).then(async result => {
        if (result === 'timeout') await this.killTree(Math.min(deadlineMs, performance.now() + 2000));
      });
    }
    return this.closing;
  }

  private async terminateUntil(deadlineMs: number): Promise<TerminationResult> {
    const operation = Symbol();
    this.operationDeadlines.set(operation, deadlineMs);
    try {
      if (await this.refresh(deadlineMs)) { this.checkCleanup(); return 'exited'; }
      if (performance.now() >= deadlineMs) return 'timeout';
      await signalTree(this.options.tree, 'SIGTERM', deadlineMs);
      const result = await this.waitForExit(deadlineMs);
      if (result !== 'exited' || !await this.refresh(deadlineMs)) return 'timeout';
      this.checkCleanup();
      return 'exited';
    } catch (error) {
      if (error instanceof ProcessDeadlineError || performance.now() >= deadlineMs) return 'timeout';
      throw error;
    } finally { this.operationDeadlines.delete(operation); }
  }

  private waitForExit(deadlineMs: number): Promise<TerminationResult> {
    return waitForTree({
      inspect: async deadline => {
        const state = await this.options.tree.inspect(deadline);
        return state.kind === 'empty' && this.options.observation.exit === undefined ? { kind: 'live' } : state;
      },
      signal: (signal, deadline) => this.options.tree.signal(signal, deadline),
    }, { deadlineMs });
  }

  private async settle(deadlineMs: number): Promise<void> {
    if (!this.pipeFailure) {
      const pipeDeadline = performance.now() + 500;
      if (await this.options.observation.waitForClose(deadlineMs) === 'timeout') {
        if (deadlineMs < pipeDeadline) throw new ProcessDeadlineError('Process deadline expired before pipe close');
        this.pipeFailure = new ProcessCleanupError(`Process ${this.pid} pipes did not close within 500 ms`);
        this.lastFailure = this.pipeFailure;
      }
    }
    checkDeadline(deadlineMs);
    await this.options.onSettled(this.pipeFailure);
    this.settled = true;
  }

  private checkCleanup(): void {
    if (this.pipeFailure) throw this.pipeFailure;
  }
}
