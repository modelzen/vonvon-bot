import {useCallback, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {Search} from 'lucide-react';
import type {MemoryEvent, MemoryItem, MemoryScopeRef} from '@vonvon/protocol';
import {useClient, useShellCapabilities} from './client-context';
import {Button, InlineNotice} from './reference/components/ui';
import {Dialog} from './reference/components/ui/Dialog';
import {MindMap, type MapEditStart, type MapMenuItem, type MapNode} from './MindMap';
import {MapInlineEditor, type MapInlineEditorSession} from './MapInlineEditor';
import {
  archiveBranchItems, branchCanChange, branchNameProblem, branchNewCount, branchRoom, branchViews, exportFileName, joinMarks, leafActions, marksOf, mergeTargets, moveRequest, noMarks, runMemory, searchPlan, sourceLines, sourceProject,
  type BranchView, type LeafAction, type Marks, type MemoryList,
} from './memory-model';
import {memoryNodes} from './memory-nodes';
import {groupUrl, openExternalUrl} from './url-actions';
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
  /** Replaces the leaf side panel while the page has its own open (the role editor). */
  panel?: ReactNode;
  panelTitle?: string;
  panelKey?: string;
  onPanelClose?: () => void;
  onLeafSelected?: () => void;
  beforeLeafSelect?: (select: () => void) => void;
};
/** Fired on `window` when a page has marked itself seen, so the counts on the navigation and the lists are read again (§5.8). */
export const MEMORY_SEEN_EVENT = 'vonvon:memory-seen';
type Dialogs =
  | {kind: 'rename'; branch: string} | {kind: 'merge'; branch: string} | {kind: 'move-branch'; item: MemoryItem}
  | {kind: 'to-bot' | 'to-project' | 'trust' | 'purge'; item: MemoryItem};

const eventLabel: Record<MemoryEvent['kind'], string> = {
  add: '新增', edit: '修改', archive: '删除', restore: '恢复', promote: '移到 Bot 记忆', move: '移回项目', confirm: '点成可信', purge: '彻底删除',
  branch_rename: '分支改名', branch_merge: '分支合并', branch_unmerge: '撤销合并',
};
const undoable = new Set<MemoryEvent['kind']>(['edit', 'archive', 'restore', 'promote', 'move', 'confirm']);
const failText = (error: unknown) => error instanceof Error ? error.message : '暂时读不到，请重试。';

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], {type: 'text/markdown'}));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  URL.revokeObjectURL(url);
}

