import { describe, expect, it } from 'vitest';
import { SessionBackend, SessionBackendThread } from '../src/agent/paseo/session-backend';
import type { AgentClient, AgentPromptInput, AgentSession, AgentStreamEvent } from '../src/agent/paseo/agent-sdk-types';
import type { AgentEvent } from '../src/agent/types';

class FakeSession implements AgentSession {
  readonly provider = 'claude';
  readonly id = 'session-1';
  readonly capabilities = {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: false,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  };
  readonly sent: AgentPromptInput[] = [];
  readonly steers: AgentPromptInput[] = [];
  readonly deniedPermissions: string[] = [];
  readonly thinkingOptions: Array<string | null> = [];
  interruptCount = 0;
  running = true;
  private listeners = new Set<(event: AgentStreamEvent) => void>();

  emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async run(): Promise<never> { throw new Error('unused'); }
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() { return { provider: 'claude', sessionId: this.id }; }
  async getAvailableModes() { return []; }
  async getCurrentMode() { return null; }
  async setMode(): Promise<void> {}
  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.sent.push(prompt);
    this.emit({ type: 'turn_started', provider: 'claude', turnId: 'turn-1' });
    return { turnId: 'turn-1' };
  }
  async steerActiveTurn(prompt: AgentPromptInput, options: { expectedTurnId: string }): Promise<{ status: 'accepted' | 'unavailable' }> {
    expect(options.expectedTurnId).toBe('turn-1');
    this.steers.push(prompt);
    return { status: 'accepted' };
  }
  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  getPendingPermissions() { return []; }
  async respondToPermission(requestId: string, response: { behavior: 'allow' | 'deny' }): Promise<void> {
    if (response.behavior === 'deny') this.deniedPermissions.push(requestId);
  }
  describePersistence() { return { provider: 'claude', sessionId: 'session-1' }; }
  async interrupt(): Promise<void> { this.interruptCount++; }
  async close(): Promise<void> {}
  isAlive(): boolean { return this.running; }
  async setThinkingOption(value: string | null): Promise<void> { this.thinkingOptions.push(value); }
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('Paseo AgentSession to AgentBackend adapter', () => {
  it('maps text, tool, permission and terminal events, and forwards steer', async () => {
    const session = new FakeSession();
    const thread = new SessionBackendThread(session);
    const run = thread.runStreamed({ text: 'first' });
    const eventsPromise = collect(run.events);
    await Promise.resolve();
    await Promise.resolve();
    expect(session.sent).toEqual(['first']);
    expect(run.turnId()).toBe('turn-1');
    await thread.steer({ text: 'follow-up' }, 'turn-1');
    expect(session.steers).toEqual(['follow-up']);
    session.emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: { type: 'assistant_message', messageId: 'm1', text: 'hello' } });
    session.emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: { type: 'assistant_message', messageId: 'm1', text: 'hello world' } });
    session.emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: { type: 'assistant_message', messageId: 'm1', text: '!' } });
    session.emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'running', error: null, detail: { type: 'shell', command: 'pwd' } } });
    session.emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'completed', error: null, detail: { type: 'shell', command: 'pwd', output: '/tmp', exitCode: 0 } } });
    session.emit({ type: 'permission_requested', provider: 'claude', turnId: 'turn-1', request: { id: 'p1', provider: 'claude', kind: 'tool', name: 'Edit', title: 'Edit file', description: 'write source' } });
    session.emit({ type: 'turn_completed', provider: 'claude', turnId: 'stale-turn' });
    session.emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: { type: 'compaction', status: 'completed', trigger: 'auto' } });
    session.emit({ type: 'turn_completed', provider: 'claude', turnId: 'turn-1', usage: { inputTokens: 2, outputTokens: 4, contextWindowUsedTokens: 100, contextWindowMaxTokens: 200 } });
    expect(await eventsPromise).toEqual([
      { type: 'turn_started', turnId: 'turn-1' },
      { type: 'text', itemId: 'm1', text: 'hello' },
      { type: 'text', itemId: 'm1', text: 'hello world' },
      { type: 'text', itemId: 'm1', text: 'hello world!' },
      { type: 'tool_use', itemId: 'tool-1', title: 'pwd', kind: 'command' },
      { type: 'tool_result', itemId: 'tool-1', output: '/tmp', exitCode: 0 },
      { type: 'approval_request', requestId: 'p1', title: 'Edit file', detail: 'write source' },
      { type: 'context_compacted' },
      { type: 'usage', inputTokens: 2, outputTokens: 4 },
      { type: 'context_usage', usedTokens: 100, contextWindow: 200 },
      { type: 'done', turnId: 'turn-1' },
    ]);
    expect(session.deniedPermissions).toEqual(['p1']);
  });

  it('ends failed turns with a visible error', async () => {
    const session = new FakeSession();
    const run = new SessionBackendThread(session).runStreamed({ text: 'fail' });
    const result = collect(run.events);
    await Promise.resolve();
    session.emit({ type: 'turn_failed', provider: 'claude', turnId: 'turn-1', error: 'API unavailable' });
    expect(await result).toEqual([
      { type: 'turn_started', turnId: 'turn-1' },
      { type: 'error', message: 'API unavailable', willRetry: false },
    ]);
  });

  it('keeps read and failed tool results visible in the bridge tool card', async () => {
    const session = new FakeSession();
    const run = new SessionBackendThread(session).runStreamed({ text: 'inspect' });
    const result = collect(run.events);
    await Promise.resolve();
    await Promise.resolve();
    session.emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: {
      type: 'tool_call', callId: 'read-1', name: 'Read', status: 'completed', error: null,
      detail: { type: 'read', filePath: '/tmp/a.txt', content: 'file contents' },
    } });
    session.emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: {
      type: 'tool_call', callId: 'edit-1', name: 'Edit', status: 'failed', error: 'permission denied',
      detail: { type: 'edit', filePath: '/tmp/a.txt' },
    } });
    session.emit({ type: 'turn_completed', provider: 'claude', turnId: 'turn-1' });
    expect(await result).toEqual([
      { type: 'turn_started', turnId: 'turn-1' },
      { type: 'tool_result', itemId: 'read-1', output: 'file contents', exitCode: 0 },
      { type: 'tool_result', itemId: 'edit-1', output: 'permission denied', exitCode: 1 },
      { type: 'done', turnId: 'turn-1' },
    ]);
  });

  it('does not invent a successful exit code for a canceled tool', async () => {
    const session = new FakeSession();
    const thread = new SessionBackendThread(session);
    const run = thread.runStreamed({ text: 'cancel' });
    const result = collect(run.events);
    await Promise.resolve();
    await Promise.resolve();
    session.emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: {
      type: 'tool_call', callId: 'canceled-call', name: 'Bash', status: 'canceled', error: null,
      detail: { type: 'shell', command: 'sleep 30' },
    } });
    session.emit({ type: 'turn_completed', provider: 'claude', turnId: 'turn-1' });
    expect(await result).toEqual([
      { type: 'turn_started', turnId: 'turn-1' },
      { type: 'tool_result', itemId: 'canceled-call' },
      { type: 'done', turnId: 'turn-1' },
    ]);
    await thread.close();
  });

  it('interrupts only the active turn and closes the stream even if the provider emits no terminal event', async () => {
    const session = new FakeSession();
    const thread = new SessionBackendThread(session);
    const run = thread.runStreamed({ text: 'slow' });
    const result = collect(run.events);
    await Promise.resolve();
    await Promise.resolve();
    await thread.abort('other-turn');
    expect(session.interruptCount).toBe(0);
    await thread.abort('turn-1');
    expect(session.interruptCount).toBe(1);
    expect(await result).toEqual([
      { type: 'turn_started', turnId: 'turn-1' },
      { type: 'done', turnId: 'turn-1' },
    ]);
  });

  it('denies a pending permission before interrupt and ignores subagent pane events', async () => {
    const session = new FakeSession();
    const order: string[] = [];
    let releaseDenial: (() => void) | undefined;
    session.respondToPermission = async () => {
      order.push('deny-start');
      await new Promise<void>((resolve) => { releaseDenial = resolve; });
      order.push('deny-done');
    };
    session.interrupt = async () => { order.push('interrupt'); };
    const thread = new SessionBackendThread(session);
    const run = thread.runStreamed({ text: 'slow' });
    const events = collect(run.events);
    await Promise.resolve();
    await Promise.resolve();
    session.emit({ type: 'provider_subagent', provider: 'claude', event: { type: 'remove', id: 'child-1' } });
    session.emit({ type: 'permission_requested', provider: 'claude', turnId: 'turn-1', request: { id: 'p1', provider: 'claude', kind: 'tool', name: 'AskUserQuestion' } });
    const abort = thread.abort('turn-1');
    expect(order).toEqual(['deny-start']);
    releaseDenial?.();
    await abort;
    expect(order).toEqual(['deny-start', 'deny-done', 'interrupt']);
    expect(await events).toEqual([
      { type: 'turn_started', turnId: 'turn-1' },
      { type: 'approval_request', requestId: 'p1', title: 'AskUserQuestion', detail: undefined },
      { type: 'done', turnId: 'turn-1' },
    ]);
  });

  it('waits for a pending permission denial before closing the provider session', async () => {
    const session = new FakeSession();
    const order: string[] = [];
    let releaseDenial: (() => void) | undefined;
    session.respondToPermission = async () => {
      order.push('deny-start');
      await new Promise<void>((resolve) => { releaseDenial = resolve; });
      order.push('deny-done');
    };
    session.close = async () => { order.push('close'); };
    const thread = new SessionBackendThread(session);
    const run = thread.runStreamed({ text: 'slow' });
    const events = collect(run.events);
    await Promise.resolve();
    await Promise.resolve();
    session.emit({ type: 'permission_requested', provider: 'claude', turnId: 'turn-1', request: { id: 'p1', provider: 'claude', kind: 'tool', name: 'Edit' } });

    const close = thread.close();
    expect(order).toEqual(['deny-start']);
    releaseDenial?.();
    await close;
    expect(order).toEqual(['deny-start', 'deny-done', 'close']);
    expect(await events).toEqual([
      { type: 'turn_started', turnId: 'turn-1' },
      { type: 'approval_request', requestId: 'p1', title: 'Edit', detail: undefined },
    ]);
  });

  it('uses the returned turn id for events emitted during startTurn and releases a closed stream', async () => {
    const session = new FakeSession();
    session.startTurn = async (prompt) => {
      session.sent.push(prompt);
      session.emit({ type: 'turn_started', provider: 'claude' });
      return { turnId: 'actual-turn' };
    };
    const thread = new SessionBackendThread(session);
    const run = thread.runStreamed({ text: 'start' });
    const result = collect(run.events);
    await Promise.resolve();
    await Promise.resolve();
    expect(run.turnId()).toBe('actual-turn');
    await thread.close();
    expect(await result).toEqual([{ type: 'turn_started', turnId: 'actual-turn' }]);
  });

  it('keeps an immediate completed turn ordered behind its real id', async () => {
    const session = new FakeSession();
    session.startTurn = async (prompt) => {
      session.sent.push(prompt);
      session.emit({ type: 'turn_started', provider: 'claude' });
      session.emit({ type: 'timeline', provider: 'claude', item: { type: 'assistant_message', text: 'quick' } });
      session.emit({ type: 'turn_completed', provider: 'claude' });
      return { turnId: 'quick-turn' };
    };
    const run = new SessionBackendThread(session).runStreamed({ text: 'quick' });
    expect(await collect(run.events)).toEqual([
      { type: 'turn_started', turnId: 'quick-turn' },
      { type: 'text', itemId: 'assistant', text: 'quick' },
      { type: 'done', turnId: 'quick-turn' },
    ]);
  });

  it('synthesizes the existing Claude goal-like status without claiming success after stop', async () => {
    const session = new FakeSession();
    const thread = new SessionBackendThread(session);
    const run = thread.runGoal('finish task');
    const result = collect(run.events);
    await Promise.resolve();
    await Promise.resolve();
    await thread.clearGoal();
    const events = await result;
    expect(events[0]).toMatchObject({ type: 'goal_update', status: 'active', objective: 'finish task' });
    expect(events.at(-1)).toMatchObject({ type: 'done', turnId: 'turn-1' });
    expect(events.some((event) => event.type === 'goal_update' && event.status === 'complete')).toBe(false);
    expect(session.sent[0]).toContain('目标：finish task');
    expect(session.interruptCount).toBe(1);
  });

  it('reports provider liveness and applies a turn effort before submitting input', async () => {
    const session = new FakeSession();
    const thread = new SessionBackendThread(session, (effort) => effort === 'ultra' ? 'max' : effort);
    expect(thread.isAlive()).toBe(true);
    const run = thread.runStreamed({ text: 'think' }, { effort: 'ultra' });
    const result = collect(run.events);
    await Promise.resolve();
    await Promise.resolve();
    expect(session.thinkingOptions).toEqual(['max']);
    expect(session.sent).toEqual(['think']);
    session.running = false;
    expect(thread.isAlive()).toBe(false);
    session.emit({ type: 'turn_completed', provider: 'claude', turnId: 'turn-1' });
    await result;
  });

  it('puts the goal completion status before the final done event', async () => {
    const session = new FakeSession();
    const run = new SessionBackendThread(session).runGoal('count');
    const result = collect(run.events);
    await Promise.resolve();
    await Promise.resolve();
    session.emit({ type: 'turn_completed', provider: 'claude', turnId: 'turn-1' });
    expect((await result).map((event) => event.type)).toEqual([
      'goal_update', 'turn_started', 'goal_update', 'done',
    ]);
  });

  it('delegates start and resume to AgentClient while enforcing supported modes', async () => {
    const configs: string[] = [];
    const client: AgentClient = {
      provider: 'claude',
      capabilities: new FakeSession().capabilities,
      async createSession(config) { configs.push(`create:${config.modeId}`); return new FakeSession(); },
      async resumeSession(handle, overrides) { configs.push(`resume:${handle.sessionId}:${overrides?.modeId}`); return new FakeSession(); },
      async fetchCatalog() { return { models: [{ provider: 'claude', id: 'model-1', label: 'Model One' }], modes: [] }; },
      async isAvailable() { return true; },
    };
    const backend = new SessionBackend(client, {
      id: 'claude-agent',
      displayName: 'Claude',
      capabilities: { goal: true, steer: true, compact: true, resume: false, approvals: false },
      supportedModes: ['qa', 'write', 'full'],
      configFor: (options) => ({ provider: 'claude', cwd: options.cwd, modeId: options.mode ?? 'write' }),
    });
    expect(backend.id).toBe('claude-agent');
    expect((await backend.startThread({ cwd: '/tmp', mode: 'qa' })).sessionId).toBe('session-1');
    expect((await backend.resumeThread({ cwd: '/tmp', sessionId: 'old', mode: 'write' })).sessionId).toBe('session-1');
    expect(configs).toEqual(['create:qa', 'resume:old:write']);
    expect((await backend.listModels())[0]?.id).toBe('model-1');
    const restricted = new SessionBackend(client, {
      id: 'restricted', displayName: 'Restricted',
      capabilities: { goal: false, steer: false, compact: false, resume: false, approvals: false },
      supportedModes: ['write'],
      configFor: (options) => ({ provider: 'claude', cwd: options.cwd }),
    });
    await expect(restricted.startThread({ cwd: '/tmp', mode: 'full' })).rejects.toThrow('不支持 full');
    expect(() => new SessionBackend(client, {
      id: 'interactive', displayName: 'Interactive',
      capabilities: { goal: false, steer: false, compact: false, resume: false, approvals: true },
      supportedModes: ['write'],
      configFor: (options) => ({ provider: 'claude', cwd: options.cwd }),
    })).toThrow('不能回传交互审批');
  });

  it('rejects a second turn until the first one has reached a terminal event', async () => {
    const session = new FakeSession();
    const thread = new SessionBackendThread(session);
    const first = thread.runStreamed({ text: 'one' });
    expect(() => thread.runStreamed({ text: 'two' })).toThrow('仍在运行');
    const result = collect(first.events);
    await Promise.resolve();
    await Promise.resolve();
    session.emit({ type: 'turn_completed', provider: 'claude', turnId: 'turn-1' });
    await result;
    session.startTurn = async (prompt) => {
      session.sent.push(prompt);
      session.emit({ type: 'turn_started', provider: 'claude', turnId: 'turn-2' });
      return { turnId: 'turn-2' };
    };
    const second = thread.runStreamed({ text: 'two' });
    expect(second.turnId()).toBeUndefined();
    const next = collect(second.events);
    await Promise.resolve();
    await Promise.resolve();
    session.emit({ type: 'turn_completed', provider: 'claude', turnId: 'turn-2' });
    await next;
    expect(first.turnId()).toBe('turn-1');
    expect(second.turnId()).toBe('turn-2');
    expect(session.sent).toEqual(['one', 'two']);
  });
});


