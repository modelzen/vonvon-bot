import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeBackend } from '../src/agent/claude-provider';
import { createClaudeSessionObservation, observeClaudeQuery } from '../src/agent/paseo-claude-wrapper';
import type { Logger } from '../src/agent/paseo/logger';
import type { AgentEvent, AgentThread } from '../src/agent/types';
import type { ClaudeQueryFactory } from '../src/agent/providers/claude/query';

const logger: Logger = { child: () => logger, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const message = (value: unknown): SDKMessage => value as SDKMessage;
const init = (model?: string) => message({ type: 'system', subtype: 'init', session_id: 'observed', permissionMode: 'bypassPermissions', model });
const success = (fields: object = {}) => message({
  type: 'result', subtype: 'success', result: '', is_error: false, session_id: 'observed',
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 }, ...fields,
});
const assistant = (fields: object = {}, text = 'API Error: request rejected') => message({
  type: 'assistant', uuid: 'assistant', session_id: 'observed', parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] }, ...fields,
});
const failure = (fields: object = {}) => message({
  type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'observed',
  usage: { input_tokens: 12, output_tokens: 3 }, errors: ['Provider request rejected'], ...fields,
});
const threads: AgentThread[] = [];
afterEach(async () => { await Promise.all(threads.splice(0).map((thread) => thread.close())); });

