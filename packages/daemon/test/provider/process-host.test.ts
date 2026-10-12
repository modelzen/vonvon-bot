import { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnedPidLedger } from '../../src/provider/process/ledger';
import type { OwnedPidRecord } from '../../src/provider/process/ledger';
import { parseLinuxStat } from '../../src/provider/process/linux-identity';
import { ProcessHost } from '../../src/provider/process/process-host';
import { PosixProcessDriver } from '../../src/provider/process/posix-driver';
import type { ProcessIdentity, ReadProcessIdentity } from '../../src/provider/process/posix-driver';
import type { ProcessDriver, ProcessTree, Recovery, ResourceCloseResult } from '../../src/provider/process/tree-kill';

class FixtureProcess extends ChildProcess {
  override exitCode: number | null = null;

  finishExit(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit('exit', 0, null);
  }

  finishClose(): void { this.emit('close', this.exitCode, null); }
}

interface FixtureChild {
  child: FixtureProcess;
  pid: number;
  startedAtMs: number;
  live: boolean;
  ignoreTerm: boolean;
  delayClose: boolean;
  signals: string[];
}

class FixtureDriver implements ProcessDriver {
  readonly children = new Map<number, FixtureChild>();
  nextPid = 40001;
  availableGate: Promise<void> = Promise.resolve();
  bindGate: Promise<void> = Promise.resolve();
  recovery: 'verified' | 'unknown' = 'verified';
  beforeSignal: (() => void) | undefined;
  beforeInspect: ((deadlineMs: number) => Promise<void>) | undefined;
  readonly calls: { operation: string; deadlineMs: number }[] = [];
  internalWork = false;
  closed = false;
  closeResult: ResourceCloseResult = 'closed';

  available(deadlineMs: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Fixture driver closed'));
    this.calls.push({ operation: 'available', deadlineMs });
    return this.availableGate;
  }

  owesWork(): boolean { return this.internalWork; }

  async close(deadlineMs: number): Promise<ResourceCloseResult> {
    this.closed = true;
    this.calls.push({ operation: 'close', deadlineMs });
    return this.closeResult;
  }

  spawn(): FixtureProcess {
    if (this.closed) throw new Error('Fixture driver closed');
    const child = new FixtureProcess();
    const pid = this.nextPid++;
    Object.defineProperty(child, 'pid', { value: pid });
    this.children.set(pid, { child, pid, startedAtMs: 1700000000000 + pid, live: true, ignoreTerm: false, delayClose: false, signals: [] });
    return child;
  }

  entry(child: ChildProcess): FixtureChild {
    const entry = child.pid === undefined ? undefined : this.children.get(child.pid);
    if (!entry) throw new Error('Unknown fixture child');
    return entry;
  }

  async bind(child: ChildProcess, deadlineMs: number): Promise<{ startedAtMs: number; tree: ProcessTree }> {
    if (this.closed) throw new Error('Fixture driver closed');
    this.calls.push({ operation: 'bind', deadlineMs });
    await this.bindGate;
    if (this.closed) throw new Error('Fixture driver closed');
    const entry = this.entry(child);
    return { startedAtMs: entry.startedAtMs, tree: this.tree(entry) };
  }

  async recover(record: OwnedPidRecord, deadlineMs: number): Promise<Recovery> {
    if (this.closed) throw new Error('Fixture driver closed');
    this.calls.push({ operation: 'recover', deadlineMs });
    if (this.recovery === 'unknown') return { kind: 'unverified', reason: 'Birth identity is unavailable' };
    const entry = this.children.get(record.pid);
    if (!entry || !entry.live) return { kind: 'gone' };
    if (entry.startedAtMs !== record.startedAtMs) return { kind: 'mismatch' };
    return { kind: 'owned', tree: this.tree(entry) };
  }

  exit(entry: FixtureChild): void {
    if (!entry.live) return;
    entry.live = false;
    entry.child.finishExit();
    if (!entry.delayClose) entry.child.finishClose();
  }

