import { describe, expect, it } from 'vitest';
import type { ScheduleSpec } from '@vonvon/protocol';
import { ceilToMinute, countSlotsBetween, describeSpec, formatAt, formatHHMM, hostTimeZone, instantOf, latestSlotWithin, localParts, nextSlotAfter, parseCron, parseLocal, validateSpec } from '../src/bot/schedule/time.js';
const zone = 'Asia/Shanghai';
const at = (text: string) => { const value = parseLocal(zone, text); if (value === undefined) throw new Error(text); return value; };
const day = 86_400_000;
const daily = { kind: 'daily', time: '09:00' } satisfies ScheduleSpec;
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
    const ny = 'America/New_York', gap = Date.parse('2026-03-08T07:30:00Z'), fold = Date.parse('2026-11-01T05:30:00Z');
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
  it('parses cron steps, ranges, lists, Sunday aliases and union day semantics', () => {
    const cron = (expr: string, after: string) => nextSlotAfter({ kind: 'cron', expr }, zone, at(after));
    expect(cron('*/15 * * * *', '2026-11-01 10:07')).toBe(at('2026-11-01 10:15'));
    expect(cron('0 9 * * 1-5', '2026-11-06 09:00')).toBe(at('2026-11-09 09:00'));
    expect(cron('0 9 1 * 1', '2026-11-01 09:00')).toBe(at('2026-11-02 09:00'));
    expect(cron('0 0 30 2 *', '2026-11-01 09:00')).toBeUndefined();
    expect([...parseCron('0,30 9-12/2 * * 7').weekdays]).toEqual([0]);
    for (const expr of ['a b c', '60 * * * *', '*/0 * * * *', '10/5 * * * *', '0 9 * JAN MON']) expect(() => parseCron(expr)).toThrow('cron 不合法');
  });
  it('looks backward directly and caps missed counts', () => {
    const anchor = at('2026-11-01 10:00'), now = anchor + 7 * day + 3600_000;
    const every = { kind: 'every', minutes: 1, anchor } satisfies ScheduleSpec;
    expect(latestSlotWithin(every, zone, now, 7 * day)).toBe(now);
    expect(latestSlotWithin(daily, zone, at('2026-11-04 08:00'), 7 * day)).toBe(at('2026-11-03 09:00'));
    expect(latestSlotWithin({ kind: 'cron', expr: '0 9 1 1 *' }, zone, at('2026-06-01 12:00'), 7 * day)).toBeUndefined();
    expect(countSlotsBetween(every, zone, anchor, anchor + 3 * 3600_000)).toBe(180);
    expect(countSlotsBetween({ kind: 'cron', expr: '* * * * *' }, zone, anchor, anchor + 30 * day)).toBe(10000);
    expect(countSlotsBetween(daily, zone, at('2026-11-01 09:00'), at('2026-11-04 09:00'))).toBe(3);
    expect(latestSlotWithin({ kind: 'once', at: anchor }, zone, anchor + day, day)).toBeUndefined();
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
  it('returns the exact validation copy', () => {
    const now = at('2026-11-01 10:00');
    const cases: [ScheduleSpec, string][] = [
      [{ kind: 'once', at: now }, '一次性任务的时间已经过了'],
      [{ kind: 'once', at: now + 366 * day }, '一次性任务最远只能排到一年后'],
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
});
