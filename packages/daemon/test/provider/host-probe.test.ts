import { describe, expect, it, vi } from 'vitest';
import { HostProbe, type HostCommandRunner } from '../../src/provider/policy/host-probe';

const success: HostCommandRunner = async () => ({ exitCode: 0 });

describe('host probe', () => {
  it.each([
    { os: 'darwin', executable: 'sandbox-exec', argv: ['-p', '(version 1) (allow default)', '/usr/bin/true'], sandbox: 'seatbelt' },
    { os: 'linux', executable: 'bwrap', argv: ['--unshare-user', 'true'], sandbox: 'bwrap' },
  ] as const)('executes the $os command with literal argv', async ({ os, executable, argv, sandbox }) => {
    const runCommand = vi.fn(success);
    const facts = await new HostProbe({ os, runCommand }).boot();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(executable, argv, { timeoutMs: 5_000 });
    expect(facts).toEqual({ os, commandSandbox: sandbox, installed: {} });
  });

  it.each([
    { name: 'nonzero', runCommand: async () => ({ exitCode: 1 }) },
    { name: 'signal', runCommand: async () => ({ exitCode: null }) },
    { name: 'spawn error', runCommand: async () => { throw new Error('ENOENT'); } },
    { name: 'timeout', runCommand: async () => { throw new Error('reaped after timeout'); } },
  ] satisfies { name: string; runCommand: HostCommandRunner }[])('maps $name to none', async ({ runCommand }) => {
    expect((await new HostProbe({ os: 'linux', runCommand }).boot()).commandSandbox).toBe('none');
  });

  it('does not run a command on Windows', async () => {
    const runCommand = vi.fn(success);
    expect(await new HostProbe({ os: 'win32', runCommand }).boot()).toEqual({
      os: 'win32', commandSandbox: 'none', installed: {},
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent boot callers and returns separate snapshots', async () => {
    const runCommand = vi.fn(success);
    const probe = new HostProbe({ os: 'darwin', runCommand });
    const [first, second] = await Promise.all([probe.boot(), probe.boot()]);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect((await probe.boot())).not.toBe(first);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('serializes multiple refreshes and gives boot callers the latest queued result', async () => {
    const pending: Array<(result: { exitCode: number | null }) => void> = [];
    const runCommand = vi.fn<HostCommandRunner>(() => new Promise(resolve => { pending.push(resolve); }));
    const probe = new HostProbe({ os: 'linux', runCommand });
    const initial = probe.boot();
    expect(runCommand).toHaveBeenCalledTimes(1);
    pending[0]?.({ exitCode: 0 });
    expect((await initial).commandSandbox).toBe('bwrap');

    const firstRefresh = probe.refreshForDoctor();
    const secondRefresh = probe.refreshForDoctor();
    const duringRefresh = probe.boot();
    expect(runCommand).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(runCommand).toHaveBeenCalledTimes(2);
    pending[1]?.({ exitCode: 1 });
    expect((await firstRefresh).commandSandbox).toBe('none');
    expect(runCommand).toHaveBeenCalledTimes(3);
    pending[2]?.({ exitCode: 0 });
    expect((await secondRefresh).commandSandbox).toBe('bwrap');
    expect((await duringRefresh).commandSandbox).toBe('bwrap');
    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it('replaces an old positive result after a failed refresh', async () => {
    const runCommand = vi.fn<HostCommandRunner>()
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockRejectedValueOnce(new Error('reaped after timeout'));
    const probe = new HostProbe({ os: 'darwin', runCommand });
    expect((await probe.boot()).commandSandbox).toBe('seatbelt');
    expect((await probe.refreshForDoctor()).commandSandbox).toBe('none');
    expect((await probe.boot()).commandSandbox).toBe('none');
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('preserves provider results and leaves absent or failed callbacks absent', async () => {
    const installed = { installed: true, version: '2.3', auth: 'logged-out' as const, hint: '请登录' };
    const probe = new HostProbe({ os: 'linux', runCommand: success, installProbes: {
      codex: () => installed,
      claude: () => { throw new Error('probe failed'); },
    } });
    expect((await probe.boot()).installed).toEqual({ codex: installed });
    expect((await new HostProbe({ os: 'linux', runCommand: success }).boot()).installed).toEqual({});
    expect((await new HostProbe({ os: 'linux', runCommand: success, installProbes: {
      claude: () => undefined,
    } }).boot()).installed).toEqual({});
  });

  it('detaches nested installed data from callbacks and other callers', async () => {
    const returned = { installed: false, auth: 'unknown' as const, hint: '尚未检测' };
    const probe = new HostProbe({ os: 'linux', runCommand: success, installProbes: { codex: () => returned } });
    const first = await probe.boot();
    returned.hint = 'callback changed';
    expect(first.installed.codex).toEqual({ installed: false, auth: 'unknown', hint: '尚未检测' });
    if (!first.installed.codex) throw new Error('expected Codex install result');
    first.installed.codex.hint = 'consumer changed';
    expect((await probe.boot()).installed.codex).toEqual({ installed: false, auth: 'unknown', hint: '尚未检测' });
  });

  it.each([
    { name: 'ready', callback: async () => true, expected: true },
    { name: 'not ready', callback: async () => false, expected: false },
    { name: 'unknown', callback: async () => undefined, expected: undefined },
    { name: 'failure', callback: async () => { throw new Error('RPC failed'); }, expected: undefined },
  ] satisfies { name: string; callback: () => Promise<boolean | undefined>; expected: boolean | undefined }[])(
    'records Windows readiness $name', async ({ callback, expected }) => {
      const facts = await new HostProbe({ os: 'win32', runCommand: success, windowsReadiness: callback }).boot();
      expect(facts.windowsSandboxReady).toBe(expected);
      expect(Object.hasOwn(facts, 'windowsSandboxReady')).toBe(expected !== undefined);
    },
  );
});
