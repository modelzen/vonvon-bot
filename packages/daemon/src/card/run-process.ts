// Adapted from vonvon-dsh's ordered Feishu process presentation.
import { md as markdown, type CardElement } from './cards';
import { processPanel } from './process-panel';
import { renderRichText } from './markdown-render';
import { toolPresentation, toolArguments } from './tool-presentation';
import { statusSymbol } from './process-status';
import { compactionLine } from './context-gauge';
import { blockKey } from './run-segment';
import { makePreview, wrapCodeFence } from './content-split';
import type { Block, ToolEntry, RunState, Terminal } from './run-state';

const PROCESS_BODY_BUDGET = 22_000;
const PROCESS_COMPONENT_BUDGET = 120;
const DETAIL_MAX = 4_000;
const OUTPUT_MAX = 1_200;
const COMPACT_GROUP_BUDGET = 18_000;

export interface OverflowAttachmentView {
  readonly status: 'streaming' | 'pending' | 'sent' | 'failed';
  readonly label: string;
  readonly preview: string;
  readonly bytes: number;
  readonly fileName?: string;
  readonly messageLink?: string;
  readonly error?: string;
}

export function formatOverflowAttachmentNotice(view: OverflowAttachmentView): string {
  if (view.status === 'streaming') {
    return `_（${view.label}超出单卡容量，生成完成后将通过附件提供完整原文…）_`;
  }
  if (view.status === 'pending') {
    return `_（${view.label}超出单卡容量，正在通过附件发送完整原文…）_`;
  }
  if (view.status === 'sent') {
    const fileLabel = view.fileName ?? '完整内容.txt';
    const ref = view.messageLink ? `[${fileLabel}](${view.messageLink})` : `\`${fileLabel}\``;
    return `📎 完整原文已通过附件发送：${ref}`;
  }
  const detail = view.error ? `（${view.error}）` : '';
  return `_（${view.label}超出单卡容量，附件发送失败${detail}，以上为截断预览）_`;
}

export function formatOverflowAttachmentMarkdown(view: OverflowAttachmentView): string {
  const notice = formatOverflowAttachmentNotice(view);
  return view.preview ? `${view.preview}\n\n${notice}` : notice;
}

/** Complete untruncated text record of a single tool operation for attachment upload. */
export function formatToolAttachmentText(tool: ToolEntry): string {
  const presentation = toolPresentation(tool);
  const command = commandFor(tool);
  const parts: string[] = [`# ${presentation.label}`];
  if (command !== undefined) {
    parts.push(`## 命令\n${command}`);
    const args = extraToolArguments(tool, command);
    if (args) parts.push(`## 调用参数\n${args}`);
  } else if (tool.detail !== undefined) {
    parts.push(`## 调用参数\n${tool.detail}`);
  } else {
    parts.push(`## 操作\n${tool.title}`);
  }
  if (tool.output !== undefined && tool.output !== '') {
    parts.push(`## ${tool.status === 'error' ? '错误' : '输出'}\n${tool.output}`);
  }
  if (tool.exitCode !== undefined && tool.exitCode !== null) {
    parts.push(`## 退出码\n${String(tool.exitCode)}`);
  }
  return parts.join('\n\n');
}

export function createToolOverflowView(
  tool: ToolEntry,
  status: OverflowAttachmentView['status'] = 'pending',
  extra: Partial<Pick<OverflowAttachmentView, 'fileName' | 'messageLink' | 'error'>> = {},
): OverflowAttachmentView {
  const raw = formatToolAttachmentText(tool);
  const command = commandFor(tool);
  const previewSource = command ?? tool.detail ?? tool.title;
  const preview = command !== undefined
    ? `**命令（预览）**\n${wrapCodeFence(previewSource.length > 360 ? `${previewSource.slice(0, 360).trimEnd()}\n…` : previewSource, 'bash')}`
    : makePreview(previewSource, 'tool');
  return {
    status,
    label: command !== undefined ? '该条命令' : '该项工具操作',
    preview,
    bytes: Buffer.byteLength(raw, 'utf8'),
    ...extra,
  };
}

interface ProcessUnit {
  readonly element: CardElement;
  readonly itemCount: number;
  readonly kind: 'tool' | 'thinking' | 'other';
  /** a compaction line: one short line, never dropped for the budget */
  readonly marker?: boolean;
}

