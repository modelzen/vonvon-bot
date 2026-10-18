import { describe, expect, it } from 'vitest';
import { JUDGE_BUDGET, JUDGE_BUDGET_WINDOW_MS, JudgeBudget, SmartLanes, type LaneEntry } from '../src/bot/smart-intake';

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

type V = 'main' | 'topic' | 'skip';
const entry = (id: string, named = false, place = 'chat'): LaneEntry => ({ id, place, named });

/** Lanes whose judgements and landings the test settles by hand. */
function lanes() {
  const judging = new Map<string, { batch: string[]; signal: AbortSignal; answer: Deferred<V> }>();
  const landing = new Map<string, Deferred<void>>();
  const landed: string[] = [];
  const failed: unknown[] = [];
  const tasks: Promise<unknown>[] = [];
  const lane = new SmartLanes<LaneEntry, V>({
    judge: (batch, signal) => {
      const answer = deferred<V>();
      judging.set(batch[batch.length - 1]!.id, { batch: batch.map((e) => e.id), signal, answer });
      return answer.promise;
    },
    ordered: (v) => v === 'main',
    land: (batch, v) => {
      const id = batch[batch.length - 1]!.id;
      landed.push(`${id}:${v}`);
      const done = deferred<void>();
      landing.set(id, done);
      return done.promise;
    },
    fail: (error) => failed.push(error),
    track: (task) => { tasks.push(task); },
  });
  return { lane, judging, landing, landed, failed, tasks };
}

describe('JudgeBudget', () => {
  it('takes 60 judgements a group in a sliding hour, then none until the oldest is an hour old', () => {
    const budget = new JudgeBudget();
    for (let i = 0; i < JUDGE_BUDGET; i++) expect(budget.take('g', 1_000 + i)).toBe(true);
    expect(budget.take('g', 2_000)).toBe(false);
    expect(budget.take('other', 2_000)).toBe(true); // per group
    expect(budget.take('g', 1_000 + JUDGE_BUDGET_WINDOW_MS - 1)).toBe(false);
    expect(budget.take('g', 1_000 + JUDGE_BUDGET_WINDOW_MS)).toBe(true); // the first one left the window
    expect(budget.take('g', 1_000 + JUDGE_BUDGET_WINDOW_MS)).toBe(false);
  });
});

