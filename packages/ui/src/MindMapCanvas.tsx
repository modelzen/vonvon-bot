import {useLayoutEffect, useRef, useState} from 'react';
import type MindElixir from 'mind-elixir';
import type {MainLineParams, NodeObj, SubLineParams} from 'mind-elixir';
import 'mind-elixir/style.css';

export type CanvasNode = {id: string; expanded: boolean; children: CanvasNode[]};
type Engine = InstanceType<typeof MindElixir>;
type Topic = HTMLElement & {nodeObj: NodeObj};
type Expander = HTMLElement & {expanded?: boolean};

/** Only ids, order and fold state affect library geometry. Text and selection remain React portal updates. */
export function canvasStructure(node: CanvasNode): string {
  return JSON.stringify([node.id, node.expanded, node.children.map(canvasStructure)]);
}

function roundedBranch(startX: number, startY: number, endX: number, endY: number, trunkLength: number): string {
  const gap = endX - startX;
  if (gap <= 0 || Math.abs(endY - startY) < 2) return `M ${startX} ${startY} H ${endX}`;
  const trunkX = startX + Math.min(trunkLength, gap / 2);
  const radius = Math.max(0, Math.min(12, (endX - trunkX) / 2, Math.abs(endY - startY) / 2));
  if (radius < 1) return `M ${startX} ${startY} H ${trunkX} V ${endY} H ${endX}`;
  const turn = Math.sign(endY - startY);
  const verticalX = trunkX + radius;
  return `M ${startX} ${startY} H ${trunkX} Q ${verticalX} ${startY} ${verticalX} ${startY + turn * radius} V ${endY - turn * radius} Q ${verticalX} ${endY} ${verticalX + radius} ${endY} H ${endX}`;
}

/** Start at the root's right edge, then make a short trunk and a rounded fork. */
export function mainBranchPath({pT, pL, pW, pH, cT, cL, cH}: MainLineParams): string {
  return roundedBranch(pL + pW, pT + pH / 2, cL, cT + cH / 2, 30);
}

/** MindElixir passes parent rectangles; account for its topic padding at each depth. */
export function subBranchPath(this: Engine, {pT, pL, pW, pH, cT, cL, cH, isFirst}: SubLineParams): string {
  const inset = Number.parseFloat(this.container.style.getPropertyValue('--node-gap-x')) || 22;
  return roundedBranch(pL + pW - (isFirst ? 0 : inset), pT + pH / 2,
    cL + inset, cT + cH / 2, 12);
}

const slotHTML = (id: string) => `<span class="mm-slot" data-mm-slot="${encodeURIComponent(id)}"></span>`;
function nodeData(node: CanvasNode): NodeObj {
  return {id: node.id, topic: '', expanded: node.expanded, dangerouslySetInnerHTML: slotHTML(node.id),
    children: node.children.map(nodeData)};
}
function linkParents(node: NodeObj, parent?: NodeObj) {
  if (parent) node.parent = parent;
  node.children?.forEach(child => linkParents(child, node));
}
function topicOf(wrapper: HTMLElement): Topic | null {
  return wrapper.querySelector(':scope > me-parent > me-tpc') as Topic | null;
}
function collectSlots(host: HTMLElement) {
  const next = new Map<string, HTMLElement>();
  host.querySelectorAll<HTMLElement>('[data-mm-slot]').forEach(slot => {
    const id = slot.dataset.mmSlot;
    if (id !== undefined) next.set(decodeURIComponent(id), slot);
  });
  return next;
}
function reconcile(engine: Engine, data: NodeObj, wrappers: Map<string, HTMLElement>, detached: Map<string, HTMLElement>) {
  engine.nodeData = data;
  linkParents(data);
  const root = engine.nodes.querySelector<Topic>('me-root > me-tpc');
  if (root) root.nodeObj = data;
  const main = engine.nodes.querySelector<HTMLElement>('me-main.rhs');
  if (!main) return;
  const childrenOf = (parent: HTMLElement, children: NodeObj[]) => {
    const wanted = new Set(children.map(child => child.id));
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      let wrapper = wrappers.get(child.id);
      if (!wrapper) {
        // Build descendants ourselves so every wrapper is tracked and reused.
        wrapper = engine.createWrapper(child, true).grp;
        wrappers.set(child.id, wrapper);
      }
      if (parent.children[index] !== wrapper) parent.insertBefore(wrapper, parent.children[index] ?? null);
      const topic = topicOf(wrapper);
      if (topic) topic.nodeObj = child;
      const parentElement = wrapper.querySelector<HTMLElement>(':scope > me-parent');
      if (!parentElement) continue;
      let expander = parentElement.querySelector<Expander>(':scope > me-epd');
      if (child.children?.length && !expander) {
        expander = document.createElement('me-epd') as Expander;
        parentElement.appendChild(expander);
      }
      if (expander) expander.expanded = child.expanded !== false;
      let descendants = wrapper.querySelector<HTMLElement>(':scope > me-children') ?? detached.get(child.id);
      if (child.children?.length && !descendants) {
        descendants = engine.createChildren([]);
      }
      if (descendants) {
        childrenOf(descendants, child.children ?? []);
        if (child.expanded === false || !child.children?.length) {
          descendants.remove();
          detached.set(child.id, descendants);
        } else {
          if (descendants.parentElement !== wrapper) wrapper.insertBefore(descendants, wrapper.children[1] ?? null);
          detached.delete(child.id);
        }
      }
    }
    for (const element of Array.from(parent.children)) {
      if (element.tagName === 'ME-WRAPPER' && !wanted.has(topicOf(element as HTMLElement)?.nodeObj.id ?? '')) element.remove();
    }
  };
  const rootChildren = data.expanded === false ? [] : data.children ?? [];
  childrenOf(main, rootChildren);
  const ids = new Set<string>();
  const collect = (node: NodeObj) => {ids.add(node.id); node.children?.forEach(collect);};
  collect(data);
  for (const id of wrappers.keys()) if (!ids.has(id)) wrappers.delete(id);
  for (const id of detached.keys()) if (!ids.has(id)) detached.delete(id);
}