export interface ProcessBodyOptions {
  readonly images?: ReadonlyMap<string, string>;
  readonly componentBudget?: number;
  readonly live?: boolean;
  /** Render full rich elements without compact-mode output erasure or omission.
   * Used when multi-card continuation owns capacity pagination. */
  readonly unbounded?: boolean;
  readonly overflowAttachments?: ReadonlyMap<string, OverflowAttachmentView>;
}

/** `live`: the run is still going, so an unfinished compaction reads as in progress. */
export function buildProcessBody(
  blocks: readonly Block[],
  images?: ReadonlyMap<string, string>,
  componentBudget = PROCESS_COMPONENT_BUDGET,
  live = false,
): CardElement[] {
  return buildProcessBodyWithKinds(blocks, images, componentBudget, live).elements;
}

export function buildProcessBodyWithKinds(
  blocks: readonly Block[],
  images?: ReadonlyMap<string, string>,
  componentBudget = PROCESS_COMPONENT_BUDGET,
  live = false,
  opts?: { readonly unbounded?: boolean; readonly overflowAttachments?: ReadonlyMap<string, OverflowAttachmentView> },
): { elements: CardElement[]; kinds: Array<'tool' | 'thinking' | 'other'> } {
  const rich = processUnits(blocks, false, live, images, opts?.overflowAttachments);
  const richElements = rich.map(unit => unit.element);
  if (opts?.unbounded || fitsProcessBudget(richElements, 0, componentBudget)) {
    return { elements: richElements, kinds: rich.map(unit => unit.kind) };
  }

  // Emergency single-card safety bound (used only when continuation cannot create a card
  // or by standalone single-card callers).
  const compact = processUnits(blocks, true, live, images, opts?.overflowAttachments);
  const compactElements = compact.map(unit => unit.element);
  if (fitsProcessBudget(compactElements, 0, componentBudget)) {
    return { elements: compactElements, kinds: compact.map(unit => unit.kind) };
  }

  const kept: ProcessUnit[] = [];
  let omitted = 0;
  for (const unit of compact) {
    // Compaction lines always stay; from the first unit that doesn't fit, the rest are omitted.
    if (unit.marker || (omitted === 0 && fitsProcessBudget([...kept.map(item => item.element), unit.element], 512, componentBudget))) {
      kept.push(unit);
    } else {
      omitted += unit.itemCount;
    }
  }
  if (omitted > 0) kept.push({ element: markdown(`_…后续 ${String(omitted)} 项过程已省略（卡片容量限制）_`), itemCount: 0, kind: 'other' });
  return { elements: kept.map(unit => unit.element), kinds: kept.map(unit => unit.kind) };
}

function fitsProcessBudget(
  elements: readonly CardElement[],
  reserve = 0,
  componentBudget = PROCESS_COMPONENT_BUDGET,
): boolean {
  return Buffer.byteLength(JSON.stringify(elements), 'utf8') + reserve <= PROCESS_BODY_BUDGET
    && estimateComponents(elements) + (reserve > 0 ? 1 : 0) <= componentBudget;
}

function processUnits(
  blocks: readonly Block[],
  compactTools: boolean,
  live: boolean,
  images?: ReadonlyMap<string, string>,
  overflowAttachments?: ReadonlyMap<string, OverflowAttachmentView>,
): ProcessUnit[] {
  const units: ProcessUnit[] = [];
  let tools: ToolEntry[] = [];
  const flushTools = (): void => {
    if (compactTools) units.push(...compactToolUnits(tools, overflowAttachments));
    else if (tools.length === 1) units.push({ element: toolPanel(tools[0]!, overflowAttachments), itemCount: 1, kind: 'tool' });
    else if (tools.length > 1) units.push({
      element: processPanel(
        toolGroupTitle(tools),
        tools.map(tool => toolPanel(tool, overflowAttachments)),
        false,
        { icon: toolPresentation(tools[0]!).icon, spacing: 8, titleColor: false },
      ),
      itemCount: tools.length,
      kind: 'tool',
    });
    tools = [];
  };

  for (const block of blocks) {
    if (block.kind === 'tool') {
      tools.push(block.tool);
      continue;
    }
    if (block.kind === 'compaction') {
      flushTools();
      units.push({ element: compactionLine(block.compaction, live), itemCount: 1, marker: true, kind: 'other' });
      continue;
    }
    if (block.content.trim() === '') continue;
    flushTools();
    const overflow = overflowAttachments?.get(blockKey(block));
    const content = overflow ? formatOverflowAttachmentMarkdown(overflow) : block.content;
    const elements = renderRichText(content, images);
    elements.forEach(element => units.push({ element, itemCount: 1, kind: block.kind === 'reasoning' ? 'thinking' : 'other' }));
  }
  flushTools();
  return units;
}

