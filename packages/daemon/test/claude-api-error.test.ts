import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createTurnMapper, resultErrorText } from '../src/agent/claude-agent/event-map';
import { ClaudeAgentThread } from '../src/agent/claude-agent/thread';
import type { AgentEvent } from '../src/agent/types';
import { buildRunCard } from '../src/card/run-card';
import { finalMessageText, initialState, reduce } from '../src/card/run-state';

// Sanitized SDK fixtures: no provider requests, credentials or local session data.
const msg = (value: unknown): SDKMessage => value as SDKMessage;
const apiErrorText = "API Error: 403 You've reached your 5-hour usage limit.";
const assistant = (fields: Record<string, unknown> = {}, text = apiErrorText) => msg({
  type: 'assistant', uuid: 'test-assistant', session_id: 'test-session', parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] }, ...fields,
});
const apiError = assistant({ error: 'authentication_failed' });
const success = msg({
  type: 'result', subtype: 'success', is_error: false, result: '',
  session_id: 'test-session', usage: { input_tokens: 0, output_tokens: 0 },
});
const failure = msg({
  type: 'result', subtype: 'error_during_execution', is_error: true,
  session_id: 'test-session', errors: ['Provider request rejected'],
  usage: { input_tokens: 0, output_tokens: 0 },
});
const reply = [
  msg({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }),
  msg({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正常回复' } } }),
  msg({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
  success,
];

const threads: ClaudeAgentThread[] = [];
afterEach(async () => {
  await Promise.all(threads.splice(0).map((thread) => thread.close()));
});

/** Only replace the external SDK query; exercise the real thread, mapper and card. */
function makeThread(turns: Array<SDKMessage[] | AsyncIterable<SDKMessage>>, endAfterTurn = false, stopTask = async (_id: string): Promise<void> => {}): ClaudeAgentThread {
  let turn = 0;
  const thread = new ClaudeAgentThread({
    sessionId: 'test-session', resume: false, cwd: process.cwd(), permission: {}, settingSources: [],
    query: ({ prompt }) => Object.assign((async function* () {
      for await (const _ of prompt) {
        yield* turns[turn++] ?? [];
        if (endAfterTurn) return;
      }
    })(), {
      stopTask,
      getContextUsage: async () => null,
      interrupt: async () => {},
      close: () => {},
    }) as unknown as Query,
  });
  threads.push(thread);
  return thread;
}

async function collect(thread: ClaudeAgentThread, goal = false): Promise<AgentEvent[]> {
  const run = goal ? thread.runGoal('test objective') : thread.runStreamed({ text: 'test input' });
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

describe('Claude API error mapping', () => {
  it.each([
    { fields: { error: 'authentication_failed' }, kind: 'auth' },
    { fields: { isApiErrorMessage: true }, kind: undefined },
  ])('surfaces explicitly marked assistant errors: $fields', ({ fields, kind }) => {
    expect(createTurnMapper().map(assistant(fields))).toEqual([
      { type: 'error', message: apiErrorText, willRetry: false, kind },
    ]);
  });

  it.each([
    ['overloaded', 'network'], ['server_error', 'network'], ['rate_limit', 'quota'],
    ['billing_error', 'quota'], ['authentication_failed', 'auth'], ['invalid_request', undefined],
  ])('classifies the SDK error code %s as %s', (error, kind) => {
    expect(createTurnMapper().map(assistant({ error }))).toMatchObject([{ type: 'error', kind }]);
  });

  it('joins error text blocks without rendering them as a successful answer', () => {
    const events = createTurnMapper().map(assistant({
      error: 'rate_limit', message: { content: [
        { type: 'text', text: 'Request rejected' },
        { type: 'image' },
        { type: 'text', text: 'Try again later' },
      ] },
    }));
    expect(events).toEqual([{ type: 'error', message: 'Request rejected\nTry again later', willRetry: false, kind: 'quota' }]);
  });

  it('retains the error code when the API supplies no text', () => {
    expect(createTurnMapper().map(assistant({ error: 'billing_error' }, ''))).toEqual([
      { type: 'error', message: expect.stringContaining('billing_error'), willRetry: false, kind: 'quota' },
    ]);
  });

  it('does not classify ordinary assistant text by error keywords', () => {
    expect(createTurnMapper().map(assistant())).toEqual([]);
  });

  it.each([false, true])('does not make recoverable max_output_tokens terminal (API flag: %s)', (flag) => {
    expect(createTurnMapper().map(assistant({ error: 'max_output_tokens', isApiErrorMessage: flag }))).toEqual([]);
  });

  it('uses concrete result errors before the generic result/subtype fallback', () => {
    expect(resultErrorText({ errors: ['First failure', '', '  ', null, 'Second failure'], result: 'fallback' }))
      .toBe('First failure\nSecond failure');
  });

  it('retains existing fallbacks when result errors are empty', () => {
    expect(resultErrorText({ errors: [], result: ' legacy detail ' })).toBe('legacy detail');
    expect(resultErrorText({ errors: [' '], subtype: 'error_max_turns' })).toBe('已达到最大轮次限制');
  });
});

it('includes final SDK usage in the failed goal summary', async () => {
  const result = msg({ ...success, usage: { input_tokens: 12, output_tokens: 3 } });
  const events = await collect(makeThread([[apiError, result]]), true);
  expect(events.filter((event) => event.type === 'goal_update').at(-1))
    .toMatchObject({ status: 'blocked', tokensUsed: 15 });
});

describe.each([false, true])('Claude terminal errors (goal: %s)', (goal) => {
  it('keeps the visible failure when the SDK follows it with an empty success result', async () => {
    const events = await collect(makeThread([[apiError, success]]), goal);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: apiErrorText, willRetry: false, kind: 'auth' },
    ]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(events).toContainEqual({ type: 'usage', inputTokens: 0, outputTokens: 0 });
    const state = events.reduce(reduce, initialState);
    expect(state.terminal).toBe('error');
    expect(JSON.stringify(buildRunCard({ rs: state }))).toContain(apiErrorText);
    if (goal) {
      expect(events.filter((event) => event.type === 'goal_update').map((event) => event.status))
        .toEqual(['active', 'blocked']);
    }
  });

  it('does not replace the first assistant error with duplicate or generic result errors', async () => {
    const events = await collect(makeThread([[apiError, apiError, failure]]), goal);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: apiErrorText, willRetry: false, kind: 'auth' },
    ]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('does not replace a specific API error with a generic process-exit error', async () => {
    const events = await collect(makeThread([[apiError]], true), goal);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: apiErrorText, willRetry: false, kind: 'auth' },
    ]);
  });

  it('drains the failed turn and resets error state for the next turn on the warm query', async () => {
    const thread = makeThread([[apiError, success], reply]);
    await collect(thread, goal);
    const events = await collect(thread, goal);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: 'text', itemId: 'b1', text: '正常回复' });
    expect(events.at(-1)?.type).toBe('done');
    expect(thread.isAlive()).toBe(true);
  });

  it('surfaces a failed result even without an assistant error message', async () => {
    const events = await collect(makeThread([[failure]]), goal);
    expect(events).toContainEqual({ type: 'error', message: 'Provider request rejected', willRetry: false });
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('does not make a contained subagent API error fail a successful parent turn', async () => {
    const nestedError = assistant({ error: 'rate_limit', parent_tool_use_id: 'test-task' });
    const events = await collect(makeThread([[nestedError, ...reply]]), goal);
    expect(events.some((event) => event.type === 'error' && !event.willRetry)).toBe(false);
    expect(events.reduce(reduce, initialState).terminal).toBe('done');
  });

  it('allows the SDK system/api_retry message to recover normally', async () => {
    const retry = msg({
      type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3,
      retry_delay_ms: 1000, error_status: 429, error: 'rate_limit',
      uuid: 'test-retry', session_id: 'test-session',
    });
    const events = await collect(makeThread([[retry, ...reply]]), goal);
    expect(events.some((event) => event.type === 'error' && !event.willRetry)).toBe(false);
    expect(events).toContainEqual({ type: 'error', message: '网络波动，正在重试…', willRetry: true });
    expect(events.reduce(reduce, initialState).terminal).toBe('done');
  });

  it('preserves retry feedback for the existing legacy api_retry alias', async () => {
    const events = await collect(makeThread([[msg({ type: 'api_retry' }), ...reply]]), goal);
    expect(events).toContainEqual({ type: 'error', message: '网络波动，正在重试…', willRetry: true });
    expect(events.at(-1)?.type).toBe('done');
    expect(events.reduce(reduce, initialState).terminal).toBe('done');
  });

  it('preserves deliberate interrupt completion for an error result', async () => {
    const thread = makeThread([[failure]]);
    const run = goal ? thread.runGoal('test objective') : thread.runStreamed({ text: 'test input' });
    await thread.abort(run.turnId()!);
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
  });
});


