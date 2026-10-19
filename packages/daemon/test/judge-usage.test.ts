import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { log } from '../src/core/logger';
import type { JudgeResult } from '../src/judge/types';
import { createJudgeUsage, JudgeUsageUnreadable, localDay, localDayBefore, readJudgeUsage, usageKey } from '../src/judge/usage';

const now = new Date(2026, 9, 19, 12).getTime();
const result = (extra: Partial<JudgeResult> = {}): JudgeResult => ({ decision: 'skip', reason: '', backend: 'codex-appserver', model: 'small', modelSource: 'default', promptSource: 'default', ms: 1, ...extra });
let dir: string, file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'judge-usage-')); file = join(dir, 'usage.json'); vi.useFakeTimers(); vi.setSystemTime(now); vi.spyOn(log, 'warn').mockImplementation(() => {}); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const stored = async () => JSON.parse(await readFile(file, 'utf8'));

it('uses local calendar days and validates source keys', () => {
  expect(localDay(new Date(2026, 9, 19, 23, 59, 59).getTime())).toBe('2026-10-19');
  expect(localDay(new Date(2026, 9, 20, 0, 0, 1).getTime())).toBe('2026-10-20');
  expect(localDayBefore(now, 29)).toBe('2026-09-20');
  expect(usageKey({ backend: 'codex-appserver' })).toBe('llm:codex-appserver');
  expect(usageKey({ backend: 'claude-agent', provider: 'typesafe' })).toBe('decision:typesafe');
  expect(usageKey({ backend: 'Bad Id' })).toBeUndefined();
});
it('batches additions for five seconds and skips invalid keys once per value', async () => {
  const write = vi.fn(async () => {});
  const usage = createJudgeUsage({ file, write, read: async () => ({}) });
  usage.add(result()); usage.add(result()); usage.add(result({ provider: 'typesafe' }));
  usage.add(result({ backend: 'Bad Id' })); usage.add(result({ backend: 'Bad Id' }));
  await vi.advanceTimersByTimeAsync(4900); expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(write).toHaveBeenCalledExactlyOnceWith(file, JSON.stringify({ version: 1, days: { '2026-10-19': { 'llm:codex-appserver': 2, 'decision:typesafe': 1 } } }));
  expect(log.warn).toHaveBeenCalledExactlyOnceWith('judge', 'usage-key-skipped', { backend: 'Bad Id', provider: undefined });
  await usage.close();
});
it('preserves existing counts, removes old days, and survives a new recorder', async () => {
  await writeFile(file, JSON.stringify({ version: 1, days: { '2026-09-01': {}, '2026-10-18': { 'llm:claude-agent': 4 }, '2026-10-19': { 'llm:codex-appserver': 1 } } }));
  const usage = createJudgeUsage({ file }); usage.add(result()); await usage.close();
  expect((await stored()).days).toEqual({ '2026-10-18': { 'llm:claude-agent': 4 }, '2026-10-19': { 'llm:codex-appserver': 2 } });
  const restarted = createJudgeUsage({ file }); restarted.add(result()); await restarted.close();
  expect((await stored()).days['2026-10-19']['llm:codex-appserver']).toBe(3);
});
it('replaces unreadable files and logs their failure once', async () => {
  const usage = createJudgeUsage({ file });
  for (let i = 0; i < 2; i++) { await writeFile(file, 'not json'); usage.add(result()); await usage.flush(); }
  expect((await stored()).days).toEqual({ '2026-10-19': { 'llm:codex-appserver': 1 } });
  expect(vi.mocked(log.warn).mock.calls.filter(c => c[1] === 'usage-unreadable')).toHaveLength(1);
  await usage.close();
});
it('restores failed increments and retries after sixty seconds', async () => {
  let text = '';
  const write = vi.fn(async (_file: string, value: string) => { text = value; }).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
  const usage = createJudgeUsage({ file, read: async () => ({}), write });
  usage.add(result()); await usage.flush(); usage.add(result());
  expect(log.warn).toHaveBeenCalledWith('judge', 'usage-write-failed', { code: 'EACCES' });
  await vi.advanceTimersByTimeAsync(59_999); expect(write).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(JSON.parse(text).days['2026-10-19']['llm:codex-appserver']).toBe(2);
  await usage.close();
});
it('serializes writes and retains additions made while a write is pending', async () => {
  let release = (): void => {};
  const write = vi.fn(async () => {}).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const usage = createJudgeUsage({ file, read: async () => ({}), write });
  usage.add(result()); const first = usage.flush(); await Promise.resolve(); await Promise.resolve();
  usage.add(result()); const second = usage.flush(); expect(write).toHaveBeenCalledTimes(1);
  release(); await Promise.all([first, second]); expect(write).toHaveBeenCalledTimes(2); await usage.close();
});
it('flushes on close, stops accepting additions and bounds a stalled write', async () => {
  const write = vi.fn(async () => {}), usage = createJudgeUsage({ file, read: async () => ({}), write });
  usage.add(result()); await usage.close(); usage.add(result()); await vi.advanceTimersByTimeAsync(5000); expect(write).toHaveBeenCalledTimes(1);
  const stuck = createJudgeUsage({ file, read: async () => ({}), write: () => new Promise<void>(() => {}) });
  stuck.add(result()); const close = stuck.close();
  await vi.advanceTimersByTimeAsync(2000); await close;
  expect(log.warn).toHaveBeenCalledWith('judge', 'usage-close-timeout');
});
it('does not overwrite newer-version files, logging only once', async () => {
  const text = JSON.stringify({ version: 2, days: { '2026-10-18': { 'llm:codex-appserver': 4 } } });
  await writeFile(file, text); const write = vi.fn(async () => {}), usage = createJudgeUsage({ file, write });
  usage.add(result()); await usage.flush(); usage.add(result()); await usage.flush();
  expect(write).not.toHaveBeenCalled(); expect(await readFile(file, 'utf8')).toBe(text);
  expect(log.warn).toHaveBeenCalledExactlyOnceWith('judge', 'usage-newer-file'); await usage.close();
});
it('reads missing files as empty and rejects invalid versions and counts', async () => {
  expect(await readJudgeUsage(file)).toEqual({});
  for (const [value, newer] of [[{ version: 2, days: {} }, true], [{ version: '1', days: {} }, undefined], [{ version: 1, days: { '2026-10-19': { 'llm:codex-appserver': -1 } } }, undefined]]) {
    await writeFile(file, JSON.stringify(value));
    await expect(readJudgeUsage(file)).rejects.toBeInstanceOf(JudgeUsageUnreadable);
    await expect(readJudgeUsage(file)).rejects.toHaveProperty('newer', newer);
  }
});

it.each(['EACCES', 'EIO', 'EMFILE'])('keeps history and pending increments on a temporary read failure: %s', async code => {
  const history = { version: 1, days: { '2026-10-18': { 'llm:claude-agent': 4 }, '2026-10-19': { 'llm:codex-appserver': 3 } } };
  await writeFile(file, JSON.stringify(history));
  const read = vi.fn(readJudgeUsage).mockRejectedValueOnce(new JudgeUsageUnreadable(code));
  const usage = createJudgeUsage({ file, read });
  usage.add(result()); await usage.flush();
  expect(await stored()).toEqual(history);
  expect(log.warn).toHaveBeenCalledWith('judge', 'usage-read-failed', { code });
  usage.add(result());
  await vi.advanceTimersByTimeAsync(59_999); expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(2);
  await usage.flush();
  expect((await stored()).days).toEqual({ '2026-10-18': { 'llm:claude-agent': 4 }, '2026-10-19': { 'llm:codex-appserver': 5 } });
  await usage.close();
});
