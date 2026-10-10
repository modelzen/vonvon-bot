import { describe, expect, it, vi } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeBackend } from '../src/agent/claude-provider';
import { BRIDGE_DEVELOPER_INSTRUCTIONS } from '../src/agent/bridge-instructions';
import type { AgentClient, AgentSession, AgentSessionConfig, AgentLaunchContext } from '../src/agent/paseo/agent-sdk-types';

function fakeClient() {
  const session = {
    id: 'native-session',
    async *streamHistory() {
      yield { type: 'timeline', provider: 'claude', item: { type: 'user_message', text: 'first' } };
      yield { type: 'timeline', provider: 'claude', item: { type: 'assistant_message', text: 'answer' } };
      yield { type: 'timeline', provider: 'claude', item: { type: 'user_message', text: 'second' } };
      yield { type: 'timeline', provider: 'claude', item: { type: 'assistant_message', text: 'second answer' } };
    },
    close: vi.fn(async () => {}),
  } as unknown as AgentSession;
  const calls: { kind: string; config: AgentSessionConfig; context?: AgentLaunchContext; purpose?: string }[] = [];
  const client = {
    provider: 'claude',
    isAvailable: vi.fn(async () => true),
    createSession: vi.fn(async (config: AgentSessionConfig, context?: AgentLaunchContext) => {
      calls.push({ kind: 'create', config, context });
      return session;
    }),
    resumeSession: vi.fn(async (_handle: unknown, config: AgentSessionConfig, context?: AgentLaunchContext, options?: { purpose?: string }) => {
      calls.push({ kind: 'resume', config, context, purpose: options?.purpose });
      return session;
    }),
    fetchCatalog: vi.fn(async () => ({
      models: [
        { provider: 'claude', id: 'opus', label: 'Opus', description: 'reasoning', isDefault: true,
          thinkingOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultThinkingOptionId: 'high' },
        { provider: 'claude', id: 'hidden', label: 'Hidden', isSelectable: false },
      ], modes: [],
    })),
    listImportableSessions: vi.fn(async () => [{
      providerHandleId: 'native-session', cwd: '/tmp/project', title: 'Named', firstPromptPreview: 'first',
      lastPromptPreview: 'second', lastActivityAt: new Date('2026-01-02T00:00:00Z'),
    }]),
  } as unknown as AgentClient;
  return { client, calls, session };
}

describe('Claude provider composition', () => {
  it('forwards model, effort, permissions, instructions, and hook marker on create and resume', async () => {
    const { client, calls } = fakeClient();
    const backend = createClaudeBackend({ client });
    expect(backend.id).toBe('claude-agent');
    expect(backend.displayName).toBe('Claude');
    expect(backend.capabilities).toEqual({ goal: true, steer: true, compact: true, resume: true, approvals: false });
    expect(backend.supportedModes).toEqual(['qa', 'write', 'full']);

    await backend.startThread({ cwd: '/tmp/project', model: 'opus', effort: 'high', mode: 'qa', network: false });
    await backend.resumeThread({ cwd: '/tmp/project', sessionId: 'native-session', model: 'opus', effort: 'ultra', mode: 'write' });
    expect(calls.map((call) => call.kind)).toEqual(['create', 'resume']);
    expect(calls[0]?.config).toMatchObject({
      provider: 'claude', cwd: '/tmp/project', model: 'opus', thinkingOptionId: 'high',
      modeId: 'bypassPermissions', daemonAppendSystemPrompt: BRIDGE_DEVELOPER_INSTRUCTIONS,
      providerOptions: { sandbox: { enabled: true, filesystem: { denyWrite: ['/tmp/project'] } },
        disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'] },
    });
    expect(calls[1]?.config.thinkingOptionId).toBe('ultracode');
    for (const call of calls) {
      expect(call.context?.env).toMatchObject({ FEISHU_CODEX_BRIDGE: '1', CLAUDE_CODE_ENTRYPOINT: 'feishu-codex-bridge' });
    }
  });

  it('uses the provider catalog and native session history without a turn', async () => {
    const { client, calls, session } = fakeClient();
    const backend = createClaudeBackend({ client });
    expect(await backend.listModels()).toEqual([{
      id: 'opus', displayName: 'Opus', description: 'reasoning', supportedEfforts: ['low', 'high'],
      defaultEffort: 'high', isDefault: true, hidden: false,
    }]);
    expect(await backend.listThreads('/tmp/project')).toEqual([{
      sessionId: 'native-session', preview: 'first', name: 'Named', createdAt: 1767312000, updatedAt: 1767312000,
    }]);
    expect(await backend.readHistory('/tmp/project', 'native-session', 1)).toEqual({
      turns: [{ userText: 'second', assistantText: 'second answer', reasoning: '', tools: [] }], totalTurns: 2,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.purpose).toBe('history');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('keeps native titles readable, writable, and generated with the chosen model', async () => {
    const { client } = fakeClient();
    const getSessionInfo = vi.fn(async () => ({ customTitle: ' Named ' }));
    const renameSession = vi.fn(async () => {});
    const query = vi.fn((_input: unknown) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', structured_output: { title: 'Generated' }, result: '' };
      },
      close: vi.fn(),
    } as unknown as Query));
    const backend = createClaudeBackend({ client, titles: {
      getSessionInfo: getSessionInfo as unknown as typeof import('@anthropic-ai/claude-agent-sdk').getSessionInfo,
      renameSession: renameSession as unknown as typeof import('@anthropic-ai/claude-agent-sdk').renameSession,
      query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query,
    } });
    expect(await backend.readSessionTitle('/tmp/project', 'native-session')).toBe('Named');
    await backend.setSessionTitle('/tmp/project', 'native-session', ' New ');
    expect(renameSession).toHaveBeenCalledWith('native-session', 'New', { dir: '/tmp/project' });
    expect(await backend.generateSessionTitle({ cwd: '/tmp/project', prompt: 'name it', model: 'opus', effort: 'high' })).toBe('Generated');
    expect(query.mock.calls[0]?.[0]).toMatchObject({ prompt: 'name it', options: {
      cwd: '/tmp/project', model: 'opus', effort: 'high', persistSession: false, maxTurns: 1,
      tools: [], skills: [], settingSources: [],
    } });
  });
});
