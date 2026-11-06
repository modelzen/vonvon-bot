import { describe, expect, it } from 'vitest';
import { ATTENTION_DEFAULTS, Attention, outcomeOf } from '../src/bot/attention';

const T0 = 1_000_000_000_000;
const s = (n: number) => n * 1000;
const m = (n: number) => n * 60_000;
const A = { chatId: 'oc_a', place: 'oc_a' };
const A1 = { chatId: 'oc_a', place: 'omt_a1' };
const A2 = { chatId: 'oc_a', place: 'omt_a2' };
const B = { chatId: 'oc_b', place: 'oc_b' };
const reading = (a: Attention, chatId = A.chatId) => a.snapshot().find(group => group.groupId === chatId)?.group;

describe('one score per group', () => {
  it('starts low even in a historically owned topic', () => {
    const a = new Attention();
    expect(a.arrive(A1, T0, { mine: true })).toBe('watch');
    expect(reading(a)).toEqual({ score: 10, intervalMs: m(5), updatedAt: T0 });
    expect(a.followup(A1, T0, 'ou_person')).toBe(false);
    expect(a.state(A1.place)).toMatchObject({ mode: 'watch', topic: true, intervalMs: m(5) });
  });

  it('raises the whole group only after a real participation lands', () => {
    const a = new Attention();
    a.arrive(A, T0); a.arrive(A1, T0); a.arrive(B, T0);
    a.verdict(A1, 'glance', 'reply', T0);
    expect(reading(a)?.score).toBe(10);
    a.replied(A1, T0 + 1, { senderId: 'ou_person' });
    expect(reading(a)).toEqual({ score: 100, intervalMs: s(5), updatedAt: T0 + 1 });
    expect(a.state(A.place)).toMatchObject({ mode: 'focus', intervalMs: s(5) });
    expect(a.state(A1.place)).toMatchObject({ mode: 'focus', intervalMs: s(5) });
    expect(reading(a, B.chatId)?.score).toBe(10);
  });

  it.each([[2, 75, 1], [10, 50, 3], [20, 25, 5], [30, 10, 5], [180, 10, 5]])(
    'decays at %i minutes for both the main area and every topic', (minutes, score, interval) => {
      const a = new Attention(); a.arrive(A, T0); a.replied(A1, T0);
      a.expire(T0 + m(minutes!));
      expect(reading(a)).toMatchObject({ score, intervalMs: m(interval!) });
      expect(a.state(A.place)?.intervalMs).toBe(m(interval!));
      expect(a.state(A1.place)?.intervalMs).toBe(m(interval!));
      expect(a.snapshot()[0]?.focusedTopics).toBe(0);
    },
  );

  it('keeps exact boundaries deterministic and publishes each transition once', () => {
    const a = new Attention(); const reports: ReturnType<Attention['snapshot']>[] = [];
    a.observe(groups => { reports.push(groups); });
    a.replied(A1, T0);
    expect(a.nextExpiryAt()).toBe(T0 + m(2));
    expect(a.expire(T0 + m(2) - 1)).toBe(false);
    expect(reading(a)?.score).toBe(100);
    const count = reports.length;
    expect(a.expire(T0 + m(2))).toBe(true);
    expect(reading(a)?.score).toBe(75);
    expect(reports).toHaveLength(count + 1);
    expect(a.expire(T0 + m(2))).toBe(false);
    expect(reports).toHaveLength(count + 1);
    expect(a.nextExpiryAt()).toBe(T0 + m(10));
    a.expire(T0 + m(30));
    expect(a.nextExpiryAt()).toBeUndefined();
  });

  it('does not renew participation from arrivals, skips, errors or bot-only replies', () => {
    const a = new Attention(); a.replied(A, T0);
    for (let minute = 1; minute <= 30; minute++) {
      a.arrive(A1, T0 + m(minute));
      a.verdict(A1, 'glance', minute % 2 ? 'skip' : 'error', T0 + m(minute));
      a.replied(A2, T0 + m(minute), { participation: false });
    }
    expect(reading(a)?.score).toBe(10);
    expect(a.followup(A2, T0 + m(30), 'ou_person')).toBe(false);
  });

  it('renews deadlines when the Bot actually participates again', () => {
    const a = new Attention(); a.replied(A, T0);
    a.replied(A1, T0 + m(9));
    expect(a.nextExpiryAt()).toBe(T0 + m(11));
    a.expire(T0 + m(10));
    expect(reading(a)?.score).toBe(100);
    a.expire(T0 + m(11));
    expect(reading(a)?.score).toBe(75);
  });

  it('never rewinds group time for a delayed judgement', () => {
    const a = new Attention(); a.replied(A1, T0); a.expire(T0 + m(30));
    a.verdict(A1, 'signal', 'reply', T0);
    expect(reading(a)?.score).toBe(10);
    expect(a.nextExpiryAt()).toBeUndefined();
    a.arrive(A, T0 + m(1));
    expect(a.state(A.place)?.arrivedAt).toBe(T0 + m(30));
  });
});

