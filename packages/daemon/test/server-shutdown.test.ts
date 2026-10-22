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

it('closes admission synchronously and shares the drain with abort callback reentry', async () => {
  const cleanup = deferred<InstallResult>();
  let reentered: Promise<void> | undefined;
  const jobs = new Jobs({ service: fakeService({ installBackend: (_id, _progress, signal) => {
    signal?.addEventListener('abort', () => { reentered = jobs.close(); });
    return cleanup.promise;
  } }), changed() {}, toolsSettled() {} });
  const admission = jobs.selectBackend('fake', false);
  await Promise.resolve();
  const closing = jobs.close();
  try {
    expect(jobs.close()).toBe(closing);
    expect(() => jobs.selectBackend('fake', false)).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => jobs.selectBackend('other', false)).toThrow(expect.objectContaining({ code: 'conflict' }));
    await Promise.resolve();
    expect(reentered).toBe(closing);
    jobs.attachBackend(admission, { id: 'late', open: true, event() { throw new Error('late observer'); } });
    expect(admission.operation.peers.size).toBe(0);
  } finally { cleanup.resolve(aborted); await closing; }
  expect(jobs.close()).toBe(closing);
  expect(jobs.attachBackend(admission, { id: 'replay', open: true, event() {} }).replay).toEqual([{ type: 'error', code: 'aborted', message: '安装已取消。' }]);
});

it('drains an admission selected before the service microtask starts', async () => {
  const started = vi.fn();
  const jobs = new Jobs({ service: fakeService({ installBackend: async (_id, _progress, signal) => {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (!signal?.aborted) started();
    return aborted;
  } }), changed() {}, toolsSettled() {} });
  const admission = jobs.selectBackend('fake', false);
  await jobs.close();
  expect(started).not.toHaveBeenCalled();
  expect(admission.operation.terminal).toMatchObject({ code: 'aborted' });
});

it('retains terminal work through its finalizer and drains a sibling despite finalizer failure', async () => {
  const first = deferred<InstallResult>();
  const sibling = deferred<InstallResult>();
  let closing: Promise<void> | undefined;
  let finalizers = 0;
  const jobs = new Jobs({ service: fakeService({ installBackend: id => id === 'first' ? first.promise : sibling.promise }), changed() {}, toolsSettled() { if (++finalizers === 1) throw new Error('refresh failed'); } });
  const admission = jobs.selectBackend('first', false);
  const other = jobs.selectBackend('other', false);
  const settled = vi.fn();
  jobs.attachBackend(admission, { id: 'terminal', open: true, event(event) {
    if (event.event === 'backendInstall' && event.payload.item.type !== 'log') {
      closing = jobs.close();
      void closing.then(settled, settled);
    }
  } });
  try {
    first.resolve(aborted);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closing).toBeDefined();
    expect(settled).not.toHaveBeenCalled();
    sibling.resolve(aborted);
    await expect(closing).rejects.toThrow('Jobs shutdown failed');
    expect(finalizers).toBe(2);
  } finally { first.resolve(aborted); sibling.resolve(aborted); await Promise.allSettled([admission.operation.done, other.operation.done, jobs.close()]); }
});
