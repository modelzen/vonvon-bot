import {useEffect, useState, type RefObject} from 'react';
import type {MemoryEvent, MemoryItem, MemoryRequest, MemoryScopeRef} from '@vonvon/protocol';
import {useClient, useShellCapabilities} from './client-context';
import {MapInlineEditor, type MapInlineEditorSession} from './MapInlineEditor';
import type {MapNode} from './MindMap';
import {branchNameProblem, branchRoom, memoryScopeKey, mergeTargets, moveRequest, runMemory, sourceLines, type BranchView} from './memory-model';
import {groupUrl, openExternalUrl} from './url-actions';

type Scope = MemoryScopeRef;
type Targets = {
  bots?: ReadonlyArray<{id: string; name: string}>;
  projects?: ReadonlyArray<{id: string; name: string; bindings: ReadonlyArray<{agentId: string; groupId: string}>}>;
  botName: (id: string) => string;
  groupName: (chatId: string) => string;
};

export type MemoryMapAction = {kind: 'merge'; branch: string} | {kind: 'move-branch' | 'to-bot' | 'to-project' | 'trust' | 'purge'; item: MemoryItem};
export type MemoryDetailNodeOptions = {
  action?: MemoryMapAction;
  detailItem?: MemoryItem;
  closeAction: () => void;
  closeDetails: () => void;
  scope: Scope;
  views: readonly BranchView[];
  targets: Targets;
  version?: string;
  projectFor: (item: MemoryItem) => string | undefined;
  act: (request: MemoryRequest, done?: string) => Promise<boolean>;
  busy: boolean;
  editorSession?: RefObject<MapInlineEditorSession | null>;
  onProblem?: (message: string) => void;
};

const eventLabel: Record<MemoryEvent['kind'], string> = {
  add: '新增', edit: '修改', archive: '删除', restore: '恢复', promote: '移到 Bot 记忆', move: '移回项目', confirm: '点成可信', purge: '彻底删除',
  branch_rename: '分类改名', branch_merge: '分类合并', branch_unmerge: '撤销合并',
};
const undoable = new Set<MemoryEvent['kind']>(['edit', 'archive', 'restore', 'promote', 'move', 'confirm']);
const node = (id: string, label: string, onClick?: () => void, kind: MapNode['kind'] = 'leaf'): MapNode => ({id, kind, label, ...(onClick ? {onClick} : {})});

