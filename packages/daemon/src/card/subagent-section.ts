import { createHash } from 'node:crypto';
import { md, type CardElement } from './cards';
import { processPanel } from './process-panel';
import { formatElapsed } from './run-process';
import type { SubagentRow, Terminal } from './run-state';
import { RUNTIME_SUBAGENT_ICON } from './runtime-card-icons';
import { toolPresentation } from './tool-presentation';
import { statusSymbol, type ProcessStatus } from './process-status';

export const SUBAGENT_FULL_ROWS = 8;
export const SUBAGENT_PAGE_ROWS = 24;
// Keep room for the parent process in its existing 120-component budget.
export const SUBAGENT_COMPONENT_BUDGET = 110;
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
  const labels = { running: '运行中', completed: '已完成', failed: '失败', stopped: '已停止', waiting: '等待处理', unknown: '状态未知' };
  const tint = (text: string, color = 'grey'): string => `<font color='${color}'>${text}</font>`;
  const statusOf = (row: SubagentRow): ProcessStatus => waiting?.subagentId === row.id ? 'waiting'
    : row.status === 'running' && terminal !== 'running' && !carried ? 'unknown' : row.status;
  const counts = Object.entries(labels).flatMap(([status, label]) => {
    const count = rows.filter(row => statusOf(row) === status).length;
    return count ? [tint(`${count} 个${label}`, status === 'failed' ? 'red' : 'grey')] : [];
  });
  const separator = tint(' · ');
  const elements: CardElement[] = [md([tint('子 agent'), ...counts].join(separator))];
  let components = 1;
  const compactable: Array<{ row: SubagentRow; panel: CardElement; detailed: CardElement[]; compact: CardElement }> = [];
  const statusNote = (row: SubagentRow): string => waiting?.subagentId === row.id ? tint(waiting.label.replace(/^⏸️?\s*/u, ''), 'orange')
    : row.status === 'running' && carried ? tint('接着显示在下一张卡')
    : statusOf(row) === 'unknown' ? tint('没收到结束消息', 'orange') : '';
  const title = (row: SubagentRow, full: boolean): string => {
    const task = row.task.trim().slice(0, full ? 40 : 20);
    const label = [tint(`${row.name.slice(0, 20)}${task ? `：${task}` : ''}`),
      tint(`${row.stepCount} 步${full ? ` · ${formatElapsed((row.endedAt ?? now) - row.startedAt)}` : ''}`)].join(separator);
    const note = statusNote(row);
    return `${label} ${statusSymbol(statusOf(row))}${note ? ` ${note}` : ''}`;
  };
  const iconLine = (content: string, token: string): CardElement => ({
    ...md(content), icon: { tag: 'standard_icon', token, color: 'grey' },
  });
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
    const steps = row.steps.map(step => {
      const presentation = toolPresentation({ ...step, status: step.status === 'failed' ? 'error' : step.status });
      const command = presentation.command?.slice(0, 60).replace(/[<>&*_`\[\]~]/gu, ch => `&#${ch.charCodeAt(0)};`);
      const status = step.status === 'done' ? 'completed' : step.status;
      return iconLine(`${command ?? presentation.label} ${statusSymbol(status)}`, presentation.icon);
    });
    const detailed = [...(omitted > 0 ? [md(`<font color='grey'>前面还有 ${omitted} 步</font>`)] : []),
      ...(steps.length ? steps : [md('还没有步骤')])];
    const body = [...detailed,
      ...(row.result ? [md(`**结果**\n${row.result}`)] : []), ...stop(row)];
    let depth = 0, parent = row.parentId;
    const seen = new Set([row.id]);
    while (parent && depth < 3 && !seen.has(parent)) {
      seen.add(parent); depth++; parent = rows.find(candidate => candidate.id === parent)?.parentId;
    }
    const panel = { ...processPanel(title(row, true), body, false, { icon: RUNTIME_SUBAGENT_ICON, spacing: 8, titleColor: false }),
      element_id: subagentElementIds(row.id).panel, margin: `0px 0px 0px ${depth * 16}px` };
    elements.push(panel);
    if (detailed.length > 1) {
      const tokens = new Set(steps.map(step => (step.icon as { token: string }).token));
      compactable.push({ row, panel, detailed,
        compact: iconLine(detailed.map(line => String(line.content)).join('\n'), tokens.size === 1 ? [...tokens][0]! : 'setting-inter_outlined') });
    }
    components += 1 + body.length;
  }
  const overflow = ordered.filter(row => !chosen.has(row));
  if (overflow.length) {
    const active = overflow.filter(row => row.status === 'running');
    const pages = Math.max(1, Math.ceil(active.length / SUBAGENT_PAGE_ROWS));
    const page = (input.page ?? 0) % pages;
    const body: CardElement[] = [];
    if (cardKey) for (const row of active.slice(page * SUBAGENT_PAGE_ROWS, (page + 1) * SUBAGENT_PAGE_ROWS)) body.push(iconLine(title(row, false), RUNTIME_SUBAGENT_ICON), ...stop(row));
    else if (active.length) body.push(iconLine(active.map(row => title(row, false)).join('\n'), RUNTIME_SUBAGENT_ICON));
    const other = overflow.filter(row => row.status !== 'running' && row.status !== 'completed').map(row => title(row, false));
    const completed = overflow.filter(row => row.status === 'completed').length;
    if (completed) other.push(`另有 ${completed} 个已完成`);
    if (other.length) body.push(iconLine(other.join('\n'), RUNTIME_SUBAGENT_ICON));
    if (cardKey && pages > 1) body.push({ tag: 'button', element_id: 'sp_next', type: 'default', size: 'small',
      text: { tag: 'plain_text', content: `下一页（${page + 1}/${pages}）` },
      behaviors: [{ type: 'callback', value: { a: 'run.subPage', m: cardKey, p: (page + 1) % pages } }] });
    elements.push({ ...processPanel(`另有 ${overflow.length} 个子 agent`, body, false, { icon: RUNTIME_SUBAGENT_ICON, spacing: 8 }), element_id: 'sa_more' });
    components += 1 + body.length;
  }
  const overhead = elements.filter(element => element.tag === 'collapsible_panel').length * 2;
  // Like the parent process, compact dense batches without dropping steps,
  // results, identities or controls. Keep active agents detailed first.
  for (const candidate of compactable.sort((a, b) => rank(b.row) - rank(a.row))) {
    if (components + overhead <= SUBAGENT_COMPONENT_BUDGET) break;
    const body = candidate.panel.elements as CardElement[];
    candidate.panel.elements = [candidate.compact, ...body.slice(candidate.detailed.length)];
    components -= candidate.detailed.length - 1;
  }
  return { elements, components };
}
