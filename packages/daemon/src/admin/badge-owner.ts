import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppRoleSnapshot } from '../config/app-roles';
import { botPaths } from '../config/paths';
import { listProjectsIn } from '../project/registry';
import type { GroupMembers } from './groups';

type ReadMembers = (appId: string, chatId: string, cursor?: string) => Promise<GroupMembers>;
type Owner = Pick<AppRoleSnapshot, 'appId' | 'tenant' | 'ownerOpenId'> & { name: string; observedAt: number };
const hitTTL = 12 * 60 * 60_000;
const missTTL = 30 * 60_000;
const fileFor = (appId: string) => join(botPaths(appId).dir, 'badge-owner.json');

function restore(roles: AppRoleSnapshot): Owner | undefined {
  try {
    const value = JSON.parse(readFileSync(fileFor(roles.appId), 'utf8')) as Owner;
    if (value.appId === roles.appId && value.tenant === roles.tenant && value.ownerOpenId === roles.ownerOpenId
      && typeof value.name === 'string' && value.name.trim() && Number.isFinite(value.observedAt)) return value;
  } catch { /* No confirmed name cached for this registration. */ }
  return undefined;
}

function persist(owner: Owner): void {
  // No mkdir: a late lookup must never recreate a removed bot directory.
  const file = fileFor(owner.appId);
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } catch { try { unlinkSync(tmp); } catch { /* Cache is optional. */ } }
}

/** Return cached names synchronously. Older Feishu applications often expose only the owner ID.
 * Resolve that ID from the same paginated group membership API that the dashboard already uses. */
export function createBadgeOwnerNames(readMembers?: ReadMembers) {
  type Entry = { identity: string; name?: string; nextRead: number; pending?: Promise<void>; pages?: AsyncGenerator<GroupMembers> };
  const entries = new Map<string, Entry>();

  async function* pages(appId: string): AsyncGenerator<GroupMembers> {
    const projects = await listProjectsIn(botPaths(appId).projectsFile);
    for (const chatId of new Set(projects.map(p => p.chatId).filter(Boolean))) {
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        let page: GroupMembers;
        try { page = await readMembers!(appId, chatId, cursor); } catch { page = { members: [] }; }
        yield page;
        cursor = page.nextCursor;
        if (cursor) {
          if (seen.has(cursor)) break;
          seen.add(cursor);
        }
      } while (cursor);
    }
  }

  async function refresh(roles: AppRoleSnapshot, entry: Entry): Promise<void> {
    entry.pages ??= pages(roles.appId);
    // Bound each burst. Resume large rosters on the next pass instead of rescanning their first page.
    for (let count = 0; count < 8 && entries.get(roles.appId) === entry; count++) {
      const result = await entry.pages.next();
      if (entries.get(roles.appId) !== entry) return;
      if (result.done) {
        entry.pages = undefined;
        return;
      }
      const name = result.value.members.find(m => m.openId === roles.ownerOpenId)?.name.trim();
      if (name && name !== '（未命名成员）') {
        entry.name = name;
        entry.nextRead = Date.now() + hitTTL;
        entry.pages = undefined;
        persist({ appId: roles.appId, tenant: roles.tenant, ownerOpenId: roles.ownerOpenId, name, observedAt: Date.now() });
        return;
      }
    }
    entry.nextRead = Date.now() + 60_000;
  }

  return {
    get(appId: string, roles: AppRoleSnapshot | undefined, running: boolean): string | undefined {
      if (!roles?.ownerOpenId || roles.ownerName) {
        entries.delete(appId);
        return roles?.ownerOpenId ? roles.ownerName : undefined;
      }
      const identity = JSON.stringify([roles.tenant, roles.ownerOpenId]);
      let entry = entries.get(appId);
      if (entry?.identity !== identity) {
        const cached = restore(roles);
        entry = { identity, name: cached?.name, nextRead: cached ? Math.min(Date.now(), cached.observedAt) + hitTTL : 0 };
        entries.set(appId, entry);
      }
      if (running && readMembers && !entry.pending && Date.now() >= entry.nextRead) {
        const target = entry;
        entry.nextRead = Date.now() + missTTL;
        entry.pending = refresh(roles, target).catch(() => { target.pages = undefined; })
          .finally(() => { target.pending = undefined; });
      }
      return entry.name;
    },
    retain(appIds: ReadonlySet<string>) {
      for (const id of entries.keys()) if (!appIds.has(id)) entries.delete(id);
    },
  };
}
