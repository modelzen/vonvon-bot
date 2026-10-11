import { describe, expect, it, vi } from 'vitest';
import { createACPBackend } from '../src/agent/acp-provider';
import type { AgentClient, AgentSession, AgentSessionConfig, AgentStreamEvent, AgentTimelineItem } from '../src/agent/paseo/agent-sdk-types';

function fixture(history?: AgentTimelineItem[]) {
  const close = vi.fn(async () => {});
  const session = {
    id: 'native-acp-1', close,
    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      if (history) {
        for (const item of history) yield { type: 'timeline', provider: 'acp', item };
        return;
      }
      yield { type: 'timeline', provider: 'acp', item: { type: 'user_message', text: 'first' } };
      yield { type: 'timeline', provider: 'acp', item: { type: 'assistant_message', text: 'answer' } };
      yield { type: 'timeline', provider: 'acp', item: { type: 'user_message', text: 'second' } };
      yield { type: 'timeline', provider: 'acp', item: { type: 'reasoning', text: 'check' } };
      yield { type: 'timeline', provider: 'acp', item: { type: 'assistant_message', text: 'done' } };
    },
  } as unknown as AgentSession;
  const createSession = vi.fn(async (_config: AgentSessionConfig) => session);
  const resumeSession = vi.fn(async () => session);
  const listImportableSessions = vi.fn(async () => [{
    providerHandleId: 'native-acp-1', cwd: '/project', title: 'Task',
    firstPromptPreview: 'first', lastPromptPreview: 'second',
    lastActivityAt: new Date('2026-01-02T00:00:00Z'),
  }]);
  const client = {
    provider: 'acp', createSession, resumeSession, listImportableSessions,
    isAvailable: vi.fn(async () => true),
    fetchCatalog: vi.fn(async () => ({ models: [
      { provider: 'acp', id: 'model-1', label: 'Model 1', isDefault: true },
      { provider: 'acp', id: 'hidden', label: 'Hidden', isSelectable: false },
    ], modes: [] })),
  } as unknown as AgentClient;
  return { client, createSession, resumeSession, listImportableSessions, close };
}

