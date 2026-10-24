import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {MemoryItem, MemoryScopeRef} from '@vonvon/protocol';
import {useClient} from './client-context';
import {MindMap, type MapEditStart, type MapMenuItem, type MapNode} from './MindMap';
import {MapInlineEditor, type MapInlineEditorSession} from './MapInlineEditor';
import {
  archiveBranchItems, branchCanChange, branchNameProblem, branchNewCount, branchRoom, branchViews, exportFileName, joinMarks, leafActions, marksOf, moveRequest, noMarks, runMemory, sameJson, searchPlan, sourceProject,
  type BranchView, type LeafAction, type Marks, type MemoryList,
} from './memory-model';
import {memoryNodes} from './memory-nodes';
import {useMemoryDetailNodes, type MemoryMapAction} from './memory-detail-nodes';
import {useInlineDraft} from './settings/DraftGuard';
import './mind-map.css';

type Scope = Extract<MemoryScopeRef, {kind: 'project' | 'bot'}>;
export type MemoryTargets = {
  /** Bots a project entry can be moved into (a project with several asks which). */
  bots?: ReadonlyArray<{id: string; name: string}>;
  /** The projects a Bot entry can go back to, with the bindings that say which one its source group is in. */
  projects?: ReadonlyArray<{id: string; name: string; bindings: ReadonlyArray<{agentId: string; groupId: string}>}>;
  botName: (id: string) => string;
  groupName: (chatId: string) => string;
};
type Props = {
  scope: Scope;
  /** The Bot a Bot memory belongs to; for a project, the Bot an entry's source says wrote it is looked up by `targets.botName`. */
  rootLabel: string;
  /** `wrapped`: one 「Bot 记忆」 node holds the branches (Bot page). `direct`: the branches hang on the root (project page). */
  mode: 'wrapped' | 'direct';
  memoryLabel: string;
  targets: MemoryTargets;
  /** Nodes drawn before and after the memory, which the page owns (角色设定, 项目, 群和 Bot). */
  before?: MapNode[];
  after?: MapNode[];
  onLeafSelected?: () => void;
  beforeInteraction?: (action: () => void) => void;
  beforeLeafSelect?: (select: () => void) => void;
};
/** Fired on `window` when a page has marked itself seen, so the counts on the navigation and the lists are read again (§5.8). */
export const MEMORY_SEEN_EVENT = 'vonvon:memory-seen';
const failText = (error: unknown) => error instanceof Error ? error.message : '暂时读不到，请重试。';

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], {type: 'text/markdown'}));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  URL.revokeObjectURL(url);
}