/** A typed category name may name an existing target; only a genuinely new name consumes a branch slot. */
export function typedBranchMove(scope: Scope, item: MemoryItem, views: readonly BranchView[], name: string):
  {request: MemoryRequest; target: string} | {problem: string} {
  const existing = views.find(view => view.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  const target = existing?.name ?? name.trim();
  if (!existing) {
    const problem = branchNameProblem(name, views);
    if (problem || !branchRoom(views)) return {problem: problem ?? '分类已满 12 支，放不下新分类。'};
  }
  const request = moveRequest(scope, item, target);
  return request ? {request, target} : {problem: '这条记忆已经在这个分类。'};
}

/** The detail and action branches are ordinary map nodes; every mutation still goes through the revision-checked memory RPC. */
export function useMemoryDetailNodes({action, detailItem, closeAction, closeDetails, scope, views, targets, version, projectFor, act, busy, editorSession, onProblem}: MemoryDetailNodeOptions): {actionNodes: MapNode[]; detailNodes: MapNode[]} {
  const client = useClient();
  const shell = useShellCapabilities();
  const [events, setEvents] = useState<MemoryEvent[]>();
  const [eventProblem, setEventProblem] = useState('');
  const [sourceProblem, setSourceProblem] = useState('');
  const [newBranch, setNewBranch] = useState(false);
  const scopeKey = memoryScopeKey(scope);
  const actionKey = action?.kind === 'merge' ? `merge:${action.branch}` : action ? `${action.kind}:${action.item.id}` : '';

  useEffect(() => {setNewBranch(false);}, [actionKey]);
  useEffect(() => {setSourceProblem('');}, [detailItem?.id]);
  useEffect(() => {
    if (!detailItem) {setEvents(undefined); setEventProblem(''); return;}
    let live = true;
    setEvents(undefined); setEventProblem('');
    void runMemory(client, {type: 'events', scope, itemId: detailItem.id}).then(outcome => {
      if (!live) return;
      if (outcome.ok && outcome.reply.kind === 'events') setEvents(outcome.reply.events);
      else {setEvents([]); setEventProblem(outcome.ok ? '历史暂时读不到。' : outcome.message);}
    });
    return () => {live = false;};
    // The scope object is recreated by the page; its identity is not a data change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, scopeKey, detailItem?.id, detailItem?.revision, version]);

  const run = (request: MemoryRequest, done: string) => {
    if (busy) return;
    void act(request, done).then(ok => {if (ok) closeAction();});
  };
  const option = (id: string, label: string, request: MemoryRequest, done: string): MapNode =>
    node(`memory-action:${id}`, label, busy ? undefined : () => run(request, done), 'action');
  const cancel = node('memory-action:cancel', '取消', busy ? undefined : closeAction, 'action');
  let actionNodes: MapNode[] = [];

  if (action?.kind === 'merge') {
    const from = views.find(view => view.name === action.branch);
    const targets = from && !from.fixed ? mergeTargets(views, action.branch) : [];
    actionNodes = [{id: 'memory-action:merge', kind: 'section', label: `合并「${action.branch}」到…`, children: [
      node('memory-action:merge-note', '这支的条目会全部挪过去；合并可整批撤销。'),
      ...targets.map(name => option(`merge:${name}`, name, {type: 'branchMerge', scope, from: action.branch, into: name}, '已合并。')),
      ...(!targets.length ? [node('memory-action:merge-empty', '没有可合并的分类。')] : []), cancel,
    ]}];
  } else if (action?.kind === 'move-branch') {
    const item = action.item;
    const choices = views.filter(view => view.name !== item.branch);
    const saveNewBranch = async (name: string): Promise<boolean> => {
      const resolved = typedBranchMove(scope, item, views, name);
      if ('problem' in resolved) {onProblem?.(resolved.problem); return false;}
      const {request, target} = resolved;
      const ok = await act(request, `已移到「${target}」。`);
      if (ok) closeAction();
      return ok;
    };
    actionNodes = [{id: 'memory-action:move-branch', kind: 'section', label: '移到分类…', children: [
      ...choices.map(view => option(`branch:${view.name}`, view.name, {type: 'edit', scope, itemId: item.id, revision: item.revision, branch: view.name}, `已移到「${view.name}」。`)),
      {id: 'memory-action:new-branch', kind: 'action', label: '新分类…', ...(newBranch ? {content: <span>
        <MapInlineEditor key={`move:${item.id}`} session={editorSession} value="" label="新分类名" busy={busy} cancelWhenEmpty onCancel={() => setNewBranch(false)} onCommit={saveNewBranch}/>
        <button type="button" tabIndex={-1} disabled={busy} aria-label="取消新分类" onPointerDown={event => event.preventDefault()} onClick={event => {event.stopPropagation(); setNewBranch(false);}}>取消</button>
      </span>} : {onClick: () => {if (!busy) setNewBranch(true);}})},
      ...(!newBranch ? [cancel] : []),
    ]}];
  } else if (action?.kind === 'to-bot') {
    const item = action.item;
    actionNodes = [{id: 'memory-action:to-bot', kind: 'section', label: '移到 Bot 记忆', children: [
      node('memory-action:to-bot-note', '这条会带进所选 Bot 的所有项目。群友的话建议先改写成对你自己的要求。'),
      ...(targets.bots ?? []).map(bot => option(`bot:${bot.id}`, bot.name, {type: 'promote', scope, itemId: item.id, revision: item.revision, botId: bot.id}, '已移到 Bot 记忆。')),
      ...(!targets.bots?.length ? [node('memory-action:no-bot', '没有可选的 Bot。')] : []), cancel,
    ]}];
  } else if (action?.kind === 'to-project') {
    const item = action.item;
    const preferred = projectFor(item);
    const projects = [...(targets.projects ?? [])].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
    actionNodes = [{id: 'memory-action:to-project', kind: 'section', label: '移回项目', children: [
      node('memory-action:to-project-note', '移过去以后，所选项目里所有群的 Bot 都会读到这条；其他项目不再带它。'),
      ...projects.map(project => option(`project:${project.id}`, project.name, {type: 'move', scope, itemId: item.id, revision: item.revision, to: {projectId: project.id}}, `已移到项目「${project.name}」。`)),
      ...(!projects.length ? [node('memory-action:no-project', '没有可选的项目。')] : []), cancel,
    ]}];
  } else if (action?.kind === 'trust') {
    const item = action.item;
    actionNodes = [{id: 'memory-action:trust', kind: 'section', label: '点成可信', children: [
      node('memory-action:trust-note', '点成可信以后，项目里所有群的 Bot 都会把它当可信记忆读到，也会发给决策模型。'),
      option('trust-confirm', '确认点成可信', {type: 'confirm', scope, itemId: item.id, revision: item.revision}, '已点成可信。'), cancel,
    ]}];
  } else if (action?.kind === 'purge') {
    const item = action.item;
    actionNodes = [{id: 'memory-action:purge', kind: 'section', label: '彻底删除', children: [
      node('memory-action:purge-note', '彻底删除以后不能恢复，也不能撤销。'),
      option('purge-confirm', '确认彻底删除', {type: 'purge', scope, itemId: item.id}, '已彻底删除。'), cancel,
    ]}];
  }

  let detailNodes: MapNode[] = [];
  if (detailItem) {
    const item = detailItem;
    const lines = sourceLines(item, {bot: targets.botName, group: targets.groupName});
    const newest = events?.at(-1);
    const history = events === undefined ? [node('memory-detail:loading', '正在读取历史…')]
      : events.length ? events.map(event => ({...node(`memory-detail:event:${event.eventId}`, eventLabel[event.kind]), meta: new Date(event.at).toLocaleString(),
        ...(event === newest && undoable.has(event.kind) && !event.undoOf ? {children: [option(`undo:${event.eventId}`, '撤销这次修改', {type: 'undo', scope, eventId: event.eventId}, '已撤销。')]} : {})}))
        : [node('memory-detail:no-events', '没有修改记录。')];
    detailNodes = [{id: `memory-detail:${item.id}`, kind: 'section', label: '详情与历史', children: [
      node('memory-detail:summary', `${item.branch}${item.state === 'archived' ? ' · 已归档' : ''} · 版本 ${item.revision}`),
      {id: 'memory-detail:source', kind: 'section', label: '来源', children: [
        ...lines.map((line, at) => node(`memory-detail:source:${at}`, line)),
        ...(item.source.chatId ? [node('memory-detail:source-link', '打开来源群 ↗', () => {void openExternalUrl(groupUrl(item.source.chatId!), 'group', shell).catch(error => setSourceProblem(error instanceof Error ? error.message : '来源暂时打不开。'));}, 'action')]
          : item.source.via !== 'ui' ? [node('memory-detail:no-source', '没有来源消息。')] : []),
        ...(sourceProblem ? [node('memory-detail:source-error', sourceProblem)] : []),
      ]},
      {id: 'memory-detail:history', kind: 'section', label: '历史', children: [...(eventProblem ? [node('memory-detail:event-error', eventProblem)] : []), ...history]},
      node('memory-detail:close', '收起详情', closeDetails, 'action'),
    ]}];
  }
  return {actionNodes, detailNodes};
}
