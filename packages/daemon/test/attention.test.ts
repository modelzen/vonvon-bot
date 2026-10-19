import { describe, expect, it } from 'vitest';
import { ATTENTION_DEFAULTS, Attention, outcomeOf } from '../src/bot/attention';

const T0 = 1_000_000_000_000;
const s = (n: number) => n * 1000;
const m = (n: number) => n * 60_000;
const A = { chatId: 'oc_a', place: 'oc_a' };
const A1 = { chatId: 'oc_a', place: 'omt_a1' };
const A2 = { chatId: 'oc_a', place: 'omt_a2' };
const B = { chatId: 'oc_b', place: 'oc_b' };
const glanceSkip = (a: Attention, ref = A, at = T0) => { a.glanced(ref, at); a.verdict(ref, 'glance', 'skip', at); };
const topic = (n: number) => ({ chatId: 'oc_a', place: `omt_${n}` });

describe('attention defaults and arrival', () => {
  it('1. uses the agreed defaults and rejects invalid intervals', () => {
    expect(ATTENTION_DEFAULTS).toEqual({ places: 200, intervalsMs: [60_000, 180_000, 300_000], exitIntervalMs: 180_000,
      quietMs: 20_000, batch: 10, overdueMs: 60_000, lullMs: 300_000, mainFocusMs: 600_000,
      mainMisses: 3, topicMisses: 5, windowMs: 600_000 });
    expect(() => new Attention({ intervalsMs: [] })).toThrow(RangeError);
    expect(() => new Attention({ intervalsMs: [180_000, 60_000] })).toThrow(RangeError);
  });
  it('2. starts an unseen main area in watch', () => {
    const a = new Attention();
    expect(a.arrive(A, T0)).toBe('watch');
    expect(a.state(A.place)).toEqual({ chatId: A.chatId, topic: false, mode: 'watch', intervalMs: m(1), arrivedAt: T0, misses: 0 });
    expect(a.state('omt_x')).toBeUndefined();
  });
  it('3. starts only a mine topic in focus, and ignores later mine values', () => {
    const a = new Attention();
    expect(a.arrive(A1, T0, { mine: true })).toBe('focus');
    expect(a.state(A1.place)?.misses).toBe(0);
    expect(a.arrive(A1, T0 + s(5), { mine: false })).toBe('focus');
    expect(a.arrive(A2, T0, { mine: false })).toBe('watch');
    expect(a.arrive(A, T0, { mine: true })).toBe('watch');
  });
  it('4. resets a slow watch interval exactly at the lull boundary', () => {
    const at = (t: number) => { const a = new Attention(); a.arrive(A, T0); for (let i = 0; i < 3; i++) glanceSkip(a); a.arrive(A, t); return a; };
    expect(at(T0 + m(5)).state(A.place)?.intervalMs).toBe(m(1));
    expect(at(T0 + m(5) - 1).state(A.place)?.intervalMs).toBe(m(5));
  });
  it('5. exits main focus after, but not at, ten minutes', () => {
    const a = new Attention(); a.replied(A, T0);
    for (const n of [4, 8, 10]) expect(a.arrive(A, T0 + m(n))).toBe('focus');
    expect(a.arrive(A, T0 + m(10) + 1)).toBe('watch');
    expect(a.state(A.place)).toMatchObject({ intervalMs: m(3), misses: 0 });
  });
  it('6. applies the main focus exit before the lull reset', () => {
    const a = new Attention(); a.arrive(A, T0 - m(1)); a.replied(A, T0);
    expect(a.arrive(A, T0 + m(11))).toBe('watch');
    expect(a.state(A.place)?.intervalMs).toBe(m(1));
  });
  it('7. never expires topic focus by elapsed time', () => {
    const a = new Attention(); a.replied(A1, T0);
    expect(a.arrive(A1, T0 + m(60))).toBe('focus');
  });
  it('8. tolerates backwards time without moving arrival backwards', () => {
    const a = new Attention(); a.arrive(A, T0 + s(10)); a.arrive(A, T0);
    expect(a.state(A.place)?.arrivedAt).toBe(T0 + s(10));
    a.replied(A, T0); expect(a.arrive(A, T0 - m(1))).toBe('focus');
  });
});

