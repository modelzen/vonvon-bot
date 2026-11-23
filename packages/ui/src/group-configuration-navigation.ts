import {useEffect, useRef, useState} from 'react';
import type {DesktopSnapshot, GroupConfigurationLocator, GroupConfigurationNavigation, GroupNavigationShell} from '@vonvon/protocol';
import type {CollaborationRoute} from './collaboration-navigation';
import {useDraftGuard} from './settings/DraftGuard';

type GroupConfigurationDestination =
  | {kind: 'available'; route: Extract<CollaborationRoute, {kind: 'membership'}>}
  | {kind: 'unavailable'; message: string};

export function groupConfigurationDestination(snapshot: DesktopSnapshot, target: GroupConfigurationLocator): GroupConfigurationDestination {
  if (snapshot.host.kind !== 'connected' || snapshot.stale) return {kind: 'unavailable', message: '当前设备尚未连接后台。请先在「设备」中连接运行这个 Bot 的设备，再重新打开群配置链接。'};
  const agent = snapshot.agents.find(item => item.id === target.botAppId);
  if (!agent || agent.readError) return {kind: 'unavailable', message: '当前设备没有可读取的这个 Bot。请在「设备」中选择运行它的设备，或先在 Bot 列表添加这个 Bot，再重新打开链接。'};
  const members = snapshot.memberships.filter(item => item.agentId === agent.id && item.groupId === target.groupId);
  const member = members.length === 1 ? members[0] : undefined;
  if (!member || member.stale || !snapshot.groups.some(item => item.id === target.groupId)) return {kind: 'unavailable', message: '当前设备尚未添加这个 Bot 在该群的配置。请打开这个 Bot 的聊天列表，添加或重新读取对应飞书群，再重新打开链接。'};
  return {kind: 'available', route: {kind: 'membership', id: member.id, pane: {kind: 'settings'}, parent: {kind: 'agent', id: agent.id, pane: {kind: 'groups'}}}};
}

/** Keep launches until a snapshot exists, then leave drafts through the normal navigation guard. */
export function useGroupConfigurationNavigation(options: {
  shell?: GroupNavigationShell;
  snapshot?: DesktopSnapshot;
  open(destination: GroupConfigurationDestination): void;
}): void {
  const {navigate} = useDraftGuard();
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef<GroupConfigurationNavigation | undefined>(undefined);
  const inFlight = useRef(false);
  const active = useRef(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const shell = options.shell;
    if (!shell) return;
    active.current = true;
    let subscribed = true;
    let receivedLive = false;
    const seen = new Set<string>();
    const acknowledge = (id: string) => {void shell.acknowledge(id).catch(() => {});};
    const receive = (navigation: GroupConfigurationNavigation) => {
      if (!subscribed || seen.has(navigation.navigationId)) return;
      seen.add(navigation.navigationId);
      if (pending.current) acknowledge(pending.current.navigationId);
      pending.current = navigation;
      setRevision(value => value + 1);
    };
    const unsubscribe = shell.onOpen(value => {receivedLive = true; receive(value);});
    void shell.pending().then(queue => {
      if (!subscribed) return;
      if (!receivedLive) queue.forEach(receive);
      else for (const navigation of queue) if (!seen.has(navigation.navigationId)) acknowledge(navigation.navigationId);
    }).catch(() => {});
    return () => {subscribed = false; active.current = false; pending.current = undefined; inFlight.current = false; unsubscribe();};
  }, [options.shell]);
  useEffect(() => {
    if (!options.snapshot || options.snapshot.host.kind === 'starting' || !pending.current || inFlight.current) return;
    inFlight.current = true;
    const finish = (open: boolean) => {
      if (!active.current) return;
      const navigation = pending.current;
      const {snapshot, shell} = latest.current;
      pending.current = undefined;
      inFlight.current = false;
      if (!navigation || !snapshot) return;
      if (open) latest.current.open(groupConfigurationDestination(snapshot, navigation));
      void shell?.acknowledge(navigation.navigationId).catch(() => {});
    };
    if (!navigate(() => finish(true), () => finish(false))) finish(false);
  }, [options.snapshot, revision, navigate]);
}
