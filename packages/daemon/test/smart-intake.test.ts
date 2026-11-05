import { describe, expect, it } from 'vitest';
import { JUDGE_BUDGET, JUDGE_BUDGET_WINDOW_MS, JudgeBudget, SmartLanes, type LaneEntry, type LaneDeps } from '../src/bot/smart-intake';

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

type V = 'main' | 'topic' | 'skip';
const entry = (id: string, kind: LaneEntry['kind'] = 'chat', place = 'chat'): LaneEntry => ({ id, place, kind });
const seconds = (n: number): number => n * 1_000;
type Due = LaneDeps<LaneEntry, V>['due'];
const quiet20: Due = (_, waiting, now) => Math.max(now, waiting[waiting.length - 1]!.at + seconds(20));
const batch3: Due = (place, waiting, now) => waiting.length >= 3 ? now : quiet20(place, waiting, now);

/** Lanes whose judgements and landings the test settles by hand. */
function lanes(due: Due = () => undefined, priority?: (entry: LaneEntry) => boolean) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, { fn(): void; at: number }>();
  const cleared: unknown[] = [];
  const overflow: string[][] = [];
  const landCalls: { batch: string[]; glance: boolean }[] = [];
  const judging = new Map<string, { batch: string[]; signal: AbortSignal; glance: boolean; answer: Deferred<V> }>();
  const landing = new Map<string, Deferred<void>>();
  const landed: string[] = [];
  const failed: unknown[] = [];
  const tasks: Promise<unknown>[] = [];
  const lane = new SmartLanes<LaneEntry, V>({
    priority,
    judge: (batch, signal, glance) => {
      const answer = deferred<V>();
      judging.set(batch[batch.length - 1]!.id, { batch: batch.map((e) => e.id), signal, glance, answer });
      return answer.promise;
    },
    ordered: (v) => v === 'main',
    land: (batch, v, glance) => {
      landCalls.push({ batch: batch.map((e) => e.id), glance });
      const id = batch[batch.length - 1]!.id;
      landed.push(`${id}:${v}`);
      const done = deferred<void>();
      landing.set(id, done);
      return done.promise;
    },
    due, now: () => now,
    setTimer: (fn, ms) => { const handle = ++nextTimer; timers.set(handle, { fn, at: now + ms }); return handle; },
    clearTimer: (handle) => { cleared.push(handle); if (typeof handle === 'number') timers.delete(handle); },
    overflow: (entries) => overflow.push(entries.map((e) => e.id)),
    fail: (error) => failed.push(error),
    track: (task) => { tasks.push(task); },
  });
  const advance = (ms: number): void => {
    now += ms;
    for (const [handle, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now && timers.delete(handle)) timer.fn();
    }
  };
  return { lane, judging, landing, landed, landCalls, failed, tasks, timers, cleared, overflow, advance, now: () => now };
}

function invariant(t: ReturnType<typeof lanes>, state: { waiting: boolean; judging: boolean; future: boolean }): void {
  expect(t.timers.size).toBe(Number(state.waiting && !state.judging && state.future));
  expect(t.lane.dueAt('chat') !== undefined).toBe(t.timers.size === 1);
}

describe('JudgeBudget', () => {
  it('takes 60 judgements a group in a sliding hour, then none until the oldest is an hour old', () => {
    const budget = new JudgeBudget();
    for (let i = 0; i < JUDGE_BUDGET; i++) expect(budget.take('g', 1_000 + i, 'focus')).toBe(true);
    expect(budget.take('g', 2_000, 'focus')).toBe(false);
    expect(budget.take('other', 2_000, 'focus')).toBe(true); // per group
    expect(budget.take('g', 1_000 + JUDGE_BUDGET_WINDOW_MS - 1, 'focus')).toBe(false);
    expect(budget.take('g', 1_000 + JUDGE_BUDGET_WINDOW_MS, 'focus')).toBe(true); // the first one left the window
    expect(budget.take('g', 1_000 + JUDGE_BUDGET_WINDOW_MS, 'focus')).toBe(false);
  });
});

