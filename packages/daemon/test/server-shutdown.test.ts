import { expect, it, vi } from 'vitest';
import { Jobs, type JobPeer } from '../src/server/jobs';
import { fakeService } from './server-fixture';
import type { InstallResult } from '../src/agent/installer';

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('uninitialized'); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const aborted: InstallResult = { ok: false, code: null, aborted: true, tail: 'cancelled' };

it('aborts detached backend work and keeps shutdown pending until cleanup settles', async () => {
  const cleanup = deferred<InstallResult>();
  let signal: AbortSignal | undefined;
  const service = fakeService({ installBackend: (_id, _progress, cancellation) => { signal = cancellation; return cleanup.promise; } });
  const jobs = new Jobs({ service, changed() {}, toolsSettled() {} });
  const peer: JobPeer = { id: 'gone', open: true, event() {} };
  const admission = jobs.selectBackend('fake', false);
  jobs.attachBackend(admission, peer);
  await Promise.resolve();
  jobs.detach(peer);
  const settled = vi.fn();
  const closing = jobs.close().then(settled);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(signal?.aborted).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    cleanup.resolve(aborted);
    await closing;
    expect(settled).toHaveBeenCalledOnce();
  } finally {
    cleanup.resolve(aborted);
    await admission.operation.done;
    await closing;
  }
});