it.each([false, true])('stops the requested Claude task only during its own parent turn (goal=%s)', async goal => {
  const stopTask = vi.fn(async (_id: string) => {});
  const thread = makeThread([[success], [success]], false, stopTask);
  const run = goal ? thread.runGoal('first') : thread.runStreamed({ text: 'first' });
  expect(run.stopSubagent).toBeTypeOf('function');
  await run.stopSubagent?.('task-one');
  expect(stopTask).toHaveBeenCalledExactlyOnceWith('task-one');
  for await (const event of run.events) void event;
  const next = goal ? thread.runGoal('second') : thread.runStreamed({ text: 'second' });
  await expect(run.stopSubagent?.('task-one')).rejects.toThrow('这个子 agent 已经结束');
  for await (const event of next.events) void event;
  await expect(next.stopSubagent?.('task-two')).rejects.toThrow('这个子 agent 已经结束');
  expect(stopTask).toHaveBeenCalledTimes(1);
});

it.each([false, true])('adds a Chinese reason when Claude stopTask fails (goal=%s)', async goal => {
  const thread = makeThread([[success]], false, async () => { throw new Error('SDK denied'); });
  const run = goal ? thread.runGoal('test') : thread.runStreamed({ text: 'test' });
  await expect(run.stopSubagent?.('task-one')).rejects.toThrow('停止子 agent 失败：SDK denied');
  for await (const event of run.events) void event;
});

