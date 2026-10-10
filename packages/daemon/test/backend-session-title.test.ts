import { describe, expect, it, vi } from 'vitest';
import {
  CodexAppServerBackend,
  type CodexTitleBackendDeps,
  type CodexTitleClient,
} from '../src/agent/codex-appserver/backend';
import type { ServerNotification } from '../src/agent/codex-appserver/protocol';

describe('Codex backend native session titles', () => {
  it('reads/sets the native name and generates via one isolated structured-output turn', async () => {
    const notifications = [
      {
        method: 'turn/started',
        params: { threadId: 'title-thread', turn: { id: 'turn-1' } },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'title-thread',
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'msg-1', text: '{"title":"修复登录超时"}' },
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'title-thread',
          turn: { id: 'turn-1', status: 'completed', error: null },
        },
      },
    ] as unknown as ServerNotification[];
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/start') return { thread: { id: 'title-thread' } };
      return {};
    });
    const close = vi.fn(async () => undefined);
    const client: CodexTitleClient = {
      connect: vi.fn(async () => undefined),
      request: request as CodexTitleClient['request'],
      stream: () => (async function* () { yield* notifications; })(),
      close,
    };
    let nativeName: string | null = ' 已有标题 ';
    const utility = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { name: nativeName } };
      return {};
    });
    const deps: CodexTitleBackendDeps = {
      utilityRequest: utility as CodexTitleBackendDeps['utilityRequest'],
      resolveBin: (() => '/fake/codex') as CodexTitleBackendDeps['resolveBin'],
      createClient: vi.fn(() => client),
    };
    const backend = new CodexAppServerBackend(deps);

    await expect(backend.readSessionTitle('/repo', 'session-1')).resolves.toBe('已有标题');
    expect(utility).toHaveBeenCalledWith(
      'thread/read',
      { threadId: 'session-1', includeTurns: false },
      { timeoutMs: 20_000 },
    );
    nativeName = null;
    await expect(backend.readSessionTitle('/repo', 'session-1')).resolves.toBeUndefined();
    await backend.setSessionTitle('/repo', 'session-1', ' 新标题 ');
    expect(utility).toHaveBeenCalledWith(
      'thread/name/set',
      { threadId: 'session-1', name: '新标题' },
    );

    await expect(backend.generateSessionTitle({
      cwd: '/repo',
      prompt: '完整标题提示词',
      model: 'gpt-title-model',
      effort: 'low',
    })).resolves.toBe('修复登录超时');

    expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      cwd: '/repo',
      model: 'gpt-title-model',
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      config: expect.objectContaining({ web_search: 'disabled' }),
    }));
    expect(request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      threadId: 'title-thread',
      model: 'gpt-title-model',
      effort: 'low',
      input: [{ type: 'text', text: '完整标题提示词', text_elements: [] }],
      outputSchema: expect.objectContaining({
        required: ['title'],
        properties: { title: { type: 'string', maxLength: 36 } },
      }),
    }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('propagates title-turn errors and still closes the dedicated client', async () => {
    const close = vi.fn(async () => undefined);
    const client: CodexTitleClient = {
      connect: vi.fn(async () => undefined),
      request: vi.fn(async (method: string) =>
        method === 'thread/start' ? { thread: { id: 'title-thread' } } : {}) as CodexTitleClient['request'],
      stream: () => (async function* () {
        yield {
          method: 'error',
          params: { error: { message: 'model unavailable' }, willRetry: false },
        } as ServerNotification;
      })(),
      close,
    };
    const backend = new CodexAppServerBackend({
      utilityRequest: vi.fn() as unknown as CodexTitleBackendDeps['utilityRequest'],
      resolveBin: (() => '/fake/codex') as CodexTitleBackendDeps['resolveBin'],
      createClient: () => client,
    });

    await expect(backend.generateSessionTitle({
      cwd: '/repo', prompt: 'prompt', model: 'exact-model', effort: 'high',
    })).rejects.toThrow('model unavailable');
    expect(close).toHaveBeenCalledOnce();
  });
});
