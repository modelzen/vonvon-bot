import { afterEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), fail: vi.fn(), pids: [123], registered: [] as number[] }));
vi.mock('../src/core/logger', () => ({ log: f }));
vi.mock('../src/agent/owned-process', () => ({
  closeOwnedProviderProcesses: async () => {}, unconfirmedProviderPids: () => f.pids, registeredProviderPids: () => f.registered,
}));
import { closeOwnedProviders } from '../src/host/lifecycle';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); f.pids = [123]; f.registered = []; });

it('an orphan drains without sending to its absent supervisor or logging repeated IPC errors', async () => {
  vi.useFakeTimers();
  const send = vi.fn();
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { send: { value: send }, connected: { value: false } }));
  let finish!: () => void;
  const closing = closeOwnedProviders(() => new Promise<void>(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(2500);
  finish();
  await closing;
  expect(send).not.toHaveBeenCalled();
  expect(f.info).toHaveBeenCalledExactlyOnceWith('daemon-shutdown', 'owned-work-orphan', { pids: [123] });
  expect(f.fail).not.toHaveBeenCalled();
  expect(f.warn).not.toHaveBeenCalled();
});

it('a send callback error while connected still fails cleanup', async () => {
  const send = vi.fn((_message: unknown, callback: (error: Error) => void) => callback(new Error('channel closed while sending')));
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { send: { value: send }, connected: { value: true } }));
  await expect(closeOwnedProviders()).rejects.toThrow('Provider cleanup failed');
  expect(f.fail).toHaveBeenCalledWith('daemon-shutdown', expect.any(Error), { phase: 'owned-work-report' });
  expect(f.info).not.toHaveBeenCalled();
});

it('s18g ① reports orphan PID set changes through shutdown', async () => {
  vi.useFakeTimers();
  f.pids = [];
  const send = vi.fn();
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { send: { value: send }, connected: { value: false } }));
  let finish!: () => void;
  const closing = closeOwnedProviders(() => new Promise<void>(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(7000);
  f.pids = [4242];
  await vi.advanceTimersByTimeAsync(13_000);
  f.pids = [];
  finish();
  await closing;
  expect(f.info.mock.calls).toEqual([
    ['daemon-shutdown', 'owned-work-orphan', { pids: [] }],
    ['daemon-shutdown', 'owned-work-orphan', { pids: [4242] }],
    ['daemon-shutdown', 'owned-work-orphan', { pids: [] }],
  ]);
  expect(f.warn).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it('s18g ② ignores ordering changes in an orphan PID set', async () => {
  vi.useFakeTimers();
  f.pids = [7, 8];
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { send: { value: vi.fn() }, connected: { value: false } }));
  let finish!: () => void;
  const closing = closeOwnedProviders(() => new Promise<void>(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(1000);
  f.pids = [8, 7];
  await vi.advanceTimersByTimeAsync(1000);
  finish();
  await closing;
  expect(f.info).toHaveBeenCalledExactlyOnceWith('daemon-shutdown', 'owned-work-orphan', { pids: [7, 8] });
});

// owner 2026-11-02: a Bot child killed past its stop limit leaves its agents in groups of their own; the host reaps the
// groups the child last reported as registered (bot/supervisor.ts).
it('reports the registered agent groups while unsettled, and none once settled', async () => {
  vi.useFakeTimers();
  f.pids = [];
  f.registered = [501, 502];
  const sent: unknown[] = [];
  const send = vi.fn((message: unknown, callback: (error: Error | null) => void) => { sent.push(message); callback(null); });
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { send: { value: send }, connected: { value: true } }));
  let finish!: () => void;
  const closing = closeOwnedProviders(() => new Promise<void>(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(1500);
  finish();
  await closing;
  expect(sent[0]).toEqual({ fcb: 'fcb.owned-work', pids: [], settled: false, registered: [501, 502] });
  expect(sent.at(-1)).toEqual({ fcb: 'fcb.owned-work', pids: [], settled: true, registered: [] });
});
