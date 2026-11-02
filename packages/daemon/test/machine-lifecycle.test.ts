import { expect, it, vi } from 'vitest';
import { fakeService } from './server-fixture';
import { machineRpc } from '../src/server/rpc/machine';
import type { ShutdownControl } from '../src/host/lifecycle';
import type { UpdateStatus } from '../src/service/update';

function control() {
  return {
    requested: false,
    waitForRequest: async () => {},
    requestStop: vi.fn(),
    requestRestart: vi.fn(),
    completeShutdown: async (release: () => Promise<void>) => release(),
    dispose: () => {},
  } satisfies ShutdownControl;
}

it('accepts stop intent before producing the done reply', async () => {
  const owner = control();
  const outcome = await machineRpc(fakeService(), owner, 43119, { type: 'stopHost' });
  expect(outcome.kind).toBe('read');
  expect(owner.requestStop).toHaveBeenCalledTimes(1);
});

// owner 2026-11-02: a desktop update stops the server; the cut-short turns' cards then say it was updated
it('passes a desktop update\'s stop reason on, and none for a plain stop', async () => {
  const owner = control();
  await machineRpc(fakeService(), owner, 43119, { type: 'stopHost', reason: 'update' });
  await machineRpc(fakeService(), owner, 43119, { type: 'stopHost' });
  expect(owner.requestStop.mock.calls).toEqual([['update'], [undefined]]);
});

it('interleaved update replies carry their own exact record into restart', async () => {
  const first = { phase: 'restarting', from: '1', to: '2', ok: true, at: 10 } satisfies UpdateStatus;
  const second = { phase: 'restarting', from: '2', to: '3', ok: true, at: 11 } satisfies UpdateStatus;
  const applyUpdate = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const updateStatus = vi.fn(() => second);
  const service = fakeService({ applyUpdate, updateStatus });
  const owner = control();
  const firstReply = await machineRpc(service, owner, 43119, { type: 'applyCoreUpdate' });
  const secondReply = await machineRpc(service, owner, 43119, { type: 'applyCoreUpdate' });
  expect(owner.requestRestart).not.toHaveBeenCalled();
  if (firstReply.kind !== 'shutdown' || secondReply.kind !== 'shutdown') throw new Error('Expected shutdown replies');
  secondReply.afterReply();
  firstReply.afterReply();
  expect(owner.requestRestart.mock.calls).toEqual([[43119, second], [43119, first]]);
  expect(updateStatus).not.toHaveBeenCalled();
});
