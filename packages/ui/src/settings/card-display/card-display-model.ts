import type {CardJson, CardNode} from './FeishuCardPreview';
import {previewFrames, previewLayoutInputs} from './card-preview-frames';

import {allowedSlots, compileCardDisplay, contextRulesFor, defaultCardDisplay, interpolate, isShown, modeNames, slotNames, variablesFor} from '@vonvon/protocol';
import type {CardBlock, CardDisplayDraft, CardSlot, ContextRules, DisplayMode, BlockKind, CardDisplayLayoutParts, CardDisplayValues} from '@vonvon/protocol';
export {allowedSlots, contextRulesFor, defaultCardDisplay, interpolate, isShown, modeNames, slotNames, variablesFor} from '@vonvon/protocol';
export type {CardBlock, CardDisplayDraft, CardSlot, ContextRules, DisplayMode, BlockKind} from '@vonvon/protocol';

export type PreviewFrame = 'thinking' | 'tool' | 'streaming' | 'done';
export type CardDisplaySnapshot = {saved?: CardDisplayDraft | null; effective?: CardDisplayDraft | null; revision: string};
export type CardDisplayConflictSnapshot = CardDisplaySnapshot & {parentRevisionAtConflict: string};
export const currentCardDisplaySnapshot = (current: CardDisplaySnapshot, conflict?: CardDisplayConflictSnapshot): CardDisplaySnapshot => conflict && current.revision === conflict.parentRevisionAtConflict ? conflict : current;
export const customScriptCount = (draft: CardDisplayDraft): number => draft.blocks.filter(block => block.kind === 'custom' && block.source === 'script').length;
export const revisionOnOpen = (hasRetainedDraft: boolean, previousRevision: string, currentRevision: string): string => hasRetainedDraft ? previousRevision : currentRevision;
export function customBlock(index: number): CardBlock {
  return {appearance: 'text', size: 'notation', color: 'auto', warning: false, warningAt: 80,
    source: 'script', sample: '{"branch":"feature/card-style"}', language: 'node',
    id: `custom-${index}`, kind: 'custom', name: '工作区信息', slot: 'bottom-left', mode: 'always',
    template: '分支 {{branch}}',
    script: `// 输入是本轮运行数据，输出是模板可用的 JSON 字段\nconst {execFileSync} = require('node:child_process');\nconst branch = execFileSync('git', ['branch', '--show-current'], {encoding: 'utf8'}).trim();\nconsole.log(JSON.stringify({branch}));`};
}
const record = (value: unknown): CardNode => value && typeof value === 'object' && !Array.isArray(value) ? value as CardNode : {};
const nodes = (value: unknown): CardNode[] => Array.isArray(value) ? value as CardNode[] : [];
export function variableData(frame: PreviewFrame, usage?: number): Record<string, unknown> {
  const percent = usage ?? (frame === 'done' ? 80 : 78);
  return {context: {percent, used: usage === undefined ? frame === 'done' ? '380k' : '371k' : `${Math.round(475 * percent / 100)}k`, window: '475k', mark: ''}, model: {name: 'gpt-6.1-sol', effort: '极高'}, elapsed: {label: frame === 'done' ? '用时' : '已处理', value: frame === 'thinking' ? '1秒' : frame === 'tool' ? '4秒' : '9秒'}, status: {label: frame === 'thinking' ? '正在处理' : frame === 'tool' ? '正在调用工具' : frame === 'streaming' ? '正在输出' : ''}};
}
export type PreviewLayoutInput = {parts: CardDisplayLayoutParts; values: CardDisplayValues};

