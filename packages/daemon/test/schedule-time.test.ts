import { describe, expect, it, vi } from 'vitest';
import type { ScheduleSpec } from '@vonvon/protocol';
import { ceilToMinute, countSlotsBetween, describeSpec, formatAt, formatHHMM, hostTimeZone, instantOf, latestSlotWithin, localParts, nextSlotAfter, normalizeTimeZone, parseCron, parseLocal, validateSpec } from '../src/bot/schedule/time.js';
const zone = 'Asia/Shanghai';
const at = (text: string) => { const value = parseLocal(zone, text); if (value === undefined) throw new Error(text); return value; };
const minute = 60_000;
const hour = 3_600_000;
const day = 86_400_000;
const daily = { kind: 'daily', time: '09:00' } satisfies ScheduleSpec;
const everyMinute = { kind: 'cron', expr: '* * * * *' } satisfies ScheduleSpec;
const ny = 'America/New_York';
const nuuk = 'America/Nuuk'; // skips 23:00-23:59 of 2026-03-28, so those slots land on 03-29

// Reference for the cross-check: walk every local minute of each day and resolve the ones the cron lists with instantOf.
function bruteSlots(expr: string, timeZone: string, days: [number, number, number][]): number[] {
  const cron = parseCron(expr);
  const slots = new Set<number>();
  for (const [y, m, d] of days) {
    for (let local = 0; local < 24 * 60; local++) {
      const hh = Math.floor(local / 60), mm = local % 60;
      if (cron.hours.has(hh) && cron.minutes.has(mm)) slots.add(instantOf(timeZone, y, m, d, hh, mm));
    }
  }
  return [...slots].sort((a, b) => a - b);
}

