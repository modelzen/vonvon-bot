import type { MemoryStore } from './memory-store';
import { acceptedNonces, type MemoryDelivered, type SessionContext } from './session-store';
import type { RawBlock } from './hidden-blocks';
import { parseUsageBlocks, parseUsageMarkers } from './usage-marker';

/** The memory stores a turn's entries came from, to put the use in the right `usage.json`. */
export interface TurnStores { bot?: MemoryStore; project?: MemoryStore; dm?: MemoryStore }

/** Every entry id the session holds as of this turn: what its opening and the updates handed over. */
export function deliveredIds(context: SessionContext): Set<string> {
  const ids = new Set<string>();
  for (const memory of Object.values(context.memory ?? {})) for (const id of Object.keys(memory.items)) ids.add(id);
  return ids;
}

/**
 * The end of a turn (4.5): which entries the model said it used, checked against what the session holds, recorded in
 * `lastTurn`. Whether anything is listed does not change what the next turn hands over, so the versions stay.
 */
export function settleTurn(
  context: SessionContext, replyText: string, at: number = Date.now(),
  /** The `<vonvon-mem>` markers the stream filter took out of the reply (the reply text no longer has them). */
  marks: readonly RawBlock[] = [],
): { context: SessionContext; used: string[] } {
  const ids = deliveredIds(context);
  const nonces = acceptedNonces(context);
  const used = [...new Set([...parseUsageBlocks(marks, nonces, ids), ...parseUsageMarkers(replyText, nonces, ids)])];
  return { context: { ...context, lastTurn: { at, injected: ids.size, used } }, used };
}

/** Best effort and outside every lock (2.4): a use that cannot be written is lost, the turn is not. */
export async function recordUsage(context: SessionContext, used: readonly string[], stores: TurnStores | undefined): Promise<void> {
  if (!stores || !used.length) return;
  const memory: Record<string, MemoryDelivered | undefined> = context.memory ?? {};
  for (const kind of ['bot', 'project', 'dm'] as const) {
    const store = stores[kind];
    const mine = used.filter(id => memory[kind]?.items[id]);
    if (store && mine.length) await store.recordUsage(mine).catch(() => undefined);
  }
}
