import type {CardJson, CardNode} from './FeishuCardPreview';
import {previewFrames, previewLayoutInputs} from './card-preview-frames';

import {CARD_DISPLAY_REMINDER_EID, allowedSlots, compileCardDisplay, contextRulesFor, defaultCardDisplay, interpolate, isShown, modeNames, slotNames, variablesFor} from '@vonvon/protocol';
import type {CardBlock, CardDisplayDraft, CardSlot, ContextRules, DisplayMode, BlockKind, CardDisplayLayoutParts, CardDisplayValues} from '@vonvon/protocol';
export {allowedSlots, contextRulesFor, defaultCardDisplay, interpolate, isShown, modeNames, slotNames, variablesFor} from '@vonvon/protocol';
export type {CardBlock, CardDisplayDraft, CardSlot, ContextRules, DisplayMode, BlockKind} from '@vonvon/protocol';

export type PreviewFrame = 'thinking' | 'tool' | 'streaming' | 'done';
/** Older saved cards gain the editor handle without causing a write until the user changes it. */
export function withReminderBlock(draft: CardDisplayDraft): CardDisplayDraft {
  if (draft.blocks.some(block => block.kind === 'reminder')) return draft;
  const reminder = defaultCardDisplay().blocks.find(block => block.kind === 'reminder');
  return reminder ? {...draft, blocks:[...draft.blocks, structuredClone(reminder)]} : draft;
}
export type CompletionReminderDraft = {completionMode: 'manual' | 'long' | 'failures' | 'always'; longTaskMinutes: number; completionTemplate: string | null};
export type CardDisplayEditorDraft = CompletionReminderDraft & {cardDisplay: CardDisplayDraft; resetReminder?: true};
export type CardDisplayEditorPatch = Partial<CompletionReminderDraft> & {cardDisplay?: CardDisplayDraft | null};
export const defaultCompletionReminder = (): CompletionReminderDraft => ({completionMode:'failures', longTaskMinutes:3, completionTemplate:null});
export type CardDisplaySnapshot = Partial<CompletionReminderDraft> & {saved?: CardDisplayDraft | null; revision: string};
export const cardDisplayEditorBaseline = (snapshot: CardDisplaySnapshot): CardDisplayEditorDraft => ({cardDisplay:withReminderBlock(snapshot.saved ?? defaultCardDisplay()), completionMode:snapshot.completionMode ?? defaultCompletionReminder().completionMode, longTaskMinutes:snapshot.longTaskMinutes ?? defaultCompletionReminder().longTaskMinutes, completionTemplate:snapshot.completionTemplate ?? null});
export function cardDisplayEditorPatch(value: CardDisplayEditorDraft, baseline: CardDisplayEditorDraft): CardDisplayEditorPatch {
  const patch: CardDisplayEditorPatch = {};
  const cardDisplay = cardDisplaySaveValue(value.cardDisplay);
  if (value.resetReminder || JSON.stringify(cardDisplay) !== JSON.stringify(cardDisplaySaveValue(baseline.cardDisplay))) patch.cardDisplay = cardDisplay;
  // Preserve inherited reminder fields unless the user actually edits them.
  if (value.resetReminder || value.completionMode !== baseline.completionMode) patch.completionMode = value.completionMode;
  if (value.resetReminder || value.longTaskMinutes !== baseline.longTaskMinutes) patch.longTaskMinutes = value.longTaskMinutes;
  if (value.resetReminder || value.completionTemplate !== baseline.completionTemplate) patch.completionTemplate = value.completionTemplate;
  return patch;
}
export type CardDisplayConflictSnapshot = CardDisplaySnapshot & {parentRevisionAtConflict: string};
export const currentCardDisplaySnapshot = (current: CardDisplaySnapshot, conflict?: CardDisplayConflictSnapshot): CardDisplaySnapshot => conflict && current.revision === conflict.parentRevisionAtConflict ? conflict : current;
export const cardDisplaySaveValue = (draft: CardDisplayDraft): CardDisplayDraft | null => {const normalized = withReminderBlock(draft); return JSON.stringify(normalized) === JSON.stringify(defaultCardDisplay()) ? null : normalized;};
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

