import { afterEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ warn: vi.fn(), fail: vi.fn(), info: vi.fn() }));
vi.mock('../src/core/logger', () => ({ log: f }));
import { armHostStopLimit, HOST_STOP_LIMIT_MS } from '../src/host/lifecycle';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

/** A control whose stop is asked for when `request` is called; `intent` as the host's own control reports it. */
function control(intent: 'restart' | 'stop') {
  let request!: () => void;
  const requested = new Promise<void>(resolve => { request = resolve; });
  return { request, value: { waitForRequest: () => requested, intent } };
}

// owner 2026-11-02: a stop, restart or update ends within 30 s, whatever a Bot or a Feishu call does meanwhile
it.each([
  ['restart', true, 75],
  ['stop', true, 0],
  ['restart', false, 1],
  ['stop', false, 1],
] as const)('a %s still running at the limit exits (managed %s → %i), after closing the run and flushing the log', async (intent, serviceManaged, code) => {
  vi.useFakeTimers();
  const order: string[] = [];
  const exit = vi.fn((value: number) => { order.push(`exit ${value}`); });
  const c = control(intent);
  armHostStopLimit(c.value, { serviceManaged, exit, beforeExit: () => { order.push('close run'); }, flush: async () => { order.push('flush'); } });
  await vi.advanceTimersByTimeAsync(HOST_STOP_LIMIT_MS * 2);
  expect(exit).not.toHaveBeenCalled(); // nothing counts before the stop is asked for
  c.request();
  await vi.advanceTimersByTimeAsync(HOST_STOP_LIMIT_MS - 1);
  expect(exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(order).toEqual(['close run', 'flush', `exit ${code}`]);
  expect(f.warn).toHaveBeenCalledWith('daemon-shutdown', 'host_stop_limit', expect.objectContaining({ limitMs: HOST_STOP_LIMIT_MS, intent, code }));
});

it('a stop that ends in time disarms the limit', async () => {
  vi.useFakeTimers();
  const exit = vi.fn();
  const c = control('stop');
  const disarm = armHostStopLimit(c.value, { serviceManaged: true, exit, ms: 1000 });
  c.request();
  await vi.advanceTimersByTimeAsync(500);
  disarm();
  await vi.advanceTimersByTimeAsync(5000);
  expect(exit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('a log flush that hangs does not hold the exit up', async () => {
  vi.useFakeTimers();
  const exit = vi.fn();
  const c = control('restart');
  armHostStopLimit(c.value, { serviceManaged: true, exit, ms: 1000, flush: () => new Promise<void>(() => {}) });
  c.request();
  await vi.advanceTimersByTimeAsync(1000);
  expect(exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1500);
  expect(exit).toHaveBeenCalledExactlyOnceWith(75);
});

it('a failing run bookkeeping is logged and the exit still comes', async () => {
  vi.useFakeTimers();
  const exit = vi.fn();
  const c = control('stop');
  armHostStopLimit(c.value, { serviceManaged: true, exit, ms: 10, beforeExit: () => { throw new Error('run.json is gone'); } });
  c.request();
  await vi.advanceTimersByTimeAsync(10);
  expect(f.fail).toHaveBeenCalledWith('daemon-shutdown', expect.any(Error), { phase: 'stop-limit' });
  expect(exit).toHaveBeenCalledExactlyOnceWith(0);
});

it('kills each reported agent group once, a group already gone is no failure, and another failure is logged', async () => {
  const { reapReportedGroups } = await import('../src/bot/supervisor');
  const kills: Array<[number, string]> = [];
  const kill = (pid: number, signal: NodeJS.Signals): void => {
    kills.push([pid, signal]);
    if (pid === -702) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    if (pid === -703) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  };
  expect(reapReportedGroups([701, 702, 701, 703], kill)).toEqual(process.platform === 'win32' ? [] : [701]);
  if (process.platform === 'win32') return;
  expect(kills).toEqual([[-701, 'SIGKILL'], [-702, 'SIGKILL'], [-703, 'SIGKILL']]);
  expect(f.fail).toHaveBeenCalledExactlyOnceWith('daemon-shutdown', expect.objectContaining({ code: 'EPERM' }), { phase: 'reap-agent-group', pid: 703 });
});
