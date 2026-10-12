import { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnProcess } from '../../src/platform/spawn';
import { linuxProcessIdentity } from '../../src/provider/process/linux-identity';
import { nativeProcessIdentity } from '../../src/provider/process/native-identity';
import { PosixProcessDriver } from '../../src/provider/process/posix-driver';
import type { ProcessIdentity, ReadProcessIdentity } from '../../src/provider/process/posix-driver';
import { signalTree, waitForTree } from '../../src/provider/process/tree-kill';
import type { ResourceCloseResult, SignalResult, TreeState } from '../../src/provider/process/tree-kill';

vi.mock('../../src/platform/spawn', () => ({ spawnProcess: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

const originalPlatform = process.platform;

function deadline(budgetMs = 2000): number { return performance.now() + budgetMs; }

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { value: 'linux' });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

function helper() {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  child.stdout = stdout;
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  vi.mocked(spawnProcess).mockReturnValue(child);
  return { child, stdout, kill };
}

const live = { kind: 'live', startedAtMs: 1700000000123.456, groupId: 42 };

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Deferred promise not initialized'); };
  let reject: (error: Error) => void = () => { throw new Error('Deferred promise not initialized'); };
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail; });
  return { promise, resolve, reject };
}

function fakeIdentityReader(implementation: (pid: number, deadlineMs: number) => Promise<ProcessIdentity>) {
  return Object.assign(vi.fn(implementation), {
    owesWork: vi.fn(() => false),
    close: vi.fn(async (_deadlineMs: number): Promise<ResourceCloseResult> => 'closed'),
  }) satisfies ReadProcessIdentity;
}

function ownedChild(): ChildProcess {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 42 });
  return child;
}