describe('batching ordinary messages', () => {
  it('looks at the first quiet batch after twenty seconds without raising the score', () => {
    const a = new Attention(); a.arrive(A, T0);
    expect(a.due(A.place, [], T0)).toBeUndefined();
    expect(a.due(A.place, [T0], T0)).toBe(T0 + s(20));
    a.arrive(A, T0 + s(10));
    expect(a.due(A.place, [T0, T0 + s(10)], T0 + s(10))).toBe(T0 + s(30));
    a.glanced(A, T0 + s(30));
    a.verdict(A, 'glance', 'skip', T0 + s(31));
    expect(reading(a)?.score).toBe(10);
  });

  it('uses one cold start for all positions, then respects the five-minute cooldown', () => {
    const a = new Attention(); a.arrive(A, T0); a.arrive(A1, T0 + s(1));
    a.glanced(A, T0 + s(21));
    expect(a.due(A1.place, [T0 + s(1)], T0 + s(21))).toBe(T0 + s(321));
    a.arrive(A2, T0 + s(30));
    expect(a.due(A2.place, [T0 + s(30)], T0 + s(30))).toBe(T0 + s(321));
  });

  it('does not let ten messages punch through a cold-group cooldown', () => {
    const a = new Attention(); a.arrive(A, T0); a.glanced(A, T0 + s(20));
    const pending = Array.from({ length: 10 }, (_, i) => T0 + s(21 + i));
    for (const at of pending) a.arrive(A, at);
    expect(a.due(A.place, pending, pending.at(-1)!)).toBe(T0 + s(320));
  });

  it('reopens a fast first batch only after the whole group has been quiet for five minutes', () => {
    const a = new Attention(); a.arrive(A, T0); a.glanced(A, T0 + s(20));
    a.arrive(A1, T0 + m(4));
    a.arrive(A, T0 + m(5));
    expect(a.due(A.place, [T0 + m(5)], T0 + m(5))).toBe(T0 + s(320));
    a.glanced(A, T0 + s(320));
    a.arrive(A1, T0 + m(10));
    expect(a.due(A1.place, [T0 + m(10)], T0 + m(10))).toBe(T0 + m(10) + s(20));
  });

  it('batches at score 100 with a fixed five-second bound even under continuous arrivals', () => {
    const a = new Attention(); a.replied(A1, T0);
    const pending = Array.from({ length: 5 }, (_, i) => T0 + s(i));
    for (const at of pending) a.arrive(A, at);
    expect(a.due(A.place, pending, T0 + s(4))).toBe(T0 + s(5));
    a.glanced(A, T0 + s(5));
    a.arrive(A2, T0 + s(6));
    expect(a.due(A2.place, [T0 + s(6)], T0 + s(6))).toBe(T0 + s(11));
  });

  it.each([[2, 1], [10, 3], [20, 5], [30, 5]])('shares the %i-minute-age cadence across positions', (age, interval) => {
    const a = new Attention(); a.arrive(A, T0); a.replied(A1, T0);
    const at = T0 + m(age!);
    a.arrive(A, at); a.glanced(A, at + s(20));
    a.arrive(A2, at + s(21));
    expect(a.due(A2.place, [at + s(21)], at + s(21))).toBe(at + s(20) + m(interval!));
  });

  it('bounds a continually postponed batch so a busy sibling cannot starve it', () => {
    const a = new Attention(); a.arrive(A, T0); a.glanced(A, T0 + s(20));
    a.arrive(A1, T0 + s(30));
    a.glanced(A, T0 + m(4));
    expect(a.due(A1.place, [T0 + s(30)], T0 + m(4))).toBe(T0 + s(390));
    expect(a.due(A1.place, [T0 + s(30)], T0 + m(8))).toBe(T0 + m(8));
  });

  it('bounds the cold-start wait under a continuous stream', () => {
    const a = new Attention();
    const pending = Array.from({ length: 8 }, (_, i) => T0 + s(i * 10));
    for (const at of pending) a.arrive(A, at);
    expect(a.due(A.place, pending, T0 + s(70))).toBe(T0 + s(80));
  });
});

