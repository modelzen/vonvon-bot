import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexProcessCleanupError, OwnedCodexProcess } from '../src/agent/codex-appserver/owned-process';
import { AppServerClient } from '../src/agent/codex-appserver/app-server-client';
import { runSetupChild } from '../src/agent/codex-appserver/managed-install';
import { writeNodeExecutable } from './helpers/node-executable';
import { WindowsCodexJob } from '../src/agent/codex-appserver/windows-job';

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const expectedCleanupErrors = new Set<unknown>();
type StartEvent =
  | { event: 'fixture-start' | 'owner-entry' | 'abort-before' | 'abort-after' | 'close-entry' | 'afterEach-entry' }
  | { event: 'owner-return' | 'spawn'; pid: number | null }
  | { event: 'exit' | 'child-close'; code: number | null }
  | { event: 'error' | 'close-settled' | 'running-settled' | 'requestStop' | 'afterEach-settled'; result: 'fulfilled' | 'rejected' }
  | { event: 'verifiedEmpty'; result: 'empty' | 'not-empty' };
type StartTrace = {
  record(event: StartEvent): void;
  emit(stage: 'pending' | 'cleanup'): void;
  timer: ReturnType<typeof setTimeout>;
};
const startDiagnostics = vi.hoisted((): { active: StartTrace | undefined } => ({ active: undefined }));
const owners = vi.hoisted(() => new Set<{ close(): Promise<void> }>());
vi.mock('../src/agent/codex-appserver/owned-process', async original => {
  const actual = await original<typeof import('../src/agent/codex-appserver/owned-process')>();
  return { ...actual, OwnedCodexProcess: class extends actual.OwnedCodexProcess {
    private readonly trace: StartTrace | undefined;
    constructor(...args: ConstructorParameters<typeof actual.OwnedCodexProcess>) {
      const trace = startDiagnostics.active;
      trace?.record({ event: 'owner-entry' });
      super(...args);
      this.trace = trace;
      owners.add(this);
      trace?.record({ event: 'owner-return', pid: this.child.pid ?? null });
      if (trace) {
        this.child.once('spawn', () => trace.record({ event: 'spawn', pid: this.child.pid ?? null }));
        this.child.once('error', () => trace.record({ event: 'error', result: 'rejected' }));
        this.child.once('exit', code => trace.record({ event: 'exit', code }));
        this.child.once('close', code => trace.record({ event: 'child-close', code }));
      }
    }
    override close(...args: Parameters<InstanceType<typeof actual.OwnedCodexProcess>['close']>): Promise<void> {
      const trace = this.trace;
      trace?.record({ event: 'close-entry' });
      const closing = super.close(...args);
      if (trace) void closing.then(
        () => trace.record({ event: 'close-settled', result: 'fulfilled' }),
        () => trace.record({ event: 'close-settled', result: 'rejected' }),
      );
      return closing;
    }
  } };
});
vi.mock('../src/agent/codex-appserver/windows-job', async original => {
  const actual = await original<typeof import('../src/agent/codex-appserver/windows-job')>();
  return { ...actual, WindowsCodexJob: class extends actual.WindowsCodexJob {
    private readonly trace = startDiagnostics.active;
    private lastEmpty: boolean | undefined;
    override requestStop(): void {
      try {
        super.requestStop();
        this.trace?.record({ event: 'requestStop', result: 'fulfilled' });
      } catch (error) {
        this.trace?.record({ event: 'requestStop', result: 'rejected' });
        throw error;
      }
    }
    override get verifiedEmpty(): boolean {
      const empty = super.verifiedEmpty;
      if (this.trace && empty !== this.lastEmpty) {
        this.trace.record({ event: 'verifiedEmpty', result: empty ? 'empty' : 'not-empty' });
        this.lastEmpty = empty;
      }
      return empty;
    }
  } };
});
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type FixtureProcess = { pid: number; started: string | undefined };
function windowsStartTime(pid: number): string | undefined {
  const script = `
    $ErrorActionPreference='Stop'
    try { $target=Get-Process -Id ${pid} -ErrorAction Stop }
    catch {
      if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { exit 0 }
      throw
    }
    try {
      $null=$target.Handle
      $started=$target.StartTime.ToUniversalTime().Ticks
      if (-not $target.HasExited) { [Console]::Out.WriteLine($started.ToString()) }
    } finally { $target.Dispose() }
  `;
  const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5000 }).trim();
  if (value && !/^\d+$/.test(value)) throw new Error('Invalid Windows fixture process creation time');
  return value || undefined;
}
function captureProcess(pid: number): FixtureProcess {
  expect(Number.isSafeInteger(pid) && pid > 0, `Invalid fixture PID: ${pid}`).toBe(true);
  const started = process.platform === 'win32' ? windowsStartTime(pid) : undefined;
  if (process.platform === 'win32') expect(started).toBeDefined();
  return { pid, started };
}
function originalAlive(target: FixtureProcess): boolean {
  if (!alive(target.pid)) return false;
  return process.platform !== 'win32' || windowsStartTime(target.pid) === target.started;
}
afterEach(async () => {
  const trace = startDiagnostics.active;
  trace?.record({ event: 'afterEach-entry' });
  const results = await Promise.allSettled([...cleanups.splice(0).map(cleanup => cleanup()), ...[...owners].map(owner => owner.close())]);
  owners.clear();
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected' && !expectedCleanupErrors.has(result.reason)) failures.push(result.reason);
  }
  expectedCleanupErrors.clear();
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (trace) {
    trace.record({ event: 'afterEach-settled', result: failures.length ? 'rejected' : 'fulfilled' });
    clearTimeout(trace.timer);
    trace.emit('cleanup');
    startDiagnostics.active = undefined;
  }
  if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed');
});
function fixture(inherit: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'codex-tree-')); roots.push(root);
  const ready = join(root, 'grandchild.pid');
  const grandchild = join(root, 'grandchild.cjs');
  writeFileSync(grandchild, `
    process.on('SIGTERM',()=>{});
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(`${ready}.tmp`)}, String(process.pid));
    fs.renameSync(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});
    setInterval(()=>{},100);
  `);
  // Windows libuv kills non-detached children when their parent exits. A detached
  // fixture survives that parent but still belongs to the non-breakaway Codex Job.
  const start = `require('node:child_process').spawn(process.execPath,[${JSON.stringify(grandchild)}],{detached:process.platform==='win32',stdio:${inherit ? "['ignore',process.stdout,process.stderr]" : "'ignore'"}});`;
  return { root, ready, start };
}
async function descendant(ready: string): Promise<FixtureProcess> {
  await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 });
  return captureProcess(Number(readFileSync(ready, 'utf8')));
}