  private tree(entry: FixtureChild): ProcessTree {
    const birth = entry.startedAtMs;
    return {
      inspect: async deadlineMs => {
        this.calls.push({ operation: 'inspect', deadlineMs });
        if (this.closed) return { kind: 'unknown', reason: 'Fixture driver closed' };
        await this.beforeInspect?.(deadlineMs);
        if (this.closed) return { kind: 'unknown', reason: 'Fixture driver closed' };
        if (performance.now() >= deadlineMs) return { kind: 'unknown', reason: 'Fixture deadline expired' };
        return entry.live ? { kind: 'live' } : { kind: 'empty' };
      },
      signal: async (signal, deadlineMs) => {
        this.calls.push({ operation: signal, deadlineMs });
        if (this.closed) return { kind: 'refused', reason: 'Fixture driver closed' };
        this.beforeSignal?.();
        if (this.closed) return { kind: 'refused', reason: 'Fixture driver closed' };
        if (performance.now() >= deadlineMs) return { kind: 'refused', reason: 'Fixture deadline expired' };
        if (entry.startedAtMs !== birth) return { kind: 'refused', reason: 'Fixture process identity changed' };
        if (!entry.live) return { kind: 'empty' };
        entry.signals.push(signal);
        if (signal === 'SIGKILL' || !entry.ignoreTerm) this.exit(entry);
        return { kind: 'sent' };
      },
    };
  }
}

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'vonvon-process-host-'));
  directories.push(dataDir);
  const driver = new FixtureDriver();
  const host = new ProcessHost({
    dataDir, daemonBootId: 'boot-one', driver,
    inspectUnboundSpawn: async pid => driver.children.get(pid)?.live ? { kind: 'live' } : { kind: 'empty' },
  });
  return { dataDir, driver, host, path: join(dataDir, 'owned-pids.json') };
}

const spec = { command: 'fixture-only', providerId: 'codex', sessionId: 'session-one' } satisfies Parameters<ProcessHost['spawn']>[0];

