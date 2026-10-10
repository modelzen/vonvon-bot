import { describe, expect, it, vi } from 'vitest';
import { createClaudeBackend } from '../src/agent/claude-provider';
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeProviderDependencies } from '../src/agent/claude-provider';
import type { AgentClient, AgentSession, AgentStreamEvent, ToolCallDetail } from '../src/agent/paseo/agent-sdk-types';

function historyClient(events: AgentStreamEvent[], info: SDKSessionInfo | undefined = {
  sessionId: 's1', customTitle: '我的标题', summary: '摘要', firstPrompt: '第一句',
  createdAt: 2_000_000, lastModified: 5_000_000,
}) {
  const session = {
    async *streamHistory() { yield* events; },
    close: vi.fn(async () => {}),
  } as unknown as AgentSession;
  const resumeSession = vi.fn(async () => session);
  const listImportableSessions = vi.fn(async () => [{
    providerHandleId: 's1', cwd: '/repo', title: '我的标题',
    firstPromptPreview: '第一句', lastPromptPreview: '最后一句',
    lastActivityAt: new Date(5_000_000),
  }]);
  const client = {
    provider: 'claude', resumeSession, listImportableSessions,
  } as unknown as AgentClient;
  const getSessionInfo = vi.fn(async () => info);
  const titles: NonNullable<ClaudeProviderDependencies['titles']> = {
    getSessionInfo, renameSession: vi.fn(), query: vi.fn(),
  };
  return { backend: createClaudeBackend({ client, titles }), session, resumeSession, listImportableSessions, getSessionInfo };
}

function timeline(item: Extract<AgentStreamEvent, { type: 'timeline' }>['item']): AgentStreamEvent {
  return { type: 'timeline', provider: 'claude', item };
}

describe('Claude public session history', () => {
  it('lists native sessions with title precedence and distinct creation and update timestamps', async () => {
    const { backend, listImportableSessions } = historyClient([]);
    expect(await backend.listThreads('/repo', 5)).toEqual([{
      sessionId: 's1', name: '我的标题', preview: '我的标题',
      createdAt: 2000, updatedAt: 5000,
    }]);
    expect(listImportableSessions).toHaveBeenCalledWith({ cwd: '/repo', limit: 5 });
  });

  it.each([
    [{ sessionId: 's1', summary: 'S', lastModified: 9000 }, 'S', 9],
    [{ sessionId: 's1', summary: '', firstPrompt: 'FP', lastModified: 1000 }, 'FP', 1],
  ] satisfies [SDKSessionInfo, string, number][])('preserves summary and first-prompt fallbacks: %j', async (info, preview, timestamp) => {
    const { backend, getSessionInfo } = historyClient([], info);
    expect(await backend.listThreads('/repo', 5)).toEqual([{
      sessionId: 's1', preview, createdAt: timestamp, updatedAt: timestamp,
    }]);
    expect(getSessionInfo).toHaveBeenCalledWith('s1', { dir: '/repo' });
  });

  it.each([
    { type: 'read', filePath: '/repo/a', content: 'retained contents' },
    { type: 'search', query: 'needle', content: 'retained contents' },
    { type: 'fetch', url: 'https://example.com', result: 'retained contents' },
    { type: 'plain_text', text: 'retained contents' },
    { type: 'unknown', input: {}, output: 'retained contents' },
    { type: 'write', filePath: '/repo/a', content: 'retained contents' },
    { type: 'sub_agent', log: 'retained contents' },
    { type: 'plan', text: 'retained contents' },
  ] satisfies ToolCallDetail[])('retains non-shell output: $type', async (detail) => {
    const { backend } = historyClient([
      timeline({ type: 'user_message', text: 'read file' }),
      timeline({ type: 'tool_call', callId: 'tool-1', name: 'Tool', status: 'completed', error: null, detail }),
    ]);
    expect((await backend.readHistory('/repo', 's1', 10)).turns[0]?.tools[0]?.output).toBe('retained contents');
  });

  it('retains the provider listing if supplemental SDK metadata cannot be read', async () => {
    const { backend, getSessionInfo } = historyClient([]);
    getSessionInfo.mockRejectedValueOnce(new Error('session disappeared'));
    expect(await backend.listThreads('/repo', 5)).toEqual([{
      sessionId: 's1', name: '我的标题', preview: '我的标题', createdAt: 5000, updatedAt: 5000,
    }]);
  });

  it('folds user, answer, reasoning, and completed tool output into a history turn', async () => {
    const { backend, session, resumeSession } = historyClient([
      timeline({ type: 'user_message', text: '跑个命令' }),
      timeline({ type: 'reasoning', text: '想一下' }),
      timeline({ type: 'tool_call', callId: 'tu1', name: 'Bash', status: 'running', error: null,
        detail: { type: 'shell', command: 'ls' } }),
      timeline({ type: 'tool_call', callId: 'tu1', name: 'Bash', status: 'completed', error: null,
        detail: { type: 'shell', command: 'ls', output: '文件列表' } }),
      timeline({ type: 'assistant_message', text: '完成' }),
    ]);
    expect(await backend.readHistory('/repo', 's1', 10)).toEqual({ totalTurns: 1, turns: [{
      userText: '跑个命令', assistantText: '完成', reasoning: '想一下',
      tools: [{ title: 'ls', output: '文件列表' }],
    }] });
    expect(resumeSession).toHaveBeenCalledWith(
      { provider: 'claude', sessionId: 's1', metadata: { cwd: '/repo' } },
      { provider: 'claude', cwd: '/repo' },
      { env: { FEISHU_CODEX_BRIDGE: '1', CLAUDE_CODE_ENTRYPOINT: 'feishu-codex-bridge' } },
      { purpose: 'history' },
    );
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('retains only the last requested turns but reports the full count', async () => {
    const events: AgentStreamEvent[] = [];
    for (let i = 1; i <= 5; i++) {
      events.push(timeline({ type: 'user_message', text: `问题${i}` }));
      events.push(timeline({ type: 'assistant_message', text: `答${i}` }));
    }
    const { backend } = historyClient(events);
    const history = await backend.readHistory('/repo', 's1', 2);
    expect(history.totalTurns).toBe(5);
    expect(history.turns.map((turn) => turn.userText)).toEqual(['问题4', '问题5']);
  });

  it.each(['<environment_context>', '# AGENTS.md', '<system-reminder>', 'Caveat:'])(
    'omits leading-whitespace %s boilerplate from the visible history', async (prefix) => {
    const { backend } = historyClient([
      timeline({ type: 'user_message', text: ` \n  ${prefix} internal setup` }),
      timeline({ type: 'user_message', text: '真问题' }),
      timeline({ type: 'assistant_message', text: '真答案' }),
    ]);
    expect(await backend.readHistory('/repo', 's1', 10)).toEqual({ totalTurns: 1, turns: [{
      userText: '真问题', assistantText: '真答案', reasoning: '', tools: [],
    }] });
  });
});
