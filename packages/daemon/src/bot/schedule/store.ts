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
}).strict();
function parseTask(value: unknown): StoredTask {
  const runtime = runtimeSchema.parse(value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => ['cursor', 'inflight', 'noticePending'].includes(key))) : value);
  const persisted = taskSchema.parse(value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !['cursor', 'inflight', 'noticePending'].includes(key))) : value);
  if (persisted.spec.kind === 'every' && persisted.spec.anchor === undefined) throw new Error('missing every anchor');
  return { ...persisted, ...runtime };
}
const fileSchema = z.object({ version: z.literal(1), tasks: z.array(z.unknown()).max(200) }).strict();

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
    for (const task of draft) {
      task.recent = task.recent.slice(-20);
      if (task.lastResult) {
        let excerpt = '';
        for (const char of task.lastResult.excerpt) {
          if (excerpt.length + char.length > 500) break;
          excerpt += char;
        }
        task.lastResult.excerpt = excerpt;
      }
    }
    await writeFileAtomic(file, JSON.stringify({ version: 1, tasks: draft }), { durable: true });
    tasks = structuredClone(draft);
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
      try { loaded = fileSchema.parse(JSON.parse(text)).tasks.map(parseTask); } catch (error) {
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
