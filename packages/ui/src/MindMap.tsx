import {useId, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode} from 'react';
import {MoreHorizontal} from 'lucide-react';
import './mind-map.css';

export type MapMenuItem = {id: string; label: string; onSelect: () => void; danger?: boolean};
export type MapEditStart = {point?: {x: number; y: number}; text?: string};
export type MapNode = {
  id: string;
  /** What the node says; `content` replaces it (an editor in place). */
  label: ReactNode;
  content?: ReactNode;
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

/**
 * A hand-written horizontal tree (§5.7): HTML nodes, SVG connectors between a node and its children, the root on the left.
 * A narrow window draws the same tree indented (CSS only); every action stays on the nodes. No chart library.
 */
export function MindMap({root, label}: {root: MapNode; label: string}) {
  const [dragging, setDragging] = useState<string>();
  const [activeId, setActiveId] = useState<string>();
  const container = useRef<HTMLDivElement>(null);
  const capture = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const prefix = useId();
  const visible: MapNode[] = [];
  const visit = (node: MapNode) => {visible.push(node); if (node.open !== false) node.children?.forEach(visit);};
  visit(root);
  const active = visible.find(node => node.id === activeId) ?? (activeId === undefined ? visible.find(node => node.selected) : undefined);
  const externalSelected = visible.find(node => node.selected)?.id;
  useLayoutEffect(() => {if (externalSelected) setActiveId(externalSelected);}, [externalSelected]);
  const selected = active?.id;
  const editing = active?.content !== undefined;
  useLayoutEffect(() => {
    if (active?.onEdit && !editing && capture.current) {
      const box = document.getElementById(`${prefix}-${active.id}`)?.getBoundingClientRect();
      const bounds = container.current?.getBoundingClientRect();
      if (box && bounds && container.current) {
        capture.current.style.left = `${box.left - bounds.left + container.current.scrollLeft}px`;
        capture.current.style.top = `${box.bottom - bounds.top + container.current.scrollTop}px`;
      }
      capture.current.focus({preventScroll: true});
    }
  }, [selected, editing]);
  const beginTyping = (text: string) => {
    if (!text || !active?.onEdit || editing) return;
    active.onEdit({text});
  };
  return <div ref={container} className="mm" role="tree" aria-label={label} tabIndex={0}
    aria-activedescendant={active ? `${prefix}-${active.id}` : undefined}
    onClick={event => {if (!(event.target as HTMLElement).closest('.mm-box')) {setActiveId(''); container.current?.focus();}}}
    onKeyDown={event => {
      const target = event.target as HTMLElement;
      if (target !== capture.current && (target.closest('input, textarea, select, [contenteditable]') || target.closest('summary, [role=menu]'))) return;
      if (target.closest('.mm-label') && !target.closest('.mm-box[data-selected]')) return;
      if (!active || event.nativeEvent.isComposing || composing.current) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {event.preventDefault(); active.onDelete?.();}
      else if (event.key === 'Escape') {event.preventDefault(); setActiveId(''); container.current?.focus();}
      else if (event.key === 'F2') {event.preventDefault(); active.onEdit?.();}
      else if (event.key === 'Enter' || (event.key === 'Tab' && active.onAdd)) {event.preventDefault(); active.onAdd?.();}
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && active.onEdit) {event.preventDefault(); beginTyping(event.key);}
    }}>
    <textarea ref={capture} className="mm-input-capture" aria-label="选中节点文字输入" tabIndex={-1}
      onCompositionStart={() => {composing.current = true;}}
      onCompositionEnd={event => {composing.current = false; beginTyping(event.currentTarget.value); event.currentTarget.value = '';}}
      onChange={event => {if (!composing.current) {beginTyping(event.currentTarget.value); event.currentTarget.value = '';}}}/>
    <MapTree node={root} dragging={dragging} setDragging={setDragging} selected={selected} prefix={prefix}
      select={node => {setActiveId(node.selected === undefined ? node.id : undefined); node.onClick?.(); if (!node.onEdit) container.current?.focus({preventScroll: true});}}/>
  </div>;
}

type TreeProps = {node: MapNode; dragging?: string; setDragging: (value?: string) => void; selected?: string; prefix: string; select: (node: MapNode) => void};
function MapTree(props: TreeProps) {
  const {node} = props;
  const [localFolded, setLocalFolded] = useState(false);
  const folded = node.onToggle ? node.open === false : localFolded || node.open === false;
  const kids = node.children ?? [];
  const foldable = kids.length > 0 || (node.childCount ?? 0) > 0;
  return <div className="mm-tree" role="none">
    <div className="mm-self" role="none"><MapBox {...props} folded={folded} foldable={foldable}
      toggle={() => {if (!folded) props.select(node); if (node.onToggle) node.onToggle(); else setLocalFolded(value => !value);}}/></div>
    {kids.length > 0 && !folded && <Links count={kids.length}>
      {kids.map(child => <MapTree {...props} key={child.id} node={child}/>) }
    </Links>}
  </div>;
}

