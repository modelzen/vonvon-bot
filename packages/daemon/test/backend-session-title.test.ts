import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelInfo as ClaudeSdkModelInfo,
  Query,
  SDKMessage,
  SDKSessionInfo,
} from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeAgentBackend,
  withConfiguredDefault,
  type ClaudeSdkFacade,
} from '../src/agent/claude-agent/backend';
import { readConfiguredClaudeModel } from '../src/agent/claude-agent/configured-model';
import type { ModelInfo } from '../src/agent/types';
import {
  CodexAppServerBackend,
  type CodexTitleBackendDeps,
  type CodexTitleClient,
} from '../src/agent/codex-appserver/backend';
import type { ServerNotification } from '../src/agent/codex-appserver/protocol';

function asyncQuery(
  messages: SDKMessage[],
  models: ClaudeSdkModelInfo[] = [],
): Query & { close: ReturnType<typeof vi.fn<() => void>>; supportedModels: ReturnType<typeof vi.fn<() => Promise<ClaudeSdkModelInfo[]>>> } {
  const generator = (async function* () {
    for (const message of messages) yield message;
  })() as Query & { close: ReturnType<typeof vi.fn<() => void>>; supportedModels: ReturnType<typeof vi.fn<() => Promise<ClaudeSdkModelInfo[]>>> };
  generator.close = vi.fn();
  generator.supportedModels = vi.fn(async () => models);
  return generator;
}

const configDirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of configDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway CLAUDE_CONFIG_DIR holding the given files (paths relative to it), removed after the test. */
function claudeConfig(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'vonvon-claude-config-'));
  configDirs.push(dir);
  for (const file of files) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), '{}\n');
  }
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
  return dir;
}

function successResult(title: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    structured_output: { title },
    result: JSON.stringify({ title }),
  } as SDKMessage;
}

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

