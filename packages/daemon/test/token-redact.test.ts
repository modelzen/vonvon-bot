import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withIdleTimeout } from '../src/bot/watchdog';
import type { AgentEvent } from '../src/agent/types';
import { redactAgentEvents, redactTokens } from '../src/core/token-redact';

const token = `vvs1_${randomBytes(32).toString('base64url')}`;
const encoded = Buffer.from(token).toString('base64');
const url = Buffer.from(token).toString('base64url');
const hidden = '[已隐藏的 vonvon 令牌]';
async function* source(events: AgentEvent[]): AsyncGenerator<AgentEvent> { yield* events; }
async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const output: AgentEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}
async function collect(events: AgentEvent[]): Promise<AgentEvent[]> {
  return drain(redactAgentEvents(source(events)));
}
const deltaText = (events: AgentEvent[]): string => events.map(e => e.type === 'text_delta' || e.type === 'thinking_delta' ? e.delta : '').join('');

describe('token formats', () => {
  it('uses real encodings, including echo newline, and URL encoding is identity', () => {
    expect(encodeURIComponent(token)).toBe(token);
    for (const value of [token, encoded, url]) expect(redactTokens(`before ${value} after`)).toBe(`before ${hidden} after`);
    expect(redactTokens(Buffer.from(`${token}\n`).toString('base64'))).toBe(`${hidden}Cg==`);
  });
  it('keeps ordinary text and near misses', () => {
    for (const text of ['vvs1_' + 'a'.repeat(42), 'vvs2_' + 'a'.repeat(43), 'vvs', 'dnZzM', '中文🙂', Buffer.from('ordinary text').toString('base64')]) {
      expect(redactTokens(text)).toBe(text);
    }
  });
});

for (const channel of ['text_delta', 'thinking_delta'] as const) {
  for (const [format, value] of [['raw', token], ['base64', encoded], ['base64url', url]] as const) {
    it(`${channel} ${format}: every split and character-at-a-time stream`, async () => {
      for (let split = 1; split < value.length; split++) {
        const first = { type: channel, itemId: 'a', delta: value.slice(0, split) } satisfies AgentEvent;
        const iterator = redactAgentEvents(source([first, { ...first, delta: value.slice(split) }]));
        const output = await drain(iterator);
        expect(deltaText(output)).toBe(hidden);
      }
      expect(deltaText(await collect([...value].map(delta => ({ type: channel, itemId: 'a', delta }))))).toBe(hidden);
    });
  }
}

