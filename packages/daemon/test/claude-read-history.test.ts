import { describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';

const user = (text: string): SessionMessage => ({
  type: 'user', uuid: 'u', session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null,
  message: { role: 'user', content: [{ type: 'text', text }] },
});
function fixture(messages = [user('第一句')]) {
  const sdk = {
    query: vi.fn<ClaudeSdkFacade['query']>(() => { throw new Error('Inference forbidden in a local-history test'); }),
    listSessions: vi.fn<ClaudeSdkFacade['listSessions']>(),
    getSessionInfo: vi.fn<ClaudeSdkFacade['getSessionInfo']>().mockResolvedValue({
      sessionId: 'session-1', summary: '自动摘要', customTitle: ' 原生标题 ', lastModified: 1,
    }),
    getSessionMessages: vi.fn<ClaudeSdkFacade['getSessionMessages']>().mockResolvedValue(messages),
    renameSession: vi.fn<ClaudeSdkFacade['renameSession']>(),
  } satisfies ClaudeSdkFacade;
  return { sdk, backend: new ClaudeAgentBackend(async () => sdk) };
}

describe('Claude local history titles', () => {
  it('returns the native title and first user message without starting inference', async () => {
    const { sdk, backend } = fixture();
    const history = await backend.readHistory('/repo', 'session-1');
    expect(history).toMatchObject({ name: '原生标题', preview: '第一句', totalTurns: 1 });
    expect(history.turns[0]?.userText).toBe('第一句');
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it.each([undefined, '   '])('uses the first prompt when customTitle is %j', async customTitle => {
    const { sdk, backend } = fixture();
    sdk.getSessionInfo.mockResolvedValue({ sessionId: 'session-1', summary: '摘要不当作标题', lastModified: 1,
      ...(customTitle !== undefined ? { customTitle } : {}) });
    const history = await backend.readHistory('/repo', 'session-1');
    expect(history.name).toBeUndefined();
    expect(history.preview).toBe('第一句');
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it('keeps the transcript and preview if title metadata cannot be read', async () => {
    const { sdk, backend } = fixture();
    sdk.getSessionInfo.mockRejectedValue(new Error('metadata unreadable'));
    const history = await backend.readHistory('/repo', 'session-1');
    expect(history).toMatchObject({ preview: '第一句', totalTurns: 1 });
    expect(history.name).toBeUndefined();
    expect(history.turns[0]?.userText).toBe('第一句');
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it.each([0, 2])('keeps the original preview when only %i recent turns are displayed', async maxTurns => {
    const { sdk, backend } = fixture(Array.from({ length: 5 }, (_, i) => user(`问题${i + 1}`)));
    sdk.getSessionInfo.mockResolvedValue(undefined);
    const history = await backend.readHistory('/repo', 'session-1', maxTurns);
    expect(history.preview).toBe('问题1');
    expect(history.totalTurns).toBe(5);
    expect(history.turns.map(turn => turn.userText)).toEqual(maxTurns ? ['问题4', '问题5'] : []);
  });

  it('finds the first user prompt after an assistant-only turn', async () => {
    const assistant: SessionMessage = { type: 'assistant', uuid: 'a', session_id: 'session-1', parent_tool_use_id: null,
      parent_agent_id: null, message: { role: 'assistant', content: [{ type: 'text', text: '开场' }] } };
    const { backend } = fixture([assistant, user('第一句')]);
    expect((await backend.readHistory('/repo', 'session-1')).preview).toBe('第一句');
  });

  it('still returns empty history when the transcript cannot be read', async () => {
    const { sdk, backend } = fixture();
    sdk.getSessionMessages.mockRejectedValue(new Error('transcript unreadable'));
    expect(await backend.readHistory('/repo', 'session-1')).toEqual({ turns: [], totalTurns: 0 });
    expect(sdk.query).not.toHaveBeenCalled();
  });
});
