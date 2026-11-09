import {useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode} from 'react';
import {CARD_DISPLAY_REMINDER_EID} from '@vonvon/protocol';
import './feishu-card-preview.css';

export type CardNode = {tag?: string; [key: string]: unknown};
export type CardJson = {
  schema: '2.0';
  config?: CardNode;
  header?: CardNode;
  body: {elements: CardNode[]; padding?: string; vertical_spacing?: string};
};
type PreviewActions = {
  editing?: boolean;
  showSlots?: boolean;
  onSelect?: (id: string) => void;
  onRemove?: (id: string) => void;
  onRequestReminder?: () => void;
  nonRemovableComponents?: readonly string[];
  onPointerDragStart?: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  allowedDropSlots?: readonly string[];
  editableComponents?: readonly string[];
  draggedComponent?: string;
  landedComponent?: string;
  activeDropSlot?: string;
};

const palette = new Set(['grey', 'green', 'yellow', 'orange', 'red', 'blue', 'violet', 'purple']);
const object = (value: unknown): CardNode => value && typeof value === 'object' && !Array.isArray(value) ? value as CardNode : {};
const list = (value: unknown): CardNode[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as CardNode[] : [];
const string = (value: unknown): string => typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
const callback = (node: CardNode): string | undefined => list(node.behaviors).map(behavior => object(behavior.value).a).find((value): value is string => typeof value === 'string');
const color = (value: unknown): string => palette.has(value as string) ? value as string : 'grey';
const nativeChartColors: Record<string, string> = {'#8F959E':'grey','#3370FF':'blue','#F2B50A':'yellow','#F57C23':'orange','#F54A45':'red'};
const chartColor = (value: unknown): string => typeof value === 'string' ? nativeChartColors[value.toUpperCase()] ?? color(value) : 'grey';
const chartSample = (spec: CardNode): CardNode | undefined => list(Array.isArray(spec.data) ? object(spec.data[0]).values : object(spec.data).values)[0];
const chartFraction = (sample: CardNode | undefined): number => Math.max(0, Math.min(1, Number(sample?.value) || 0));
const nestedChart = (node: CardNode): CardNode | undefined => node.tag === 'chart' ? node : [...list(node.columns),...list(node.elements)].map(nestedChart).find(Boolean);
const measure = (value: unknown): string | undefined => typeof value === 'string' && /^(?:\d+(?:\.\d+)?px|\d+(?:\.\d+)?%)$/.test(value) ? value : undefined;
const buttonWidth = (value: unknown): string | undefined => value === 'fill' ? '100%' : typeof value === 'string' && /^\d+(?:\.\d+)?px$/.test(value) ? value : undefined;
const box = (value: unknown): string | undefined => typeof value === 'string' && /^(?:\d+(?:\.\d+)?px)(?:\s+\d+(?:\.\d+)?px){0,3}$/.test(value.trim()) ? value : undefined;

const icons: Record<string, ReactNode> = {
  'down-small-ccm_outlined': <path d="m5 8 3 3 3-3"/>,
  'stop-record_filled': <><circle cx="8" cy="8" r="6"/><rect x="6" y="6" width="4" height="4" rx="0.7" fill="currentColor" stroke="none"/></>,
  'close_outlined': <path d="M4 4l8 8M12 4l-8 8"/>,
  'right-small-ccm_outlined': <path d="m6 4 4 4-4 4"/>,
  'link-copy_outlined': <><path d="M6.5 9.5 9.5 6.5M6 6h-1a3 3 0 0 0 0 6h3a3 3 0 0 0 3-3V8M10 10h1a3 3 0 0 0 0-6H8a3 3 0 0 0-3 3v1"/><path d="M10 10h1a3 3 0 0 0 0-6H8a3 3 0 0 0-3 3v1"/></>,
  'setting-inter_outlined': <><circle cx="8" cy="8" r="2"/><path d="m6.3 1.8.4 1.3h2.6l.4-1.3 1.4.7-.5 1.3 1.8 1.8 1.3-.5.7 1.4-1.3.4v2.6l1.3.4-.7 1.4-1.3-.5-1.8 1.8.5 1.3-1.4.7-.4-1.3H6.7l-.4 1.3-1.4-.7.5-1.3-1.8-1.8-1.3.5-.7-1.4 1.3-.4V6.7l-1.3-.4.7-1.4 1.3.5 1.8-1.8-.5-1.3z"/></>,
  'edit_outlined': <path d="M3 11.5 11.3 3.2l1.5 1.5L4.5 13H3zM10 4.5l1.5 1.5"/>,
  'warning_outlined': <path d="M8 2 14 13H2zM8 6v3.5M8 11.5h.01"/>,
  'time_outlined': <><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></>,
  'computer_outlined': <><rect x="2" y="3" width="12" height="9" rx="1"/><path d="M6 14h4M8 12v2"/></>,
  'robot_outlined': <><rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2v3M6 9h.01M10 9h.01M6 12h4"/></>,
  'code_outlined': <path d="m5.5 5-3 3 3 3M10.5 5l3 3-3-3M9.5 3l-3 10"/>,
  'folder_outlined': <path d="M2 4h5l1 1h6v8H2z"/>,
  'image_outlined': <><rect x="2" y="2" width="12" height="12" rx="1"/><circle cx="6" cy="6" r="1"/><path d="m3 12 3-3 2 2 2-2 3 3"/></>,
  'plugin_outlined': <path d="M6 2v3M10 2v3M4 5h8v3a4 4 0 0 1-8 0zM8 12v2"/>,
  'search_outlined': <><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/></>,
  'wiki-book_outlined': <path d="M2 3h5a2 2 0 0 1 1 1 2 2 0 0 1 1-1h5v10H9a2 2 0 0 0-1 1 2 2 0 0 0-1-1H2zM8 4v10"/>,
  'speed_filled': <><path d="M3 12a6 6 0 1 1 10 0H3z"/><path d="m8 9 3-3"/></>,
};

function CardIcon({spec, className = ''}: {spec: unknown; className?: string}) {
  const node = object(spec);
  const token = typeof spec === 'string' ? spec : string(node.token);
  return <svg className={`vcr-icon ${className}`} data-token={token} data-color={node.color ? color(node.color) : undefined} viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[token] ?? null}</svg>;
}

