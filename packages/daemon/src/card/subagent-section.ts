import { createHash } from 'node:crypto';
import { md, type CardElement } from './cards';
import { processPanel } from './process-panel';
import { formatElapsed } from './run-process';
import type { SubagentRow, Terminal } from './run-state';

export const SUBAGENT_FULL_ROWS = 8;
export const SUBAGENT_PAGE_ROWS = 24;
export interface SubagentSectionInput {
  rows: readonly SubagentRow[];
  cardKey?: string;
  running: boolean;
  terminal: Terminal;
  waiting?: { subagentId: string; label: string };
  carried?: boolean;
  page?: number;
  now?: number;
}
export function subagentElementIds(id: string): { panel: string; button: string } {
  const hash = createHash('sha1').update(id).digest('hex').slice(0, 12);
  return { panel: `sa_${hash}`, button: `sb_${hash}` };
}
export function buildSubagentSection(input: SubagentSectionInput): { elements: CardElement[]; components: number } {
  const { rows, running, terminal, waiting, carried, now = Date.now() } = input;
  const cardKey = running && terminal === 'running' ? input.cardKey : undefined;
  if (!rows.length) return { elements: [], components: 0 };
  const icons = { running: '🔄', completed: '✅', failed: '❌', stopped: '⏹' };
  const labels = { running: '在跑', completed: '已完成', failed: '失败', stopped: '已停止' };
  const counts = Object.entries(labels).flatMap(([status, label]) => {
    const count = rows.filter(row => row.status === status).length;
    return count ? [`${count} 个${label}`] : [];
  });
  const elements: CardElement[] = [md(`<font color='grey'>子 agent · ${counts.join(' · ')}</font>`)];
  let components = 1;
  const suffix = (row: SubagentRow): string => waiting?.subagentId === row.id ? ` · ${waiting.label}`
    : row.status === 'failed' ? ' · 失败' : row.status === 'stopped' ? ' · 已停止'
    : row.status === 'running' && carried ? ' · 接着显示在下一张卡'
    : row.status === 'running' && terminal !== 'running' ? ' · 没收到结束消息' : '';
  const title = (row: SubagentRow, full: boolean): string =>
    `${row.status === 'running' && terminal !== 'running' ? '⚠️' : icons[row.status]} ${row.name.slice(0, 20)}：${row.task.slice(0, full ? 40 : 20)} · ${row.stepCount} 步${full ? ` · ${formatElapsed((row.endedAt ?? now) - row.startedAt)}` : ''}${suffix(row)}`;
  const stop = (row: SubagentRow): CardElement[] => {
    if (!cardKey || !running || row.status !== 'running' || !row.stoppable) return [];
    const e = subagentElementIds(row.id).button;
    return [{ tag: 'button', element_id: e, text: { tag: 'plain_text', content: '停止' }, type: 'default', size: 'small',
      behaviors: [{ type: 'callback', value: { a: 'run.stopSub', m: cardKey, subagentId: row.id, e } }] }];
  };
  const rank = (row: SubagentRow): number => row.status === 'running' ? 1 : row.status === 'completed' ? 3 : 2;
  const ordered = [...rows].sort((a, b) => a.startedAt - b.startedAt);
  const full = [...ordered].sort((a, b) => rank(a) - rank(b)).slice(0, SUBAGENT_FULL_ROWS);
  const pending = ordered.find(row => row.id === waiting?.subagentId);
  if (pending && !full.includes(pending)) full.splice(0, 1, pending);
  const chosen = new Set(full);
  for (const row of ordered.filter(row => chosen.has(row))) {
    const omitted = row.stepCount - row.steps.length;
    const steps = row.steps.map(step => `${step.status === 'running' ? '🔄' : step.status === 'done' ? '✅' : '❌'} ${step.title.slice(0, 60)}`);
    const body = [md([...(omitted > 0 ? [`<font color='grey'>前面还有 ${omitted} 步</font>`] : []), ...steps].join('\n') || '还没有步骤'),
      ...(row.result ? [md(`**结果**\n${row.result}`)] : []), ...stop(row)];
    let depth = 0, parent = row.parentId;
    const seen = new Set([row.id]);
    while (parent && depth < 3 && !seen.has(parent)) {
      seen.add(parent); depth++; parent = rows.find(candidate => candidate.id === parent)?.parentId;
    }
    elements.push({ ...processPanel(title(row, true), body, false, { spacing: 8 }),
      element_id: subagentElementIds(row.id).panel, margin: `0px 0px 0px ${depth * 16}px` });
    components += 1 + body.length;
  }
  const overflow = ordered.filter(row => !chosen.has(row));
  if (overflow.length) {
    const active = overflow.filter(row => row.status === 'running');
    const pages = Math.max(1, Math.ceil(active.length / SUBAGENT_PAGE_ROWS));
    const page = (input.page ?? 0) % pages;
    const body: CardElement[] = [];
    if (cardKey) for (const row of active.slice(page * SUBAGENT_PAGE_ROWS, (page + 1) * SUBAGENT_PAGE_ROWS)) body.push(md(title(row, false)), ...stop(row));
    else if (active.length) body.push(md(active.map(row => title(row, false)).join('\n')));
    const other = overflow.filter(row => row.status !== 'running' && row.status !== 'completed').map(row => title(row, false));
    const completed = overflow.filter(row => row.status === 'completed').length;
    if (completed) other.push(`另有 ${completed} 个已完成`);
    if (other.length) body.push(md(other.join('\n')));
    if (cardKey && pages > 1) body.push({ tag: 'button', element_id: 'sp_next', type: 'default', size: 'small',
      text: { tag: 'plain_text', content: `下一页（${page + 1}/${pages}）` },
      behaviors: [{ type: 'callback', value: { a: 'run.subPage', m: cardKey, p: (page + 1) % pages } }] });
    elements.push({ ...processPanel(`另有 ${overflow.length} 个子 agent`, body, false, { spacing: 8 }), element_id: 'sa_more' });
    components += 1 + body.length;
  }
  return { elements, components };
}
