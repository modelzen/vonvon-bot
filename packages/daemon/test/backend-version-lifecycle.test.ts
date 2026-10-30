import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const processControl = vi.hoisted(() => ({ spawn: vi.fn() }));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), fail: vi.fn() }));
vi.mock('../src/platform/spawn', () => ({ spawnProcess: processControl.spawn }));
vi.mock('../src/core/logger', () => ({ log: logger }));
// This file owns npm child lifetime checks; CLI selection/probing is exercised
// with real executable fixtures in backend-codex-version.test.ts.
vi.mock('../src/agent/codex-appserver/locate', () => ({
  refreshCodexResolution: () => null, resolveCodexBin: () => null,
  cachedCodexVersion: () => undefined,
}));

import { latestNpmVersion } from '../src/agent/installer';
import { createAdminService } from '../src/admin/service';
import { Jobs } from '../src/server/jobs';
import { environmentRpc } from '../src/server/rpc/environment';

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
    expect(logger.info).toHaveBeenCalledExactlyOnceWith('backend-version', 'term_sent', { pkg: '@example/backend', pid: 76543 });
    await vi.advanceTimersByTimeAsync(112_001);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  } finally {
    child.emit('close', 0, null);
    await done;
  }
  expect(await done).toBeNull();
});

it('keeps a born npm query pending after an error until its close, then discards valid output', async () => {
  const { child, stdout } = heldNpm(76544);
  let settled = false;
  const done = latestNpmVersion('@example/backend').then(result => {
    settled = true;
    return result;
  });
  try {
    child.emit('error', new Error('fixture stream failure'));
    stdout.write('9.8.7\n');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
  } finally {
    child.emit('close', 0, null);
    await done;
  }
  expect(await done).toBeNull();
});

it('settles a birthless npm error without waiting for a close', async () => {
  const { child } = heldNpm();
  const done = latestNpmVersion('@example/backend');
  child.emit('error', new Error('ENOENT'));
  expect(await done).toBeNull();
  expect(child.kill).not.toHaveBeenCalled();
});

it('settles a birthless spawn without needing an error or close event', async () => {
  const { child } = heldNpm();
  let settled = false;
  const done = latestNpmVersion('@example/backend').then(result => {
    settled = true;
    return result;
  });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(true);
  } finally {
    child.emit('error', new Error('ENOENT'));
    await done;
  }
  expect(await done).toBeNull();
  expect(child.kill).not.toHaveBeenCalled();
});

it('keeps the real environment backendVersion RPC pending with its npm view child', async () => {
  vi.useFakeTimers();
  const { child } = heldNpm(76547);
  const service = createAdminService();
  const jobs = new Jobs({ service, changed() {}, toolsSettled() {} });
  let settled = false;
  // claude-agent 锁了版本、不查 npm，所以用没锁版本的 codex 条目走 npm view。
  const request = environmentRpc(service, jobs, { id: 'version', open: true, event() {} }, { type: 'backendVersion', id: 'codex-appserver' }).then(reply => {
    settled = true;
    return reply;
  });
  try {
    await vi.advanceTimersByTimeAsync(120_001);
    expect(processControl.spawn).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(settled).toBe(false);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith('backend-version', 'term_sent', { pkg: '@openai/codex', pid: 76547 });
    expect(logger.info).not.toHaveBeenCalledWith('backend-queue', 'reserved', expect.anything());
  } finally {
    child.emit('close', 0, null);
    await jobs.close();
  }
  expect(await request).toMatchObject({ kind: 'read', value: { kind: 'backendVersion', id: 'codex-appserver', latest: null, hasUpdate: false } });
});

it('returns the parsed version after a successful close', async () => {
  const { child, stdout } = heldNpm(76545);
  const done = latestNpmVersion('@example/backend@1.0.0');
  expect(processControl.spawn).toHaveBeenCalledWith(
    'npm', ['view', '@example/backend', 'version', '--no-fund', '--no-audit'],
    { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env } },
  );
  stdout.write('9.8.7\n');
  child.emit('close', 0, null);
  expect(await done).toBe('9.8.7');
});

it('asks a trusted npm-cli.js with this Node in Node mode', async () => {
  const cli = fileURLToPath(import.meta.url);
  vi.stubEnv('VONVON_NPM_CLI', cli);
  try {
    const { child, stdout } = heldNpm(76548);
    const done = latestNpmVersion('@example/backend');
    expect(processControl.spawn).toHaveBeenCalledWith(
      process.execPath, [cli, 'view', '@example/backend', 'version', '--no-fund', '--no-audit'],
      { stdio: ['ignore', 'pipe', 'ignore'], env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1', npm_config_update_notifier: 'false' }) },
    );
    stdout.write('9.8.7\n');
    child.emit('close', 0, null);
    expect(await done).toBe('9.8.7');
  } finally { vi.unstubAllEnvs(); }
});

it('returns null after a nonzero npm close', async () => {
  const { child, stdout } = heldNpm(76546);
  const done = latestNpmVersion('@example/backend');
  stdout.write('9.8.7\n');
  child.emit('close', 1, null);
  expect(await done).toBeNull();
});