it('keeps a goal active through retry feedback and clears the owned observer once at completion', async () => {
  const session = new FakeSession();
  let emit: ((event: AgentEvent) => void) | undefined;
  let ended = 0;
  const thread = new SessionBackendThread(session, undefined, {
    beginTurn(sink) { emit = sink; },
    repair(_event, mapped) { return mapped; },
    endTurn() { ended++; },
  });
  const run = thread.runGoal('retry then finish');
  const result = collect(run.events);
  await Promise.resolve();
  await Promise.resolve();
  emit?.({ type: 'error', message: 'retrying', willRetry: true });
  session.emit({ type: 'turn_completed', provider: 'claude', turnId: 'turn-1' });
  emit?.({ type: 'error', message: 'stale callback', willRetry: false });
  const events = await result;
  expect(events.filter((event) => event.type === 'goal_update').map((event) => event.status)).toEqual(['active', 'complete']);
  expect(events.filter((event) => event.type === 'error')).toEqual([{ type: 'error', message: 'retrying', willRetry: true }]);
  expect(ended).toBe(1);
  await thread.close();
  expect(ended).toBe(1);
});


it.each([
  { error: 'ordinary failure', status: 'blocked' },
  { error: 'error_max_budget_usd', status: 'budgetLimited' },
])('retains unadapted backend goal classification for $error', async ({ error, status }) => {
  const session = new FakeSession();
  const run = new SessionBackendThread(session).runGoal('existing backend');
  const result = collect(run.events);
  await Promise.resolve();
  await Promise.resolve();
  session.emit({ type: 'turn_failed', provider: 'codex', turnId: 'turn-1', error });
  const events = await result;
  expect(events.filter((event) => event.type === 'goal_update').map((event) => event.status)).toEqual(['active', status]);
  expect(events.filter((event) => event.type === 'error')).toEqual([{ type: 'error', message: error, willRetry: false }]);
  expect(events.some((event) => event.type === 'done')).toBe(false);
});

