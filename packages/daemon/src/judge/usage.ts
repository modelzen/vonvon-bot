import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { log } from '../core/logger';
import { writeFileAtomic } from '../server/atomic-file';
import type { JudgeResult } from './types';

export const JUDGE_USAGE_KEEP_DAYS = 30;
export const JUDGE_USAGE_FLUSH_MS = 5_000;
export const JUDGE_USAGE_CLOSE_MS = 2_000;
const keyShape = /^(llm|decision):[a-z0-9][a-z0-9-]{0,39}$/;
const daysSchema = z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.record(z.string().regex(keyShape), z.number().int().nonnegative()));
const fileSchema = z.object({ version: z.literal(1), days: daysSchema });
export type JudgeUsageDays = z.infer<typeof daysSchema>;
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function localDayBefore(ms: number, n: number): string {
  const d = new Date(ms);
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime());
}
export function usageKey(result: Pick<JudgeResult, 'backend' | 'provider'>): string | undefined {
  const key = result.provider !== undefined ? `decision:${result.provider}` : `llm:${result.backend}`;
  return keyShape.test(key) ? key : undefined;
}
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
export class JudgeUsageUnreadable extends Error {
  constructor(readonly code?: string, readonly newer?: boolean) { super('判断次数读不了'); }
}
export async function readJudgeUsage(file: string): Promise<JudgeUsageDays> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (z.object({ version: z.number().int().gt(1) }).safeParse(value).success) throw new JudgeUsageUnreadable(undefined, true);
    const parsed = fileSchema.safeParse(value);
    if (!parsed.success) throw new JudgeUsageUnreadable();
    return parsed.data.days;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {};
    if (error instanceof JudgeUsageUnreadable) throw error;
    throw new JudgeUsageUnreadable(errorCode(error));
  }
}
export interface JudgeUsage { add(result: JudgeResult): void; flush(): Promise<void>; close(): Promise<void> }
function merge(into: JudgeUsageDays, delta: JudgeUsageDays): void {
  for (const [day, counts] of Object.entries(delta)) {
    const target = into[day] ??= {};
    for (const [key, count] of Object.entries(counts)) target[key] = (target[key] ?? 0) + count;
  }
}
export function createJudgeUsage(opts: {
  file: string; now?: () => number; flushMs?: number; closeMs?: number;
  write?: (file: string, text: string) => Promise<void>; read?: (file: string) => Promise<JudgeUsageDays>;
}): JudgeUsage {
  const now = opts.now ?? Date.now, flushMs = opts.flushMs ?? JUDGE_USAGE_FLUSH_MS;
  let pending: JudgeUsageDays = {}, chain = Promise.resolve(), closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unreadLogged = false, newerLogged = false;
  const skipped = new Set<string>();
  const clear = (): void => { clearTimeout(timer); timer = undefined; };
  const schedule = (delay: number): void => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
    timer.unref();
  };
  const flush = (): Promise<void> => {
    clear();
    chain = chain.then(async () => {
      if (!Object.keys(pending).length) return;
      const delta = pending; pending = {};
      let days: JudgeUsageDays;
      try { days = await (opts.read ?? readJudgeUsage)(opts.file); }
      catch (error) {
        if (error instanceof JudgeUsageUnreadable && error.newer) {
          if (!newerLogged) { log.warn('judge', 'usage-newer-file'); newerLogged = true; }
          return;
        }
        if (!unreadLogged) { log.warn('judge', 'usage-unreadable', { code: errorCode(error) }); unreadLogged = true; }
        days = {};
      }
      merge(days, delta);
      const oldest = localDayBefore(now(), JUDGE_USAGE_KEEP_DAYS - 1);
      for (const day of Object.keys(days)) if (day < oldest) delete days[day];
      try { await (opts.write ?? writeFileAtomic)(opts.file, JSON.stringify({ version: 1, days })); }
      catch (error) {
        merge(pending, delta);
        log.warn('judge', 'usage-write-failed', { code: errorCode(error) });
        clear(); schedule(flushMs * 12);
      }
    });
    return chain;
  };
  return {
    add(result) {
      if (closed) return;
      const key = usageKey(result);
      if (!key) {
        const value = JSON.stringify([result.backend, result.provider]);
        if (!skipped.has(value)) { skipped.add(value); log.warn('judge', 'usage-key-skipped', { backend: result.backend, provider: result.provider }); }
        return;
      }
      const counts = pending[localDay(now())] ??= {};
      counts[key] = (counts[key] ?? 0) + 1;
      schedule(flushMs);
    },
    flush,
    async close() {
      closed = true; clear();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([flush(), new Promise<void>(resolve => {
          timeout = setTimeout(() => { log.warn('judge', 'usage-close-timeout'); resolve(); }, opts.closeMs ?? JUDGE_USAGE_CLOSE_MS);
        })]);
      } catch { /* Usage never blocks shutdown. */ }
      finally { clearTimeout(timeout); }
    },
  };
}
