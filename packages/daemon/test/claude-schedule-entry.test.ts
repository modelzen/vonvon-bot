import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSdkMcpServer, tool, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { claudeAccess, permissionOptions } from '../src/agent/claude-agent/permission';
import type { FeishuReader } from '../src/feishu-read/reader';
import { createFeishuTools } from '../src/agent/entry/feishu-tools';
import { createAgentEntries, type AgentPlace } from '../src/agent/entry/registry';
import { createScheduleTools } from '../src/agent/entry/schedule-tools';
import { sessionInfoTool } from '../src/agent/entry/tools';
import { groupSkillProfile } from '../src/agent/group-skills';
import type { AgentBackend, AgentThread, PermissionMode } from '../src/agent/types';
import type { SessionProfile } from '../src/agent/session-profile';

// T3 4.3 on the locked SDK (0.3.296) with a fake transport: the schedule tools in vonvon_bot only where the profile
// says so, and Claude Code's own scheduling off in every tier.
const NATIVE = ['CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup', 'RemoteTrigger'];
const threads: AgentThread[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(threads.splice(0).map(t => t.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function fixture() {
  let options: Options | undefined;
  const registered: string[] = [];
  let end: (() => void) | undefined;
  const query = vi.fn<ClaudeSdkFacade['query']>(params => {
    options = params.options;
    return Object.assign((async function* (): AsyncGenerator<SDKMessage> { await new Promise<void>(resolve => { end = resolve; }); })(),
      { close: () => end?.(), interrupt: async () => {} }) as unknown as Query;
  });
  const makeTool: typeof tool = (name, ...rest) => { registered.push(name); return tool(name, ...rest); };
  const sdk = { query, listSessions: vi.fn(), getSessionInfo: vi.fn(), getSessionMessages: vi.fn(), renameSession: vi.fn(), createSdkMcpServer, tool: makeTool } satisfies ClaudeSdkFacade;
  return { registered, backend: new ClaudeAgentBackend(async () => sdk, () => undefined), options: () => options };
}
const profile = (schedule: boolean, feishu?: boolean, feishuEdit?: boolean): SessionProfile => ({ instructions: '', env: {}, nativeSettings: { automaticMemory: false },
  additionalRoots: [], capabilityPackages: [], mcpServers: [], tools: { schedule, ...(feishu !== undefined ? { feishu } : {}), ...(feishuEdit !== undefined ? { feishuEdit } : {}) } });
const grant = (place: AgentPlace) => createAgentEntries({ appId: 'fixture', isAdmin: () => true,
  tools: [sessionInfoTool, ...createScheduleTools({ commands: { execute: async () => ({ kind: 'deleted', taskId: 'x' }) } })] }).issue(place);
function savedSession(): string {
  const root = mkdtempSync(join(tmpdir(), 't3-claude-')); roots.push(root);
  vi.stubEnv('CLAUDE_CONFIG_DIR', root);
  mkdirSync(join(root, 'projects', '-fixture'), { recursive: true });
  writeFileSync(join(root, 'projects', '-fixture', 'saved.jsonl'), JSON.stringify({ type: 'user', uuid: 'm', message: { role: 'user', content: 'fixture' } }) + '\n');
  return root;
}

it.each([
  ['a group, schedule on', { kind: 'group', chatId: 'oc_group' }, true, 7],
  ['a group, schedule off', { kind: 'group', chatId: 'oc_group' }, false, 0],
  ['a private chat, schedule on', { kind: 'p2p', chatId: 'oc_dm' }, true, 7],
  ['a private chat, schedule off', { kind: 'p2p', chatId: 'oc_dm' }, false, 0],
] as const)('lists the schedule tools in vonvon_bot for %s', async (_case, place, schedule, count) => {
  for (const action of ['start', 'resume'] as const) {
    const f = fixture(), entry = grant(place), cwd = savedSession();
    threads.push(action === 'start' ? await f.backend.startThread({ cwd, mode: 'qa', entry, profile: profile(schedule) })
      : await f.backend.resumeThread({ cwd, mode: 'qa', entry, sessionId: 'saved', profile: profile(schedule) }));
    expect(f.registered.filter(name => name.startsWith('schedule_'))).toHaveLength(count);
    expect(f.registered).toContain('session_info');
  }
});

it.each([[true, 1], [false, 0]] as const)('lists the Feishu read tools in vonvon_bot by the profile (tools.feishu %j)', async (feishu, count) => {
  for (const action of ['start', 'resume'] as const) {
    const f = fixture(), cwd = savedSession();
    const entry = createAgentEntries({ appId: 'fixture', isAdmin: () => true,
      tools: createFeishuTools({ members: async () => ({ members: [] }), feishu: {} as FeishuReader }) }).issue({ kind: 'group', chatId: 'oc_group' });
    threads.push(action === 'start' ? await f.backend.startThread({ cwd, mode: 'qa', entry, profile: profile(false, feishu) })
      : await f.backend.resumeThread({ cwd, mode: 'qa', entry, sessionId: 'saved', profile: profile(false, feishu) }));
    expect(f.registered.filter(name => name === 'feishu_doc')).toHaveLength(count);
    expect(f.registered.filter(name => name === 'feishu_members')).toHaveLength(1);
  }
});

it.each([[true, 1], [false, 0]] as const)('lists feishu_doc_edit by the profile (tools.feishuEdit %j), and a comment\'s session only the document column', async (edit, count) => {
  for (const action of ['start', 'resume'] as const) {
    const f = fixture(), cwd = savedSession();
    const entry = createAgentEntries({ appId: 'fixture', isAdmin: () => true,
      tools: createFeishuTools({ members: async () => ({ members: [] }), feishu: {} as FeishuReader }) }).issue({ kind: 'doc', docId: 'd' });
    threads.push(action === 'start' ? await f.backend.startThread({ cwd, mode: 'qa', entry, profile: profile(false, true, edit) })
      : await f.backend.resumeThread({ cwd, mode: 'qa', entry, sessionId: 'saved', profile: profile(false, true, edit) }));
    expect(f.registered.filter(name => name === 'feishu_doc_edit')).toHaveLength(count);
    expect(f.registered.filter(name => name === 'feishu_doc')).toHaveLength(1);
    expect(f.registered.filter(name => name === 'feishu_messages' || name === 'feishu_members')).toEqual([]);
  }
});

it.each([[true, 1], [false, 0]] as const)('lists feishu_api in a private chat by the profile (tools.feishuApi %j)', async (api, count) => {
  for (const action of ['start', 'resume'] as const) {
    const f = fixture(), cwd = savedSession();
    const entry = createAgentEntries({ appId: 'fixture', isAdmin: () => true,
      tools: createFeishuTools({ members: async () => ({ members: [] }), feishu: {} as FeishuReader }) }).issue({ kind: 'p2p', chatId: 'oc_dm' });
    const tools = { ...profile(false, true), tools: { schedule: false, feishu: true, ...(api ? { feishuApi: true } : {}) } };
    threads.push(action === 'start' ? await f.backend.startThread({ cwd, mode: 'full', entry, profile: tools })
      : await f.backend.resumeThread({ cwd, mode: 'full', entry, sessionId: 'saved', profile: tools }));
    expect(f.registered.filter(name => name === 'feishu_api')).toHaveLength(count);
  }
});

it('does not list feishu_api in a group, whatever the profile says', async () => {
  const f = fixture(), cwd = savedSession();
  const entry = createAgentEntries({ appId: 'fixture', isAdmin: () => true,
    tools: createFeishuTools({ members: async () => ({ members: [] }), feishu: {} as FeishuReader }) }).issue({ kind: 'group', chatId: 'oc_group' });
  threads.push(await f.backend.startThread({ cwd, mode: 'full', entry, profile: { ...profile(false, true), tools: { schedule: false, feishu: true, feishuApi: true } } }));
  expect(f.registered).not.toContain('feishu_api');
});

it.each([['qa', undefined], ['write', undefined], ['full', undefined], ['qa', { permissionMode: 'plan' }]] as const)(
  'turns Claude Code\'s own scheduling off in the %s tier (native %j)', async (mode: PermissionMode, native) => {
    const f = fixture();
    threads.push(await f.backend.startThread({ cwd: '/fixture', mode, native, entry: grant({ kind: 'group', chatId: 'oc_group' }), profile: profile(true) }));
    const tier = permissionOptions(claudeAccess(mode, false, '/fixture', '/fixture', [], native)).disallowedTools ?? [];
    expect(f.options()?.disallowedTools).toEqual([...tier, ...NATIVE]);
    // The tier's own denials are kept; full access has none and returns early in permission.ts, the five still come.
    if (mode !== 'full') expect(tier.length).toBeGreaterThan(0);
    // CLAUDE_CODE_DISABLE_CRON in the flag-layer settings too: a settings file's `env` overrides the child env.
    expect(f.options()?.settings).toMatchObject({ skillOverrides: { loop: 'off', schedule: 'off' }, autoMemoryEnabled: false, env: { CLAUDE_CODE_DISABLE_CRON: '1' } });
    expect(f.options()?.env).toMatchObject({ CLAUDE_CODE_DISABLE_CRON: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
  });

it('keeps loop and schedule off a group\'s skill whitelist', async () => {
  const skills = ['a', 'b', 'loop', 'schedule'].map(name => ({ path: `claude:${name}`, name, description: name, source: 'provider' as const, enabled: true }));
  const backend = { id: 'claude-agent', listSkills: async () => skills } as unknown as AgentBackend;
  expect(await groupSkillProfile({ backend, cwd: '/work', disabledPaths: ['claude:a'] })).toEqual({ disabledPaths: ['claude:a'], enabledNames: ['b'] });
});
