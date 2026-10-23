import type {ReactNode} from 'react';
import type {MemoryItem} from '@vonvon/protocol';
import type {MapMenuItem, MapNode} from './MindMap';
import {shownLeaves, type BranchView, type SearchPlan} from './memory-model';

export type NodeInput = {
  views: {branches: BranchView[]; archived: BranchView[]};
  plan: SearchPlan;
  items: ReadonlyMap<string, MemoryItem>;
  selected?: string;
  /** Folds: a node is open unless the person flipped it from `initially`; a search opens the branches it found. */
  isOpen: (id: string, initially: boolean) => boolean;
  flip: (id: string) => void;
  leafMenu: (item: MemoryItem) => MapMenuItem[];
  branchMenu: (view: BranchView) => MapMenuItem[];
  onLeaf: (item: MemoryItem, archived: boolean) => void;
  /** The in-place editor, when this leaf is being edited. */
  leafContent: (item: MemoryItem) => ReactNode | undefined;
  /** A leaf dropped on a branch of the same memory. */
  moveTo: (itemId: string, branch: string) => void;
};

/** The branch nodes of one memory and its 已归档 node (§5.7): leaves newest first, 8 per branch, search highlights, pending dashed. */
export function memoryNodes(input: NodeInput): {branches: MapNode[]; archive: MapNode[]} {
  const {views, plan, items, isOpen, flip} = input;
  const leaf = (item: MemoryItem, archived: boolean): MapNode => {
    const content = input.leafContent(item);
    return {
      id: `i:${item.id}`, kind: 'leaf', label: item.text, selected: input.selected === item.id,
      tone: archived ? 'muted' : plan.active ? (plan.leaves.has(item.id) ? 'match' : 'dim') : item.trust === 'untrusted' ? 'pending' : undefined,
      meta: item.trust === 'untrusted' && !archived ? '待确认' : undefined,
      onClick: () => input.onLeaf(item, archived), menu: input.leafMenu(item), ...(archived ? {} : {drag: item.id}), ...(content ? {content} : {}),
    };
  };
  const branch = (view: BranchView, archived: boolean): MapNode => {
    const id = `${archived ? 'a' : 'b'}:${view.name}`;
    const {shown, hidden} = shownLeaves(view.items, isOpen(`m:${id}`, false), plan.leaves);
    const more: MapNode[] = hidden > 0 ? [{id: `m:${id}`, kind: 'more', label: `还有 ${hidden} 条`, onClick: () => flip(`m:${id}`)}] : [];
    const hit = plan.active && plan.branches.has(view.name);
    return {
      id, kind: 'branch', label: view.name, open: isOpen(id, plan.active ? hit : !archived), onToggle: () => flip(id),
      tone: archived ? 'muted' : plan.active ? (plan.named.has(view.name) ? 'match' : hit ? undefined : 'dim') : undefined,
      meta: `${view.items.length}${view.pending ? ` · 待确认 ${view.pending}` : ''}`,
      menu: archived ? [] : input.branchMenu(view),
      children: [...shown.map(item => leaf(item, archived)), ...more],
      ...(archived ? {} : {drop: {accepts: (dragged: string) => items.get(dragged)?.state === 'active' && items.get(dragged)?.branch !== view.name, onDrop: (dragged: string) => input.moveTo(dragged, view.name)}}),
    };
  };
  const count = views.archived.reduce((sum, view) => sum + view.items.length, 0);
  return {
    branches: views.branches.map(view => branch(view, false)),
    archive: count ? [{
      id: 'archive', kind: 'archive', label: '已归档', meta: String(count), tone: 'muted',
      open: isOpen('archive', plan.active && views.archived.some(view => plan.branches.has(view.name))), onToggle: () => flip('archive'),
      children: views.archived.map(view => branch(view, true)),
    }] : [],
  };
}
