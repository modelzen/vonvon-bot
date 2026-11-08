import type {CardJson, CardNode} from './FeishuCardPreview';
import {previewFrames} from './card-preview-frames';

/** UI acceptance draft only. The daemon/CLI contract follows after visual acceptance. */
export type DisplayMode = 'off' | 'running' | 'done' | 'always';
export type CardSlot = 'top-left' | 'top-right' | 'top' | 'process' | 'bottom-left' | 'bottom-right' | 'bottom' | 'actions-left' | 'actions-right';
export type BlockKind = 'context' | 'model' | 'time' | 'status' | 'tools' | 'thinking' | 'stop' | 'custom';
export type ContextColor = 'yellow' | 'orange' | 'red';
export type ContextRules = {yellowAt: number; orangeAt: number; redAt: number; showFrom: number; enabledColors?: ContextColor[]};
export type CardBlock = {
  id: string; kind: BlockKind; name: string; slot: CardSlot; mode: DisplayMode;
  appearance: 'text' | 'percent' | 'bar' | 'icon'; template: string; size: 'notation' | 'normal'; color: 'auto' | 'grey' | 'blue';
  warning: boolean; warningAt: number; source: 'builtin' | 'script';
  script: string; language: 'node' | 'shell' | 'powershell'; sample: string;
  contextRules?: ContextRules;
};
export type CardDisplayDraft = {version: 1; blocks: CardBlock[]; reply?: {streamText: boolean; collapseAfterRun: boolean; flowModes?: Record<string, DisplayMode>}};
export type PreviewFrame = 'thinking' | 'tool' | 'streaming' | 'done';
export const slotNames: Record<CardSlot, string> = {'top-left': '上方左侧', 'top-right': '上方右侧', top: '上方整行', process: '执行过程', 'bottom-left': '下方左侧', 'bottom-right': '下方右侧', bottom: '下方整行', 'actions-left': '操作区左侧', 'actions-right': '操作区右侧'};
export const modeNames: Record<DisplayMode, string> = {off: '隐藏', running: '仅执行中', done: '仅完成后', always: '始终显示'};
const infoSlots: CardSlot[] = ['top-left', 'top-right', 'top', 'bottom-left', 'bottom-right', 'bottom'];
export const allowedSlots = (block: CardBlock): CardSlot[] => block.kind === 'stop' ? ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'actions-left', 'actions-right']
  : block.kind === 'tools' || block.kind === 'thinking' ? ['process']
  : block.kind === 'time' ? ['process', ...infoSlots] : block.kind === 'status' ? ['bottom-left', 'bottom-right'] : infoSlots;
