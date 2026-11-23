import {contextRulesFor, interpolate, isShown, DEFAULT_REMINDER_TEMPLATE, DEFAULT_REMINDER_REQUESTED_TEMPLATE, type CardDisplayConfig, type CardDisplayBlock, type CardDisplaySlot, type CardDisplayValues} from './card-display.js';

/** The card builder supplies these positions while creating native elements. */
export type CardDisplayLayoutParts = {
  contextIndex: number;
  processIndex?: number;
  processChildKinds?: Array<'tool'|'thinking'|'other'>;
  statusIndex?: number;
  modelIndex?: number;
  statusElement?: CardDisplayElement;
  modelElement?: CardDisplayElement;
  controlsIndex?: number;
  /** Legacy standalone confirmation; newer native cards keep a disabled button in controls. */
  reminderIndex?: number;
  answerIndices: number[];
  subagentIndices?: number[];
};
export type CardDisplayLayoutInput = {
  phase: 'running' | 'done';
  values: CardDisplayValues;
  scriptValues?: Record<string, Record<string, unknown>>;
  parts: CardDisplayLayoutParts;
  strict?: boolean;
};
export type CardDisplayElement = Record<string, unknown>;
export type CardDisplayCard = Record<string, unknown>;
/** Independent orphan-healing anchor when the run stop button leaves controls. */
export const CARD_DISPLAY_STOP_EID = 'display_stop';
export const CARD_DISPLAY_REMINDER_EID = 'display_reminder';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const elements = (value: unknown): CardDisplayElement[] => Array.isArray(value) ? value as CardDisplayElement[] : [];
const slotOrder: CardDisplaySlot[] = ['top-left','top-right','top','process','bottom-left','bottom-right','bottom','actions-left','actions-right'];
const escaped = (value: string): string => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const fontColor = (block: CardDisplayBlock, percent: number): string => {
  if (block.color !== 'auto') return block.color;
  if (block.kind !== 'context') return 'grey';
  const rules = contextRulesFor(block), enabled = rules.enabledColors ?? [];
  return enabled.includes('red') && percent >= rules.redAt ? 'red' : enabled.includes('orange') && percent >= rules.orangeAt ? 'orange' : enabled.includes('yellow') && percent >= rules.yellowAt ? 'yellow' : 'grey';
};
const markdown = (text: string, block: CardDisplayBlock, color: string): CardDisplayElement => ({tag:'markdown',content:`<font color='${color}'>${escaped(text)}</font>`,text_size:block.size});
const column = (items: CardDisplayElement[], right = false): CardDisplayElement => ({tag:'column',width:'weighted',weight:1,elements:items.map(item => right ? {...item,text_align:'right'} : item)});
const row = (left: CardDisplayElement[], right: CardDisplayElement[]): CardDisplayElement | undefined => left.length || right.length ? {tag:'column_set',flex_mode:'none',horizontal_spacing:'16px',columns:[column(left),column(right,true)]} : undefined;
const callback = (node: CardDisplayElement): string | undefined => elements(node.behaviors).map(behavior => object(behavior.value).a).find((value):value is string => typeof value === 'string');

function findStop(node: CardDisplayElement): CardDisplayElement | undefined {
  if (node.tag === 'button' && callback(node) === 'run.stop') return node;
  for (const child of [...elements(node.elements),...elements(node.columns)]) {
    const found = findStop(child); if (found) return found;
  }
  return undefined;
}
const isReminder = (node: CardDisplayElement): boolean => node.tag === 'button'
  && (callback(node) === 'run.remind' || node.element_id === CARD_DISPLAY_REMINDER_EID && node.disabled === true);
