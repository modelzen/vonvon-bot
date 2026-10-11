import { describe, expect, it, vi } from 'vitest';
import { createCopilotBackend } from '../src/agent/copilot-provider';
import type { AgentClient, AgentSession, AgentSessionConfig, AgentStreamEvent } from '../src/agent/paseo/agent-sdk-types';

describe('Copilot ACP backend', () => {
  it('uses ACP history deduplication and honors a zero turn limit', async () => {
    const session = {
      id: 'copilot-history',
      close: vi.fn(async () => {}),
      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'timeline', provider: 'copilot', item: { type: 'user_message', text: 'inspect' } };
        for (let duplicate = 0; duplicate < 2; duplicate++) {
          yield { type: 'timeline', provider: 'copilot', item: {
            type: 'tool_call', callId: 'read-1', name: 'read', status: 'failed', error: 'File missing',
            detail: { type: 'read', filePath: '/missing' },
          } };
        }
      },
    } as unknown as AgentSession;
    const client = {
      provider: 'copilot', resumeSession: vi.fn(async () => session),
    } as unknown as AgentClient;
    const backend = createCopilotBackend({ client });
    expect(await backend.readHistory('/project', 'copilot-history', 1)).toEqual({
      turns: [{ userText: 'inspect', assistantText: '', reasoning: '', tools: [
        { title: '/missing', output: 'File missing', failed: true },
      ] }], totalTurns: 1,
    });
    expect(await backend.readHistory('/project', 'copilot-history', 0)).toEqual({ turns: [], totalTurns: 1 });
    expect(session.close).toHaveBeenCalledTimes(2);
  });

  it('uses Copilot session identity, rejects unsupported permission tiers, and denies approval events', async () => {
    const listeners = new Set<(event: AgentStreamEvent) => void>();
    const denied: string[] = [];
    const session = {
      id: 'copilot-1',
      subscribe(listener: (event: AgentStreamEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async startTurn() {
        for (const listener of listeners) listener({ type: 'turn_started', provider: 'copilot', turnId: 'turn-1' });
        return { turnId: 'turn-1' };
      },
      async respondToPermission(id: string, response: { behavior: string }) {
        if (response.behavior === 'deny') denied.push(id);
      },
      async close() {},
    } as unknown as AgentSession;
    const createSession = vi.fn(async (_config: AgentSessionConfig) => session);
    const client = {
      provider: 'copilot', createSession,
      isAvailable: vi.fn(async () => true),
      fetchCatalog: vi.fn(async () => ({ models: [], modes: [] })),
    } as unknown as AgentClient;
    const backend = createCopilotBackend({ client });
    expect(backend.id).toBe('copilot-acp');
    expect(backend.capabilities?.approvals).toBe(false);
    const thread = await backend.startThread({ cwd: '/project', mode: 'full' });
    expect(createSession).toHaveBeenCalledWith({ provider: 'copilot', cwd: '/project', featureValues: { auto_accept: true } });
    const run = thread.runStreamed({ text: 'hello' });
    await Promise.resolve();
    for (const listener of listeners) listener({ type: 'permission_requested', provider: 'copilot', turnId: 'turn-1',
      request: { id: 'permission-1', provider: 'copilot', kind: 'tool', name: 'edit', title: 'Edit file' } });
    for (const listener of listeners) listener({ type: 'turn_completed', provider: 'copilot', turnId: 'turn-1' });
    const events = [];
    for await (const event of run.events) events.push(event);
    expect(events).toContainEqual({ type: 'approval_request', requestId: 'permission-1', title: 'Edit file', detail: undefined });
    expect(denied).toEqual(['permission-1']);
    await thread.close();
    await expect(backend.startThread({ cwd: '/project', mode: 'write' })).rejects.toThrow('不支持 write');
  });
});
