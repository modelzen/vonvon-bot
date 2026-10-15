import type { Block, RunState } from './run-state';

/** A steer changes the display destination, not the backend turn. Subtract the
 * already displayed prefix, including later full snapshots of the same item. */
export function runSegment(state: RunState, boundary?: RunState, startedAt?: number): RunState {
  if (!boundary) return state;
  const prior = new Map(boundary.blocks.map(block => [key(block), block]));
  const blocks: Block[] = [];
  for (const block of state.blocks) {
    const old = prior.get(key(block));
    if (!old) { blocks.push(block); continue; }
    if (block.kind === 'tool' || block.kind === 'compaction' || old.kind === 'tool' || old.kind === 'compaction') {
      // A tool or compaction already in flight crosses the boundary: keep its
      // eventual result accessible in the new card rather than losing it in a frozen one.
      const running = old.kind === 'tool' ? old.tool.status === 'running' : old.kind === 'compaction' && old.compaction.status === 'running';
      if (running) blocks.push(block);
      continue;
    }
    // A rewritten final snapshot has no reliable split point. Preserve the
    // correction in full instead of silently discarding the final answer.
    const content = block.content.startsWith(old.content) ? block.content.slice(old.content.length) : block.content;
    if (content) blocks.push({ ...block, content });
  }
  return {
    ...state, blocks, startedAt,
    reasoning: blocks.flatMap(block => block.kind === 'reasoning' ? [{ id: block.id, text: block.content }] : []),
  };
}

function key(block: Block): string {
  if (block.kind === 'tool') return `tool:${block.tool.id}`;
  if (block.kind === 'compaction') return `compaction:${block.compaction.id}`;
  return `${block.kind}:${block.id}`;
}
