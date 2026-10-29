import {useId, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {ChevronLeft, LocateFixed, MoreHorizontal, Plus} from 'lucide-react';
import {useMindMapCanvas, type CanvasNode} from './MindMapCanvas';
import './mind-map.css';

export type MapMenuItem = {id: string; label: string; onSelect: () => void; danger?: boolean};
export type MapEditStart = {point?: {x: number; y: number}; text?: string};
export type MapNode = {
  id: string;
  /** What the node says; `content` replaces it (an editor in place). */
  label: ReactNode;
  content?: ReactNode;
  /** Inline actions below this node's own text; unlike content, these are not an editor. */
  footer?: ReactNode;
  /** The count and the 新 tag, small, after the label. */
  meta?: ReactNode;
  kind: 'root' | 'section' | 'branch' | 'leaf' | 'more' | 'archive' | 'action';
  /** pending = a dashed frame (待确认); muted = archived; match = a search hit; dim = a search miss */
  tone?: 'pending' | 'muted' | 'match' | 'dim';
  selected?: boolean;
  /** A dot before the label: written since the owner last opened this page (§5.8). */
  fresh?: boolean;
  children?: MapNode[];
  /** Controlled fold state; ordinary page-owned child groups can also fold locally. */
  open?: boolean;
  onToggle?: () => void;
  onClick?: () => void;
  onAdd?: () => void;
  onDelete?: () => void;
  onEdit?: (start?: MapEditStart) => void;
  fixed?: boolean;
  childCount?: number;
  menu?: MapMenuItem[];
  /** The node can be dragged: this is what it carries. */
  drag?: string;
  /** The node takes a dragged leaf: `accepts` says whether this one may land here. */
  drop?: {accepts: (dragged: string) => boolean; onDrop: (dragged: string) => void};
};

/** MindElixir lays out branches and owns the camera; React owns every node and action. */
export function MindMap({root, label, beforeLocalToggle, beforeSelect, inlineMenus = false, focusRequest}: {root: MapNode; label: string; beforeLocalToggle?: (toggle: () => void) => void; beforeSelect?: (select: () => void) => void; inlineMenus?: boolean; focusRequest?: {id: string; token: number}}) {
  const [menuId, setMenuId] = useState<string>();
  const [dragging, setDragging] = useState<string>();
  const [activeId, setActiveId] = useState<string>();
  const [localFolds, setLocalFolds] = useState<ReadonlySet<string>>(new Set());
  const lastInteraction = useRef<string | undefined>(undefined);
  const folded = (node: MapNode) => node.onToggle ? node.open === false : localFolds.has(node.id) ? node.open !== false : node.open === false;
  const container = useRef<HTMLDivElement>(null);
  const capture = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const prefix = useId();
  const browser = typeof window !== 'undefined' && typeof document !== 'undefined';
  const all: MapNode[] = [];
  const visible: MapNode[] = [];
  const visit = (node: MapNode, shown: boolean) => {
    all.push(node);
    if (shown) visible.push(node);
    node.children?.forEach(child => visit(child, shown && !folded(node)));
  };
  const withMenu = (node: MapNode): MapNode => {
    const opened = inlineMenus && menuId === node.id && Boolean(node.menu?.length);
    return {...node, ...(opened ? {open: true, onToggle: () => setMenuId(undefined)} : {}),
      ...(node.children || opened ? {children: [...(node.children ?? []).map(withMenu), ...(opened ? [{
        id: `menu:${node.id}`, kind: 'section' as const, label: '操作', fixed: false, children: [
          ...node.menu!.map(entry => ({id: `menu:${node.id}:${entry.id}`, kind: 'action' as const, label: entry.label, fixed: false, onClick: () => {setMenuId(undefined); entry.onSelect();}})),
          {id: `menu:${node.id}:close`, kind: 'action' as const, label: '收起操作', fixed: false, onClick: () => setMenuId(undefined)},
        ],
      }] : [])]} : {})};
  };
  const displayRoot = inlineMenus ? withMenu(root) : root;
  visit(displayRoot, true);
  const active = visible.find(node => node.id === activeId) ?? (activeId === undefined ? visible.find(node => node.selected) : undefined);
  const externalSelected = visible.find(node => node.selected)?.id;
  const previousExternal = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (externalSelected) setActiveId(externalSelected);
    else if (previousExternal.current) setActiveId(undefined);
    previousExternal.current = externalSelected;
  }, [externalSelected]);
  const selected = active?.id;
  const editing = active?.content !== undefined;
  const canvasTree = (node: MapNode): CanvasNode => ({id: node.id, expanded: !folded(node), children: (node.children ?? []).map(canvasTree)});
  const {host, slots, reset} = useMindMapCanvas(canvasTree(displayRoot), lastInteraction.current ?? selected, editing ? selected : undefined, focusRequest);
  useLayoutEffect(() => {
    if (active?.onEdit && !editing && capture.current && (document.activeElement === document.body || container.current?.contains(document.activeElement))) {
      const box = document.getElementById(`${prefix}-${active.id}`)?.getBoundingClientRect();
      const bounds = container.current?.getBoundingClientRect();
      if (box && bounds) {
        capture.current.style.left = `${box.left - bounds.left}px`;
        capture.current.style.top = `${box.bottom - bounds.top}px`;
      }
      capture.current.focus({preventScroll: true});
    }
  }, [selected, editing]);
  const beginTyping = (text: string) => {if (text && active?.onEdit && !editing) {lastInteraction.current = active.id; active.onEdit({text});}};
  const toggleLocal = (id: string) => {
    const toggle = () => {lastInteraction.current = id; setLocalFolds(current => {const next = new Set(current); if (!next.delete(id)) next.add(id); return next;});};
    if (beforeLocalToggle) beforeLocalToggle(toggle); else toggle();
  };
  const select = (node: MapNode) => {
    const action = () => {lastInteraction.current = node.id; setActiveId(node.selected === undefined ? node.id : undefined); node.onClick?.(); if (!node.onEdit) container.current?.focus({preventScroll: true});};
    if (beforeSelect) beforeSelect(action); else action();
  };
  const openMenu = (node: MapNode) => {
    const action = () => {lastInteraction.current = node.id; setMenuId(current => current === node.id ? undefined : node.id);};
    if (beforeSelect) beforeSelect(action); else action();
  };
  const props: Omit<BoxProps, 'node' | 'folded' | 'foldable' | 'toggle'> = {dragging, setDragging, selected, prefix, select, inlineMenus, openMenu, markInteraction: id => {lastInteraction.current = id;}};
  const box = (node: MapNode) => <MapBox {...props} node={node} folded={folded(node)} foldable={Boolean(node.children?.length || node.childCount)}
    toggle={() => {lastInteraction.current = node.id; if (node.onToggle) node.onToggle(); else toggleLocal(node.id);}}/>;
  const staticTree = (node: MapNode): ReactNode => <div key={node.id} className="mm-static-branch">{box(node)}{!folded(node) && node.children?.map(staticTree)}</div>;
  return <div ref={container} className="mm" role="tree" aria-label={label} tabIndex={0}
    aria-activedescendant={active ? `${prefix}-${active.id}` : undefined}
    onClick={event => {if (!(event.target as HTMLElement).closest('.mm-box')) {setMenuId(undefined); setActiveId(''); container.current?.focus({preventScroll: true});}}}
    onKeyDown={event => {
      const target = event.target as HTMLElement;
      if (target.closest('.mm-node-footer')) return;
      if (target !== capture.current && (target.closest('input, textarea, select, [contenteditable]') || target.closest('summary, [role=menu]'))) return;
      if (target.closest('.mm-label') && !target.closest('.mm-box[data-selected]')) return;
      if (!active || event.nativeEvent.isComposing || composing.current) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {event.preventDefault(); lastInteraction.current = active.id; active.onDelete?.();}
      else if (event.key === 'Escape') {event.preventDefault(); setActiveId(''); container.current?.focus({preventScroll: true});}
      else if (event.key === 'F2') {event.preventDefault(); lastInteraction.current = active.id; active.onEdit?.();}
      else if (event.key === 'Enter' || (event.key === 'Tab' && active.onAdd)) {event.preventDefault(); lastInteraction.current = active.id; active.onAdd?.();}
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && active.onEdit) {event.preventDefault(); beginTyping(event.key);}
    }}>
    <textarea ref={capture} className="mm-input-capture" aria-label="选中节点文字输入" tabIndex={-1}
      onCompositionStart={() => {composing.current = true;}}
      onCompositionEnd={event => {composing.current = false; beginTyping(event.currentTarget.value); event.currentTarget.value = '';}}
      onChange={event => {if (!composing.current) {beginTyping(event.currentTarget.value); event.currentTarget.value = '';}}}/>
    {!browser ? <div className="mm-static">{staticTree(displayRoot)}</div> : <div ref={host} className="mm-engine"/>}
    {browser && all.map(node => {const slot = slots.get(node.id); return slot ? createPortal(box(node), slot, node.id) : null;})}
    {browser && <button type="button" className="mm-home" aria-label="回到起点" title="回到起点" onClick={event => {event.stopPropagation(); reset();}}><LocateFixed size={17} strokeWidth={1.8} aria-hidden="true"/></button>}
  </div>;
}

