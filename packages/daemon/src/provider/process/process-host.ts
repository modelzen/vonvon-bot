import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ProviderId } from '../model';
import { OwnedPidLedger, ownedPidSchema } from './ledger';
import type { OwnedPidRecord } from './ledger';
import { checkDeadline, ChildObservation, OwnedProcess, ProcessCleanupError, withinDeadline } from './owned-process';
import { signalTree, waitForTree } from './tree-kill';
import type { ProcessDriver, ProcessTree, TreeState } from './tree-kill';

type Registration =
  | { kind: 'registering'; observation: ChildObservation }
  | { kind: 'unconfirmed'; observation: ChildObservation; source: 'spawn' | 'adopt'; tree?: ProcessTree };

async function inspectUnboundSpawn(pid: number, deadlineMs: number): Promise<TreeState> {
  checkDeadline(deadlineMs);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    return { kind: 'unknown', reason: 'Invalid unbound child PID' };
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return { kind: 'unknown', reason: 'Unbound process-tree absence is unproven on this platform' };
  }
  // ProcessDriver.spawn owns a detached POSIX group. Absence needs no birth
  // identity; a present group never authorizes a signal or settlement here.
  try { process.kill(-pid, 0); return { kind: 'live' }; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return { kind: 'empty' };
    return { kind: 'unknown', reason: 'Cannot establish process-group absence' };
  }
}

export interface ProcessOwner { providerId: ProviderId; sessionId: string }
export interface SpawnSpec extends ProcessOwner {
  command: string;
  args?: readonly string[];
  options?: SpawnOptions;
}

export interface SweepReport {
  killed: number;
  skipped: number;
  unconfirmed: { pid: number; reason: string }[];
}

export class ProcessRegistrationError extends Error {
  constructor(readonly pid: number | undefined, cause: unknown) {
    super('Process registration failed', { cause });
  }
}

export class ProcessHost {
  readonly daemonBootId: string;
  readonly ledger: OwnedPidLedger;
  private readonly processes = new Map<number, OwnedProcess>();
  private readonly registering = new Map<ChildProcess, Registration>();
  private readonly rechecking = new Map<ChildProcess, Promise<void>>();
  private readonly cleanupErrors = new Set<unknown>();
  private readonly unclosedPipes = new Set<ChildObservation>();
  private readonly orphans = new Set<number>();
  private pending = 0;
  private ledgerUncertain = false;
  private readonly drained = new Set<() => void>();
  private accepting = true;
  private closing: Promise<void> | undefined;
  private sweeping: Promise<SweepReport> | undefined;

  constructor(private readonly options: {
    dataDir: string;
    daemonBootId?: string;
    driver: ProcessDriver;
    inspectUnboundSpawn?: (pid: number, deadlineMs: number) => Promise<TreeState>;
  }) {
    this.daemonBootId = options.daemonBootId ?? randomUUID();
    if (!this.daemonBootId) throw new Error('daemonBootId must not be empty');
    this.ledger = new OwnedPidLedger(options.dataDir);
  }

  async spawn(spec: SpawnSpec): Promise<OwnedProcess> {
    const deadlineMs = performance.now() + 2000;
    this.assertAccepting();
    if (this.sweeping) throw new Error('ProcessHost is sweeping orphans');
    this.validateOwner(spec);
    this.pending++;
    try {
      await withinDeadline(this.options.driver.available(deadlineMs), deadlineMs);
      const existing = await this.readLedger();
      if (existing.some(record => record.daemonBootId !== this.daemonBootId)) {
        for (const record of existing) this.orphans.add(record.pid);
        throw new Error('Sweep previous-daemon ownership before spawning children');
      }
      this.assertAccepting();
      checkDeadline(deadlineMs);
      const child = this.options.driver.spawn(spec.command, spec.args ?? [], spec.options ?? {});
      return await this.register(child, spec, 'spawn', deadlineMs);
    } finally { this.endOperation(); }
  }

  async adopt(child: ChildProcess, owner: ProcessOwner): Promise<OwnedProcess> {
    const deadlineMs = performance.now() + 2000;
    this.assertAccepting();
    if (this.sweeping) throw new Error('ProcessHost is sweeping orphans');
    this.validateOwner(owner);
    if (this.registering.has(child) || [...this.processes.values()].some(process => process.child === child)) {
      throw new Error('Child is already owned by this ProcessHost');
    }
    this.pending++;
    try { return await this.register(child, owner, 'adopt', deadlineMs); }
    finally { this.endOperation(); }
  }

  owesWork(): boolean {
    return this.options.driver.owesWork() || this.ledgerUncertain || this.pending !== 0 || this.registering.size !== 0
      || this.unclosedPipes.size !== 0 || this.orphans.size !== 0
      || [...this.processes.values()].some(process => process.owesWork);
  }

  unconfirmedPids(): number[] {
    return [...new Set([
      ...this.orphans,
      ...[...this.processes.values()].filter(process => process.owesWork).map(process => process.pid),
      ...[...this.registering.keys()].flatMap(child => child.pid === undefined ? [] : [child.pid]),
      ...[...this.unclosedPipes].flatMap(({ child }) => child.pid === undefined ? [] : [child.pid]),
    ])];
  }