function positionOf(element: Element | null) {
  if (!element) return undefined;
  const bounds = element.getBoundingClientRect();
  return {x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2};
}

/** MindElixir owns links and camera gestures; React owns every visible node's content and actions. */
export function useMindMapCanvas(tree: CanvasNode, anchorId?: string, editingId?: string, focusRequest?: {id: string; token: number}) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const wrappers = useRef(new Map<string, HTMLElement>());
  const detached = useRef(new Map<string, HTMLElement>());
  const [slots, setSlots] = useState<Map<string, HTMLElement>>(new Map());
  const structure = canvasStructure(tree);
  const latest = useRef({tree, structure, anchorId});
  latest.current = {tree, structure, anchorId};
  const installed = useRef('');
  const frame = useRef<number | undefined>(undefined);
  const pendingAnchor = useRef<{id: string; before: {x: number; y: number}} | undefined>(undefined);
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const observedTopics = useRef(new Set<Element>());
  const visibleEditors = useRef(new WeakSet<Element>());
  const initialized = useRef(false);
  const pendingFocus = useRef<{id: string; token: number} | undefined>(undefined);
  const schedule = () => {
    if (frame.current !== undefined) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = undefined;
      const instance = engine.current;
      if (!instance || !host.current) return;
      instance.linkDiv();
      const rootTopic = instance.nodes.querySelector('me-root > me-tpc');
      if (!initialized.current && rootTopic?.querySelector('.mm-box')) {
        const canvas = host.current.getBoundingClientRect();
        const root = positionOf(rootTopic);
        if (root) {
          instance.move(canvas.left + Math.min(180, Math.max(90, canvas.width * .14)) - root.x,
            canvas.top + canvas.height / 2 - root.y);
        }
        initialized.current = true;
      } else if (pendingAnchor.current) {
        const {id, before} = pendingAnchor.current;
        const target = host.current?.querySelector<HTMLElement>(`[data-mm-slot="${encodeURIComponent(id)}"]`)?.closest('me-tpc');
        const after = positionOf(target ?? rootTopic);
        if (after) instance.move(before.x - after.x, before.y - after.y);
      }
      pendingAnchor.current = undefined;
      // A new inline editor can be created outside the viewport. Bring only
      // that new DOM instance into view; typing and polling leave the camera alone.
      const viewport = instance.container.getBoundingClientRect();
      if (pendingFocus.current) {
        const slot = host.current.querySelector<HTMLElement>(`[data-mm-slot="${encodeURIComponent(pendingFocus.current.id)}"]`);
        const target = slot?.closest('me-tpc')?.getBoundingClientRect();
        if (target?.width && target.height) {
          instance.move(viewport.left + viewport.width / 2 - (target.left + target.width / 2),
            viewport.top + viewport.height / 2 - (target.top + target.height / 2));
          pendingFocus.current = undefined;
        }
      }
      for (const editor of instance.nodes.querySelectorAll<HTMLElement>('.mm-inline-editor')) {
        if (visibleEditors.current.has(editor)) continue;
        const topic = editor.closest('me-tpc') ?? editor;
        const bounds = topic.getBoundingClientRect();
        if (!bounds.width || !bounds.height) continue;
        visibleEditors.current.add(editor);
        editor.addEventListener('wheel', event => {if (!event.ctrlKey && !event.metaKey) event.stopPropagation();}, {passive: true});
        const margin = 24;
        const left = viewport.left + margin, right = viewport.right - margin;
        const top = viewport.top + margin, bottom = viewport.bottom - margin;
        const dx = bounds.width > right - left ? left - bounds.left : bounds.left < left ? left - bounds.left : bounds.right > right ? right - bounds.right : 0;
        const dy = bounds.height > bottom - top ? top - bounds.top : bounds.top < top ? top - bounds.top : bounds.bottom > bottom ? bottom - bounds.bottom : 0;
        if (dx || dy) instance.move(dx, dy);
      }
    });
  };

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    let cancelled = false;
    void import('mind-elixir').then(({default: MindElixir}) => {
      if (cancelled || !host.current) return;
      const instance = new MindElixir({el: element, direction: MindElixir.RIGHT, editable: false, draggable: false,
        keypress: false, toolBar: false, contextMenu: false, allowUndo: false, overflowHidden: false,
        scaleMin: .45, scaleMax: 2, compact: false, theme: {
          name: 'Vonvon', type: 'light', palette: ['#7658d9', '#8d72e3', '#a18aea', '#7658d9'],
          generateMainBranch: mainBranchPath,
          generateSubBranch: subBranchPath,
          cssVar: {'--node-gap-x': '22px', '--node-gap-y': '10px', '--main-gap-x': '62px', '--main-gap-y': '14px',
            '--map-padding': '36px', '--topic-padding': '0px', '--bgcolor': 'transparent',
            '--main-color': '#7658d9', '--color': 'var(--color-text)', '--selected': '#7658d9',
            '--accent-color': '#7658d9'},
        }});
      engine.current = instance;
      // The native pointer listener runs before React's delegated portal handler. Keep
      // blank-space pan, but never start a camera drag from an interactive node.
      const originalPointerDown = instance.panHelper.handlePointerDown.bind(instance.panHelper);
      instance.panHelper.handlePointerDown = event => {
        if (!instance.spacePressed && event.target instanceof Element && event.target.closest('.mm-box')) return;
        originalPointerDown(event);
      };
      instance.init({nodeData: nodeData(latest.current.tree), direction: MindElixir.RIGHT});
      installed.current = latest.current.structure;
      instance.nodes.querySelectorAll<HTMLElement>('me-wrapper').forEach(wrapper => {
        const topic = topicOf(wrapper);
        if (topic) wrappers.current.set(topic.nodeObj.id, wrapper);
      });
      setSlots(collectSlots(element));
      if (typeof ResizeObserver !== 'undefined') {
        observer.current = new ResizeObserver(schedule);
        observer.current.observe(element);
        for (const topic of instance.nodes.querySelectorAll('me-tpc')) {
          observer.current.observe(topic);
          observedTopics.current.add(topic);
        }
      }
      schedule();
    });
    return () => {
      cancelled = true;
      observer.current?.disconnect();
      observer.current = undefined;
      observedTopics.current.clear();
      visibleEditors.current = new WeakSet();
      if (frame.current !== undefined) window.cancelAnimationFrame(frame.current);
      frame.current = undefined;
      engine.current?.destroy();
      engine.current = null;
      wrappers.current.clear();
      detached.current.clear();
      installed.current = '';
    };
  }, []);

  useLayoutEffect(() => {
    const instance = engine.current;
    if (!instance || !host.current || installed.current === structure) {
      if (instance && slots.size) schedule();
      return;
    }
    const id = anchorId && slots.has(anchorId) ? anchorId : tree.id;
    const anchor = slots.get(id) ?? slots.get(tree.id);
    const before = positionOf(anchor?.closest('me-tpc') ?? null);
    if (before) pendingAnchor.current = {id, before};
    reconcile(instance, nodeData(tree), wrappers.current, detached.current);
    installed.current = structure;
    const topics = new Set(instance.nodes.querySelectorAll('me-tpc'));
    for (const topic of observedTopics.current) if (!topics.has(topic)) {observer.current?.unobserve(topic); observedTopics.current.delete(topic);}
    for (const topic of topics) if (!observedTopics.current.has(topic)) {observer.current?.observe(topic); observedTopics.current.add(topic);}
    setSlots(collectSlots(host.current));
    schedule();
  }, [structure, slots]);

  useLayoutEffect(() => {if (editingId && engine.current) schedule();}, [editingId]);
  useLayoutEffect(() => {
    if (!focusRequest) return;
    pendingFocus.current = focusRequest;
    schedule();
  }, [focusRequest?.id, focusRequest?.token]);

  const reset = () => {
    const instance = engine.current;
    if (!instance || !host.current) return;
    pendingAnchor.current = undefined;
    instance.scale(1);
    instance.toCenter();
    const rootTopic = instance.nodes.querySelector('me-root > me-tpc');
    const root = positionOf(rootTopic);
    const canvas = host.current.getBoundingClientRect();
    if (root) instance.move(canvas.left + Math.min(180, Math.max(90, canvas.width * .14)) - root.x,
      canvas.top + canvas.height / 2 - root.y);
    initialized.current = true;
  };
  return {host, slots, reset};
}