describe('SmartLanes', () => {
  it('coalesces synchronous rearm requests when many overdue topics start together', async () => {
    let now = 0;
    let calls = 0;
    const errors: unknown[] = [];
    const tasks: Promise<unknown>[] = [];
    const lane: SmartLanes<LaneEntry, V> = new SmartLanes<LaneEntry, V>({
      judge: async () => { calls++; lane.rearmWhere(() => true); return 'skip'; },
      land: async () => {}, ordered: () => false,
      due: () => 1_000, now: () => now, setTimer: () => 0, clearTimer: () => {},
      fail: error => { errors.push(error); }, track: task => { tasks.push(task); },
    });
    for (let i = 0; i < 1_100; i++) lane.submit(entry(`m${i}`, 'chat', `topic${i}`));
    now = 7 * 60_000;
    lane.rearmWhere(() => true);
    await Promise.all(tasks);
    expect(calls).toBe(1_100);
    expect(errors).toEqual([]);
    lane.shutdown();
  });

  it('isolates a continuation from an older ordinary backlog and later messages', async () => {
    const isPriority = (item: LaneEntry) => item.id === 'followup';
    const t = lanes((place, waiting, now) => waiting.some(item => isPriority(item.entry)) || waiting[0]?.entry.id === 'inflight'
      ? undefined : quiet20(place, waiting, now), isPriority);
    t.lane.submit(entry('inflight'));
    for (let i = 0; i < 20; i++) t.lane.submit(entry(`ordinary-${i}`));
    t.lane.submit(entry('followup'));
    t.lane.submit(entry('later-person'));
    t.judging.get('inflight')!.answer.resolve('skip');
    await flush();
    expect(t.judging.get('followup')).toMatchObject({batch: ['followup'], glance: false});
    expect(t.judging.has('later-person')).toBe(false);
    t.judging.get('followup')!.answer.resolve('skip');
    await flush();
    expect(t.timers.size).toBe(1);
    t.advance(seconds(20));
    expect(t.judging.get('later-person')).toMatchObject({glance: true});
    expect(t.judging.get('later-person')!.batch).toHaveLength(21);
    expect(t.judging.get('later-person')!.batch).not.toContain('followup');
    t.lane.shutdown();
  });

  it('an aside entry is judged at once beside the unnamed batch, is never its context, and holds nothing back', async () => {
    const t = lanes();
    t.lane.submit(entry('a'));
    t.lane.submit(entry('w', 'aside'));
    t.lane.submit(entry('b'));
    t.lane.submit(entry('n', 'named'));
    expect([...t.judging.keys()]).toEqual(['a', 'w', 'n']);
    t.judging.get('a')!.answer.resolve('skip'); await flush();
    expect(t.judging.get('b')!.batch).toEqual(['b']);
    t.judging.get('n')!.answer.resolve('main'); await flush();
    expect(t.landed).toContain('n:main');
    t.landing.get('n')!.resolve(); await flush();
    t.lane.submit(entry('earlier', 'named'));
    t.lane.submit(entry('later-w', 'aside'));
    t.judging.get('later-w')!.answer.resolve('main'); await flush();
    expect(t.landed).not.toContain('later-w:main');
    t.judging.get('earlier')!.answer.resolve('main'); await flush();
    t.landing.get('earlier')!.resolve(); await flush();
    expect(t.landed).toContain('later-w:main');
  });

  it('judges one unnamed batch a place at a time; those coming meanwhile go as one batch, the newest judged', async () => {
    const t = lanes();
    t.lane.submit(entry('a'));
    t.lane.submit(entry('b'));
    t.lane.submit(entry('c'));
    t.lane.submit(entry('x', 'chat', 'topic'));
    expect([...t.judging.keys()]).toEqual(['a', 'x']); // another place is judged beside it
    t.judging.get('a')!.answer.resolve('skip');
    await flush();
    expect(t.landed).toEqual(['a:skip']);
    expect(t.judging.get('c')!.batch).toEqual(['b', 'c']);
    expect(t.judging.get('c')!.glance).toBe(false);
    expect(t.timers.size).toBe(0); expect(t.lane.dueAt('chat')).toBeUndefined();
    expect(t.judging.has('b')).toBe(false);
  });

  it('H1: an unnamed message judged to the main session lands only after the earlier named one (@B1 slow, A fast)', async () => {
    const t = lanes();
    t.lane.submit(entry('n', 'named'));
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
    t.lane.submit(entry('n1', 'named'));
    t.lane.submit(entry('n2', 'named'));
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
    t.lane.submit(entry('n1', 'named'));
    t.lane.submit(entry('a'));
    t.lane.submit(entry('n2', 'named'));
    t.judging.get('a')!.answer.resolve('topic');
    t.judging.get('n2')!.answer.resolve('topic');
    await flush();
    expect(t.landed).toEqual(['a:topic', 'n2:topic']);
    t.judging.get('n1')!.answer.resolve('main');
    await flush();
    expect(t.landed).toEqual(['a:topic', 'n2:topic', 'n1:main']);
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
    expect(t.judging.get('b')!.glance).toBe(false);
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
    expect(t.landCalls[1]!.batch).toEqual(['c']);
    expect(t.timers.size).toBe(0);
  });

  it('a recalled named message stops holding back later landings', async () => {
    const t = lanes();
    t.lane.submit(entry('n', 'named'));
    t.lane.submit(entry('a'));
    t.judging.get('a')!.answer.resolve('main');
    await flush();
    t.lane.abort('n');
    await flush();
    expect(t.landed).toEqual(['a:main']);
  });

  it('a judgement that rejects is reported and stops holding back later landings', async () => {
    const t = lanes();
    t.lane.submit(entry('n', 'named'));
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
    t.lane.submit(entry('n', 'named'));
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
    t.lane.submit(entry('n', 'named'));
    t.lane.submit(entry('a'));
    t.lane.submit(entry('b'));
    t.lane.submit(entry('x', 'chat', 'topic'));
    t.lane.submit(entry('s', 'aside'));
    expect(t.lane.pending().map((e) => e.id)).toEqual(['n']);
    const signals = [...t.judging.values()].map((j) => j.signal);
    t.lane.shutdown();
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(t.lane.submit(entry('late', 'named'))).toBe(false);
    for (const j of t.judging.values()) j.answer.resolve('main');
    await flush();
    expect(t.landed).toEqual([]);
    expect(t.lane.pending()).toEqual([]);
    await Promise.all(t.tasks);
  });
});

