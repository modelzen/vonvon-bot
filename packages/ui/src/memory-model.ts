import {MEMORY_BRANCH_COUNT_MAX, MEMORY_BRANCH_NAME_MAX, type MemoryItem, type MemoryReply, type MemoryRequest, type MemorySource} from '@vonvon/protocol';

/** One branch shows its newest this many leaves; the rest sit behind 还有 N 条 (§5.7). */
export const LEAF_LIMIT = 8;
export type MemoryList = Extract<MemoryReply, {kind: 'list'}>;
export type MemoryKind = 'bot' | 'project';

/** A branch as the map draws it: its active entries newest first, and how many of them wait to be confirmed. */
export type BranchView = {name: string; fixed: boolean; items: MemoryItem[]; pending: number};

/** §5.8: the entries and branches written since the page was last opened, and the ones archived to make room. */
export type Marks = {ids: ReadonlySet<string>; branches: ReadonlySet<string>; madeRoom: ReadonlySet<string>};
export const noMarks: Marks = {ids: new Set(), branches: new Set(), madeRoom: new Set()};
export const marksOf = (list: Pick<MemoryList, 'newIds' | 'newBranches' | 'madeRoom'>): Marks => ({ids: new Set(list.newIds), branches: new Set(list.newBranches), madeRoom: new Set(list.madeRoom)});
/** Marks of the first reading stay for as long as the page is open: the 新 does not vanish when the page marks itself seen; later ones join. */
export const joinMarks = (a: Marks, b: Marks): Marks => ({ids: new Set([...a.ids, ...b.ids]), branches: new Set([...a.branches, ...b.branches]), madeRoom: new Set([...a.madeRoom, ...b.madeRoom])});
/** How many leaves of a branch are new. */
export const branchNewCount = (view: Pick<BranchView, 'items'>, marks?: Pick<Marks, 'ids'>): number => marks ? view.items.filter(item => marks.ids.has(item.id)).length : 0;

const codePoints = (value: string) => Array.from(value).length;
const newest = (a: MemoryItem, b: MemoryItem) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1);

/**
 * The branches of one memory, the daemon's order (fixed ones first) with a branch an entry names but the list lacks added
 * at the end, and the archived entries grouped by the branch they came from. A branch with no entries stays: the fixed ones
 * always show, with 0.
 */
export function branchViews(list: Pick<MemoryList, 'items' | 'branches'>): {branches: BranchView[]; archived: BranchView[]} {
  const names = list.branches.map(branch => branch.name);
  for (const item of list.items) if (!names.includes(item.branch)) names.push(item.branch);
  const fixed = new Set(list.branches.filter(branch => branch.fixed).map(branch => branch.name));
  const view = (name: string, state: MemoryItem['state']): BranchView => {
    const items = list.items.filter(item => item.branch === name && item.state === state).sort(newest);
    return {name, fixed: fixed.has(name), items, pending: items.filter(item => item.trust === 'untrusted').length};
  };
  const ordered = [...names.filter(name => fixed.has(name)), ...names.filter(name => !fixed.has(name))];
  return {branches: ordered.map(name => view(name, 'active')), archived: ordered.map(name => view(name, 'archived')).filter(branch => branch.items.length)};
}

/** The leaves a branch draws: its newest 8, or all of them once 还有 N 条 was opened or a search wants the matches seen. */
export function shownLeaves(items: readonly MemoryItem[], showAll: boolean, always: ReadonlySet<string> = new Set()): {shown: MemoryItem[]; hidden: number} {
  if (showAll || items.length <= LEAF_LIMIT) return {shown: [...items], hidden: 0};
  const shown = items.filter((item, at) => at < LEAF_LIMIT || always.has(item.id));
  return {shown, hidden: items.length - shown.length};
}

export type SearchPlan = {active: boolean; leaves: ReadonlySet<string>; /** branches to open: those with a match by name or by a leaf */ branches: ReadonlySet<string>; /** branches whose own name matched */ named: ReadonlySet<string>};
/** What a search box finds: matching leaves and branch names. A branch with a match (by name or by a leaf) is opened. */
export function searchPlan(views: readonly BranchView[], query: string): SearchPlan {
  const needle = query.trim().toLocaleLowerCase();
  const leaves = new Set<string>(); const branches = new Set<string>(); const named = new Set<string>();
  if (!needle) return {active: false, leaves, branches, named};
  for (const view of views) {
    if (view.name.toLocaleLowerCase().includes(needle)) {branches.add(view.name); named.add(view.name);}
    for (const item of view.items) if (item.text.toLocaleLowerCase().includes(needle)) {leaves.add(item.id); branches.add(view.name);}
  }
  return {active: true, leaves, branches, named};
}

export type LeafAction = 'move-branch' | 'to-bot' | 'to-project' | 'trust' | 'delete' | 'restore' | 'purge';
/** The leaf menu (§5.2, §5.3, §5.7): 删除 is archive; 点成可信 only on a waiting project entry; archived ones restore or go for good. */
export function leafActions(item: Pick<MemoryItem, 'state' | 'trust'>, kind: MemoryKind, backTo?: string): Array<{action: LeafAction; label: string}> {
  if (item.state === 'archived') return [{action: 'restore', label: '恢复'}, {action: 'purge', label: '彻底删除'}];
  return [
    {action: 'move-branch', label: '移到分支…'},
    ...(kind === 'project' && item.trust === 'untrusted' ? [{action: 'trust' as const, label: '点成可信'}] : []),
    ...(kind === 'project' ? [{action: 'to-bot' as const, label: '移到 Bot 记忆'}] : [{action: 'to-project' as const, label: backTo ? `移回项目「${backTo}」` : '移到项目…'}]),
    {action: 'delete', label: '删除'},
  ];
}