describe('owned Codex process trees', () => {
  it.skipIf(process.platform === 'win32')('keeps polling an EPERM liveness result until the owned group is absent', async () => {
    const f = fixture(false);
    const owned = new OwnedCodexProcess(process.execPath, ['-e', 'setInterval(()=>{},100)'], { cwd: f.root, stdio: 'ignore' });
    const pid = owned.child.pid!;
    const kill = process.kill.bind(process);
    let permissionDenied = false;
    const probe = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === -pid && signal === 0 && !permissionDenied) {
        permissionDenied = true;
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      }
      return kill(target, signal);
    });
    try {
      await owned.close(100);
      expect(permissionDenied).toBe(true);
      expect(alive(pid)).toBe(false);
    } finally { probe.mockRestore(); }
  });

  it('cancels immediately while the process owner is starting', async () => {
    const started = performance.now();
    const events: Array<StartEvent & { elapsedMs: number }> = [];
    let dropped = 0;
    const trace: StartTrace = {
      record(event) {
        if (events.length === 96) { events.splice(64, 1); dropped++; }
        events.push({ ...event, elapsedMs: performance.now() - started });
      },
      emit(stage) {
        process.stderr.write(`[codex-start-diagnostic] ${JSON.stringify({ stage, elapsedMs: performance.now() - started, dropped, events })}\n`);
      },
      timer: setTimeout(() => trace.emit('pending'), 8000),
    };
    startDiagnostics.active = trace;
    trace.record({ event: 'fixture-start' });
    const f = fixture(false);
    const abort = new AbortController();
    const running = runSetupChild(process.execPath, ['-e', 'setInterval(()=>{},100)'], { cwd: f.root, signal: abort.signal });
    trace.record({ event: 'abort-before' });
    abort.abort();
    trace.record({ event: 'abort-after' });
    void running.then(
      () => trace.record({ event: 'running-settled', result: 'fulfilled' }),
      () => trace.record({ event: 'running-settled', result: 'rejected' }),
    );
    await expect(running).rejects.toThrow();
  }, 10_000);

  it('cancellation awaits an ignored-stdio descendant that ignores TERM', async () => {
    const f = fixture(false);
    const parent = join(f.root, 'parent.cjs');
    writeFileSync(parent, `${f.start}setInterval(()=>{},100);`);
    const abort = new AbortController();
    const running = runSetupChild(process.execPath, [parent], { cwd: f.root, signal: abort.signal }).catch(error => error);
    cleanups.push(async () => { abort.abort(); await running; });
    const target = await descendant(f.ready);
    abort.abort();
    const result = await running;
    if (process.platform === 'win32') expect(result).toBe(abort.signal.reason);
    else expect(result).toBeInstanceOf(CodexProcessCleanupError);
    expect(originalAlive(target)).toBe(false);
    expectedCleanupErrors.add(result);
  }, 20_000);

  it.each([false, true])('close reaps inherited pipes after leader already exited=%s', async earlyExit => {
    const f = fixture(true);
    const leaderFile = join(f.root, 'leader.pid');
    const server = writeNodeExecutable(f.root, 'server', `
      require('node:fs').writeFileSync(${JSON.stringify(leaderFile)},String(process.pid));
      ${f.start}
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);
        if(m.method==='exit')process.exit(0);
        if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
      });
    `);
    const client = new AppServerClient({ bin: server.bin, cwd: f.root, initializeTimeoutMs: 10_000 });
    await client.connect();
    const target = await descendant(f.ready);
    const leader = Number(readFileSync(leaderFile, 'utf8'));
    if (earlyExit) {
      const leaderProcess = captureProcess(leader);
      const wrapper = process.platform === 'win32'
        ? captureProcess(Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$ErrorActionPreference='Stop'; $wrappers=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${client.pid} AND Name='node.exe'"); if ($wrappers.Count -ne 1) { throw "Expected one Node wrapper, found $($wrappers.Count)" }; [Console]::Out.WriteLine($wrappers[0].ProcessId)`], { encoding: 'utf8', timeout: 15_000 }).trim()))
        : undefined;
      client.notify('exit');
      await vi.waitFor(() => expect(originalAlive(leaderProcess)).toBe(false), { timeout: 5000 });
      if (wrapper) await vi.waitFor(() => expect(originalAlive(wrapper)).toBe(false), { timeout: 5000 });
      expect(originalAlive(target)).toBe(true);
      if (process.platform !== 'win32') expect(client.exited).toBe(true);
    }
    const result = await Promise.race([client.close(50).catch(error => error), delay(8000).then(() => 'timeout')]);
    if (process.platform === 'win32' && !earlyExit) expect(result).toBeUndefined();
    else expect(result).toBeInstanceOf(CodexProcessCleanupError);
    expect(originalAlive(target)).toBe(false);
    expectedCleanupErrors.add(result);
  }, process.platform === 'win32' ? 60_000 : 30_000);
});

