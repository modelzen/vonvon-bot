import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { createClaudeBackend } from '../src/agent/claude-provider';
import type { Logger } from '../src/agent/paseo/logger';
import type { AgentEvent } from '../src/agent/types';
import { buildRunCard } from '../src/card/run-card';
import { initialState, reduce } from '../src/card/run-state';

const logger: Logger = { child: () => logger, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const raw = (value: unknown): SDKMessage => value as SDKMessage;
const stream = (event: object) => raw({ type: 'stream_event', session_id: 'boundary-session', event });

it('builds a completed run card from combined raw SDK streaming, compaction, usage and tool output', async () => {
  const messages = [
    raw({ type: 'system', subtype: 'init', session_id: 'boundary-session', permissionMode: 'bypassPermissions', model: 'claude-opus-4-8[1m]' }),
    raw({ type: 'system', subtype: 'init', session_id: 'boundary-session', permissionMode: 'bypassPermissions', model: 'claude-opus-4-8[1m]' }),
    stream({ type: 'message_start', message: { id: 'answer' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先检查' } }),
    stream({ type: 'content_block_stop', index: 0 }),
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '完成' } }),
    stream({ type: 'content_block_stop', index: 1 }),
    stream({ type: 'message_stop' }),
    raw({ type: 'system', subtype: 'compact_boundary', session_id: 'boundary-session', compact_metadata: { trigger: 'auto', pre_tokens: 9000 } }),
    raw({ type: 'assistant', uuid: 'tool-message', session_id: 'boundary-session', parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls', description: '列目录' } }] } }),
    raw({ type: 'user', uuid: 'tool-result', session_id: 'boundary-session', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], is_error: false }] } }),
    raw({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: 'boundary-session',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }, total_cost_usd: 0 }),
  ];
  const backend = createClaudeBackend({
    logger, resolveBinary: async () => '/mock/claude', resolveVersion: async () => '2.1.220',
    queryFactory: ({ prompt }) => Object.assign((async function* () {
      if (typeof prompt === 'string') throw new Error('Expected streaming input');
      for await (const _ of prompt) { yield* messages; }
    })(), {
      close() {}, async interrupt() {}, async setPermissionMode() {}, async setModel() {},
      async supportedModels() { return []; }, async supportedCommands() { return []; },
      async getContextUsage() { return null; },
    }) as unknown as Query,
  });
  const thread = await backend.startThread({ cwd: '/repo' });
  const events: AgentEvent[] = [];
  try {
    for await (const event of thread.runStreamed({ text: 'inspect' }).events) events.push(event);
  } finally {
    await thread.close();
  }
  expect(events.filter((event) => event.type === 'system')).toEqual([{ type: 'system', threadId: 'boundary-session' }]);
  expect(events).toContainEqual({ type: 'context_compacted' });
  expect(events).toContainEqual({ type: 'context_usage', usedTokens: 15, contextWindow: 1_000_000 });
  expect(events).toContainEqual({ type: 'tool_use', itemId: 'bash-1', title: 'ls', detail: '列目录', kind: 'command' });
  expect(events).toContainEqual({ type: 'tool_result', itemId: 'bash-1', output: 'ab', exitCode: 0 });
  expect(events.find((event) => event.type === 'thinking')).toMatchObject({ text: '先检查' });
  expect(events.find((event) => event.type === 'text')).toMatchObject({ text: '完成' });
  expect(events.at(-1)?.type).toBe('done');
  const card = JSON.stringify(buildRunCard({ rs: events.reduce(reduce, initialState) }));
  expect(card).toContain('完成');
  expect(card).toContain('列目录');
});