describe('Claude backend native session titles', () => {
  it('passes the dedicated non-SDK entrypoint on both fresh and resumed chats', async () => {
    const firstQuery = asyncQuery([]);
    const resumedQuery = asyncQuery([]);
    const query = vi.fn()
      .mockReturnValueOnce(firstQuery)
      .mockReturnValueOnce(resumedQuery);
    const sdk = {
      query,
      listSessions: vi.fn(),
      getSessionInfo: vi.fn(),
      getSessionMessages: vi.fn(),
      renameSession: vi.fn(),
    } as unknown as ClaudeSdkFacade;
    const backend = new ClaudeAgentBackend(async () => sdk);
    claudeConfig(['projects/-repo/session-1.jsonl']);

    const fresh = await backend.startThread({ cwd: '/repo' });
    const resumed = await backend.resumeThread({ cwd: '/repo', sessionId: 'session-1' });

    for (const call of query.mock.calls) {
      expect(call[0].options?.env).toEqual(expect.objectContaining({
        FEISHU_CODEX_BRIDGE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'feishu-codex-bridge',
      }));
    }
    expect(query.mock.calls[0]![0].options).toEqual(expect.objectContaining({
      cwd: '/repo',
      sessionId: fresh.sessionId,
    }));
    expect(query.mock.calls[1]![0].options).toEqual(expect.objectContaining({
      cwd: '/repo',
      resume: 'session-1',
    }));

    await fresh.close();
    await resumed.close();
  });

  it('refuses to resume a session Claude Code never saved, so the caller starts a fresh one', async () => {
    const query = vi.fn(() => asyncQuery([]));
    const sdk = { query, listSessions: vi.fn(), getSessionInfo: vi.fn(), getSessionMessages: vi.fn(), renameSession: vi.fn() } as unknown as ClaudeSdkFacade;
    const backend = new ClaudeAgentBackend(async () => sdk);
    claudeConfig(['projects/-repo/other-session.jsonl']);

    await expect(backend.resumeThread({ cwd: '/repo', sessionId: 'never-saved' })).rejects.toThrow('没有保存下来');
    expect(query).not.toHaveBeenCalled();

    claudeConfig([]);
    await expect(backend.resumeThread({ cwd: '/repo', sessionId: 'never-saved' })).rejects.toThrow('没有保存下来');
  });

  it('resumes a saved transcript in any project folder, even one getSessionInfo cannot summarise', async () => {
    const query = vi.fn((_params: { options?: { resume?: string } }) => asyncQuery([]));
    const getSessionInfo = vi.fn(async (): Promise<SDKSessionInfo | undefined> => undefined);
    const sdk = { query, listSessions: vi.fn(), getSessionInfo, getSessionMessages: vi.fn(), renameSession: vi.fn() } as unknown as ClaudeSdkFacade;
    const backend = new ClaudeAgentBackend(async () => sdk);
    // Claude Code named the folder after another spelling of the path (case, symlink): still found.
    claudeConfig(['projects/-Users-me-Documents-repo/long-session.jsonl']);

    const resumed = await backend.resumeThread({ cwd: '/Users/me/documents/repo', sessionId: 'long-session' });
    expect(query.mock.calls[0]![0].options).toEqual(expect.objectContaining({ resume: 'long-session' }));
    await resumed.close();
  });

  it('still resumes when the transcript folder cannot be read', async () => {
    const query = vi.fn((_params: { options?: { resume?: string } }) => asyncQuery([]));
    const sdk = { query, listSessions: vi.fn(), getSessionInfo: vi.fn(), getSessionMessages: vi.fn(), renameSession: vi.fn() } as unknown as ClaudeSdkFacade;
    const backend = new ClaudeAgentBackend(async () => sdk);
    const dir = claudeConfig([]);
    writeFileSync(join(dir, 'projects'), 'not a folder');

    const resumed = await backend.resumeThread({ cwd: '/repo', sessionId: 'session-1' });
    expect(query.mock.calls[0]![0].options).toEqual(expect.objectContaining({ resume: 'session-1' }));
    await resumed.close();
  });

  it('uses customTitle/renameSession and an ephemeral no-tools structured query', async () => {
    const modelQuery = asyncQuery([], [{
      value: 'claude-title-model',
      displayName: 'Claude Title',
      description: 'small and fast',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
    }]);
    const titleQuery = asyncQuery([successResult('定位支付回调失败')]);
    const query = vi.fn()
      .mockReturnValueOnce(modelQuery)
      .mockReturnValueOnce(titleQuery);
    const renameSession = vi.fn(async () => undefined);
    const getSessionInfo = vi.fn(async (): Promise<SDKSessionInfo | undefined> => ({
      sessionId: 'session-1',
      summary: 'summary is not a title',
      customTitle: ' 原生标题 ',
      lastModified: 2,
    }));
    const sdk = {
      query,
      listSessions: vi.fn(async () => []),
      getSessionInfo,
      getSessionMessages: vi.fn(async () => []),
      renameSession,
    } as unknown as ClaudeSdkFacade;
    const backend = new ClaudeAgentBackend(async () => sdk, () => undefined);

    const models = await backend.listModels();
    expect(models).toEqual([expect.objectContaining({
      id: 'claude-title-model',
      supportedEfforts: ['low', 'high'],
      isDefault: true,
    })]);
    // Same settings source as the login probe: the user layer (where an `env`
    // with ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL lives), no hooks, no MCP.
    const listCall = query.mock.calls[0]![0];
    expect(listCall.options).toEqual(expect.objectContaining({
      cwd: homedir(),
      settingSources: ['user'],
      strictMcpConfig: true,
      settings: expect.objectContaining({
        disableAllHooks: true,
        claudeMdExcludes: expect.arrayContaining(['**/.claude/CLAUDE.md']),
      }),
      env: expect.objectContaining({ FEISHU_CODEX_BRIDGE: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }),
    }));
    await expect(backend.listModels()).resolves.toEqual(models);
    expect(query).toHaveBeenCalledOnce(); // successful discovery is cached
    expect(modelQuery.close).toHaveBeenCalledOnce();

    await expect(backend.readSessionTitle('/repo', 'session-1')).resolves.toBe('原生标题');
    getSessionInfo.mockResolvedValueOnce({
      sessionId: 'session-1',
      summary: '只有摘要和首条消息，不能当作 customTitle',
      firstPrompt: '首条消息',
      customTitle: undefined,
      lastModified: 3,
    });
    await expect(backend.readSessionTitle('/repo', 'session-1')).resolves.toBeUndefined();
    await backend.setSessionTitle('/repo', 'session-1', ' 新原生标题 ');
    expect(renameSession).toHaveBeenCalledWith('session-1', '新原生标题', { dir: '/repo' });

    await expect(backend.generateSessionTitle({
      cwd: '/repo',
      prompt: '完整标题提示词',
      model: 'claude-title-model',
      effort: 'xhigh',
    })).resolves.toBe('定位支付回调失败');

    const titleCall = query.mock.calls[1]![0];
    expect(titleCall.prompt).toBe('完整标题提示词');
    expect(titleCall.options).toEqual(expect.objectContaining({
      cwd: '/repo',
      model: 'claude-title-model',
      effort: 'xhigh',
      persistSession: false,
      maxTurns: 1,
      tools: [],
      skills: [],
      mcpServers: {},
      settingSources: ['user'],
      settings: expect.objectContaining({
        disableAllHooks: true,
        claudeMdExcludes: expect.arrayContaining(['**/.claude/CLAUDE.md']),
      }),
      env: expect.objectContaining({ FEISHU_CODEX_BRIDGE: '1' }),
      outputFormat: {
        type: 'json_schema',
        schema: expect.objectContaining({ required: ['title'] }),
      },
    }));
    expect(titleQuery.close).toHaveBeenCalledOnce();
  });

  it('falls back to the static catalog only when SDK discovery fails', async () => {
    const failed = asyncQuery([]);
    failed.supportedModels.mockRejectedValue(new Error('SDK init failed'));
    const recovered = asyncQuery([], [{
      value: 'claude-recovered',
      displayName: 'Recovered',
      description: '',
      supportedEffortLevels: ['low'],
    }]);
    const query = vi.fn()
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(recovered);
    const sdk = {
      query,
      listSessions: vi.fn(),
      getSessionInfo: vi.fn(),
      getSessionMessages: vi.fn(),
      renameSession: vi.fn(),
    } as unknown as ClaudeSdkFacade;
    const backend = new ClaudeAgentBackend(async () => sdk, () => undefined);

    const models = await backend.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]!.id).toMatch(/^claude-/);
    expect(failed.close).toHaveBeenCalledOnce();

    // Failure fallback is not cached: the next call retries and then caches the
    // successful live catalog instead of pinning the process to stale statics.
    await expect(backend.listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'claude-recovered' }),
    ]);
    await backend.listModels();
    expect(query).toHaveBeenCalledTimes(2);
    expect(recovered.close).toHaveBeenCalledOnce();
  });
});

