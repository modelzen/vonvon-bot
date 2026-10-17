import { afterEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), fail: vi.fn() }));
vi.mock('../src/core/logger', () => ({ log: f }));
vi.mock('../src/agent/codex-appserver/owned-process', () => ({
  closeOwnedCodexProcesses: async () => {}, unconfirmedCodexPids: () => [123],
}));
import { closeOwnedProviders } from '../src/host/lifecycle';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

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
