import {useCallback, useEffect, useMemo, useState} from 'react';
import type {VonvonClient} from '@vonvon/client/browser';
import type {AgentId, DesktopSnapshot, GroupId, MemoryItem, SnapshotProject} from '@vonvon/protocol';
import {useClient} from './client-context';
import {Button} from './reference/components/ui';
import type {MapNode} from './MindMap';
import {branchViews, sourceLines, type MemoryList} from './memory-model';
import './inherited-content.css';

type Read<T> = {value: T; error?: never} | {value?: never; error: string};
type Role = {identity: string; notes: string; changed: boolean};
export type InheritedBot = {id: AgentId; name: string};
export type InheritedContent = {role: Read<Role>; memory: Read<MemoryList>};
export type InheritedDetail = {id: string; bot: InheritedBot; title: string; text: string; note?: string; item?: MemoryItem};
type Reader = Pick<VonvonClient, 'settings' | 'memory'>;
const failure = (error: unknown) => error instanceof Error ? error.message : '暂时读不到，请重试。';

/** A group view inherits from its selected Bot; the whole project lists each of its Bots once. */
export function inheritedBots(project: SnapshotProject, snapshot: DesktopSnapshot, selectedAgentId?: AgentId, selectedGroupId?: GroupId): InheritedBot[] {
  const ids = [...new Set(project.bindings.filter(binding => (!selectedAgentId || binding.agentId === selectedAgentId) && (!selectedGroupId || binding.groupId === selectedGroupId)).map(binding => binding.agentId))];
  return ids.map(id => ({id, name: snapshot.agents.find(agent => agent.id === id)?.name ?? id}));
}

/** Read only persisted role text, never the registration draft. Each source can fail independently. */
export async function readInheritedContent(client: Reader, botId: AgentId): Promise<InheritedContent> {
  const [role, memory] = await Promise.allSettled([
    client.settings({type: 'read', scope: {kind: 'agent', botId}}).then(reply => {
      if (reply.kind !== 'view' || reply.view.scope.kind !== 'agent' || reply.view.scope.botId !== botId || !('administrators' in reply.view)) throw new Error('角色设定暂时读不到。');
      const stored = reply.view.sections.role?.stored;
      if (!stored) throw new Error('这份角色设定暂不可用。');
      return {...stored, changed: reply.view.roleInfo?.integrity === 'changed'};
    }),
    client.memory({type: 'list', scope: {kind: 'bot', botId}}).then(reply => {
      if (reply.kind !== 'list') throw new Error('Bot 记忆暂时读不到。');
      return reply;
    }),
  ]);
  return {
    role: role.status === 'fulfilled' ? {value: role.value} : {error: failure(role.reason)},
    memory: memory.status === 'fulfilled' ? {value: memory.value} : {error: failure(memory.reason)},
  };
}

/** Mirrors context-assembly.currentOf for work sessions: archived, untrusted or unverified Bot entries are excluded. */
export function inheritedMemories(memory: MemoryList): {included: MemoryItem[]; excluded: MemoryItem[]} {
  const active = memory.items.filter(item => item.state === 'active');
  return {
    included: active.filter(item => item.trust === 'trusted' && memory.verified),
    excluded: active.filter(item => item.trust !== 'trusted' || !memory.verified),
  };
}

type NodeActions = {
  inspect: (detail: InheritedDetail) => void;
  isOpen: (id: string, initially: boolean) => boolean;
  toggle: (id: string) => void;
  selected?: string;
  retry?: () => void;
};
const preview = (text: string) => {const single = text.replace(/\s+/g, ' ').trim(); return [...single].length > 80 ? [...single].slice(0, 80).join('') + '…' : single;};
const exclusionNote = (item: MemoryItem, verified: boolean): string | undefined => item.trust !== 'trusted'
  ? '这条 Bot 记忆尚未确认，不会带入任务。请到 Bot 页处理。'
  : !verified ? 'Bot 记忆文件在应用之外改过，确认前不会带入任务。请到 Bot 页处理。' : undefined;

