import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeBackend, isSupportedOpenCodeVersion } from '../src/agent/opencode-provider';
import { decorateOpenCodeV2Env } from '../src/agent/providers/opencode/bridge';
import { V2Timeline } from '../src/agent/providers/opencode/v2/timeline';
import type { AgentClient, AgentSession, AgentSessionConfig, AgentStreamEvent, AgentTimelineItem } from '../src/agent/paseo/agent-sdk-types';

function fixture(history?: AgentTimelineItem[]) {
  const listeners = new Set<(event: AgentStreamEvent) => void>();
  const emit = (event: AgentStreamEvent) => { for (const listener of listeners) listener(event); };
  const session = {
    id: 'session-1',
    subscribe: vi.fn((listener: (event: AgentStreamEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
    startTurn: vi.fn(async () => ({ turnId: 'turn-1' })),
    interrupt: vi.fn(async () => {}),
    respondToPermission: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    async *streamHistory() {
      if (history) {
        for (const item of history) yield { type: 'timeline', provider: 'opencode', item };
        return;
      }
      yield { type: 'timeline', provider: 'opencode', item: { type: 'user_message', text: 'one' } };
      yield { type: 'timeline', provider: 'opencode', item: { type: 'assistant_message', text: 'answer' } };
      yield { type: 'timeline', provider: 'opencode', item: { type: 'user_message', text: 'two' } };
      yield { type: 'timeline', provider: 'opencode', item: { type: 'assistant_message', text: 'second' } };
    },
  } as unknown as AgentSession;
  const client = {
    provider: 'opencode',
    createSession: vi.fn(async (_config: AgentSessionConfig) => session),
    resumeSession: vi.fn(async () => session),
    fetchCatalog: vi.fn(async () => ({ models: [{ provider: 'opencode', id: 'model', label: 'Model', isDefault: true }], modes: [] })),
    listImportableSessions: vi.fn(async () => [{ providerHandleId: 'session-1', cwd: '/project', title: 'Topic', firstPromptPreview: 'one', lastActivityAt: new Date('2026-01-02T00:00:00Z') }]),
  } as unknown as AgentClient;
  return { client, session, emit };
}

describe('OpenCode V2 backend', () => {
  it('retains completed tools emitted by a fresh V2 history timeline', async () => {
    const events = new V2Timeline().messages([{
      id: 'answer', type: 'assistant', agent: 'build',
      model: { providerID: 'test', id: 'model' }, time: { created: 2 },
      content: [{
        type: 'tool', id: 'shell', name: 'bash', executed: false,
        state: { status: 'completed', input: { command: 'pwd' },
          content: [{ type: 'text', text: '/project' }], metadata: {} },
        time: { created: 2, ran: 2, completed: 2 },
      }],
    }]);
    const { client } = fixture([
      { type: 'user_message', text: 'inspect' },
      ...events.flatMap((event) => event.type === 'timeline' ? [event.item] : []),
    ]);
    expect(await createOpenCodeBackend({ client }).readHistory('/project', 'session', 10)).toEqual({
      turns: [{ userText: 'inspect', assistantText: '', reasoning: '', tools: [
        { title: 'pwd', output: '/project' },
      ] }], totalTurns: 1,
    });
  });

  it.each([
    ['1.9.99', false], ['2.0.9', false], ['2.0.10', true], ['2.1.0', true],
    ['3.0.0', true], ['not a version', false], ['2.0.10-beta.1', false],
  ])('gates version %s', (output, supported) => {
    expect(isSupportedOpenCodeVersion(output)).toBe(supported);
  });


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
    const backend = createOpenCodeBackend({ client });
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
    const backend = createOpenCodeBackend({ client });
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
    const backend = createOpenCodeBackend({ client });
    expect(await backend.readHistory('/project', 'session', maxTurns)).toEqual({ turns: [], totalTurns: 2 });
  });

  it('reports an actionable minimum for an unsupported binary', async () => {
    const { client } = fixture();
    const backend = createOpenCodeBackend({ client, versionOutput: async () => '2.0.9' });
    expect(await backend.isAvailable()).toBe(false);
    expect(await backend.doctor()).toMatchObject({ ok: false, version: '2.0.9', hint: expect.stringContaining('2.0.10') });
  });

  it('creates and resumes V2 sessions, reads history, aborts, and denies permission', async () => {
    const { client, session, emit } = fixture();
    const backend = createOpenCodeBackend({ client, versionOutput: async () => '2.0.10' });
    expect(backend.supportedModes).toEqual(['full']);
    expect(await backend.isAvailable()).toBe(true);
    const thread = await backend.startThread({ cwd: '/project', mode: 'full', model: 'model' });
    expect(client.createSession).toHaveBeenCalledWith({ provider: 'opencode', cwd: '/project', featureValues: { auto_accept: true } });
    const run = thread.runStreamed({ text: 'question' });
    const eventsPromise = (async () => { const result = []; for await (const event of run.events) result.push(event); return result; })();
    await Promise.resolve();
    await Promise.resolve();
    emit({ type: 'permission_requested', provider: 'opencode', turnId: 'turn-1', request: { id: 'p1', provider: 'opencode', kind: 'tool', name: 'shell', title: 'Run shell' } });
    await Promise.resolve();
    expect(session.respondToPermission).toHaveBeenCalledWith('p1', expect.objectContaining({ behavior: 'deny' }));
    await thread.abort('turn-1');
    expect(session.interrupt).toHaveBeenCalledOnce();
    expect(await eventsPromise).toContainEqual({ type: 'approval_request', requestId: 'p1', title: 'Run shell', detail: undefined });
    await thread.close();
    const resumed = await backend.resumeThread({ cwd: '/project', sessionId: 'session-1', mode: 'full' });
    expect(client.resumeSession).toHaveBeenCalledWith({ provider: 'opencode', sessionId: 'session-1', metadata: { cwd: '/project' } }, expect.objectContaining({ provider: 'opencode', cwd: '/project' }));
    await resumed.close();
    expect(await backend.listThreads('/project')).toEqual([{ sessionId: 'session-1', preview: 'one', name: 'Topic', createdAt: 1767312000, updatedAt: 1767312000 }]);
    expect(await backend.readHistory('/project', 'session-1', 1)).toEqual({ turns: [{ userText: 'two', assistantText: 'second', reasoning: '', tools: [] }], totalTurns: 2 });
    expect(await backend.listModels()).toMatchObject([{ id: 'model', displayName: 'Model' }]);
  });

  it('sets V2 plugin options without a route or token', () => {
    const env = decorateOpenCodeV2Env({}, '/tmp/plugin.mjs');
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}');
    expect(config.plugins).toEqual([{ package: '/tmp/plugin.mjs', options: {} }]);
    expect(JSON.stringify(config)).not.toMatch(/baseUrl|token/);
  });
});
