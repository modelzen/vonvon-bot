import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Distribution } from '../../daemon/src/service/distribution.js';
import type { Registration } from '../src/daemon-manager.js';
import { setLoginItem } from '../src/login-item.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
  execFile: vi.fn(() => { throw new Error('Tests must not execute a real child process.'); }),
}));

const appRoot = resolve('fixture-app');
const resources = join(appRoot, 'resources');
const executable = join(appRoot, 'Vonvon Bot');
const root = resolve('selected', 'root');
const daemon = join(resources, 'daemon');
const cliPath = join(daemon, 'bin', 'vonvon.mjs');

function setup() {
  const runtime = {
    platform: 'darwin' as NodeJS.Platform,
    packaged: true,
    resources,
    executable,
    root,
    env: { PATH: '/untrusted/bin', VONVON_HOME: '/wrong/root', VONVON_SERVICE: '1' },
  };
  const classifyDistribution = vi.fn((_root: string): Distribution => ({ kind: 'bundled', cliPath }));
  const runCommand = vi.fn(async () => ({ code: 0, stdout: 'completed', stderr: '' }));
  const readRegistration = vi.fn(async (): Promise<Registration> => ({ kind: 'ours' }));
  const reattachAfterUninstall = vi.fn(async () => {});
  const dependencies = { classifyDistribution, runCommand, readRegistration, reattachAfterUninstall };
  return { runtime, dependencies, classifyDistribution, runCommand, readRegistration, reattachAfterUninstall };
}

describe('unexposed desktop login item helper', () => {
  it('installs through the packaged CLI and verifies our registration', async () => {
    const fixture = setup();
    await expect(setLoginItem(true, fixture.runtime, fixture.dependencies)).resolves.toEqual({ code: 0, stdout: 'completed', stderr: '' });
    expect(fixture.classifyDistribution).toHaveBeenCalledExactlyOnceWith(daemon);
    expect(fixture.runCommand).toHaveBeenCalledExactlyOnceWith(
      executable, [cliPath, 'service', 'install'],
      { PATH: '/untrusted/bin', ELECTRON_RUN_AS_NODE: '1', VONVON_HOME: root },
    );
    expect(fixture.readRegistration).toHaveBeenCalledOnce();
    expect(fixture.reattachAfterUninstall).not.toHaveBeenCalled();
  });

  it('uninstalls, verifies absence, then resumes and reattaches the desktop owner once', async () => {
    const fixture = setup();
    fixture.readRegistration.mockResolvedValue({ kind: 'absent' });
    const order: string[] = [];
    fixture.runCommand.mockImplementation(async () => { order.push('command'); return { code: 0, stdout: 'uninstalled', stderr: '' }; });
    fixture.readRegistration.mockImplementation(async () => { order.push('readback'); return { kind: 'absent' }; });
    fixture.reattachAfterUninstall.mockImplementation(async () => { order.push('resume'); });

    await expect(setLoginItem(false, fixture.runtime, fixture.dependencies)).resolves.toMatchObject({ stdout: 'uninstalled' });
    expect(fixture.runCommand).toHaveBeenCalledWith(executable, [cliPath, 'service', 'uninstall'], expect.any(Object));
    expect(order).toEqual(['command', 'readback', 'resume']);
    expect(fixture.reattachAfterUninstall).toHaveBeenCalledOnce();
  });

  it.each([true, false])('refuses a nonzero %s command before readback or resume', async enabled => {
    const fixture = setup();
    fixture.runCommand.mockResolvedValue({ code: 1, stdout: '', stderr: 'transaction incomplete' });
    await expect(setLoginItem(enabled, fixture.runtime, fixture.dependencies)).rejects.toThrow('exited 1: transaction incomplete');
    expect(fixture.readRegistration).not.toHaveBeenCalled();
    expect(fixture.reattachAfterUninstall).not.toHaveBeenCalled();
  });

  it('propagates a child execution error without readback or fallback', async () => {
    const fixture = setup();
    fixture.runCommand.mockRejectedValue(new Error('child timed out'));
    await expect(setLoginItem(false, fixture.runtime, fixture.dependencies)).rejects.toThrow('child timed out');
    expect(fixture.readRegistration).not.toHaveBeenCalled();
    expect(fixture.reattachAfterUninstall).not.toHaveBeenCalled();
  });

  it.each([
    [true, { kind: 'absent' }],
    [false, { kind: 'ours' }],
    [false, { kind: 'other-root', root: '/another/root' }],
    [false, { kind: 'unrecognized', file: '/unknown/service' }],
  ] satisfies Array<[boolean, Registration]>)('refuses contradictory readback: enabled=%s, state=%j', async (enabled, registration) => {
    const fixture = setup();
    fixture.readRegistration.mockImplementation(async () => registration);
    await expect(setLoginItem(enabled, fixture.runtime, fixture.dependencies)).rejects.toThrow(`registration is ${registration.kind}`);
    expect(fixture.reattachAfterUninstall).not.toHaveBeenCalled();
  });

  it.each(['linux', 'freebsd'] as const)('refuses %s before classification or child execution', async platform => {
    const fixture = setup();
    fixture.runtime.platform = platform;
    await expect(setLoginItem(true, fixture.runtime, fixture.dependencies)).rejects.toThrow('unavailable');
    expect(fixture.classifyDistribution).not.toHaveBeenCalled();
    expect(fixture.runCommand).not.toHaveBeenCalled();
  });

  it('refuses development and unknown distributions before child execution', async () => {
    for (const kind of ['development', 'unknown'] as const) {
      const fixture = setup();
      fixture.classifyDistribution.mockReturnValue({ kind, cliPath: '/untrusted/vonvon.mjs' });
      await expect(setLoginItem(true, fixture.runtime, fixture.dependencies)).rejects.toThrow('bundled Vonvon daemon is unavailable');
      expect(fixture.runCommand).not.toHaveBeenCalled();
    }
  });

  it('refuses an unpackaged runtime before classification or child execution', async () => {
    const fixture = setup();
    fixture.runtime.packaged = false;
    await expect(setLoginItem(true, fixture.runtime, fixture.dependencies)).rejects.toThrow('packaged desktop application');
    expect(fixture.classifyDistribution).not.toHaveBeenCalled();
    expect(fixture.runCommand).not.toHaveBeenCalled();
  });
});