describe('due time', () => {
  it('9. waits for quiet when never looked at, and leaves empty pending undefined', () => {
    const a = new Attention(); a.arrive(A, T0);
    expect(a.due(A.place, [T0], T0)).toBe(T0 + s(20));
    a.arrive(A, T0 + s(10));
    expect(a.due(A.place, [T0, T0 + s(10)], T0 + s(10))).toBe(T0 + s(30));
    expect(a.due(A.place, [], T0)).toBeUndefined();
    expect(a.due('oc_z', [T0], T0)).toBe(T0 + s(20));
  });
  it('10. waits until the previous look interval has passed', () => {
    const a = new Attention(); a.arrive(A, T0); a.glanced(A, T0 + s(20));
    a.verdict(A, 'glance', 'skip', T0 + s(25)); a.arrive(A, T0 + s(60));
    expect(a.due(A.place, [T0 + s(60)], T0 + s(60))).toBe(T0 + s(200));
  });
  it('11. uses overdue to bound a continuous stream', () => {
    const a = new Attention(); const times = Array.from({ length: 8 }, (_, n) => T0 + s(15 * n));
    for (const at of times) a.arrive(A, at);
    expect(a.due(A.place, times, T0 + s(105))).toBe(T0 + s(120));
  });
  it('12. scans immediately only on the tenth pending message', () => {
    const a = new Attention(); const times = Array.from({ length: 10 }, (_, n) => T0 + s(n));
    times.forEach(at => a.arrive(A, at));
    expect(a.due(A.place, times.slice(0, 9), times[8]!)).toBeGreaterThan(times[8]!);
    expect(a.due(A.place, times, times[9]!)).toBe(times[9]);
  });
  it('13. scans pending messages immediately in focus', () => {
    const a = new Attention(); a.verdict(A, 'glance', 'reply', T0);
    expect(a.due(A.place, [T0 + s(1)], T0 + s(1))).toBe(T0 + s(1));
  });
  it('14. never returns a past due time', () => {
    const a = new Attention(); a.arrive(A, T0);
    expect(a.due(A.place, [T0], T0 + m(30))).toBe(T0 + m(30));
  });
  it('15. uses constructor intervals', () => {
    const a = new Attention({ intervalsMs: [30_000, 90_000, 150_000] });
    a.arrive(A, T0); a.glanced(A, T0 + s(20)); a.verdict(A, 'glance', 'skip', T0 + s(25));
    expect(a.state(A.place)?.intervalMs).toBe(s(90));
    a.arrive(A, T0 + s(30));
    expect(a.due(A.place, [T0 + s(30)], T0 + s(30))).toBe(T0 + s(110));
  });
});

