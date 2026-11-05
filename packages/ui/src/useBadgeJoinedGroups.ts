import {useEffect, useSyncExternalStore} from 'react';
import type {VonvonClient} from '@vonvon/client/browser';
import type {AgentId, CommandResult, GroupId} from '@vonvon/protocol';

export type BadgeJoinedGroup = Extract<CommandResult, {kind: 'groups'}>['groups'][number];
type Reader = Pick<VonvonClient, 'run'>;
type GroupsByAgent = ReadonlyMap<AgentId, readonly BadgeJoinedGroup[]>;
const freshness = 60_000;

async function readAllGroups(client: Reader, agentId: AgentId, summaryOnly: boolean): Promise<BadgeJoinedGroup[]> {
  const groups = new Map<GroupId, BadgeJoinedGroup>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.run({type: 'listJoinedGroups', agentId, ...(summaryOnly ? {summaryOnly: true} : {}), ...(cursor ? {cursor} : {})});
    if (page.kind !== 'groups') throw new Error('群列表暂不可用');
    for (const group of page.groups) groups.set(group.id, group);
    cursor = page.nextCursor;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error('群列表返回了重复的分页游标');
      cursors.add(cursor);
    }
  } while (cursor);
  return [...groups.values()];
}

function createDirectory(client: Reader) {
  let groups: GroupsByAgent = new Map();
  const nextRead = new Map<AgentId, number>();
  const pending = new Map<AgentId, Promise<void>>();
  const listeners = new Set<() => void>();
  return {
    snapshot: () => groups,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async refresh(id: AgentId, summaryOnly: boolean) {
      if (pending.has(id)) return pending.get(id);
      if ((nextRead.get(id) ?? 0) > Date.now()) return;
      nextRead.set(id, Date.now() + freshness);
      const read = readAllGroups(client, id, summaryOnly).then(complete => {
        groups = new Map(groups).set(id, complete);
        for (const notify of listeners) notify();
      }).catch(() => {
        // Keep the last complete list on a permission, connection or pagination failure.
      }).finally(() => pending.delete(id));
      pending.set(id, read);
      return read;
    },
  };
}

// DesktopRoot provides a client bound to exactly one device. A late reply from
// a previously selected device only updates that device's own directory.
const directories = new WeakMap<Reader, ReturnType<typeof createDirectory>>();
export function badgeDirectoryFor(client: Reader) {
  let directory = directories.get(client);
  if (!directory) {
    directory = createDirectory(client);
    directories.set(client, directory);
  }
  return directory;
}

export function useBadgeJoinedGroups(client: Reader, ids: readonly AgentId[], connected: boolean, summaryOnly: boolean): GroupsByAgent {
  const directory = badgeDirectoryFor(client);
  const groups = useSyncExternalStore(directory.subscribe, directory.snapshot, directory.snapshot);
  const roster = JSON.stringify([...new Set(ids)].sort());
  useEffect(() => {
    if (!connected) return;
    const available = JSON.parse(roster) as AgentId[];
    let active = true;
    let reading = false;
    async function refreshVisible() {
      if (document.hidden || reading || !active) return;
      reading = true;
      try {
        // Limit simultaneous Feishu requests, especially for older daemons that also enrich each group.
        for (let i = 0; i < available.length && active && !document.hidden; i += 3) {
          await Promise.all(available.slice(i, i + 3).map(id => directory.refresh(id, summaryOnly)));
        }
      } finally { reading = false; }
    }
    void refreshVisible();
    const timer = window.setInterval(refreshVisible, freshness);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [connected, directory, roster, summaryOnly]);
  return groups;
}
