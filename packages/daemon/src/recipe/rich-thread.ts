import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentRun, AgentThread } from '../agent/types';
import { writeFileAtomic } from '../server/atomic-file';
import { recipeAdmissions } from './rich-admission';

const aliasPattern = /^recipe_session_([a-f0-9-]{36})$/;
export const isRecipeSession = (id: string) => aliasPattern.test(id);
export async function rememberRecipeThread(root: string, slot: string, epoch: string, nativeId: string): Promise<string> {
  const dir = join(root, 'recipe-native-sessions');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const alias = 'recipe_session_' + randomUUID();
  const index = join(dirname(dirname(root)), 'recipe-session-owners', createHash('sha256').update(nativeId).digest('hex'));
  await writeFileAtomic(index, JSON.stringify({ slot, alias, epoch }), { durable: true });
  await writeFileAtomic(join(dir, alias), JSON.stringify({ slot, epoch, nativeId }), { durable: true });
  return alias;
}
export async function managedThreadOwner(
  root: string,
  id: string,
): Promise<{ slot: string; alias: string; epoch: string } | undefined> {
  try {
    return JSON.parse(
      await readFile(
        join(dirname(dirname(root)), 'recipe-session-owners', createHash('sha256').update(id).digest('hex')),
        'utf8',
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
export async function recipeHistoryId(root: string, id: string, slot: string): Promise<string> {
  if (!isRecipeSession(id)) {
    if (await managedThreadOwner(root, id)) throw new Error('请使用本群的历史会话入口');
    return id;
  }
  const record = JSON.parse(await readFile(join(root, 'recipe-native-sessions', id), 'utf8'));
  if (record.slot !== slot || typeof record.nativeId !== 'string') throw new Error('历史会话不属于这个群');
  return record.nativeId;
}
export async function recipeResumeId(root: string, alias: string, slot: string, epoch: string): Promise<string | undefined> {
  if (!isRecipeSession(alias)) return;
  let data: string;
  try {
    data = await readFile(join(root, 'recipe-native-sessions', alias), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const record = JSON.parse(data);
  if (record.slot === slot && record.epoch === epoch && typeof record.nativeId === 'string') return record.nativeId;
}

export function guardRecipeThread(thread: AgentThread, slot: string, assertEpoch: () => void, alias?: string): AgentThread {
  const pending = new Set<() => void>();
  function acquire() {
    const release = recipeAdmissions.acquire(slot);
    try {
      assertEpoch();
    } catch (error) {
      release();
      throw error;
    }
    const end = () => {
      pending.delete(end);
      release();
    };
    pending.add(end);
    return end;
  }
  function run(start: () => AgentRun): AgentRun {
    const end = acquire();
    try {
      const active = start(),
        stream = active.events;
      return new Proxy(active, {
        get(target, key) {
          if (key === 'events')
            return (async function* () {
              let consumed = false;
              try {
                yield* stream;
                consumed = true;
              } finally {
                if (!consumed) await thread.close();
                end();
              }
            })();
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    } catch (error) {
      end();
      throw error;
    }
  }
  return new Proxy(thread, {
    get(target, key) {
      if (key === 'sessionId' && alias) return alias;
      if (key === 'runStreamed')
        return (...args: Parameters<AgentThread['runStreamed']>) => run(() => thread.runStreamed(...args));
      if (key === 'runGoal') return (...args: Parameters<AgentThread['runGoal']>) => run(() => thread.runGoal(...args));
      if (key === 'close')
        return async () => {
          await thread.close();
          for (const end of pending) end();
        };
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (key === 'compact' || key === 'steer' || key === 'injectContext')
        return async (...args: unknown[]) => {
          const end = acquire();
          try {
            return await value.apply(target, args);
          } finally {
            end();
          }
        };
      return value.bind(target);
    },
  });
}
