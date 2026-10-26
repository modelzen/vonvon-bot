import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({ failRemove: new Set<string>(), failRead: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if ([...fs.failRemove].some(name => String(path).endsWith(name))) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return actual.rm(path, options);
    }),
    readdir: vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
      if (fs.failRead) throw Object.assign(new Error(`${fs.failRead}: cannot read`), { code: fs.failRead });
      return actual.readdir(...args);
    }),
  };
});
import { gcOldLogs, startLogGc, TEST_LOGS_DIR } from '../src/core/logger';

const day = (offsetDays: number): string => new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
const old = ['2001-02-03.log', '2001-02-04.log'];
const recent = [`${day(1)}.log`, `${day(6)}.log`];
const others = ['notes.txt', '2001-02-03.log.bak', 'x2001-02-03.log'];
const mine = [...old, ...others, ...recent.filter(name => name !== `${day(0)}.log`)];

beforeEach(() => {
  fs.failRemove.clear();
  fs.failRead = '';
  mkdirSync(TEST_LOGS_DIR, { recursive: true });
  for (const name of mine) writeFileSync(join(TEST_LOGS_DIR, name), 'x\n');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const name of mine) rmSync(join(TEST_LOGS_DIR, name), { force: true });
});

describe('gcOldLogs', () => {
  it('deletes only daily logs past the retention window', async () => {
    const removed = await gcOldLogs();
    expect(removed).toBeGreaterThanOrEqual(old.length);
    for (const name of old) expect(existsSync(join(TEST_LOGS_DIR, name))).toBe(false);
    for (const name of [...recent, ...others]) if (mine.includes(name)) expect(existsSync(join(TEST_LOGS_DIR, name))).toBe(true);
  });

  it('logs what it cannot delete and carries on with the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.failRemove.add(old[0]!);
    await expect(gcOldLogs()).resolves.toBeGreaterThanOrEqual(1);
    expect(existsSync(join(TEST_LOGS_DIR, old[0]!))).toBe(true);
    expect(existsSync(join(TEST_LOGS_DIR, old[1]!))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gc_failed'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(old[0]!));
  });

  it('logs an unreadable directory once and stays quiet for a missing one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.failRead = 'ENOENT';
    await expect(gcOldLogs()).resolves.toBe(0);
    expect(warn).not.toHaveBeenCalled();
    fs.failRead = 'EACCES';
    await expect(gcOldLogs()).resolves.toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('readdir'));
  });
});

describe('startLogGc', () => {
  it('trims once at start and then once a day, until stopped', async () => {
    vi.useFakeTimers();
    const gc = vi.fn(async () => 0);
    const stop = startLogGc({ gc });
    await vi.advanceTimersByTimeAsync(0);
    expect(gc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(86_400_000 - 1);
    expect(gc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(gc).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * 86_400_000);
    expect(gc).toHaveBeenCalledTimes(4);
    stop();
    await vi.advanceTimersByTimeAsync(5 * 86_400_000);
    expect(gc).toHaveBeenCalledTimes(4);
  });

  it('only logs a failure, even a synchronous one, and keeps the daily schedule', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gc = vi.fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('disk gone'))
      .mockImplementationOnce(() => { throw new Error('thrown outright'); })
      .mockResolvedValue(3);
    const stop = startLogGc({ gc });
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('disk gone'));
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('thrown outright'));
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(gc).toHaveBeenCalledTimes(3);
    stop();
  });

  it('does not keep the process alive', () => {
    const unref = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => ({ unref })) as unknown as typeof setInterval);
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    const stop = startLogGc({ gc: async () => 0 });
    expect(unref).toHaveBeenCalledOnce();
    stop();
    expect(clear).toHaveBeenCalledOnce();
    setIntervalSpy.mockRestore();
  });
});
