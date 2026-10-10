import { expect, it, vi } from 'vitest';
import { SessionBackendThread } from '../src/agent/paseo/session-backend';
import type { AgentSession, AgentStreamEvent } from '../src/agent/paseo/agent-sdk-types';
import type { AgentEvent } from '../src/agent/types';
import { finalMessageText, initialState, reduce } from '../src/card/run-state';

it('renders provider timeline text, reasoning, tool, compaction, and usage as one completed card', async () => {
  const listeners = new Set<(event: AgentStreamEvent) => void>();
  const emit = (event: AgentStreamEvent): void => { for (const listener of listeners) listener(event); };
  const session = {
    id: 'native-session',
    subscribe(listener: (event: AgentStreamEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    startTurn: vi.fn(async () => ({ turnId: 'turn-1' })),
    close: vi.fn(async () => {}),
  } as unknown as AgentSession;
  const thread = new SessionBackendThread(session);
  const run = thread.runStreamed({ text: '列目录' });
  const collect = (async (): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    return events;
  })();
  await Promise.resolve();
  await Promise.resolve();
  emit({ type: 'thread_started', provider: 'claude', sessionId: 'native-session' });
  emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: { type: 'reasoning', text: '想一下' } });
  emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: { type: 'assistant_message', messageId: 'm1', text: '你好' } });
  emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: { type: 'assistant_message', messageId: 'm1', text: '你好，世界' } });
  emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: { type: 'tool_call', callId: 'tu1', name: 'Bash', status: 'running', error: null, detail: { type: 'shell', command: 'ls -la' } } });
  emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: { type: 'tool_call', callId: 'tu1', name: 'Bash', status: 'completed', error: null, detail: { type: 'shell', command: 'ls -la', output: '文件列表', exitCode: 0 } } });
  emit({ type: 'timeline', provider: 'claude', turnId: 'turn-1', item: { type: 'compaction', status: 'completed', trigger: 'auto' } });
  emit({ type: 'turn_completed', provider: 'claude', turnId: 'turn-1', usage: { inputTokens: 10, outputTokens: 5, contextWindowUsedTokens: 15, contextWindowMaxTokens: 1_000_000 } });
  const events = await collect;
  expect(events).toContainEqual({ type: 'system', threadId: 'native-session' });
  expect(events).toContainEqual({ type: 'thinking', itemId: 'reasoning', text: '想一下' });
  expect(events.filter((event) => event.type === 'text')).toEqual([
    { type: 'text', itemId: 'm1', text: '你好' },
    { type: 'text', itemId: 'm1', text: '你好，世界' },
  ]);
  expect(events).toContainEqual({ type: 'tool_use', itemId: 'tu1', title: 'ls -la', kind: 'command' });
  expect(events).toContainEqual({ type: 'tool_result', itemId: 'tu1', output: '文件列表', exitCode: 0 });
  expect(events).toContainEqual({ type: 'context_compacted' });
  expect(events).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 5 });
  expect(events).toContainEqual({ type: 'context_usage', usedTokens: 15, contextWindow: 1_000_000 });
  expect(events.at(-1)).toEqual({ type: 'done', turnId: 'turn-1' });
  const state = events.reduce(reduce, initialState);
  expect(finalMessageText(state)).toBe('你好，世界');
  await thread.close();
});