// CardKit lark_md is treated as text plus a small, explicit formatting subset.
// React escapes all content; user templates never become HTML.
function inline(value: string, depth = 0): ReactNode[] {
  if (depth > 8 || !value) return [value];
  const token = /<font\s+color=['"]?([a-z]+)['"]?\s*>([\s\S]*?)<\/font>|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*]+)\*)|(?<![\w_])_([^_\n]+)_(?![\w_])/gi;
  const parts: ReactNode[] = [];
  let previous = 0;
  for (const match of value.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > previous) parts.push(value.slice(previous, index));
    if (match[1] !== undefined) parts.push(<span key={index} data-color={color(match[1].toLowerCase())}>{inline(match[2] ?? '', depth + 1)}</span>);
    else if (match[3] !== undefined) parts.push(<a key={index} href={match[4]} target="_blank" rel="noopener noreferrer">{inline(match[3], depth + 1)}</a>);
    else if (match[5] !== undefined) parts.push(<strong key={index}>{inline(match[6] ?? '', depth + 1)}</strong>);
    else if (match[7] !== undefined) parts.push(<code key={index}>{match[8]}</code>);
    else if (match[9] !== undefined) parts.push(<em key={index}>{inline(match[10] ?? '', depth + 1)}</em>);
    else if (match[11] !== undefined) parts.push(<em key={index}>{inline(match[11], depth + 1)}</em>);
    previous = index + match[0].length;
  }
  if (previous < value.length) parts.push(value.slice(previous));
  return parts;
}

function Markdown({content}: {content: unknown}) {
  const lines = string(content).split('\n');
  const output: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const fence = /^\s*(`{3,})([^`]*)$/.exec(line);
    if (fence) {
      const closing = fence[1]!.length;
      const body: string[] = [];
      index++;
      while (index < lines.length) {
        const candidate = (lines[index] ?? '').trim();
        if (candidate.length >= closing && /^`+$/.test(candidate)) break;
        body.push(lines[index++] ?? '');
      }
      if (index < lines.length) index++;
      output.push(<pre key={output.length}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    if (!line.trim()) { index++; continue; }
    const bullet = /^\s*([-+*]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]!);
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = /^\s*([-+*]|\d+[.)])\s+(.*)$/.exec(lines[index] ?? '');
        if (!item || /\d/.test(item[1]!) !== ordered) break;
        items.push(<li key={index}>{inline(item[2] ?? '')}</li>);
        index++;
      }
      output.push(ordered ? <ol key={output.length}>{items}</ol> : <ul key={output.length}>{items}</ul>);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { output.push(<blockquote key={output.length}>{inline(quote[1] ?? '')}</blockquote>); index++; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { output.push(<div className="vcr-heading" key={output.length}>{inline(heading[2] ?? '')}</div>); index++; continue; }
    const paragraph: string[] = [line];
    index++;
    while (index < lines.length && lines[index]?.trim() && !/^\s*(`{3,}|[-+*]\s+|\d+[.)]\s+|>\s?)/.test(lines[index] ?? '')) paragraph.push(lines[index++] ?? '');
    output.push(<p key={output.length}>{paragraph.map((part, partIndex) => <span key={partIndex}>{partIndex > 0 && <br/>}{inline(part)}</span>)}</p>);
  }
  return <div className="vcr-markdown">{output}</div>;
}

