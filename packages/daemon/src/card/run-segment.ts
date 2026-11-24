import type { Block, RunState } from './run-state';

export interface ConsumedBlockState {
  readonly kind: Block['kind'];
  /** Exact prefix already committed to earlier card(s) for text/reasoning blocks. */
  readonly committedPrefix?: string;
  /** True when a tool/compaction was still running across a steer boundary and
   * should still surface its eventual result on the next card. */
  readonly wasRunning?: boolean;
  /** True when this block was completely rendered on an earlier card. */
  readonly fullyConsumed?: boolean;
}

/**
 * Unified display cursor across multi-card turns (both steer splits and
 * capacity-driven continuation cards). Tracks what portion of the full
 * `RunState.blocks` has already been committed to earlier frozen cards so every
 * process item and answer segment appears once, in original order.
 */
export interface DisplayCursor {
  readonly consumed: ReadonlyMap<string, ConsumedBlockState>;
  readonly startedAt?: number;
}

export const EMPTY_DISPLAY_CURSOR: DisplayCursor = {
  consumed: new Map(),
};

export function blockKey(block: Block): string {
  if (block.kind === 'tool') return `tool:${block.tool.id}`;
  if (block.kind === 'compaction') return `compaction:${block.compaction.id}`;
  return `${block.kind}:${block.id}`;
}

/** A steer changes the display destination, not the backend turn. Subtract the
 * already displayed prefix, including later full snapshots of the same item. */
export function runSegment(state: RunState, boundary?: RunState, startedAt?: number): RunState {
  if (!boundary) return state;
  return sliceRunState(state, cursorFromSteerBoundary(boundary, startedAt));
}

export function cursorFromSteerBoundary(boundary: RunState, startedAt?: number): DisplayCursor {
  const consumed = new Map<string, ConsumedBlockState>();
  for (const block of boundary.blocks) {
    const k = blockKey(block);
    if (block.kind === 'tool') {
      const running = block.tool.status === 'running';
      consumed.set(k, { kind: 'tool', wasRunning: running, fullyConsumed: !running });
    } else if (block.kind === 'compaction') {
      const running = block.compaction.status === 'running';
      consumed.set(k, { kind: 'compaction', wasRunning: running, fullyConsumed: !running });
    } else {
      consumed.set(k, { kind: block.kind, committedPrefix: block.content });
    }
  }
  return { consumed, startedAt };
}

/**
 * Advance `cursor` when freezing a card on a capacity boundary.
 *
 * - `completedBlocks`: whole blocks rendered completely on the frozen card.
 * - `partialBlock`: an in-progress or oversized text/reasoning block whose
 *   first `consumedChars` characters (relative to the current unconsumed
 *   segment view!) were frozen onto the card.
 */
export function advanceDisplayCursor(
  cursor: DisplayCursor,
  currentSegment: RunState,
  committed: {
    readonly completedBlocks?: readonly Block[];
    readonly partialBlock?: { readonly key: string; readonly kind: 'text' | 'reasoning'; readonly consumedChars: number };
    readonly nextStartedAt?: number;
  },
): DisplayCursor {
  const next = new Map(cursor.consumed);
  const segByKey = new Map(currentSegment.blocks.map(block => [blockKey(block), block]));

  for (const block of committed.completedBlocks ?? []) {
    const k = blockKey(block);
    if (block.kind === 'tool' || block.kind === 'compaction') {
      next.set(k, { kind: block.kind, fullyConsumed: true });
    } else {
      const prevPrefix = next.get(k)?.committedPrefix ?? '';
      const seg = segByKey.get(k);
      const added = seg && (seg.kind === 'text' || seg.kind === 'reasoning') ? seg.content : block.content;
      next.set(k, {
        kind: block.kind,
        committedPrefix: prevPrefix + added,
        fullyConsumed: !block.streaming,
      });
    }
  }

  if (committed.partialBlock) {
    const { key, kind, consumedChars } = committed.partialBlock;
    const prevPrefix = next.get(key)?.committedPrefix ?? '';
    const seg = segByKey.get(key);
    if (seg && (seg.kind === 'text' || seg.kind === 'reasoning') && consumedChars > 0) {
      const added = seg.content.slice(0, consumedChars);
      next.set(key, {
        kind,
        committedPrefix: prevPrefix + added,
        fullyConsumed: false,
      });
    }
  }

  return { consumed: next, startedAt: committed.nextStartedAt ?? cursor.startedAt };
}

/**
 * Project the full turn `state` through `cursor` to obtain the unconsumed
 * suffix for the active card.
 */
export function sliceRunState(state: RunState, cursor?: DisplayCursor): RunState {
  if (!cursor || cursor.consumed.size === 0) {
    return cursor?.startedAt !== undefined ? { ...state, startedAt: cursor.startedAt } : state;
  }
  const blocks: Block[] = [];
  for (const block of state.blocks) {
    const entry = cursor.consumed.get(blockKey(block));
    if (!entry) {
      blocks.push(block);
      continue;
    }
    if (block.kind === 'tool' || block.kind === 'compaction') {
      if (entry.wasRunning && !entry.fullyConsumed) blocks.push(block);
      continue;
    }
    if (entry.fullyConsumed) {
      // A completed text/reasoning block was already rendered in full on an earlier card.
      // Only resurface if a later snapshot appended content beyond its committed prefix.
      const prefix = entry.committedPrefix ?? '';
      if (prefix && block.content.startsWith(prefix)) {
        const extra = block.content.slice(prefix.length);
        if (extra.trim()) blocks.push({ ...block, content: extra });
      }
      continue;
    }
    const prefix = entry.committedPrefix ?? '';
    // A rewritten final snapshot has no reliable split point. Preserve the
    // correction in full instead of silently discarding the final answer.
    const content = block.content.startsWith(prefix) ? block.content.slice(prefix.length) : block.content;
    if (content) blocks.push({ ...block, content });
  }
  return {
    ...state,
    blocks,
    startedAt: cursor.startedAt,
    reasoning: blocks.flatMap(block => (block.kind === 'reasoning' ? [{ id: block.id, text: block.content }] : [])),
  };
}
