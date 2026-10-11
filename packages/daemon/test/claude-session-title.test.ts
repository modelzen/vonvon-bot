import { describe, expect, it, vi } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeBackend, type ClaudeProviderDependencies } from '../src/agent/claude-provider';
import type { AgentClient } from '../src/agent/paseo/agent-sdk-types';

function titles(queryMessages: unknown[] = []) {
  const getSessionInfo = vi.fn(async () => ({ sessionId: 'session-1', customTitle: ' 原生标题 ', summary: '摘要' }));
  const renameSession = vi.fn(async () => {});
  const close = vi.fn();
  const query = vi.fn(() => ({
    async *[Symbol.asyncIterator]() { yield* queryMessages; },
    close,
  } as unknown as Query));
  const sdk = { getSessionInfo, renameSession, query } as unknown as NonNullable<ClaudeProviderDependencies['titles']>;
  const client = { provider: 'claude' } as unknown as AgentClient;
  return { backend: createClaudeBackend({ client, titles: sdk }), getSessionInfo, renameSession, query, close };
}

describe('Claude native session titles through the new backend', () => {
  it('reads only customTitle and trims titles before writing', async () => {
    const { backend, getSessionInfo, renameSession } = titles();
    expect(await backend.readSessionTitle('/repo', 'session-1')).toBe('原生标题');
    expect(getSessionInfo).toHaveBeenCalledWith('session-1', { dir: '/repo' });
    getSessionInfo.mockResolvedValueOnce({ sessionId: 'session-1', customTitle: '', summary: '摘要' });
    expect(await backend.readSessionTitle('/repo', 'session-1')).toBeUndefined();
    await backend.setSessionTitle('/repo', 'session-1', ' 新标题 ');
    expect(renameSession).toHaveBeenCalledWith('session-1', '新标题', { dir: '/repo' });
    await expect(backend.setSessionTitle('/repo', 'session-1', '  ')).rejects.toThrow('empty');
  });

  it.each(['high', 'xhigh'] as const)('generates with %s effort in an ephemeral, one-turn, structured, no-tools query and closes it', async (effort) => {
    const { backend, query, close } = titles([{
      type: 'result', subtype: 'success', structured_output: { title: '定位支付回调失败' }, result: '',
    }]);
    expect(await backend.generateSessionTitle({
      cwd: '/repo', prompt: '完整标题提示词', model: 'claude-title-model', effort,
    })).toBe('定位支付回调失败');
    expect(query).toHaveBeenCalledWith({ prompt: '完整标题提示词', options: expect.objectContaining({
      cwd: '/repo', model: 'claude-title-model', effort, persistSession: false,
      maxTurns: 1, tools: [], skills: [], mcpServers: {}, settingSources: [],
      outputFormat: { type: 'json_schema', schema: expect.objectContaining({ required: ['title'] }) },
    }) });
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports title-turn errors and still closes the dedicated query', async () => {
    const { backend, close } = titles([{
      type: 'result', subtype: 'error_during_execution', errors: ['model unavailable'], result: '',
    }]);
    await expect(backend.generateSessionTitle({
      cwd: '/repo', prompt: 'prompt', model: 'claude-title-model', effort: 'high',
    })).rejects.toThrow('model unavailable');
    expect(close).toHaveBeenCalledOnce();
  });
});