function findReminder(node: CardDisplayElement): CardDisplayElement | undefined {
  if (isReminder(node)) return node;
  for (const child of [...elements(node.elements),...elements(node.columns)]) {
    const found = findReminder(child); if (found) return found;
  }
  return undefined;
}
function withoutReminder(node: CardDisplayElement): CardDisplayElement | undefined {
  if (isReminder(node)) return undefined;
  const next = {...node};
  for (const key of ['elements','columns']) if (Array.isArray(node[key])) next[key] = elements(node[key]).map(withoutReminder).filter((child):child is CardDisplayElement => Boolean(child));
  if (next.tag === 'column' && !elements(next.elements).length || next.tag === 'column_set' && !elements(next.columns).length) return undefined;
  return next;
}
function withoutStop(node: CardDisplayElement): CardDisplayElement | undefined {
  if (node.tag === 'button' && callback(node) === 'run.stop') return undefined;
  const next = {...node};
  for (const key of ['elements','columns']) if (Array.isArray(node[key])) next[key] = elements(node[key]).map(withoutStop).filter((child):child is CardDisplayElement => Boolean(child));
  if (next.tag === 'column' && !elements(next.elements).length || next.tag === 'column_set' && !elements(next.columns).length) return undefined;
  return next;
}

function contextBar(percent: number, color: string, block:CardDisplayBlock): CardDisplayElement {
  const palette:Record<string,string> = {grey:'#8F959E',blue:'#3370FF',yellow:'#F2B50A',orange:'#F57C23',red:'#F54A45'};
  const fill=palette[color] ?? palette.grey;
  const chart:CardDisplayElement={tag:'chart',height:'20px',preview:false,chart_spec:{type:'linearProgress',data:[{id:'context',values:[{name:'上下文',value:percent/100}]}],direction:'horizontal',xField:'value',yField:'name',color:[fill],padding:0,bandWidth:8,cornerRadius:4,progress:{style:{fill}},tooltip:{visible:false},axes:[{orient:'left',visible:false},{orient:'bottom',visible:false}]}};
  return {tag:'column_set',flex_mode:'none',horizontal_spacing:'8px',columns:[
    {tag:'column',width:'auto',vertical_align:'center',elements:[markdown('上下文',block,'grey')]},
    {tag:'column',width:'weighted',weight:1,vertical_align:'center',elements:[chart]},
    {tag:'column',width:'auto',vertical_align:'center',elements:[{...markdown(`${percent}%`,block,color),text_align:'right'}]},
  ]};
}

