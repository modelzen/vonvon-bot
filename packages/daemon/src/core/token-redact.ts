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

/**
 * 助手正文的第二道过滤（隐藏块，`bot/hidden-blocks.ts`），和令牌打码走同一条事件流，所以流式、终态、停止、出错
 * 四条路径都过它。只管 `text_delta` / `text`，不动思考。
 */
export interface AssistantTextFilter {
  /** 思考文字只剥不收：流式 delta（可选，没有就不过滤） */
  thinkDelta?(itemId: string, text: string): string;
  /** 思考终态整段只剥不收 */
  thinkFinal?(text: string): string;
  /** 一段流式 delta 进、能给人看的部分出（可能是空串） */
  delta(itemId: string, text: string): string;
  /** 这个 item 的流结束了，吐出还扣着的尾巴（没闭合的块丢掉） */
  flushItem(itemId: string): string;
  /** 终态整段文本进、剥完的出 */
  final(itemId: string, text: string): string;
  /** 事件流结束（done、出错、断流）时所有 item 还扣着的尾巴 */
  flushAll(): Array<{ itemId: string; text: string }>;
  /** `done` 之前调一次，这一轮的终态解析在这里做；做完才放 `done` 过去 */
  turnEnd?(): void | Promise<void>;
  /** 出错或断流：这一轮攒的块不解析，直接丢 */
  abandon?(): void;
}

/** Hold only a possible token prefix, separately for each item and channel. */
export function redactAgentEvents(events: AsyncIterable<AgentEvent>, filter?: AssistantTextFilter) {
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
        const delta = redactTokens(event.delta);
        const visible = filter && event.type === 'text_delta' ? filter.delta(event.itemId, delta)
          : filter?.thinkDelta && event.type === 'thinking_delta' ? filter.thinkDelta(event.itemId, delta) : delta;
        if (visible || !filter || event.type !== 'text_delta') yield redactStrings({ ...event, delta: visible });
      }
    }
    // The held-back tails of the hidden-block filter (a partial tag that turned out to be text).
    function* residue(itemId?: string): Generator<AgentEvent> {
      if (!filter) return;
      if (itemId !== undefined) {
        const text = filter.flushItem(itemId);
        if (text) yield { type: 'text_delta', itemId, delta: text };
        return;
      }
      for (const rest of filter.flushAll()) yield { type: 'text_delta', itemId: rest.itemId, delta: rest.text };
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
          yield* residue();
          filter?.abandon?.();
          throw error;
        } finally { cancelPending = undefined; }
        if (next.done) {
          ended = true;
          yield* flush();
          yield* residue();
          filter?.abandon?.();
          return;
        }
        const event = next.value;
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          const key = keyOf(event.type, event.itemId);
          const text = redactTokens((tails.get(key)?.delta ?? '') + event.delta);
          const start = tailStart(text);
          if (start > 0 || text.length === 0) tails.delete(key);
          if (start < text.length) tails.set(key, { ...event, delta: text.slice(start) });
          if (start > 0 || text.length === 0) {
            const piece = text.slice(0, start);
            const visible = filter && event.type === 'text_delta' ? filter.delta(event.itemId, piece)
              : filter?.thinkDelta && event.type === 'thinking_delta' ? filter.thinkDelta(event.itemId, piece) : piece;
            if (visible || !filter || event.type !== 'text_delta') yield redactStrings({ ...event, delta: visible });
          }
          continue;
        }
        if (event.type === 'text' || event.type === 'thinking') {
          yield* flush(keyOf(event.type === 'text' ? 'text_delta' : 'thinking_delta', event.itemId));
          if (filter && event.type === 'text') {
            yield* residue(event.itemId);
            yield redactStrings({ ...event, text: filter.final(event.itemId, redactTokens(event.text)) });
            continue;
          }
          if (filter?.thinkFinal && event.type === 'thinking') {
            yield redactStrings({ ...event, text: filter.thinkFinal(redactTokens(event.text)) });
            continue;
          }
        } else if (event.type === 'done' || event.type === 'error') {
          yield* flush();
          yield* residue();
          if (event.type === 'done') await filter?.turnEnd?.();
          else filter?.abandon?.();
        }
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