function compactToolUnits(
  tools: readonly ToolEntry[],
  overflowAttachments?: ReadonlyMap<string, OverflowAttachmentView>,
): ProcessUnit[] {
  const units: ProcessUnit[] = [];
  let batch: ToolEntry[] = [];
  let entries: string[] = [];
  const flush = (): void => {
    if (!batch.length) return;
    units.push({
      element: processPanel(
        toolGroupTitle(batch),
        [markdown(entries.join('\n\n'))],
        false,
        { icon: toolPresentation(batch[0]!).icon, spacing: 8, titleColor: false },
      ),
      itemCount: batch.length,
      kind: 'tool',
    });
    batch = [];
    entries = [];
  };

  for (const tool of tools) {
    const entry = compactToolEntry(tool, overflowAttachments);
    const candidate = processPanel(
      toolGroupTitle([...batch, tool]),
      [markdown([...entries, entry].join('\n\n'))],
      false,
      { icon: toolPresentation(batch[0] ?? tool).icon, spacing: 8, titleColor: false },
    );
    if (batch.length && Buffer.byteLength(JSON.stringify(candidate), 'utf8') > COMPACT_GROUP_BUDGET) flush();
    batch.push(tool);
    entries.push(entry);
  }
  flush();
  return units;
}

function compactToolEntry(
  tool: ToolEntry,
  overflowAttachments?: ReadonlyMap<string, OverflowAttachmentView>,
): string {
  const presentation = toolPresentation(tool);
  const overflow = overflowAttachments?.get(`tool:${tool.id}`);
  if (overflow) {
    const parts = [`**${presentation.header}**`, formatOverflowAttachmentMarkdown(overflow)];
    if (tool.exitCode !== undefined && tool.exitCode !== null) parts.push(`**退出码** \`${String(tool.exitCode)}\``);
    return parts.join('\n\n');
  }
  const command = tool.kind === 'command' ? tool.title : presentation.command;
  const parts = [`**${presentation.header}**`];
  if (command !== undefined) {
    parts.push(wrapCodeFence(command, 'bash'));
    const args = extraToolArguments(tool, command);
    if (args) parts.push(`**调用参数**\n${wrapCodeFence(truncateWithNotice(args, DETAIL_MAX), 'json')}`);
  } else if (tool.detail !== undefined) {
    parts.push(`**调用参数**\n${wrapCodeFence(truncateWithNotice(tool.detail, DETAIL_MAX))}`);
  } else {
    parts.push(`**操作**\n${wrapCodeFence(tool.title)}`);
  }
  if (tool.exitCode !== undefined && tool.exitCode !== null) parts.push(`**退出码** \`${String(tool.exitCode)}\``);
  return parts.join('\n\n');
}

function toolPanel(
  tool: ToolEntry,
  overflowAttachments?: ReadonlyMap<string, OverflowAttachmentView>,
): CardElement {
  const presentation = toolPresentation(tool);
  const overflow = overflowAttachments?.get(`tool:${tool.id}`);
  const body = overflow
    ? [
        formatOverflowAttachmentMarkdown(overflow),
        ...(tool.exitCode !== undefined && tool.exitCode !== null ? [`**退出码** \`${String(tool.exitCode)}\``] : []),
      ].join('\n\n')
    : (toolBodyMarkdown(tool) || '_无输出_');
  return processPanel(
    presentation.header,
    [markdown(body)],
    false,
    { icon: presentation.icon, bodyIndent: 20, spacing: 8, titleColor: false },
  );
}