describe('Windows Job stop exit arbitration', () => {
  it.each([
    { name: 'owner termination', terminated: true, code: 0xe0560001, active: true, expected: 0 },
    { name: 'natural failure wins accepted termination', terminated: true, code: 7, active: true, expected: 7 },
    { name: 'natural 254 wins accepted termination', terminated: true, code: 254, active: true, expected: 254 },
    { name: 'natural success leaves descendants', terminated: true, code: 0, active: true, expected: 252 },
    { name: 'natural success empties job', terminated: true, code: 0, active: false, expected: 0 },
    { name: 'pending natural failure', terminated: false, code: 7, active: true, expected: 7 },
    { name: 'pending natural 254', terminated: false, code: 254, active: true, expected: 254 },
    { name: 'pending success leaves descendants', terminated: false, code: 0, active: true, expected: 252 },
    { name: 'termination failure remains an error', terminated: false, code: 7, active: true, error: 6, expected: new Error('6') },
    { name: 'unconfirmed exit remains an error', terminated: false, code: 7, active: true, wait: 258, expected: new Error('Native check failed') },
    { name: 'unowned marker is not success', terminated: false, code: 0xe0560001, active: true, expected: 0xe0560001 | 0 },
  ])('$name', outcome => {
    const job = new WindowsCodexJob();
    try {
      const launch = job.launch(process.execPath, []);
      const script = Buffer.from(launch[launch.length - 1]!, 'base64').toString('utf16le');
      const branch = script.match(/const uint stopMarker=[\s\S]*?return unchecked\(\(int\)code\);/)?.[0];
      expect(branch).toBeDefined();
      if (!branch) throw new Error('Missing embedded Windows stop branch');
      const executable = branch
        .replace(/\b(?:const uint|bool|int) /g, 'let ')
        .replace('GetExitCodeProcess(child.process,out code)', '(code=GetExitCodeProcess(child.process),true)')
        .replace('unchecked((int)code)', '(code | 0)');
      const events: string[] = [];
      const context = {
        child: { process: 'owned-process' }, job: 'owned-job', proof: 'proof', name: job.name, code: 0,
        TerminateProcess: (handle: string, marker: number) => {
          expect(handle).toBe('owned-process'); expect(marker).toBe(0xe0560001);
          events.push('terminate-process'); return outcome.terminated;
        },
        Marshal: { GetLastWin32Error: () => 'error' in outcome ? outcome.error : 5 },
        WaitForSingleObject: (handle: string, timeout: number) => {
          expect(handle).toBe('owned-process'); events.push(`wait-${timeout}`);
          return timeout === 0 ? 258 : ('wait' in outcome ? outcome.wait : 0);
        },
        GetExitCodeProcess: () => { events.push('exit-code'); return outcome.code; },
        Empty: () => !outcome.active,
        TerminateJobObject: (handle: string) => { expect(handle).toBe('owned-job'); events.push('terminate-job'); return true; },
        Drain: () => { events.push('drain'); },
        File: { WriteAllText: (path: string, value: string) => { expect(path).toBe('proof'); expect(value).toBe(job.name); events.push('proof'); } },
        Check: (ok: boolean) => { if (!ok) throw new Error('Native check failed'); },
        Win32Exception: Error, Exception: Error,
      };
      const run = () => runInNewContext(`(function(){${executable}})()`, context);
      if (outcome.expected instanceof Error) {
        expect(run).toThrow(outcome.expected.message);
        expect(events).not.toContain('proof');
        return;
      }
      expect(run()).toBe(outcome.expected);
      expect(events).toEqual(['terminate-process', 'wait-1000', 'exit-code', 'terminate-job', 'drain', 'proof']);
    } finally { job.dispose(); }
  });
});