it('captures typed goal status per run through cleanup and rejects stale observer updates', async () => {
  const session = new FakeSession();
  let setStatus: ((status: 'blocked' | 'budgetLimited') => void) | undefined;
  let ended = 0;
  const thread = new SessionBackendThread(session, undefined, {
    beginTurn(_emit, sink) { setStatus = sink; sink?.('blocked'); },
    repair(_event, mapped) { return mapped; },
    endTurn() { ended++; },
  });
  const first = thread.runGoal('budget');
  await Promise.resolve();
  await Promise.resolve();
  const staleStatus = setStatus;
  setStatus?.('budgetLimited');
  session.emit({ type: 'turn_failed', provider: 'codex', turnId: 'turn-1', error: '预算已耗尽' });
  expect(ended).toBe(1);
  staleStatus?.('blocked');
  const second = thread.runGoal('ordinary');
  await Promise.resolve();
  await Promise.resolve();
  staleStatus?.('budgetLimited');
  session.emit({ type: 'turn_failed', provider: 'codex', turnId: 'turn-1', error: 'error_max_budget_usd is only text' });
  expect(ended).toBe(2);
  expect((await collect(first.events)).filter((event) => event.type === 'goal_update').map((event) => event.status)).toEqual(['active', 'budgetLimited']);
  expect((await collect(second.events)).filter((event) => event.type === 'goal_update').map((event) => event.status)).toEqual(['active', 'blocked']);
  await thread.close();
  expect(ended).toBe(2);
});