it('does not emit any token prefix while waiting for the second chunk', async () => {
  let advance!: () => void;
  const wait = new Promise<void>(resolve => { advance = resolve; });
  let delivered = false;
  async function* chunks(): AsyncGenerator<AgentEvent> {
    yield { type: 'text_delta', itemId: 'a', delta: token.slice(0, 30) };
    await wait;
    yield { type: 'text_delta', itemId: 'a', delta: token.slice(30) };
  }
  const iterator = redactAgentEvents(chunks());
  const next = iterator.next().then(value => { delivered = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  expect(delivered).toBe(false);
  advance();
  expect((await next).value).toEqual({ type: 'text_delta', itemId: 'a', delta: hidden });
  await iterator.return();
});

it('flushes short prefixes at text/thinking, done, error and natural end', async () => {
  for (const ending of [undefined, { type: 'done', turnId: 't' }, { type: 'error', message: 'oops', willRetry: false }] satisfies (AgentEvent | undefined)[]) {
    const events: AgentEvent[] = [{ type: 'text_delta', itemId: 'a', delta: 'ordinary vvs1_' }];
    if (ending) events.push(ending);
    const output = await collect(events);
    expect(deltaText(output)).toBe('ordinary vvs1_');
    if (ending) expect(output.at(-1)).toEqual(ending);
  }
  for (const [delta, complete] of [['text_delta', 'text'], ['thinking_delta', 'thinking']] as const) {
    const output = await collect([{ type: delta, itemId: 'a', delta: 'vvs1_' }, { type: complete, itemId: 'a', text: 'vvs1_' }]);
    expect(output).toEqual([{ type: delta, itemId: 'a', delta: 'vvs1_' }, { type: complete, itemId: 'a', text: 'vvs1_' }]);
  }
});

it('isolates items and channels and only flushes the completed item/channel', async () => {
  const output = await collect([
    { type: 'text_delta', itemId: 'a', delta: 'vvs1_' },
    { type: 'thinking_delta', itemId: 'a', delta: 'dnZzMV' },
    { type: 'text_delta', itemId: 'b', delta: 'vvs' },
    { type: 'text', itemId: 'b', text: 'vvs' },
    { type: 'done', turnId: 't' },
  ]);
  expect(output).toEqual([
    { type: 'text_delta', itemId: 'b', delta: 'vvs' },
    { type: 'text', itemId: 'b', text: 'vvs' },
    { type: 'text_delta', itemId: 'a', delta: 'vvs1_' },
    { type: 'thinking_delta', itemId: 'a', delta: 'dnZzMV' },
    { type: 'done', turnId: 't' },
  ]);
});

it('redacts every textual field without changing ordinary control fields or undefined', async () => {
  const events: AgentEvent[] = [
    { type: 'tool_use', itemId: 'tool', title: token, detail: encoded, kind: 'tool' },
    { type: 'tool_result', itemId: 'tool', output: url, exitCode: null },
    { type: 'text', itemId: 'a', text: token }, { type: 'thinking', itemId: 'a', text: token },
    { type: 'subagent_start', id: 'child', parentId: undefined, name: token, task: encoded, stoppable: true },
    { type: 'subagent_step', id: 'child', stepId: 'step', title: token, status: 'running' },
    { type: 'subagent_status', id: 'child', status: 'completed', result: token },
    { type: 'error', message: token, willRetry: false },
    { type: 'ask', subagentId: 'child', request: { id: 'ask', kind: 'choices', title: token, acceptedConsequence: token, declinedConsequence: token,
      questions: [{ id: 'q', title: token, detail: token, selection: 'single', other: false, options: [{ id: 'o', label: token, description: token }] }] } },
  ];
  const output = await collect(events);
  expect(JSON.stringify(output)).not.toContain(token);
  expect(JSON.stringify(output)).not.toContain(encoded);
  expect(JSON.stringify(output)).not.toContain(url);
  expect(output[0]).toEqual({ type: 'tool_use', itemId: 'tool', title: hidden, detail: hidden, kind: 'tool' });
  expect(output[4]).toEqual({ type: 'subagent_start', id: 'child', parentId: undefined, name: hidden, task: hidden, stoppable: true });
  const plain: AgentEvent[] = [{ type: 'usage', inputTokens: 2, outputTokens: undefined }, { type: 'text_delta', itemId: 'a', delta: '中文🙂普通分段' },
    { type: 'ask', request: { kind: 'confirmation', id: 'a', title: 'confirm', detail: 'detail', acceptedConsequence: 'yes', declinedConsequence: 'no' } }];
  expect(await collect(plain)).toEqual(plain);
});

it('flushes on upstream throw then rethrows the identical error', async () => {
  const error = new Error('fixture failure');
  async function* failing(): AsyncGenerator<AgentEvent> {
    yield { type: 'text_delta', itemId: 'a', delta: 'ordinary vvs1_' };
    throw error;
  }
  const output: AgentEvent[] = [];
  let caught: unknown;
  try { for await (const event of redactAgentEvents(failing())) output.push(event); }
  catch (failure) { caught = failure; }
  expect(caught).toBe(error);
  expect(deltaText(output)).toBe('ordinary vvs1_');
});

it('consumer return closes source without flushing the held tail', async () => {
  let closed = false;
  async function* endless(): AsyncGenerator<AgentEvent> {
    try {
      yield { type: 'text_delta', itemId: 'a', delta: 'ordinary vvs1_' };
      throw new Error('must not advance');
    } finally { closed = true; }
  }
  const iterator = redactAgentEvents(endless());
  expect(await iterator.next()).toEqual({ done: false, value: { type: 'text_delta', itemId: 'a', delta: 'ordinary ' } });
  expect(await iterator.return()).toEqual({ done: true, value: undefined });
  expect(closed).toBe(true);
});

it('redacts string fields on flushed deltas too', async () => {
  expect(await collect([{ type: 'text_delta', itemId: token, delta: 'vvs1_' }])).toEqual([
    { type: 'text_delta', itemId: hidden, delta: 'vvs1_' },
  ]);
});

it('watchdog stop does not deliver a pending tail to the stopped card', async () => {
  let stopped!: () => void;
  const stop = new Promise<void>(resolve => { stopped = resolve; });
  let pending!: () => void;
  const entered = new Promise<void>(resolve => { pending = resolve; });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  async function* events(): AsyncGenerator<AgentEvent> {
    yield { type: 'text_delta', itemId: 'a', delta: 'ordinary vvs1_' };
    pending();
    await wait;
  }
  const guarded = withIdleTimeout(redactAgentEvents(events()), 0, () => undefined, stop);
  const output: AgentEvent[] = [];
  const consuming = (async () => { for await (const event of guarded) output.push(event); })();
  await entered;
  stopped();
  await consuming;
  release();
  await Promise.resolve();
  expect(deltaText(output)).toBe('ordinary ');
});

it('return interrupts a pending next without waiting for the provider', async () => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let closed = false;
  const input: AsyncIterableIterator<AgentEvent> = {
    next() { entered(); return new Promise(() => undefined); },
    async return() { closed = true; return { done: true, value: undefined }; },
    [Symbol.asyncIterator]() { return this; },
  };
  const iterator = redactAgentEvents(input);
  const next = iterator.next();
  await waiting;
  expect(await iterator.return()).toEqual({ done: true, value: undefined });
  expect(await next).toEqual({ done: true, value: undefined });
  expect(closed).toBe(true);
});

it('retains the original order of tails continued between interleaved items', async () => {
  const output = await collect([
    { type: 'text_delta', itemId: 'a', delta: 'vvs' },
    { type: 'thinking_delta', itemId: 'b', delta: 'dn' },
    { type: 'text_delta', itemId: 'a', delta: '1_' },
  ]);
  expect(output).toEqual([
    { type: 'text_delta', itemId: 'a', delta: 'vvs1_' },
    { type: 'thinking_delta', itemId: 'b', delta: 'dn' },
  ]);
});