describe('look and reply transitions', () => {
  it('16. raises watch intervals one tier per skipped glance', () => {
    const a = new Attention(); a.arrive(A, T0);
    for (const interval of [m(3), m(5), m(5)]) { glanceSkip(a); expect(a.state(A.place)?.intervalMs).toBe(interval); }
  });
  it('17. records a look even when the glance fails', () => {
    const a = new Attention(); a.glanced(A, T0); a.verdict(A, 'glance', 'error', T0 + s(4));
    expect(a.state(A.place)).toMatchObject({ intervalMs: m(1), lookedAt: T0 });
  });
  it('18. a skipped signal resets watch interval without recording a look', () => {
    const a = new Attention(); a.arrive(A, T0); glanceSkip(a, A, T0 + s(1)); glanceSkip(a, A, T0 + s(2));
    const lookedAt = a.state(A.place)?.lookedAt;
    a.verdict(A, 'signal', 'skip', T0 + s(3));
    expect(a.state(A.place)).toMatchObject({ mode: 'watch', intervalMs: m(1), lookedAt });
  });
  it('19. three skipped signals exit main focus', () => {
    const a = new Attention(); a.replied(A, T0);
    for (let i = 1; i <= 2; i++) { a.verdict(A, 'signal', 'skip', T0 + i); expect(a.state(A.place)).toMatchObject({ mode: 'focus', misses: i }); }
    a.verdict(A, 'signal', 'skip', T0 + 3);
    expect(a.state(A.place)).toMatchObject({ mode: 'watch', intervalMs: m(3), misses: 0 });
  });
  it('20. errors do not count as focus misses, and a reply clears misses', () => {
    const a = new Attention(); a.replied(A, T0);
    a.verdict(A, 'focus', 'skip', T0 + 1); a.verdict(A, 'focus', 'error', T0 + 2); a.verdict(A, 'focus', 'skip', T0 + 3);
    expect(a.state(A.place)).toMatchObject({ mode: 'focus', misses: 2 });
    a.verdict(A, 'focus', 'skip', T0 + 4); expect(a.state(A.place)).toMatchObject({ mode: 'watch', intervalMs: m(3) });
    const b = new Attention(); b.replied(A, T0);
    b.verdict(A, 'focus', 'skip', T0 + 1); b.verdict(A, 'focus', 'skip', T0 + 2); b.verdict(A, 'focus', 'reply', T0 + 3);
    expect(b.state(A.place)).toMatchObject({ mode: 'focus', misses: 0 });
  });
  it('21. exits topic focus only after five misses', () => {
    const a = new Attention(); a.replied(A1, T0);
    for (let i = 1; i <= 4; i++) a.verdict(A1, 'focus', 'skip', T0 + i);
    expect(a.state(A1.place)).toMatchObject({ mode: 'focus', misses: 4 });
    a.verdict(A1, 'focus', 'skip', T0 + 5);
    expect(a.state(A1.place)).toMatchObject({ mode: 'watch', intervalMs: m(3), misses: 0 });
  });
  it.each(['glance', 'signal', 'focus'] as const)('22. %s reply enters focus and resets interval', kind => {
    const a = new Attention(); a.arrive(A, T0); glanceSkip(a); glanceSkip(a);
    a.verdict(A, kind, 'reply', T0 + s(1));
    expect(a.state(A.place)).toMatchObject({ mode: 'focus', misses: 0, intervalMs: m(1), repliedAt: T0 + s(1) });
    expect(a.arrive(A, T0 + s(2))).toBe('focus');
  });
  it('23. stale skip kinds do not alter the current mode', () => {
    const a = new Attention(); a.replied(A, T0); a.verdict(A, 'focus', 'skip', T0 + 1);
    const focus = a.state(A.place); a.verdict(A, 'glance', 'skip', T0 + 2); expect(a.state(A.place)).toEqual(focus);
    const b = new Attention(); b.arrive(B, T0); glanceSkip(b, B); const watch = b.state(B.place);
    b.verdict(B, 'focus', 'skip', T0 + 2); expect(b.state(B.place)).toEqual(watch);
  });
  it('24. errors of every kind leave focus and watch values unchanged', () => {
    const a = new Attention(); a.replied(A, T0); a.verdict(A, 'focus', 'skip', T0 + 1);
    const b = new Attention(); b.arrive(B, T0); glanceSkip(b, B); glanceSkip(b, B);
    for (const [att, ref] of [[a, A], [b, B]] as const) {
      const before = att.state(ref.place);
      for (const kind of ['signal', 'focus', 'glance'] as const) att.verdict(ref, kind, 'error', T0 + 2);
      expect(att.state(ref.place)).toEqual(before);
    }
  });
  it('25. skip and error do not create state, while reply, replied, and glanced do', () => {
    const a = new Attention(); a.verdict(A2, 'signal', 'skip', T0); a.verdict(A2, 'glance', 'error', T0);
    expect(a.state(A2.place)).toBeUndefined();
    a.verdict(A2, 'focus', 'reply', T0); expect(a.state(A2.place)?.mode).toBe('focus');
    const newer = { chatId: 'oc_a', place: 'omt_new' }; a.replied(newer, T0);
    expect(a.state(newer.place)).toMatchObject({ topic: true, mode: 'focus', repliedAt: T0 });
    a.glanced(B, T0); expect(a.state(B.place)).toMatchObject({ mode: 'watch', lookedAt: T0 });
  });
});