/** One memory (a Bot's or a project's) as a mind map with its toolbar, notices, dialogs and the side panel of the selected leaf (§5.7). */
export function MemoryMap({scope, rootLabel, mode, memoryLabel, targets, before = [], after = [], panel, panelTitle = '角色设定', panelKey, onPanelClose, onLeafSelected, beforeLeafSelect}: Props) {
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
  const [dialog, setDialog] = useState<Dialogs>();
  const [marks, setMarks] = useState<Marks>(noMarks);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!panelKey || !panelRef.current) return;
    const anchor = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    panelRef.current.scrollIntoView({block: 'nearest'});
    return () => {if (anchor?.isConnected) anchor.focus();};
  }, [panelKey]);
  const serial = useRef(0);
  const draftOpen = useRef(false);
  const editorSession = useRef<MapInlineEditorSession | null>(null);
  const switching = useRef(false);
  draftOpen.current = Boolean(editing || adding);
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
      setList(reply); setError(undefined);
      // the first reading's marks stay while the page is open; what is written meanwhile joins them
      setMarks(current => joinMarks(current, marksOf(reply)));
      if (seenSent.current !== scopeKey) {
        seenSent.current = scopeKey;
        const page = scope.kind === 'bot' ? {kind: 'bot' as const, botId: scope.botId} : {kind: 'project' as const, projectId: scope.projectId};
        void client.memory({type: 'seen', page}).then(() => window.dispatchEvent(new Event(MEMORY_SEEN_EVENT))).catch(() => undefined);
      }
    } catch (failure) {if (request === serial.current) setError(failText(failure));}
    // `scope` is rebuilt by the parent every render; its key is what says the memory changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, scopeKey]);
  useEffect(() => {setList(undefined); setMarks(noMarks); setSelected(undefined); setEditing(undefined); setAdding(undefined); setDetailsOpen(false); void reload(true); return () => {serial.current++;};}, [reload]);
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
    if (!session) {action(); return;}
    if (switching.current) return;
    switching.current = true;
    void session.commit().then(ok => {
      if (ok) action();
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
    if (selectedRef.current === item.id) {setSelected(undefined); setDetailsOpen(false);}
    setEditing(current => current?.kind === 'leaf' && current.id === item.id ? undefined : current);
  }
  function leafMenu(item: MemoryItem): MapMenuItem[] {
    const back = projectFor(item);
    return [{id: 'details', label: '详情与历史', onSelect: () => withSavedDraft(() => {setSelected(item.id); setDetailsOpen(true);})}, ...leafActions(item, scope.kind, back && targets.projects?.find(project => project.id === back)?.name).map(({action, label}) => {
      const run: Record<LeafAction, () => void> = {
        'move-branch': () => setDialog({kind: 'move-branch', item}), 'to-bot': () => setDialog({kind: 'to-bot', item}), 'to-project': () => setDialog({kind: 'to-project', item}),
        trust: () => setDialog({kind: 'trust', item}), purge: () => setDialog({kind: 'purge', item}),
        delete: () => {void archiveLeaf(item);},
        restore: () => void act({type: 'restore', scope, itemId: item.id, revision: item.revision}, '已恢复。'),
      };
      return {id: action, label, onSelect: () => withSavedDraft(run[action]), danger: action === 'delete' || action === 'purge'};
    })];
  }
  const guardMemory = (action: () => void) => {
    const afterRoleGuard = () => withSavedDraft(action);
    if (beforeLeafSelect) beforeLeafSelect(afterRoleGuard); else afterRoleGuard();
  };
  const beginLeafEdit = (item: MemoryItem, start?: MapEditStart) => guardMemory(() => {
    if (busy) return;
    setSelected(item.id); setDetailsOpen(false);
    setAdding(undefined);
    setEditing({kind: 'leaf', id: item.id, text: start?.text ? start.text : item.text, revision: item.revision, point: start?.point});
  });
  const beginBranchEdit = (view: BranchView, start?: MapEditStart) => guardMemory(() => {
    if (busy || view.fixed) return;
    setAdding(undefined);
    setEditing({kind: 'branch', name: view.name, text: start?.text ?? view.name, point: start?.point});
  });
  const startAdding = (branch?: string) => guardMemory(() => {
    if (!list || busy) return;
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
  const {branches: branchNodes, archive: archiveNode} = memoryNodes({
    views, plan, items, selected, marks, isOpen, flip, leafMenu, moveTo,
    branchMenu: view => [
      {id: 'add', label: '在这支加一条', onSelect: () => startAdding(view.name)},
      ...(branchCanChange(view) ? [{id: 'rename', label: '改名', onSelect: () => withSavedDraft(() => setDialog({kind: 'rename', branch: view.name}))}, {id: 'merge', label: '合并到…', onSelect: () => withSavedDraft(() => setDialog({kind: 'merge', branch: view.name}))}] : []),
    ],
    onLeaf: (item, archived) => {
      const select = () => {setSelected(item.id); setDetailsOpen(false); onLeafSelected?.(); if (archived) setEditing(undefined);};
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
    ? [{id: 'memory', kind: 'section', label: memoryLabel, meta: list ? `${list.used} / ${list.limit}${memoryFresh ? ` · 新 ${memoryFresh}` : ''}` : undefined, open: isOpen('memory', true), onToggle: () => flip('memory'), onAdd: () => startAdding(), children: [...branchNodes, ...archiveNode, addNode]}]
    : [...branchNodes, ...archiveNode, addNode];
  const root: MapNode = {id: 'root', kind: 'root', label: rootLabel, children: [...before, ...memory, ...after],
    onAdd: () => startAdding(),
    ...(mode === 'direct' && list ? {meta: `${list.used} / ${list.limit}${memoryFresh ? ` · 新 ${memoryFresh}` : ''}`} : {}),
    menu: list ? [{id: 'add', label: '添加记忆', onSelect: () => startAdding()}, {id: 'export', label: '导出记忆', onSelect: () => void exportAll()}] : undefined};

  const item = selected ? items.get(selected) : undefined;
  return <section className="memory-map" aria-label={memoryLabel}>
    <div className="memory-toolbar">
      <label className="memory-search"><Search size={13} aria-hidden="true"/><input type="search" aria-label="搜索记忆" placeholder="搜索" value={query} onChange={event => setQuery(event.target.value)}/></label>
    </div>
    {error && <InlineNotice title="读取未完成" tone="warning">{error}<Button size="sm" onClick={() => void reload()}>重试</Button></InlineNotice>}
    {list && !list.verified && <InlineNotice title="记忆文件在 vonvon 之外被改过" tone="warning">可信条目暂时不会交给模型。检查下面的条目，没问题就确认。<Button size="sm" disabled={busy} onClick={() => void act({type: 'reseal', scope}, '已确认，下一轮起可信条目照常交给模型。')}>检查过了，照现在的用</Button></InlineNotice>}
    {list?.problems.map(problem => <p className="group-control-note" role="status" key={problem}>{problem}</p>)}
    {notice && <p className="group-control-note" role="status">{notice}</p>}
    <div className="memory-body">
      <div className="memory-canvas"><MindMap key={scopeKey} root={root} label={`${rootLabel}的记忆导图`} beforeLocalToggle={withSavedDraft}/>{!list && !error && <p className="gd-empty" role="status">正在读取记忆…</p>}</div>
      {(panel || detailsOpen && item) && <aside ref={panelRef} className="memory-panel" aria-label="详情">
        <div className="memory-panel-heading"><strong>{panel ? panelTitle : '记忆详情'}</strong><Button size="sm" aria-label="关闭详情" onClick={() => {setDetailsOpen(false); onPanelClose?.();}}>关闭</Button></div>
        {panel ?? (item && <LeafPanel key={item.id} item={item} scope={scope} targets={targets} version={list?.lastEventId} onUndone={() => reload()} busy={busy} act={act}/>)}
      </aside>}
    </div>
    <MemoryDialogs dialog={dialog} close={() => setDialog(undefined)} scope={scope} views={views.branches} targets={targets} projectFor={projectFor} act={act} busy={busy}/>
  </section>;
}

function LeafPanel({item, scope, targets, version, onUndone, busy, act}: {item: MemoryItem; scope: Scope; targets: MemoryTargets; version?: string; onUndone: () => Promise<void>; busy: boolean; act: (request: Parameters<typeof runMemory>[1], done?: string) => Promise<boolean>}) {
  const client = useClient();
  const shell = useShellCapabilities();
  const [events, setEvents] = useState<MemoryEvent[]>();
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let live = true;
    void runMemory(client, {type: 'events', scope, itemId: item.id}).then(outcome => {if (live) setEvents(outcome.ok && outcome.reply.kind === 'events' ? outcome.reply.events : []);});
    return () => {live = false;};
  }, [client, scope.kind === 'bot' ? scope.botId : scope.projectId, item.id, item.revision, version]);
  const lines = sourceLines(item, {bot: targets.botName, group: targets.groupName});
  const newest = events?.at(-1);
  const chatId = item.source.chatId;
  return <div className="memory-leaf-panel">
    <h3>{item.text}</h3>
    <p className="group-control-note">{item.branch}{item.state === 'archived' ? ' · 已归档' : ''}</p>
    <ul className="memory-source">{lines.map(line => <li key={line}>{line}</li>)}</ul>
    {chatId && <Button size="sm" onClick={() => void openExternalUrl(groupUrl(chatId), 'group', shell).catch(error => setProblem(failText(error)))}>来源↗</Button>}
    {!chatId && item.source.via !== 'ui' && <p className="group-control-note">没有来源消息。</p>}
    {problem && <p className="gd-note" role="alert">{problem}</p>}
    <h4>历史</h4>
    {events === undefined ? <p className="group-control-note" role="status">正在读取…</p> : !events.length ? <p className="group-control-note">没有修改记录。</p>
      : <ol className="memory-history">{events.map(event => <li key={event.eventId}>
        <span>{eventLabel[event.kind]}</span>
        {event === newest && undoable.has(event.kind) && event.undoOf === undefined && <Button size="sm" disabled={busy} onClick={() => void act({type: 'undo', scope, eventId: event.eventId}, '已撤销。').then(() => onUndone())}>撤销</Button>}
      </li>)}</ol>}
  </div>;
}

function MemoryDialogs({dialog, close, scope, views, targets, projectFor, act, busy}: {
  dialog?: Dialogs; close: () => void; scope: Scope; views: BranchView[]; targets: MemoryTargets;
  projectFor: (item: MemoryItem) => string | undefined; act: (request: Parameters<typeof runMemory>[1], done?: string) => Promise<boolean>; busy: boolean;
}) {
  const [text, setText] = useState('');
  const [choice, setChoice] = useState('');
  useEffect(() => {
    if (!dialog) return;
    setText(dialog.kind === 'rename' ? dialog.branch : dialog.kind === 'move-branch' ? dialog.item.branch : '');
    setChoice(dialog.kind === 'merge' ? mergeTargets(views, dialog.branch)[0] ?? '' : dialog.kind === 'to-bot' ? targets.bots?.[0]?.id ?? '' : dialog.kind === 'to-project' ? projectFor(dialog.item) ?? targets.projects?.[0]?.id ?? '' : '');
    // reset only when a dialog opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog]);
  if (!dialog) return null;
  const run = async (request: Parameters<typeof runMemory>[1], done: string) => {if (await act(request, done)) close();};
  const footer = (confirm: string, onConfirm: () => void, disabled = false, tone?: 'danger') => <>
    <Button disabled={busy} onClick={close}>取消</Button>
    <Button variant={tone === 'danger' ? undefined : 'primary'} loading={busy} disabled={disabled} onClick={onConfirm}>{confirm}</Button></>;
  switch (dialog.kind) {
    case 'rename': {
      const problem = branchNameProblem(text, views, dialog.branch);
      return <Dialog open title={`给分支「${dialog.branch}」改名`} onClose={close} footer={footer('改名', () => void run({type: 'branchRename', scope, from: dialog.branch, to: text.trim()}, '已改名。'), Boolean(problem) || text.trim() === dialog.branch)}>
        <label className="group-control-note">新名字<input className="settings-field" aria-label="分支名" value={text} onChange={event => setText(event.target.value)}/></label>
        {problem && <p className="gd-note" role="status">{problem}</p>}
      </Dialog>;
    }
    case 'merge':
      return <Dialog open title={`把分支「${dialog.branch}」合并到…`} onClose={close} footer={footer('合并', () => void run({type: 'branchMerge', scope, from: dialog.branch, into: choice}, '已合并。'), !choice)}>
        <label className="group-control-note">合并到<select className="settings-field" aria-label="合并到哪个分支" value={choice} onChange={event => setChoice(event.target.value)}>
          {mergeTargets(views, dialog.branch).map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        <p className="group-control-note">这一支的条目都挪过去，这一支消失。合并记成一个事件，能整批撤销。</p>
      </Dialog>;
    case 'move-branch': {
      const problem = views.some(view => view.name === text.trim()) || !text.trim() ? undefined : !branchRoom(views) ? '分支已满 12 支，放不下新分支。' : branchNameProblem(text, views);
      const request = moveRequest(scope, dialog.item, text);
      return <Dialog open title="移到分支…" onClose={close} footer={footer('移动', () => request && void run(request, `已移到「${text.trim()}」。`), !request || Boolean(problem))}>
        <label className="group-control-note">分支（选一个，或写一个新名字）<input className="settings-field" aria-label="目标分支" list="memory-move-branches" value={text} onChange={event => setText(event.target.value)}/></label>
        <datalist id="memory-move-branches">{views.filter(view => view.name !== dialog.item.branch).map(view => <option key={view.name} value={view.name}/>)}</datalist>
        {problem && <p className="gd-note" role="status">{problem}</p>}
      </Dialog>;
    }
    case 'to-bot': {
      const bots = targets.bots ?? [];
      const name = bots.find(bot => bot.id === choice)?.name ?? '这个 Bot';
      return <Dialog open title="移到 Bot 记忆" onClose={close} footer={footer('移过去', () => void run({type: 'promote', scope, itemId: dialog.item.id, revision: dialog.item.revision, botId: choice}, '已移到 Bot 记忆。'), !choice)}>
        {bots.length > 1 && <label className="group-control-note">哪个 Bot<select className="settings-field" aria-label="哪个 Bot" value={choice} onChange={event => setChoice(event.target.value)}>
          {bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>}
        <p className="group-control-note">这条会带进{name}的所有项目。群友的话建议先改写成对你自己的要求。</p>
      </Dialog>;
    }
    case 'to-project': {
      const projects = targets.projects ?? [];
      const name = projects.find(project => project.id === choice)?.name ?? '这个项目';
      return <Dialog open title="移回项目" onClose={close} footer={footer('移过去', () => void run({type: 'move', scope, itemId: dialog.item.id, revision: dialog.item.revision, to: {projectId: choice}}, `已移到项目「${name}」。`), !choice)}>
        <label className="group-control-note">哪个项目<select className="settings-field" aria-label="哪个项目" value={choice} onChange={event => setChoice(event.target.value)}>
          {!choice && <option value="">选一个项目</option>}{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <p className="group-control-note">移过去以后，项目「{name}」里所有群的 Bot 都会读到这条，其他项目不再带它。</p>
      </Dialog>;
    }
    case 'trust':
      return <Dialog open title="点成可信" onClose={close} footer={footer('点成可信', () => void run({type: 'confirm', scope, itemId: dialog.item.id, revision: dialog.item.revision}, '已点成可信。'))}>
        <p className="group-control-note">点成可信以后，这个项目里所有群的 Bot 都会把它当可信记忆读到，也会发给决策模型。</p>
      </Dialog>;
    case 'purge':
      return <Dialog open title="彻底删除" onClose={close} footer={footer('彻底删除', () => void run({type: 'purge', scope, itemId: dialog.item.id}, '已彻底删除。'), false, 'danger')}>
        <p className="group-control-note">彻底删除以后不能恢复，也不能撤销。</p>
      </Dialog>;
  }
}
