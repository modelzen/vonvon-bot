import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runWinSupervise } from '../src/cli/commands/win-supervise';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** Runs the placeholder against a scripted list of daemon exit codes, on a fake clock; returns what it did. */
async function supervise(codes: readonly (number | null)[], runMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-win-supervise-')); dirs.push(root);
  let clock = 1000;
  const sleeps: number[] = [];
  const queue = [...codes];
  const spawn = vi.fn((..._args: unknown[]) => {
    // The supervisor's pid file is there while the daemon runs.
    expect(JSON.parse(readFileSync(join(root, 'supervisor.pid'), 'utf8'))).toEqual({ pid: 4321, startedAt: '1970-01-01T00:00:01.000Z', version: '9.9.9' });
    const child = new EventEmitter();
    const code = queue.shift();
    if (code === undefined) throw new Error('spawned once too often');
    setImmediate(() => { clock += runMs; child.emit('exit', code, code === null ? 'SIGTERM' : null); });
    return child;
  });
  const result = await runWinSupervise({ port: 7788, home: root }, {
    spawn: spawn as never, execPath: 'C:\\node\\node.exe', entry: 'C:\\app\\bin\\vonvon.mjs', pid: 4321, now: () => clock, version: '9.9.9',
    sleep: async ms => { sleeps.push(ms); clock += ms; },
  });
  return { root, result, spawn, sleeps };
}

/** I4a §4.6: until I4b, the task's command runs `daemon run` as the Windows service and restarts it itself (review F4). */
it('runs daemon run for the task\'s data root, hidden, as the Windows service; exit 0 ends it', async () => {
  const { root, result, spawn, sleeps } = await supervise([0]);
  expect(result).toBe(0);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(sleeps).toEqual([]);
  const [file, args, options] = spawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv; stdio: unknown[]; windowsHide: boolean; detached?: boolean }];
  expect(file).toBe('C:\\node\\node.exe');
  expect(args).toEqual(['C:\\app\\bin\\vonvon.mjs', 'daemon', 'run', '--port', '7788']);
  expect(options.env).toMatchObject({ VONVON_HOME: root, VONVON_SERVICE: 'windows' });
  expect(options.windowsHide).toBe(true);
  expect(options.detached).toBeUndefined();
  expect(options.stdio[0]).toBe('ignore');
  expect(existsSync(join(root, 'service.log')) && existsSync(join(root, 'service.err.log'))).toBe(true);
  expect(existsSync(join(root, 'supervisor.pid'))).toBe(false);
});

it('starts the daemon again itself: at once after 75 (a requested restart), 5 s after a crash or a kill', async () => {
  // Task Scheduler's RestartOnFailure never sees these: it retries only a task that failed to start.
  const { root, result, spawn, sleeps } = await supervise([75, 1, null, 0]);
  expect(result).toBe(0);
  expect(spawn).toHaveBeenCalledTimes(4);
  expect(sleeps).toEqual([5000, 5000]);
  expect(readFileSync(join(root, 'service.err.log'), 'utf8')).toContain('daemon exited 75; starting it again in 0 s');
  expect(existsSync(join(root, 'supervisor.pid'))).toBe(false);
});

it('waits 30 s after five failures in a row within a minute each; a longer run or a restart resets the count', async () => {
  const quick = await supervise([1, 1, 1, 1, 1, 1, 0]);
  expect(quick.sleeps).toEqual([5000, 5000, 5000, 5000, 30_000, 30_000]);
  const restarts = await supervise([75, 75, 75, 75, 75, 75, 0]);
  expect(restarts.sleeps).toEqual([]);
  const slow = await supervise([1, 1, 1, 1, 1, 1, 0], 61_000);
  expect(slow.sleeps).toEqual([5000, 5000, 5000, 5000, 5000, 5000]);
});

it('refuses a relative data root or a bad port before starting anything', async () => {
  const spawn = vi.fn();
  await expect(runWinSupervise({ port: 7788, home: 'relative' }, { spawn: spawn as never })).rejects.toThrow('absolute');
  await expect(runWinSupervise({ port: 0, home: tmpdir() }, { spawn: spawn as never })).rejects.toThrow('port');
  expect(spawn).not.toHaveBeenCalled();
});