describe('Claude model configured in the user settings (DeepSeek, Kimi)', () => {
  const row = (id: string, isDefault = false): ModelInfo => ({
    id,
    displayName: id,
    description: '',
    supportedEfforts: ['low', 'high'],
    defaultEffort: 'high',
    isDefault,
    hidden: false,
  });

  it('becomes the default and goes first, whether or not the list has it', () => {
    const list = [row('default', true), row('opus'), row('kimi-k2')];
    expect(withConfiguredDefault(list, undefined)).toBe(list);
    expect(withConfiguredDefault(list, 'kimi-k2').map((m) => [m.id, m.isDefault])).toEqual([
      ['kimi-k2', true],
      ['default', false],
      ['opus', false],
    ]);
    const added = withConfiguredDefault(list, 'deepseek-chat');
    expect(added[0]).toMatchObject({ id: 'deepseek-chat', isDefault: true, description: '来自 Claude 设置' });
    expect(added.slice(1).every((m) => !m.isDefault)).toBe(true);
    expect(list[0]!.isDefault).toBe(true); // input untouched
  });

  it('marks discovery and the static fallback alike', async () => {
    const failed = asyncQuery([]);
    failed.supportedModels.mockRejectedValue(new Error('SDK init failed'));
    const live = asyncQuery([], [
      { value: 'default', displayName: 'Default', description: '' },
      { value: 'kimi-k2', displayName: 'kimi-k2', description: 'Custom model' },
    ]);
    const query = vi.fn().mockReturnValueOnce(failed).mockReturnValueOnce(live);
    const sdk = { query } as unknown as ClaudeSdkFacade;
    const backend = new ClaudeAgentBackend(async () => sdk, () => 'kimi-k2');
    expect((await backend.listModels())[0]).toMatchObject({ id: 'kimi-k2', isDefault: true });
    expect((await backend.listModels()).map((m) => [m.id, m.isDefault])).toEqual([
      ['kimi-k2', true],
      ['default', false],
    ]);
  });

  it('reads settings env first, then the process env, then the settings model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vonvon-claude-cfg-'));
    try {
      const cfg = join(dir, 'cfg');
      mkdirSync(cfg);
      const env = { CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_MODEL: 'from-process' };
      const write = (body: unknown) => writeFileSync(join(cfg, 'settings.json'), typeof body === 'string' ? body : JSON.stringify(body));
      write({ env: { ANTHROPIC_MODEL: ' deepseek-chat ' }, model: 'opus' });
      expect(readConfiguredClaudeModel(env, dir)).toBe('deepseek-chat');
      write({ env: {}, model: 'opus' });
      expect(readConfiguredClaudeModel(env, dir)).toBe('from-process');
      expect(readConfiguredClaudeModel({ CLAUDE_CONFIG_DIR: cfg }, dir)).toBe('opus');
      write('{ not json');
      expect(readConfiguredClaudeModel(env, dir)).toBe('from-process');
      expect(readConfiguredClaudeModel({ CLAUDE_CONFIG_DIR: cfg }, dir)).toBeUndefined();
      // Without CLAUDE_CONFIG_DIR it reads <home>/.claude/settings.json.
      mkdirSync(join(dir, '.claude'));
      writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet' }));
      expect(readConfiguredClaudeModel({}, dir)).toBe('sonnet');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