const blank = {appearance: 'text' as const, size: 'notation' as const, color: 'auto' as const, warning: false, warningAt: 80, source: 'builtin' as const, script: '', language: 'node' as const, sample: '{\n  "branch": "feature/card-style",\n  "cost": "$0.04"\n}'};
export function defaultCardDisplay(): CardDisplayDraft {
  return {version: 1, reply: {streamText: true, collapseAfterRun: true}, blocks: [
    {...blank, id: 'context', kind: 'context', name: '上下文用量', slot: 'top', mode: 'always', template: '上下文 {{context.percent}}% · {{context.used}}/{{context.window}}', contextRules: {yellowAt: 70, orangeAt: 85, redAt: 95, showFrom: 0, enabledColors: ['yellow','orange','red']}},
    {...blank, id: 'time', kind: 'time', name: '执行耗时', slot: 'process', mode: 'always', size: 'normal', template: '{{elapsed.label}} {{elapsed.value}}'},
    {...blank, id: 'status', kind: 'status', name: '执行状态', slot: 'bottom-left', mode: 'running', template: '{{status.label}}'},
    {...blank, id: 'model', kind: 'model', name: '模型与思考强度', slot: 'bottom-right', mode: 'running', template: '{{model.name}} · {{model.effort}}'},
    {...blank, id: 'tools', kind: 'tools', name: '工具调用', slot: 'process', mode: 'always', template: ''},
    {...blank, id: 'thinking', kind: 'thinking', name: '思考内容', slot: 'process', mode: 'always', template: ''},
    {...blank, id: 'stop', kind: 'stop', name: '终止按钮', slot: 'actions-left', mode: 'running', appearance: 'icon', template: '终止'},
  ]};
}
export function customBlock(index: number): CardBlock {
  return {...blank, id: `custom-${index}`, kind: 'custom', name: '工作区信息', source: 'script', slot: 'bottom-left', mode: 'always', template: '{{branch}} · {{cost}}', script: `// 输入是本轮运行数据，输出是模板可用的 JSON 字段\nconst {execFileSync} = require('node:child_process');\nconst branch = execFileSync('git', ['branch', '--show-current'], {encoding: 'utf8'}).trim();\nconsole.log(JSON.stringify({branch}));`};
}
export function isShown(block: CardBlock, frame: PreviewFrame) {return block.mode === 'always' || block.mode === 'running' && frame !== 'done' || block.mode === 'done' && frame === 'done';}
export function contextRulesFor(block: CardBlock): ContextRules {
  if (block.contextRules) return {...block.contextRules, enabledColors: block.contextRules.enabledColors ?? ['yellow','orange','red']};
  const redAt = block.warning ? Math.max(2, Math.min(100, block.warningAt)) : 95;
  const orangeAt = Math.min(85, redAt - 1);
  return {yellowAt: Math.min(70, orangeAt - 1), orangeAt, redAt, showFrom: 0, enabledColors: ['yellow','orange','red']};
}
const record = (value: unknown): CardNode => value && typeof value === 'object' && !Array.isArray(value) ? value as CardNode : {};
const nodes = (value: unknown): CardNode[] => Array.isArray(value) ? value as CardNode[] : [];
const nodeText = (node: CardNode) => String(record(node.text).content ?? node.content ?? '');
export function variableData(frame: PreviewFrame, usage?: number): Record<string, unknown> {
  const percent = usage ?? (frame === 'done' ? 80 : 78);
  return {context: {percent, used: usage === undefined ? frame === 'done' ? '380k' : '371k' : `${Math.round(475 * percent / 100)}k`, window: '475k', mark: ''}, model: {name: 'gpt-6.1-sol', effort: '极高'}, elapsed: {label: frame === 'done' ? '用时' : '已处理', value: frame === 'thinking' ? '1秒' : frame === 'tool' ? '4秒' : '9秒'}, status: {label: frame === 'thinking' ? '正在处理' : frame === 'tool' ? '正在调用工具' : frame === 'streaming' ? '正在输出' : ''}};
}
export function interpolate(template: string, data: Record<string, unknown>): {text: string; missing: string[]} {
  const missing: string[] = [];
  const text = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const value = key.split('.').reduce<unknown>((current, part) => Object.hasOwn(record(current), part) ? record(current)[part] : undefined, data);
    if (value === undefined || value === null || typeof value === 'object') {missing.push(key); return '—';}
    return String(value);
  }).trim();
  return {text, missing};
}
export const variablesFor = (kind: BlockKind): string[] => kind === 'stop' ? [] : kind === 'context' ? ['context.percent', 'context.used', 'context.window']
  : kind === 'model' ? ['model.name', 'model.effort'] : kind === 'time' ? ['elapsed.label', 'elapsed.value'] : kind === 'status' ? ['status.label'] : ['branch', 'cost', 'model.name', 'context.percent'];

function withoutStopControl(node: CardNode): CardNode | undefined {
  if (node.tag === 'button' && record(node.icon).token === 'stop-record_filled') return undefined;
  const next = {...node};
  for (const key of ['elements', 'columns']) {
    if (Array.isArray(node[key])) next[key] = nodes(node[key]).map(withoutStopControl).filter((item): item is CardNode => Boolean(item));
  }
  if (next.tag === 'column' && !nodes(next.elements).length || next.tag === 'column_set' && !nodes(next.columns).length) return undefined;
  return next;
}

function findStopControl(node: CardNode): CardNode | undefined {
  if (node.tag === 'button' && record(node.icon).token === 'stop-record_filled') return node;
  for (const child of [...nodes(node.elements), ...nodes(node.columns)]) {
    const found = findStopControl(child);
    if (found) return found;
  }
  return undefined;
}

