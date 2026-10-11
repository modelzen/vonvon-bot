import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { createPiBackend } from '../src/agent/pi-provider';
import { PiRpcAgentClient } from '../src/agent/providers/pi/agent';
import { FakePi } from './paseo/providers/pi/test-utils/fake-pi';
import { piExtensions } from '../src/agent/providers/pi/extensions/registry';
import { piExtensionRuntimeBridge } from '../src/agent/providers/pi/extensions';
import { PiHistoryMapper } from '../src/agent/providers/pi/history-mapper';
import type { AgentClient, AgentSession, AgentSessionConfig, AgentStreamEvent, AgentTimelineItem } from '../src/agent/paseo/agent-sdk-types';

function fixture(history?: AgentTimelineItem[]) {
  const listeners = new Set<(event: AgentStreamEvent) => void>();
  const emit = (event: AgentStreamEvent) => { for (const listener of listeners) listener(event); };
  const session = {
    id: 'pi-session',
    describePersistence: () => ({ provider: 'pi', sessionId: 'pi-session', nativeHandle: '/project/pi-session.jsonl' }),
    subscribe: vi.fn((listener: (event: AgentStreamEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
    startTurn: vi.fn(async () => ({ turnId: 'turn-1' })),
    interrupt: vi.fn(async () => {}),
    respondToPermission: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    async *streamHistory() {
      if (history) {
        for (const item of history) yield { type: 'timeline', provider: 'pi', item };
        return;
      }
      yield { type: 'timeline', provider: 'pi', item: { type: 'user_message', text: 'one' } };
      yield { type: 'timeline', provider: 'pi', item: { type: 'assistant_message', text: 'answer' } };
      yield { type: 'timeline', provider: 'pi', item: { type: 'user_message', text: 'two' } };
      yield { type: 'timeline', provider: 'pi', item: { type: 'assistant_message', text: 'second' } };
    },
  } as unknown as AgentSession;
  const client = {
    provider: 'pi',
    isAvailable: vi.fn(async () => true),
    createSession: vi.fn(async (_config: AgentSessionConfig) => session),
    resumeSession: vi.fn(async () => session),
    fetchCatalog: vi.fn(async () => ({ models: [{ provider: 'pi', id: 'model', label: 'Pi Model', isDefault: true }], modes: [] })),
    listImportableSessions: vi.fn(async () => [{ providerHandleId: '/project/pi-session.jsonl', cwd: '/project', title: 'Topic', firstPromptPreview: 'one', lastActivityAt: new Date('2026-01-02T00:00:00Z') }]),
  } as unknown as AgentClient;
  return { client, session, emit };
}

describe('Pi backend', () => {
  it('uses the copied Pi runtime file across create, restart, list, resume and history', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vonvon-pi-wrapper-'));
    try {
      const cwd = path.join(root, 'workspace');
      const agentDir = path.join(root, 'agent');
      const sessionsDir = path.join(agentDir, 'sessions');
      mkdirSync(cwd);
      mkdirSync(sessionsDir, { recursive: true });
      const sessionFile = path.join(sessionsDir, 'session.jsonl');
      writeFileSync(sessionFile, [
        JSON.stringify({ type: 'session', version: 3, id: 'pi-uuid', timestamp: '2026-01-01T00:00:00.000Z', cwd }),
        JSON.stringify({ type: 'message', id: 'entry-1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'first prompt' } }),
      ].join('\n') + '\n');
      const pi = new FakePi();
      pi.queueSessionSetup((session) => { session.state.sessionFile = sessionFile; });
      const client = new PiRpcAgentClient({ logger: pino({ level: 'silent' }), runtime: pi,
        runtimeSettings: { env: { PI_CODING_AGENT_DIR: agentDir } } });
      const thread = await createPiBackend({ client }).startThread({ cwd, mode: 'full' });
      expect(thread.sessionId).toBe(sessionFile);
      expect(await thread.compact()).toEqual({ compacted: true, usage: null });
      expect(pi.latestSession().compactRequests).toEqual([{}]);
      await thread.close();

      const restarted = createPiBackend({ client });
      expect((await restarted.listThreads(cwd)).map((item) => item.sessionId)).toEqual([sessionFile]);
      const resumed = await restarted.resumeThread({ cwd, mode: 'full', sessionId: sessionFile });
      expect(resumed.sessionId).toBe(sessionFile);
      expect(pi.recordedLaunches.at(-1)?.session).toBe(sessionFile);
      await resumed.close();
      const history = await restarted.readHistory(cwd, sessionFile, 10);
      expect(history.totalTurns).toBeGreaterThanOrEqual(0);
      expect(pi.recordedLaunches.at(-1)?.session).toBe(sessionFile);
      const launches = pi.recordedLaunches.length;
      await expect(restarted.resumeThread({ cwd, mode: 'full', sessionId: 'pi-uuid' })).rejects.toThrow('无效的 Pi 会话');
      await expect(restarted.resumeThread({ cwd, mode: 'full', sessionId: 'relative.jsonl' })).rejects.toThrow('无效的 Pi 会话');
      expect(pi.recordedLaunches).toHaveLength(launches);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('retains final results emitted by the Pi history mapper', async () => {
    const events = new PiHistoryMapper('pi').mapMessages([
      { role: 'user', content: 'read files' },
      { role: 'assistant', content: [
        { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: '/one' } },
        { type: 'toolCall', id: 'read-2', name: 'read', arguments: { path: '/missing' } },
      ] },
      { role: 'toolResult', toolCallId: 'read-2', toolName: 'read', isError: true,
        content: [{ type: 'text', text: 'File missing' }] },
      { role: 'toolResult', toolCallId: 'read-1', toolName: 'read',
        content: [{ type: 'text', text: 'file contents' }] },
    ]);
    const { client } = fixture(events.flatMap((event) => event.type === 'timeline' ? [event.item] : []));
    expect(await createPiBackend({ client }).readHistory('/project', '/project/pi-session.jsonl', 10)).toEqual({
      turns: [{ userText: 'read files', assistantText: '', reasoning: '', tools: [
        { title: '/one', output: 'file contents' },
        { title: '/missing', output: 'File missing', failed: true },
      ] }], totalTurns: 1,
    });
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
    const backend = createPiBackend({ client });
    expect(await backend.readHistory('/project', '/project/pi-session.jsonl', 10)).toEqual({
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
    const backend = createPiBackend({ client });
    expect(await backend.readHistory('/project', '/project/pi-session.jsonl', 10)).toEqual({
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
    const backend = createPiBackend({ client });
    expect(await backend.readHistory('/project', '/project/pi-session.jsonl', maxTurns)).toEqual({ turns: [], totalTurns: 2 });
  });

  it('keeps the removed extension registry and runtime bridge empty', () => {
    expect(piExtensions).toEqual([]);
    expect(piExtensionRuntimeBridge).toBe('');
  });

  it('creates and resumes sessions, reads history, aborts, and denies permission', async () => {
    const { client, session, emit } = fixture();
    const backend = createPiBackend({ client });
    expect(backend.supportedModes).toEqual(['full']);
    expect(await backend.isAvailable()).toBe(true);
    expect(await backend.doctor()).toMatchObject({ ok: true, depState: 'installed' });
    const thread = await backend.startThread({ cwd: '/project', mode: 'full', model: 'model' });
    expect(thread.sessionId).toBe('/project/pi-session.jsonl');
    expect(client.createSession).toHaveBeenCalledWith({ provider: 'pi', cwd: '/project' });
    const run = thread.runStreamed({ text: 'question' });
    const eventsPromise = (async () => { const result = []; for await (const event of run.events) result.push(event); return result; })();
    await Promise.resolve();
    await Promise.resolve();
    emit({ type: 'permission_requested', provider: 'pi', turnId: 'turn-1', request: { id: 'p1', provider: 'pi', kind: 'tool', name: 'shell', title: 'Run shell' } });
    await Promise.resolve();
    expect(session.respondToPermission).toHaveBeenCalledWith('p1', expect.objectContaining({ behavior: 'deny' }));
    await thread.abort('turn-1');
    expect(session.interrupt).toHaveBeenCalledOnce();
    expect(await eventsPromise).toContainEqual({ type: 'approval_request', requestId: 'p1', title: 'Run shell', detail: undefined });
    await thread.close();
    const resumed = await backend.resumeThread({ cwd: '/project', sessionId: '/project/pi-session.jsonl', mode: 'full' });
    expect(client.resumeSession).toHaveBeenCalledWith({ provider: 'pi', sessionId: '/project/pi-session.jsonl', nativeHandle: '/project/pi-session.jsonl', metadata: { cwd: '/project' } }, expect.objectContaining({ provider: 'pi', cwd: '/project' }));
    await resumed.close();
    for (const sessionId of ['pi-session', 'relative.jsonl']) {
      await expect(backend.resumeThread({ cwd: '/project', sessionId, mode: 'full' })).rejects.toThrow('无效的 Pi 会话');
      expect(await backend.readHistory('/project', sessionId, 1)).toEqual({ turns: [], totalTurns: 0 });
    }
    expect(client.resumeSession).toHaveBeenCalledTimes(1);
    expect(await backend.listThreads('/project')).toEqual([{ sessionId: '/project/pi-session.jsonl', preview: 'one', name: 'Topic', createdAt: 1767312000, updatedAt: 1767312000 }]);
    expect(await backend.readHistory('/project', '/project/pi-session.jsonl', 1)).toEqual({ turns: [{ userText: 'two', assistantText: 'second', reasoning: '', tools: [] }], totalTurns: 2 });
    expect(await backend.listModels()).toMatchObject([{ id: 'model', displayName: 'Pi Model' }]);
  });
});
