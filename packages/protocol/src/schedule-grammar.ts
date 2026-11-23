export function parseScheduleCron(expr: string) {
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
  // Like Vixie cron and cronie, a day field that starts with '*' (also '*/2') counts as not given.
  return { minutes, hours, days, months, weekdays, anyDay: fields[2]?.startsWith('*') ?? false, anyWeekday: fields[4]?.startsWith('*') ?? false };
}

export function resolveScheduleTimeZone(zone: string): string {
  return new Intl.DateTimeFormat('en', {timeZone: zone}).resolvedOptions().timeZone;
}