type AnswerParts = Pick<CardDisplayLayoutParts, 'answerIndices'>;
function streamPreviewAnswer(base: CardJson, parts: AnswerParts) {
  for (const index of [...parts.answerIndices].reverse()) {
    const node = base.body.elements[index];
    if (!node || node.tag !== 'markdown' && node.tag !== 'div') continue;
    if (typeof node.content === 'string') return {index,node,content:node.content,nested:false};
    const text = record(node.text);
    if (typeof text.content === 'string') return {index,node,content:text.content,nested:true};
  }
}
/** Reveal only the last native answer; tool, reasoning and action nodes retain their original structure. */
export function streamPreviewCard(base: CardJson, parts: AnswerParts, visibleCharacters: number): CardJson {
  const answer = streamPreviewAnswer(base, parts);
  if (!answer) return base;
  const content = Array.from(answer.content).slice(0, Math.max(0, Math.floor(visibleCharacters))).join('');
  if (content === answer.content) return base;
  const elements = [...base.body.elements];
  elements[answer.index] = answer.nested
    ? {...answer.node, text:{...record(answer.node.text),content}}
    : {...answer.node,content};
  return {...base,body:{...base.body,elements}};
}
export function streamPreviewLength(base: CardJson, parts: AnswerParts): number {
  const answer = streamPreviewAnswer(base, parts);
  return answer ? Array.from(answer.content).length : 0;
}

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
  const controls = input.parts.controlsIndex === undefined ? undefined : base.body.elements[input.parts.controlsIndex];
  let nativeStop = false, nativeReminder = input.parts.reminderIndex !== undefined && Boolean(base.body.elements[input.parts.reminderIndex]);
  if (controls) visit([controls], node => {
    if (node.tag === 'button' && callback(node) === 'run.stop') nativeStop = true;
    if (node.tag === 'button' && (callback(node) === 'run.remind' || node.disabled === true && node.element_id === CARD_DISPLAY_REMINDER_EID)) nativeReminder = true;
  });
  const hasReminderBlock = config.blocks.some(block => block.kind === 'reminder');
  const visible = config.blocks.filter(block => {
    if (!isShown(block, phase) || block.mode === 'off') return false;
    if (block.kind === 'thinking' || block.kind === 'tools' || block.kind === 'status' && phase === 'done') return false;
    if ((block.kind === 'stop' || block.kind === 'reminder') && (phase === 'done' || config.reply?.streamText === false || !(block.kind === 'stop' ? nativeStop : nativeReminder))) return false;
    if (block.kind === 'context' && (!Number.isFinite(percent) || percent < contextRulesFor(block).showFrom)) return false;
    if (block.kind === 'custom' && block.source === 'script' && (!scriptValues[block.id] || interpolate(block.template,{...values,...scriptValues[block.id]}).missing.length)) return false;
    return true;
  });
  const at = (slot: CardSlot) => visible.filter(block => block.slot === slot);
  const topRowCount = at('top-left').length || at('top-right').length ? 1 : 0;
  const bottomRowCount = at('bottom-left').length || at('bottom-right').length ? 1 : 0;
  const output = card.body.elements;
  const topCount = at('top').length, bottomCount = at('bottom').length;
  const excluded = new Set([input.parts.contextIndex,input.parts.processIndex,input.parts.statusIndex,input.parts.modelIndex,input.parts.controlsIndex,...(hasReminderBlock || config.reply?.streamText === false) && input.parts.reminderIndex !== undefined ? [input.parts.reminderIndex] : []].filter((index): index is number => index !== undefined));
  const toolsBlock = config.blocks.find(block => block.kind === 'tools');
  const showSubagents = config.reply?.streamText !== false && Boolean(toolsBlock && isShown(toolsBlock, phase) && toolsBlock.mode !== 'off');
  const mainCount = base.body.elements.filter((_node, index) => !excluded.has(index)
    && (phase === 'done' || config.reply?.streamText !== false || !input.parts.answerIndices.includes(index))
    && (showSubagents || !input.parts.subagentIndices?.includes(index))).length;
  const controlsCount = output.some(node => node.element_id === 'controls') ? 1 : 0;
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
  if (stop) visit(output, node => {if (node.tag === 'button' && callback(node) === 'run.stop') {node.preview_component = stop.id; node.preview_slot = stop.slot;}});
  const reminder = visible.find(block => block.kind === 'reminder');
  if (reminder) visit(output, node => {
    if (node.element_id === CARD_DISPLAY_REMINDER_EID || node.tag === 'button' && callback(node) === 'run.remind') {node.preview_component = reminder.id; node.preview_slot = reminder.slot;}
  });
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