function TextNode({data, kind}: {data: CardNode; kind: 'text' | 'div'}) {
  const inner = data.text && typeof data.text === 'object' ? object(data.text) : data;
  return <div className={`vcr-${kind}${data.icon ? ' vcr-with-icon' : ''}`} data-size={string(inner.text_size) || undefined} data-color={inner.text_color ? color(inner.text_color) : undefined} data-align={string(inner.text_align) || undefined}>
    {Boolean(data.icon) && <CardIcon spec={data.icon}/>}
    {inner.tag === 'plain_text' ? string(inner.content) : <Markdown content={inner.content}/>}
  </div>;
}

function componentLabel(data: CardNode): string {
  if (data.tag === 'button') return string(object(data.text).content ?? object(data.hover_tips).content) || '终止任务';
  const chart = nestedChart(data);
  if (chart) return `上下文 ${Math.round(chartFraction(chartSample(object(chart.chart_spec))) * 100)}%`;
  const content = data.tag === 'collapsible_panel' ? object(object(data.header).title) : data;
  return string(object(content.text).content ?? content.content).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().replace(/^_([^_]+)_$/, '$1');
}
function EditableComponent({id, data, actions, children}: {id: string; data: CardNode; actions: PreviewActions; children: ReactNode}) {
  if (!actions.editing || !id || actions.editableComponents && !actions.editableComponents.includes(id)) return children;
  const label = componentLabel(data);
  const select = () => actions.onSelect?.(id);
  const reminder = callback(data) === 'run.remind' && data.disabled !== true;
  const protectedComponent = callback(data) === 'run.remind' || data.element_id === CARD_DISPLAY_REMINDER_EID || actions.nonRemovableComponents?.includes(id);
  return <div className="vcr-widget" data-card-component={id} data-card-position={string(data.preview_slot) || undefined} data-interactive={reminder || undefined} data-dragging={actions.draggedComponent === id} data-landed={actions.landedComponent === id}>
    <div className="vcr-widget-body" inert={!reminder || undefined} aria-hidden={reminder ? undefined : true}>{children}</div>
    {reminder ? <button type="button" className="vcr-widget-settings" aria-label={`设置 ${label}`} onClick={event => {event.stopPropagation();select();}}>设置</button>
      : <button type="button" className="vcr-widget-edit" aria-label={label} title={data.disabled === true ? string(object(data.hover_tips).content) || undefined : undefined} onPointerDown={event => actions.onPointerDragStart?.(id,event)} onClick={event => {event.stopPropagation();select();}}/>}
    {actions.onRemove && !protectedComponent && <button type="button" className="vcr-widget-remove" aria-label={`隐藏 ${label}`} onClick={event => {event.stopPropagation();actions.onRemove?.(id);}}>隐藏</button>}
  </div>;
}