describe('ProcessHost ownership contract with a deterministic process driver', () => {
  it('persists the five-field OS identity before spawn returns and counts one-shot work', async () => {
    const { host, path } = await fixture();
    const owned = await host.spawn(spec);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([{
      pid: 40001, startedAtMs: 1700000040001, daemonBootId: 'boot-one', providerId: 'codex', sessionId: 'session-one',
    }]);
    expect(host.owesWork()).toBe(true);
    await owned.killTree();
    expect(host.owesWork()).toBe(false);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([]);
  });

  it('preserves every record across concurrent registrations and settlements', async () => {
    const { host } = await fixture();
    const [first, second] = await Promise.all([host.spawn(spec), host.spawn({ ...spec, sessionId: 'session-two' })]);
    expect((await host.ledger.read()).map(record => record.pid).sort()).toEqual([40001, 40002]);
    await Promise.all([first.killTree(), second.killTree()]);
    expect(await host.ledger.read()).toEqual([]);
    expect(host.owesWork()).toBe(false);
  });

  it('adopts a child into the same ledger and keeps a TERM timeout outstanding until KILL confirms exit', async () => {
    const { driver, host } = await fixture();
    const child = driver.spawn();
    const entry = driver.entry(child);
    entry.ignoreTerm = true;
    const owned = await host.adopt(child, { providerId: 'claude', sessionId: 'sdk-session' });
    expect(await host.ledger.read()).toEqual([{
      pid: 40001, startedAtMs: 1700000040001, daemonBootId: 'boot-one', providerId: 'claude', sessionId: 'sdk-session',
    }]);
    vi.useFakeTimers();
    const terminating = owned.terminateTree(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await terminating).toBe('timeout');
    expect(host.owesWork()).toBe(true);
    await owned.killTree();
    expect(entry.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(entry.live).toBe(false);
    expect(host.owesWork()).toBe(false);
  });

  it('removes a naturally completed child only after the tree is empty', async () => {
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    driver.exit(driver.entry(owned.child));
    await host.refresh();
    expect(await owned.exited).toEqual({ code: 0, signal: null });
    expect(host.owesWork()).toBe(false);
    expect(await host.ledger.read()).toEqual([]);
  });

  it('keeps the ledger and close pending between exit and pipe close', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    const entry = driver.entry(owned.child);
    entry.delayClose = true;
    const closing = host.close();
    await owned.exited;
    expect((await host.ledger.read()).map(record => record.pid)).toEqual([40001]);
    await vi.advanceTimersByTimeAsync(499);
    expect(host.owesWork()).toBe(true);
    expect((await host.ledger.read()).map(record => record.pid)).toEqual([40001]);
    entry.child.finishClose();
    await closing;
    expect(host.owesWork()).toBe(false);
    expect(await host.ledger.read()).toEqual([]);
    expect(owned.cleanupFailure).toBeUndefined();
  });

  it('reports the existing 500 ms pipe-close timeout after confirmed tree exit', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    const entry = driver.entry(owned.child);
    entry.delayClose = true;
    const closing = host.close();
    const result = closing.catch((error: unknown) => error);
    await owned.exited;
    expect((await host.ledger.read()).map(record => record.pid)).toEqual([40001]);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBeInstanceOf(AggregateError);
    expect(owned.cleanupFailure).toMatchObject({ message: 'Process 40001 pipes did not close within 500 ms' });
    expect(host.owesWork()).toBe(true);
    expect(owned.owesWork).toBe(true);
    expect(driver.closed).toBe(true);
    expect(await host.ledger.read()).toEqual([]);
    entry.child.finishClose();
    await host.refresh();
    expect(host.owesWork()).toBe(false);
    expect(owned.owesWork).toBe(false);
    expect(host.close()).toBe(closing);
    await expect(owned.close()).rejects.toThrow('pipes did not close within 500 ms');
  });

  it('preserves a natural-exit pipe cleanup failure for a later host close', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    const entry = driver.entry(owned.child);
    entry.delayClose = true;
    driver.exit(entry);
    const refreshing = host.refresh();
    expect((await host.ledger.read()).map(record => record.pid)).toEqual([40001]);
    await vi.advanceTimersByTimeAsync(500);
    await refreshing;
    expect(host.owesWork()).toBe(true);
    expect(await host.ledger.read()).toEqual([]);
    await expect(host.close()).rejects.toThrow('outstanding cleanup');
    entry.child.finishClose();
    await host.refresh();
    expect(host.owesWork()).toBe(false);
  });

  it('does not settle when a group is empty but direct child exit has not been observed', async () => {
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    driver.entry(owned.child).live = false;
    expect(await owned.terminateTree(0)).toBe('timeout');
    expect(host.owesWork()).toBe(true);
    expect((await host.ledger.read()).map(record => record.pid)).toEqual([40001]);
  });

  it('retains descendants after direct child exit until the driver confirms the entire tree is empty', async () => {
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    driver.entry(owned.child).child.finishExit();
    await host.refresh();
    expect(host.owesWork()).toBe(true);
    expect((await host.ledger.read()).map(record => record.pid)).toEqual([40001]);
    await owned.killTree();
    expect(driver.entry(owned.child).live).toBe(false);
    expect(host.owesWork()).toBe(false);
  });

  it('cleans a proven child and rejects spawn when the ledger write fails', async () => {
    const { driver, host } = await fixture();
    const failure = new Error('disk unavailable');
    host.ledger.add = async () => { throw failure; };
    await expect(host.spawn(spec)).rejects.toMatchObject({ cause: failure });
    expect(driver.children.get(40001)?.live).toBe(false);
    expect(driver.children.get(40001)?.signals).toEqual(['SIGKILL']);
    expect(host.owesWork()).toBe(false);
  });

  it('retains unresolved registration without signalling when birth identity is unavailable', async () => {
    const { driver, host } = await fixture();
    driver.bind = async () => { throw new Error('Cannot read OS birth identity'); };
    await expect(host.spawn(spec)).rejects.toThrow('Process registration failed');
    expect(driver.children.get(40001)?.live).toBe(true);
    expect(driver.children.get(40001)?.signals).toEqual([]);
    expect(host.unconfirmedPids()).toEqual([40001]);
    expect(host.owesWork()).toBe(true);
    await expect(host.close()).rejects.toThrow('outstanding cleanup');
  });

  it('settles a short-lived spawned child only after proving its group absent', async () => {
    const { driver, host } = await fixture();
    driver.bind = async child => {
      driver.exit(driver.entry(child));
      throw new Error('Child exited before the birth read');
    };
    await expect(host.spawn(spec)).rejects.toThrow('Process registration failed');
    expect(driver.children.get(40001)?.signals).toEqual([]);
    expect(host.unconfirmedPids()).toEqual([]);
    expect(host.owesWork()).toBe(false);
    await host.close();
  });

  it('can close a failed registration after the driver supplies a proven tree on recheck', async () => {
    const { driver, host } = await fixture();
    const bind = driver.bind.bind(driver);
    driver.bind = async () => { throw new Error('Birth reader temporarily unavailable'); };
    await expect(host.spawn(spec)).rejects.toThrow('Process registration failed');
    expect(host.owesWork()).toBe(true);
    driver.bind = bind;
    await host.close();
    expect(driver.children.get(40001)?.signals).toEqual(['SIGKILL']);
    expect(driver.children.get(40001)?.live).toBe(false);
    expect(host.owesWork()).toBe(false);
  });

  it('retains a failed registration when group-absence inspection is denied', async () => {
    const { driver, dataDir } = await fixture();
    const host = new ProcessHost({
      dataDir, driver,
      inspectUnboundSpawn: async () => ({ kind: 'unknown', reason: 'EPERM' }),
    });
    driver.bind = async () => { throw new Error('Birth reader unavailable'); };
    await expect(host.spawn(spec)).rejects.toThrow('Process registration failed');
    const entry = driver.children.get(40001);
    if (!entry) throw new Error('Missing fixture child');
    driver.exit(entry);
    await host.refresh();
    expect(host.unconfirmedPids()).toEqual([40001]);
    expect(host.owesWork()).toBe(true);
    expect(entry.signals).toEqual([]);
    await expect(host.close()).rejects.toThrow('outstanding cleanup');
  });

  it.each(['refresh', 'close'])('rechecks failed registration through %s without trusting child exit alone', async method => {
    const { driver, host } = await fixture();
    driver.bind = async () => { throw new Error('Birth reader unavailable'); };
    await expect(host.spawn(spec)).rejects.toThrow('Process registration failed');
    const entry = driver.children.get(40001);
    if (!entry) throw new Error('Missing fixture child');
    entry.child.finishExit();
    entry.child.finishClose();
    await host.refresh();
    expect(host.unconfirmedPids()).toEqual([40001]);
    expect(host.owesWork()).toBe(true);
    entry.live = false;
    if (method === 'refresh') await host.refresh();
    else await host.close();
    expect(host.unconfirmedPids()).toEqual([]);
    expect(host.owesWork()).toBe(false);
    expect(entry.signals).toEqual([]);
  });

  it('does not infer an unbound adopted tree is empty from child exit or pipe close', async () => {
    const { driver, host } = await fixture();
    const child = driver.spawn();
    driver.bind = async () => { throw new Error('Adopted group ownership is unknown'); };
    await expect(host.adopt(child, { providerId: 'claude', sessionId: 'unknown-adoption' })).rejects.toThrow('Process registration failed');
    driver.exit(driver.entry(child));
    await host.refresh();
    expect(host.unconfirmedPids()).toEqual([40001]);
    expect(host.owesWork()).toBe(true);
    expect(driver.entry(child).signals).toEqual([]);
  });

  it('waits for delayed pipes when rechecking an unregistered child with an absent group', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    driver.bind = async () => { throw new Error('Birth reader unavailable'); };
    await expect(host.spawn(spec)).rejects.toThrow('Process registration failed');
    const entry = driver.children.get(40001);
    if (!entry) throw new Error('Missing fixture child');
    entry.delayClose = true;
    driver.exit(entry);
    const closing = host.close();
    await vi.advanceTimersByTimeAsync(499);
    expect(host.unconfirmedPids()).toEqual([40001]);
    entry.child.finishClose();
    await closing;
    expect(host.owesWork()).toBe(false);
    expect(entry.signals).toEqual([]);
  });

  it('keeps timed-out pipes owed after failed registration and driver shutdown until close is observed', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    driver.bind = async () => { throw new Error('Birth reader unavailable'); };
    await expect(host.spawn(spec)).rejects.toThrow('Process registration failed');
    const entry = driver.children.get(40001);
    if (!entry) throw new Error('Missing fixture child');
    entry.delayClose = true;
    driver.exit(entry);
    const closing = host.close();
    const result = closing.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBeInstanceOf(AggregateError);
    expect(driver.closed).toBe(true);
    expect(host.owesWork()).toBe(true);
    expect(host.unconfirmedPids()).toEqual([40001]);
    expect(entry.signals).toEqual([]);
    entry.child.finishClose();
    await host.refresh();
    expect(host.owesWork()).toBe(false);
    expect(host.unconfirmedPids()).toEqual([]);
    expect(host.close()).toBe(closing);
  });

  it('settles late pipes after a failed-registration recheck exhausts its remaining budget and closes the driver', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    const bind = driver.bind.bind(driver);
    driver.bind = async () => { throw new Error('Birth reader temporarily unavailable'); };
    await expect(host.spawn(spec)).rejects.toThrow('Process registration failed');
    const entry = driver.children.get(40001);
    if (!entry) throw new Error('Missing fixture child');
    entry.delayClose = true;
    driver.bind = bind;
    driver.bindGate = new Promise(resolve => { setTimeout(resolve, 1800); });
    const closing = host.close();
    const result = closing.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1800);
    expect(entry.signals).toEqual(['SIGKILL']);
    expect(entry.live).toBe(false);
    expect(entry.child.exitCode).toBe(0);
    expect(driver.closed).toBe(false);
    expect(host.owesWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    const failure = await result;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ message: 'Process operation deadline expired' })]),
    });
    expect(driver.closed).toBe(true);
    expect(host.owesWork()).toBe(true);
    expect(host.unconfirmedPids()).toEqual([40001]);
    const callsAfterClose = driver.calls.length;
    entry.child.finishClose();
    await host.refresh();
    expect(host.owesWork()).toBe(false);
    expect(host.unconfirmedPids()).toEqual([]);
    expect(driver.calls).toHaveLength(callsAfterClose);
    expect(host.close()).toBe(closing);
    await expect(host.close()).rejects.toBe(failure);
  });

  it.each(['direct exit', 'tree absence'])('retains failed registration after driver shutdown without proof of %s', async missingProof => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    const bind = driver.bind.bind(driver);
    driver.bind = async () => { throw new Error('Birth reader temporarily unavailable'); };
    await expect(host.spawn(spec)).rejects.toThrow('Process registration failed');
    const entry = driver.children.get(40001);
    if (!entry) throw new Error('Missing fixture child');
    entry.delayClose = true;
    driver.bind = bind;
    if (missingProof === 'direct exit') driver.beforeSignal = () => { entry.live = false; };
    else driver.beforeInspect = async () => { throw new Error('Cannot prove tree absence'); };
    const closing = host.close();
    const result = closing.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBeInstanceOf(AggregateError);
    expect(driver.closed).toBe(true);
    expect(entry.child.exitCode).toBe(missingProof === 'direct exit' ? null : 0);
    entry.child.finishClose();
    await host.refresh();
    expect(host.owesWork()).toBe(true);
    expect(host.unconfirmedPids()).toEqual([40001]);
    expect(entry.signals).toEqual(missingProof === 'direct exit' ? [] : ['SIGKILL']);
  });

  it('kills one recovered tree and removes its old-daemon record only after confirmation', async () => {
    const { driver, host, dataDir } = await fixture();
    const owned = await host.spawn(spec);
    const restarted = new ProcessHost({ dataDir, daemonBootId: 'boot-two', driver });
    expect(await restarted.sweepOrphans()).toEqual({ killed: 1, skipped: 0, unconfirmed: [] });
    expect(driver.entry(owned.child).signals).toEqual(['SIGKILL']);
    expect(driver.entry(owned.child).live).toBe(false);
    expect(await restarted.ledger.read()).toEqual([]);
    expect(restarted.owesWork()).toBe(false);
  });

  it('skips PID reuse without signalling the replacement process', async () => {
    const { driver, host, dataDir } = await fixture();
    const owned = await host.spawn(spec);
    const replacement = driver.entry(owned.child);
    replacement.startedAtMs++;
    const restarted = new ProcessHost({ dataDir, daemonBootId: 'boot-two', driver });
    expect(await restarted.sweepOrphans()).toEqual({ killed: 0, skipped: 1, unconfirmed: [] });
    expect(replacement.live).toBe(true);
    expect(replacement.signals).toEqual([]);
  });

  it('keeps unknown birth identity recorded and prevents a successful close', async () => {
    const { driver, host, dataDir } = await fixture();
    await host.spawn(spec);
    const before = await host.ledger.read();
    driver.recovery = 'unknown';
    const restarted = new ProcessHost({ dataDir, daemonBootId: 'boot-two', driver });
    expect(await restarted.sweepOrphans()).toEqual({
      killed: 0, skipped: 0, unconfirmed: [{ pid: 40001, reason: 'Birth identity is unavailable' }],
    });
    expect(await restarted.ledger.read()).toEqual(before);
    expect(restarted.owesWork()).toBe(true);
    await expect(restarted.close()).rejects.toThrow('outstanding cleanup');
  });

  it('does not claim a kill when identity changes after recovery', async () => {
    const { driver, host, dataDir } = await fixture();
    const owned = await host.spawn(spec);
    const replacement = driver.entry(owned.child);
    driver.beforeSignal = () => { replacement.startedAtMs++; };
    const restarted = new ProcessHost({ dataDir, daemonBootId: 'boot-two', driver });
    expect(await restarted.sweepOrphans()).toEqual({
      killed: 0, skipped: 0, unconfirmed: [{ pid: 40001, reason: 'Fixture process identity changed' }],
    });
    expect(replacement.live).toBe(true);
    expect(replacement.signals).toEqual([]);
    expect((await restarted.ledger.read()).length).toBe(1);
  });

  it('does not sweep records from the current daemon boot', async () => {
    const { driver, host, dataDir } = await fixture();
    await host.spawn(spec);
    const second = new ProcessHost({ dataDir, daemonBootId: 'boot-one', driver });
    expect(await second.sweepOrphans()).toEqual({ killed: 0, skipped: 1, unconfirmed: [] });
    expect((await second.ledger.read()).length).toBe(1);
    expect(second.owesWork()).toBe(true);
  });

  it('preserves a corrupt ledger and does not spawn over it', async () => {
    const { driver, host, path } = await fixture();
    await writeFile(path, '{broken');
    await expect(host.spawn(spec)).rejects.toThrow('ownership evidence was preserved');
    expect(driver.children.size).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('{broken');
    expect(host.owesWork()).toBe(true);
  });

  it('rejects duplicate ownership without overwriting the original record', async () => {
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    await expect(host.adopt(owned.child, { providerId: 'claude', sessionId: 'other' })).rejects.toThrow('already owned');
    expect((await host.ledger.read()).map(record => record.providerId)).toEqual(['codex']);
    expect(driver.entry(owned.child).live).toBe(true);
  });

  it('closes registrations that were already in flight and caches the close promise', async () => {
    const { driver, host } = await fixture();
    let unblock: () => void = () => { throw new Error('Missing gate'); };
    driver.bindGate = new Promise(resolve => { unblock = resolve; });
    const child = driver.spawn();
    const registering = host.adopt(child, { providerId: 'claude', sessionId: 'pending' });
    const closing = host.close();
    expect(host.close()).toBe(closing);
    expect(host.owesWork()).toBe(true);
    unblock();
    await registering;
    await closing;
    expect(driver.entry(child).live).toBe(false);
    expect(host.owesWork()).toBe(false);
    await expect(host.spawn(spec)).rejects.toThrow('closed');
  });

  it('shares the spawn budget between availability and binding', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    let unblock = (): void => { throw new Error('Missing availability gate'); };
    driver.availableGate = new Promise(resolve => { unblock = resolve; });
    const start = performance.now();
    const spawning = host.spawn(spec);
    await vi.advanceTimersByTimeAsync(1500);
    unblock();
    const owned = await spawning;
    expect(driver.calls.filter(call => call.operation === 'available' || call.operation === 'bind')).toEqual([
      { operation: 'available', deadlineMs: start + 2000 },
      { operation: 'bind', deadlineMs: start + 2000 },
    ]);
    await owned.killTree();
  });

  it('does not send TERM after the initial refresh exhausts its budget', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    const entry = driver.entry(owned.child);
    entry.child.finishExit();
    await host.refresh();
    driver.calls.length = 0;
    driver.beforeInspect = async () => { await new Promise<void>(resolve => setTimeout(resolve, 60)); };
    const start = performance.now();
    const terminating = owned.terminateTree(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await terminating).toBe('timeout');
    expect(driver.calls).toEqual([{ operation: 'inspect', deadlineMs: start + 50 }]);
    expect(entry.signals).toEqual([]);
    expect(host.owesWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    driver.beforeInspect = undefined;
    await owned.killTree();
  });

  it('does not send a target signal with a zero TERM budget', async () => {
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    expect(await owned.terminateTree(0)).toBe('timeout');
    expect(driver.entry(owned.child).signals).toEqual([]);
    expect(host.owesWork()).toBe(true);
    await owned.killTree();
  });

  it('keeps TERM polling on one deadline and gives KILL its independent two seconds', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    driver.entry(owned.child).ignoreTerm = true;
    driver.calls.length = 0;
    const start = performance.now();
    const closing = owned.close(50);
    await vi.advanceTimersByTimeAsync(50);
    await closing;
    const killIndex = driver.calls.findIndex(call => call.operation === 'SIGKILL');
    expect(killIndex).toBeGreaterThan(0);
    expect(driver.calls[0]).toEqual({ operation: 'SIGTERM', deadlineMs: start + 50 });
    // The KILL phase first refreshes the child, which has not exited yet.
    expect(driver.calls.slice(0, killIndex).every(call => call.deadlineMs === start + 50)).toBe(true);
    expect(driver.calls.slice(killIndex).every(call => call.deadlineMs === start + 2050)).toBe(true);
    expect(driver.entry(owned.child).signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(host.owesWork()).toBe(false);
  });

  it('forwards the active TERM deadline to exit and pipe-close event refreshes', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    driver.calls.length = 0;
    const deadlineMs = performance.now() + 800;
    expect(await owned.terminateTree(800)).toBe('exited');
    expect(driver.calls.some(call => call.operation === 'inspect')).toBe(true);
    expect(driver.calls.every(call => call.deadlineMs === deadlineMs)).toBe(true);
    expect(await host.ledger.read()).toEqual([]);
  });

  it('preserves pipe obligations when the TERM budget expires before pipe close', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    const entry = driver.entry(owned.child);
    entry.delayClose = true;
    const terminating = owned.terminateTree(50);
    await owned.exited;
    await vi.advanceTimersByTimeAsync(50);
    expect(await terminating).toBe('timeout');
    expect(host.owesWork()).toBe(true);
    expect((await host.ledger.read()).map(record => record.pid)).toEqual([40001]);
    entry.child.finishClose();
    await host.refresh();
    expect(host.owesWork()).toBe(false);
    expect(await host.ledger.read()).toEqual([]);
  });

  it('can finish delayed pipe cleanup in the independent KILL budget without signalling an empty tree', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    const entry = driver.entry(owned.child);
    entry.delayClose = true;
    const closing = owned.close(50);
    await owned.exited;
    await vi.advanceTimersByTimeAsync(80);
    expect(host.owesWork()).toBe(true);
    entry.child.finishClose();
    await closing;
    expect(entry.signals).toEqual(['SIGTERM']);
    expect(host.owesWork()).toBe(false);
    expect(await host.ledger.read()).toEqual([]);
  });

  it('shares the sweep deadline across recovery, signals and tree inspection', async () => {
    vi.useFakeTimers();
    const { driver, host, dataDir } = await fixture();
    await host.spawn(spec);
    await host.spawn({ ...spec, sessionId: 'second' });
    driver.calls.length = 0;
    const restarted = new ProcessHost({ dataDir, daemonBootId: 'boot-two', driver });
    const deadlineMs = performance.now() + 2000;
    expect(await restarted.sweepOrphans()).toEqual({ killed: 2, skipped: 0, unconfirmed: [] });
    expect(driver.calls.filter(call => call.operation === 'recover')).toHaveLength(2);
    expect(driver.calls.every(call => call.deadlineMs === deadlineMs)).toBe(true);
  });

  it('closes the driver after a tree cleanup failure without claiming the tree empty', async () => {
    const { driver, host } = await fixture();
    const owned = await host.spawn(spec);
    const entry = driver.entry(owned.child);
    driver.beforeSignal = () => { entry.startedAtMs++; };
    await expect(host.close()).rejects.toThrow('outstanding cleanup');
    expect(driver.calls.at(-1)?.operation).toBe('close');
    expect(driver.closed).toBe(true);
    expect(host.owesWork()).toBe(true);
    expect(host.unconfirmedPids()).toEqual([40001]);
    expect(entry.live).toBe(true);
    expect(entry.signals).toEqual([]);
  });

  it.each(['timeout', 'outstanding'])('rejects host close for driver %s and keeps the rejected close cached', async failure => {
    const { driver, host } = await fixture();
    driver.internalWork = true;
    driver.closeResult = failure === 'timeout' ? 'timeout' : 'closed';
    expect(host.owesWork()).toBe(true);
    const closing = host.close();
    await expect(closing).rejects.toThrow('outstanding cleanup');
    expect(driver.closed).toBe(true);
    expect(host.owesWork()).toBe(true);
    driver.internalWork = false;
    expect(host.owesWork()).toBe(false);
    expect(host.close()).toBe(closing);
    await expect(host.close()).rejects.toThrow('outstanding cleanup');
    await expect(host.spawn(spec)).rejects.toThrow('closed');
  });

  it('rejects a driver close timeout even if the driver reports no remaining work', async () => {
    const { driver, host } = await fixture();
    driver.closeResult = 'timeout';
    expect(host.owesWork()).toBe(false);
    await expect(host.close()).rejects.toThrow('outstanding cleanup');
  });

  it('bounds registration coordination and closes the driver while a bind remains unconfirmed', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    let unblock = (): void => { throw new Error('Missing bind gate'); };
    driver.bindGate = new Promise(resolve => { unblock = resolve; });
    driver.internalWork = true;
    const child = driver.spawn();
    const registering = host.adopt(child, { providerId: 'claude', sessionId: 'stalled-bind' });
    const registrationResult = registering.catch((error: unknown) => error);
    const closing = host.close();
    const closeResult = closing.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2000);
    // The registration has expired; its close-time recheck gets one bounded KILL phase.
    await vi.advanceTimersByTimeAsync(2000);
    expect(await registrationResult).toMatchObject({ message: 'Process registration failed' });
    expect(await closeResult).toBeInstanceOf(AggregateError);
    expect(driver.closed).toBe(true);
    expect(host.owesWork()).toBe(true);
    expect(host.unconfirmedPids()).toEqual([40001]);
    expect(driver.entry(child).signals).toEqual([]);
    unblock();
    driver.internalWork = false;
    driver.exit(driver.entry(child));
    await host.refresh();
    expect(host.owesWork()).toBe(true);
    expect(host.unconfirmedPids()).toEqual([40001]);
    expect(host.close()).toBe(closing);
  });

  it('bounds driver close and continues to account for late internal cleanup', async () => {
    vi.useFakeTimers();
    const { driver, host } = await fixture();
    let finish = (): void => { throw new Error('Missing close gate'); };
    driver.internalWork = true;
    driver.close = deadlineMs => {
      driver.closed = true;
      driver.calls.push({ operation: 'close', deadlineMs });
      return new Promise<ResourceCloseResult>(resolve => { finish = () => { driver.internalWork = false; resolve('closed'); }; });
    };
    const start = performance.now();
    const closing = host.close();
    const result = closing.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(7500);
    expect(await result).toBeInstanceOf(AggregateError);
    expect(driver.calls).toEqual([{ operation: 'close', deadlineMs: start + 7500 }]);
    expect(host.owesWork()).toBe(true);
    finish();
    expect(host.owesWork()).toBe(false);
    expect(host.close()).toBe(closing);
    await expect(host.adopt(new FixtureProcess(), { providerId: 'claude', sessionId: 'after-close' })).rejects.toThrow('closed');
  });
});