describe('SmartLanes', () => {
  it('judges one unnamed batch a place at a time; those coming meanwhile go as one batch, the newest judged', async () => {
    const t = lanes();
    t.lane.submit(entry('a'));
    t.lane.submit(entry('b'));
    t.lane.submit(entry('c'));
    t.lane.submit(entry('x', false, 'topic'));
    expect([...t.judging.keys()]).toEqual(['a', 'x']); // another place is judged beside it
    t.judging.get('a')!.answer.resolve('skip');
    await flush();
    expect(t.landed).toEqual(['a:skip']);
    expect(t.judging.get('c')!.batch).toEqual(['b', 'c']);
    expect(t.judging.has('b')).toBe(false);
  });

  it('H1: an unnamed message judged to the main session lands only after the earlier named one (@B1 slow, A fast)', async () => {
    const t = lanes();
    t.lane.submit(entry('n', true));
    t.lane.submit(entry('a'));
    t.judging.get('a')!.answer.resolve('main');
    await flush();
    expect(t.landed).toEqual([]); // waits for the named one
    t.judging.get('n')!.answer.resolve('main');
    await flush();
    expect(t.landed).toEqual(['n:main']);
    t.landing.get('n')!.resolve();
    await flush();
    expect(t.landed).toEqual(['n:main', 'a:main']);
  });

  it('H1: two named messages land in order whatever their judgements took (@B1 slow, @B2 fast)', async () => {
    const t = lanes();
    t.lane.submit(entry('n1', true));
    t.lane.submit(entry('n2', true));
    t.judging.get('n2')!.answer.resolve('main');
    await flush();
    expect(t.landed).toEqual([]);
    t.judging.get('n1')!.answer.resolve('main');
    await flush();
    t.landing.get('n1')!.resolve();
    await flush();
    expect(t.landed).toEqual(['n1:main', 'n2:main']);
  });

  it('a verdict that does not go into the session (skip, topic) lands at once; a later named one does not wait on an unnamed one', async () => {
    const t = lanes();
    t.lane.submit(entry('n1', true));
    t.lane.submit(entry('a'));
    t.lane.submit(entry('n2', true));
    t.judging.get('a')!.answer.resolve('topic');
    t.judging.get('n2')!.answer.resolve('topic');
    await flush();
    expect(t.landed).toEqual(['a:topic', 'n2:topic']);
    t.judging.get('n1')!.answer.resolve('main');
    await flush();
    expect(t.landed).toEqual(['a:topic', 'n2:topic', 'n1:main']);
  });

  it('a named message over the budget comes with its verdict and still lands after the earlier named one', async () => {
    const t = lanes();
    t.lane.submit(entry('n1', true));
    t.lane.submit(entry('n2', true), { value: 'main' });
    expect(t.judging.has('n2')).toBe(false);
    await flush();
    expect(t.landed).toEqual([]);
    t.judging.get('n1')!.answer.resolve('skip');
    await flush();
    expect(t.landed).toEqual(['n1:skip', 'n2:main']);
  });

  it('a recalled message being judged aborts its judgement; the rest of its batch is judged again', async () => {
    const t = lanes();
    t.lane.submit(entry('a'));
    t.lane.submit(entry('b'));
    t.lane.submit(entry('c'));
    t.judging.get('a')!.answer.resolve('skip');
    await flush();
    const first = t.judging.get('c')!;
    t.lane.abort('c');
    expect(first.signal.aborted).toBe(true);
    expect(t.judging.get('b')!.batch).toEqual(['b']);
    first.answer.resolve('main'); // what the aborted judgement says is dropped
    await flush();
    expect(t.landed).toEqual(['a:skip']);
  });

  it('a recalled message waiting, or only context of a batch, leaves it; the batch is not judged again', async () => {
    const t = lanes();
    for (const id of ['a', 'b', 'c', 'd']) t.lane.submit(entry(id));
    t.lane.abort('d');
    t.judging.get('a')!.answer.resolve('skip');
    await flush();
    expect(t.judging.get('c')!.batch).toEqual(['b', 'c']);
    t.lane.abort('b');
    expect(t.judging.get('c')!.signal.aborted).toBe(false);
    t.judging.get('c')!.answer.resolve('skip');
    await flush();
    expect(t.landed).toEqual(['a:skip', 'c:skip']);
  });

  it('a recalled named message stops holding back later landings', async () => {
    const t = lanes();
    t.lane.submit(entry('n', true));
    t.lane.submit(entry('a'));
    t.judging.get('a')!.answer.resolve('main');
    await flush();
    t.lane.abort('n');
    await flush();
    expect(t.landed).toEqual(['a:main']);
  });

  it('a judgement that rejects is reported and stops holding back later landings', async () => {
    const t = lanes();
    t.lane.submit(entry('n', true));
    t.lane.submit(entry('a'));
    t.judging.get('a')!.answer.resolve('main');
    const boom = new Error('boom');
    t.judging.get('n')!.answer.reject(boom);
    await flush();
    expect(t.failed).toEqual([boom]);
    expect(t.landed).toEqual(['a:main']);
  });

  it('a landing that rejects is reported, and the next ones still land', async () => {
    const t = lanes();
    t.lane.submit(entry('n', true));
    t.lane.submit(entry('a'));
    t.judging.get('a')!.answer.resolve('main');
    t.judging.get('n')!.answer.resolve('main');
    await flush();
    const boom = new Error('land');
    t.landing.get('n')!.reject(boom);
    await flush();
    expect(t.failed).toEqual([boom]);
    expect(t.landed).toEqual(['n:main', 'a:main']);
  });

  it('pending lists what is not landed, oldest first; shutdown aborts every judgement and takes nothing more', async () => {
    const t = lanes();
    t.lane.submit(entry('n', true));
    t.lane.submit(entry('a'));
    t.lane.submit(entry('b'));
    t.lane.submit(entry('x', false, 'topic'));
    expect(t.lane.pending().map((e) => e.id)).toEqual(['n', 'a', 'b', 'x']);
    const signals = [...t.judging.values()].map((j) => j.signal);
    t.lane.shutdown();
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(t.lane.submit(entry('late', true))).toBe(false);
    for (const j of t.judging.values()) j.answer.resolve('main');
    await flush();
    expect(t.landed).toEqual([]);
    expect(t.lane.pending()).toEqual([]);
    await Promise.all(t.tasks);
  });
});