/** An open readonly detail follows refreshes; it must not keep showing a stale or newly archived entry. */
export function currentInheritedDetail(selected: InheritedDetail | undefined, content: InheritedContent | undefined): InheritedDetail | undefined {
  if (!selected || !content) return undefined;
  if (selected.item) {
    const memory = content.memory.value;
    const item = memory?.items.find(item => item.id === selected.item!.id && item.state === 'active');
    return item && memory ? {...selected, item, title: item.branch, text: item.text, note: exclusionNote(item, memory.verified)} : undefined;
  }
  const role = content.role.value;
  if (!role) return undefined;
  const text = selected.id.endsWith(':role:identity') ? role.identity : role.notes;
  return {...selected, text: text || '尚未填写。', note: role.changed ? '角色设定文件在应用之外改过，当前内容仍会带入任务。' : undefined};
}

/** These nodes deliberately have no menus, drag data, drop targets, or memory mutation callbacks. */
export function inheritedNodes(bot: InheritedBot, content: InheritedContent | undefined, actions: NodeActions): MapNode {
  const prefix = `inherited:${bot.id}`;
  const section = (id: string, label: string, children: MapNode[], initially = true, meta?: string): MapNode => ({
    id, kind: 'section', label, meta, children, open: actions.isOpen(id, initially), onToggle: () => actions.toggle(id),
  });
  const unavailable = (id: string, label: string): MapNode => ({id, kind: 'leaf', label, tone: 'muted', ...(actions.retry ? {meta: '重试', onClick: actions.retry} : {})});
  if (!content) return section(prefix, `来自 ${bot.name}`, [{id: `${prefix}:loading`, kind: 'leaf', label: '正在读取…'}], true, '只读');
  const leaf = (detail: Omit<InheritedDetail, 'bot'>, label: string, meta?: string): MapNode => ({
    id: detail.id, kind: 'leaf', label, meta, selected: actions.selected === detail.id, onClick: () => actions.inspect({...detail, bot}),
  });
  const role = content.role.value;
  const roleNodes = role ? ([['identity', '身份与职责'], ['notes', '其他说明']] as const).map(([key, title]) => {
    const text = role[key];
    return leaf({id: `${prefix}:role:${key}`, title, text: text || '尚未填写。', ...(role.changed ? {note: '角色设定文件在应用之外改过，当前内容仍会带入任务。'} : {})}, `${title}：${text.trim() ? preview(text) : '尚未填写'}`);
  }) : [unavailable(`${prefix}:role-error`, content.role.error)];
  const memory = content.memory.value;
  let memoryNodes: MapNode[];
  let count: number | undefined;
  if (!memory) memoryNodes = [unavailable(`${prefix}:memory-error`, content.memory.error)];
  else {
    const {included, excluded} = inheritedMemories(memory);
    count = included.length;
    memoryNodes = branchViews({...memory, items: included}).branches.filter(branch => branch.items.length).map(branch => {
      const id = `${prefix}:branch:${branch.name}`;
      const all = actions.isOpen(`${id}:more`, false);
      return section(id, branch.name, [
        ...branch.items.slice(0, all ? undefined : 8).map(item => leaf({id: `${prefix}:item:${item.id}`, title: item.branch, text: item.text, item}, item.text)),
        ...(!all && branch.items.length > 8 ? [{id: `${id}:more`, kind: 'more' as const, label: `还有 ${branch.items.length - 8} 条`, onClick: () => actions.toggle(`${id}:more`)}] : []),
      ], true, String(branch.items.length));
    });
    if (!included.length) memoryNodes.push({id: `${prefix}:empty`, kind: 'leaf', label: '暂无可继承的 Bot 记忆', tone: 'muted'});
    if (excluded.length) memoryNodes.push(section(`${prefix}:excluded`, '暂未带入', excluded.map(item => {
      const note = exclusionNote(item, memory.verified);
      return {...leaf({id: `${prefix}:excluded:${item.id}`, title: item.branch, text: item.text, item, note}, item.text, item.trust !== 'trusted' ? '待确认' : '文件待确认'), tone: 'pending' as const};
    }), false, String(excluded.length)));
    for (const [index, problem] of memory.problems.entries()) memoryNodes.push({id: `${prefix}:problem:${index}`, kind: 'leaf', label: problem, tone: 'muted'});
  }
  return section(prefix, `来自 ${bot.name}`, [
    section(`${prefix}:role`, '角色设定', roleNodes),
    section(`${prefix}:memory`, 'Bot 记忆', memoryNodes, true, count === undefined ? undefined : `${count} 条`),
  ], true, '只读');
}