describe('state memory and glance selection', () => {
  it('26. forgets only one chat and reinitializes its locations normally', () => {
    const a = new Attention(); for (const ref of [A, A1, A2, B]) a.arrive(ref, T0);
    const preserved = a.state(B.place); a.forget(A.chatId);
    for (const ref of [A, A1, A2]) expect(a.state(ref.place)).toBeUndefined();
    expect(a.state(B.place)).toEqual(preserved);
    expect(a.arrive(A, T0 + 1)).toBe('watch'); expect(a.state(A.place)?.lookedAt).toBeUndefined();
    expect(a.arrive(A1, T0 + 1, { mine: true })).toBe('focus');
  });
  it('27. resets only that chat when its prompt hash changes', () => {
    const a = new Attention(); expect(a.notePrompt(A.chatId, 'h1')).toBe(false);
    a.arrive(A, T0); a.arrive(B, T0);
    expect(a.notePrompt(A.chatId, 'h1')).toBe(false); expect(a.state(A.place)).toBeDefined();
    expect(a.notePrompt(A.chatId, 'h2')).toBe(true);
    expect(a.state(A.place)).toBeUndefined(); expect(a.state(B.place)).toBeDefined();
    expect(a.notePrompt(B.chatId, 'h1')).toBe(false);
  });
  it('28. evicts the least recently used place and permits mine to restore it', () => {
    const a = new Attention(); for (let n = 0; n < 200; n++) a.arrive(topic(n), T0);
    a.verdict(topic(0), 'focus', 'error', T0); a.arrive(topic(200), T0);
    expect(a.state(topic(1).place)).toBeUndefined();
    for (const n of [0, 2, 199, 200]) expect(a.state(topic(n).place)).toBeDefined();
    expect(a.arrive(topic(1), T0, { mine: true })).toBe('focus');
  });
  it('29. state does not touch LRU and returns a copy', () => {
    const a = new Attention(); for (let n = 0; n < 200; n++) a.arrive(topic(n), T0);
    expect(a.state(topic(0).place)).toBeDefined(); a.arrive(topic(200), T0);
    expect(a.state(topic(0).place)).toBeUndefined();
    const copy = a.state(topic(2).place)!; copy.mode = 'focus';
    expect(a.state(topic(2).place)?.mode).toBe('watch');
  });
  it('30. picks only the latest ten messages within the window, retaining order', () => {
    const a = new Attention(); const now = T0 + m(20);
    const pending = [T0, T0 + m(10), ...Array.from({ length: 12 }, (_, n) => T0 + m(15) + s(10 * n))].map((at, id) => ({ at, id }));
    const result = a.pickGlance(pending, now);
    expect(result.look).toEqual(pending.slice(4));
    expect(result.old).toEqual(pending.slice(0, 4));
    const boundary = [{ at: now - m(10) - 1, id: 'too-old' }, { at: now - m(10), id: 'exact' }];
    expect(a.pickGlance(boundary, now)).toEqual({ look: [boundary[1]], old: [boundary[0]] });
    expect(a.pickGlance([], now)).toEqual({ look: [], old: [] });
  });
  it('31. maps skipped, replying, and failed judge results', () => {
    expect(outcomeOf({ decision: 'skip' })).toBe('skip');
    for (const decision of ['main', 'topic', 'reply'] as const) expect(outcomeOf({ decision })).toBe('reply');
    expect(outcomeOf({ decision: 'skip', error: { kind: 'timeout' } })).toBe('error');
    expect(outcomeOf({ decision: 'main', error: { kind: 'timeout' } })).toBe('error');
  });
  it('bounds prompt hashes independently of state and does not touch state in due', () => {
    const a = new Attention({ places: 2 }); a.arrive(A, T0); a.arrive(B, T0);
    expect(a.due(A.place, [T0], T0)).toBe(T0 + s(20));
    a.arrive(A1, T0); expect(a.state(A.place)).toBeUndefined();
    expect(a.notePrompt('oc_a', 'old')).toBe(false);
    expect(a.notePrompt('oc_b', 'keep')).toBe(false);
    expect(a.notePrompt('oc_a', 'old')).toBe(false); // touch oc_a
    expect(a.notePrompt('oc_c', 'new')).toBe(false); // evict oc_b
    expect(a.notePrompt('oc_b', 'changed')).toBe(false); // unknown hash after eviction
  });
});
