import {useEffect, useMemo, useState} from 'react';
import type {AgentId, DesktopSnapshot, ProjectId} from '@vonvon/protocol';
import {useClient} from './client-context';
import {MemoryMap} from './MemoryMap';
import type {MapNode} from './MindMap';
import {roleUsage} from './memory-model';
import {useRoleMap} from './role-map';

const preview = (value: string) => {const line = value.replace(/\s+/g, ' ').trim(); return [...line].length > 80 ? [...line].slice(0, 80).join('') + '…' : line || '尚未填写';};

/** Each project's active entry count and how many are new, for the 项目 node; a project that cannot be read shows no count. */
function useProjectCounts(ids: readonly ProjectId[]) {
  const client = useClient();
  const [counts, setCounts] = useState<Record<string, {used: number; fresh: number}>>({});
  const key = ids.join('|');
  useEffect(() => {
    let live = true;
    void Promise.all(ids.map(async projectId => {
      try {const reply = await client.memory({type: 'list', scope: {kind: 'project', projectId}}); return reply.kind === 'list' ? [projectId, {used: reply.used, fresh: reply.newIds?.length ?? 0}] as const : undefined;}
      catch {return undefined;}
    })).then(found => {if (live) setCounts(Object.fromEntries(found.flatMap(entry => entry ? [entry] : [])));});
    return () => {live = false;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  return counts;
}

type Props = {agentId: AgentId; snapshot: DesktopSnapshot; onProject: (id: ProjectId) => void};
/** The Bot page's 导图 (§5.2): the Bot in the middle, 角色设定, Bot 记忆 and the projects it works in. */
export function BotMap({agentId, snapshot, onProject}: Props) {
  const agent = snapshot.agents.find(item => item.id === agentId);
  const role = useRoleMap({kind: 'agent', botId: agentId});
  const [selectedRole, setSelectedRole] = useState<'identity' | 'notes'>();
  const projects = useMemo(() => (snapshot.projects ?? []).filter(project => project.bindings.some(binding => binding.agentId === agentId)), [snapshot.projects, agentId]);
  const counts = useProjectCounts(projects.map(project => project.id));
  const usage = roleUsage(role.role ? {identity: [...(role.role.fields.identity ?? '')].length, notes: [...(role.role.fields.notes ?? '')].length} : undefined);
  const freshTotal = Object.values(counts).reduce((sum, count) => sum + count.fresh, 0);
  const before: MapNode[] = [{
    id: 'role', kind: 'section', label: '角色设定',
    children: [...usage.map(leaf => ({id: `role:${leaf.id}`, kind: 'leaf' as const,
      label: `${leaf.label}：${preview(role.role?.fields[leaf.id] ?? '')}`, meta: leaf.meta,
      selected: selectedRole === leaf.id, onClick: () => setSelectedRole(leaf.id),
      content: role.content(leaf.id, `role:${leaf.id}`),
      ...(selectedRole === leaf.id && role.role && role.editing?.field !== leaf.id ? {children: [{id: `role:${leaf.id}:full`, kind: 'leaf' as const, label: role.role.fields[leaf.id] || '尚未填写'}]} : {}),
      ...(role.role && !role.role.readonly ? {onEdit: (start?: import('./MindMap').MapEditStart) => role.beginEdit(leaf.id, start)} : {}),
    })), ...role.statusNodes],
  }];
  const after: MapNode[] = [{
    id: 'projects', kind: 'section', label: '项目', meta: `${projects.length}${freshTotal ? ` · 新 ${freshTotal}` : ''}`,
    children: projects.map(project => ({
      id: `p:${project.id}`, kind: 'branch', label: `${project.name} →`, onClick: () => onProject(project.id),
      meta: counts[project.id] === undefined ? undefined : `${counts[project.id]!.used} 条${counts[project.id]!.fresh ? ` · 新 ${counts[project.id]!.fresh}` : ''}`,
      ...(counts[project.id]?.fresh ? {fresh: true} : {}),
    })),
  }];
  const targets = useMemo(() => ({
    projects: (snapshot.projects ?? []).filter(project => project.bindings.some(binding => binding.agentId === agentId)),
    botName: (id: string) => snapshot.agents.find(item => item.id === id)?.name ?? '这个 Bot',
    groupName: (chatId: string) => snapshot.groups.find(group => group.id === chatId)?.name ?? '一个群',
  }), [snapshot, agentId]);
  return <MemoryMap scope={{kind: 'bot', botId: agentId}} rootLabel={agent?.name ?? 'Bot'} mode="wrapped" memoryLabel="Bot 记忆" targets={targets}
    before={before} after={after} beforeInteraction={role.withSavedDraft} beforeLeafSelect={select => {setSelectedRole(undefined); select();}}/>;
}