function callback(node: CardNode): string | undefined {
  return nodes(node.behaviors).map(behavior => record(behavior.value).a).find((value): value is string => typeof value === 'string');
}
function visit(nodesToVisit: CardNode[], action: (node: CardNode) => void) {
  for (const node of nodesToVisit) {
    action(node);
    visit([...nodes(node.elements), ...nodes(node.columns)], action);
  }
}
function markRow(row: CardNode | undefined, left: CardSlot, right: CardSlot, visible: CardBlock[]) {
  if (!row) return;
  const columns = nodes(row.columns);
  for (const [index, slot] of [left, right].entries()) {
    const column = columns[index];
    if (!column) continue;
    column.preview_slot = slot;
    column.preview_slot_label = slotNames[slot];
    nodes(column.elements).forEach((node, item) => {const block = visible.filter(block => block.slot === slot)[item]; if (block) node.preview_component = block.id;});
  }
}
function tagPreview(card: CardJson, base: CardJson, config: CardDisplayDraft, input: PreviewLayoutInput, frame: PreviewFrame, values: CardDisplayValues, scriptValues: Record<string, Record<string, unknown>>): CardJson {
  const phase = frame === 'done' ? 'done' : 'running';
  const percent = Number(record(values.context).percent);
  const visible = config.blocks.filter(block => {
    if (!isShown(block, phase) || block.mode === 'off') return false;
    if (block.kind === 'thinking' || block.kind === 'tools' || block.kind === 'status' && phase === 'done') return false;
    if (block.kind === 'stop' && (phase === 'done' || config.reply?.streamText === false)) return false;
    if (block.kind === 'context' && (!Number.isFinite(percent) || percent < contextRulesFor(block).showFrom)) return false;
    if (block.kind === 'custom' && block.source === 'script' && (!scriptValues[block.id] || interpolate(block.template,{...values,...scriptValues[block.id]}).missing.length)) return false;
    return true;
  });
  const at = (slot: CardSlot) => visible.filter(block => block.slot === slot);
  const topRowCount = at('top-left').length || at('top-right').length ? 1 : 0;
  const bottomRowCount = at('bottom-left').length || at('bottom-right').length ? 1 : 0;
  const output = card.body.elements;
  const topCount = at('top').length, bottomCount = at('bottom').length;
  const excluded = new Set([input.parts.contextIndex,input.parts.processIndex,input.parts.statusIndex,input.parts.modelIndex,input.parts.controlsIndex].filter((index): index is number => index !== undefined));
  const answerRemoved = phase === 'running' && config.reply?.streamText === false
    ? input.parts.answerIndices.filter(index => !excluded.has(index)).length : 0;
  const mainCount = base.body.elements.length - excluded.size - answerRemoved;
  const controls = input.parts.controlsIndex === undefined ? undefined : base.body.elements[input.parts.controlsIndex];
  let otherControl = false;
  if (controls) visit([controls], node => {if (node.tag === 'button' && callback(node) !== 'run.stop') otherControl = true;});
  const stopAction = visible.some(block => block.kind === 'stop' && (block.slot === 'actions-left' || block.slot === 'actions-right'));
  const controlsCount = otherControl || stopAction ? 1 : 0;
  const processCount = Math.max(0, output.length - topRowCount - topCount - mainCount - bottomRowCount - bottomCount - controlsCount);
  let index = 0;
  if (topRowCount) markRow(output[index++], 'top-left', 'top-right', visible);
  for (const block of at('top')) {
    const node = output[index++];
    if (node) {node.preview_component = block.id; node.preview_slot = 'top'; node.preview_slot_label = slotNames.top;}
  }
  if (processCount) {
    const process = output[index];
    if (process) {
      process.preview_slot = 'process'; process.preview_slot_label = slotNames.process;
      const time = visible.find(block => block.kind === 'time' && block.slot === 'process');
      if (time) {
        if (process.tag === 'collapsible_panel') {
          const title = record(process.header).title as CardNode | undefined;
          if (title) title.preview_component = time.id;
        } else process.preview_component = time.id;
      }
      if (process.tag === 'collapsible_panel') {
        const tools = config.blocks.find(block => block.kind === 'tools' && isShown(block, phase) && block.mode !== 'off');
        const thinking = config.blocks.find(block => block.kind === 'thinking' && isShown(block, phase) && block.mode !== 'off');
        const childKinds = input.parts.processChildKinds ?? [];
        const shownKinds = childKinds.filter(kind => kind === 'other' || kind === 'tool' && tools || kind === 'thinking' && thinking);
        nodes(process.elements).forEach((child, childIndex) => {
          if (shownKinds[childIndex] === 'tool' && tools) child.preview_component = tools.id;
          if (shownKinds[childIndex] === 'thinking' && thinking) child.preview_component = thinking.id;
        });
      }
    }
  }
  index += processCount + mainCount;
  if (bottomRowCount) markRow(output[index++], 'bottom-left', 'bottom-right', visible);
  for (const block of at('bottom')) {
    const node = output[index++];
    if (node) {node.preview_component = block.id; node.preview_slot = 'bottom'; node.preview_slot_label = slotNames.bottom;}
  }
  const stop = visible.find(block => block.kind === 'stop');
  if (stop) visit(output, node => {if (node.tag === 'button' && callback(node) === 'run.stop') node.preview_component = stop.id;});
  return card;
}

/** Apply the same native layout compiler as production, then add editor-only hit targets. */
export function composeCard(base: CardJson, draft: CardDisplayDraft, frame: PreviewFrame, _editing: boolean, usage?: number, layout: PreviewLayoutInput = previewLayoutInputs[frame]): CardJson {
  const values: CardDisplayValues = structuredClone(layout.values);
  if (usage !== undefined) values.context = {...record(values.context), percent: usage, used: `${Math.round(475 * usage / 100)}k`};
  const scriptValues: Record<string, Record<string, unknown>> = {};
  for (const block of draft.blocks.filter(block => block.kind === 'custom' && block.source === 'script')) {
    try {scriptValues[block.id] = record(JSON.parse(block.sample));} catch {scriptValues[block.id] = {};}
  }
  const card = compileCardDisplay(base, draft, {phase: frame === 'done' ? 'done' : 'running', values, parts: layout.parts, scriptValues}) as CardJson;
  return tagPreview(card, base, draft, layout, frame, values, scriptValues);
}
export function safeComposeCard(base: CardJson, draft: CardDisplayDraft, frame: PreviewFrame, usage?: number, layout: PreviewLayoutInput = previewLayoutInputs[frame], fallback?: CardJson): {card: CardJson; error?: string} {
  try {return {card: composeCard(base,draft,frame,false,usage,layout)};}
  catch (failure) {return {card: fallback ?? base, error: failure instanceof Error ? failure.message : '暂时无法预览当前草稿。'};}
}
export {parseCardDisplay} from '@vonvon/protocol';