describe('JudgeBudget kinds', () => {
  it('named judgements are never charged, even beyond the full budget', () => {
    const b = new JudgeBudget();
    for (let i = 0; i < 60; i++) b.take('g', 1_000 + i, 'focus');
    for (let i = 0; i < 6; i++) expect(b.take('g', 2_000, 'named')).toBe(true);
    expect(b.used('g', 2_000)).toBe(60);
    expect(b.take('g', 2_000, 'focus')).toBe(false);
  });
  it('glances stop at 45 while focus, bot and name share the full group budget', () => {
    const b = new JudgeBudget();
    for (let i = 0; i < 45; i++) expect(b.take('g', 1_000 + i, 'focus')).toBe(true);
    expect(b.take('g', 2_000, 'glance')).toBe(false);
    for (const kind of ['focus', 'bot', 'name'] satisfies Parameters<JudgeBudget['take']>[2][]) expect(b.take('g', 2_000, kind)).toBe(true);
    expect(b.take('other', 2_000, 'glance')).toBe(true);
  });
  it('bot judgements have no smaller sublimit', () => {
    const b = new JudgeBudget();
    for (let i = 0; i < 60; i++) expect(b.take('g', i, 'bot')).toBe(true);
    expect(b.take('g', 100, 'bot')).toBe(false);
    expect(b.take('g', 100, 'named')).toBe(true);
  });
  it('reports usage and the exact expiry needed to fall below a cap', () => {
    const b = new JudgeBudget();
    for (let i = 0; i < 47; i++) b.take('g', 1_000 + i, 'focus');
    expect(b.used('g', 2_000)).toBe(47);
    expect(b.freeAt('g', 2_000, 45)).toBe(1_002 + JUDGE_BUDGET_WINDOW_MS);
    expect(b.freeAt('g', 2_000, 60)).toBe(2_000);
    for (const cap of [0, 1]) expect(b.freeAt('g', 2_000, cap)).toBe(1_046 + JUDGE_BUDGET_WINDOW_MS);
    const now = 1_002 + JUDGE_BUDGET_WINDOW_MS;
    expect(b.used('g', now)).toBe(44);
    expect(b.freeAt('g', now, 45)).toBe(now);
    expect(b.used('none', 2_000)).toBe(0);
    expect(b.freeAt('none', 2_000, 45)).toBe(2_000);
    expect(b.used('g', now + JUDGE_BUDGET_WINDOW_MS)).toBe(0);
  });
  it('honors custom limits, windows and glance caps', () => {
    const b = new JudgeBudget(10, 1_000, 4);
    for (let i = 0; i < 4; i++) expect(b.take('g', 0, 'focus')).toBe(true);
    expect(b.take('g', 0, 'glance')).toBe(false);
    for (let i = 4; i < 10; i++) expect(b.take('g', 0, 'focus')).toBe(true);
    expect(b.take('g', 0, 'focus')).toBe(false);
    expect(b.take('g', 1_000, 'glance')).toBe(true);
  });
});

