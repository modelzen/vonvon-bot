import { randomBytes } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { scheduledTaskViewSchema } from '@vonvon/protocol';
import { z } from 'zod';
import type { log } from '../../core/logger';
import { writeFileAtomic } from '../../server/atomic-file';
import type { ScheduleDiagnosticEvent } from '../diagnostics';
import type { StoredTask } from './types';

export interface ScheduleStore {
  load(): Promise<{ interrupted: StoredTask[] }>;
  all(): StoredTask[];
  byChat(chatId: string): StoredTask[];
  get(taskId: string): StoredTask | undefined;
  mutateConfig<T>(fn: (tasks: StoredTask[], touch: (task: StoredTask) => void) => T): Promise<T>;
  mutateRuntime<T>(fn: (tasks: StoredTask[]) => T): Promise<T>;
  onChange(listener: () => void): () => void;
}

// Reuse protocol validation while storing only the persistent subset of its view.
const taskSchema = scheduledTaskViewSchema.omit({ nextRunAt: true, running: true, describe: true, botId: true });
const runtimeSchema = z.object({
  cursor: z.number().int(),
  inflight: z.object({ runId: z.string(), slot: z.number().int(), trigger: z.enum(['schedule', 'catchUp', 'manual']), startedAt: z.number().int(), revision: z.string() }).strict().optional(),
  noticePending: z.literal(true).optional(),
  noticeSince: z.number().int().optional(), // epoch ms
}).strict();
const runtimeKeys: readonly string[] = runtimeSchema.keyof().options;
const MAX_TASKS_PER_BOT = 200;
const MAX_RECENT = 20;
const MAX_ERROR_UNITS = 200;   // scheduleRunRecordSchema.error
const MAX_EXCERPT_UNITS = 500; // lastResult.excerpt
const fileSchema = z.object({ version: z.literal(1), tasks: z.array(z.unknown()).max(MAX_TASKS_PER_BOT) }).strict();

function pickKeys(value: object, keep: (key: string) => boolean): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => keep(key)));
}

function parseTask(value: unknown): StoredTask {
  if (!value || typeof value !== 'object') throw new Error('task is not an object');
  const runtime = runtimeSchema.parse(pickKeys(value, key => runtimeKeys.includes(key)));
  const persisted = taskSchema.parse(pickKeys(value, key => !runtimeKeys.includes(key)));
  if (persisted.spec.kind === 'every' && persisted.spec.anchor === undefined) throw new Error('missing every anchor');
  return { ...persisted, ...runtime };
}

function describeInvalid(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

/** The one reader of schedules.json contents: load() quarantines what this rejects, and mutate() refuses to write it. */
function parseFile(value: unknown): StoredTask[] {
  return fileSchema.parse(value).tasks.map((task, index) => {
    try {
      return parseTask(task);
    } catch (error) {
      throw new Error(`task ${index}: ${describeInvalid(error)}`, { cause: error });
    }
  });
}

/** Cuts `text` to at most `max` UTF-16 units without splitting a surrogate pair. */
export function clampUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let kept = '';
  for (const char of text) {
    if (kept.length + char.length > max) break;
    kept += char;
  }
  return kept;
}

/** Bounds what runners fill in (a long backend error, a fractional duration) so it fits the strict schema. */
function bound(task: StoredTask): void {
  if (Array.isArray(task.recent)) {
    task.recent = task.recent.slice(-MAX_RECENT);
    for (const record of task.recent) {
      if (typeof record.error === 'string') record.error = clampUnits(record.error, MAX_ERROR_UNITS);
      if (typeof record.durationMs !== 'number') continue;
      if (Number.isFinite(record.durationMs)) record.durationMs = Math.max(0, Math.round(record.durationMs));
      else delete record.durationMs;
    }
  }
  if (typeof task.lastResult?.excerpt === 'string') {
    task.lastResult.excerpt = clampUnits(task.lastResult.excerpt, MAX_EXCERPT_UNITS);
  }
}

export function createScheduleStore(file: string, deps: {
  now: () => number; log: typeof log; diagnostics: (event: ScheduleDiagnosticEvent) => void; newRevision?: () => string;
}): ScheduleStore {
  let tasks: StoredTask[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  };
  const mutate = <T>(fn: (draft: StoredTask[]) => T): Promise<T> => enqueue(async () => {
    const draft = structuredClone(tasks);
    const result = fn(draft);
    for (const task of draft) bound(task);
    const text = JSON.stringify({ version: 1, tasks: draft });
    // Read the text back the way load() will. Writing something load() quarantines would lose every task of the bot
    // at the next start, so refuse it here and keep memory and the file as they were.
    let committed: StoredTask[];
    try {
      committed = parseFile(JSON.parse(text));
    } catch (error) {
      deps.log.warn('schedule', 'store-write-invalid', { error });
      throw new Error(`schedule store refused an invalid write: ${describeInvalid(error)}`, { cause: error });
    }
    await writeFileAtomic(file, text, { durable: true });
    tasks = committed;
    for (const listener of listeners) {
      try { listener(); } catch (error) { deps.log.warn('schedule', 'listener-failed', { error }); }
    }
    return result;
  });
  return {
    load: () => enqueue(async () => {
      let text: string;
      try { text = await readFile(file, 'utf8'); } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { interrupted: [] };
        throw error;
      }
      let loaded: StoredTask[];
      try { loaded = parseFile(JSON.parse(text)); } catch (error) {
        await rename(file, `${file}.corrupt-${deps.now()}`);
        tasks = [];
        deps.log.warn('schedule', 'store-corrupt', { error });
        deps.diagnostics({ kind: 'schedule-store-corrupt' });
        return { interrupted: [] };
      }
      tasks = loaded;
      return { interrupted: structuredClone(tasks.filter(task => task.inflight)) };
    }),
    all: () => structuredClone(tasks),
    byChat: chatId => structuredClone(tasks.filter(task => task.chatId === chatId)),
    get: taskId => structuredClone(tasks.find(task => task.id === taskId)),
    mutateConfig: fn => mutate(draft => fn(draft, task => {
      task.revision = deps.newRevision?.() ?? randomBytes(8).toString('hex');
      task.updatedAt = deps.now();
    })),
    mutateRuntime: mutate,
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
