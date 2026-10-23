import {useCallback, useEffect, useMemo, useState} from 'react';
import type {AgentId, DesktopSnapshot, ProjectId} from '@vonvon/protocol';
import {useClient} from './client-context';
import {Button} from './reference/components/ui';
import {MemoryMap} from './MemoryMap';
import type {MapNode} from './MindMap';
import {AgentProfileSettings} from './settings/GroupDesignSettings';
import {roleUsage} from './memory-model';
import {ContextPanel} from './ContextPanel';
import {Dialog} from './reference/components/ui/Dialog';

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
  const agent = snapshot.agents.find(item => item.id === agentId);
  const [role, setRole] = useState(false);
  const [context, setContext] = useState<ProjectId>();
  const {sizes, reload} = useRoleSizes(agentId);
  const projects = useMemo(() => (snapshot.projects ?? []).filter(project => project.bindings.some(binding => binding.agentId === agentId)), [snapshot.projects, agentId]);
  const counts = useProjectCounts(projects.map(project => project.id));
  const usage = roleUsage(sizes);
  const freshTotal = Object.values(counts).reduce((sum, count) => sum + count.fresh, 0);
  const contextProject = projects.find(project => project.id === context);
  const contextBinding = contextProject?.bindings.find(binding => binding.agentId === agentId);
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
      menu: [{id: 'context', label: '模型看到什么', onSelect: () => setContext(project.id)}],
    })),
  }];
  const targets = useMemo(() => ({
    projects: (snapshot.projects ?? []).filter(project => project.bindings.some(binding => binding.agentId === agentId)),
    botName: (id: string) => snapshot.agents.find(item => item.id === id)?.name ?? '这个 Bot',
    groupName: (chatId: string) => snapshot.groups.find(group => group.id === chatId)?.name ?? '一个群',
  }), [snapshot, agentId]);
  return <><MemoryMap scope={{kind: 'bot', botId: agentId}} rootLabel={agent?.name ?? 'Bot'} mode="wrapped" memoryLabel="Bot 记忆" targets={targets}
    note="只放跨项目的“怎么跟你和团队合作”。群友说的、Bot 自己观察到的永远进不了这里。"
    empty="还没有。你或管理员在群里手打的跨项目要求会记到这里；也可以直接添加。"
    before={before} after={after} onLeafSelected={() => setRole(false)}
    panel={role ? <div className="memory-role-panel">
      <AgentProfileSettings botId={agentId} onSaved={() => void reload()}/>
      <p className="group-control-note">角色设定＝它是谁，所有项目都带；每个项目里的“补充职责”＝它在那个项目里多做什么。只有主人和管理员能改，Bot 改不了。</p>
    </div> : undefined}/>
    {contextProject && contextBinding && <Dialog open title="模型看到什么" onClose={() => setContext(undefined)} footer={<Button onClick={() => setContext(undefined)}>关闭</Button>}>
      <ContextPanel agentId={agentId} groupId={contextBinding.groupId} projectId={contextProject.id} revision={snapshot.revision}
        title={`${agent?.name ?? 'Bot'} · ${snapshot.groups.find(group => group.id === contextBinding.groupId)?.name ?? '一个群'}`}
        go={{projectMemory: () => {setContext(undefined); onProject(contextProject.id);}}}/>
    </Dialog>}</>;
}