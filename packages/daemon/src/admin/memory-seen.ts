import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryEvent, MemoryItem } from '@vonvon/protocol';
import { writeFileAtomic } from '../server/atomic-file';
import type { LibraryLocation } from '../project/library';

/**
 * 记忆设计 5.8 的"新"标记。主人上次打开某一页（`bot:<appId>`、`project:<projectId>`）的时间存在 `<数据根>/library/seen.json`，
 * 只有本机一份，桌面端和网页端看到的一样。原子写，不占 `'library'` 锁，也不碰条目、revision 和完整性校验：新不新只拿事件的 `at` 比。
 */
export type SeenPage = { kind: 'bot'; botId: string } | { kind: 'project'; projectId: string } | { kind: 'dm'; botId: string; openId: string };
export const seenKey = (page: SeenPage): string => page.kind === 'bot' ? `bot:${page.botId}` : page.kind === 'project' ? `project:${page.projectId}` : `dm:${page.botId}:${page.openId}`;
const seenFile = (library: LibraryLocation): string => join(library.dir, 'seen.json');

export async function readSeen(library: LibraryLocation): Promise<Record<string, number>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(seenFile(library), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
  } catch { return {}; }
}

// 同一个进程里的两次写排队：读—改—写不会互相覆盖（跨进程的并发 seen 只会少记一页的时间，下次打开再记，不丢条目）
let chain: Promise<unknown> = Promise.resolve();
export function markSeen(library: LibraryLocation, page: SeenPage, at: number): Promise<void> {
  const run = chain.then(async () => {
    const current = await readSeen(library);
    await writeFileAtomic(seenFile(library), `${JSON.stringify({ ...current, [seenKey(page)]: Math.max(at, current[seenKey(page)] ?? 0) })}\n`);
  });
  chain = run.catch(() => undefined);
  return run;
}

/** 主人自己在桌面端、命令行做的、迁移导入的不标；群里（工具、隐藏块、群友的 update/forget）做的标。 */
const QUIET_ROLES = new Set<MemoryEvent['actor']['role']>(['desktop', 'cli', 'import']);
const QUIET_KINDS = new Set<MemoryEvent['kind']>(['purge', 'branch_rename', 'branch_merge', 'branch_unmerge']);

export interface Marks { ids: Set<string>; branches: Set<string>; madeRoom: Set<string> }

/** Which entries and branches the events after `seenAt` make new, and which entries were archived to make room (3.7). */
export function marksFrom(events: readonly MemoryEvent[], items: readonly Pick<MemoryItem, 'id'>[], seenAt: number): Marks {
  const known = new Set(items.map(item => item.id));
  const marks: Marks = { ids: new Set(), branches: new Set(), madeRoom: new Set() };
  const room = new Set<string>();
  for (const event of events) {
    if (!event.itemId || !known.has(event.itemId)) continue;
    if (event.kind === 'archive' && event.reason === 'make-room') room.add(event.itemId);
    else if (event.kind === 'restore' || event.kind === 'purge') room.delete(event.itemId);
  }
  for (const event of events) {
    if (event.at <= seenAt || QUIET_KINDS.has(event.kind) || !event.itemId || !known.has(event.itemId)) continue;
    const make = event.kind === 'archive' && event.reason === 'make-room';
    if (QUIET_ROLES.has(event.actor.role) && !make) continue;
    marks.ids.add(event.itemId);
    if (event.newBranch && event.after) marks.branches.add(event.after.branch);
  }
  for (const id of room) marks.madeRoom.add(id);
  return marks;
}