/** A fixed branch cannot be renamed or merged away (§2.4); a merge needs somewhere to go. */
export const branchCanChange = (view: Pick<BranchView, 'fixed'>) => !view.fixed;
export const mergeTargets = (views: readonly BranchView[], from: string) => views.filter(view => view.name !== from).map(view => view.name);

/** Why a branch name cannot be used; the daemon normalises further (brackets, case) and has the last word. */
export function branchNameProblem(name: string, views: readonly Pick<BranchView, 'name'>[], self?: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return '分支名不能为空。';
  if (codePoints(trimmed) > MEMORY_BRANCH_NAME_MAX) return `分支名最多 ${MEMORY_BRANCH_NAME_MAX} 个字。`;
  if (views.some(view => view.name !== self && view.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) return '已经有这个名字的分支。';
  return undefined;
}
/** Whether a new branch name still fits (§2.4: 12 branches, fixed ones counted). */
export const branchRoom = (views: readonly unknown[]) => views.length < MEMORY_BRANCH_COUNT_MAX;

/** `export` replies one file per branch; this is the file name for it, free of what a file system refuses. */
export const exportFileName = (branch: string) => `${branch.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || '记忆'}.md`;

const roleLabel: Record<MemorySource['actorRole'], string> = {owner: '主人', admin: '管理员', member: '群友', bot: 'Bot', desktop: '主人（桌面端）', cli: '命令行', import: '导入'};
export const downgradeText: Record<NonNullable<MemorySource['downgraded']>, string> = {
  member: '群友说的，只记在本项目',
  'not-human-turn': '不是人触发的这一轮，只记在本项目',
  steered: '这一轮被插话，只记在本项目',
  'not-typed': '不是主人手打的消息，只记在本项目',
  'not-in-message': '由主人触发，内容不在主人这条消息里，只记在本项目',
  quota: 'Bot 记忆这一轮已写过一条，只记在本项目',
};
const when = (at: number) => {const date = new Date(at); return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;};

/** The side panel's source block (§5.3): who, where, when, the Bot's own reason, who edited, why it was lowered. No ids. */
export function sourceLines(item: MemoryItem, names: {bot: (id: string) => string; group: (chatId: string) => string}): string[] {
  const {source} = item;
  const bot = names.bot(source.botId);
  const who = source.actorRole === 'bot' || source.via === 'tool' && source.claim === 'self' && !source.actorOpenId ? `${bot} 自己记的` : `${roleLabel[source.actorRole]}说的`;
  return [
    `${who}${source.chatId ? ` · ${names.group(source.chatId)}` : ''} · ${when(item.createdAt)}${source.chatId && source.via !== 'ui' && source.via !== 'cli' ? ` · 经 ${bot}` : ''}`,
    ...(source.why ? [`${bot} 说：${source.claim === 'asked' ? '有人要求记。' : ''}${source.why}`] : []),
    ...(item.lastEditedBy ? [`${roleLabel[item.lastEditedBy.actorRole]} ${when(item.lastEditedBy.at)} 改过`] : []),
    ...(source.downgraded ? [downgradeText[source.downgraded]] : []),
    ...(source.via === 'promoted' || source.via === 'moved' ? [source.via === 'promoted' ? '从项目记忆移来' : '从 Bot 记忆移来'] : []),
    ...(item.trust === 'untrusted' ? ['待确认：点成可信之前不会发给决策模型'] : []),
  ];
}

/** "移回项目「X」" starts on the project of the group the entry came from: the Bot's binding of that group. */
export function sourceProject(item: Pick<MemoryItem, 'source'>, botId: string, projects: ReadonlyArray<{id: string; bindings: ReadonlyArray<{agentId: string; groupId: string}>}>): string | undefined {
  const chatId = item.source.chatId;
  return chatId ? projects.find(project => project.bindings.some(binding => binding.agentId === botId && binding.groupId === chatId))?.id : undefined;
}

export type Outcome = {ok: true; reply: MemoryReply} | {ok: false; message: string; conflict?: boolean};
/** One memory call, every kind of "no" as text. A conflict is its own case: the page re-reads the list (§5.7). */
export async function runMemory(client: {memory(request: MemoryRequest): Promise<MemoryReply>}, request: MemoryRequest): Promise<Outcome> {
  try {
    const reply = await client.memory(request);
    if (reply.kind === 'conflict') return {ok: false, conflict: true, message: '已在别处改过，重新读取。'};
    if (reply.kind === 'refused') return {ok: false, message: reply.message};
    return {ok: true, reply};
  } catch (failure) {return {ok: false, message: failure instanceof Error ? failure.message : '操作未完成，请重试。'};}
}

/** The edit that moves a leaf to another branch of the same memory, with the revision the page saw (§5.7); none when it is already there. */
export function moveRequest(scope: Extract<MemoryRequest, {type: 'edit'}>['scope'], item: Pick<MemoryItem, 'id' | 'revision' | 'branch'>, branch: string): MemoryRequest | undefined {
  const to = branch.trim();
  return !to || to === item.branch ? undefined : {type: 'edit', scope, itemId: item.id, revision: item.revision, branch: to};
}

/** The two 角色设定 leaves with their size: 身份与职责 against its 500-character limit, 其他说明 as a count. */
export function roleUsage(sizes?: {identity: number; notes: number}): Array<{id: 'identity' | 'notes'; label: string; meta?: string}> {
  return [
    {id: 'identity', label: '身份与职责', ...(sizes ? {meta: `${sizes.identity} / 500 字`} : {})},
    {id: 'notes', label: '其他说明', ...(sizes ? {meta: `${sizes.notes} 字`} : {})},
  ];
}
