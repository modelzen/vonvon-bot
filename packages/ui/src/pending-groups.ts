import {useClient} from './client-context';
import {useEffect, useRef, useState} from 'react';
import type {AgentId, DesktopSnapshot, PendingGroup} from '@vonvon/protocol';

export type PendingAgentGroups = {
  agentId: AgentId;
  groups: PendingGroup[];
  problem?: {kind: 'unsupported' | 'failed'; message: string};
};

export function usePendingGroups(snapshot: DesktopSnapshot | undefined) {
  const client = useClient();
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const [pages, setPages] = useState<PendingAgentGroups[]>([]);
  const scope = JSON.stringify(snapshot?.host.kind === 'connected' && !snapshot.stale
    ? [snapshot.host, snapshot.agents.filter(agent => agent.enabled && agent.activation === 'active' && !agent.readError && agent.connection === 'connected').map(agent => agent.id).sort()]
    : null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setPages([]);
    async function poll() {
      const current = latest.current;
      if (!current || current.host.kind !== 'connected' || current.stale) return;
      const agents = current.agents.filter(agent => agent.enabled && agent.activation === 'active' && !agent.readError && agent.connection === 'connected');
      for (const agent of agents) {
        if (!active) return;
        let page: PendingAgentGroups;
        try {
          const reply = await client.run({type: 'listPendingGroups', agentId: agent.id});
          page = reply.kind === 'pendingGroups'
            ? {agentId: agent.id, groups: reply.groups}
            : {agentId: agent.id, groups: [], problem: {kind: reply.kind === 'refused' && reply.code === 'unsupported' ? 'unsupported' : 'failed', message: 'message' in reply ? reply.message : '无法读取待绑定的飞书群，请稍后重试。'}};
        } catch (error) {
          page = {agentId: agent.id, groups: [], problem: {kind: 'failed', message: error instanceof Error ? error.message : '无法读取待绑定的飞书群。'}};
        }
        if (active) setPages(previous => [...previous.filter(item => item.agentId !== agent.id), {...page, groups: page.problem?.kind === 'failed' ? previous.find(item => item.agentId === agent.id)?.groups ?? [] : page.groups}]);
      }
      if (active) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {active = false; clearTimeout(timer);};
  }, [scope, client]);
  if (!snapshot || snapshot.host.kind !== 'connected' || snapshot.stale) return [];
  return pages.filter(page => snapshot.agents.some(agent => agent.id === page.agentId && agent.enabled && agent.activation === 'active' && agent.connection === 'connected' && !agent.readError)).map(page => ({...page, groups: page.groups.filter(group => !snapshot?.memberships.some(member => member.agentId === page.agentId && member.groupId === group.chatId))}));
}