describe('custom ACP backend', () => {

  it('preserves terminal-only tools, including output and failure details', async () => {
    const { client } = fixture([
      { type: 'user_message', text: 'inspect' },
      { type: 'tool_call', callId: 'shell', name: 'bash', status: 'completed', error: null,
        detail: { type: 'shell', command: 'pwd', output: '/project', exitCode: 0 } },
      { type: 'tool_call', callId: 'read', name: 'read', status: 'failed', error: { message: 'File missing' },
        detail: { type: 'read', filePath: '/missing' } },
      { type: 'tool_call', callId: 'custom', name: 'custom', status: 'completed', error: null,
        detail: { type: 'plain_text', text: 'custom result' } },
      { type: 'tool_call', callId: 'empty', name: 'bash', status: 'completed', error: null,
        detail: { type: 'shell', command: 'true', output: '' } },
    ]);
    const backend = createACPBackend({ command: ['custom-agent'], client });
    expect(await backend.readHistory('/project', 'session', 10)).toEqual({
      turns: [{ userText: 'inspect', assistantText: '', reasoning: '', tools: [
        { title: 'pwd', output: '/project', exitCode: 0 },
        { title: '/missing', output: 'File missing', failed: true },
        { title: 'custom', output: 'custom result' },
        { title: 'true', output: '' },
      ] }], totalTurns: 1,
    });
  });

  it('updates each call in arrival order without duplicating terminal events or merging turns', async () => {
    const { client } = fixture([
      { type: 'user_message', text: 'first' },
      { type: 'tool_call', callId: 'a', name: 'bash', status: 'running', error: null,
        detail: { type: 'shell', command: 'pwd' } },
      { type: 'tool_call', callId: 'b', name: 'bash', status: 'running', error: null,
        detail: { type: 'shell', command: 'cat missing' } },
      { type: 'tool_call', callId: 'b', name: 'bash', status: 'failed', error: 'Command failed',
        detail: { type: 'shell', command: 'cat missing', output: 'No such file', exitCode: 1 } },
      { type: 'tool_call', callId: 'a', name: 'bash', status: 'completed', error: null,
        detail: { type: 'shell', command: 'pwd', output: '/project', exitCode: 0 } },
      { type: 'tool_call', callId: 'a', name: 'bash', status: 'completed', error: null,
        detail: { type: 'shell', command: 'pwd', output: '/project', exitCode: 0 } },
      { type: 'tool_call', callId: 'b', name: 'bash', status: 'failed', error: 'Command failed',
        detail: { type: 'shell', command: 'cat missing', output: 'No such file', exitCode: 1 } },
      { type: 'assistant_message', text: 'checked' },
      { type: 'user_message', text: 'second' },
      { type: 'tool_call', callId: 'a', name: 'read', status: 'completed', error: null,
        detail: { type: 'read', filePath: '/next', content: 'next file' } },
    ]);
    const backend = createACPBackend({ command: ['custom-agent'], client });
    expect(await backend.readHistory('/project', 'session', 10)).toEqual({
      turns: [
        { userText: 'first', assistantText: 'checked', reasoning: '', tools: [
          { title: 'pwd', output: '/project', exitCode: 0 },
          { title: 'cat missing', output: 'No such file', exitCode: 1, failed: true },
        ] },
        { userText: 'second', assistantText: '', reasoning: '', tools: [
          { title: '/next', output: 'next file' },
        ] },
      ], totalTurns: 2,
    });
  });

  it.each([0, -1])('returns no turns for limit %s while retaining the total', async (maxTurns) => {
    const { client } = fixture();
    const backend = createACPBackend({ command: ['custom-agent'], client });
    expect(await backend.readHistory('/project', 'session', maxTurns)).toEqual({ turns: [], totalTurns: 2 });
  });

  it('keeps the configured command at the factory boundary and forwards native session settings', async () => {
    const { client, createSession, resumeSession } = fixture();
    const backend = createACPBackend({ command: ['custom-agent', '--acp'], client });
    expect(backend.id).toBe('custom-acp');
    expect(backend.supportedModes).toEqual(['full']);
    await backend.startThread({ cwd: '/project', mode: 'full', model: 'model-1' });
    await backend.resumeThread({ cwd: '/project', sessionId: 'native-acp-1', mode: 'full' });
    expect(createSession).toHaveBeenCalledWith({ provider: 'acp', cwd: '/project', featureValues: { auto_accept: true } });
    expect(resumeSession).toHaveBeenCalledWith(
      { provider: 'acp', sessionId: 'native-acp-1', metadata: { cwd: '/project' } },
      { provider: 'acp', cwd: '/project', featureValues: { auto_accept: true } },
    );
    await expect(backend.startThread({ cwd: '/project', mode: 'qa' })).rejects.toThrow('不支持 qa');
    await expect(backend.resumeThread({ cwd: '/project', sessionId: 'native-acp-1', mode: 'write' })).rejects.toThrow('不支持 write');
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });

  it('uses the ACP catalog and reads history with a read-only resume that closes its process', async () => {
    const { client, resumeSession, listImportableSessions, close } = fixture();
    const backend = createACPBackend({ command: ['custom-agent'], client });
    expect(await backend.listModels()).toEqual([{
      id: 'model-1', displayName: 'Model 1', description: '', supportedEfforts: [],
      defaultEffort: 'none', isDefault: true, hidden: false,
    }]);
    expect(await backend.listThreads('/project', 3)).toEqual([{
      sessionId: 'native-acp-1', preview: 'first', name: 'Task',
      createdAt: 1767312000, updatedAt: 1767312000,
    }]);
    expect(listImportableSessions).toHaveBeenCalledWith({ cwd: '/project', limit: 3 });
    expect(await backend.readHistory('/project', 'native-acp-1', 1)).toEqual({
      turns: [{ userText: 'second', assistantText: 'done', reasoning: 'check', tools: [] }], totalTurns: 2,
    });
    expect(resumeSession).toHaveBeenCalledWith(
      { provider: 'acp', sessionId: 'native-acp-1', nativeHandle: 'native-acp-1', metadata: { provider: 'acp', cwd: '/project', featureValues: { auto_accept: true } } },
      { provider: 'acp', cwd: '/project', featureValues: { auto_accept: true } },
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports availability through the client probe', async () => {
    const { client } = fixture();
    const backend = createACPBackend({ command: ['custom-agent'], client });
    expect(await backend.doctor()).toMatchObject({ ok: true, depState: 'installed' });
    vi.mocked(client.isAvailable).mockResolvedValue(false);
    expect(await backend.doctor()).toMatchObject({ ok: false, depState: 'external-missing', hint: '自定义 ACP 命令不可用' });
  });
});
