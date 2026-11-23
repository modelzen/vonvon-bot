import {describeRecurringSchedule, parseScheduleCron as parseCron, resolveScheduleTimeZone, type ScheduleSpec} from '@vonvon/protocol';

export {parseCron};

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
const zoneNames = new Map<string, string>();
export function hostTimeZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
// The name Intl resolves a zone to, so 'asia/shanghai' equals 'Asia/Shanghai' and Asia/Kolkata equals Asia/Calcutta.
// Throws a RangeError for a zone Intl does not know.
export function normalizeTimeZone(zone: string): string {
  let name = zoneNames.get(zone);
  if (name === undefined) {
    name = resolveScheduleTimeZone(zone);
    zoneNames.set(zone, name);
  }
  return name;
}
export function localParts(timeZone: string, ms: number) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(ms);
  const value = (key: string) => Number(parts.find(p => p.type === key)?.value);
  const y = value('year'), m = value('month'), d = value('day');
  return { y, m, d, hh: value('hour'), mm: value('minute'), weekday: weekdayOf(y, m, d) };
}
function weekdayOf(y: number, m: number, d: number): number { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function wall(ms: number, zone: string): number {
  const p = localParts(zone, ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
}
// Local wall time minus UTC at a whole-minute instant.
function offsetAt(zone: string, ms: number): number { return wall(ms, zone) - ms; }
export function instantOf(zone: string, y: number, m: number, d: number, hh: number, mm: number): number {
  const target = Date.UTC(y, m - 1, d, hh, mm);
  // Offsets on both sides of a transition resolve folds to the first occurrence,
  // and gaps using the offset before the transition (02:30 becomes 03:30).
  const offsets = new Set([-2, -1, 0, 1, 2].map(days => wall(target + days * DAY, zone) - (target + days * DAY)));
  const candidates = [...offsets].map(offset => target - offset).sort((a, b) => a - b);
  return candidates.find(ms => wall(ms, zone) === target)
    ?? candidates.filter(ms => wall(ms, zone) > target).sort((a, b) => wall(a, zone) - wall(b, zone))[0]
    ?? target;
}
export function parseLocal(zone: string, text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return instantOf(zone, y, m, d, Number(hour), Number(minute));
}
type Cron = ReturnType<typeof parseCron>;
function cronDays(cron: Cron): (m: number, d: number, weekday: number) => boolean {
  // Flag arrays rather than Set lookups: validateCron asks about every date of a 400-year cycle.
  const flags = (values: Set<number>, size: number) => Array.from({ length: size }, (_, n) => values.has(n));
  const months = flags(cron.months, 13), days = flags(cron.days, 32), weekdays = flags(cron.weekdays, 7);
  // Standard cron: when either day field is not given both must match; only two restricted fields are a union.
  const both = cron.anyDay || cron.anyWeekday;
  return (m, d, weekday) => months[m] === true && (both ? days[d] === true && weekdays[weekday] === true : days[d] === true || weekdays[weekday] === true);
}
type CalendarSpec = Exclude<ScheduleSpec, { kind: 'once' | 'every' }>;
interface CalendarRule {
  // Minutes of the local day (hh × 60 + mm) the spec fires at, ascending.
  times: number[];
  matches(y: number, m: number, d: number): boolean;
}
function calendar(spec: CalendarSpec): CalendarRule {
  if (spec.kind !== 'cron') {
    const [hh = 0, mm = 0] = spec.time.split(':').map(Number);
    const weekdays = spec.kind === 'weekly' ? spec.days : undefined;
    return { times: [hh * 60 + mm], matches: (y, m, d) => !weekdays || weekdays.includes(weekdayOf(y, m, d)) };
  }
  const cron = parseCron(spec.expr), matchDay = cronDays(cron);
  const ascending = (values: Set<number>) => [...values].sort((a, b) => a - b);
  const times: number[] = [];
  for (const hh of ascending(cron.hours)) {
    for (const mm of ascending(cron.minutes)) times.push(hh * 60 + mm);
  }
  return { times, matches: (y, m, d) => matchDay(m, d, weekdayOf(y, m, d)) };
}
interface LocalDay {
  // Instant of a minute of this local day, the same as instantOf returns for it.
  slot(minuteOfDay: number): number;
  // One offset all day: slot() grows with the minute, so the first slot found in scan order is the nearest.
  linear: boolean;
}
function localDay(zone: string, y: number, m: number, d: number): LocalDay {
  const base = Date.UTC(y, m - 1, d);
  // Every instant whose wall time falls on this day lies in [lo, hi], for any offset from -12:00 to +14:00.
  // Equal offsets at both ends mean no transition near the day (no zone changes its offset twice within these
  // 52 hours), so every minute is base + minute - offset, which is what instantOf returns for it.
  const lo = base - 15 * HOUR, hi = base + DAY + 13 * HOUR;
  const before = offsetAt(zone, lo), after = offsetAt(zone, hi);
  if (before === after) return { linear: true, slot: minute => base + minute * MINUTE - before };
  const change = transitionInstant(zone, lo, hi, before);
  if (offsetAt(zone, change) !== after) {
    // More than one change in the window: resolve every minute on its own.
    return { linear: false, slot: minute => instantOf(zone, y, m, d, Math.floor(minute / 60), minute % 60) };
  }
  return {
    linear: false,
    slot(minute) {
      const local = base + minute * MINUTE;
      const early = local - before; // this wall time read with the offset before the transition
      const late = local - after; // and with the offset after it
      const earlyExists = early < change, lateExists = late >= change;
      if (earlyExists && lateExists) return Math.min(early, late); // fold: the first occurrence
      if (lateExists) return late;
      return early; // before the transition, or in a gap, which shifts it forward by the gap
    },
  };
}
// First whole-minute instant in (lo, hi] whose offset is no longer `before`; lo must have `before` and hi must not.
function transitionInstant(zone: string, lo: number, hi: number, before: number): number {
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (offsetAt(zone, mid) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}
// Nearest slot after `edge` (forward) or at or before it (backward), not past `limit`, looking at most `days` local days away.
// A forward scan starts one date earlier: a gap that crosses midnight (America/Nuuk skips 23:00-23:59) shifts the
// slots of the date before onto edge's date. Gaps only shift forward, so a backward scan needs no such date.
function calendarSlot(spec: CalendarSpec, zone: string, edge: number, forward: boolean, days: number, limit: number): number | undefined {
  const rule = calendar(spec);
  const order = forward ? rule.times : [...rule.times].reverse();
  const p = localParts(zone, edge);
  const date = Date.UTC(p.y, p.m - 1, p.d);
  for (let i = forward ? -1 : 0; i <= days; i++) {
    const day = new Date(date + (forward ? i : -i) * DAY);
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    if (!rule.matches(y, m, d)) continue;
    const local = localDay(zone, y, m, d);
    let best: number | undefined;
    for (const minute of order) {
      const slot = local.slot(minute);
      const inside = forward ? slot > edge && slot <= limit : slot <= edge && slot > limit;
      if (!inside) continue;
      if (best === undefined || (forward ? slot < best : slot > best)) best = slot;
      if (local.linear) break;
    }
    if (best !== undefined) return best;
  }
  return undefined;
}
function interval(spec: Extract<ScheduleSpec, { kind: 'every' }>): { anchor: number; step: number } {
  if (spec.anchor === undefined) throw new Error('every requires anchor');
  return { anchor: spec.anchor, step: spec.minutes * MINUTE };
}
export function nextSlotAfter(spec: ScheduleSpec, zone: string, after: number): number | undefined {
  if (spec.kind === 'once') return spec.at > after ? spec.at : undefined;
  if (spec.kind === 'every') {
    const { anchor, step } = interval(spec);
    return anchor + Math.max(1, Math.floor((after - anchor) / step) + 1) * step;
  }
  // Bounded by dates only: a next date 400 days on is found even when a DST change makes it 400 days and an hour.
  return calendarSlot(spec, zone, after, true, 400, Infinity);
}
export function latestSlotWithin(spec: ScheduleSpec, zone: string, now: number, window: number): number | undefined {
  if (spec.kind === 'once') return spec.at <= now && spec.at > now - window ? spec.at : undefined;
  if (spec.kind === 'every') {
    const { anchor, step } = interval(spec), k = Math.floor((now - anchor) / step), slot = anchor + k * step;
    return k >= 1 && slot > now - window ? slot : undefined;
  }
  // One date more than the window spans: after a spring-forward, now − window reads as a wall time on the date before.
  const dates = Math.ceil(window / DAY) + 1;
  return calendarSlot(spec, zone, now, false, spec.kind === 'cron' ? dates : Math.min(8, dates), now - window);
}
// `every` is exact arithmetic; daily, weekly and cron stop counting at `cap` and return `cap`.
export function countSlotsBetween(spec: ScheduleSpec, zone: string, from: number, to: number, cap = 10000): number {
  if (to <= from) return 0;
  if (spec.kind === 'once') return spec.at > from && spec.at <= to ? 1 : 0;
  if (spec.kind === 'every') {
    const { anchor, step } = interval(spec);
    return Math.max(0, Math.floor((to - anchor) / step)) - Math.max(0, Math.floor((from - anchor) / step));
  }
  if (cap <= 0) return 0;
  const rule = calendar(spec), first = localParts(zone, from), last = localParts(zone, to);
  const end = Date.UTC(last.y, last.m - 1, last.d);
  // A gap minute lands on the same instant as the minute one gap later, on this date or (a gap across midnight) the
  // next one, so start one date early, like calendarSlot, and count distinct instants over the whole range.
  const slots = new Set<number>();
  for (let date = Date.UTC(first.y, first.m - 1, first.d) - DAY; date <= end && slots.size < cap; date += DAY) {
    const day = new Date(date), y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    if (!rule.matches(y, m, d)) continue;
    const local = localDay(zone, y, m, d);
    for (const minute of rule.times) {
      const slot = local.slot(minute);
      if (slot > from && slot <= to) slots.add(slot);
    }
  }
  return Math.min(slots.size, cap);
}
const pad = (n: number) => String(n).padStart(2, '0');
function sameZone(a: string, b: string): boolean {
  try {
    return normalizeTimeZone(a) === normalizeTimeZone(b);
  } catch {
    return a === b; // a stored zone this Intl no longer knows still gets described
  }
}
const suffix = (zone: string, host: string) => sameZone(zone, host) ? '' : `（${zone}）`;
export function formatHHMM(ms: number, zone: string): string { const p = localParts(zone, ms); return `${pad(p.hh)}:${pad(p.mm)}`; }
export function formatAt(ms: number, zone: string, host: string): string {
  const p = localParts(zone, ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${formatHHMM(ms, zone)}${suffix(zone, host)}`;
}
export function ceilToMinute(ms: number): number { return Math.ceil(ms / MINUTE) * MINUTE; }
export function describeSpec(spec: ScheduleSpec, zone: string, host: string, now: number): string {
  let text: string;
  switch (spec.kind) {
    case 'once': {
      const p = localParts(zone, spec.at);
      const year = p.y === localParts(zone, now).y ? '' : `${p.y} 年 `;
      text = `${year}${p.m} 月 ${p.d} 日 ${formatHHMM(spec.at, zone)} 一次`;
      break;
    }
    default: text = describeRecurringSchedule(spec);
  }
  return text + suffix(zone, host);
}
const MAX_GAP_DAYS = 400; // nextSlotAfter looks this many dates ahead
const CYCLE_DAYS = 146_097; // 400 Gregorian years, after which dates and weekdays repeat
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const daysInMonth = (y: number, m: number) => m === 2 && y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : MONTH_DAYS[m - 1] ?? 31;
// Whether every two matching dates in a row are at most 400 days apart. Walks civil dates from `start` across one
// cycle plus one gap, so the gap that wraps around the cycle is measured too. Dates are enough: a matching date always
// has a slot, and times of day and DST move it by hours. A start that does not match counts as one: the gap it opens
// is shorter than the real one around it, so it cannot refuse a cron that fits.
function gapsFit(matchDay: (m: number, d: number, weekday: number) => boolean, start: { y: number; m: number; d: number }): boolean {
  let { y, m, d } = start, weekday = weekdayOf(y, m, d), last = 0;
  for (let i = 0; i <= CYCLE_DAYS + MAX_GAP_DAYS; i++) {
    // Checked on every date, matching ones too: a match 401 days after the last one is already too far.
    if (i - last > MAX_GAP_DAYS) return false;
    if (matchDay(m, d, weekday)) last = i;
    weekday = (weekday + 1) % 7;
    if (++d > daysInMonth(y, m)) { d = 1; if (++m > 12) { m = 1; y++; } }
  }
  return true;
}
// A cron is refused unless its first slot is within the 400-day search and no two slots in a row are further apart:
// a Feb 29 cron, or '0 9 31 10 */6' (Oct 31 on a weekend: 2026, 2027, then 2032), would stop running for good.
function validateCron(spec: Extract<ScheduleSpec, { kind: 'cron' }>, now: number, zone: string): string | undefined {
  try {
    const fits = nextSlotAfter(spec, zone, now) !== undefined && gapsFit(cronDays(parseCron(spec.expr)), localParts(zone, now));
    return fits ? undefined : '这个 cron 在 400 天内没有一次会到';
  } catch (error) {
    return error instanceof Error ? error.message : 'cron 不合法：格式错误';
  }
}
export function validateSpec(spec: ScheduleSpec, now: number, zone: string): string | undefined {
  try { normalizeTimeZone(zone); } catch { return `不认识这个时区：${zone}`; }
  switch (spec.kind) {
    case 'once': {
      if (spec.at <= now) return '一次性任务的时间已经过了';
      // 366 days: a calendar year that spans a Feb 29 is 366 days long.
      return spec.at > now + 366 * DAY ? '一次性任务最远只能排到一年后' : undefined;
    }
    case 'every': return !Number.isInteger(spec.minutes) || spec.minutes < 1 || spec.minutes > 10080 ? '间隔最短 1 分钟，最长 7 天' : undefined;
    case 'weekly': { if (!spec.days.length || spec.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) return '星期要在 0 到 6 之间，至少一个';
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(spec.time) ? undefined : '时间要写成 HH:mm'; }
    case 'daily': return /^([01]\d|2[0-3]):[0-5]\d$/.test(spec.time) ? undefined : '时间要写成 HH:mm';
    case 'cron': return validateCron(spec, now, zone);
    default: { const exhaustive: never = spec; return exhaustive; }
  }
}
