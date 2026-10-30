import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fullOnly from '../src/agent/codex-appserver/full-only';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { BRIDGE_DEVELOPER_INSTRUCTIONS } from '../src/agent/bridge-instructions';
import { SESSION_ENV } from '../src/config/session-env';
import type { SessionProfile } from '../src/agent/session-profile';

const rpc = vi.hoisted(() => ({
  request: vi.fn(), close: vi.fn(async () => {}), take: vi.fn(), refill: vi.fn(async () => {}),
}));
vi.mock('../src/agent/codex-appserver/client-pool', async importOriginal => ({
  ...await importOriginal<typeof import('../src/agent/codex-appserver/client-pool')>(),
  takeWarmClient: rpc.take, refillWarmPool: rpc.refill, utilityRequest: vi.fn(), connectGated: vi.fn(),
}));
vi.mock('../src/agent/codex-appserver/locate', () => ({
  refreshCodexResolution: () => '/fake/codex', resolveCodexBin: () => '/fake/codex', codexVersionAsync: vi.fn(async () => 'codex-cli 0.163.0'), cachedCodexVersion: () => undefined,
}));

const explicit: SessionProfile = {
  instructions: 'Use the session instructions.', env: { PROFILE_TEST: 'session-value', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' },
  nativeSettings: { automaticMemory: false }, additionalRoots: [], capabilityPackages: [], mcpServers: [],
};
const threads: { close(): Promise<void> }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  rpc.request.mockImplementation(async (method, params) => method === 'config/read' ? { config: {} } : ({
    thread: { id: params.threadId ?? 'test-session', turns: [] }, cwd: params.cwd, runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
    approvalPolicy: 'never', activePermissionProfile: params.config?.default_permissions ? { id: 'feishu', extends: null } : null,
    sandbox: params.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' } : {
      type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    },
  }));
  rpc.take.mockReturnValue({ request: rpc.request, close: rpc.close });
});
afterEach(async () => {
  await Promise.all(threads.splice(0).map(thread => thread.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Codex session profile reaches the provider', () => {
  for (const action of ['start', 'resume'] as const) {
    for (const profile of [undefined, explicit]) {
      it(`${action}: ${profile ? 'explicit' : 'default'} profile`, async () => {
        const backend = new CodexAppServerBackend();
        const options = { cwd: '/profile-workspace', mode: 'full' as const, profile };
        const thread = action === 'start'
          ? await backend.startThread(options)
          : await backend.resumeThread({ ...options, sessionId: 'saved' });
        threads.push(thread);
        expect(rpc.request).toHaveBeenCalledWith(`thread/${action}`, expect.objectContaining({
          cwd: options.cwd,
          developerInstructions: profile
            ? `${BRIDGE_DEVELOPER_INSTRUCTIONS}\n\n${profile.instructions}` : BRIDGE_DEVELOPER_INSTRUCTIONS,
          config: expect.objectContaining({
            projects: { [options.cwd]: { trust_level: 'trusted' } },
            features: { memories: false },
            memories: { use_memories: false, generate_memories: false },
            shell_environment_policy: { set: { [SESSION_ENV]: '1', ...profile?.env } },
          }),
          ...(action === 'resume' ? { threadId: 'saved' } : {}),
        }));
      });
    }
    it(`${action}: closes the acquired process after a provider refusal`, async () => {
      rpc.request.mockResolvedValueOnce({ config: {} }).mockRejectedValueOnce(new Error('provider refusal'));
      const backend = new CodexAppServerBackend();
      const options = { cwd: '/profile-workspace', mode: 'full' as const };
      await expect(action === 'start' ? backend.startThread(options)
        : backend.resumeThread({ ...options, sessionId: 'saved' })).rejects.toThrow('provider refusal');
      expect(rpc.close).toHaveBeenCalledOnce();
    });
  }
});

function claudeFixture() {
  const query = vi.fn<ClaudeSdkFacade['query']>(() => {
    const stream = (async function* (): AsyncGenerator<SDKMessage> {})();
    // This fixture only exercises query construction and close, not SDK controls.
    return Object.assign(stream, { close: vi.fn() }) as unknown as Query;
  });
  const sdk = {
    query, listSessions: vi.fn<ClaudeSdkFacade['listSessions']>(),
    getSessionInfo: vi.fn<ClaudeSdkFacade['getSessionInfo']>(),
    getSessionMessages: vi.fn<ClaudeSdkFacade['getSessionMessages']>(),
    renameSession: vi.fn<ClaudeSdkFacade['renameSession']>(),
  } satisfies ClaudeSdkFacade;
  const load = vi.fn(async () => sdk);
  return { backend: new ClaudeAgentBackend(load, () => undefined), query, load };
}

describe('Claude session profile reaches SDK query options', () => {
  for (const action of ['start', 'resume'] as const) {
    for (const profile of [undefined, explicit]) {
      it(`${action}: ${profile ? 'explicit' : 'default'} profile`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'vonvon-session-profile-'));
        vi.stubEnv('CLAUDE_CONFIG_DIR', root);
        mkdirSync(join(root, 'projects', '-repo'), { recursive: true });
        writeFileSync(join(root, 'projects', '-repo', 'saved.jsonl'), `${JSON.stringify({
          type: 'user', uuid: 'saved-message', message: { role: 'user', content: 'hello' },
        })}\n`);
        const { backend, query } = claudeFixture();
        const options = { cwd: root, mode: 'full' as const, profile };
        threads.push(action === 'start' ? await backend.startThread(options)
          : await backend.resumeThread({ ...options, sessionId: 'saved' }));
        expect(query).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({
          cwd: root,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: profile
            ? `${BRIDGE_DEVELOPER_INSTRUCTIONS}\n\n${profile.instructions}` : BRIDGE_DEVELOPER_INSTRUCTIONS },
          env: expect.objectContaining({ [SESSION_ENV]: '1', ...profile?.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }),
          settings: expect.objectContaining({ autoCompactEnabled: true, autoMemoryEnabled: false,
            env: expect.objectContaining({ DISABLE_AUTO_COMPACT: '', DISABLE_COMPACT: '', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }) }),
          ...(action === 'resume' ? { resume: 'saved' } : {}),
        }) }));
      });
    }
  }
});

