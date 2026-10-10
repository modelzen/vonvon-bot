import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';

const processControl = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../src/platform/spawn', () => ({ spawnProcess: processControl.spawn }));

import { latestNpmVersion } from '../src/agent/installer';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function heldNpm(pid?: number) {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  Object.defineProperty(child, 'pid', { value: pid });
  Object.defineProperty(child, 'stdout', { value: stdout });
  child.kill = vi.fn(() => true);
  processControl.spawn.mockReturnValue(child);
  return { child, stdout };
}

it('keeps a timed out born npm query pending until its close', async () => {
  vi.useFakeTimers();
  const { child, stdout } = heldNpm(76543);
  let settled = false;
  const done = latestNpmVersion('@example/backend', 8000).then(result => {
    settled = true;
    return result;
  });
  try {
    stdout.write('9.8.7\n');
    await vi.advanceTimersByTimeAsync(8000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(settled).toBe(false);
  } finally {
    child.emit('close', 0, null);
    await done;
  }
  expect(await done).toBeNull();
});

it('keeps a born npm query pending after an error until its close', async () => {
  const { child } = heldNpm(76544);
  let settled = false;
  const done = latestNpmVersion('@example/backend').then(result => {
    settled = true;
    return result;
  });
  try {
    child.emit('error', new Error('fixture stream failure'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
  } finally {
    child.emit('close', 1, null);
    await done;
  }
  expect(await done).toBeNull();
});

it('settles a birthless npm error without waiting for a close', async () => {
  const { child } = heldNpm();
  const done = latestNpmVersion('@example/backend');
  child.emit('error', new Error('ENOENT'));
  expect(await done).toBeNull();
});

it('returns the parsed version after a successful close', async () => {
  const { child, stdout } = heldNpm(76545);
  const done = latestNpmVersion('@example/backend@1.0.0');
  expect(processControl.spawn).toHaveBeenCalledWith(
    'npm', ['view', '@example/backend', 'version', '--no-fund', '--no-audit'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  stdout.write('9.8.7\n');
  child.emit('close', 0, null);
  expect(await done).toBe('9.8.7');
});

it('returns null after a nonzero npm close', async () => {
  const { child, stdout } = heldNpm(76546);
  const done = latestNpmVersion('@example/backend');
  stdout.write('9.8.7\n');
  child.emit('close', 1, null);
  expect(await done).toBeNull();
});