type BoxProps = {node: MapNode; inlineMenus?: boolean; openMenu?: (node: MapNode) => void; dragging?: string; setDragging: (value?: string) => void; selected?: string; prefix: string; select: (node: MapNode) => void; folded: boolean; foldable: boolean; toggle: () => void; markInteraction: (id: string) => void};
function MapBox({node, dragging, setDragging, selected, prefix, select, folded, foldable, toggle, inlineMenus, openMenu, markInteraction}: BoxProps) {
  const [over, setOver] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const canDrop = Boolean(node.drop && dragging !== undefined && node.drop.accepts(dragging));
  const isSelected = selected === node.id;
  const fixed = node.fixed ?? !node.onDelete;
  const drop = node.drop;
  const events = {
    ...(node.drag && !node.content ? {draggable: true, onDragStart: (event: DragEvent) => {event.dataTransfer.setData('text/plain', node.drag!); event.dataTransfer.effectAllowed = 'move'; setDragging(node.drag);}, onDragEnd: () => {setDragging(undefined); setOver(false);}} : {}),
    ...(drop ? {
      onDragOver: (event: DragEvent) => {if (canDrop) {event.preventDefault(); setOver(true);}},
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        const dragged = dragging ?? event.dataTransfer.getData('text/plain');
        setOver(false); setDragging(undefined);
        if (dragged && drop.accepts(dragged)) {event.preventDefault(); drop.onDrop(dragged);}
      },
    } : {}),
  };
  return <div className="mm-box" data-kind={node.kind} data-tone={node.tone} data-selected={isSelected || undefined} data-inline-tools={node.footer ? true : undefined} data-fixed={fixed || undefined} data-actions={Boolean(node.onAdd || foldable) || undefined} data-fresh={node.fresh || undefined} onPointerDown={event => event.stopPropagation()} onContextMenu={event => {event.stopPropagation(); markInteraction(node.id); if (inlineMenus && node.menu?.length) {event.preventDefault(); openMenu?.(node);} else if (menu.current) {event.preventDefault(); menu.current.open = true;}}} data-drop={canDrop ? (over ? 'over' : 'ready') : undefined} {...events}>
    <div className="mm-main" id={`${prefix}-${node.id}`} role="treeitem" aria-selected={isSelected} aria-expanded={foldable ? !folded : undefined}>
      {node.fresh && <span className="mm-new" role="img" aria-label="新"/>}
      {node.content ?? <button type="button" className="mm-label" onClick={event => {
        if (isSelected && node.onEdit) {markInteraction(node.id); node.onEdit({point: {x: event.clientX, y: event.clientY}});}
        else select(node);
      }} onDoubleClick={event => {if (!isSelected) {markInteraction(node.id); node.onEdit?.({point: {x: event.clientX, y: event.clientY}});}}}>
        {node.label}{node.meta && <small>{node.meta}</small>}
      </button>}
    </div>
    {node.footer && <div className="mm-node-footer" onClick={event => event.stopPropagation()}>{node.footer}</div>}
    {isSelected && !folded && node.onAdd && <button type="button" className="mm-add" aria-label="添加记忆" title="添加记忆" onClick={() => {markInteraction(node.id); node.onAdd?.();}}><Plus size={18} strokeWidth={2} aria-hidden="true"/></button>}
    {foldable && (folded || !isSelected) && <button type="button" className="mm-fold" data-collapsed={folded || undefined}
      aria-label={folded ? '展开' : '收起'} aria-expanded={!folded} onClick={toggle}>{folded ? node.childCount ?? node.children?.length : <ChevronLeft size={16} strokeWidth={2} aria-hidden="true"/>}</button>}

    {!inlineMenus && node.menu && node.menu.length > 0 && <details ref={menu} className="mm-menu" onToggle={event => {
      const details = event.currentTarget;
      const popup = details.querySelector<HTMLElement>('[role=menu]');
      if (!details.open || !popup) return;
      const bounds = details.closest('.mm')!.getBoundingClientRect();
      const left = Math.max(8, bounds.left + 8), right = Math.min(window.innerWidth - 8, bounds.right - 8);
      const top = Math.max(8, bounds.top + 8), bottom = Math.min(window.innerHeight - 8, bounds.bottom - 8);
      popup.style.transform = ''; popup.style.maxHeight = `${Math.max(80, bottom - top)}px`;
      const rect = popup.getBoundingClientRect();
      const x = Math.max(left - rect.left, Math.min(0, right - rect.right));
      const y = Math.max(top - rect.top, Math.min(0, bottom - rect.bottom));
      popup.style.transform = `translate(${x}px, ${y}px)`;
      popup.querySelector('button')?.focus({preventScroll: true});
    }} onKeyDown={event => {
      if (!event.currentTarget.open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {event.preventDefault(); event.stopPropagation(); event.currentTarget.open = true; return;}
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.closest('.mm-box')?.querySelector<HTMLButtonElement>('.mm-label')?.focus({preventScroll: true});}
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]'));
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? (at + 1) % buttons.length : event.key === 'ArrowUp' ? (at - 1 + buttons.length) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : undefined;
      if (next !== undefined) {event.preventDefault(); event.stopPropagation(); buttons[next]?.focus({preventScroll: true});}
    }} onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;}}>
      <summary aria-label="更多操作" title="更多操作"><MoreHorizontal size={14} aria-hidden="true"/></summary>
      <div role="menu">{node.menu.map(item => <button type="button" role="menuitem" key={item.id} data-danger={item.danger || undefined}
        onClick={event => {event.currentTarget.closest('details')?.removeAttribute('open'); item.onSelect();}}>{item.label}</button>)}</div>
    </details>}
  </div>;
}