describe('SmartLanes timers', () => {
  it('batches after quiet time, resetting the timer, then arms arrivals after judging', async () => {
    const t = lanes(quiet20);
    const check = (waiting: boolean, judging: boolean, future: boolean): void => invariant(t, { waiting, judging, future });
    check(false, false, false);
    t.lane.submit(entry('a')); check(true, false, true);
    expect(t.lane.dueAt('chat')).toBe(seconds(20));
    t.advance(seconds(5)); t.lane.submit(entry('b')); check(true, false, true);
    expect(t.cleared).toHaveLength(1);
    expect(t.lane.dueAt('chat')).toBe(seconds(25));
    t.advance(seconds(19)); check(true, false, true); expect(t.judging.size).toBe(0);
    t.advance(seconds(1)); check(false, true, false);
    expect(t.judging.get('b')).toMatchObject({ batch: ['a', 'b'], glance: true });
    t.lane.submit(entry('c')); check(true, true, true);
    t.judging.get('b')!.answer.resolve('skip'); await flush();
    t.landing.get('b')!.resolve(); await flush(); check(true, false, true);
    expect(t.landCalls[0]).toEqual({ batch: ['a', 'b'], glance: true });
    expect(t.lane.dueAt('chat')).toBe(seconds(45));
    t.advance(seconds(20)); check(false, true, false);
    expect(t.judging.get('c')).toMatchObject({ batch: ['c'], glance: true });
  });
  it('starts immediately once enough waiting entries arrive', () => {
    const t = lanes(batch3);
    for (const id of ['a', 'b', 'c']) t.lane.submit(entry(id));
    expect(t.judging.get('c')).toMatchObject({ batch: ['a', 'b', 'c'], glance: true });
    expect(t.cleared).toHaveLength(2);
    invariant(t, { waiting: false, judging: true, future: false });
  });
  it('recomputes due at firing and reschedules instead of polling', () => {
    let due = quiet20;
    const t = lanes((...args) => due(...args)); t.lane.submit(entry('a'));
    due = (_, _waiting, now) => now + seconds(40);
    t.advance(seconds(20));
    expect(t.judging.size).toBe(0); expect(t.cleared).toHaveLength(0);
    expect(t.lane.dueAt('chat')).toBe(seconds(60));
    invariant(t, { waiting: true, judging: false, future: true });
    due = quiet20; t.advance(seconds(40));
    expect(t.judging.get('a')).toMatchObject({ batch: ['a'], glance: true });
    invariant(t, { waiting: false, judging: true, future: false });
  });
  it('drops the oldest waiting entry beyond 40', () => {
    const t = lanes(quiet20);
    for (let i = 0; i < 41; i++) t.lane.submit(entry(`c${i}`));
    expect(t.overflow).toEqual([['c0']]); t.advance(seconds(20));
    expect(t.judging.get('c40')!.batch).toHaveLength(40);
    expect(t.judging.get('c40')!.batch[0]).toBe('c1');
  });
  it('hard signals do not consume waiting entries or their timer, even on skip and error', async () => {
    const t = lanes(quiet20); t.lane.submit(entry('a'));
    for (const kind of ['named', 'aside'] satisfies LaneEntry['kind'][]) {
      t.lane.submit(entry(kind, kind));
      expect(t.judging.get(kind)).toMatchObject({ batch: [kind], glance: false });
      expect(t.lane.dueAt('chat')).toBe(seconds(20)); expect(t.timers.size).toBe(1);
    }
    t.judging.get('named')!.answer.resolve('skip'); await flush();
    t.landing.get('named')!.resolve();
    t.judging.get('aside')!.answer.reject(new Error('judge')); await flush();
    expect(t.failed).toHaveLength(1); t.advance(seconds(20));
    expect(t.judging.get('a')).toMatchObject({ batch: ['a'], glance: true });
  });
  for (const kind of ['named', 'aside'] satisfies LaneEntry['kind'][]) {
    for (const verdict of ['main', 'skip'] satisfies V[]) {
      it(`defers an expired glance through ${kind} judging and ${verdict} landing`, async () => {
        const t = lanes(quiet20); t.lane.submit(entry('a')); t.advance(seconds(10));
        t.lane.submit(entry('hard', kind)); t.advance(seconds(10));
        expect(t.judging.has('a')).toBe(false); expect(t.timers.size).toBe(0);
        expect(t.lane.dueAt('chat')).toBeUndefined();
        t.judging.get('hard')!.answer.resolve(verdict); await flush();
        expect(t.landed).toEqual([`hard:${verdict}`]); expect(t.judging.has('a')).toBe(false);
        t.landing.get('hard')!.resolve(); await flush();
        expect(t.judging.get('a')).toMatchObject({ batch: ['a'], glance: true });
      });
    }
  }
  it('a new chat arrival can move a deferred glance back into the future', async () => {
    const t = lanes(quiet20); t.lane.submit(entry('a')); t.lane.submit(entry('n', 'named'));
    t.advance(seconds(20)); t.lane.submit(entry('b'));
    expect(t.lane.dueAt('chat')).toBe(seconds(40)); expect(t.timers.size).toBe(1);
    t.judging.get('n')!.answer.resolve('main'); await flush(); t.landing.get('n')!.resolve(); await flush();
    expect(t.judging.has('b')).toBe(false); t.advance(seconds(20));
    expect(t.judging.get('b')).toMatchObject({ batch: ['a', 'b'], glance: true });
    expect(t.timers.size).toBe(0);
  });
  it('undefined due keeps judging chat alongside a hard signal', () => {
    const t = lanes(); t.lane.submit(entry('n', 'named')); t.lane.submit(entry('a'));
    expect([...t.judging.keys()]).toEqual(['n', 'a']); expect(t.judging.get('a')!.glance).toBe(false);
    expect(t.timers.size).toBe(0); expect(t.lane.dueAt('chat')).toBeUndefined();
  });
  it('aborting a hard signal resumes an expired glance', () => {
    const t = lanes(quiet20); t.lane.submit(entry('a')); t.lane.submit(entry('n', 'named')); t.advance(seconds(20));
    t.lane.abort('n'); expect(t.judging.get('n')!.signal.aborted).toBe(true);
    expect(t.judging.get('a')!.glance).toBe(true);
  });
  it('prunes waiting entries in arrival order and recalculates or clears their timer', () => {
    const t = lanes(quiet20);
    for (const id of ['a', 'b', 'c']) { t.lane.submit(entry(id)); t.advance(seconds(1)); }
    const cleared = t.cleared.length;
    expect(t.lane.prune('chat', (e) => e.id !== 'c').map((e) => e.id)).toEqual(['a', 'b']);
    expect(t.lane.dueAt('chat')).toBe(seconds(22)); invariant(t, { waiting: true, judging: false, future: true });
    expect(t.lane.prune('chat', () => true).map((e) => e.id)).toEqual(['c']);
    expect(t.cleared).toHaveLength(cleared + 2); invariant(t, { waiting: false, judging: false, future: false });
    expect(t.lane.prune('none', () => true)).toEqual([]);
  });
  it('prunes waiting arrivals without arming while a batch is judging', async () => {
    const t = lanes(quiet20); t.lane.submit(entry('a')); t.advance(seconds(20)); t.lane.submit(entry('b'));
    expect(t.lane.prune('chat', () => true).map((e) => e.id)).toEqual(['b']);
    invariant(t, { waiting: false, judging: true, future: false });
    t.judging.get('a')!.answer.resolve('skip'); await flush(); t.landing.get('a')!.resolve(); await flush();
    expect([...t.judging.keys()]).toEqual(['a']); invariant(t, { waiting: false, judging: false, future: false });
  });
  it('recalculates the timer when waiting entries are recalled', () => {
    const t = lanes(quiet20); t.lane.submit(entry('a')); t.advance(seconds(1)); t.lane.submit(entry('b'));
    t.lane.abort('b'); expect(t.lane.dueAt('chat')).toBe(seconds(20));
    invariant(t, { waiting: true, judging: false, future: true });
    t.lane.abort('a'); invariant(t, { waiting: false, judging: false, future: false });
  });
  for (const delay of [0, 5]) {
    it(`restores the original timestamps after recalling a batch target, with ${delay}s new delay`, () => {
      let due = quiet20;
      const t = lanes((...args) => due(...args)); t.lane.submit(entry('a')); t.lane.submit(entry('b')); t.advance(seconds(20));
      const original = t.judging.get('b')!;
      if (delay) due = (_, _waiting, now) => now + seconds(delay);
      t.lane.abort('b'); expect(original.signal.aborted).toBe(true);
      if (delay) {
        expect(t.judging.has('a')).toBe(false); expect(t.lane.dueAt('chat')).toBe(t.now() + seconds(delay));
        invariant(t, { waiting: true, judging: false, future: true }); due = quiet20; t.advance(seconds(delay));
      }
      expect(t.judging.get('a')).toMatchObject({ batch: ['a'], glance: true });
      invariant(t, { waiting: false, judging: true, future: false });
    });
  }
  for (const future of [false, true]) {
    it(`bounds recall refill to the newest 40 entries with ${future ? 'future' : 'immediate'} due`, async () => {
      let delayed = false;
      let waiting: { id: string; at: number }[] = [];
      const t = lanes((place, batch, now) => {
        waiting = batch.map(({ entry, at }) => ({ id: entry.id, at }));
        return delayed ? quiet20(place, batch, now) : undefined;
      });
      const oldIds = Array.from({ length: 40 }, (_, i) => `b${i + 1}`);
      const newIds = Array.from({ length: 40 }, (_, i) => `c${i + 1}`);
      t.lane.submit(entry('seed'));
      for (const id of oldIds) t.lane.submit(entry(id));
      t.judging.get('seed')!.answer.resolve('skip'); await flush();
      t.landing.get('seed')!.resolve(); await flush();
      const old = t.judging.get('b40')!;
      expect(old.batch).toEqual(oldIds);
      for (const id of newIds) { t.advance(seconds(1)); t.lane.submit(entry(id)); }
      delayed = future;
      t.lane.abort('b40');
      expect(old.signal.aborted).toBe(true);
      expect({ waiting: waiting.length, overflow: t.overflow }).toEqual({ waiting: 40, overflow: [oldIds.slice(0, -1)] });
      expect(waiting).toEqual(newIds.map((id, i) => ({ id, at: seconds(i + 1) })));
      expect(t.timers.size).toBe(future ? 1 : 0);
      if (future) {
        expect(t.judging.has('c40')).toBe(false);
        expect(t.lane.dueAt('chat')).toBe(seconds(60));
      } else expect(t.judging.get('c40')!.batch).toEqual(newIds);
      old.answer.resolve('main'); await flush();
      expect(t.landed).toEqual(['seed:skip']);
      if (future) t.advance(seconds(20));
      expect(t.judging.get('c40')).toMatchObject({ batch: newIds, glance: future });
      t.judging.get('c40')!.answer.resolve('main'); await flush();
      expect(t.landed).toEqual(['seed:skip', 'c40:main']);
      t.landing.get('c40')!.resolve(); await flush();
      expect(t.lane.prune('chat', () => true)).toEqual([]);
      expect(t.timers.size).toBe(0);
      await Promise.all(t.tasks);
    });
  }
  it('shutdown clears timers before aborting and ignores a queued timer callback', async () => {
    const t = lanes(quiet20); t.lane.submit(entry('a')); t.lane.submit(entry('n', 'named'));
    const timer = [...t.timers.values()][0]!;
    t.judging.get('n')!.signal.addEventListener('abort', () => expect(t.timers.size).toBe(0));
    t.lane.shutdown(); expect(t.cleared).toHaveLength(1); expect(t.timers.size).toBe(0);
    expect(t.judging.get('n')!.signal.aborted).toBe(true);
    expect(() => timer.fn()).not.toThrow(); t.advance(seconds(60));
    expect([...t.judging.keys()]).toEqual(['n']); expect(t.lane.submit(entry('b'))).toBe(false);
    t.judging.get('n')!.answer.resolve('main'); await flush(); expect(t.landed).toEqual([]);
    await Promise.all(t.tasks);
  });
  it('a late callback from a replaced timer cannot erase the current timer', () => {
    const t = lanes(quiet20); t.lane.submit(entry('a'));
    const old = [...t.timers.values()][0]!;
    t.advance(seconds(5)); t.lane.submit(entry('b')); const cleared = t.cleared.length;
    old.fn(); expect(t.lane.dueAt('chat')).toBe(seconds(25)); expect(t.timers.size).toBe(1);
    expect(t.cleared).toHaveLength(cleared); t.advance(seconds(20));
    expect(t.judging.get('b')!.batch).toEqual(['a', 'b']); expect(t.timers.size).toBe(0);
  });
});

