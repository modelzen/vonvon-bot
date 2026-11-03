import type {ContextPreviewReply, ContextSectionKey, MemoryItem} from '@vonvon/protocol';

/** The one sentence about files vonvon does not handle (§5.5, D6): fixed text, no file is read, listed or named beyond it. */
export const INSTRUCTION_FILES_NOTE = '模型还会读项目自己的 AGENTS.md / CLAUDE.md，vonvon 不显示也不改。';

const label: Record<ContextSectionKey, string> = {
  identity: '身份行', role: '角色设定', supplement: '本项目的补充职责', botMemory: 'Bot 记忆', projectMemory: '项目记忆',
};
/** Where 去改 / 去看 leads for a row. */
export type PanelTarget = 'role' | 'supplement' | 'botMemory' | 'projectMemory';
const target: Partial<Record<ContextSectionKey, PanelTarget>> = {role: 'role', supplement: 'supplement', botMemory: 'botMemory', projectMemory: 'projectMemory'};

export type PanelRow = {key: string; label: string; live?: string; liveWarn?: boolean; next: string; target?: PanelTarget};

/** The 下一次新会话会有的 cell of one row. */
function nextCell(section: ContextPreviewReply['next']['sections'][number], items: ContextPreviewReply['next']['items']): string {
  if (section.key === 'identity') return '✓';
  if (section.key === 'role' || section.key === 'supplement') return section.chars ? `${section.chars.toLocaleString('en-US')} 字` : '没有';
  if (section.key === 'botMemory') return `${items.bot} 条（${section.branches ?? 0} 个分支）`;
  return `可信 ${items.trusted} 条 / 待确认 ${items.untrusted} 条（${section.branches ?? 0} 个分支）`;
}

/** The two columns of §5.5: what the live session was last handed, and what a new session would get. vonvon's own parts only. */
export function panelRows(reply: ContextPreviewReply): PanelRow[] {
  const {session, next} = reply;
  const live = session && !session.legacy ? new Map(session.sections.map(section => [section.key, section] as const)) : undefined;
  const sessionCell = (key: ContextSectionKey): Pick<PanelRow, 'live' | 'liveWarn'> => {
    if (!session) return {};
    if (session.legacy) return {live: '旧版（升级前开场）', liveWarn: true};
    const entry = live?.get(key);
    if (!entry) return {live: '没有'};
    const count = key === 'botMemory' ? `${entry.items ?? 0} 条` : key === 'projectMemory' ? `${entry.items ?? 0} 条` : '✓';
    return entry.stale ? {live: `${count === '✓' ? `版本 ${entry.version.slice(0, 6)}` : count}，还没收到，下一轮生效`, liveWarn: true} : {live: count};
  };
  return [
    {key: 'convention', label: '固定约定', next: '新版', ...(session ? session.legacy ? {live: '旧版（升级前开场）', liveWarn: true} : {live: '✓'} : {})},
    ...next.sections.map(section => ({key: section.key, label: label[section.key], next: nextCell(section, next.items), ...sessionCell(section.key), ...(target[section.key] ? {target: target[section.key]} : {})})),
  ];
}

/** The judge block: who gets it and what goes in it (§4.6). `machine`: whose model a local judge is, 本机 or 「X」上的. */
export function judgeLines(judge: ContextPreviewReply['judge'], machine = '本机'): string[] {
  const who = judge.via === 'third-party' ? `智能判断会发给决策模型（${judge.label ?? '第三方'}，第三方）` : `智能判断交给${machine}决策模型${judge.label ? `（${judge.label}）` : ''}`;
  return [who, `补充职责 + 身份与职责（${judge.roleChars} 字）；项目记忆只发本群可信条目 ${judge.memoryItems} 条；待确认的、Bot 记忆不发`];
}

const when = (at: number) => {const date = new Date(at); return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;};
type LastTurn = NonNullable<NonNullable<ContextPreviewReply['session']>['lastTurn']>;

/** "最近一轮：模型说参考了 N 条" (§5.3, §5.5): the model's own account, not something the daemon checked. */
export function lastTurnLines(turn: LastTurn): {head: string; used: string[]; missed?: string} {
  const missed = turn.missed?.length ? `有 ${turn.missed.length} 条没记上：${[...new Set(turn.missed)].join('、')}（不存原文）` : undefined;
  return {
    head: `最近一轮参考了 ${turn.used.length} 条（${when(turn.at)}）`,
    used: turn.used.map(entry => entry.text ?? '（这条已经不在了）'),
    ...(missed ? {missed} : {}),
  };
}
export const injectedLine = (turn: LastTurn): string => `注入：Bot 记忆 ${turn.items.bot} 条 · 项目记忆 可信 ${turn.items.trusted} / 待确认 ${turn.items.untrusted}`;

/** The newest `lastTurn` among several bindings' previews (a project can have several groups and Bots). */
export function newestTurn(replies: ReadonlyArray<{label: string; reply?: ContextPreviewReply}>): {label: string; turn: LastTurn} | undefined {
  let best: {label: string; turn: LastTurn} | undefined;
  for (const {label: name, reply} of replies) {
    const turn = reply?.session?.lastTurn;
    if (turn && (!best || turn.at > best.turn.at)) best = {label: name, turn};
  }
  return best;
}

/** `[逐条看]` groups: entries by branch, in the order the branches list them. */
export function groupByBranch(items: readonly MemoryItem[], branches: readonly string[]): Array<{branch: string; items: MemoryItem[]}> {
  const names = [...branches, ...items.map(item => item.branch).filter(name => !branches.includes(name))];
  return [...new Set(names)].map(branch => ({branch, items: items.filter(item => item.branch === branch)})).filter(group => group.items.length);
}

/** The entries the decision model gets (§4.6): this group's trusted active ones, newest first; the first `count` as the daemon counted them. */
export function judgeItems(items: readonly MemoryItem[], chatId: string, count: number): MemoryItem[] {
  return items
    .filter(item => item.state === 'active' && item.trust === 'trusted' && (item.source.chatId ? item.source.chatId === chatId : item.source.via === 'ui' || item.source.via === 'cli'))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, count);
}