/** One memory (a Bot's or a project's) as a mind map with all editing, feedback and detail actions inside its nodes (§5.7). */
export function MemoryMap({scope, rootLabel, mode, memoryLabel, targets, before = [], after = [], onLeafSelected, beforeLeafSelect, beforeInteraction}: Props) {
  const client = useClient();
  const scopeKey = scope.kind === 'bot' ? `bot:${scope.botId}` : `project:${scope.projectId}`;
  const [list, setList] = useState<MemoryList>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string>();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [editing, setEditing] = useState<{kind: 'leaf'; id: string; text: string; revision: number; point?: MapEditStart['point']} | {kind: 'branch'; name: string; text: string; point?: MapEditStart['point']}>();
  const [adding, setAdding] = useState<{phase: 'branch' | 'text'; branch: string; origin: 'root' | 'branch'}>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const [action, setAction] = useState<MemoryMapAction>();
  const [searching, setSearching] = useState(false);
  const [marks, setMarks] = useState<Marks>(noMarks);
  const listCache = useRef<{scopeKey: string; value?: MemoryList}>({scopeKey});
  const serial = useRef(0);
  const draftOpen = useRef(false);
  const editorSession = useRef<MapInlineEditorSession | null>(null);
  const switching = useRef(false);
  const savedSession = useRef<MapInlineEditorSession | null>(null);
  useInlineDraft(Boolean(editing || adding), async () => {
    const current = editorSession.current;
    if (!current) return !editing && !adding;
    const ok = await current.commit();
    if (!ok) editorSession.current?.focus();
    return ok;
  });
  draftOpen.current = Boolean(editing || adding || action);
  /** The page is marked seen once per opening, after the first reading has shown what is new (§5.8). */
  const seenSent = useRef('');
  const reload = useCallback(async (force = false) => {
    if (draftOpen.current && !force) return;
    const request = ++serial.current;
    try {
      const reply = await client.memory({type: 'list', scope});
      if (request !== serial.current) return;
      if (reply.kind !== 'list') throw new Error('记忆暂时读不到。');
      if (draftOpen.current && !force) return;
      const cached = listCache.current;
      if (cached.scopeKey !== scopeKey || !sameJson(cached.value, reply)) {
        listCache.current = {scopeKey, value: reply};
        setList(reply);
        // The first reading's marks stay while the page is open; later ones join only if the reply changed.
        setMarks(current => joinMarks(current, marksOf(reply)));
      }
      setError(undefined);
      if (seenSent.current !== scopeKey) {
        seenSent.current = scopeKey;
        const page = scope.kind === 'bot' ? {kind: 'bot' as const, botId: scope.botId} : {kind: 'project' as const, projectId: scope.projectId};
        void client.memory({type: 'seen', page}).then(() => window.dispatchEvent(new Event(MEMORY_SEEN_EVENT))).catch(() => undefined);
      }
    } catch (failure) {if (request === serial.current) setError(failText(failure));}
    // `scope` is rebuilt by the parent every render; its key is what says the memory changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, scopeKey]);
  useEffect(() => {listCache.current = {scopeKey}; setList(undefined); setMarks(noMarks); setSelected(undefined); setEditing(undefined); setAdding(undefined); setDetailsOpen(false); setAction(undefined); setSearching(false); setQuery(''); void reload(true); return () => {serial.current++;};}, [reload, scopeKey]);
  // What the bot writes does not change the snapshot: look again while the page is open, so a new leaf shows up marked 新.
  useEffect(() => {
    const timer = window.setInterval(() => {if (document.visibilityState === 'visible') void reload();}, 8_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const views = useMemo(() => list ? branchViews(list) : {branches: [], archived: []}, [list]);
  const plan = useMemo(() => searchPlan([...views.branches, ...views.archived], query), [views, query]);
  const items = useMemo(() => new Map((list?.items ?? []).map(item => [item.id, item])), [list]);
  const withSavedDraft = (action: () => void) => {
    const session = editorSession.current;
    if (!session) {savedSession.current = null; action(); return;}
    if (savedSession.current === session) {action(); return;}
    if (switching.current) return;
    switching.current = true;
    void session.commit().then(ok => {
      if (ok) {savedSession.current = session; switching.current = false; action();}
      else editorSession.current?.focus();
    }).catch(error => {
      setNotice(failText(error));
      editorSession.current?.focus();
    }).finally(() => {switching.current = false;});
  };
  const rawFlip = (id: string) => setFlipped(current => {const next = new Set(current); if (!next.delete(id)) next.add(id); return next;});
  const flip = (id: string) => withSavedDraft(() => rawFlip(id));
  const isOpen = (id: string, initially: boolean) => flipped.has(id) ? !initially : initially;

  async function act(request: Parameters<typeof runMemory>[1], done = '', onItem?: (item: MemoryItem) => void): Promise<boolean> {
    setBusy(true); setNotice('');
    const outcome = await runMemory(client, request);
    if (!outcome.ok) {setNotice(outcome.message); if (outcome.conflict) await reload(true);}
    else {await reload(true); if (done) setNotice(done); if (outcome.reply.kind === 'item') onItem?.(outcome.reply.item);}
    setBusy(false);
    return outcome.ok;
  }
  const moveTo = (id: string, branch: string) => withSavedDraft(() => {
    const item = items.get(id);
    const request = item && moveRequest(scope, item, branch);
    if (request) void act(request, `已移到「${branch.trim()}」。`);
  });
  async function exportAll() {
    const outcome = await runMemory(client, {type: 'export', scope});
    if (!outcome.ok) {setNotice(outcome.message); return;}
    if (outcome.reply.kind === 'exported') for (const file of outcome.reply.files) download(exportFileName(file.branch), file.markdown);
  }

  const projectFor = (item: MemoryItem) => scope.kind === 'bot' ? sourceProject(item, scope.botId, targets.projects ?? []) : undefined;
  async function archiveLeaf(item: MemoryItem) {
    if (busy) return;
    if (!await act({type: 'archive', scope, itemId: item.id, revision: item.revision}, '已删除，在「已归档」里能恢复。')) return;
    if (selectedRef.current === item.id) {setSelected(undefined); setDetailsOpen(false); setAction(undefined);}
    setEditing(current => current?.kind === 'leaf' && current.id === item.id ? undefined : current);
  }
  function leafMenu(item: MemoryItem): MapMenuItem[] {
    const back = projectFor(item);
    const openAction = (kind: 'move-branch' | 'to-bot' | 'to-project' | 'trust' | 'purge') => {setSelected(item.id); setDetailsOpen(false); setAction({kind, item});};
    return [{id: 'details', label: '详情与历史', onSelect: () => withSavedDraft(() => {setSelected(item.id); setAction(undefined); setDetailsOpen(true);})}, ...leafActions(item, scope.kind, back && targets.projects?.find(project => project.id === back)?.name).map(({action, label}) => {
      const run: Record<LeafAction, () => void> = {
        'move-branch': () => openAction('move-branch'), 'to-bot': () => openAction('to-bot'), 'to-project': () => openAction('to-project'),
        trust: () => openAction('trust'), purge: () => openAction('purge'),
        delete: () => {void archiveLeaf(item);},
        restore: () => void act({type: 'restore', scope, itemId: item.id, revision: item.revision}, '已恢复。'),
      };
      return {id: action, label, onSelect: () => withSavedDraft(run[action]), danger: action === 'delete' || action === 'purge'};
    })];
  }
  const guardInteraction = (action: () => void) => {
    const commitMemory = () => withSavedDraft(action);
    if (beforeInteraction) beforeInteraction(commitMemory); else commitMemory();
  };
  const guardMemory = (action: () => void) => guardInteraction(() => {
    if (beforeLeafSelect) beforeLeafSelect(action); else action();
  });
  const beginLeafEdit = (item: MemoryItem, start?: MapEditStart) => guardMemory(() => {
    if (busy) return;
    setSelected(item.id); setDetailsOpen(false); setAction(undefined);
    setAdding(undefined);
    setEditing({kind: 'leaf', id: item.id, text: start?.text ? start.text : item.text, revision: item.revision, point: start?.point});
  });
  const beginBranchEdit = (view: BranchView, start?: MapEditStart) => guardMemory(() => {
    if (busy || view.fixed) return;
    setAction(undefined); setDetailsOpen(false);
    setAdding(undefined);
    setEditing({kind: 'branch', name: view.name, text: start?.text ?? view.name, point: start?.point});
  });
  const startAdding = (branch?: string) => guardMemory(() => {
    if (!list || busy) return;
    setAction(undefined); setDetailsOpen(false);
    setEditing(undefined);
    setAdding({phase: branch ? 'text' : 'branch', branch: branch ?? '', origin: branch ? 'branch' : 'root'});
    const open = branch ? `b:${branch}` : mode === 'wrapped' ? 'memory' : undefined;
    if (open && !isOpen(open, branch && plan.active ? plan.branches.has(branch) : true)) rawFlip(open);
  });
  const added = (item: MemoryItem) => {setSelected(item.id); setDetailsOpen(false);};
  const archiveBranch = async (view: BranchView) => {
    if (busy || view.fixed) return;
    if (!view.items.length) {setNotice('这支没有可删除的记忆。'); return;}
    setBusy(true); setNotice('');
    const outcome = await archiveBranchItems(client, scope, view.items);
    await reload(true);
    if (outcome.failure) {
      setNotice(`${outcome.archived ? `已删除 ${outcome.archived} 条；` : ''}${outcome.failure.message}，剩余条目未删除。`);
      setBusy(false);
      return;
    }
    setSelected(undefined);
    setNotice(`已删除「${view.name}」中的 ${outcome.archived} 条记忆，可在「已归档」恢复。`);
    setBusy(false);
  };
  const detailItem = detailsOpen && selected ? items.get(selected) : undefined;
  const {actionNodes, detailNodes} = useMemoryDetailNodes({
    action, detailItem, closeAction: () => setAction(undefined), closeDetails: () => setDetailsOpen(false),
    scope, views: views.branches, targets, version: list?.lastEventId, projectFor, act, busy,
    editorSession, onProblem: setNotice,
  });
  const {branches: branchNodes, archive: archiveNode} = memoryNodes({
    views, plan, items, selected, marks, isOpen, flip, leafMenu, moveTo,
    branchMenu: view => [
      {id: 'add', label: '在这支加一条', onSelect: () => startAdding(view.name)},
      ...(branchCanChange(view) ? [{id: 'rename', label: '改名', onSelect: () => beginBranchEdit(view)}, {id: 'merge', label: '合并到…', onSelect: () => withSavedDraft(() => setAction({kind: 'merge', branch: view.name}))}] : []),
    ],
    onLeaf: (item, archived) => {
      const select = () => {setAction(undefined); setSelected(item.id); setDetailsOpen(false); onLeafSelected?.(); if (archived) setEditing(undefined);};
      guardMemory(select);
    },
    onLeafEdit: beginLeafEdit,
    onLeafDelete: item => {void archiveLeaf(item);},
    onLeafAdd: item => startAdding(item.branch),
    onBranchAdd: view => startAdding(view.name),
    onBranchEdit: beginBranchEdit,
    onBranchDelete: view => {void archiveBranch(view);},
    leafContent: item => editing?.kind === 'leaf' && editing.id === item.id ? <MapInlineEditor key={`${scopeKey}:${item.id}:${editing.revision}`} session={editorSession} value={editing.text} label="记忆内容" busy={busy} point={editing.point} onCancel={() => setEditing(current => current === editing ? undefined : current)} onCommit={async (text: string) => {
      if (!text.trim()) {setNotice('记忆内容不能为空。'); return false;}
      if (text === item.text) {setNotice(''); setEditing(current => current === editing ? undefined : current); return true;}
      const ok = await act({type: 'edit', scope, itemId: item.id, revision: editing.revision, text}, '已保存。');
      if (ok) setEditing(current => current === editing ? undefined : current);
      return ok;
    }}/> : undefined,
    branchContent: view => editing?.kind === 'branch' && editing.name === view.name ? <MapInlineEditor key={`${scopeKey}:branch:${view.name}`} session={editorSession} value={editing.text} label="分支名" busy={busy} point={editing.point} onCancel={() => setEditing(current => current === editing ? undefined : current)} onCommit={async (text: string) => {
      if (text.trim() === view.name) {setNotice(''); setEditing(current => current === editing ? undefined : current); return true;}
      const problem = branchNameProblem(text, views.branches, view.name);
      if (problem) {setNotice(problem); return false;}
      const ok = await act({type: 'branchRename', scope, from: view.name, to: text.trim()}, '已改名。');
      if (ok) setEditing(current => current === editing ? undefined : current);
      return ok;
    }}/> : undefined,
    branchAddContent: view => adding?.origin === 'branch' && adding.branch === view.name ? <MapInlineEditor key={`${scopeKey}:add:${view.name}`} session={editorSession} value="" label="新记忆" busy={busy} cancelWhenEmpty onCancel={() => {setNotice(''); setAdding(current => current === adding ? undefined : current);}} onCommit={async (text: string) => {
      if (!text.trim()) {setNotice('记忆内容不能为空。'); return false;}
      const ok = await act({type: 'add', scope, text, branch: view.name}, '已添加。', added);
      if (ok) setAdding(current => current === adding ? undefined : current);
      return ok;
    }}/> : undefined,
  });
  const decorateMemory = (node: MapNode): MapNode => {
    const details = detailItem && node.id === `i:${detailItem.id}` ? detailNodes : [];
    const target = action && ('item' in action ? `i:${action.item.id}` : `b:${action.branch}`);
    const actions = target === node.id ? actionNodes : [];
    const extra = [...details, ...actions];
    return {...node, ...(node.children || extra.length ? {children: [...(node.children ?? []).map(decorateMemory), ...extra]} : {}),
      ...(extra.length ? {open: true} : {})};
  };
  // Page-owned role/navigation nodes share the memory editor's commit boundary.
  const guardNode = (node: MapNode): MapNode => ({...node,
    ...(node.children ? {children: node.children.map(guardNode)} : {}),
    ...(node.onClick ? {onClick: () => guardInteraction(() => {setSelected(undefined); setDetailsOpen(false); setAction(undefined); node.onClick!();})} : {}),
    ...(node.onEdit ? {onEdit: (start?: MapEditStart) => guardInteraction(() => node.onEdit!(start))} : {}),
    ...(node.onAdd ? {onAdd: () => guardInteraction(node.onAdd!)} : {}),
    ...(node.onDelete ? {onDelete: () => guardInteraction(node.onDelete!)} : {}),
    ...(node.onToggle ? {onToggle: () => guardInteraction(node.onToggle!)} : {}),
    ...(node.menu ? {menu: node.menu.map(entry => ({...entry, onSelect: () => guardInteraction(entry.onSelect)}))} : {}),
  });
  const statusNodes: MapNode[] = [
    ...(!list && !error ? [{id: 'loading', kind: 'action' as const, label: '正在读取记忆…'}] : []),
    ...(error ? [{id: 'error', kind: 'action' as const, label: `读取未完成：${error}`, children: [{id: 'retry', kind: 'action' as const, label: '重试', onClick: () => void reload()}]}] : []),
    ...(list && !list.verified ? [{id: 'unverified', kind: 'action' as const, label: '记忆文件在 vonvon 之外被改过，可信条目暂时不会交给模型。', children: [{id: 'reseal', kind: 'action' as const, label: '检查过了，照现在的用', onClick: () => {if (!busy) void act({type: 'reseal', scope}, '已确认，下一轮起可信条目照常交给模型。');}}]}] : []),
    ...(list?.problems ?? []).map((problem, at) => ({id: `problem:${at}`, kind: 'action' as const, label: problem})),
    ...(notice ? [{id: 'notice', kind: 'action' as const, label: notice, onClick: () => setNotice('')}] : []),
    ...(searching ? [{id: 'search', kind: 'action' as const, label: '搜索记忆', content: <input className="mm-search-input" type="search" aria-label="搜索记忆" placeholder="搜索记忆" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {if (event.key === 'Escape') {event.preventDefault(); setQuery(''); setSearching(false);}}}/>, children: [{id: 'search-close', kind: 'action' as const, label: '结束搜索', onClick: () => {setQuery(''); setSearching(false);}}]}] : []),
  ];
  const memoryFresh = [...views.branches, ...views.archived].reduce((sum, view) => sum + branchNewCount(view, marks), 0);
  const addNode: MapNode = {id: 'add-memory', kind: 'action', label: '添加记忆', ...(list && !busy ? {onAdd: () => startAdding()} : {}),
    ...(adding?.origin === 'root' ? {content: <MapInlineEditor key={`${scopeKey}:add:${adding.phase}:${adding.branch}`} session={editorSession} value="" label={adding.phase === 'branch' ? '分类名' : '新记忆'} busy={busy} cancelWhenEmpty onCancel={() => {setNotice(''); setAdding(current => current === adding ? undefined : current);}} onCommit={async (text: string) => {
      if (adding.phase === 'branch') {
        const name = text.trim();
        const existing = views.branches.some(view => view.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        const problem = branchNameProblem(name, []);
        if (problem || !existing && !branchRoom(views.branches)) {setNotice(problem ?? '分支已满 12 支，放不下新分支。'); return false;}
        setAdding(current => current === adding ? {phase: 'text', branch: name, origin: 'root'} : current);
        setNotice(existing ? '' : `分类「${name}」会随第一条记忆创建。`);
        return true;
      }
      if (!text.trim()) {setNotice('记忆内容不能为空。'); return false;}
      const ok = await act({type: 'add', scope, text, branch: adding.branch}, '已添加。', added);
      if (ok) setAdding(current => current === adding ? undefined : current);
      return ok;
    }}/>} : {})};
  const memory: MapNode[] = mode === 'wrapped'
    ? [{id: 'memory', kind: 'section', label: memoryLabel, meta: list ? `${list.used} / ${list.limit}${memoryFresh ? ` · 新 ${memoryFresh}` : ''}` : undefined, open: isOpen('memory', true), onToggle: () => flip('memory'), onAdd: () => startAdding(), children: [...branchNodes, ...archiveNode].map(decorateMemory).concat(addNode)}]
    : [...branchNodes, ...archiveNode].map(decorateMemory).concat(addNode);
  const root: MapNode = {id: 'root', kind: 'root', label: rootLabel, children: [...before.map(guardNode), ...memory, ...after.map(guardNode), ...statusNodes],
    onAdd: () => startAdding(),
    ...(mode === 'direct' && list ? {meta: `${list.used} / ${list.limit}${memoryFresh ? ` · 新 ${memoryFresh}` : ''}`} : {}),
    menu: list ? [{id: 'add', label: '添加记忆', onSelect: () => startAdding()}, {id: 'search', label: '搜索记忆', onSelect: () => guardMemory(() => setSearching(true))}, {id: 'export', label: '导出记忆', onSelect: () => void exportAll()}] : undefined};

  return <section className="memory-map" aria-label={memoryLabel}>
    <div className="memory-canvas"><MindMap key={scopeKey} root={root} label={`${rootLabel}的记忆导图`} beforeLocalToggle={guardInteraction} beforeSelect={guardInteraction} inlineMenus/></div>
  </section>;
}