describe('one-use recent follow-ups', () => {
  it('gives a topic exactly one early next message without renewing its group', () => {
    const a = new Attention(); a.replied(A1, T0);
    expect(a.followup(A1, T0 + s(1), 'ou_anyone')).toBe(true);
    expect(a.followup(A1, T0 + s(2), 'ou_anyone')).toBe(false);
    expect(a.nextExpiryAt()).toBe(T0 + m(2));
    a.replied(A1, T0 + s(3));
    expect(a.followup(A1, T0 + s(4), 'ou_anyone')).toBe(true);
  });

  it('restricts main-area shortcuts to the person who was just addressed', () => {
    const a = new Attention(); a.replied(A, T0, { senderId: 'ou_requester' });
    expect(a.followup(A, T0 + s(1), 'ou_other')).toBe(false);
    expect(a.followup(A, T0 + s(1))).toBe(false);
    expect(a.followup(A, T0 + s(2), 'ou_requester')).toBe(true);
    expect(a.followup(A, T0 + s(3), 'ou_requester')).toBe(false);
    a.replied(A, T0 + s(4));
    expect(a.followup(A, T0 + s(5), 'ou_requester')).toBe(false);
  });

  it('expires the shortcut at two minutes and never revives an old topic', () => {
    const a = new Attention(); a.replied(A1, T0);
    expect(a.followup(A1, T0 + m(2), 'ou_person')).toBe(false);
    a.arrive(A1, T0 + m(180), { mine: true });
    expect(a.followup(A1, T0 + m(180), 'ou_person')).toBe(false);
    expect(reading(a)?.score).toBe(10);
  });

  it('shares the originating reply shortcut with its actually opened topic', () => {
    const a = new Attention(); const ticket = a.replied(A, T0, { senderId: 'ou_requester' });
    a.openedTopic(A.chatId, A1.place, ticket);
    expect(a.followup(A1, T0 + s(1), 'ou_other')).toBe(true);
    expect(a.followup(A, T0 + s(2), 'ou_requester')).toBe(false);
    expect(reading(a)?.updatedAt).toBe(T0);
  });

  it('binds an asynchronous opening to its own reply instead of a newer main-area reply', () => {
    const a = new Attention();
    const first = a.replied(A, T0, { senderId: 'ou_first' });
    const second = a.replied(A, T0 + s(10), { senderId: 'ou_second' });
    a.openedTopic(A.chatId, A1.place, first, T0 + s(11));
    expect(a.followup(A1, T0 + s(12), 'ou_anyone')).toBe(true);
    expect(a.followup(A, T0 + s(13), 'ou_second')).toBe(true);
    a.openedTopic(A.chatId, A2.place, second, T0 + s(14));
    expect(a.followup(A2, T0 + s(14), 'ou_anyone')).toBe(false);
  });

  it('rejects expired, cross-group and forgotten capabilities', () => {
    const a = new Attention();
    const ticket = a.replied(A, T0);
    a.openedTopic(B.chatId, 'omt_b', ticket, T0 + s(1));
    expect(a.state('omt_b')).toBeUndefined();
    a.openedTopic(A.chatId, A1.place, ticket, T0 + m(2));
    expect(a.state(A1.place)).toBeUndefined();
    const fresh = a.replied(A, T0 + m(3));
    a.forget(A.chatId); a.arrive(A, T0 + m(3) + 1);
    a.openedTopic(A.chatId, A1.place, fresh, T0 + m(3) + 2);
    expect(a.state(A1.place)).toBeUndefined();
  });

  it('does not grant shortcuts for background topic recovery', () => {
    const a = new Attention(); a.openedTopic(A.chatId, A1.place);
    expect(a.snapshot()).toEqual([]);
    a.replied(A, T0);
    a.openedTopic(A.chatId, A1.place, undefined, T0 + 1);
    expect(a.state(A1.place)).toBeUndefined();
    a.expire(T0 + m(2)); a.openedTopic(A.chatId, A1.place);
    expect(a.state(A1.place)).toBeUndefined();
  });

  it('budget freezing consumes the shortcut while preserving the group score', () => {
    const a = new Attention();
    expect(a.freeze(A1, T0)).toBe(false);
    a.replied(A1, T0); expect(a.freeze(A1, T0 + s(1))).toBe(true);
    expect(a.followup(A1, T0 + s(2), 'ou_person')).toBe(false);
    expect(reading(a)?.score).toBe(100);
  });
});