/** The children column and the curves from the parent (left, vertically centred) to each child's node. */
function Links({count, children}: {count: number; children: ReactNode}) {
  const column = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<{height: number; ends: number[]}>({height: 0, ends: []});
  useLayoutEffect(() => {
    const element = column.current;
    if (!element) return;
    const nodes = Array.from(element.children).flatMap(child => {
      const self = child.querySelector(':scope > .mm-self');
      return self instanceof HTMLElement ? [{tree: child, self}] : [];
    });
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const ends = nodes.map(({self}) => {
        // Both .mm-tree and .mm-self can have this column as their offsetParent.
        // Compare viewport rectangles so a child's vertical offset is counted only once.
        const box = self.getBoundingClientRect();
        return box.top - bounds.top + box.height / 2;
      });
      setPaths(previous => previous.height === bounds.height && previous.ends.length === ends.length && previous.ends.every((end, at) => end === ends[at]) ? previous : {height: bounds.height, ends});
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // Two subtrees can change height while the whole column keeps the same height.
    for (const {tree, self} of nodes) {observer.observe(tree); observer.observe(self);}
    return () => observer.disconnect();
  }, [count, children]);
  const middle = paths.height / 2;
  return <div className="mm-children" role="group" ref={column}>
    <svg className="mm-links" aria-hidden="true" width="64" height={paths.height || undefined} viewBox={`0 0 64 ${paths.height || 1}`}>
      {paths.ends.map((end, at) => <path key={at} d={count === 1 ? `M0 ${middle} H64` : `M0 ${middle} H16 Q32 ${middle} 32 ${middle + Math.sign(end - middle) * Math.min(14, Math.abs(end - middle) / 2)} V${end - Math.sign(end - middle) * Math.min(14, Math.abs(end - middle) / 2)} Q32 ${end} 48 ${end} H64`} fill="none" stroke="currentColor" strokeWidth="1.2"/>)}
    </svg>
    {children}
  </div>;
}

function MapBox({node, dragging, setDragging, selected, prefix, select, folded, foldable, toggle}: TreeProps & {folded: boolean; foldable: boolean; toggle: () => void}) {
  const [over, setOver] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const canDrop = Boolean(node.drop && dragging !== undefined && node.drop.accepts(dragging));
  const isSelected = selected === node.id;
  const fixed = node.fixed ?? !node.onDelete;
  const drop = node.drop;
  const events = {
    ...(node.drag ? {draggable: true, onDragStart: (event: DragEvent) => {event.dataTransfer.setData('text/plain', node.drag!); event.dataTransfer.effectAllowed = 'move'; setDragging(node.drag);}, onDragEnd: () => {setDragging(undefined); setOver(false);}} : {}),
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
  return <div className="mm-box" data-kind={node.kind} data-tone={node.tone} data-selected={isSelected || undefined} data-fixed={fixed || undefined} data-fresh={node.fresh || undefined} onContextMenu={event => {if (menu.current) {event.preventDefault(); menu.current.open = true; menu.current.querySelector('button')?.focus();}}} data-drop={canDrop ? (over ? 'over' : 'ready') : undefined} {...events}>
    <div className="mm-main" id={`${prefix}-${node.id}`} role="treeitem" aria-selected={isSelected} aria-expanded={foldable ? !folded : undefined}>
      {node.fresh && <span className="mm-new" role="img" aria-label="新"/>}
      {node.content ?? <button type="button" className="mm-label" onClick={event => {
        if (isSelected && node.onEdit) node.onEdit({point: {x: event.clientX, y: event.clientY}});
        else select(node);
      }} onDoubleClick={event => {if (!isSelected) node.onEdit?.({point: {x: event.clientX, y: event.clientY}});}}>
        {node.label}{node.meta && <small>{node.meta}</small>}
      </button>}
    </div>
    {isSelected && !folded && node.onAdd && <button type="button" className="mm-add" aria-label="添加记忆" title="添加记忆" onClick={node.onAdd}>+</button>}
    {foldable && (folded || !isSelected) && <button type="button" className="mm-fold" data-collapsed={folded || undefined}
      aria-label={folded ? '展开' : '收起'} aria-expanded={!folded} onClick={toggle}>{folded ? node.childCount ?? node.children?.length : '‹'}</button>}

    {node.menu && node.menu.length > 0 && <details ref={menu} className="mm-menu" onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;}}>
      <summary aria-label="更多操作" title="更多操作"><MoreHorizontal size={14} aria-hidden="true"/></summary>
      <div role="menu">{node.menu.map(item => <button type="button" role="menuitem" key={item.id} data-danger={item.danger || undefined}
        onClick={event => {event.currentTarget.closest('details')?.removeAttribute('open'); item.onSelect();}}>{item.label}</button>)}</div>
    </details>}
  </div>;
}
