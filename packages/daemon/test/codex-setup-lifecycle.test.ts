import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../src/platform/spawn', async original => ({ ...await original<object>(), spawnProcess: transport.spawn }));

describe.skipIf(process.platform === 'win32')('POSIX setup child lifecycle', () => {
  const pid = 987654329;
  let child: ChildProcess;
  let stdout: PassThrough;
  let stderr: PassThrough;
  let groupPresent: boolean;
  let signalFailure: Error | undefined;
  let runSetupChild: typeof import('../src/agent/codex-appserver/managed-install').runSetupChild;
  let ownerModule: typeof import('../src/agent/owned-process');
  const endings: Promise<void>[] = [];

  type Outcome = { kind: 'pending' } | { kind: 'fulfilled'; value: string } | { kind: 'rejected'; error: unknown };
  function observe(promise: Promise<string>) {
    let outcome: Outcome = { kind: 'pending' };
    endings.push(promise.then(value => { outcome = { kind: 'fulfilled', value }; }, error => { outcome = { kind: 'rejected', error }; }));
    return () => outcome;
  }
  function start(options: { timeoutMs?: number } = {}) {
    const abort = new AbortController();
    const outcome = observe(runSetupChild('/fixture/no-provider', [], { cwd: '/fixture', signal: abort.signal, ...options }));
    return { abort, outcome };
  }
  function die(code = 0) {
    groupPresent = false;
    child.emit('exit', code, null);
    child.emit('close', code, null);
  }
  function causes(error: unknown): unknown[] {
    if (!(error instanceof Error)) return [error];
    return [error, ...('cause' in error ? causes(error.cause) : []), ...(error instanceof AggregateError ? error.errors.flatMap(causes) : [])];
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    endings.length = 0;
    groupPresent = true;
    signalFailure = undefined;
    child = new ChildProcess();
    stdout = new PassThrough();
    stderr = new PassThrough();
    Object.defineProperties(child, { pid: { value: pid, configurable: true }, stdout: { value: stdout }, stderr: { value: stderr } });
    vi.spyOn(child, 'kill').mockImplementation(() => { throw new Error('Unexpected direct child signal'); });
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target !== -pid) throw new Error(`Unowned signal target ${target}`);
      if (!groupPresent) throw Object.assign(new Error('fixture group absent'), { code: 'ESRCH' });
      if (signal !== 0 && signalFailure) throw signalFailure;
      return true;
    });
    transport.spawn.mockReset().mockReturnValueOnce(child).mockImplementation(() => { throw new Error('Unexpected fixture spawn'); });
    ownerModule = await import('../src/agent/owned-process');
    ({ runSetupChild } = await import('../src/agent/codex-appserver/managed-install'));
  });
  afterEach(async () => {
    die();
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(endings);
    for (const [target] of vi.mocked(process.kill).mock.calls) expect(target).toBe(-pid);
    expect(child.kill).not.toHaveBeenCalled();
    stdout.destroy();
    stderr.destroy();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('control: birthless ENOENT rejects promptly with the original error and no signals', async () => {
    Object.defineProperty(child, 'pid', { value: undefined });
    const { outcome } = start();
    const failure = Object.assign(new Error('spawn fixture ENOENT'), { code: 'ENOENT' });
    child.emit('error', failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome()).toEqual({ kind: 'rejected', error: failure });
    const result = outcome();
    if (result.kind === 'rejected') expect(result.error).toBe(failure);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('postbirth error keeps setup pending until death and preserves the original failure', async () => {
    const { outcome } = start();
    const failure = new Error('postbirth fixture pipe error');
    child.emit('error', failure);
    await vi.advanceTimersByTimeAsync(6000);
    expect.soft(outcome().kind).toBe('pending');
    await vi.advanceTimersByTimeAsync(114000);
    expect.soft(outcome().kind).toBe('pending');
    die();
    await vi.advanceTimersByTimeAsync(1000);
    const result = outcome();
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect.soft(result.error).toBeInstanceOf(ownerModule.ProviderProcessCleanupError);
      expect(causes(result.error)).toContain(failure);
    }
  });

  it.each([
    { interruption: 'cancellation', uncertainty: 'group' },
    { interruption: 'cancellation', uncertainty: 'direct exit' },
    { interruption: 'timeout', uncertainty: 'group' },
    { interruption: 'timeout', uncertainty: 'direct exit' },
  ])('$interruption keeps setup pending through $uncertainty uncertainty, then reports cleanup failure', async ({ interruption, uncertainty }) => {
    const failure = new Error('fixture signal transport failed');
    signalFailure = failure;
    const { abort, outcome } = start({ timeoutMs: interruption === 'timeout' ? 10 : 300000 });
    if (interruption === 'cancellation') abort.abort(new Error('fixture cancellation'));
    else await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(0);
    if (uncertainty === 'direct exit') groupPresent = false;
    else { child.emit('exit', 0, null); child.emit('close', 0, null); }
    await vi.advanceTimersByTimeAsync(6000);
    expect.soft(outcome().kind).toBe('pending');
    await vi.advanceTimersByTimeAsync(114000);
    expect.soft(outcome().kind).toBe('pending');
    die();
    await vi.advanceTimersByTimeAsync(1000);
    const result = outcome();
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.error).toBeInstanceOf(ownerModule.ProviderProcessStoppedError);
      expect(causes(result.error)).toContain(failure);
    }
  });

  it('repeated detection cannot spawn a replacement while the old process group is still alive', async () => {
    const locate = await import('../src/agent/codex-appserver/locate');
    vi.spyOn(locate, 'resolveCodexBin').mockReturnValue('/fixture/no-provider');
    const { CodexSetupService } = await import('../src/agent/codex-appserver/setup');
    const value = new CodexSetupService();
    const pending = value.setup();
    const outcome = observe(pending.then(() => 'unexpected success'));
    child.emit('error', new Error('fixture transport failed'));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(120000);
    expect(outcome().kind).toBe('pending');
    expect(value.setup()).toBe(pending);
    expect(transport.spawn).toHaveBeenCalledTimes(1);
    die();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).rejects.toBeInstanceOf(ownerModule.ProviderProcessStoppedError);
    await expect(value.close()).resolves.toBeUndefined();
  });

  it('control: successful setup returns trimmed stdout after confirmed death', async () => {
    const { outcome } = start();
    stdout.write('  codex-cli fixture\n');
    stderr.write('ignored diagnostic');
    die();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome()).toEqual({ kind: 'fulfilled', value: 'codex-cli fixture' });
  });

  it('control: nonzero exit retains its original status after confirmed death', async () => {
    const { outcome } = start();
    die(23);
    await vi.advanceTimersByTimeAsync(0);
    const result = outcome();
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.error).toBeInstanceOf(Error);
      expect(causes(result.error).some(cause => cause instanceof Error && /\b23\b/.test(cause.message))).toBe(true);
    }
  });
});