function setupProcess() {
  const fixture = setup();
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  vi.mocked(spawn).mockReturnValue(child);
  return {
    ...fixture,
    dependencies: {
      classifyDistribution: fixture.classifyDistribution,
      readRegistration: fixture.readRegistration,
      reattachAfterUninstall: fixture.reattachAfterUninstall,
    },
    child, stdout, stderr, kill,
  };
}

describe('default login item process runner', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it.each(['darwin', 'win32'] as const)('spawns only the packaged executable on %s with separate arguments and selected root', async platform => {
    const fixture = setupProcess();
    fixture.runtime.platform = platform;
    const request = setLoginItem(true, fixture.runtime, fixture.dependencies);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(executable, [cliPath, 'service', 'install'], {
      env: { PATH: '/untrusted/bin', ELECTRON_RUN_AS_NODE: '1', VONVON_HOME: root },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fixture.child.emit('close', 0, null);
    await expect(request).resolves.toEqual({ code: 0, stdout: '', stderr: '' });
    expect(fixture.readRegistration).toHaveBeenCalledOnce();
    expect(fixture.reattachAfterUninstall).not.toHaveBeenCalled();
    expect(fixture.kill).not.toHaveBeenCalled();
  });

  it('keeps an uninstall pending beyond 120 seconds without killing it or reattaching early', async () => {
    vi.useFakeTimers();
    const fixture = setupProcess();
    fixture.readRegistration.mockResolvedValue({ kind: 'absent' });
    const request = setLoginItem(false, fixture.runtime, fixture.dependencies);
    let settled = false;
    const observed = request.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(180_001);
    expect(settled).toBe(false);
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(fixture.readRegistration).not.toHaveBeenCalled();
    expect(fixture.reattachAfterUninstall).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    fixture.child.emit('exit', 0, null);
    await Promise.resolve();
    expect(fixture.readRegistration).not.toHaveBeenCalled();
    fixture.stdout.write('drain completed');
    fixture.child.emit('close', 0, null);
    await expect(request).resolves.toEqual({ code: 0, stdout: 'drain completed', stderr: '' });
    await observed;
    expect(fixture.readRegistration).toHaveBeenCalledOnce();
    expect(fixture.reattachAfterUninstall).toHaveBeenCalledOnce();
    expect(fixture.kill).not.toHaveBeenCalled();
  });

  it('retains at most 64 KiB per stream while consuming excess output through successful uninstall', async () => {
    const fixture = setupProcess();
    fixture.readRegistration.mockResolvedValue({ kind: 'absent' });
    const request = setLoginItem(false, fixture.runtime, fixture.dependencies);
    fixture.stdout.write(Buffer.alloc(60 * 1024, 'a'));
    fixture.stdout.write(Buffer.alloc(60 * 1024, 'b'));
    fixture.stderr.write(Buffer.alloc(80 * 1024, 'e'));
    for (let index = 0; index < 16; index += 1) {
      fixture.stdout.write(Buffer.alloc(64 * 1024, 'x'));
      fixture.stderr.write(Buffer.alloc(64 * 1024, 'y'));
    }
    expect(fixture.stdout.readableLength).toBe(0);
    expect(fixture.stderr.readableLength).toBe(0);
    expect(fixture.stdout.destroyed).toBe(false);
    expect(fixture.stderr.destroyed).toBe(false);
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(fixture.readRegistration).not.toHaveBeenCalled();
    expect(fixture.reattachAfterUninstall).not.toHaveBeenCalled();
    fixture.child.emit('close', 0, null);
    await expect(request).resolves.toEqual({
      code: 0,
      stdout: 'a'.repeat(60 * 1024) + 'b'.repeat(4 * 1024),
      stderr: 'e'.repeat(64 * 1024),
    });
    expect(fixture.readRegistration).toHaveBeenCalledOnce();
    expect(fixture.reattachAfterUninstall).toHaveBeenCalledOnce();
    expect(fixture.kill).not.toHaveBeenCalled();
  });

  it.each([true, false])('rejects a real nonzero child exit for enabled=%s before readback or reattachment', async enabled => {
    const fixture = setupProcess();
    const request = setLoginItem(enabled, fixture.runtime, fixture.dependencies);
    fixture.stderr.write('transaction incomplete');
    fixture.child.emit('close', 7, null);
    await expect(request).rejects.toThrow('exited 7: transaction incomplete');
    expect(fixture.readRegistration).not.toHaveBeenCalled();
    expect(fixture.reattachAfterUninstall).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it.each(['SIGTERM', 'SIGKILL'] satisfies NodeJS.Signals[])('rejects a child terminated by %s without fallback', async signal => {
    const fixture = setupProcess();
    const request = setLoginItem(false, fixture.runtime, fixture.dependencies);
    fixture.child.emit('close', null, signal);
    await expect(request).rejects.toThrow(`command failed (${signal})`);
    expect(fixture.readRegistration).not.toHaveBeenCalled();
    expect(fixture.reattachAfterUninstall).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('rejects a missing exit code without readback or fallback', async () => {
    const fixture = setupProcess();
    const request = setLoginItem(false, fixture.runtime, fixture.dependencies);
    fixture.child.emit('close', null, null);
    await expect(request).rejects.toThrow('no exit code');
    expect(fixture.readRegistration).not.toHaveBeenCalled();
    expect(fixture.reattachAfterUninstall).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('rejects a spawn error even if a later close event reports success', async () => {
    const fixture = setupProcess();
    const request = setLoginItem(false, fixture.runtime, fixture.dependencies);
    fixture.child.emit('error', new Error('ENOENT'));
    fixture.child.emit('close', 0, null);
    await expect(request).rejects.toThrow('command failed: ENOENT');
    expect(fixture.readRegistration).not.toHaveBeenCalled();
    expect(fixture.reattachAfterUninstall).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('rejects a synchronous spawn failure without fallback', async () => {
    const fixture = setupProcess();
    vi.mocked(spawn).mockImplementation(() => { throw new Error('invalid executable'); });
    await expect(setLoginItem(false, fixture.runtime, fixture.dependencies)).rejects.toThrow('invalid executable');
    expect(fixture.readRegistration).not.toHaveBeenCalled();
    expect(fixture.reattachAfterUninstall).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
  });
});