function scriptedQuery(turns: SDKMessage[][], endAfterTurn = false): ClaudeQueryFactory {
  return ({ prompt }) => {
    if (typeof prompt === 'string') throw new Error('Expected streaming input');
    let turn = 0;
    return Object.assign((async function* () {
      for await (const _ of prompt) {
        yield* turns[turn++] ?? [];
        if (endAfterTurn) return;
      }
    })(), {
      close() {}, async interrupt() {}, async setPermissionMode() {}, async setModel() {},
      async supportedModels() { return []; }, async supportedCommands() { return []; },
      async getContextUsage() { return null; },
    }) as unknown as Query;
  };
}
async function threadFor(turns: SDKMessage[][], options: { resume?: boolean; endAfterTurn?: boolean } = {}) {
  const queryFactory = vi.fn(scriptedQuery(turns, options.endAfterTurn));
  const backend = createClaudeBackend({ logger, queryFactory, resolveBinary: async () => '/mock/claude', resolveVersion: async () => '2.1.220' });
  const thread = options.resume ? await backend.resumeThread({ cwd: '/repo', sessionId: 'observed' }) : await backend.startThread({ cwd: '/repo' });
  threads.push(thread);
  return { thread, queryFactory };
}
async function collect(thread: AgentThread, goal = false): Promise<AgentEvent[]> {
  const run = goal ? thread.runGoal('objective') : thread.runStreamed({ text: 'hello' });
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

it('observes direct next and for-await exactly once and binds controls to the Query', async () => {
  const messages = [init(), success()];
  const seen: SDKMessage[] = [];
  const raw = Object.assign((async function* () { yield* messages; })(), {
    interrupt() { expect(this).toBe(raw); return Promise.resolve(); },
    close() { expect(this).toBe(raw); },
    getContextUsage() { expect(this).toBe(raw); return Promise.resolve(null); },
  }) as unknown as Query;
  const proxy = observeClaudeQuery(raw, (msg) => { seen.push(msg); });
  const first = await proxy.next();
  expect(first.value).toBe(messages[0]);
  expect(seen).toEqual([messages[0]]);
  for await (const value of proxy) { expect(value).toBe(messages[1]); expect(seen.at(-1)).toBe(value); }
  expect(seen).toEqual(messages);
  await proxy.interrupt(); proxy.close(); await proxy.getContextUsage();
});

it('delegates iterator return and throw with their original yielded values and errors', async () => {
  const caught = assistant({}, 'caught');
  const cleanup = assistant({}, 'cleanup');
  const seen: SDKMessage[] = [];
  const raw = (async function* () {
    try { yield init(); } catch { yield caught; } finally { yield cleanup; }
  })() as unknown as Query;
  const proxy = observeClaudeQuery(raw, (msg) => { seen.push(msg); });
  await proxy.next();
  expect((await proxy.throw(new Error('recoverable'))).value).toBe(caught);
  expect((await proxy.return()).value).toBe(cleanup);
  expect(seen).toEqual([expect.anything(), caught, cleanup]);
  await expect(proxy.throw(new Error('closed'))).rejects.toThrow('closed');
});

it.each([false, true])('passes each V3 marked API error through the copied provider (resume: %s)', async (resume) => {
  for (const fields of [{ error: 'authentication_failed' }, { isApiErrorMessage: true }, { error: 'billing_error' }]) {
    const { thread, queryFactory } = await threadFor([[init(), assistant(fields), success()]], { resume });
    const events = await collect(thread);
    expect(events.filter((event) => event.type === 'error')).toEqual([{ type: 'error', message: 'API Error: request rejected', willRetry: false }]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(queryFactory).toHaveBeenCalledOnce();
    expect(queryFactory.mock.calls[0]?.[0].options.settingSources).toEqual(['user', 'project']);
    expect(queryFactory.mock.calls[0]?.[0].options.resume).toBe(resume ? 'observed' : undefined);
  }
});

it('keeps text blocks and an empty-text error code, while ordinary/recoverable/nested messages succeed', async () => {
  const cases = [
    { raw: assistant({ error: 'rate_limit', message: { content: [{ type: 'text', text: 'First' }, { type: 'image' }, { type: 'text', text: 'Last' }] } }), error: 'First\nLast' },
    { raw: assistant({ error: 'billing_error' }, ''), error: '模型服务请求失败（billing_error）' },
    { raw: assistant(), error: undefined },
    { raw: assistant({ error: 'max_output_tokens' }), error: undefined },
    { raw: assistant({ error: 'max_output_tokens', isApiErrorMessage: true }), error: undefined },
    { raw: assistant({ error: 'rate_limit', parent_tool_use_id: 'nested' }), error: undefined },
  ];
  for (const { raw, error } of cases) {
    const { thread } = await threadFor([[init(), raw, success()]]);
    const events = await collect(thread);
    expect(events.filter((event) => event.type === 'error')).toEqual(error ? [{ type: 'error', message: error, willRetry: false }] : []);
    expect(events.some((event) => event.type === 'done')).toBe(!error);
  }
});

it.each([false, true])('retains first API error over duplicates, result and process-exit errors (goal: %s)', async (goal) => {
  for (const endAfterTurn of [false, true]) {
    const { thread } = await threadFor([[init(), assistant({ error: 'rate_limit' }), assistant({ error: 'billing_error' }), ...(endAfterTurn ? [] : [failure()])]], { endAfterTurn });
    const events = await collect(thread, goal);
    expect(events.filter((event) => event.type === 'error')).toEqual([{ type: 'error', message: 'API Error: request rejected', willRetry: false }]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    if (goal && !endAfterTurn) expect(events.filter((event) => event.type === 'goal_update').at(-1)).toMatchObject({ status: 'blocked', tokensUsed: 15 });
  }
});

it('resets turn facts on a warm query while retaining its init context model', async () => {
  const { thread, queryFactory } = await threadFor([[init('claude-opus[1m]'), assistant({ error: 'rate_limit' }), success()], [success()]]);
  await collect(thread);
  const events = await collect(thread);
  expect(queryFactory).toHaveBeenCalledOnce();
  expect(events.filter((event) => event.type === 'error')).toEqual([]);
  expect(events).toContainEqual({ type: 'context_usage', usedTokens: 15, contextWindow: 1_000_000 });
  expect(events.at(-1)?.type).toBe('done');
});

it('isolates raw failures and context models in concurrent threads of one backend', async () => {
  let calls = 0;
  const factories = [scriptedQuery([[init('model[1m]'), assistant({ error: 'rate_limit' }), success()]]), scriptedQuery([[init('model'), success()]])];
  const backend = createClaudeBackend({ logger, resolveBinary: async () => '/mock/claude', queryFactory: (input) => factories[calls++]!(input) });
  const first = await backend.startThread({ cwd: '/repo' });
  const second = await backend.resumeThread({ cwd: '/repo', sessionId: 'observed' });
  threads.push(first, second);
  const [failed, passed] = await Promise.all([collect(first), collect(second)]);
  expect(failed.some((event) => event.type === 'done')).toBe(false);
  expect(passed.filter((event) => event.type === 'error')).toEqual([]);
  expect(passed).toContainEqual({ type: 'context_usage', usedTokens: 15, contextWindow: 200_000 });
});

it.each([
  { model: 'model', modelUsage: {}, contextWindow: 200_000 },
  { model: 'model[1m]', modelUsage: {}, contextWindow: 1_000_000 },
  { model: undefined, modelUsage: {}, contextWindow: null },
  { model: 'model', modelUsage: { model: { contextWindow: 123456 } }, contextWindow: 123456 },
])('replaces result usage once with cache totals and window $contextWindow', async ({ model, modelUsage, contextWindow }) => {
  const { thread } = await threadFor([[init(model), success({ modelUsage })]]);
  const events = await collect(thread);
  expect(events.filter((event) => event.type === 'usage' || event.type === 'context_usage')).toEqual([
    { type: 'usage', inputTokens: 10, outputTokens: 5 }, { type: 'context_usage', usedTokens: 15, contextWindow },
  ]);
});

it('retains non-result usage updates but suppresses copied result updates before repaired completion', async () => {
  const observation = createClaudeSessionObservation(() => (async function* () { yield init(); yield success(); })() as unknown as Query);
  observation.beginTurn(() => {});
  const raw = observation.queryFactory({ prompt: '', options: {} });
  const update = { type: 'usage_updated', provider: 'claude', usage: { inputTokens: 99, outputTokens: 1 } } as const;
  const mapped = [{ type: 'usage', inputTokens: 99, outputTokens: 1 }] as const;
  await raw.next();
  expect(observation.repair(update, mapped)).toEqual(mapped);
  await raw.next();
  expect(observation.repair(update, mapped)).toEqual([]);
  observation.endTurn();
});

it.each([
  { fields: { errors: ['First failure', '', '  ', 'Second failure'] }, text: 'First failure\nSecond failure' },
  { fields: { errors: [], result: ' legacy detail ' }, text: 'legacy detail' },
  { fields: { errors: [' '], subtype: 'error_max_turns' }, text: '已达到最大轮次限制' },
  { fields: { errors: [], subtype: 'error_max_budget_usd' }, text: '已达到预算上限' },
])('preserves V3 result error fallback $text', async ({ fields, text }) => {
  const { thread } = await threadFor([[failure(fields)]]);
  const events = await collect(thread);
  expect(events.filter((event) => event.type === 'error')).toEqual([{ type: 'error', message: text, willRetry: false }]);
  expect(events.some((event) => event.type === 'done')).toBe(false);
});

it.each([
  { name: 'empty budget errors', subtype: 'error_max_budget_usd', errors: [], apiError: false, text: '已达到预算上限', status: 'budgetLimited' },
  { name: 'nonempty budget errors', subtype: 'error_max_budget_usd', errors: ['预算已耗尽'], apiError: false, text: '预算已耗尽', status: 'budgetLimited' },
  { name: 'ordinary failure with misleading budget token', subtype: 'error_during_execution', errors: ['日志包含 error_max_budget_usd'], apiError: false, text: '日志包含 error_max_budget_usd', status: 'blocked' },
  { name: 'marked API error before budget result', subtype: 'error_max_budget_usd', errors: [], apiError: true, text: 'API Error: request rejected', status: 'blocked' },
])('uses raw terminal semantics for goal $name', async ({ subtype, errors, apiError, text, status }) => {
  const { thread, queryFactory } = await threadFor([[
    init('model'), ...(apiError ? [assistant({ error: 'billing_error' })] : []),
    failure({ subtype, errors, usage: { input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 4 } }),
  ]]);
  const events = await collect(thread, true);
  expect(queryFactory).toHaveBeenCalledOnce();
  expect(events.filter((event) => event.type === 'error')).toEqual([{ type: 'error', message: text, willRetry: false }]);
  expect(events.some((event) => event.type === 'done')).toBe(false);
  expect(events.filter((event) => event.type === 'usage' || event.type === 'context_usage')).toEqual([
    { type: 'usage', inputTokens: 12, outputTokens: 3 },
    { type: 'context_usage', usedTokens: 18, contextWindow: 200_000 },
  ]);
  expect(events.filter((event) => event.type === 'goal_update')).toEqual([
    { type: 'goal_update', status: 'active', objective: 'objective', tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null },
    { type: 'goal_update', status, objective: 'objective', tokensUsed: 15, timeUsedSeconds: expect.any(Number), tokenBudget: null },
  ]);
});

it.each([false, true])('allows SDK system/api_retry recovery (goal: %s)', async (goal) => {
  const { thread } = await threadFor([[init(), message({
    type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 1000,
    error_status: 429, error: 'rate_limit', uuid: 'retry', session_id: 'observed',
  }), success()]]);
  const events = await collect(thread, goal);
  expect(events.some((event) => event.type === 'error' && !event.willRetry)).toBe(false);
  expect(events.at(-1)?.type).toBe('done');
});

it.each([false, true])('preserves legacy api_retry feedback through the copied provider (goal: %s)', async (goal) => {
  const { thread } = await threadFor([[init(), message({ type: 'api_retry' }), success()]]);
  const events = await collect(thread, goal);
  expect(events).toContainEqual({ type: 'error', message: '网络波动，正在重试…', willRetry: true });
  if (goal) expect(events.filter((event) => event.type === 'goal_update').map((event) => event.status)).toEqual(['active', 'complete']);
  expect(events.at(-1)?.type).toBe('done');
});

it.each([false, true])('preserves deliberate interrupt completion for a raw failure result (goal: %s)', async (goal) => {
  let release: () => void = () => {};
  const interrupted = new Promise<void>((resolve) => { release = resolve; });
  const backend = createClaudeBackend({ logger, resolveBinary: async () => '/mock/claude', queryFactory: ({ prompt }) => {
    if (typeof prompt === 'string') throw new Error('Expected streaming input');
    return Object.assign((async function* () {
      for await (const _ of prompt) { yield init(); await interrupted; yield failure(); return; }
    })(), {
      close() { release(); }, async interrupt() { release(); }, async setPermissionMode() {},
      async supportedModels() { return []; }, async supportedCommands() { return []; },
    }) as unknown as Query;
  } });
  const thread = await backend.startThread({ cwd: '/repo' });
  threads.push(thread);
  const run = goal ? thread.runGoal('stop goal') : thread.runStreamed({ text: 'stop' });
  const events: AgentEvent[] = [];
  const consuming = (async () => { for await (const event of run.events) events.push(event); })();
  await vi.waitFor(() => { expect(run.turnId()).toBeDefined(); });
  await thread.abort(run.turnId()!);
  await consuming;
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect(events.at(-1)?.type).toBe('done');
});

it.each([
  { uuid: 'error-uuid' },
  { uuid: 'error-uuid', message_id: 'provider-root-id' },
  { uuid: 'error-uuid', message: { id: 'provider-message-id', role: 'assistant', content: [{ type: 'text', text: 'API Error: request rejected' }] } },
])('does not render marked API error text as an assistant answer: %j', async (identity) => {
  const earlier = assistant({ uuid: 'earlier-valid', message: { id: 'earlier-message', role: 'assistant', content: [{ type: 'text', text: 'API Error: request rejected' }] } });
  const { thread } = await threadFor([[init(), earlier, assistant({ ...identity, error: 'rate_limit' }), success()]]);
  const events = await collect(thread);
  expect(events.filter((event) => event.type === 'text')).toEqual([
    { type: 'text', itemId: 'earlier-message', text: 'API Error: request rejected' },
  ]);
  expect(events.filter((event) => event.type === 'error')).toEqual([{ type: 'error', message: 'API Error: request rejected', willRetry: false }]);
  expect(events.some((event) => event.type === 'done')).toBe(false);
});

it.each([
  { path: 'new session', resume: false },
  { path: 'resumed session', resume: true },
])('passes exactly the V3 setting sources to the SDK for a $path', async ({ resume }) => {
  const { thread, queryFactory } = await threadFor([[init(), success()]], { resume });
  await collect(thread);
  expect(queryFactory).toHaveBeenCalledOnce();
  const options = queryFactory.mock.calls[0]?.[0].options;
  expect(options?.settingSources).toEqual(['user', 'project']);
  expect(options?.settingSources).not.toContain('local');
  expect(options?.resume).toBe(resume ? 'observed' : undefined);
});


it.each([false, true])('resets typed budget status on a warm copied-provider goal (resume: %s)', async (resume) => {
  const { thread, queryFactory } = await threadFor([
    [init('model'), failure({ subtype: 'error_max_budget_usd', errors: [] })],
    [failure({ errors: ['ordinary error mentioning error_max_budget_usd'] })],
  ], { resume });
  const budget = await collect(thread, true);
  const ordinary = await collect(thread, true);
  expect(queryFactory).toHaveBeenCalledOnce();
  expect(budget.filter((event) => event.type === 'goal_update').map((event) => event.status)).toEqual(['active', 'budgetLimited']);
  expect(ordinary.filter((event) => event.type === 'goal_update').map((event) => event.status)).toEqual(['active', 'blocked']);
  expect(budget.filter((event) => event.type === 'error')).toEqual([{ type: 'error', message: '已达到预算上限', willRetry: false }]);
  expect(ordinary.filter((event) => event.type === 'error')).toEqual([{ type: 'error', message: 'ordinary error mentioning error_max_budget_usd', willRetry: false }]);
  for (const events of [budget, ordinary]) {
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(events.filter((event) => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 12, outputTokens: 3 }]);
    expect(events.filter((event) => event.type === 'goal_update').at(-1)).toMatchObject({ tokensUsed: 15 });
  }
});