for (const field of ['capabilityPackages', 'mcpServers'] as const) {
  const unsupported: SessionProfile = {
    ...explicit,
    ...(field === 'capabilityPackages' ? { capabilityPackages: [{ path: '/package' }] }
        : { mcpServers: [{ name: 'test' }] }),
  };
  for (const action of ['start', 'resume'] as const) {
    it(`${action}: refuses unsupported ${field} before acquiring either provider`, async () => {
      const options = { cwd: '/repo', mode: 'full' as const, profile: unsupported };
      const codex = new CodexAppServerBackend();
      const claude = claudeFixture();
      for (const backend of [codex, claude.backend]) {
        await expect(action === 'start' ? backend.startThread(options)
          : backend.resumeThread({ ...options, sessionId: 'saved' })).rejects.toThrow('s39');
      }
      expect(rpc.take).not.toHaveBeenCalled();
      expect(rpc.request).not.toHaveBeenCalled();
      expect(claude.load).not.toHaveBeenCalled();
      expect(claude.query).not.toHaveBeenCalled();
    });
  }
}

 it('Codex preserves restricted filesystem and network configuration while applying the profile', async () => {
  vi.spyOn(fullOnly, 'codexConfinesReads').mockReturnValue(true);
  const backend = new CodexAppServerBackend();
  const cwd = mkdtempSync(join(tmpdir(), 'profile-restricted-'));
  writeFileSync(join(cwd, '.mcp.json'), '{}');
  mkdirSync(join(cwd, '.claude/skills'), { recursive: true });
  threads.push(await backend.startThread({ cwd, mode: 'write', network: false, profile: explicit }));
  expect(rpc.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
    config: expect.objectContaining({
      default_permissions: 'feishu',
      permissions: { feishu: {
        filesystem: expect.objectContaining({ ':minimal': 'read', ':workspace_roots': { '.': 'read' },
          [cwd]: expect.objectContaining({ '.': 'write', '.mcp.json': 'read', '.claude/skills': 'read' }),
        }),
        network: { enabled: false },
      } },
      features: { memories: false },
      memories: { use_memories: false, generate_memories: false },
    }),
  }));
});


it('keeps the built-in vonvon_bot name out of unsupported profile MCP configuration', async () => {
  const profile = { ...explicit, mcpServers: [{ name: 'vonvon_bot' }] };
  const claude = claudeFixture();
  for (const backend of [new CodexAppServerBackend(), claude.backend]) {
    await expect(backend.startThread({ cwd: '/fixture', profile })).rejects.toThrow('s39');
    await expect(backend.resumeThread({ cwd: '/fixture', profile, sessionId: 'saved' })).rejects.toThrow('s39');
  }
  expect(claude.load).not.toHaveBeenCalled();
  expect(rpc.take).not.toHaveBeenCalled();
});

for (const action of ['start', 'resume'] as const) it(`Claude ${action} forwards admitted directories and native skill selection`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-profile-directories-')));
  try {
    vi.stubEnv('CLAUDE_CONFIG_DIR', root);
    mkdirSync(join(root, 'projects', '-repo'), { recursive: true });
    writeFileSync(join(root, 'projects', '-repo', 'saved.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'saved-message', message: { role: 'user', content: 'hello' } })}\n`);
    const extra = join(root, 'second'); mkdirSync(extra);
    const { backend, query } = claudeFixture();
    const options = { cwd: root, mode: 'write' as const, profile: { ...explicit, additionalRoots: [{ path: extra, access: 'write' as const }], skills: { disabledPaths: ['claude:disabled'], enabledNames: ['enabled'] } } };
    const thread = action === 'start' ? await backend.startThread(options) : await backend.resumeThread({ ...options, sessionId: 'saved' });
    try {
      const supplied = query.mock.calls[0]?.[0]?.options;
      expect({ directories: supplied?.additionalDirectories, skills: supplied?.skills, filesystem: supplied?.sandbox?.filesystem })
        .toEqual({ directories: [extra], skills: ['enabled'], filesystem: {
          allowWrite: [extra],
          denyWrite: ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json', '.claude/skills',
            '.claude/commands', '.claude/agents', '.codex', '.agents/skills'].map(path => join(root, path)),
        } });
    } finally { await thread.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