export function useInheritedContent({project, snapshot, selectedAgentId, selectedGroupId, onBotProfile, beforeInspect}: {
  project: SnapshotProject; snapshot: DesktopSnapshot; selectedAgentId?: AgentId; selectedGroupId?: GroupId; onBotProfile?: (id: AgentId) => void; beforeInspect?: (inspect: () => void) => void;
}) {
  const client = useClient();
  const bots = useMemo(() => inheritedBots(project, snapshot, selectedAgentId, selectedGroupId), [project, snapshot, selectedAgentId, selectedGroupId]);
  const key = bots.map(bot => bot.id).join('|');
  const [result, setResult] = useState<{key: string; values: Record<string, InheritedContent>}>({key: '', values: {}});
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<InheritedDetail>();
  const close = useCallback(() => setSelected(undefined), []);
  useEffect(() => {setSelected(undefined); setOpen({});}, [key]);
  useEffect(() => {
    let active = true;
    let serial = 0;
    const refresh = async () => {
      const request = ++serial;
      const found = await Promise.all(bots.map(async bot => [bot.id, await readInheritedContent(client, bot.id)] as const));
      if (active && request === serial) setResult({key, values: Object.fromEntries(found)});
    };
    void refresh();
    // Like project memory, inherited memory can change without a desktop snapshot revision.
    const timer = window.setInterval(() => {if (document.visibilityState === 'visible') void refresh();}, 8_000);
    return () => {active = false; window.clearInterval(timer);};
    // The IDs identify the requests; names are rendered from the current snapshot below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, snapshot.revision, retry]);
  const nodes = bots.map(bot => inheritedNodes(bot, result.key === key ? result.values[bot.id] : undefined, {
    inspect: detail => {const inspect = () => setSelected(detail); if (beforeInspect) beforeInspect(inspect); else inspect();}, selected: selected?.id, isOpen: (id, initially) => open[id] ?? initially,
    toggle: id => setOpen(current => ({...current, [id]: !(current[id] ?? (id.endsWith(':excluded') || id.endsWith(':more') ? false : true))})),
    retry: () => setRetry(value => value + 1),
  }));
  const current = selected && bots.find(bot => bot.id === selected.bot.id);
  const detail = current && result.key === key ? currentInheritedDetail(selected, result.values[current.id]) : undefined;
  const lines = detail?.item ? sourceLines(detail.item, {bot: id => snapshot.agents.find(agent => agent.id === id)?.name ?? 'Bot', group: id => snapshot.groups.find(group => group.id === id)?.name ?? '一个群'}) : [];
  const panel = detail && current ? <div className="inherited-detail">
    <h3>{detail.title}</h3>
    <p className="group-control-note">来自 {current.name} · 只读</p>
    <p className="inherited-detail-text">{detail.text}</p>
    {detail.note && <p className="group-control-note">{detail.note}</p>}
    {lines.length > 0 && <ul className="memory-source">{lines.map(line => <li key={line}>{line}</li>)}</ul>}
    <p className="group-control-note">这份内容由 Bot 统一设置，在项目里只能查看。</p>
    {onBotProfile && <Button size="sm" onClick={() => onBotProfile(current.id)}>到 Bot 页修改</Button>}
  </div> : undefined;
  return {nodes, panel, close, selectedId: detail?.id};
}
