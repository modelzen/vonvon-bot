import {useEffect, useMemo, useState} from 'react';
import type {VonvonClient} from '@vonvon/client/browser';
import {groupIdentitySchema, groupIdSchema, type AgentId, type DesktopSnapshot} from '@vonvon/protocol';

export function useRecipeGroupIdentity({client, scope, snapshot, botId, groupId, enabled}: {
  client: VonvonClient; scope: object; snapshot?: DesktopSnapshot; botId?: AgentId; groupId?: string; enabled: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const agent = snapshot?.agents.find(item => item.id === botId);
  const binding = snapshot?.memberships.find(item => item.agentId === botId && item.groupId === groupId);
  const fingerprint = JSON.stringify([agent?.registeredAt, agent?.tenant, agent?.enabled, agent?.running, agent?.connection, agent?.activation, binding]);
  const source = useMemo(() => ({client, scope, botId, groupId, fingerprint, attempt, enabled}), [client, scope, botId, groupId, fingerprint, attempt, enabled]);
  const [read, setRead] = useState<{source: typeof source; name?: string; error?: string}>();
  const result = read?.source === source ? read : undefined;
  useEffect(() => {
    if (!enabled || !botId || !groupId) return;
    let active = true;
    void client.run({type: 'readGroupIdentity', agentId: botId, groupId: groupIdSchema.parse(groupId)}).then(reply => {
      const identity = groupIdentitySchema.parse(reply);
      if (identity.agentId !== botId || identity.groupId !== groupId) throw new Error('群名响应与原目标不一致，请重新核对。');
      if (active) setRead({source, name: identity.name});
    }).catch(() => {
      if (active) setRead({source, error: '暂时无法读取飞书群名。输入已保留，请刷新群名后再确认。'});
    });
    return () => {active = false;};
  }, [client, source, enabled, botId, groupId]);
  return {name: result?.name, error: result?.error, refresh: () => setAttempt(value => value + 1)};
}
