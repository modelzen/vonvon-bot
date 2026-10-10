import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { expect, it, vi } from 'vitest';
import { createClaudeBackend } from '../src/agent/claude-provider';
import type { Logger } from '../src/agent/paseo/logger';
import type { AgentEvent } from '../src/agent/types';
import { finalMessageText, initialState, reduce } from '../src/card/run-state';

const logger: Logger = {
  child: () => logger,
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};
const init = (model?: string) => ({
  type: 'system', subtype: 'init', session_id: 'sdk-events', permissionMode: 'bypassPermissions', model,
});
const result = (usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }) => ({
  type: 'result', subtype: 'success', is_error: false, result: '', session_id: 'sdk-events', usage, total_cost_usd: 0,
});
const stream = (event: object) => ({ type: 'stream_event', session_id: 'sdk-events', event });
const block = (index: number, type: string, fragments: string[]) => [
  stream({ type: 'content_block_start', index, content_block: { type } }),
  ...fragments.map((text) => stream({ type: 'content_block_delta', index,
    delta: type === 'thinking' ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text } })),
  stream({ type: 'content_block_stop', index }),
];
const tool = (id: string, name: string, input: object) => ({
  type: 'assistant', uuid: `assistant-${id}`, session_id: 'sdk-events', parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, content: unknown, isError = false) => ({
  type: 'user', uuid: `result-${id}`, session_id: 'sdk-events', parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});

async function publicEvents(messages: unknown[]): Promise<AgentEvent[]> {
  let index = 0;
  const backend = createClaudeBackend({
    logger, resolveBinary: async () => '/mock/claude', resolveVersion: async () => '2.1.220',
    queryFactory: () => ({
      next: vi.fn(async () => index < messages.length
        ? { done: false, value: messages[index++] }
        : { done: true, value: undefined }),
      return: vi.fn(async () => ({ done: true, value: undefined })),
      [Symbol.asyncIterator]() { return this; },
      close: vi.fn(), interrupt: vi.fn(async () => {}), setPermissionMode: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}), supportedModels: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []), rewindFiles: vi.fn(async () => ({ canRewind: true })),
    } as unknown as Query),
  });
  const thread = await backend.startThread({ cwd: '/repo' });
  const events: AgentEvent[] = [];
  try {
    for await (const event of thread.runStreamed({ text: 'test SDK events' }).events) events.push(event);
  } finally {
    await thread.close();
  }
  return events;
}

it('suppresses duplicate SDK init and maps SDK automatic compaction', async () => {
  const events = await publicEvents([init(), init(), {
    type: 'system', subtype: 'compact_boundary', session_id: 'sdk-events',
    compact_metadata: { trigger: 'auto', pre_tokens: 9000 },
  }, result()]);
  expect(events.filter((event) => event.type === 'system')).toEqual([{ type: 'system', threadId: 'sdk-events' }]);
  expect(events.filter((event) => event.type === 'context_compacted')).toEqual([{ type: 'context_compacted' }]);
  expect(events.at(-1)?.type).toBe('done');
});

it('accumulates SDK text and thinking deltas and retains ordered separate text/tool items in the card', async () => {
  const events = await publicEvents([
    init(), stream({ type: 'message_start', message: { id: 'm1' } }),
    ...block(0, 'thinking', ['让我', '想想']), ...block(1, 'text', ['你好', '，世界']),
    stream({ type: 'message_stop' }),
    tool('read-1', 'Read', { file_path: '/repo/a.ts' }), toolResult('read-1', 'contents'), result(),
  ]);
  const state = events.reduce(reduce, initialState);
  expect(finalMessageText(state)).toBe('你好，世界');
  const thinking = events.filter((event) => event.type === 'thinking');
  expect(thinking.at(-1)).toMatchObject({ text: '让我想想' });
  const text = events.filter((event) => event.type === 'text');
  expect(text.at(-1)).toMatchObject({ text: '你好，世界' });
  expect(new Set(text.map((event) => event.itemId)).size).toBe(1);
  const ids = [...thinking, ...text, ...events.filter((event) => event.type === 'tool_use')].map((event) => event.itemId);
  expect(new Set(ids).size).toBe(3);
  expect(events.findIndex((event) => event.type === 'thinking')).toBeLessThan(events.findIndex((event) => event.type === 'text'));
  expect(events.findIndex((event) => event.type === 'text')).toBeLessThan(events.findIndex((event) => event.type === 'tool_use'));
});

it('preserves SDK Bash command description in public tool detail', async () => {
  const events = await publicEvents([init(), tool('bash-1', 'Bash', { command: 'ls -la', description: '列目录' }), toolResult('bash-1', 'files'), result()]);
  expect(events).toContainEqual({ type: 'tool_use', itemId: 'bash-1', title: 'ls -la', detail: '列目录', kind: 'command' });
});

it.each([
  ['success', '输出内容', false, '输出内容', 0],
  ['failure', '炸了', true, '炸了', 1],
  ['text array', [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }], false, 'AB', 0],
] as const)('preserves SDK %s tool results and exit status', async (_label, content, isError, output, exitCode) => {
  const events = await publicEvents([init(), tool('bash-1', 'Bash', { command: 'ls' }), toolResult('bash-1', content, isError), result()]);
  expect(events).toContainEqual({ type: 'tool_result', itemId: 'bash-1', output, exitCode });
});

it('adds SDK cache tokens and obtains the model context window from init', async () => {
  const events = await publicEvents([init('claude-opus-4-8[1m]'), result()]);
  expect(events).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 5 });
  expect(events).toContainEqual({ type: 'context_usage', usedTokens: 15, contextWindow: 1_000_000 });
});

it('retains an unknown context window when SDK init has no model', async () => {
  const events = await publicEvents([init(), result({ input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
  expect(events).toContainEqual({ type: 'context_usage', usedTokens: 10, contextWindow: null });
});

it('keeps successive SDK text messages distinct and ordered', async () => {
  const events = await publicEvents([
    init(), stream({ type: 'message_start', message: { id: 'first' } }),
    ...block(0, 'text', ['first ', 'answer']), stream({ type: 'message_stop' }),
    stream({ type: 'message_start', message: { id: 'second' } }),
    ...block(0, 'text', ['second ', 'answer']), stream({ type: 'message_stop' }), result(),
  ]);
  const text = events.filter((event) => event.type === 'text');
  expect(new Set(text.map((event) => event.itemId)).size).toBe(2);
  const complete = text.filter((event) => event.text.endsWith('answer'));
  expect(complete.map((event) => event.text)).toEqual(['first answer', 'second answer']);
});