it('provides single-task stop for stoppable children in a Claude goal', async () => {
  const stopTask = vi.fn(async (_id: string) => {});
  const thread = makeThread([[msg({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'child-goal', description: 'goal child' }), success]], false, stopTask);
  const run = thread.runGoal('test objective');
  for await (const event of run.events) {
    if (event.type === 'subagent_start') {
      expect(event.stoppable).toBe(true);
      expect(run.stopSubagent).toBeTypeOf('function');
      await run.stopSubagent?.(event.id);
      expect(stopTask).toHaveBeenCalledExactlyOnceWith('child-goal');
    }
  }
});


it('stops one goal child while its sibling and parent complete normally', async () => {
  let stopped!: () => void;
  const stopRequested = new Promise<void>(resolve => { stopped = resolve; });
  const stopTask = vi.fn(async (_id: string) => { stopped(); });
  async function* messages(): AsyncGenerator<SDKMessage> {
    for (const id of ['child-one', 'child-two']) yield msg({
      type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: id, description: id,
    });
    await stopRequested;
    yield msg({ type: 'system', subtype: 'task_notification', task_id: 'child-one', status: 'stopped' });
    yield msg({ type: 'system', subtype: 'task_notification', task_id: 'child-two', status: 'completed', summary: 'Sibling finished' });
    yield* reply;
  }
  const thread = makeThread([messages()], false, stopTask);
  const abort = vi.spyOn(thread, 'abort');
  const clearGoal = vi.spyOn(thread, 'clearGoal');
  const run = thread.runGoal('test objective');
  const events: AgentEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
    if (event.type === 'subagent_start' && event.id === 'child-two') {
      expect(events.filter(event => event.type === 'subagent_start')).toHaveLength(2);
      await run.stopSubagent?.('child-one');
    }
  }
  expect(stopTask).toHaveBeenCalledExactlyOnceWith('child-one');
  expect(abort).not.toHaveBeenCalled();
  expect(clearGoal).not.toHaveBeenCalled();
  expect(events).toContainEqual({ type: 'subagent_status', id: 'child-one', status: 'stopped', result: undefined });
  expect(events).toContainEqual({ type: 'subagent_status', id: 'child-two', status: 'completed', result: 'Sibling finished' });
  expect(events).toContainEqual(expect.objectContaining({ type: 'goal_update', status: 'complete' }));
  const state = events.reduce(reduce, initialState);
  expect(state.terminal).toBe('done');
  expect(finalMessageText(state)).toBe('正常回复');
  await expect(run.stopSubagent?.('child-two')).rejects.toThrow('这个子 agent 已经结束');
  expect(stopTask).toHaveBeenCalledTimes(1);
});

it.each(['exit', 'clear', 'close'])('refuses goal child stop after %s', async ending => {
  const stopTask = vi.fn(async (_id: string) => {});
  const thread = makeThread([[]], true, stopTask);
  const run = thread.runGoal('test objective');
  if (ending === 'clear') await thread.clearGoal();
  else if (ending === 'close') await thread.close();
  else for await (const event of run.events) void event;
  await expect(run.stopSubagent?.('child-one')).rejects.toThrow('这个子 agent 已经结束');
  expect(stopTask).not.toHaveBeenCalled();
});