function toolBodyMarkdown(tool: ToolEntry): string {
  const command = commandFor(tool);
  const parts: string[] = [];
  if (command !== undefined) {
    parts.push(`**命令**\n${wrapCodeFence(command, 'bash')}`);
    const args = extraToolArguments(tool, command);
    if (args) parts.push(`**调用参数**\n${wrapCodeFence(truncateWithNotice(args, DETAIL_MAX), 'json')}`);
  } else if (tool.detail !== undefined) {
    parts.push(`**调用参数**\n${wrapCodeFence(truncateWithNotice(tool.detail, DETAIL_MAX))}`);
  } else {
    parts.push(`**操作**\n${wrapCodeFence(tool.title)}`);
  }

  if (tool.output !== undefined && tool.output !== '') {
    parts.push(`**${tool.status === 'error' ? '错误' : '输出'}**\n${wrapCodeFence(truncateWithNotice(tool.output, OUTPUT_MAX))}`);
  } else if (tool.kind === 'search' && tool.status === 'done') {
    parts.push('_（搜索结果已用于作答，不单独回传）_');
  }
  if (tool.exitCode !== undefined && tool.exitCode !== null) parts.push(`**退出码** \`${String(tool.exitCode)}\``);
  return parts.join('\n\n');
}

function commandFor(tool: ToolEntry): string | undefined {
  const presentation = toolPresentation(tool);
  return tool.kind === 'command' ? tool.title : presentation.command;
}

function extraToolArguments(tool: ToolEntry, command: string): string | undefined {
  const args = toolArguments(tool.detail);
  if (args) {
    const extra = Object.fromEntries(Object.entries(args).filter(([key, value]) => !((key === 'command' || key === 'cmd') && value === command)));
    return Object.keys(extra).length ? JSON.stringify(extra, null, 2) : undefined;
  }
  return tool.detail !== undefined && tool.detail !== command ? tool.detail : undefined;
}

function toolGroupTitle(tools: readonly ToolEntry[]): string {
  const unique = [...new Map(tools.map(tool => [tool.id, tool])).values()];
  const failed = unique.filter(tool => tool.status === 'error').length;
  const running = unique.some(tool => tool.status === 'running');
  const status = running ? 'running' : failed ? 'failed' : 'completed';
  return [`<font color='grey'>${unique.length} 项操作</font>`,
    failed ? `<font color='red'>· ${String(failed)} 项失败</font>` : '', statusSymbol(status)].filter(Boolean).join(' ');
}

function truncateWithNotice(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…\n（内容过长，已截断；完整内容 ${String(value.length)} 字符）` : value;
}

export function runElapsedMs(state: RunState, now = Date.now()): number | undefined {
  if (state.startedAt === undefined) return undefined;
  return Math.max(0, (state.completedAt ?? now) - state.startedAt);
}

export function processTitle(
  status: Terminal,
  elapsedMs?: number,
): string {
  const label = elapsedMs === undefined || !Number.isFinite(elapsedMs) ? '执行过程' : `${status === 'running' ? '已处理' : '用时'} ${formatElapsed(elapsedMs)}`;
  const mark = status === 'running' ? 'running' : status === 'done' ? 'completed'
    : status === 'interrupted' ? 'stopped' : status === 'error' ? 'failed' : 'unknown';
  return [`<font color='grey'>${label}${status === 'idle_timeout' ? ' · 已超时' : ''}</font>`, statusSymbol(mark)].filter(Boolean).join(' ');
}

export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  if (total === 0) return '不足 1 秒';
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);
  return [hours > 0 ? `${String(hours)}小时` : '', minutes > 0 ? `${String(minutes)}分钟` : '', seconds > 0 ? `${String(seconds)}秒` : ''].filter(Boolean).join(' ');
}

export function currentAnswerIndex(blocks: readonly Block[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind === 'tool' || block?.kind === 'compaction') return -1;
    if (block !== undefined && block.content.trim() !== '') return block.kind === 'text' ? index : -1;
  }
  return -1;
}

function estimateComponents(elements: readonly CardElement[]): number {
  return elements.reduce((total, element) => total + (element.tag === 'collapsible_panel' ? 4 : 1)
    + (Array.isArray(element.elements) ? estimateComponents(element.elements) : 0)
    + (Array.isArray(element.columns) ? estimateComponents(element.columns) : 0), 0);
}