  async refresh(deadlineMs = performance.now() + 2000): Promise<void> {
    checkDeadline(deadlineMs);
    await withinDeadline(Promise.all([
      ...[...this.processes.values()].map(process => process.refresh(deadlineMs)),
      ...[...this.registering.keys()].map(child => this.recheckRegistration(child, false, deadlineMs)),
    ]), deadlineMs);
  }

  sweepOrphans(): Promise<SweepReport> {
    this.assertAccepting();
    if (!this.sweeping) {
      if (this.pending || this.processes.size || this.registering.size) {
        throw new Error('Sweep orphans before accepting children');
      }
      this.pending++;
      this.sweeping = this.sweep(performance.now() + 2000).finally(() => {
        this.endOperation();
        this.sweeping = undefined;
      });
    }
    return this.sweeping;
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.accepting = false;
      // Budget 2 s for registration, 1.5 s for TERM, 2 s for KILL, and 2 s for driver cleanup.
      this.closing = this.closeProcesses(performance.now() + 7500);
    }
    return this.closing;
  }

  private async register(child: ChildProcess, owner: ProcessOwner, source: 'spawn' | 'adopt', deadlineMs: number): Promise<OwnedProcess> {
    const observation = new ChildObservation(child);
    this.registering.set(child, { kind: 'registering', observation });
    let tree: ProcessTree | undefined;
    try {
      await withinDeadline(observation.spawned, deadlineMs);
      if (child.pid === undefined) throw new Error('Spawned child has no PID');
      const binding = await withinDeadline(this.options.driver.bind(child, deadlineMs), deadlineMs);
      tree = binding.tree;
      checkDeadline(deadlineMs);
      const record = ownedPidSchema.parse({
        pid: child.pid, startedAtMs: binding.startedAtMs, daemonBootId: this.daemonBootId,
        providerId: owner.providerId, sessionId: owner.sessionId,
      });
      await this.ledger.add(record);
      const owned = new OwnedProcess({ observation, record, tree: binding.tree, onSettled: async failure => {
        await this.ledger.remove(record);
        if (failure) this.cleanupErrors.add(failure);
        this.observeRemainingPipes(observation);
        this.processes.delete(record.pid);
      } });
      this.processes.set(record.pid, owned);
      this.registering.delete(child);
      checkDeadline(deadlineMs);
      await owned.refresh(deadlineMs);
      return owned;
    } catch (cause) {
      if (this.registering.has(child)) {
        this.registering.set(child, { kind: 'unconfirmed', observation, source, tree });
        try {
          if (tree || observation.exit !== undefined || child.pid === undefined) {
            await this.recheckRegistration(child, true, deadlineMs);
          }
        } catch { /* Keep unresolved ownership visible through owesWork(). */ }
      }
      throw new ProcessRegistrationError(child.pid, cause);
    }
  }

  private async sweep(deadlineMs: number): Promise<SweepReport> {
    const report: SweepReport = { killed: 0, skipped: 0, unconfirmed: [] };
    for (const record of await this.readLedger()) {
      this.orphans.add(record.pid);
      if (record.daemonBootId === this.daemonBootId) { report.skipped++; continue; }
      try {
        checkDeadline(deadlineMs);
        const recovery = await withinDeadline(this.options.driver.recover(record, deadlineMs), deadlineMs);
        checkDeadline(deadlineMs);
        switch (recovery.kind) {
          case 'gone':
          case 'mismatch':
            await this.ledger.remove(record);
            this.orphans.delete(record.pid);
            report.skipped++;
            break;
          case 'unverified':
            report.unconfirmed.push({ pid: record.pid, reason: recovery.reason });
            break;
          case 'owned': {
            const signal = await signalTree(recovery.tree, 'SIGKILL', deadlineMs);
            if (await waitForTree(recovery.tree, { deadlineMs }) !== 'exited') {
              report.unconfirmed.push({ pid: record.pid, reason: 'Process tree is not confirmed empty' });
              break;
            }
            checkDeadline(deadlineMs);
            await this.ledger.remove(record);
            this.orphans.delete(record.pid);
            if (signal.kind === 'sent') report.killed++;
            else report.skipped++;
            break;
          }
          default: {
            const exhaustive: never = recovery;
            throw new Error(`Unknown recovery result: ${exhaustive}`);
          }
        }
      } catch (error) {
        report.unconfirmed.push({ pid: record.pid, reason: error instanceof Error ? error.message : 'Orphan recovery failed' });
      }
    }
    return report;
  }

  private async closeProcesses(deadlineMs: number): Promise<void> {
    const errors: unknown[] = [];
    try {
      if (this.pending) {
        let onDrained = (): void => undefined;
        const drained = new Promise<void>(resolve => { onDrained = resolve; this.drained.add(resolve); });
        try { await withinDeadline(drained, Math.min(deadlineMs, performance.now() + 2000)); }
        catch (error) { errors.push(error); }
        finally { this.drained.delete(onDrained); }
      }
      const treeDeadline = Math.min(deadlineMs, performance.now() + 3500);
      const results = await withinDeadline(Promise.allSettled([
        ...[...this.processes.values()].map(process => process.close(1500, treeDeadline)),
        ...[...this.registering.keys()].map(child => this.recheckRegistration(child, true, Math.min(treeDeadline, performance.now() + 2000))),
      ]), treeDeadline);
      errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
    } catch (error) { errors.push(error); }
    finally {
      try {
        const closed = await withinDeadline(this.options.driver.close(deadlineMs), deadlineMs);
        if (closed !== 'closed') errors.push(new ProcessCleanupError('Process driver close timed out'));
      } catch (error) { errors.push(error); }
    }
    errors.push(...this.cleanupErrors);
    if (this.owesWork()) errors.push(new Error(`Unconfirmed process ownership: ${this.unconfirmedPids().join(', ')}`));
    if (errors.length) throw new AggregateError(errors, 'ProcessHost has outstanding cleanup');
  }

  private recheckRegistration(child: ChildProcess, stop: boolean, deadlineMs: number): Promise<void> {
    checkDeadline(deadlineMs);
    const registration = this.registering.get(child);
    if (!registration || registration.kind === 'registering') return Promise.resolve();
    const existing = this.rechecking.get(child);
    if (existing) return withinDeadline(existing, deadlineMs).then(() => {
      if (stop) return this.recheckRegistration(child, true, deadlineMs);
    });
    const checking = this.inspectRegistration(registration, stop, deadlineMs).finally(() => { this.rechecking.delete(child); });
    this.rechecking.set(child, checking);
    return checking;
  }

  private async inspectRegistration(registration: Extract<Registration, { kind: 'unconfirmed' }>, stop: boolean, deadlineMs: number): Promise<void> {
    const { observation } = registration;
    const child = observation.child;
    if (child.pid === undefined) {
      if (!observation.error) return;
    } else {
      if (!registration.tree && !(registration.source === 'spawn' && observation.exit !== undefined)) {
        try { registration.tree = (await withinDeadline(this.options.driver.bind(child, deadlineMs), deadlineMs)).tree; }
        catch { /* A failed birth read is not proof that the tree is empty. */ }
      }
      if (registration.tree) {
        const tree = registration.tree;
        if (stop) {
          checkDeadline(deadlineMs);
          await signalTree(tree, 'SIGKILL', deadlineMs);
          if (await waitForTree({
            inspect: async deadline => {
              const state = await tree.inspect(deadline);
              return state.kind === 'empty' && observation.exit === undefined ? { kind: 'live' } : state;
            },
            signal: (signal, deadline) => tree.signal(signal, deadline),
          }, { deadlineMs }) !== 'exited') return;
        } else if (observation.exit === undefined || (await withinDeadline(tree.inspect(deadlineMs), deadlineMs)).kind !== 'empty') return;
      } else {
        if (observation.exit === undefined || registration.source !== 'spawn') return;
        const inspect = this.options.inspectUnboundSpawn ?? inspectUnboundSpawn;
        checkDeadline(deadlineMs);
        if ((await withinDeadline(inspect(child.pid, deadlineMs), deadlineMs)).kind !== 'empty') return;
      }
    }
    try {
      checkDeadline(deadlineMs);
      const pipeDeadline = performance.now() + 500;
      if (await observation.waitForClose(deadlineMs) === 'timeout') {
        if (deadlineMs < pipeDeadline) { checkDeadline(deadlineMs); return; }
        this.cleanupErrors.add(new ProcessCleanupError(`Process ${child.pid ?? 'not-spawned'} pipes did not close within 500 ms`));
      }
      checkDeadline(deadlineMs);
    } finally {
      // Only pipes remain; an expired wait must not discard the completed ownership proof.
      this.observeRemainingPipes(observation);
      this.registering.delete(child);
    }
  }

  private observeRemainingPipes(observation: ChildObservation): void {
    if (observation.didClose || this.unclosedPipes.has(observation)) return;
    this.unclosedPipes.add(observation);
    void observation.closed.then(() => { this.unclosedPipes.delete(observation); });
  }

  private assertAccepting(): void {
    if (!this.accepting) throw new Error('ProcessHost is closed');
  }

  private async readLedger(): Promise<OwnedPidRecord[]> {
    try {
      const records = await this.ledger.read();
      this.ledgerUncertain = false;
      return records;
    } catch (error) {
      this.ledgerUncertain = true;
      throw error;
    }
  }

  private validateOwner(owner: ProcessOwner): void {
    ownedPidSchema.pick({ providerId: true, sessionId: true }).parse({ providerId: owner.providerId, sessionId: owner.sessionId });
  }

  private endOperation(): void {
    this.pending--;
    if (this.pending === 0) {
      for (const resolve of this.drained) resolve();
      this.drained.clear();
    }
  }
}