function CardElement({data, actions, level = 0}: {data: CardNode; actions: PreviewActions; level?: number}): ReactNode {
  if (level > 20) return null;
  const marker = string(data.preview_component ?? object(data.data).preview_component);
  const slot = string(data.preview_slot);
  const slotLabel = string(data.preview_slot_label);
  const emptySlot = Boolean(slot && !list(data.elements).length && !list(data.columns).length);
  const canDrop = Boolean(actions.showSlots && slot && (!actions.allowedDropSlots || actions.allowedDropSlots.includes(slot)));
  if (actions.showSlots && slot && !canDrop && emptySlot) return null;
  const pickSlot = emptySlot && canDrop ? <div className="vcr-slot-pick">{slotLabel || slot}</div> : null;
  const wrap = (children: ReactNode) => <EditableComponent id={marker} data={data} actions={actions}>{children}</EditableComponent>;
  const attrs = {
    'data-element-id': string(data.element_id) || undefined,
    'data-preview-component': marker || undefined,
    'data-card-position': slot || undefined,
    'data-card-slot': canDrop && slot || undefined,
    'data-card-slot-label': canDrop && slotLabel || undefined,
    'data-tag': string(data.tag),
    style: box(data.margin) ? {margin: box(data.margin)} as CSSProperties : undefined,
  };
  switch (data.tag) {
    case 'markdown': return wrap(<div className="vcr-node" {...attrs}><TextNode data={data} kind="text"/></div>);
    case 'div': return wrap(<div className="vcr-node" {...attrs}><TextNode data={data} kind="div"/></div>);
    case 'hr': return <hr className="vcr-rule" {...attrs}/>;
    case 'button': {
      const icon = object(data.icon);
      const label = string(object(data.text).content);
      const tip = string(object(data.hover_tips).content);
      const action = callback(data);
      const reminder = action === 'run.remind' && data.disabled !== true;
      return wrap(<button type="button" className={`vcr-button${icon.token === 'stop-record_filled' && !label ? ' vcr-button--stop' : ''}`} data-action={action} data-variant={string(data.type) || 'default'} data-size={string(data.size) || undefined} data-width={string(data.width) || undefined} title={tip || undefined} aria-label={tip || label || string(icon.token)} disabled={data.disabled === true} onPointerDown={reminder && actions.editing && marker ? event => actions.onPointerDragStart?.(marker,event) : undefined} onClick={reminder ? event => {event.stopPropagation(); if (data.disabled !== true) actions.onRequestReminder?.();} : undefined} {...attrs} style={{...attrs.style,width:buttonWidth(data.width)}}>
        {Boolean(data.icon) && <CardIcon spec={data.icon}/>}{label && <span className="vcr-button-label">{label}</span>}
      </button>);
    }
    case 'chart': {
      const chart = object(data.chart_spec);
      if (chart.type !== 'linearProgress') return null;
      const sample = chartSample(chart);
      const fraction = chartFraction(sample);
      const percentage = Math.round(fraction * 100);
      const tint = Array.isArray(chart.color) ? chart.color[0] : chart.color;
      const label = string(sample?.label ?? sample?.name);
      return wrap(<div className="vcr-progress" {...attrs} data-color={chartColor(tint)} role="img" aria-label={`${label} ${percentage}%`}>
        <span className="vcr-progress-track"><span className="vcr-progress-fill" style={{width: `${fraction * 100}%`}}/></span>
      </div>);
    }
    case 'column_set': return wrap(<div className="vcr-columns" data-flex={string(data.flex_mode) || 'none'} data-spacing={string(data.horizontal_spacing) || 'small'} data-align={string(data.horizontal_align) || undefined} {...attrs} style={{...attrs.style, columnGap: measure(data.horizontal_spacing)}}>
      {list(data.columns).map((item, i) => <CardElement key={i} data={item} actions={actions} level={level + 1}/>)}{pickSlot}
    </div>);
    case 'column': return <div className="vcr-column" data-width={string(data.width) || 'auto'} data-valign={string(data.vertical_align) || 'top'} {...attrs} style={{...attrs.style, ...(data.width === 'weighted' ? {flexGrow: Math.max(1, Number(data.weight) || 1)} : {width: measure(data.width)})}}>
      {list(data.elements).map((item, i) => <CardElement key={i} data={item} actions={actions} level={level + 1}/>)}{pickSlot}
    </div>;
    case 'collapsible_panel': return wrap(<Panel data={data} attrs={attrs} actions={actions} level={level} pickSlot={pickSlot}/>);
    default: return null;
  }
}

function Panel({data, attrs, actions, level, pickSlot}: {data: CardNode; attrs: Record<string, unknown>; actions: PreviewActions; level: number; pickSlot: ReactNode}) {
  const header = object(data.header);
  const [open, setOpen] = useState(data.expanded === true);
  const angle = Number(header.icon_expanded_angle);
  const icon = header.icon ? <CardIcon spec={header.icon} className="vcr-chevron"/> : null;
  const position = string(header.icon_position) || 'follow_text';
  const component = string(object(header.title).preview_component);
  return <div className="vcr-panel" data-open={open ? 'true' : undefined} data-border={object(data.border).color ? color(object(data.border).color) : undefined} data-header-width={string(header.width) || undefined} {...attrs}>
    <EditableComponent id={component} data={object(header.title)} actions={actions}><button type="button" className="vcr-panel-header" data-icon-right={position === 'right' ? '' : undefined} onClick={() => setOpen(value => !value)} style={{padding: box(header.padding), ['--vcr-expanded-angle' as string]: Number.isFinite(angle) ? `${angle}deg` : '-180deg'}} aria-expanded={open}>
      {position === 'left' && icon}<span className="vcr-panel-title"><TextNode data={object(header.title)} kind="text"/></span>{position !== 'left' && icon}
    </button></EditableComponent>
    {open && <div className="vcr-panel-body" style={{padding: box(data.padding), rowGap: measure(data.vertical_spacing)}}>
      {list(data.elements).map((item, i) => <CardElement key={i} data={item} actions={actions} level={level + 1}/>)}{pickSlot}
    </div>}
  </div>;
}

