import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdmissionBusy, OutboundAdmission, type AdmissionBudget } from '../../src/provider/outbound/admission';

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('not initialized'); };
  let reject: (error: unknown) => void = () => { throw new Error('not initialized'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => vi.advanceTimersByTimeAsync(0);
const holdEight = (admission: OutboundAdmission, budget: AdmissionBudget) =>
  Promise.all(Array.from({ length: 8 }, () => admission.acquire(budget)));

describe('process-local outbound admission', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it.each(['batch', 'read', 'capture'] as const)('admits exactly eight %s owners and expires only the ninth waiter', async budget => {
    const admission = new OutboundAdmission();
    const owners = await holdEight(admission, budget);
    const ninth = admission.acquire(budget);
    const expired = expect(ninth).rejects.toMatchObject({ code: 'busy', budget, waitedMs: 2000 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(admission.usage[budget]).toBe(8);
    expect(admission.usage.waiters).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expired;
    expect(admission.usage[budget]).toBe(8);
    expect(admission.usage.waiters).toBe(0);
    owners.forEach(owner => { owner.release(); owner.release(); });
    expect(admission.usage[budget]).toBe(0);
  });

  it('shares exactly sixteen waiting places across batches, reads and captures', async () => {
    const admission = new OutboundAdmission();
    const budgets: AdmissionBudget[] = ['batch', 'read', 'capture'];
    const owners = await Promise.all(budgets.map(budget => holdEight(admission, budget)));
    const queued = Array.from({ length: 16 }, (_, index) => admission.acquire(
      index < 6 ? 'batch' : index < 11 ? 'read' : 'capture',
    ));
    const expiration = Promise.all(queued.map(promise => expect(promise).rejects.toMatchObject({ waitedMs: 2000 })));
    expect(admission.usage).toEqual({ batch: 8, read: 8, capture: 8, native: 0, waiters: 16, reservedBytes: 0 });
    await expect(admission.acquire('capture')).rejects.toMatchObject({ code: 'busy', budget: 'capture', waitedMs: 0 });
    await vi.advanceTimersByTimeAsync(2000);
    await expiration;
    expect(admission.usage.waiters).toBe(0);
    owners.flat().forEach(owner => owner.release());
  });

  it('bounds captures at eight active plus sixteen queued', async () => {
    const admission = new OutboundAdmission();
    const owners = await holdEight(admission, 'capture');
    const queued = Array.from({ length: 16 }, () => admission.acquire('capture'));
    await expect(admission.acquire('capture')).rejects.toMatchObject({ budget: 'capture', waitedMs: 0 });
    owners.forEach(owner => owner.release());
    const first = await Promise.all(queued.slice(0, 8));
    expect(admission.usage.capture).toBe(8);
    expect(admission.usage.waiters).toBe(8);
    first.forEach(owner => owner.release());
    (await Promise.all(queued.slice(8))).forEach(owner => owner.release());
    expect(admission.usage.capture).toBe(0);
  });

  it('hands off in FIFO order without letting a blocked budget stall an eligible one', async () => {
    const admission = new OutboundAdmission();
    const batches = await holdEight(admission, 'batch');
    const reads = await holdEight(admission, 'read');
    const order: string[] = [];
    const batch = admission.acquire('batch').then(owner => { order.push('batch'); return owner; });
    const first = admission.acquire('read').then(owner => { order.push('first'); return owner; });
    const second = admission.acquire('read').then(owner => { order.push('second'); return owner; });
    reads[0]?.release();
    const firstOwner = await first;
    expect(order).toEqual(['first']);
    expect(admission.usage.read).toBe(8);
    const late = admission.acquire('read').then(owner => { order.push('late'); return owner; });
    firstOwner.release();
    const secondOwner = await second;
    expect(order).toEqual(['first', 'second']);
    secondOwner.release();
    (await late).release();
    batches[0]?.release();
    (await batch).release();
    expect(order).toEqual(['first', 'second', 'late', 'batch']);
    [...batches, ...reads].forEach(owner => owner.release());
  });

  it('removes expired waiters before handoff even when their timer has not run', async () => {
    const admission = new OutboundAdmission();
    const owners = await holdEight(admission, 'read');
    const stale = admission.acquire('read');
    const expired = expect(stale).rejects.toMatchObject({ waitedMs: 2000 });
    vi.setSystemTime(Date.now() + 2000);
    owners[0]?.release();
    await expired;
    const fresh = await admission.acquire('read');
    expect(admission.usage.read).toBe(8);
    expect(admission.usage.waiters).toBe(0);
    fresh.release();
    owners.forEach(owner => owner.release());
  });

  it('retains the original operation through rejection and asynchronous cleanup after an outer timeout', async () => {
    const admission = new OutboundAdmission();
    const io = deferred<void>();
    const cleanup = deferred<void>();
    const original = admission.run('read', async () => {
      try { await io.promise; } finally { await cleanup.promise; }
    });
    const rejected = expect(original).rejects.toThrow('read failed');
    const outer = Promise.race([original, new Promise(resolve => setTimeout(() => resolve('timeout'), 10))]);
    await vi.advanceTimersByTimeAsync(10);
    expect(await outer).toBe('timeout');
    expect(admission.usage.read).toBe(1);
    io.reject(new Error('read failed'));
    await tick();
    expect(admission.usage.read).toBe(1);
    cleanup.resolve();
    await rejected;
    expect(admission.usage.read).toBe(0);
  });

  it('releases a transferred admission only on the original settlement', async () => {
    const admission = new OutboundAdmission();
    const owner = await admission.acquire('batch');
    const original = deferred<void>();
    owner.transferTo(original.promise);
    owner.release();
    owner.transferTo(Promise.reject(new Error('duplicate transfer')));
    await tick();
    expect(admission.usage.batch).toBe(1);
    original.reject(new Error('cleanup failed'));
    await tick();
    owner.release();
    expect(admission.usage.batch).toBe(0);
  });

  it('releases a slot after synchronous setup failure', async () => {
    const admission = new OutboundAdmission();
    await expect(admission.run('capture', () => { throw new Error('setup'); })).rejects.toThrow('setup');
    expect(admission.usage.capture).toBe(0);
    (await admission.acquire('capture')).release();
  });
});

describe('source byte ownership', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

  it('reserves exactly eighty MiB and restores capacity exactly once', () => {
    const admission = new OutboundAdmission();
    const a = admission.reserveBytes(40 * 1024 * 1024);
    const b = admission.reserveBytes(40 * 1024 * 1024);
    expect(admission.usage.reservedBytes).toBe(83886080);
    expect(() => admission.reserveBytes(1)).toThrow(AdmissionBusy);
    a.release();
    a.release();
    expect(admission.usage.reservedBytes).toBe(41943040);
    const replacement = admission.reserveBytes(41943040);
    expect(() => admission.reserveBytes(1)).toThrow(AdmissionBusy);
    b.release();
    replacement.release();
    expect(admission.usage.reservedBytes).toBe(0);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte reservation %s without changing ownership', value => {
    const admission = new OutboundAdmission();
    const lease = admission.reserveBytes(12);
    expect(() => admission.reserveBytes(value)).toThrow(RangeError);
    expect(admission.usage.reservedBytes).toBe(12);
    lease.release();
  });

  it.each(['cache-hit', 'discard', 'sync-sdk-throw'])('allows immediate release on %s', path => {
    const admission = new OutboundAdmission();
    const lease = admission.reserveBytes(12);
    try {
      if (path === 'sync-sdk-throw') throw new Error('SDK setup');
    } catch (error) {
      expect(error).toEqual(new Error('SDK setup'));
    } finally { lease.release(); }
    lease.release();
    expect(admission.usage.reservedBytes).toBe(0);
    const all = admission.reserveBytes(83886080);
    expect(all.bytes).toBe(83886080);
    all.release();
  });

  it.each(['resolve', 'reject'] as const)('holds bytes after wrapper timeout until late SDK %s without unhandled rejection', async outcome => {
    const admission = new OutboundAdmission();
    const lease = admission.reserveBytes(83886080);
    const sdk = deferred<void>();
    lease.transferTo(sdk.promise);
    const outer = Promise.race([sdk.promise, new Promise(resolve => setTimeout(() => resolve('timeout'), 10))]);
    await vi.advanceTimersByTimeAsync(10);
    expect(await outer).toBe('timeout');
    lease.release();
    lease.transferTo(Promise.reject(new Error('duplicate transfer')));
    await tick();
    expect(admission.usage.reservedBytes).toBe(83886080);
    expect(() => admission.reserveBytes(1)).toThrow(AdmissionBusy);
    if (outcome === 'resolve') sdk.resolve();
    else sdk.reject(new Error('SDK late rejection'));
    await tick();
    lease.release();
    expect(admission.usage.reservedBytes).toBe(0);
  });

  it('does not resurrect a released lease on transfer', async () => {
    const admission = new OutboundAdmission();
    const lease = admission.reserveBytes(9);
    lease.release();
    lease.transferTo(Promise.reject(new Error('already released')));
    const current = admission.reserveBytes(11);
    await tick();
    expect(admission.usage.reservedBytes).toBe(11);
    current.release();
  });
});

describe('bounded synthetic native dispatch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

  it('reserves maxBytes before dispatch and retains the returned backing allocation rather than view length', async () => {
    const admission = new OutboundAdmission();
    const returned = await admission.runNativeRead(32, async () => {
      expect(admission.usage).toEqual({ batch: 0, read: 1, capture: 0, native: 1, waiters: 0, reservedBytes: 32 });
      return new Uint8Array(new ArrayBuffer(16), 0, 2);
    });
    expect(returned.bytes.byteLength).toBe(2);
    expect(returned.lease.bytes).toBe(16);
    expect(admission.usage).toEqual({ batch: 0, read: 0, capture: 0, native: 0, waiters: 0, reservedBytes: 16 });
    returned.lease.release();
    expect(admission.usage.reservedBytes).toBe(0);
  });

  it('queues the fifth native request and hands it a dispatch slot only after original completion', async () => {
    const admission = new OutboundAdmission();
    const pending = Array.from({ length: 5 }, () => deferred<Uint8Array>());
    const started: number[] = [];
    const jobs = pending.map((result, index) => admission.runNativeRead(16, () => {
      started.push(index);
      return result.promise;
    }));
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(admission.usage).toEqual({ batch: 0, read: 5, capture: 0, native: 4, waiters: 1, reservedBytes: 80 });
    pending[0]?.resolve(new Uint8Array(8));
    (await jobs[0])?.lease.release();
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(admission.usage.native).toBe(4);
    pending.slice(1).forEach(result => result.resolve(new Uint8Array(8)));
    (await Promise.all(jobs)).forEach(result => result.lease.release());
    expect(admission.usage).toEqual({ batch: 0, read: 0, capture: 0, native: 0, waiters: 0, reservedBytes: 0 });
  });

  it('expires a queued native request without releasing active workers or their reserved bytes', async () => {
    const admission = new OutboundAdmission();
    const active = deferred<Uint8Array>();
    const jobs = Array.from({ length: 4 }, () => admission.runNativeRead(10, () => active.promise));
    await tick();
    const fifth = admission.runNativeRead(10, async () => { throw new Error('must not dispatch'); });
    const refused = expect(fifth).rejects.toMatchObject({ code: 'busy', budget: 'native', waitedMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    await refused;
    expect(admission.usage).toEqual({ batch: 0, read: 4, capture: 0, native: 4, waiters: 0, reservedBytes: 40 });
    active.resolve(new Uint8Array(5));
    (await Promise.all(jobs)).forEach(result => result.lease.release());
    expect(admission.usage.reservedBytes).toBe(0);
  });

  it('retains read, native and byte ownership through outer timeout and original cleanup', async () => {
    const admission = new OutboundAdmission();
    const io = deferred<void>();
    const cleanup = deferred<void>();
    const original = admission.runNativeRead(20, async () => {
      try {
        await io.promise;
        return new Uint8Array(5);
      } finally {
        await cleanup.promise;
      }
    });
    const outer = Promise.race([original, new Promise(resolve => setTimeout(() => resolve('timeout'), 10))]);
    await vi.advanceTimersByTimeAsync(10);
    expect(await outer).toBe('timeout');
    io.resolve();
    await tick();
    expect(admission.usage).toEqual({ batch: 0, read: 1, capture: 0, native: 1, waiters: 0, reservedBytes: 20 });
    cleanup.resolve();
    const result = await original;
    expect(admission.usage).toEqual({ batch: 0, read: 0, capture: 0, native: 0, waiters: 0, reservedBytes: 5 });
    const sdk = deferred<void>();
    result.lease.transferTo(sdk.promise);
    result.lease.release();
    expect(admission.usage.reservedBytes).toBe(5);
    sdk.resolve();
    await tick();
    expect(admission.usage.reservedBytes).toBe(0);
  });

  it('limits combined active and queued native reads to eight read owners', async () => {
    const admission = new OutboundAdmission();
    const pending = deferred<Uint8Array>();
    let dispatched = 0;
    const jobs = Array.from({ length: 8 }, () => admission.runNativeRead(10, () => {
      dispatched++;
      return pending.promise;
    }));
    await tick();
    const ninth = admission.runNativeRead(10, () => { dispatched++; return pending.promise; });
    await tick();
    expect(dispatched).toBe(4);
    expect(admission.usage).toEqual({ batch: 0, read: 8, capture: 0, native: 4, waiters: 5, reservedBytes: 80 });
    pending.resolve(new Uint8Array(1));
    const results = await Promise.all([...jobs, ninth]);
    expect(dispatched).toBe(9);
    expect(admission.usage).toEqual({ batch: 0, read: 0, capture: 0, native: 0, waiters: 0, reservedBytes: 9 });
    results.forEach(result => result.lease.release());
  });

  it('refuses native dispatch when the shared waiter queue is full', async () => {
    const admission = new OutboundAdmission();
    const batches = await holdEight(admission, 'batch');
    const queued = Array.from({ length: 16 }, () => admission.acquire('batch'));
    const active = deferred<Uint8Array>();
    const jobs = Array.from({ length: 4 }, () => admission.runNativeRead(10, () => active.promise));
    await tick();
    await expect(admission.runNativeRead(10, async () => new Uint8Array(1))).rejects.toMatchObject({ budget: 'native', waitedMs: 0 });
    expect(admission.usage.read).toBe(4);
    expect(admission.usage.reservedBytes).toBe(40);
    batches.forEach(owner => owner.release());
    (await Promise.all(queued.slice(0, 8))).forEach(owner => owner.release());
    (await Promise.all(queued.slice(8))).forEach(owner => owner.release());
    active.resolve(new Uint8Array(1));
    (await Promise.all(jobs)).forEach(result => result.lease.release());
  });

  it('refuses an exhausted byte budget before invoking allocation or dispatch', async () => {
    const admission = new OutboundAdmission();
    const lease = admission.reserveBytes(83886080);
    let invoked = false;
    await expect(admission.runNativeRead(1, async () => {
      invoked = true;
      return new Uint8Array(1);
    })).rejects.toMatchObject({ code: 'busy', budget: 'bytes', waitedMs: 0 });
    expect(invoked).toBe(false);
    expect(admission.usage).toEqual({ batch: 0, read: 0, capture: 0, native: 0, waiters: 0, reservedBytes: 83886080 });
    lease.release();
    const result = await admission.runNativeRead(1, async () => new Uint8Array([7]));
    expect([...result.bytes]).toEqual([7]);
    result.lease.release();
  });

  it.each(['sync-throw', 'reject', 'oversize'] as const)('releases all native ownership on %s', async failure => {
    const admission = new OutboundAdmission();
    const result = admission.runNativeRead(8, () => {
      if (failure === 'sync-throw') throw new Error('setup');
      if (failure === 'reject') return Promise.reject(new Error('read'));
      return Promise.resolve(new Uint8Array(9));
    });
    await expect(result).rejects.toThrow();
    expect(admission.usage).toEqual({ batch: 0, read: 0, capture: 0, native: 0, waiters: 0, reservedBytes: 0 });
  });
});