describe.skipIf(process.platform !== 'win32')('Windows Job shutdown outcomes', () => {
  function launchJob(command: string, args: string[]) {
    const job = new WindowsCodexJob();
    const child = spawn(job.executable, job.launch(command, args), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', data => { stderr += String(data); });
    child.stdout.resume();
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });
    cleanups.push(async () => {
      job.requestStop();
      await exited;
      expect(job.verifiedEmpty, stderr).toBe(true);
      job.dispose();
    });
    return { job, child, exited, stderr: () => stderr };
  }

  async function controlledJob(code: number, descendants = false) {
    const f = fixture(true);
    const pidFile = join(f.root, 'target.pid');
    const wrapperFile = join(f.root, 'wrapper.pid');
    const exitFile = join(f.root, 'exit');
    const running = launchJob(process.execPath, ['-e', `
      const fs=require('node:fs');
      fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)},String(process.pid));
      fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)},${JSON.stringify(pidFile)});
      fs.writeFileSync(${JSON.stringify(`${wrapperFile}.tmp`)},String(process.ppid));
      fs.renameSync(${JSON.stringify(`${wrapperFile}.tmp`)},${JSON.stringify(wrapperFile)});
      ${descendants ? f.start : ''}
      setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitFile)}))process.exit(${code});},10);
    `]);
    const target = await descendant(pidFile);
    const wrapper = await descendant(wrapperFile);
    return { ...running, target, wrapper, exitFile, f };
  }

  it('cancels before birth and binds the empty proof to its own identity', async () => {
    const f = fixture(false);
    const born = join(f.root, 'born');
    const job = new WindowsCodexJob();
    job.requestStop();
    const other = new WindowsCodexJob();
    try {
      const child = spawn(job.executable, job.launch(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(born)},'born')`]), { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.resume();
      child.stderr.resume();
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      expect(code).toBe(0);
      expect(existsSync(born)).toBe(false);
      expect(job.verifiedEmpty).toBe(true);
      expect(other.verifiedEmpty).toBe(false);
    } finally { job.dispose(); other.dispose(); }
  }, 20_000);

  it.each([0, 7, 254])('preserves natural exit %s after death and a late stop', async code => {
    const running = await controlledJob(code);
    writeFileSync(running.exitFile, 'exit');
    expect(await running.exited, running.stderr()).toBe(code);
    running.job.requestStop();
    expect(running.job.verifiedEmpty).toBe(true);
    expect(originalAlive(running.target)).toBe(false);
    expect(originalAlive(running.wrapper)).toBe(false);
  }, 30_000);

  it('preserves a missing target executable as supervisor exit 1', async () => {
    const f = fixture(false);
    const running = launchJob(join(f.root, 'missing-executable'), []);
    expect(await running.exited, running.stderr()).toBe(1);
    expect(running.job.verifiedEmpty).toBe(true);
    expect(alive(running.child.pid!)).toBe(false);
  }, 20_000);

  it.each([7, 254])('rejects owner close for observed natural exit %s', async code => {
    const f = fixture(false);
    const owned = new OwnedCodexProcess(process.execPath, ['-e', `process.exit(${code})`], { cwd: f.root, stdio: ['pipe', 'pipe', 'pipe'] });
    owned.child.stdout?.resume();
    owned.child.stderr?.resume();
    expect((await owned.exited).code).toBe(code);
    const result: unknown = await owned.close().catch((error: unknown) => error);
    expect(result).toBeInstanceOf(CodexProcessCleanupError);
    if (!(result instanceof CodexProcessCleanupError && result.cause instanceof AggregateError)) throw new Error('Missing cleanup failure details');
    expect(result.cause.errors).toContainEqual(new Error(`Codex child exited with code ${code}`));
    expect(alive(owned.child.pid!)).toBe(false);
    expectedCleanupErrors.add(result);
  }, 20_000);

  it.each([0, 7, 254])('preserves wrapper exit %s while forcibly draining descendants', async code => {
    const running = await controlledJob(code, true);
    const grandchild = await descendant(running.f.ready);
    writeFileSync(running.exitFile, 'exit');
    await vi.waitFor(() => expect(originalAlive(running.wrapper)).toBe(false), { timeout: 5000 });
    expect(originalAlive(grandchild)).toBe(true);
    running.job.requestStop();
    expect(await running.exited, running.stderr()).toBe(code === 0 ? 252 : code);
    expect(running.job.verifiedEmpty).toBe(true);
    expect(originalAlive(running.target)).toBe(false);
    expect(originalAlive(grandchild)).toBe(false);
  }, 30_000);

  it('races owner stop with natural failure without leaking or killing an unrelated process', async () => {
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},100)'], { stdio: 'ignore' });
    const unrelatedExit = new Promise<void>(resolve => unrelated.once('close', () => resolve()));
    cleanups.push(async () => { unrelated.kill(); await unrelatedExit; });
    const unrelatedIdentity = captureProcess(unrelated.pid!);
    for (let attempt = 0; attempt < 3; attempt++) {
      const running = await controlledJob(7, true);
      const grandchild = await descendant(running.f.ready);
      writeFileSync(running.exitFile, 'exit');
      running.job.requestStop();
      const code = await running.exited;
      expect([0, 7], running.stderr()).toContain(code);
      expect(running.job.verifiedEmpty).toBe(true);
      expect(originalAlive(running.target)).toBe(false);
      expect(originalAlive(running.wrapper)).toBe(false);
      expect(originalAlive(grandchild)).toBe(false);
      expect(originalAlive(unrelatedIdentity)).toBe(true);
    }
  }, 60_000);
});
