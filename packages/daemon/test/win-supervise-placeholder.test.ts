import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runWinSupervise } from '../src/cli/commands/win-supervise';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** I4a §4.6: until I4b, the task's command runs `daemon run` once, as the Windows service, and exits with its code. */
it.each([[0, 0], [75, 75], [1, 1], [null, 1]] as const)('runs daemon run for the task\'s data root and exits with its code (%s → %s)', async (code, exit) => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-win-supervise-')); dirs.push(root);
  const child = new EventEmitter();
  const spawn = vi.fn((..._args: unknown[]) => {
    // The supervisor's pid file is there while the daemon runs.
    expect(JSON.parse(readFileSync(join(root, 'supervisor.pid'), 'utf8'))).toEqual({ pid: 4321, startedAt: '1970-01-01T00:00:01.000Z', version: '9.9.9' });
    setImmediate(() => child.emit('exit', code, code === null ? 'SIGTERM' : null));
    return child;
  });
  const result = await runWinSupervise({ port: 7788, home: root }, { spawn: spawn as never, execPath: 'C:\\node\\node.exe', entry: 'C:\\app\\bin\\vonvon.mjs', pid: 4321, now: () => 1000, version: '9.9.9' });
  expect(result).toBe(exit);
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

it('refuses a relative data root or a bad port before starting anything', async () => {
  const spawn = vi.fn();
  await expect(runWinSupervise({ port: 7788, home: 'relative' }, { spawn: spawn as never })).rejects.toThrow('absolute');
  await expect(runWinSupervise({ port: 0, home: tmpdir() }, { spawn: spawn as never })).rejects.toThrow('port');
  expect(spawn).not.toHaveBeenCalled();
});