describe('SmartLanes ordered landings', () => {
  it('serializes an aside and a glance in either arrival order', async () => {
    const t = lanes(quiet20); t.lane.submit(entry('a')); t.lane.submit(entry('s', 'aside'));
    t.judging.get('s')!.answer.resolve('main'); await flush(); t.advance(seconds(20));
    expect(t.landed).toEqual(['s:main']); expect(t.judging.has('a')).toBe(false);
    t.landing.get('s')!.resolve(); await flush(); t.judging.get('a')!.answer.resolve('main'); await flush();
    expect(t.landed).toEqual(['s:main', 'a:main']);
    const u = lanes(quiet20); u.lane.submit(entry('a')); u.advance(seconds(20));
    u.judging.get('a')!.answer.resolve('main'); await flush(); u.lane.submit(entry('s', 'aside'));
    u.judging.get('s')!.answer.resolve('main'); await flush(); expect(u.landed).toEqual(['a:main']);
    u.landing.get('a')!.resolve(); await flush(); expect(u.landed).toEqual(['a:main', 's:main']);
  });
  for (const verdict of ['main', 'topic', 'skip'] satisfies V[]) {
    it(`two aside verdicts serialize main but allow ${verdict} appropriately`, async () => {
      const t = lanes(); t.lane.submit(entry('s1', 'aside')); t.lane.submit(entry('s2', 'aside'));
      t.judging.get('s1')!.answer.resolve('main'); t.judging.get('s2')!.answer.resolve(verdict); await flush();
      expect(t.landed).toEqual(verdict === 'main' ? ['s1:main'] : ['s1:main', `s2:${verdict}`]);
      t.landing.get('s1')!.resolve(); await flush(); expect(t.landed).toEqual(['s1:main', `s2:${verdict}`]);
    });
  }
  it('serializes only within a place and permits another place to land concurrently', async () => {
    const t = lanes();
    for (const [id, place] of [['a', 'chat'], ['b', 'chat'], ['x', 'topic']]) t.lane.submit(entry(id!, 'aside', place!));
    for (const id of ['a', 'b', 'x']) t.judging.get(id)!.answer.resolve('main'); await flush();
    expect(t.landed).toEqual(['a:main', 'x:main']);
    t.landing.get('a')!.resolve(); await flush(); expect(t.landed).toEqual(['a:main', 'x:main', 'b:main']);
  });
});


