import {useCallback, useEffect, useMemo, useState} from 'react';
import type {AgentId, DesktopSnapshot, ProjectId} from '@vonvon/protocol';
import {useClient} from './client-context';
import {MemoryMap} from './MemoryMap';
import type {MapNode} from './MindMap';
import {AgentProfileSettings} from './settings/GroupDesignSettings';
import {useDraftGuard} from './settings/DraftGuard';
import {roleUsage} from './memory-model';

/** The role file's size for the two 角色设定 leaves; `undefined` while it loads or when an older daemon has no role section. */
function useRoleSizes(botId: AgentId) {
  const client = useClient();
  const [sizes, setSizes] = useState<{identity: number; notes: number}>();
  const reload = useCallback(async () => {
    try {
      const reply = await client.settings({type: 'read', scope: {kind: 'agent', botId}});
      const role = reply.kind === 'view' && 'administrators' in reply.view ? reply.view.sections.role?.stored : undefined;
      setSizes(role && {identity: Array.from(role.identity).length, notes: Array.from(role.notes).length});
    } catch {setSizes(undefined);}
  }, [client, botId]);
  useEffect(() => {void reload();}, [reload]);
  return {sizes, reload};
}

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
  const {navigate} = useDraftGuard();
  const agent = snapshot.agents.find(item => item.id === agentId);
  const [role, setRole] = useState(false);
  const {sizes, reload} = useRoleSizes(agentId);
  const projects = useMemo(() => (snapshot.projects ?? []).filter(project => project.bindings.some(binding => binding.agentId === agentId)), [snapshot.projects, agentId]);
  const counts = useProjectCounts(projects.map(project => project.id));
  const usage = roleUsage(sizes);
  const freshTotal = Object.values(counts).reduce((sum, count) => sum + count.fresh, 0);
  const before: MapNode[] = [{
    id: 'role', kind: 'section', label: '角色设定',
    children: usage.map(leaf => ({id: `role:${leaf.id}`, kind: 'leaf', label: leaf.label, meta: leaf.meta, selected: role, onClick: () => setRole(true)})),
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
    before={before} after={after} beforeLeafSelect={select => navigate(() => {setRole(false); select();})} onPanelClose={() => navigate(() => setRole(false))}
    panelKey={role ? 'bot-role' : undefined} panel={role ? <div className="memory-role-panel">
      <AgentProfileSettings botId={agentId} onSaved={() => void reload()}/>
      <p className="group-control-note">角色设定决定它是谁，在所有项目中生效；各群还可以单独设置本群角色。只有主人和管理员能改，Bot 改不了。</p>
    </div> : undefined}/>;
}
