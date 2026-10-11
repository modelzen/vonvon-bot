import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { expect, it, vi } from 'vitest';
import { createClaudeBackend } from '../src/agent/claude-provider';
import type { Logger } from '../src/agent/paseo/logger';
import type { AgentEvent } from '../src/agent/types';
import { buildRunCard } from '../src/card/run-card';
import { initialState, reduce } from '../src/card/run-state';

const logger: Logger = {
  child: () => logger,
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};
const apiErrorText = "API Error: 403 You've reached your 5-hour usage limit.";

function queryWithAssistantErrorThenSuccess(): Query {
  const messages = [
    { type: 'system', subtype: 'init', session_id: 'error-session', permissionMode: 'bypassPermissions', model: 'opus' },
    { type: 'assistant', uuid: 'error-assistant', session_id: 'error-session', parent_tool_use_id: null,
      error: 'authentication_failed', message: { role: 'assistant', content: [{ type: 'text', text: apiErrorText }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 'error-session',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, total_cost_usd: 0 },
  ];
  let index = 0;
  return {
    next: vi.fn(async () => index < messages.length
      ? { done: false, value: messages[index++] }
      : { done: true, value: undefined }),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => []),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() { return this; },
  } as unknown as Query;
}

it('keeps a marked SDK assistant API error visible and terminal despite a later empty success result', async () => {
  const backend = createClaudeBackend({
    logger, resolveBinary: async () => '/mock/claude', resolveVersion: async () => '2.1.220',
    queryFactory: () => queryWithAssistantErrorThenSuccess(),
  });
  const thread = await backend.startThread({ cwd: '/repo' });
  const events: AgentEvent[] = [];
  try {
    for await (const event of thread.runStreamed({ text: 'hello' }).events) events.push(event);
  } finally {
    await thread.close();
  }
  expect(events).toContainEqual({ type: 'error', message: apiErrorText, willRetry: false });
  expect(events.some((event) => event.type === 'done')).toBe(false);
  const state = events.reduce(reduce, initialState);
  expect(state.terminal).toBe('error');
  expect(JSON.stringify(buildRunCard({ rs: state }))).toContain(apiErrorText);
});