describe('native identity helper lifecycle', () => {
  it('accepts a validated response only after successful close', async () => {
    const { child, stdout, kill } = helper();
    const settled = vi.fn();
    const result = nativeProcessIdentity('/identity-helper')(42, deadline());
    void result.then(settled);
    stdout.emit('data', JSON.stringify(live));
    child.emit('exit', 0, null);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit('close', 0, null);
    expect(await result).toEqual(live);
    expect(kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(stdout.listenerCount('data')).toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith('/identity-helper', ['42'], { stdio: ['ignore', 'pipe', 'ignore'] });
  });

  it('bounds a helper that never closes and retains unconfirmed cleanup', async () => {
    const { child, stdout, kill } = helper();
    const read = nativeProcessIdentity('/identity-helper');
    const result = read(42, deadline());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ kind: 'unknown', reason: 'Native identity helper timed out; cleanup is unconfirmed' });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(stdout.destroyed).toBe(true);
    expect(await read(43, deadline())).toEqual({ kind: 'unknown', reason: 'Native identity helper cleanup is unconfirmed' });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    child.emit('error', new Error('late error'));
    child.emit('close', 0, null);
    const nextHelper = helper();
    const next = read(43, deadline());
    nextHelper.child.emit('close', 1, null);
    expect(await next).toMatchObject({ kind: 'unknown' });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps each timed-out helper owned until its own close', async () => {
    const read = nativeProcessIdentity('/identity-helper');
    const first = helper();
    const firstRead = read(42, deadline());
    const second = helper();
    const secondRead = read(43, deadline());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await firstRead).toMatchObject({ kind: 'unknown' });
    expect(await secondRead).toMatchObject({ kind: 'unknown' });
    first.child.emit('close', null, 'SIGKILL');
    expect(await read(44, deadline())).toEqual({ kind: 'unknown', reason: 'Native identity helper cleanup is unconfirmed' });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    second.child.emit('close', null, 'SIGKILL');
    const next = helper();
    const nextRead = read(44, deadline());
    next.stdout.emit('data', JSON.stringify({ kind: 'missing' }));
    next.child.emit('close', 0, null);
    expect(await nextRead).toEqual({ kind: 'missing' });
  });

  it.each(['error', 'pipe-error', 'oversize', 'no-pipe'] as const)('fails promptly on %s without waiting for close', async failure => {
    const { child, stdout, kill } = helper();
    if (failure === 'no-pipe') child.stdout = null;
    const result = nativeProcessIdentity('/identity-helper')(42, deadline());
    if (failure === 'error') child.emit('error', new Error('helper failed'));
    if (failure === 'pipe-error') stdout.emit('error', new Error('pipe failed'));
    if (failure === 'oversize') stdout.emit('data', 'é'.repeat(2049));
    expect(await result).toMatchObject({ kind: 'unknown' });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
    child.emit('close', 0, null);
    expect(await result).toMatchObject({ kind: 'unknown' });
  });

  it.each(['false', 'throw'] as const)('does not treat kill %s as cleanup confirmation', async failure => {
    const { child, kill } = helper();
    if (failure === 'false') kill.mockReturnValue(false);
    else kill.mockImplementation(() => { throw new Error('cannot signal'); });
    const read = nativeProcessIdentity('/identity-helper');
    const result = read(42, deadline());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ kind: 'unknown' });
    expect(await read(43, deadline())).toEqual({ kind: 'unknown', reason: 'Native identity helper cleanup is unconfirmed' });
    child.emit('close', null, 'SIGKILL');
  });

  it.each([
    ['malformed JSON', '{', 0, null],
    ['extra field', JSON.stringify({ ...live, trusted: true }), 0, null],
    ['nonzero exit', JSON.stringify(live), 1, null],
    ['signal exit', JSON.stringify(live), null, 'SIGKILL'],
  ])('rejects %s', async (_name, output, code, signal) => {
    const { child, stdout } = helper();
    const result = nativeProcessIdentity('/identity-helper')(42, deadline());
    stdout.emit('data', output);
    child.emit('close', code, signal);
    expect(await result).toMatchObject({ kind: 'unknown' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed when spawn throws or input is invalid', async () => {
    vi.mocked(spawnProcess).mockImplementation(() => { throw new Error('spawn failed'); });
    const read = nativeProcessIdentity('/identity-helper');
    expect(await read(42, deadline())).toEqual({ kind: 'unknown', reason: 'Cannot start the native identity helper' });
    expect(await read(-1, deadline())).toEqual({ kind: 'unknown', reason: 'Invalid process PID' });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(() => nativeProcessIdentity('relative-helper')).toThrow('absolute path');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('identity deadlines and resource closure', () => {
  it.each(['native', 'linux'] as const)('does not start an expired %s read', async platform => {
    const read = platform === 'native' ? nativeProcessIdentity('/identity-helper') : linuxProcessIdentity(100);
    expect(await read(42, performance.now())).toMatchObject({ kind: 'unknown' });
    await expect(read(42, Infinity)).rejects.toThrow('finite');
    await expect(read(42, NaN)).rejects.toThrow('finite');
    expect(read.owesWork()).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('uses a caller budget shorter than the native helper safety limit', async () => {
    const { child, kill } = helper();
    const read = nativeProcessIdentity('/identity-helper');
    const result = read(42, deadline(20));
    expect(read.owesWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ kind: 'unknown' });
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(read.owesWork()).toBe(true);
    child.emit('close', null, 'SIGKILL');
    expect(read.owesWork()).toBe(false);
  });

  it('does not renew a shared deadline for a second helper read', async () => {
    const read = nativeProcessIdentity('/identity-helper');
    const until = deadline(20);
    const first = helper();
    const firstRead = read(42, until);
    await vi.advanceTimersByTimeAsync(10);
    first.stdout.emit('data', JSON.stringify(live));
    first.child.emit('close', 0, null);
    expect(await firstRead).toEqual(live);
    const second = helper();
    const secondRead = read(42, until);
    await vi.advanceTimersByTimeAsync(10);
    expect(await secondRead).toMatchObject({ kind: 'unknown' });
    expect(second.kill).toHaveBeenCalledWith('SIGKILL');
    second.child.emit('close', null, 'SIGKILL');
    expect(read.owesWork()).toBe(false);
  });

  it('rejects a native success delivered after its deadline before the timer runs', async () => {
    const { child, stdout, kill } = helper();
    const read = nativeProcessIdentity('/identity-helper');
    const until = deadline(20);
    const result = read(42, until);
    vi.spyOn(performance, 'now').mockReturnValue(until);
    stdout.emit('data', JSON.stringify(live));
    child.emit('close', 0, null);
    expect(await result).toMatchObject({ kind: 'unknown' });
    expect(read.owesWork()).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes normal native work without treating cancellation as close confirmation', async () => {
    const { child, kill } = helper();
    const read = nativeProcessIdentity('/identity-helper');
    const result = read(42, deadline());
    const closing = read.close(deadline(20));
    expect(read.owesWork()).toBe(true);
    expect(await result).toMatchObject({ kind: 'unknown' });
    expect(await read(43, deadline())).toEqual({ kind: 'unknown', reason: 'Native identity reader is closed' });
    await vi.advanceTimersByTimeAsync(20);
    expect(await closing).toBe('timeout');
    expect(read.owesWork()).toBe(true);
    child.emit('close', null, 'SIGKILL');
    expect(read.owesWork()).toBe(false);
    expect(await read.close(deadline())).toBe('closed');
    expect(await read(43, deadline())).toMatchObject({ kind: 'unknown' });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives concurrent close calls their own deadline and accepts an on-time close', async () => {
    const { child, kill } = helper();
    const read = nativeProcessIdentity('/identity-helper');
    const result = read(42, deadline());
    const short = read.close(deadline(5));
    const long = read.close(deadline(50));
    await vi.advanceTimersByTimeAsync(5);
    expect(await short).toBe('timeout');
    child.emit('close', null, 'SIGKILL');
    expect(await long).toBe('closed');
    expect(await result).toMatchObject({ kind: 'unknown' });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not accept a late native close as meeting the close deadline', async () => {
    const { child } = helper();
    const read = nativeProcessIdentity('/identity-helper');
    const result = read(42, deadline());
    const until = deadline(20);
    const closing = read.close(until);
    vi.spyOn(performance, 'now').mockReturnValue(until);
    child.emit('close', null, 'SIGKILL');
    expect(await closing).toBe('timeout');
    expect(read.owesWork()).toBe(false);
    expect(await result).toMatchObject({ kind: 'unknown' });
  });

  it('uses the Linux caller budget and retains both aborted requests until settlement', async () => {
    const processStat = deferred<string>();
    const bootStat = deferred<string>();
    vi.mocked(readFile).mockReturnValueOnce(processStat.promise).mockReturnValueOnce(bootStat.promise);
    const read = linuxProcessIdentity(100);
    const result = read(42, deadline(20));
    expect(read.owesWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ kind: 'unknown' });
    const closing = read.close(deadline(10));
    processStat.resolve(stat());
    await vi.advanceTimersByTimeAsync(10);
    expect(await closing).toBe('timeout');
    expect(read.owesWork()).toBe(true);
    bootStat.resolve('btime 1700000000\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(read.owesWork()).toBe(false);
    expect(await read.close(deadline())).toBe('closed');
    expect(await read(43, deadline())).toEqual({ kind: 'unknown', reason: 'Linux identity reader is closed' });
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('cancels normal Linux work and confirms close only after both reads settle', async () => {
    const processStat = deferred<string>();
    const bootStat = deferred<string>();
    vi.mocked(readFile).mockReturnValueOnce(processStat.promise).mockReturnValueOnce(bootStat.promise);
    const read = linuxProcessIdentity(100);
    const result = read(42, deadline());
    const closing = read.close(deadline(20));
    expect(await result).toMatchObject({ kind: 'unknown' });
    for (const [, options] of vi.mocked(readFile).mock.calls) expect(options).toMatchObject({ signal: { aborted: true } });
    processStat.reject(new Error('aborted'));
    await vi.advanceTimersByTimeAsync(0);
    expect(read.owesWork()).toBe(true);
    bootStat.reject(new Error('aborted'));
    expect(await closing).toBe('closed');
    expect(read.owesWork()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects Linux success delivered after the deadline before the timer runs', async () => {
    const processStat = deferred<string>();
    vi.mocked(readFile).mockReturnValueOnce(processStat.promise).mockResolvedValueOnce('btime 1700000000\n');
    const read = linuxProcessIdentity(100);
    const until = deadline(20);
    const result = read(42, until);
    vi.spyOn(performance, 'now').mockReturnValue(until);
    processStat.resolve(stat());
    expect(await result).toMatchObject({ kind: 'unknown' });
    expect(read.owesWork()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('POSIX driver deadlines and internal work', () => {
  const identity = { kind: 'live', startedAtMs: 1700000000123, groupId: 42 } satisfies ProcessIdentity;
  const record = { pid: 42, startedAtMs: identity.startedAtMs, daemonBootId: 'previous', providerId: 'codex', sessionId: 'session' } as const;

  it('passes the same absolute deadline through all identity reads and target signalling', async () => {
    const read = fakeIdentityReader(async () => identity);
    const signal = vi.fn();
    const driver = new PosixProcessDriver({ readIdentity: read, signal });
    const until = deadline(50);
    await driver.available(until);
    const { tree } = await driver.bind(ownedChild(), until);
    expect(await tree.inspect(until)).toEqual({ kind: 'live' });
    expect(await tree.signal('SIGTERM', until)).toEqual({ kind: 'sent' });
    expect(await driver.recover(record, until)).toMatchObject({ kind: 'unverified' });
    expect(read.mock.calls.map(([, received]) => received)).toEqual(Array(6).fill(until));
    expect(signal).toHaveBeenCalledWith(-42, 'SIGTERM');
    expect(driver.owesWork()).toBe(false);
  });

  it('does not start expired driver operations or a target signal', async () => {
    const read = fakeIdentityReader(async () => identity);
    const signal = vi.fn();
    const driver = new PosixProcessDriver({ readIdentity: read, signal });
    const { tree } = await driver.bind(ownedChild(), deadline());
    read.mockClear();
    const expired = performance.now();
    await expect(driver.available(expired)).rejects.toThrow('deadline');
    await expect(driver.bind(ownedChild(), expired)).rejects.toThrow('deadline');
    expect(await driver.recover(record, expired)).toMatchObject({ kind: 'unverified' });
    expect(await tree.inspect(expired)).toMatchObject({ kind: 'unknown' });
    expect(await tree.signal('SIGKILL', expired)).toMatchObject({ kind: 'refused' });
    expect(read).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it('refuses a target signal when the second identity read completes late', async () => {
    const read = fakeIdentityReader(async () => identity);
    const signal = vi.fn();
    const driver = new PosixProcessDriver({ readIdentity: read, signal });
    const { tree } = await driver.bind(ownedChild(), deadline());
    const until = deadline(20);
    read.mockResolvedValueOnce(identity).mockImplementationOnce(async () => {
      vi.spyOn(performance, 'now').mockReturnValue(until);
      return identity;
    });
    expect(await tree.signal('SIGKILL', until)).toMatchObject({ kind: 'refused' });
    expect(signal).not.toHaveBeenCalledWith(-42, 'SIGKILL');
    expect(read.mock.calls.slice(-2).map(([, received]) => received)).toEqual([until, until]);
  });

  it('does not signal from an in-flight tree operation after driver close', async () => {
    const read = fakeIdentityReader(async () => identity);
    const signal = vi.fn();
    const driver = new PosixProcessDriver({ readIdentity: read, signal });
    const { tree } = await driver.bind(ownedChild(), deadline());
    const pending = deferred<ProcessIdentity>();
    read.mockReturnValueOnce(pending.promise);
    const signalling = tree.signal('SIGTERM', deadline());
    const closing = driver.close(deadline(20));
    pending.resolve(identity);
    expect(await signalling).toMatchObject({ kind: 'refused' });
    expect(await closing).toBe('closed');
    expect(signal).not.toHaveBeenCalledWith(-42, 'SIGTERM');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('retains an unsettled driver read after its caller times out and close expires', async () => {
    const pending = deferred<ProcessIdentity>();
    const read = fakeIdentityReader(() => pending.promise);
    const driver = new PosixProcessDriver({ readIdentity: read, signal: vi.fn() });
    const available = driver.available(deadline(10));
    const failure = expect(available).rejects.toThrow('deadline');
    expect(driver.owesWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    await failure;
    expect(driver.owesWork()).toBe(true);
    const closing = driver.close(deadline(10));
    await vi.advanceTimersByTimeAsync(10);
    expect(await closing).toBe('timeout');
    expect(driver.owesWork()).toBe(true);
    expect(() => driver.spawn('forbidden', [], {})).toThrow('closed');
    pending.resolve(identity);
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.owesWork()).toBe(false);
    expect(await driver.close(deadline())).toBe('closed');
    await expect(driver.available(deadline())).rejects.toThrow('closed');
    expect(read).toHaveBeenCalledTimes(1);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('closes its actual reader while a normal helper read is in flight', async () => {
    const { child } = helper();
    const read = nativeProcessIdentity('/identity-helper');
    const driver = new PosixProcessDriver({ readIdentity: read, signal: vi.fn() });
    const available = driver.available(deadline());
    const failure = expect(available).rejects.toThrow();
    const closing = driver.close(deadline(20));
    expect(driver.owesWork()).toBe(true);
    child.emit('close', null, 'SIGKILL');
    await failure;
    expect(await closing).toBe('closed');
    expect(driver.owesWork()).toBe(false);
  });
});

describe('tree operation absolute deadlines', () => {
  it('does not inspect or signal after an already expired deadline', async () => {
    const tree = { inspect: vi.fn(async (): Promise<TreeState> => ({ kind: 'empty' })), signal: vi.fn() };
    const expired = performance.now();
    expect(await waitForTree(tree, { deadlineMs: expired })).toBe('timeout');
    await expect(signalTree(tree, 'SIGTERM', expired)).rejects.toThrow('deadline');
    expect(tree.inspect).not.toHaveBeenCalled();
    expect(tree.signal).not.toHaveBeenCalled();
  });

  it('bounds an inspection that never completes and consumes its late failure', async () => {
    const inspection = deferred<TreeState>();
    const tree = { inspect: vi.fn(() => inspection.promise), signal: vi.fn() };
    const until = deadline(20);
    const waiting = waitForTree(tree, { deadlineMs: until });
    await vi.advanceTimersByTimeAsync(20);
    expect(await waiting).toBe('timeout');
    expect(tree.inspect).toHaveBeenCalledWith(until);
    inspection.reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one deadline across repeated inspections', async () => {
    const tree = {
      inspect: vi.fn(async (): Promise<TreeState> => ({ kind: 'live' })),
      signal: vi.fn(),
    };
    const until = deadline(60);
    const waiting = waitForTree(tree, { deadlineMs: until });
    await vi.advanceTimersByTimeAsync(60);
    expect(await waiting).toBe('timeout');
    expect(tree.inspect.mock.calls).toEqual([[until], [until], [until]]);
  });

  it('rejects an empty observation delivered after the deadline', async () => {
    const inspection = deferred<TreeState>();
    const tree = { inspect: vi.fn(() => inspection.promise), signal: vi.fn() };
    const until = deadline(20);
    const waiting = waitForTree(tree, { deadlineMs: until });
    vi.spyOn(performance, 'now').mockReturnValue(until);
    inspection.resolve({ kind: 'empty' });
    expect(await waiting).toBe('timeout');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a signal operation and ignores its late success', async () => {
    const signalling = deferred<SignalResult>();
    const tree = { inspect: vi.fn(), signal: vi.fn(() => signalling.promise) };
    const until = deadline(20);
    const result = signalTree(tree, 'SIGKILL', until);
    const failure = expect(result).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(20);
    await failure;
    expect(tree.signal).toHaveBeenCalledWith('SIGKILL', until);
    signalling.resolve({ kind: 'sent' });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function stat() {
  const fields = Array<string>(20).fill('0');
  fields[0] = 'S';
  fields[2] = '42';
  fields[19] = '123';
  return `42 (identity helper) ${fields.join(' ')}`;
}

describe('Linux identity read lifecycle', () => {
  it('reads birth identity and clears the safety timer', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(stat()).mockResolvedValueOnce('btime 1700000000\n');
    expect(await linuxProcessIdentity(100)(42, deadline())).toEqual({ kind: 'live', startedAtMs: 1700000001230, groupId: 42 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['process', 'boot'] as const)('classifies missing %s data without confusing boot data with PID absence', async missing => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (missing === 'process') vi.mocked(readFile).mockRejectedValueOnce(error).mockResolvedValueOnce('btime 1700000000\n');
    else vi.mocked(readFile).mockResolvedValueOnce(stat()).mockRejectedValueOnce(error);
    expect(await linuxProcessIdentity(100)(42, deadline())).toEqual(missing === 'process'
      ? { kind: 'missing' }
      : { kind: 'unknown', reason: 'Cannot read Linux boot time' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds stalled reads, aborts both requests, and blocks retries until both settle', async () => {
    let finishStat: (value: string) => void = () => { throw new Error('stat read not started'); };
    let finishBoot: (value: string) => void = () => { throw new Error('boot read not started'); };
    vi.mocked(readFile)
      .mockReturnValueOnce(new Promise<string>(resolve => { finishStat = resolve; }))
      .mockReturnValueOnce(new Promise<string>(resolve => { finishBoot = resolve; }));
    const read = linuxProcessIdentity(100);
    const result = read(42, deadline());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ kind: 'unknown', reason: 'Linux identity read timed out; cleanup is unconfirmed' });
    for (const [, options] of vi.mocked(readFile).mock.calls) {
      expect(options).toMatchObject({ encoding: 'utf8', signal: { aborted: true } });
    }
    finishStat(stat());
    await vi.advanceTimersByTimeAsync(0);
    expect(await read(43, deadline())).toEqual({ kind: 'unknown', reason: 'Linux identity read cleanup is unconfirmed' });
    expect(readFile).toHaveBeenCalledTimes(2);
    finishBoot('btime 1700000000\n');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(readFile).mockResolvedValueOnce(stat()).mockResolvedValueOnce('btime 1700000000\n');
    expect(await read(42, deadline())).toMatchObject({ kind: 'live' });
    expect(await result).toMatchObject({ kind: 'unknown' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not clear another concurrent read\'s pending cleanup', async () => {
    let finishFirst: (value: string) => void = () => { throw new Error('first read not started'); };
    let finishSecond: (value: string) => void = () => { throw new Error('second read not started'); };
    vi.mocked(readFile)
      .mockReturnValueOnce(new Promise<string>(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce('btime 1700000000\n')
      .mockReturnValueOnce(new Promise<string>(resolve => { finishSecond = resolve; }))
      .mockResolvedValueOnce('btime 1700000000\n');
    const read = linuxProcessIdentity(100);
    const first = read(42, deadline());
    const second = read(43, deadline());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toMatchObject({ kind: 'unknown' });
    expect(await second).toMatchObject({ kind: 'unknown' });
    finishFirst(stat());
    await vi.advanceTimersByTimeAsync(0);
    expect(await read(44, deadline())).toEqual({ kind: 'unknown', reason: 'Linux identity read cleanup is unconfirmed' });
    expect(readFile).toHaveBeenCalledTimes(4);
    finishSecond(stat());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