describe('owned PID ledger', () => {
  it('serializes separate ledger instances for the same path', async () => {
    const { host, dataDir } = await fixture();
    const record = { pid: 50001, startedAtMs: 1700000000000, daemonBootId: 'boot', providerId: 'codex', sessionId: 'a' } satisfies OwnedPidRecord;
    const other = new OwnedPidLedger(dataDir);
    await Promise.all([host.ledger.add(record), other.add({ ...record, pid: 50002 })]);
    expect((await other.read()).map(entry => entry.pid).sort()).toEqual([50001, 50002]);
    await host.ledger.remove({ ...record, daemonBootId: 'different' });
    expect((await other.read()).length).toBe(2);
  });
});

function identityReader(read: (pid: number, deadlineMs: number) => Promise<ProcessIdentity>): ReadProcessIdentity {
  return Object.assign(read, {
    owesWork: () => false,
    close: async (_deadlineMs: number): Promise<ResourceCloseResult> => 'closed',
  });
}

describe('POSIX identity boundaries with a deterministic OS reader', () => {
  it('refuses group signals when the leader birth changes before signalling', async () => {
    const driver = new FixtureDriver();
    const child = driver.spawn();
    let birth = 1700000000000;
    const signals: [number, string | number][] = [];
    const posix = new PosixProcessDriver({
      readIdentity: identityReader(async () => ({ kind: 'live', startedAtMs: birth, groupId: 40001 })),
      signal: (pid, signal) => { signals.push([pid, signal]); },
    });
    const deadlineMs = performance.now() + 2000;
    const binding = await posix.bind(child, deadlineMs);
    birth++;
    expect(await binding.tree.signal('SIGKILL', deadlineMs)).toEqual({ kind: 'refused', reason: 'Process-group leader identity changed' });
    expect(signals.filter(([, signal]) => signal !== 0)).toEqual([]);
  });

  it('keeps an exited leader with surviving descendants unconfirmed', async () => {
    const driver = new FixtureDriver();
    const child = driver.spawn();
    let identity: ProcessIdentity = { kind: 'live', startedAtMs: 1700000000000, groupId: 40001 };
    const posix = new PosixProcessDriver({ readIdentity: identityReader(async () => identity), signal: () => undefined });
    const deadlineMs = performance.now() + 2000;
    const binding = await posix.bind(child, deadlineMs);
    identity = { kind: 'missing' };
    expect(await binding.tree.inspect(deadlineMs)).toEqual({ kind: 'live' });
    expect(await binding.tree.signal('SIGKILL', deadlineMs)).toEqual({ kind: 'refused', reason: 'Cannot prove the current process-group leader identity' });
  });

  it('does not represent a matching birth snapshot as atomic orphan-signal authority', async () => {
    const posix = new PosixProcessDriver({
      readIdentity: identityReader(async () => ({ kind: 'live', startedAtMs: 1700000000000, groupId: 40001 })),
      signal: () => { throw new Error('No signal is authorized'); },
    });
    expect(await posix.recover({ pid: 40001, startedAtMs: 1700000000000, daemonBootId: 'old', providerId: 'codex', sessionId: 'session' }, performance.now() + 2000)).toEqual({
      kind: 'unverified', reason: 'Atomic identity-bound POSIX orphan signalling is not implemented',
    });
  });

  it('parses Linux ticks without confusing spaces and parentheses in the command name', () => {
    const fields = ['S', '1', '40001', ...Array<string>(16).fill('0'), '12345'];
    expect(parseLinuxStat(`40001 (name with ) parens) ${fields.join(' ')}`, 250, 1700000000000)).toEqual({
      kind: 'live', startedAtMs: 1700000049380, groupId: 40001,
    });
    expect(parseLinuxStat('broken', 250, 1700000000000)).toEqual({ kind: 'unknown', reason: 'Malformed Linux process stat' });
  });
});