describe('SmartLanes recovery', () => {
  it('reports a throwing due callback and falls back to immediate nonglance judging', () => {
    const boom = new Error('due');
    const t = lanes(() => { throw boom; });
    expect(t.lane.submit(entry('a'))).toBe(true);
    expect(t.failed).toEqual([boom]);
    expect(t.judging.get('a')).toMatchObject({ batch: ['a'], glance: false });
    expect(t.timers.size).toBe(0);
  });
  it('resumes an expired deferred glance when the hard signal judgement rejects', async () => {
    const t = lanes(quiet20); t.lane.submit(entry('a')); t.lane.submit(entry('n', 'named'));
    t.advance(seconds(20)); expect(t.judging.has('a')).toBe(false); expect(t.timers.size).toBe(0);
    const boom = new Error('judge'); t.judging.get('n')!.answer.reject(boom); await flush();
    expect(t.failed).toEqual([boom]);
    expect(t.judging.get('a')).toMatchObject({ batch: ['a'], glance: true });
    expect(t.timers.size).toBe(0);
  });
});

describe('rearm (s25g)', () => {
  it('37. cancels a watch timer and judges immediately after focus changes', () => {
    let due: Due = quiet20;
    const t = lanes((...args) => due(...args)); t.lane.submit(entry('a'));
    expect(t.lane.dueAt('chat')).toBe(seconds(20)); due = () => undefined;
    t.lane.rearm('chat'); expect(t.judging.get('a')?.glance).toBe(false);
    expect(t.timers.size).toBe(0); expect(t.cleared).toHaveLength(1);
    expect(() => t.lane.rearm('none')).not.toThrow();
  });
  it('38. leaves an in-flight chat judgement alone and waits for settle', async () => {
    const t = lanes(quiet20); t.lane.submit(entry('a')); t.advance(seconds(20));
    t.lane.submit(entry('b')); t.lane.rearm('chat');
    expect([...t.judging.keys()]).toEqual(['a']); expect(t.timers.size).toBe(0);
    t.judging.get('a')!.answer.resolve('skip'); await flush();
    t.landing.get('a')!.resolve(); await flush();
    expect(t.lane.dueAt('chat')).toBe(seconds(40));
  });
});
