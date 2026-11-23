import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSdkMcpServer, tool, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { AUTO_COMPACT_SETTINGS } from '../src/agent/claude-agent/thread';
import { log } from '../src/core/logger';
import type { AgentThread, PermissionMode } from '../src/agent/types';
import type { SessionProfile } from '../src/agent/session-profile';

// T4b 4.2 on the locked SDK (0.3.296) with a fake transport: the builtin package goes in as a local plugin, is
// switched on in the flag settings and joins a group's skill whitelist, in every tier and only where it was handed over.
const PACKAGE = '/data/bots/fixture/capabilities/builtin/group';
const threads: AgentThread[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(threads.splice(0).map(t => t.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function fixture(init?: SDKMessage) {
  let options: Options | undefined;
  let end: (() => void) | undefined;
  const query = vi.fn<ClaudeSdkFacade['query']>(params => {
    options = params.options;
    return Object.assign((async function* (): AsyncGenerator<SDKMessage> {
      if (init) yield init;
      await new Promise<void>(resolve => { end = resolve; });
    })(), { close: () => end?.(), interrupt: async () => {} }) as unknown as Query;
  });
  const sdk = { query, listSessions: vi.fn(), getSessionInfo: vi.fn(), getSessionMessages: vi.fn(), renameSession: vi.fn(), createSdkMcpServer, tool } satisfies ClaudeSdkFacade;
  return { backend: new ClaudeAgentBackend(async () => sdk, () => undefined), options: () => options };
}
// What profileOf hands over: the package exactly when the schedule tools are on.
const profile = (schedule: boolean, enabledNames?: string[]): SessionProfile => ({ instructions: '', env: {}, nativeSettings: { automaticMemory: false },
  additionalRoots: [], capabilityPackages: schedule ? [{ path: PACKAGE, kind: 'builtin' }] : [], mcpServers: [], tools: { schedule },
  ...(enabledNames ? { skills: { disabledPaths: ['claude:off'], enabledNames } } : {}) });
function savedSession(): string {
  const root = mkdtempSync(join(tmpdir(), 't4b-claude-')); roots.push(root);
  vi.stubEnv('CLAUDE_CONFIG_DIR', root);
  mkdirSync(join(root, 'projects', '-fixture'), { recursive: true });
  writeFileSync(join(root, 'projects', '-fixture', 'saved.jsonl'), JSON.stringify({ type: 'user', uuid: 'm', message: { role: 'user', content: 'fixture' } }) + '\n');
  return root;
}
async function open(f: ReturnType<typeof fixture>, action: 'start' | 'resume', p: SessionProfile, mode: PermissionMode = 'qa', native?: { permissionMode: 'plan' }) {
  const cwd = action === 'resume' ? savedSession() : '/fixture';
  threads.push(action === 'start' ? await f.backend.startThread({ cwd, mode, native, profile: p })
    : await f.backend.resumeThread({ cwd, mode, native, sessionId: 'saved', profile: p }));
  return f.options()!;
}

it.each([['qa', undefined], ['write', undefined], ['full', undefined], ['qa', { permissionMode: 'plan' }]] as const)(
  'loads the package as the vonvon plugin in the %s tier (native %j)', async (mode, native) => {
    for (const action of ['start', 'resume'] as const) {
      const options = await open(fixture(), action, profile(true, ['own-skill']), mode, native);
      expect(options.plugins).toEqual([{ type: 'local', path: PACKAGE, skipMcpDiscovery: true }]);
      expect(options.settings).toMatchObject({ ...AUTO_COMPACT_SETTINGS, enabledPlugins: { 'vonvon@inline': true } });
      if (native) expect(options.settings).toHaveProperty('plansDirectory');
      expect(options.skills).toEqual(['own-skill', 'vonvon:vonvon-schedule', 'vonvon:vonvon-feishu', 'vonvon:vonvon-config', 'vonvon:vonvon-recipe']);
    }
  });

it.each(['qa', 'write', 'full'] as const)('hands over none of it without the package in the %s tier', async mode => {
  for (const action of ['start', 'resume'] as const) {
    const options = await open(fixture(), action, profile(false, ['own-skill']), mode);
    expect(options).not.toHaveProperty('plugins');
    expect(options.settings).not.toHaveProperty('enabledPlugins');
    expect(options.settings).toEqual(AUTO_COMPACT_SETTINGS);
    expect(options.skills).toEqual(['own-skill']);
  }
});

// dm-agent 9: the launcher's directory is on the Bot's own PATH, which the Claude process inherits.
it.each(['start', 'resume'] as const)('hands a session\'s VONVON_CLI and the Bot\'s PATH to the Claude process on %s', async action => {
  const env = { VONVON_CLI: '/data/bin/vonvon' };
  const options = await open(fixture(), action, { ...profile(true), env }, 'full');
  expect(options.env).toMatchObject({ ...env, PATH: process.env.PATH, CLAUDE_CODE_DISABLE_CRON: '1', FEISHU_CODEX_BRIDGE: '1' });
});

it('adds no whitelist where the group has none, so every skill stays listed', async () => {
  const options = await open(fixture(), 'start', profile(true));
  expect(options.plugins).toHaveLength(1);
  expect(options).not.toHaveProperty('skills');
});

it('logs when the CLI reports it did not load the plugin, and only then', async () => {
  const init = (plugins: { name: string; path: string }[]) => ({ type: 'system', subtype: 'init', plugins, skills: [] }) as unknown as SDKMessage;
  const warn = vi.spyOn(log, 'warn');
  await open(fixture(init([{ name: 'vonvon', path: PACKAGE }])), 'start', profile(true));
  await open(fixture(init([])), 'start', profile(false));
  await open(fixture(init([{ name: 'other', path: '/other' }])), 'start', profile(true));
  const missing = () => warn.mock.calls.filter(([, event]) => event === 'builtin-plugin-missing');
  await vi.waitFor(() => expect(missing()).toHaveLength(1));
  expect(missing()[0]![2]).toMatchObject({ loaded: 'other' });
});
