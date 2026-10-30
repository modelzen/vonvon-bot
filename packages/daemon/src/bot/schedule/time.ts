import type { ScheduleSpec } from '@vonvon/protocol';

const MINUTE = 60_000;
const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
export function hostTimeZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
export function localParts(timeZone: string, ms: number) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(ms);
  const value = (key: string) => Number(parts.find(p => p.type === key)?.value);
  const y = value('year'), m = value('month'), d = value('day');
  return { y, m, d, hh: value('hour'), mm: value('minute'), weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}
function wall(ms: number, zone: string): number {
  const p = localParts(zone, ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
}
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
export function parseCron(expr: string) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron 不合法：需要 5 段');
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] satisfies [number, number][];
  const sets = bounds.map(([min, max], index) => {
    const field = fields[index] ?? '';
    const values = new Set<number>();
    for (const item of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
      if (!match) throw new Error('cron 不合法：只支持数字、范围、列表和步长');
      const base = match[1] ?? '', step = Number(match[2] ?? 1);
      if (match[2] && base !== '*' && !base.includes('-')) throw new Error('cron 不合法：步长要用于星号或范围');
      const [start, end] = base === '*' ? [min, max] : base.split('-').map(Number);
      const stop = end ?? start;
      if (start === undefined || stop === undefined || !Number.isSafeInteger(step) || step < 1 || start < min || stop > max || start > stop) throw new Error('cron 不合法：范围或步长超出限制');
      for (let n = start; n <= stop; n += step) values.add(index === 4 && n === 7 ? 0 : n);
    }
    return values;
  });
  const [minutes, hours, days, months, weekdays] = sets;
  if (!minutes || !hours || !days || !months || !weekdays) throw new Error('cron 不合法：需要 5 段');
  return { minutes, hours, days, months, weekdays, anyDay: fields[2] === '*', anyWeekday: fields[4] === '*' };
}
function calendar(spec: Exclude<ScheduleSpec, { kind: 'once' | 'every' }>) {
  const cron = spec.kind === 'cron' ? parseCron(spec.expr) : undefined;
  const [hh, mm] = spec.kind === 'cron' ? [0, 0] : spec.time.split(':').map(Number);
  return {
    hours: cron ? [...cron.hours] : [hh ?? 0], minutes: cron ? [...cron.minutes] : [mm ?? 0],
    matches(y: number, m: number, d: number): boolean {
      const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      if (spec.kind === 'weekly') return spec.days.includes(weekday);
      if (!cron) return true;
      const dom = cron.days.has(d), dow = cron.weekdays.has(weekday);
      return cron.months.has(m) && (cron.anyDay ? dow : cron.anyWeekday ? dom : dom || dow);
    },
  };
}
function calendarSlot(spec: Exclude<ScheduleSpec, { kind: 'once' | 'every' }>, zone: string, edge: number, forward: boolean, days: number, limit: number): number | undefined {
  const p = localParts(zone, edge), rule = calendar(spec);
  const date = Date.UTC(p.y, p.m - 1, p.d);
  for (let i = 0; i <= days; i++) {
    const day = new Date(date + (forward ? i : -i) * DAY);
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    if (!rule.matches(y, m, d)) continue;
    let best: number | undefined;
    for (const hh of rule.hours) for (const mm of rule.minutes) {
      const slot = instantOf(zone, y, m, d, hh, mm);
      if ((forward ? slot > edge && slot <= limit : slot <= edge && slot > limit)
        && (best === undefined || (forward ? slot < best : slot > best))) best = slot;
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
  return calendarSlot(spec, zone, after, true, 400, after + 400 * DAY);
}
export function latestSlotWithin(spec: ScheduleSpec, zone: string, now: number, window: number): number | undefined {
  if (spec.kind === 'once') return spec.at <= now && spec.at > now - window ? spec.at : undefined;
  if (spec.kind === 'every') {
    const { anchor, step } = interval(spec), k = Math.floor((now - anchor) / step), slot = anchor + k * step;
    return k >= 1 && slot > now - window ? slot : undefined;
  }
  return calendarSlot(spec, zone, now, false, spec.kind === 'cron' ? Math.ceil(window / DAY) : Math.min(8, Math.ceil(window / DAY)), now - window);
}
export function countSlotsBetween(spec: ScheduleSpec, zone: string, from: number, to: number, cap = 10000): number {
  if (to <= from || cap <= 0) return 0;
  if (spec.kind === 'once') return spec.at > from && spec.at <= to ? 1 : 0;
  if (spec.kind === 'every') {
    const { anchor, step } = interval(spec);
    return Math.min(cap, Math.max(0, Math.floor((to - anchor) / step)) - Math.max(0, Math.floor((from - anchor) / step)));
  }
  const rule = calendar(spec), first = localParts(zone, from), last = localParts(zone, to);
  const end = Date.UTC(last.y, last.m - 1, last.d);
  let count = 0;
  for (let day = Date.UTC(first.y, first.m - 1, first.d); day <= end; day += DAY) {
    const date = new Date(day), y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate();
    if (!rule.matches(y, m, d)) continue;
    const slots = new Set<number>();
    for (const hh of rule.hours) for (const mm of rule.minutes) {
      const slot = instantOf(zone, y, m, d, hh, mm);
      if (slot > from && slot <= to) slots.add(slot);
    }
    count += slots.size;
    if (count >= cap) return cap;
  }
  return count;
}
const pad = (n: number) => String(n).padStart(2, '0');
const suffix = (zone: string, host: string) => zone === host ? '' : `（${zone}）`;
export function formatHHMM(ms: number, zone: string): string { const p = localParts(zone, ms); return `${pad(p.hh)}:${pad(p.mm)}`; }
export function formatAt(ms: number, zone: string, host: string): string {
  const p = localParts(zone, ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${formatHHMM(ms, zone)}${suffix(zone, host)}`;
}
export function ceilToMinute(ms: number): number { return Math.ceil(ms / MINUTE) * MINUTE; }
export function describeSpec(spec: ScheduleSpec, zone: string, host: string, nowMs = Date.now()): string {
  let text: string;
  switch (spec.kind) {
    case 'once': { const p = localParts(zone, spec.at); text = `${p.y === localParts(zone, nowMs).y ? '' : `${p.y} 年 `}${p.m} 月 ${p.d} 日 ${formatHHMM(spec.at, zone)} 一次`; break; }
    case 'every': text = spec.minutes % 60 === 0 ? `每 ${spec.minutes / 60} 小时` : `每 ${spec.minutes} 分钟`; break;
    case 'daily': text = `每天 ${spec.time}`; break;
    case 'weekly': { const days = [...new Set(spec.days)].sort((a, b) => a - b); text = `${days.join(',') === '1,2,3,4,5' ? '每个工作日' : `每周${days.map(day => '日一二三四五六'[day]).join('、')}`} ${spec.time}`; break; }
    case 'cron': text = `cron「${spec.expr}」`; break;
    default: { const exhaustive: never = spec; return exhaustive; }
  }
  return text + suffix(zone, host);
}
export function validateSpec(spec: ScheduleSpec, now: number, zone: string): string | undefined {
  try { new Intl.DateTimeFormat(undefined, { timeZone: zone }); } catch { return `不认识这个时区：${zone}`; }
  switch (spec.kind) {
    case 'once': return spec.at <= now ? '一次性任务的时间已经过了' : spec.at > now + 365 * DAY ? '一次性任务最远只能排到一年后' : undefined;
    case 'every': return !Number.isInteger(spec.minutes) || spec.minutes < 1 || spec.minutes > 10080 ? '间隔最短 1 分钟，最长 7 天' : undefined;
    case 'weekly': { if (!spec.days.length || spec.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) return '星期要在 0 到 6 之间，至少一个';
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(spec.time) ? undefined : '时间要写成 HH:mm'; }
    case 'daily': return /^([01]\d|2[0-3]):[0-5]\d$/.test(spec.time) ? undefined : '时间要写成 HH:mm';
    case 'cron': try { return nextSlotAfter(spec, zone, now) === undefined ? '这个 cron 在 400 天内没有一次会到' : undefined; } catch (error) { return error instanceof Error ? error.message : 'cron 不合法：格式错误'; }
    default: { const exhaustive: never = spec; return exhaustive; }
  }
}