/** Layout only: copy actual generated elements; never add invented run-state text. */
export function composeCard(base: CardJson, draft: CardDisplayDraft, frame: PreviewFrame, editing: boolean, usage?: number): CardJson {
  const card = structuredClone(base);
  const data = variableData(frame, usage);
  const byKind = (kind: BlockKind) => draft.blocks.find(block => block.kind === kind);
  const showKind = (kind: BlockKind) => {const block = byKind(kind); return Boolean(block && isShown(block, frame));};
  let model: CardNode | undefined, status: CardNode | undefined, process: CardNode | undefined, stop: CardNode | undefined;
  const main: CardNode[] = [], controls: CardNode[] = [];
  function extract(elements: CardNode[]) {
    for (const node of elements) {
      if (node.tag === 'column_set' && node.element_id !== 'controls') {for (const column of nodes(node.columns)) extract(nodes(column.elements));}
      else if (node.tag === 'div' && nodeText(node).includes('上下文 ')) continue;
      else if (node.tag === 'markdown' && node.text_align === 'right') model = node;
      else if (node.tag === 'markdown' && record(node.icon).token) status = node;
      else if (node.element_id === 'controls') {controls.push(node); stop ??= findStopControl(node);}
      else if (!process && (node.tag === 'collapsible_panel' || /^(?:<font[^>]*>)?(?:已处理|用时)/.test(nodeText(node)))) process = node;
      else main.push(node);
    }
  }
  extract(card.body.elements);
  stop ??= previewFrames.streaming.body.elements.map(findStopControl).find((node): node is CardNode => Boolean(node));
  if (!model) {
    for (const node of previewFrames.streaming.body.elements) for (const column of nodes(node.columns)) {
      const found = nodes(column.elements).find(element => element.tag === 'markdown' && element.text_align === 'right');
      if (found) model = structuredClone(found);
    }
  }
  const slots = Object.fromEntries(Object.keys(slotNames).map(slot => [slot, [] as CardNode[]])) as Record<CardSlot, CardNode[]>;
  for (const block of draft.blocks) {
    if (!isShown(block, frame) || block.slot === 'process' || block.kind === 'tools' || block.kind === 'thinking' || block.kind === 'status' && frame === 'done') continue;
    if (block.kind === 'context' && Number(record(data.context).percent) < contextRulesFor(block).showFrom) continue;
    if (block.kind === 'stop') {
      if (frame === 'done' || draft.reply?.streamText === false || block.mode !== 'running' || !stop) continue;
      const button: CardNode = {...structuredClone(stop), preview_component: block.id};
      if (block.appearance === 'text') button.text = {tag: 'plain_text', content: interpolate(block.template, data).text || '终止'};
      else delete button.text;
      slots[block.slot].push(button);
      continue;
    }
    let values = data;
    if (block.kind === 'custom') {try {values = {...data, ...record(JSON.parse(block.sample))};} catch {values = {...data, branch: '—', cost: '—'};}}
    let content = interpolate(block.template, values).text;
    if (block.kind === 'context' && block.appearance === 'percent') content = `${record(data.context).percent}%`;
    let node: CardNode;
    const percent = Number(record(data.context).percent);
    const rules = contextRulesFor(block);
    const enabled = rules.enabledColors!;
    const contextColor = enabled.includes('red') && percent >= rules.redAt ? 'red' : enabled.includes('orange') && percent >= rules.orangeAt ? 'orange' : enabled.includes('yellow') && percent >= rules.yellowAt ? 'yellow' : 'grey';
    const configuredColor = block.color === 'auto' ? block.kind === 'context' ? contextColor : 'grey' : block.color;
    if (block.kind === 'context' && block.appearance === 'bar') {
      node = {tag: 'chart', chart_spec: {type: 'linearProgress', color: configuredColor, data: {values: [{value: Number(record(data.context).percent) / 100, label: '上下文'}]}}};
    } else if (block.kind === 'status' && status) node = {...status, content: `<font color='${configuredColor}'>${record(data.status).label}</font>`, text_size: block.size};
    else if (block.kind === 'model' && model && block.template === defaultCardDisplay().blocks.find(b => b.kind === 'model')!.template && block.color === 'auto') node = {...model, text_size: block.size};
    else node = {tag: 'markdown', content: configuredColor === 'grey' ? `<font color='grey'>${content}</font>` : `<font color='${configuredColor}'>${content}</font>`, text_size: block.size};
    slots[block.slot].push({...node, text_align: block.slot.endsWith('right') ? 'right' : 'left', preview_component: block.id});
  }
  const processElements: CardNode[] = [];
  if (process) {
    const time = byKind('time');
    const hasTime = Boolean(time && showKind('time') && time.slot === 'process');
    const timeTitle: CardNode = {tag:'markdown', content:`<font color='${time?.color === 'blue' ? 'blue' : 'grey'}'>${interpolate(time?.template ?? '', data).text}</font>`, text_size:time?.size ?? 'normal', preview_component:'time'};
    if (process.tag === 'collapsible_panel') {
      const children = draft.reply?.streamText === false ? [] : nodes(process.elements).filter(node => node.tag === 'collapsible_panel' ? showKind('tools') : showKind('thinking')).map(node => ({...node, preview_component: node.tag === 'collapsible_panel' ? 'tools' : 'thinking'}));
      const header = record(process.header);
      const title = hasTime ? timeTitle : {tag: 'markdown', content: "<font color='grey'>执行过程</font>", text_size: 'normal'};
      if (children.length) processElements.push({...process, expanded: frame === 'done' ? draft.reply?.collapseAfterRun === false : process.expanded, elements: children, header: {...header, title}, preview_slot: 'process', preview_slot_label: slotNames.process});
      else if (hasTime) processElements.push({...timeTitle, preview_slot: 'process', preview_slot_label: slotNames.process});
    } else if (hasTime) processElements.push({...timeTitle, preview_slot: 'process', preview_slot_label: slotNames.process});
  }
  if (!processElements.length && editing) processElements.push({tag: 'column', width: 'weighted', elements: [], preview_slot: 'process', preview_slot_label: slotNames.process});
  const column = (slot: CardSlot): CardNode => ({tag: 'column', width: 'weighted', weight: 1, elements: slots[slot], preview_slot: slot, preview_slot_label: slotNames[slot]});
  const row = (left: CardSlot, right: CardSlot): CardNode[] => editing || slots[left].length || slots[right].length ? [{tag: 'column_set', flex_mode: 'none', horizontal_spacing: '16px', columns: [column(left), column(right)]}] : [];
  const full = (slot: CardSlot): CardNode[] => slots[slot].length || editing ? [column(slot)] : [];
  const answerElements = frame !== 'done' && draft.reply?.streamText === false ? main.filter(node => node.element_id !== 'answer') : main;
  // Legacy drafts without a stop block keep the original control behavior.
  const shownControls = byKind('stop') || draft.reply?.streamText === false
    ? controls.map(withoutStopControl).filter((item): item is CardNode => Boolean(item))
    : controls;
  const actions = [...slots['actions-left'], ...slots['actions-right']];
  if (actions.length) {
    const original = shownControls[0];
    const actionColumn = (slot: 'actions-left' | 'actions-right'): CardNode => ({tag: 'column', width: slot === 'actions-right' ? 'weighted' : 'auto', weight: 1, elements: slots[slot], preview_slot: slot, preview_slot_label: slotNames[slot]});
    if (original?.tag === 'column_set') {
      shownControls[0] = {...original, columns: [
        ...(slots['actions-left'].length ? [actionColumn('actions-left')] : []),
        ...nodes(original.columns),
        ...(slots['actions-right'].length ? [actionColumn('actions-right')] : []),
      ]};
    } else {
      shownControls.unshift({tag: 'column_set', element_id: 'controls', flex_mode: 'flow', horizontal_spacing: 'small', columns: [
        ...(slots['actions-left'].length ? [actionColumn('actions-left')] : []),
        ...(slots['actions-right'].length ? [actionColumn('actions-right')] : []),
      ]});
    }
  }
  const topRow = row('top-left', 'top-right');
  const bottomRow = row('bottom-left', 'bottom-right');
  // When the stop button is the only control and moves into an info row, keep
  // the stable control-row id on its new carrier.
  if (!shownControls.some(node => node.element_id === 'controls')) {
    const carrier = [...topRow, ...bottomRow].find(node => nodes(node.columns).some(column => nodes(column.elements).some(element => element.preview_component === 'stop')));
    if (carrier) carrier.element_id = 'controls';
  }
  card.body.elements = [...topRow, ...full('top'), ...processElements, ...answerElements, ...bottomRow, ...full('bottom'), ...shownControls];
  return card;
}

