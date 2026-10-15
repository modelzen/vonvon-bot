import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendNotInstalledError } from '../src/agent/backend-loader';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { CLAUDE_SIGNED_OUT_MESSAGE, cachedClaudeLogin, loginFromAccount, loginFromEnv, readClaudeLogin, resetClaudeLoginCache } from '../src/agent/claude-agent/login';

afterEach(() => {
  resetClaudeLoginCache();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Claude login mapping', () => {
  it('maps the account the CLI reports', () => {
    expect(loginFromAccount({ subscriptionType: 'max', tokenSource: 'claude.ai', apiProvider: 'firstParty' })).toMatchObject({ state: 'signedIn' });
    expect(loginFromAccount({ apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'none', apiProvider: 'firstParty' })).toEqual({ state: 'signedIn', message: '已登录，凭据来自 ANTHROPIC_API_KEY。' });
    expect(loginFromAccount({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' })).toMatchObject({ state: 'signedIn' });
    expect(loginFromAccount({ tokenSource: 'none', apiProvider: 'firstParty' })).toEqual({ state: 'signedOut', message: CLAUDE_SIGNED_OUT_MESSAGE });
    expect(loginFromAccount({ apiKeySource: 'none' })).toEqual({ state: 'signedOut', message: CLAUDE_SIGNED_OUT_MESSAGE });
    expect(loginFromAccount({ apiProvider: 'bedrock' })).toMatchObject({ state: 'unknown' });
    expect(loginFromAccount({})).toBeNull();
    expect(loginFromAccount(undefined)).toBeNull();
  });

  it('falls back to credential variables but never reports signed out', () => {
    expect(loginFromEnv({ ANTHROPIC_API_KEY: 'sk-fixture' }, 'x')).toEqual({ state: 'signedIn', message: '设置了 ANTHROPIC_API_KEY，没有验证过。' });
    expect(loginFromEnv({ ANTHROPIC_API_KEY: '  ' }, '起不来')).toEqual({ state: 'unknown', message: '无法确认：起不来' });
  });

  it('caches answers, shares one probe and refreshes on request', async () => {
    vi.useFakeTimers();
    let release!: (value: { state: 'signedOut'; message: string }) => void;
    const probe = vi.fn(() => new Promise<{ state: 'signedOut'; message: string }>(resolve => { release = resolve; }));
    const first = readClaudeLogin(probe);
    const second = readClaudeLogin(probe);
    release({ state: 'signedOut', message: 'out' });
    expect(await first).toEqual(await second);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(cachedClaudeLogin()).toEqual({ state: 'signedOut', message: 'out' });
    probe.mockImplementation(async () => ({ state: 'signedOut', message: 'out' }));
    await readClaudeLogin(probe);
    expect(probe).toHaveBeenCalledTimes(1);
    await readClaudeLogin(probe, { refresh: true });
    expect(probe).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5 * 60_000);
    expect(cachedClaudeLogin()).toBeUndefined();
    await readClaudeLogin(probe);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('answers a refresh with a probe that starts after it, not one already running', async () => {
    type Answer = { state: 'signedIn' | 'signedOut'; message: string };
    const releases: Array<(value: Answer) => void> = [];
    const probe = vi.fn(() => new Promise<Answer>(resolve => { releases.push(resolve); }));
    const background = readClaudeLogin(probe);
    const first = readClaudeLogin(probe, { refresh: true });
    const second = readClaudeLogin(probe, { refresh: true });
    releases[0]!({ state: 'signedOut', message: 'before' });
    expect(await background).toEqual({ state: 'signedOut', message: 'before' });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    releases[1]!({ state: 'signedIn', message: 'after' });
    expect(await first).toEqual({ state: 'signedIn', message: 'after' });
    expect(await second).toEqual({ state: 'signedIn', message: 'after' });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(cachedClaudeLogin()).toEqual({ state: 'signedIn', message: 'after' });
  });
});

describe('ClaudeAgentBackend.loginStatus', () => {
  function sdkWith(initializationResult: () => Promise<unknown>) {
    const close = vi.fn();
    const query = vi.fn(() => ({ initializationResult: vi.fn(initializationResult), close } as unknown as Query));
    return { sdk: { query } as unknown as ClaudeSdkFacade, query, close };
  }

  it('reads the account at initialize with user settings, no hooks and no connectors', async () => {
    const { sdk, query, close } = sdkWith(async () => ({ account: { subscriptionType: 'pro', apiProvider: 'firstParty' } }));
    const login = await new ClaudeAgentBackend(async () => sdk).loginStatus();
    expect(login).toEqual({ state: 'signedIn', message: '已登录 claude.ai 账号（pro）。' });
    const options = (query.mock.calls[0] as unknown as [{ options: Record<string, unknown> }])[0].options;
    expect(options).toMatchObject({ settingSources: ['user'], settings: { disableAllHooks: true }, tools: [], mcpServers: {}, strictMcpConfig: true, persistSession: false });
    expect((options.env as Record<string, string>).ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(close).toHaveBeenCalled();
  });

  it('says the SDK is missing, and uses the env when the CLI cannot start', async () => {
    expect(await new ClaudeAgentBackend(async () => { throw new BackendNotInstalledError('@anthropic-ai/claude-agent-sdk'); }).loginStatus()).toEqual({ state: 'unknown', message: '还没下载 Claude Agent SDK。' });
    expect(cachedClaudeLogin()).toBeUndefined();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    const { sdk, close } = sdkWith(async () => { throw new Error('spawn ENOENT'); });
    expect(await new ClaudeAgentBackend(async () => sdk).loginStatus()).toMatchObject({ state: 'unknown' });
    expect(close).toHaveBeenCalled();
  });
});