describe('bounded state and context', () => {
  it('evicts least-recently-used positions and drops group state only after its last position leaves', () => {
    const a = new Attention({ places: 2 }); a.replied(A, T0); a.arrive(A1, T0); a.arrive(B, T0);
    expect(a.state(A.place)).toBeUndefined();
    expect(reading(a)?.score).toBe(100);
    a.arrive({ chatId: 'oc_c', place: 'oc_c' }, T0);
    expect(reading(a)).toBeUndefined();
    expect(a.nextExpiryAt()).toBeUndefined();
  });

  it('keeps reads from changing LRU order and returns state copies without routing tickets', () => {
    const a = new Attention({ places: 2 }); a.replied(A, T0); a.arrive(A1, T0);
    const copy = a.state(A.place)!;
    copy.mode = 'watch';
    expect(a.state(A.place)?.mode).toBe('focus');
    expect(copy).not.toHaveProperty('followup');
    a.arrive(B, T0);
    expect(a.state(A.place)).toBeUndefined();
  });

  it('invalidates captured group identities after forgetting or LRU eviction', () => {
    const a = new Attention({ places: 1 }); a.arrive(A, T0);
    const first = a.captureGroup(A.chatId);
    expect(a.isCurrentGroup(A.chatId, first)).toBe(true);
    expect(a.isCurrentGroup(B.chatId, first)).toBe(false);
    a.forget(A.chatId); a.arrive(A, T0 + 1);
    expect(a.isCurrentGroup(A.chatId, first)).toBe(false);
    const second = a.captureGroup(A.chatId);
    a.arrive(B, T0 + 2); a.arrive(A, T0 + 3);
    expect(a.isCurrentGroup(A.chatId, second)).toBe(false);
  });

  it('forgets only one group and retains its prompt hash across resets', () => {
    const a = new Attention(); a.replied(A1, T0); a.replied(B, T0);
    expect(a.notePrompt(A.chatId, 'old')).toBe(false);
    expect(a.notePrompt(A.chatId, 'new')).toBe(true);
    expect(reading(a)).toBeUndefined();
    expect(reading(a, B.chatId)?.score).toBe(100);
    a.forget(A.chatId);
    expect(a.notePrompt(A.chatId, 'newer')).toBe(true);
  });

  it('bounds remembered prompt hashes independently of active groups', () => {
    const a = new Attention({ places: 2 });
    a.notePrompt('oc_a', 'a'); a.notePrompt('oc_b', 'b'); a.notePrompt('oc_a', 'a'); a.notePrompt('oc_c', 'c');
    expect(a.notePrompt('oc_b', 'changed')).toBe(false);
  });

  it('keeps the latest ten recent messages as candidates and older messages as context', () => {
    const a = new Attention(); const now = T0 + m(20);
    const pending = [T0, T0 + m(10), ...Array.from({ length: 12 }, (_, n) => T0 + m(15) + s(10 * n))].map((at, id) => ({ at, id }));
    expect(a.pickGlance(pending, now)).toEqual({ look: pending.slice(4), old: pending.slice(0, 4) });
    const edge = [{ at: now - m(10) - 1 }, { at: now - m(10) }];
    expect(a.pickGlance(edge, now)).toEqual({ look: [edge[1]], old: [edge[0]] });
  });

  it('rejects invalid cadence and decay boundaries', () => {
    expect(ATTENTION_DEFAULTS.decayMs).toEqual([m(2), m(10), m(20), m(30)]);
    expect(() => new Attention({ places: 0 })).toThrow(RangeError);
    expect(() => new Attention({ intervalsMs: [] })).toThrow(RangeError);
    expect(() => new Attention({ intervalsMs: [m(3), m(1), m(5)] })).toThrow(RangeError);
    expect(() => new Attention({ decayMs: [m(2), m(10)] })).toThrow(RangeError);
  });

  it('maps model outcomes while leaving participation decisions to the caller', () => {
    expect(outcomeOf({ decision: 'skip' })).toBe('skip');
    for (const decision of ['main', 'topic', 'reply'] as const) expect(outcomeOf({ decision })).toBe('reply');
    expect(outcomeOf({ decision: 'main', error: { kind: 'timeout' } })).toBe('error');
  });
});