export function parseCardDisplay(text: string): CardDisplayDraft {
  const value: unknown = JSON.parse(text);const root = record(value);
  if (root.version !== 1 || !Array.isArray(root.blocks) || root.blocks.length > 30) throw new Error('需要 version: 1 和最多 30 个显示组件。');
  if (root.reply !== undefined) {
    const reply = record(root.reply);
    if (typeof reply.streamText !== 'boolean' || typeof reply.collapseAfterRun !== 'boolean') throw new Error('回复行为需要正文显示方式与完成后收起设置。');
    if (reply.flowModes !== undefined && (typeof reply.flowModes !== 'object' || reply.flowModes === null || Array.isArray(reply.flowModes) ||
      Object.values(reply.flowModes).some(mode => !Object.hasOwn(modeNames, String(mode))))) throw new Error('回复模式里的过程组件显示方式无效。');
  }
  const ids = new Set<string>();
  for (const input of root.blocks as unknown[]) {
    const item = record(input);
    if (typeof item.id !== 'string' || ids.has(item.id) || !['context','model','time','status','tools','thinking','stop','custom'].includes(String(item.kind))) throw new Error('组件名称、类型或 ID 无效。');
    ids.add(item.id);
    if (item.contextRules !== undefined) {
      const rules = record(item.contextRules);
      const colors = ['yellow','orange','red'];
      const enabled = rules.enabledColors ?? colors;
      if (!Array.isArray(enabled) || enabled.some(color => !colors.includes(String(color))) || new Set(enabled).size !== enabled.length) throw new Error('上下文颜色需要选择黄色、橙色或红色，可以不启用任何颜色。');
      const thresholds = colors.filter(color => enabled.includes(color)).map(color => Number(rules[`${color}At`]));
      if (item.kind !== 'context' || ['yellowAt','orangeAt','redAt','showFrom'].some(key => typeof rules[key] !== 'number' || !Number.isInteger(rules[key]) || Number(rules[key]) < 0 || Number(rules[key]) > 100) || thresholds.some((value,index) => index > 0 && value <= thresholds[index - 1]!)) throw new Error('已启用的上下文颜色需要按黄色、橙色、红色递增，显示用量需要在 0–100% 之间。');
    }
    if (item.kind === 'status' && !['off','running'].includes(String(item.mode))) throw new Error('执行状态只在执行中存在，请选择 running 或 off。');
    if (item.kind === 'stop' && !['off','running'].includes(String(item.mode))) throw new Error('终止按钮只在执行中可用，请选择 running 或 off。');
    if (item.kind === 'stop' ? !['icon','text'].includes(String(item.appearance)) :
      item.kind === 'context' ? !['text','percent','bar'].includes(String(item.appearance)) : item.appearance !== 'text') throw new Error('组件显示形态与类型不匹配。');
    if (!Object.hasOwn(modeNames, String(item.mode)) || !Object.hasOwn(slotNames, String(item.slot)) || !['text','percent','bar','icon'].includes(String(item.appearance)) || typeof item.template !== 'string' || typeof item.name !== 'string' || !['notation','normal'].includes(String(item.size)) || !['auto','grey','blue'].includes(String(item.color)) || typeof item.warning !== 'boolean' || typeof item.warningAt !== 'number' || item.warningAt < 1 || item.warningAt > 100 || !['builtin','script'].includes(String(item.source)) || !['node','shell','powershell'].includes(String(item.language)) || typeof item.script !== 'string' || typeof item.sample !== 'string') throw new Error(`“${String(item.name)}”的显示设置不完整。`);
    if (!allowedSlots(item as CardBlock).includes(item.slot as CardSlot)) throw new Error(`“${String(item.name)}”不支持 ${String(item.slot)} 位置。`);
  }
  return value as CardDisplayDraft;
}
