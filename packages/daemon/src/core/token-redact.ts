import type { AgentEvent } from '../agent/types';

const HIDDEN = '[已隐藏的 vonvon 令牌]';
const FORMATS = [
  { head: 'vvs1_', body: '[A-Za-z0-9_-]', count: 43 },
  { head: 'dnZzMV', body: '[89+/][A-Za-z0-9+/]', count: 58 },
  { head: 'dnZzMV', body: '[89_-][A-Za-z0-9_-]', count: 58 },
];
const TOKEN = /vvs1_[A-Za-z0-9_-]{43}|dnZzMV[89+/][A-Za-z0-9+/]{57}|dnZzMV[89_-][A-Za-z0-9_-]{57}/g;

export function redactTokens(text: string): string {
  return text.replace(TOKEN, HIDDEN);
}

const PREFIXES = FORMATS.flatMap(({ head, body, count }) => {
  const prefixes: RegExp[] = [];
  for (let n = 1; n < head.length; n++) prefixes.push(new RegExp(`^${head.slice(0, n)}$`));
  if (head === 'vvs1_') prefixes.push(new RegExp(`^${head}${body}{0,${count - 1}}$`));
  else prefixes.push(new RegExp(`^${head}(?:${body}{0,${count - 2}})?$`));
  return prefixes;
});

function tailStart(text: string): number {
  for (let start = Math.max(0, text.length - 63); start < text.length; start++) {
    if (PREFIXES.some(prefix => prefix.test(text.slice(start)))) return start;
  }
  return text.length;
}

// Agent events contain plain records, arrays and primitives. Walk values only:
// optional undefined fields, numbers and booleans retain their original shape.
function redactStrings<T>(value: T): T;
function redactStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactTokens(value);
  if (Array.isArray(value)) return value.map(item => redactStrings(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item)]));
  }
  return value;
}

type Delta = Extract<AgentEvent, { type: 'text_delta' | 'thinking_delta' }>;

/** Hold only a possible token prefix, separately for each item and channel. */
export function redactAgentEvents(events: AsyncIterable<AgentEvent>) {
  let cancelled = false;
  let cancelPending: (() => void) | undefined;
  const cancel = (): void => { cancelled = true; cancelPending?.(); };
  const output = consume();
  return {
    next: () => output.next(),
    return: async () => { cancel(); return output.return(undefined); },
    throw: async (error: unknown) => { cancel(); return output.throw(error); },
    [Symbol.asyncIterator]() { return this; },
  };

  async function* consume(): AsyncGenerator<AgentEvent, void> {
    const tails = new Map<string, Delta>();
    const keyOf = (type: Delta['type'], itemId: string): string => JSON.stringify([type, itemId]);
    function* flush(key?: string): Generator<Delta> {
      for (const [id, event] of tails) {
        if (key !== undefined && id !== key) continue;
        tails.delete(id);
        yield redactStrings({ ...event, delta: redactTokens(event.delta) });
      }
    }
    const iterator = events[Symbol.asyncIterator]();
    let ended = false;
    let pending = false;
    try {
      while (true) {
        let next: IteratorResult<AgentEvent>;
        try {
          const cancellation = new Promise<IteratorResult<AgentEvent>>(resolve => {
            cancelPending = () => resolve({ done: true, value: undefined });
          });
          pending = true;
          const step = Promise.resolve(iterator.next()).finally(() => { pending = false; });
          next = await Promise.race([step, cancellation]);
          if (cancelled) return;
        }
        catch (error) {
          if (cancelled) return;
          ended = true;
          yield* flush();
          throw error;
        } finally { cancelPending = undefined; }
        if (next.done) {
          ended = true;
          yield* flush();
          return;
        }
        const event = next.value;
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          const key = keyOf(event.type, event.itemId);
          const text = redactTokens((tails.get(key)?.delta ?? '') + event.delta);
          const start = tailStart(text);
          if (start > 0 || text.length === 0) tails.delete(key);
          if (start < text.length) tails.set(key, { ...event, delta: text.slice(start) });
          if (start > 0 || text.length === 0) yield redactStrings({ ...event, delta: text.slice(0, start) });
          continue;
        }
        if (event.type === 'text' || event.type === 'thinking') {
          yield* flush(keyOf(event.type === 'text' ? 'text_delta' : 'thinking_delta', event.itemId));
        } else if (event.type === 'done' || event.type === 'error') yield* flush();
        yield redactStrings(event);
      }
    } finally {
      tails.clear();
      if (!ended) {
        const closing = iterator.return?.();
        // A provider can keep next() pending forever. Request closure without
        // making a cancelled consumer wait for that provider to unblock.
        if (cancelled && pending) void Promise.resolve(closing).catch(() => undefined);
        else await closing;
      }
    }
  }
}