/** A non-interactive sample for the content chooser, using the card's actual element. */
export function FeishuContentSample({node}: {node: CardNode}) {
  const content = node.tag === 'collapsible_panel' ? object(object(node.header).title) : node;
  const label = string(object(content.text).content);
  return <div className="vcr-sample">{content.tag === 'button' ? <span className={`vcr-button${!label ? ' vcr-button--stop' : ''}`} data-action={callback(content)} data-element-id={string(content.element_id) || undefined} data-variant={string(content.type)} data-size={string(content.size) || undefined} data-width={string(content.width) || undefined} style={{width:buttonWidth(content.width)}} role="img" aria-label={label || string(object(content.hover_tips).content) || '终止按钮'}>{Boolean(content.icon) && <CardIcon spec={content.icon}/>}{label && <span className="vcr-button-label">{label}</span>}</span> : content.tag === 'chart' || content.tag === 'column_set' ? <CardElement data={content} actions={{}}/> : <TextNode data={content} kind={content.tag === 'div' ? 'div' : 'text'}/>}</div>;
}

function elementKey(item: CardNode, index: number) {
  return string(item.preview_slot ?? item.element_id ?? item.preview_component) || (item.tag === 'column_set' ? `row:${list(item.columns).map(column => string(column.preview_slot)).join(':')}` : `${item.tag}:${index}`);
}

export function FeishuCardPreview({card, onSelect, onRemove, onRequestReminder, nonRemovableComponents, onPointerDragStart, editing, showSlots, allowedDropSlots, editableComponents, draggedComponent, landedComponent, activeDropSlot, replyContext}: {card: CardJson; replyContext?: string} & PreviewActions) {
  const actions = {onSelect, onRemove, onRequestReminder, nonRemovableComponents, onPointerDragStart, editing, showSlots, allowedDropSlots, editableComponents, draggedComponent, landedComponent, activeDropSlot};
  const contentActions = {...actions, showSlots: false};
  const header = object(card.header);
  const body = object(card.body);
  const hasControls = list(body.elements).some(node => node.element_id === 'controls');
  const actionTargets = allowedDropSlots?.some(slot => slot.startsWith('actions-'));
  const positions: Record<string, string> = {'top-left':'上方左侧',top:'上方整行','top-right':'上方右侧',process:'执行过程','bottom-left':'下方左侧',bottom:'下方整行','bottom-right':'下方右侧','actions-left':'按钮区左侧','actions-right':'按钮区右侧'};
  const target = (slot: string) => !allowedDropSlots || allowedDropSlots.includes(slot) ? <div key={slot} className="vcr-drop-zone" data-card-slot={slot} data-active={activeDropSlot === slot}>{positions[slot]}</div> : null;
  return <article className="vcr-card" aria-label="飞书消息卡片" data-width-mode={string(object(card.config).width_mode) || undefined}>
    {Boolean(card.header) && <header className="vcr-card-header" data-template={string(header.template) || 'blue'}><div className="vcr-card-heading">{string(object(header.title).content)}</div>{Boolean(object(header.subtitle).content) && <div className="vcr-card-subtitle">{string(object(header.subtitle).content)}</div>}</header>}
    {replyContext && <div className="vcr-reply-context"><span>{replyContext}</span></div>}
    <div className="vcr-card-body" style={{padding: box(body.padding) ?? '12px', rowGap: measure(body.vertical_spacing) ?? '16px'}}>
      {list(body.elements).map((item, i) => <CardElement key={elementKey(item, i)} data={item} actions={contentActions}/>)}
    </div>
    {showSlots && <div className="vcr-drop-layer" aria-label="拖放位置" style={{top:replyContext ? 42 : 12,bottom:hasControls && !actionTargets ? 48 : 12}}><div className="vcr-drop-row">{['top-left','top','top-right'].map(target)}</div><div className="vcr-drop-middle">{target('process')}</div><div className="vcr-drop-row">{['bottom-left','bottom','bottom-right'].map(target)}</div>{actionTargets && <div className="vcr-drop-row">{['actions-left','actions-right'].map(target)}</div>}</div>}
  </article>;
}
