import {useEffect, useRef, useState, type DragEvent, type ReactNode} from 'react';
import {MoreHorizontal} from 'lucide-react';
import './mind-map.css';

export type MapMenuItem = {id: string; label: string; onSelect: () => void; danger?: boolean};
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
  /** Left out: the node has no fold. Given: the arrow shows and `onToggle` flips it. */
  open?: boolean;
  onToggle?: () => void;
  onClick?: () => void;
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
  return <div className="mm" role="tree" aria-label={label}><MapTree node={root} dragging={dragging} setDragging={setDragging}/></div>;
}

type TreeProps = {node: MapNode; dragging?: string; setDragging: (value?: string) => void};
function MapTree({node, dragging, setDragging}: TreeProps) {
  const folded = node.open === false;
  const kids = node.children ?? [];
  return <div className="mm-tree" role="none">
    <div className="mm-self" role="none"><MapBox node={node} dragging={dragging} setDragging={setDragging}/></div>
    {kids.length > 0 && !folded && <Links count={kids.length}>
      {kids.map(child => <MapTree key={child.id} node={child} dragging={dragging} setDragging={setDragging}/>)}
    </Links>}
  </div>;
}

/** The children column and the curves from the parent (left, vertically centred) to each child's node. */
function Links({count, children}: {count: number; children: ReactNode}) {
  const column = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<{height: number; ends: number[]}>({height: 0, ends: []});
  useEffect(() => {
    const element = column.current;
    if (!element) return;
    const measure = () => {
      const ends = Array.from(element.children).flatMap(child => {
        const self = child.querySelector(':scope > .mm-self');
        return self instanceof HTMLElement ? [(child as HTMLElement).offsetTop + self.offsetTop + self.offsetHeight / 2] : [];
      });
      setPaths(previous => previous.height === element.offsetHeight && previous.ends.length === ends.length && previous.ends.every((end, at) => end === ends[at]) ? previous : {height: element.offsetHeight, ends});
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [count]);
  const middle = paths.height / 2;
  return <div className="mm-children" role="group" ref={column}>
    <svg className="mm-links" aria-hidden="true" width="28" height={paths.height || undefined} viewBox={`0 0 28 ${paths.height || 1}`}>
      {paths.ends.map((end, at) => <path key={at} d={`M0 ${middle} C14 ${middle} 14 ${end} 28 ${end}`} fill="none" stroke="currentColor" strokeWidth="1.2"/>)}
    </svg>
    {children}
  </div>;
}

function MapBox({node, dragging, setDragging}: {node: MapNode; dragging?: string; setDragging: (value?: string) => void}) {
  const [over, setOver] = useState(false);
  const canDrop = Boolean(node.drop && dragging !== undefined && node.drop.accepts(dragging));
  const foldable = node.open !== undefined && node.onToggle;
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
  return <div className="mm-box" data-kind={node.kind} data-tone={node.tone} data-selected={node.selected || undefined} data-fresh={node.fresh || undefined} data-drop={canDrop ? (over ? 'over' : 'ready') : undefined} {...events}>
    <div className="mm-main" role="treeitem" aria-selected={node.selected} aria-expanded={foldable ? node.open : undefined}>
      {foldable && <button type="button" className="mm-fold" aria-label={node.open ? '收起' : '展开'} aria-expanded={node.open} onClick={node.onToggle}>{node.open ? '−' : '+'}</button>}
      {node.fresh && <span className="mm-new" role="img" aria-label="新"/>}
      {node.content ?? (node.onClick
        ? <button type="button" className="mm-label" onClick={node.onClick}>{node.label}{node.meta && <small>{node.meta}</small>}</button>
        : <span className="mm-label">{node.label}{node.meta && <small>{node.meta}</small>}</span>)}
    </div>
    {node.menu && node.menu.length > 0 && <details className="mm-menu">
      <summary aria-label="更多操作" title="更多操作"><MoreHorizontal size={14} aria-hidden="true"/></summary>
      <div role="menu">{node.menu.map(item => <button type="button" role="menuitem" key={item.id} data-danger={item.danger || undefined}
        onClick={event => {event.currentTarget.closest('details')?.removeAttribute('open'); item.onSelect();}}>{item.label}</button>)}</div>
    </details>}
  </div>;
}