describe('schedule time', () => {
  it('keeps interval anchors, strict boundaries and once semantics', () => {
    const anchor = at('2026-11-01 10:01');
    const spec = { kind: 'every', minutes: 30, anchor } satisfies ScheduleSpec;
    expect(nextSlotAfter(spec, zone, anchor - 37_000)).toBe(anchor + 30 * 60_000);
    expect(nextSlotAfter(spec, zone, anchor + 30 * 60_000)).toBe(anchor + 60 * 60_000);
    expect(() => nextSlotAfter({ kind: 'every', minutes: 1 }, zone, anchor)).toThrow('anchor');
    expect(nextSlotAfter({ kind: 'once', at: anchor }, zone, anchor - 1)).toBe(anchor);
    expect(nextSlotAfter({ kind: 'once', at: anchor }, zone, anchor)).toBeUndefined();
    expect(ceilToMinute(anchor - 36_500)).toBe(anchor);
    expect(ceilToMinute(anchor)).toBe(anchor);
  });
  it('advances daily and weekly dates across years', () => {
    expect(nextSlotAfter(daily, zone, at('2026-11-01 09:00'))).toBe(at('2026-11-02 09:00'));
    const weekly = { kind: 'weekly', days: [1, 3], time: '10:00' } satisfies ScheduleSpec;
    expect(nextSlotAfter(weekly, zone, at('2026-11-02 10:00'))).toBe(at('2026-11-04 10:00'));
    expect(nextSlotAfter(weekly, zone, at('2026-11-04 10:00'))).toBe(at('2026-11-09 10:00'));
    expect(nextSlotAfter({ kind: 'daily', time: '00:00' }, zone, at('2026-12-31 00:00'))).toBe(at('2027-01-01 00:00'));
  });
  it('resolves DST gaps forward and folds to their first instant in both directions', () => {
    const gap = Date.parse('2026-03-08T07:30:00Z'), fold = Date.parse('2026-11-01T05:30:00Z');
    expect(instantOf(ny, 2026, 3, 8, 2, 30)).toBe(gap);
    expect(instantOf(ny, 2026, 11, 1, 1, 30)).toBe(fold);
    expect(nextSlotAfter({ kind: 'daily', time: '02:30' }, ny, Date.parse('2026-03-08T05:00:00Z'))).toBe(gap);
    expect(latestSlotWithin({ kind: 'daily', time: '02:30' }, ny, gap + 60_000, day)).toBe(gap);
    expect(latestSlotWithin({ kind: 'daily', time: '01:30' }, ny, fold + 3600_000, day)).toBe(fold);
    expect(nextSlotAfter({ kind: 'daily', time: '01:30' }, ny, fold)).toBe(Date.parse('2026-11-02T06:30:00Z'));
    expect(nextSlotAfter({ kind: 'cron', expr: '30 2 * * *' }, ny, gap - 3600_000)).toBe(gap);
    expect(latestSlotWithin({ kind: 'cron', expr: '30 1 * * *' }, ny, fold + 3600_000, day)).toBe(fold);
    expect(countSlotsBetween({ kind: 'cron', expr: '30 1 * * *' }, ny, fold - 1, fold + 3600_000)).toBe(1);
    expect(countSlotsBetween({ kind: 'cron', expr: '30 2,3 * * *' }, ny, gap - 1, gap)).toBe(1);
  });
  it('resolves transition days with 30-minute and midnight shifts like instantOf', () => {
    // Lord Howe moves 30 minutes; Santiago skips 00:00-00:59 on 2026-09-06 and repeats 23:00-23:59 on 2026-04-04.
    const cases: [string, [number, number, number]][] = [
      ['Australia/Lord_Howe', [2026, 10, 4]], ['Australia/Lord_Howe', [2026, 4, 5]],
      ['America/Santiago', [2026, 9, 6]], ['America/Santiago', [2026, 4, 4]], ['Europe/London', [2026, 3, 29]],
    ];
    for (const [timeZone, [y, m, d]] of cases) {
      const slots = bruteSlots('*/5 * * * *', timeZone, [[y, m, d]]);
      const first = slots[0] ?? 0, last = slots.at(-1) ?? 0;
      expect(countSlotsBetween({ kind: 'cron', expr: '*/5 * * * *' }, timeZone, first - 1, last, Infinity)).toBe(slots.length);
      for (const slot of slots) expect(nextSlotAfter({ kind: 'cron', expr: '*/5 * * * *' }, timeZone, slot - 1)).toBe(slot);
    }
  });
  it('[8][10][r2-1] matches a brute-force minute walk across both New York DST days and the Nuuk gap across midnight', () => {
    const crons = ['* * * * *', '*/7 * * * *', '0,15,30,45 1-3 * * *', '59 1,2 * * *', '0 0-23/5 * * *', '30 23 * * *', '0,30 0,23 * * *'];
    const transitions: [string, [number, number, number][], number][] = [
      [ny, [[2026, 3, 6], [2026, 3, 7], [2026, 3, 8], [2026, 3, 9]], Date.parse('2026-03-08T07:00:00Z')],
      [ny, [[2026, 10, 30], [2026, 10, 31], [2026, 11, 1], [2026, 11, 2]], Date.parse('2026-11-01T06:00:00Z')],
      [nuuk, [[2026, 3, 27], [2026, 3, 28], [2026, 3, 29], [2026, 3, 30]], Date.parse('2026-03-29T01:00:00Z')],
    ];
    for (const [timeZone, days, transition] of transitions) {
      const edges: number[] = [];
      for (let edge = transition - 8 * hour; edge <= transition + 20 * hour; edge += 37 * minute) edges.push(edge);
      for (let edge = transition - 70 * minute; edge <= transition + 70 * minute; edge += 5 * minute) edges.push(edge);
      for (const expr of crons) {
        const spec = { kind: 'cron', expr } satisfies ScheduleSpec;
        const slots = bruteSlots(expr, timeZone, days);
        for (const edge of edges) {
          const label = `${timeZone} ${expr} @ ${new Date(edge).toISOString()}`;
          expect(nextSlotAfter(spec, timeZone, edge), label).toBe(slots.find(slot => slot > edge));
          expect(latestSlotWithin(spec, timeZone, edge, day), label).toBe(slots.filter(slot => slot <= edge && slot > edge - day).at(-1));
          const count = slots.filter(slot => slot > edge - 6 * hour && slot <= edge).length;
          expect(countSlotsBetween(spec, timeZone, edge - 6 * hour, edge, Infinity), label).toBe(count);
        }
      }
    }
    // A spring day has 23 hours of distinct minutes (the gap lands on 03:00-03:59); a fall day keeps each minute once.
    const springDay: [number, number, number][] = [[2026, 3, 8]], fallDay: [number, number, number][] = [[2026, 11, 1]];
    const spring = Date.parse('2026-03-08T05:00:00Z'), fall = Date.parse('2026-11-01T04:00:00Z');
    expect(countSlotsBetween(everyMinute, ny, spring - 1, spring + 23 * hour - minute, Infinity)).toBe(bruteSlots('* * * * *', ny, springDay).length);
    expect(bruteSlots('* * * * *', ny, springDay)).toHaveLength(23 * 60);
    expect(countSlotsBetween(everyMinute, ny, fall - 1, fall + 25 * hour - minute, Infinity)).toBe(24 * 60);
    expect(bruteSlots('* * * * *', ny, fallDay)).toHaveLength(24 * 60);
  });
  it('[r2-1] finds and counts a slot a gap across midnight moves onto the next date once (America/Nuuk)', () => {
    const shifted = Date.parse('2026-03-29T01:30:00Z'); // 03-28 23:30 does not exist; it runs at 03-29 00:30
    expect(instantOf(nuuk, 2026, 3, 28, 23, 30)).toBe(shifted);
    for (const after of [Date.UTC(2026, 2, 29, 1, 0), Date.UTC(2026, 2, 29, 1, 10), Date.UTC(2026, 2, 29, 1, 29)]) {
      expect(nextSlotAfter({ kind: 'daily', time: '23:30' }, nuuk, after)).toBe(shifted);
      expect(nextSlotAfter({ kind: 'weekly', days: [6], time: '23:30' }, nuuk, after)).toBe(shifted);
    }
    expect(countSlotsBetween({ kind: 'cron', expr: '0 * * * *' }, nuuk, Date.UTC(2026, 2, 29, 0), Date.UTC(2026, 2, 29, 3))).toBe(3);
    expect(countSlotsBetween(everyMinute, nuuk, Date.UTC(2026, 2, 28, 12), Date.UTC(2026, 2, 29, 6))).toBe(1080);
    expect(countSlotsBetween({ kind: 'cron', expr: '30 0,23 * * *' }, nuuk, Date.UTC(2026, 2, 28, 12), Date.UTC(2026, 2, 29, 6))).toBe(1);
    expect(countSlotsBetween({ kind: 'daily', time: '23:30' }, nuuk, Date.UTC(2026, 2, 29, 1), Date.UTC(2026, 2, 29, 2))).toBe(1);
  });
  it('[r2-2][r2-12] looks back one more date, so the oldest hour of a 7-day window after a spring-forward is seen', () => {
    const cases: [string, string, number, string][] = [
      [ny, '45 23 7 * *', instantOf(ny, 2026, 3, 15, 0, 30), '2026-03-08T04:45:00Z'],
      [ny, '50 23 7 3 *', Date.parse('2027-03-15T04:10:00Z'), '2027-03-08T04:50:00Z'],
      ['Australia/Sydney', '50 23 * 9 *', Date.parse('2027-10-07T13:38:00Z'), '2027-09-30T13:50:00Z'],
      ['Europe/London', '*/4 23 21-27/2 * */3', Date.parse('2027-04-03T23:24:00Z'), '2027-03-27T23:56:00Z'],
    ];
    for (const [timeZone, expr, now, want] of cases) {
      expect(latestSlotWithin({ kind: 'cron', expr }, timeZone, now, 7 * day), `${timeZone} ${expr}`).toBe(Date.parse(want));
    }
  });
  it('[8][10] resolves dense crons without an Intl call per minute of the day', () => {
    const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    const intlCalls = (run: () => unknown) => { formatToParts.mockClear(); run(); return formatToParts.mock.calls.length; };
    try {
      const now = at('2026-11-05 12:34'), late = at('2026-11-05 23:59');
      expect(nextSlotAfter(everyMinute, zone, now)).toBe(now + minute);
      expect(intlCalls(() => nextSlotAfter(everyMinute, zone, now))).toBeLessThan(10);
      expect(intlCalls(() => nextSlotAfter(everyMinute, zone, late))).toBeLessThan(10);
      expect(intlCalls(() => latestSlotWithin(everyMinute, zone, now, 7 * day))).toBeLessThan(10);
      expect(intlCalls(() => validateSpec(everyMinute, now, zone))).toBeLessThan(15);
      expect(countSlotsBetween(everyMinute, zone, now - 30 * day, now, Infinity)).toBe(30 * 24 * 60);
      expect(intlCalls(() => countSlotsBetween(everyMinute, zone, now - 30 * day, now, Infinity))).toBeLessThan(31 * 3);
      // Two Intl calls per day; a transition day adds a binary search for the switch, not one instantOf per minute.
      // The forward scan also reads the date before (a gap across midnight), whose window holds the same switch.
      expect(intlCalls(() => nextSlotAfter(everyMinute, ny, Date.parse('2026-03-08T06:59:00Z')))).toBeLessThan(45);
      expect(intlCalls(() => countSlotsBetween(everyMinute, ny, Date.parse('2026-11-01T04:00:00Z'), Date.parse('2026-11-02T05:00:00Z'), Infinity))).toBeLessThan(40);
    } finally {
      formatToParts.mockRestore();
    }
  });
  it('parses cron steps, ranges, lists, Sunday aliases and union day semantics', () => {
    const cron = (expr: string, after: string) => nextSlotAfter({ kind: 'cron', expr }, zone, at(after));
    expect(cron('*/15 * * * *', '2026-11-01 10:07')).toBe(at('2026-11-01 10:15'));
    expect(cron('0 9 * * 1-5', '2026-11-06 09:00')).toBe(at('2026-11-09 09:00'));
    expect(cron('0 9 1 * 1', '2026-11-01 09:00')).toBe(at('2026-11-02 09:00'));
    expect(cron('0 0 30 2 *', '2026-11-01 09:00')).toBeUndefined();
    expect(cron('30,0 10,9 * * *', '2026-11-01 09:10')).toBe(at('2026-11-01 09:30'));
    expect([...parseCron('0,30 9-12/2 * * 7').weekdays]).toEqual([0]);
    for (const expr of ['a b c', '60 * * * *', '*/0 * * * *', '10/5 * * * *', '0 9 * JAN MON']) expect(() => parseCron(expr)).toThrow('cron 不合法');
  });
  it('[14] treats a day field starting with * (also */n) as not given, like Vixie cron', () => {
    // 2026-11-02 and 2026-11-09 are Mondays.
    const cron = (expr: string, after: string) => nextSlotAfter({ kind: 'cron', expr }, zone, at(after));
    expect(cron('0 9 */1 * 1', '2026-11-02 09:00')).toBe(at('2026-11-09 09:00'));
    expect(cron('0 9 */2 * 1', '2026-11-02 09:00')).toBe(at('2026-11-09 09:00'));
    expect(cron('0 9 1 * */1', '2026-11-02 09:00')).toBe(at('2026-12-01 09:00'));
    expect(cron('0 9 */2 * *', '2026-11-01 09:00')).toBe(at('2026-11-03 09:00'));
    expect(cron('0 9 * * */2', '2026-11-02 09:00')).toBe(at('2026-11-03 09:00'));
    expect(cron('0 9 1 * 1', '2026-11-01 09:00')).toBe(at('2026-11-02 09:00'));
  });
  it('looks backward directly and caps missed counts', () => {
    const anchor = at('2026-11-01 10:00'), now = anchor + 7 * day + 3600_000;
    const every = { kind: 'every', minutes: 1, anchor } satisfies ScheduleSpec;
    expect(latestSlotWithin(every, zone, now, 7 * day)).toBe(now);
    expect(latestSlotWithin(daily, zone, at('2026-11-04 08:00'), 7 * day)).toBe(at('2026-11-03 09:00'));
    expect(latestSlotWithin({ kind: 'cron', expr: '0 9 1 1 *' }, zone, at('2026-06-01 12:00'), 7 * day)).toBeUndefined();
    expect(countSlotsBetween(every, zone, anchor, anchor + 3 * 3600_000)).toBe(180);
    expect(countSlotsBetween(everyMinute, zone, anchor, anchor + 30 * day)).toBe(10000);
    expect(countSlotsBetween(everyMinute, zone, anchor, anchor + 30 * day, 10001)).toBe(10001);
    expect(countSlotsBetween(daily, zone, at('2026-11-01 09:00'), at('2026-11-04 09:00'))).toBe(3);
    expect(latestSlotWithin({ kind: 'once', at: anchor }, zone, anchor + day, day)).toBeUndefined();
  });
  it('[9] counts every-N slots exactly, with no cap', () => {
    const anchor = at('2026-11-01 10:00');
    const every = { kind: 'every', minutes: 1, anchor } satisfies ScheduleSpec;
    expect(countSlotsBetween(every, zone, anchor, anchor + 30 * day)).toBe(43200);
    expect(countSlotsBetween(every, zone, anchor, anchor + 30 * day, 10)).toBe(43200);
    expect(countSlotsBetween(every, zone, anchor - day, anchor + 30 * minute)).toBe(30);
  });
  it('describes and formats schedules in the requested zone', () => {
    const now = at('2026-10-30 12:00');
    const cases: [ScheduleSpec, string][] = [
      [{ kind: 'every', minutes: 30 }, '每 30 分钟'], [{ kind: 'every', minutes: 120 }, '每 2 小时'],
      [daily, '每天 09:00'], [{ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, '每个工作日 09:00'],
      [{ kind: 'weekly', days: [1, 3], time: '10:00' }, '每周一、三 10:00'],
      [{ kind: 'once', at: at('2026-10-31 14:00') }, '10 月 31 日 14:00 一次'],
      [{ kind: 'once', at: at('2027-01-02 09:00') }, '2027 年 1 月 2 日 09:00 一次'],
      [{ kind: 'cron', expr: '0 9 * * 1-5' }, 'cron「0 9 * * 1-5」'],
    ];
    for (const [spec, text] of cases) expect(describeSpec(spec, zone, zone, now)).toBe(text);
    expect(describeSpec(daily, 'Asia/Tokyo', zone, now)).toBe('每天 09:00（Asia/Tokyo）');
    expect(formatAt(now, zone, zone)).toBe('2026-10-30 12:00');
    expect(formatAt(now, 'Asia/Tokyo', zone)).toBe('2026-10-30 13:00（Asia/Tokyo）');
    expect(formatHHMM(now, zone)).toBe('12:00');
    expect(localParts(zone, now)).toEqual({ y: 2026, m: 10, d: 30, hh: 12, mm: 0, weekday: 5 });
    expect(hostTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(parseLocal(zone, '2026-13-01 14:00')).toBeUndefined();
    expect(parseLocal(zone, '2026-02-30 14:00')).toBeUndefined();
  });
  it('[6] decides the year in describeSpec from the now the caller passes, not the clock', () => {
    const spec = { kind: 'once', at: at('2027-01-02 09:00') } satisfies ScheduleSpec;
    vi.useFakeTimers();
    vi.setSystemTime(at('2027-06-01 12:00'));
    try {
      expect(describeSpec(spec, zone, zone, at('2026-10-30 12:00'))).toBe('2027 年 1 月 2 日 09:00 一次');
      expect(describeSpec(spec, zone, zone, at('2027-01-01 12:00'))).toBe('1 月 2 日 09:00 一次');
    } finally {
      vi.useRealTimers();
    }
    // Type check only (tsc): `now` is required, so a call without it does not compile.
    // @ts-expect-error describeSpec needs the caller's now
    const withoutNow = () => describeSpec(spec, zone, zone);
    expect(withoutNow).toBeTypeOf('function');
  });
  it('[13] compares normalized zone names before adding the zone suffix', () => {
    const now = at('2026-10-30 12:00');
    expect(normalizeTimeZone('ASIA/TOKYO')).toBe('Asia/Tokyo');
    expect(normalizeTimeZone('Asia/Kolkata')).toBe(normalizeTimeZone('Asia/Calcutta'));
    expect(() => normalizeTimeZone('Mars/Olympus')).toThrow(RangeError);
    expect(describeSpec(daily, 'asia/shanghai', 'Asia/Shanghai', now)).toBe('每天 09:00');
    expect(describeSpec(daily, 'Asia/Kolkata', 'Asia/Calcutta', now)).toBe('每天 09:00');
    expect(formatAt(Date.UTC(2026, 10, 1, 2, 0), 'asia/shanghai', 'Asia/Shanghai')).toBe('2026-11-01 10:00');
    expect(formatAt(Date.UTC(2026, 10, 1, 2, 0), 'Asia/Tokyo', 'asia/shanghai')).toBe('2026-11-01 11:00（Asia/Tokyo）');
    expect(validateSpec(daily, now, 'asia/shanghai')).toBeUndefined();
    expect(describeSpec(daily, 'Mars/Olympus', zone, now)).toBe('每天 09:00（Mars/Olympus）');
  });
  it('returns the exact validation copy', () => {
    const now = at('2026-11-01 10:00');
    const cases: [ScheduleSpec, string][] = [
      [{ kind: 'once', at: now }, '一次性任务的时间已经过了'],
      [{ kind: 'once', at: now + 366 * day + 60_000 }, '一次性任务最远只能排到一年后'],
      [{ kind: 'every', minutes: 0 }, '间隔最短 1 分钟，最长 7 天'],
      [{ kind: 'every', minutes: 10081 }, '间隔最短 1 分钟，最长 7 天'],
      [{ kind: 'daily', time: '9:00' }, '时间要写成 HH:mm'],
      [{ kind: 'weekly', days: [], time: '09:00' }, '星期要在 0 到 6 之间，至少一个'],
      [{ kind: 'cron', expr: '0 0 30 2 *' }, '这个 cron 在 400 天内没有一次会到'],
    ];
    for (const [spec, error] of cases) expect(validateSpec(spec, now, zone)).toBe(error);
    expect(validateSpec(daily, now, 'Mars/Olympus')).toBe('不认识这个时区：Mars/Olympus');
    expect(validateSpec({ kind: 'cron', expr: 'a b c' }, now, zone)).toBe('cron 不合法：需要 5 段');
    expect(validateSpec(daily, now, zone)).toBeUndefined();
  });
  it('[11] refuses a cron with no second slot within 400 days, such as Feb 29', () => {
    const now = at('2027-03-01 10:00');
    const leapDay = { kind: 'cron', expr: '0 9 29 2 *' } satisfies ScheduleSpec;
    expect(nextSlotAfter(leapDay, zone, now)).toBe(at('2028-02-29 09:00'));
    expect(nextSlotAfter(leapDay, zone, at('2028-02-29 09:00'))).toBeUndefined();
    expect(validateSpec(leapDay, now, zone)).toBe('这个 cron 在 400 天内没有一次会到');
    expect(validateSpec({ kind: 'cron', expr: '0 9 31 12 *' }, now, zone)).toBeUndefined();
    expect(validateSpec({ kind: 'cron', expr: '0 9 29 2,3 *' }, now, zone)).toBeUndefined();
  });
  it('[r2-13] refuses a cron whose slots are ever more than 400 days apart, not only one without a second slot', () => {
    const now = at('2026-10-30 12:00'), refusal = '这个 cron 在 400 天内没有一次会到';
    // Oct 31 on a weekend: 2026 and 2027, then 2032. Both of the first two slots fit, so the old two-slot check accepted it.
    const weekendOct31 = { kind: 'cron', expr: '0 9 31 10 */6' } satisfies ScheduleSpec;
    const second = nextSlotAfter(weekendOct31, zone, nextSlotAfter(weekendOct31, zone, now) ?? 0);
    expect(second).toBe(at('2027-10-31 09:00'));
    expect(nextSlotAfter(weekendOct31, zone, second ?? 0)).toBeUndefined();
    expect(validateSpec(weekendOct31, now, zone)).toBe(refusal);
    for (const expr of ['0 9 */21 3 1', '0 9 1 4 */2', '0 9 13 2 */6', '0 9 */13 1 5']) expect(validateSpec({ kind: 'cron', expr }, now, zone), expr).toBe(refusal);
    for (const expr of ['* * * * *', '0 9 * * 1-5', '0 9 1 1 *', '0 9 31 12 *', '0 9 29 2,3 *', '0 9 13 * 5', '0 9 31 * *', '0 9 1-7 * */1']) {
      expect(validateSpec({ kind: 'cron', expr }, now, zone), expr).toBeUndefined();
    }
  });
  it('allows a once task one calendar year ahead across Feb 29 (366 days)', () => {
    const now = at('2027-03-01 10:00');
    expect(validateSpec({ kind: 'once', at: at('2028-03-01 10:00') }, now, zone)).toBeUndefined();
    expect(validateSpec({ kind: 'once', at: now + 366 * day }, now, zone)).toBeUndefined();
    expect(validateSpec({ kind: 'once', at: now + 366 * day + 60_000 }, now, zone)).toBe('一次性任务最远只能排到一年后');
  });
});