/** Pure JSON compiler shared by the native daemon and the web preview. */
export function compileCardDisplay(base: CardDisplayCard, config: CardDisplayConfig, input: CardDisplayLayoutInput): CardDisplayCard {
  const card = structuredClone(base);
  const body = object(card.body);
  if (!Array.isArray(body.elements)) throw new Error('运行卡缺少 body.elements');
  const original = elements(body.elements);
  const at = (index: number | undefined, name: string): CardDisplayElement | undefined => {
    if (index === undefined) return undefined;
    const node = original[index];
    if (!node && input.strict) throw new Error(`运行卡缺少 ${name} 组件`);
    return node;
  };
  const context = at(input.parts.contextIndex,'context');
  const process = at(input.parts.processIndex,'process');
  at(input.parts.statusIndex,'status');
  at(input.parts.modelIndex,'model');
  const controls = at(input.parts.controlsIndex,'controls');
  const stop = controls && findStop(controls);
  const reminder = controls && findReminder(controls);
  const reminderConfirmation = at(input.parts.reminderIndex,'reminder');
  const hasReminderBlock = config.blocks.some(block => block.kind === 'reminder');
  const excluded = new Set([input.parts.contextIndex,input.parts.processIndex,input.parts.statusIndex,input.parts.modelIndex,input.parts.controlsIndex].filter((index):index is number => index !== undefined));
  const toolsBlock=config.blocks.find(block=>block.kind==='tools');
  const showSubagents=config.reply?.streamText!==false && Boolean(toolsBlock && isShown(toolsBlock,input.phase) && toolsBlock.mode!=='off');
  const main = original.filter((_node,index) => !excluded.has(index)
    && (!(hasReminderBlock || config.reply?.streamText === false) || index !== input.parts.reminderIndex)
    && (input.phase === 'done' || config.reply?.streamText !== false || !input.parts.answerIndices.includes(index))
    && (showSubagents || !input.parts.subagentIndices?.includes(index)));
  const slots = Object.fromEntries(slotOrder.map(slot => [slot,[] as CardDisplayElement[]])) as Record<CardDisplaySlot,CardDisplayElement[]>;
  const percent = Number(object(input.values.context).percent);
  for (const block of config.blocks) {
    if (!isShown(block,input.phase) || block.mode === 'off') continue;
    if (block.kind === 'thinking' || block.kind === 'tools') continue;
    if (block.kind === 'status' && input.phase === 'done') continue;
    if (block.kind === 'status' && !object(input.values.status).label) continue;
    if (block.kind === 'context') {
      if (!context || Number.isFinite(percent) && percent < contextRulesFor(block).showFrom) continue;
      if (!Number.isFinite(percent)) {slots[block.slot]!.push(context);continue;}
    }
    if (block.kind === 'model' && !object(input.values.model).name) continue;
    if (block.kind === 'stop') {
      if (input.phase === 'done' || config.reply?.streamText === false) continue;
      // The first CardKit create has no carrier message ID yet, so no callback
      // can exist until the next frame; absence is a valid native state.
      if (!stop) continue;
      const button = structuredClone(stop);
      if (block.slot !== 'actions-left' && block.slot !== 'actions-right') button.element_id = CARD_DISPLAY_STOP_EID;
      if (block.appearance === 'text') button.text = {tag:'plain_text',content:interpolate(block.template,input.values).text || '终止'};
      else delete button.text;
      slots[block.slot]!.push(button);
      continue;
    }
    if (block.kind === 'reminder') {
      if (input.phase === 'done' || config.reply?.streamText === false || !reminder && !reminderConfirmation) continue;
      // Only move native controls/confirmation. A config must never manufacture
      // a callback when the policy or requester does not offer manual reminders.
      // Older preview frames supplied a note. Upgrade only that confirmed state
      // to an inert button, never to an actionable callback.
      const control: CardDisplayElement = reminder ? structuredClone(reminder) : {
        tag:'button',type:'default',disabled:true,
        hover_tips:{tag:'plain_text',content:'本轮结束后会提醒发起人'},
      };
      control.element_id = CARD_DISPLAY_REMINDER_EID;
      const before = block.template.trim() ? block.template : DEFAULT_REMINDER_TEMPLATE;
      const after = block.requestedTemplate?.trim() ? block.requestedTemplate : DEFAULT_REMINDER_REQUESTED_TEMPLATE;
      control.text = {tag:'plain_text',content:control.disabled === true ? after : before};
      control.size = 'medium';
      control.width = 'default';
      slots[block.slot]!.push(control);
      continue;
    }
    if (block.kind === 'custom' && block.source === 'script' && !input.scriptValues?.[block.id]) continue;
    const values = block.kind === 'custom' ? {...input.values,...object(input.scriptValues?.[block.id])} : input.values;
    const rendered = interpolate(block.template,values);
    if (block.kind === 'custom' && block.source === 'script' && rendered.missing.length) {
      if (input.strict) throw new Error(`“${block.name}”缺少模板字段：${rendered.missing.join('、')}`);
      continue;
    }
    let text = rendered.text;
    if (block.kind === 'context' && block.appearance === 'percent') text = `${percent}%`;
    const color = fontColor(block,percent);
    let node: CardDisplayElement;
    if (block.kind === 'context' && block.appearance === 'bar') node = contextBar(percent,color,block);
    else if (block.kind==='status' && block.template==='{{status.label}}' && block.color==='auto' && input.parts.statusElement)
      node={...structuredClone(input.parts.statusElement),text_size:block.size};
    else if (block.kind==='model' && block.template==='{{model.name}} · {{model.effort}}' && block.color==='auto' && input.parts.modelElement)
      node={...structuredClone(input.parts.modelElement),text_size:block.size};
    else if (block.kind==='model' && block.template==='{{model.name}} · {{model.effort}}' && block.color==='auto') {
      const model=object(input.values.model),name=escaped(String(model.name??'')),effort=escaped(String(model.effort??''));
      const tint=['grey','yellow','green','violet','purple'].includes(String(model.effortColor))?String(model.effortColor):'grey';
      node={tag:'markdown',content:effort?`${name} · <font color='${tint}'>${effort}</font>`:name,text_size:block.size,text_color:'grey'};
    }
    else node = markdown(text,block,color);
    slots[block.slot]!.push(node);
  }
  const processItems: CardDisplayElement[] = [];
  const time = config.blocks.find(block => block.kind === 'time');
  const showTime = time && isShown(time,input.phase) && time.mode !== 'off';
  if (process && process.tag === 'collapsible_panel') {
    const panel = structuredClone(process);
    const showProcess = (kind:'tool'|'thinking'):boolean => {
      const block = config.blocks.find(item => item.kind === (kind==='tool'?'tools':'thinking'));
      return Boolean(block && isShown(block,input.phase) && block.mode !== 'off');
    };
    if (input.parts.processChildKinds) panel.elements = elements(panel.elements).filter((_child,index) => {
      const kind = input.parts.processChildKinds![index];
      return kind === 'other' || kind === 'tool' && showProcess('tool') || kind === 'thinking' && showProcess('thinking');
    });
    if (config.reply?.streamText === false && input.phase === 'running') panel.elements = [];
    if (input.phase === 'done') panel.expanded = config.reply?.collapseAfterRun === false;
    if (showTime && time.slot === 'process') {
      const header = object(panel.header);
      panel.header = {...header,title:markdown(interpolate(time.template,input.values).text,time,fontColor(time,percent))};
    } else {
      const header = object(panel.header);
      panel.header = {...header,title:{tag:'markdown',content:"<font color='grey'>执行过程</font>",text_size:'normal'}};
    }
    if (elements(panel.elements).length) processItems.push(panel);
    else if (showTime && time.slot === 'process') processItems.push(markdown(interpolate(time.template,input.values).text,time,fontColor(time,percent)));
  } else if (showTime && time.slot === 'process') processItems.push(markdown(interpolate(time.template,input.values).text,time,fontColor(time,percent)));
  // Older/custom-only drafts without a stop component keep native behavior.
  const hasStopBlock = config.blocks.some(block=>block.kind==='stop');
  let remainingControls = controls && (hasStopBlock || config.reply?.streamText === false ? withoutStop(controls) : controls);
  if (remainingControls && (hasReminderBlock || config.reply?.streamText === false)) remainingControls = withoutReminder(remainingControls);
  const leftActions = slots['actions-left']!, rightActions = slots['actions-right']!;
  if (leftActions.length || rightActions.length) {
    const actionColumn=(items:CardDisplayElement[]):CardDisplayElement=>({tag:'column',width:'auto',elements:items});
    const nativeColumns=remainingControls?.tag==='column_set' ? elements(remainingControls.columns) : [];
    const actionColumns=[...leftActions.map(item=>actionColumn([item])),...nativeColumns];
    if (rightActions.length) {
      // A weighted spacer keeps the stop at the physical right edge even when
      // it is the only action or a reminder/goal button occupies the left.
      actionColumns.push({tag:'column',width:'weighted',weight:1,elements:[{tag:'markdown',content:'\u200B'}]},...rightActions.map(item=>actionColumn([item])));
    }
    remainingControls={...(remainingControls?.tag==='column_set'?remainingControls:{}),tag:'column_set',element_id:'controls',flex_mode:rightActions.length?'none':'flow',horizontal_spacing:'small',columns:actionColumns};
  }
  const top = row(slots['top-left']!,slots['top-right']!);
  const bottom = row(slots['bottom-left']!,slots['bottom-right']!);
  body.elements = [...(top ? [top] : []),...slots.top!,...processItems,...main,...(bottom ? [bottom] : []),...slots.bottom!,...(remainingControls ? [remainingControls] : [])];
  if (!elements(body.elements).length) body.elements = [{tag:'markdown',content:'\u200B'}];
  card.body = body;
  const count = (value:unknown):number => Array.isArray(value) ? value.reduce<number>((total,item)=>total+count(item),0)
    : value && typeof value === 'object' ? Object.entries(value).reduce((total,[key,item])=>total+(key==='tag'?1:count(item)),0) : 0;
  if (count(body.elements) > 200) throw new Error('消息卡片组件超过 200 个');
  if (new TextEncoder().encode(JSON.stringify(card)).length > 100_000) throw new Error('消息卡片内容超过 100 KB');
  return card;
}
