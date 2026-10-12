import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawnProcess } from '../../platform/spawn';
import type { OwnedPidRecord } from './ledger';
import { assertDeadline, beforeDeadline } from './tree-kill';
import type { ProcessDriver, ProcessTree, Recovery, ResourceCloseResult, SignalResult, TreeState } from './tree-kill';

export type ProcessIdentity =
  | { kind: 'live'; startedAtMs: number; groupId: number }
  | { kind: 'missing' }
  | { kind: 'unknown'; reason: string };

export interface ReadProcessIdentity {
  (pid: number, deadlineMs: number): Promise<ProcessIdentity>;
  owesWork(): boolean;
  close(deadlineMs: number): Promise<ResourceCloseResult>;
}
type GroupSignal = (pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => void;

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

class PosixTree implements ProcessTree {
  private empty = false;

  constructor(private readonly options: {
    pid: number;
    startedAtMs: number;
    readIdentity: ReadProcessIdentity;
    signal: GroupSignal;
    perform: <T>(deadlineMs: number, action: () => Promise<T>) => Promise<T>;
    assertUsable: (deadlineMs: number) => void;
  }) {}

  async inspect(deadlineMs: number): Promise<TreeState> {
    try { return await this.options.perform(deadlineMs, () => this.inspectIdentity(deadlineMs)); }
    catch (error) { return { kind: 'unknown', reason: error instanceof Error ? error.message : 'Cannot inspect process identity' }; }
  }

  private async inspectIdentity(deadlineMs: number): Promise<TreeState> {
    if (this.empty) return { kind: 'empty' };
    try { this.options.signal(-this.options.pid, 0); }
    catch (error) {
      if (errorCode(error) === 'ESRCH') {
        this.empty = true;
        return { kind: 'empty' };
      }
      return { kind: 'unknown', reason: `Cannot inspect process group ${this.options.pid}` };
    }
    const identity = await this.options.readIdentity(this.options.pid, deadlineMs);
    this.options.assertUsable(deadlineMs);
    if (identity.kind === 'unknown') return identity;
    if (identity.kind === 'live' && !this.matches(identity)) {
      return { kind: 'unknown', reason: 'Process-group leader identity changed' };
    }
    return { kind: 'live' };
  }

  async signal(signal: 'SIGTERM' | 'SIGKILL', deadlineMs: number): Promise<SignalResult> {
    try { return await this.options.perform(deadlineMs, () => this.signalIdentity(signal, deadlineMs)); }
    catch (error) { return { kind: 'refused', reason: error instanceof Error ? error.message : 'Cannot signal process identity' }; }
  }

  private async signalIdentity(signal: 'SIGTERM' | 'SIGKILL', deadlineMs: number): Promise<SignalResult> {
    const state = await this.inspectIdentity(deadlineMs);
    this.options.assertUsable(deadlineMs);
    if (state.kind === 'empty') return { kind: 'empty' };
    if (state.kind === 'unknown') return { kind: 'refused', reason: state.reason };
    const identity = await this.options.readIdentity(this.options.pid, deadlineMs);
    this.options.assertUsable(deadlineMs);
    if (identity.kind !== 'live' || !this.matches(identity)) {
      return { kind: 'refused', reason: 'Cannot prove the current process-group leader identity' };
    }
    // This recheck is not an atomic identity-and-signal primitive. Restart recovery
    // remains unavailable until a platform driver proves that stronger operation.
    this.options.assertUsable(deadlineMs);
    try {
      this.options.signal(-this.options.pid, signal);
      return { kind: 'sent' };
    } catch (error) {
      if (errorCode(error) === 'ESRCH') {
        this.empty = true;
        return { kind: 'empty' };
      }
      return { kind: 'refused', reason: `Could not send ${signal} to owned process group ${this.options.pid}` };
    }
  }

  private matches(identity: Extract<ProcessIdentity, { kind: 'live' }>): boolean {
    return identity.startedAtMs === this.options.startedAtMs && identity.groupId === this.options.pid;
  }
}

export class PosixProcessDriver implements ProcessDriver {
  private readonly readIdentity: ReadProcessIdentity;
  private readonly signal: GroupSignal;
  private accepting = true;
  private readonly operations = new Set<Promise<unknown>>();

  constructor(options: { readIdentity: ReadProcessIdentity; signal?: GroupSignal }) {
    this.readIdentity = options.readIdentity;
    this.signal = options.signal ?? ((pid, signal) => { process.kill(pid, signal); });
  }

  async available(deadlineMs: number): Promise<void> {
    return this.perform(deadlineMs, async () => {
      if (process.platform === 'win32') throw new Error('POSIX process groups are unavailable on Windows');
      const ownIdentity = await this.readIdentity(process.pid, deadlineMs);
      if (ownIdentity.kind !== 'live') throw new Error('An authoritative OS process-birth reader is required');
    });
  }

  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    if (!this.accepting) throw new Error('Process driver is closed');
    if (options.shell) throw new Error('ProcessHost does not launch through a shell');
    if (options.signal || options.timeout) throw new Error('Use ProcessHost termination instead of spawn timeout or AbortSignal');
    return spawnProcess(command, args, { ...options, detached: true });
  }

  async bind(child: ChildProcess, deadlineMs: number): Promise<{ startedAtMs: number; tree: ProcessTree }> {
    return this.perform(deadlineMs, async () => {
      const pid = child.pid;
      if (pid === undefined || pid <= 0 || pid === process.pid) throw new Error('Invalid owned child PID');
      const identity = await this.readIdentity(pid, deadlineMs);
      this.assertUsable(deadlineMs);
      if (identity.kind !== 'live' || identity.groupId !== pid || child.exitCode !== null || child.signalCode !== null) {
        throw new Error('The child must have a proven OS birth identity and its own detached process group');
      }
      return {
        startedAtMs: identity.startedAtMs,
        tree: new PosixTree({
          pid, startedAtMs: identity.startedAtMs, readIdentity: this.readIdentity, signal: this.signal,
          perform: (deadline, action) => this.perform(deadline, action),
          assertUsable: deadline => this.assertUsable(deadline),
        }),
      };
    });
  }

  async recover(record: OwnedPidRecord, deadlineMs: number): Promise<Recovery> {
    try { return await this.perform(deadlineMs, () => this.recoverIdentity(record, deadlineMs)); }
    catch (error) { return { kind: 'unverified', reason: error instanceof Error ? error.message : 'Cannot recover process identity' }; }
  }

  private async recoverIdentity(record: OwnedPidRecord, deadlineMs: number): Promise<Recovery> {
    const identity = await this.readIdentity(record.pid, deadlineMs);
    this.assertUsable(deadlineMs);
    if (identity.kind === 'unknown') return { kind: 'unverified', reason: identity.reason };
    if (identity.kind === 'live' && (identity.startedAtMs !== record.startedAtMs || identity.groupId !== record.pid)) {
      return { kind: 'mismatch' };
    }
    if (identity.kind === 'missing') {
      try { this.signal(-record.pid, 0); }
      catch (error) {
        if (errorCode(error) === 'ESRCH') return { kind: 'gone' };
      }
      return { kind: 'unverified', reason: 'The recorded leader is gone; descendant-group identity is unproven' };
    }
    return { kind: 'unverified', reason: 'Atomic identity-bound POSIX orphan signalling is not implemented' };
  }

  owesWork(): boolean { return this.operations.size > 0 || this.readIdentity.owesWork(); }

  async close(deadlineMs: number): Promise<ResourceCloseResult> {
    assertDeadline(deadlineMs);
    this.accepting = false;
    const closing = this.readIdentity.close(deadlineMs);
    const work = Promise.all([closing, Promise.allSettled([...this.operations])]);
    const result = await beforeDeadline(work, deadlineMs);
    if (result.kind === 'completed' && result.value[0] === 'closed' && !this.owesWork()) return 'closed';
    return 'timeout';
  }

  private assertUsable(deadlineMs: number): void {
    assertDeadline(deadlineMs);
    if (!this.accepting) throw new Error('Process driver is closed');
    if (performance.now() >= deadlineMs) throw new Error('Process operation deadline expired');
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.operations.add(work);
    void work.then(() => this.operations.delete(work), () => this.operations.delete(work));
    return work;
  }

  private async perform<T>(deadlineMs: number, action: () => Promise<T>): Promise<T> {
    this.assertUsable(deadlineMs);
    const work = this.track(action());
    return this.track(beforeDeadline(work, deadlineMs).then(result => {
      this.assertUsable(deadlineMs);
      if (result.kind === 'timeout') throw new Error('Process operation deadline expired');
      return result.value;
    }));
  }
}
