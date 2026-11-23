import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend } from '../src/agent/types';
import { discoverGroupSkills, discoverLocalGroupSkills, groupSkillProfile } from '../src/agent/group-skills';
import { codexSessionParams } from '../src/agent/codex-appserver/backend';
import { claudeAccess, decide, permissionOptions } from '../src/agent/claude-agent/permission';
import { presentationConfig } from '../src/bot/group-presentation';
import { createVoiceService } from '../src/voice/service';
import type { AppConfig } from '../src/config/schema';
import { ClaudeAgentThread } from '../src/agent/claude-agent/thread';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { renderJudgeInput } from '../src/judge/prompt';
import { decisionBody } from '../src/judge/decision';

const skills = [{ path: 'claude:a', name: 'a', description: 'A', source: 'workspace' as const, enabled: true }, { path: 'claude:plugin:b', name: 'plugin:b', description: 'B', source: 'provider' as const, enabled: true }];
const backend = { id: 'claude-agent', listSkills: vi.fn(async () => skills) } as unknown as AgentBackend;
describe('native group capabilities', () => {
  it('filters one group without mutating native/global discovery', async () => {
    expect((await discoverGroupSkills({ backend, cwd: '/work', disabledPaths: ['claude:a'] })).map(skill => skill.enabled)).toEqual([false, true]);
    expect((await discoverGroupSkills({ backend, cwd: '/work' })).map(skill => skill.enabled)).toEqual([true, true]);
    expect(await groupSkillProfile({ backend, cwd: '/work', disabledPaths: ['claude:a'] })).toEqual({ disabledPaths: ['claude:a'], enabledNames: ['plugin:b'] });
    expect(await groupSkillProfile({ backend, cwd: '/work' })).toBeUndefined();
  });
  it('passes disabled Codex paths in session config, never a global config write', () => {
    const parameters = codexSessionParams({ cwd: '/work', mode: 'full', profile: { instructions: '', env: {}, nativeSettings: { automaticMemory: false }, additionalRoots: [], capabilityPackages: [], mcpServers: [], skills: { disabledPaths: ['/work/.agents/skills/a/SKILL.md'] } } });
    expect(parameters).toMatchObject({ config: { skills: { config: [{ path: '/work/.agents/skills/a/SKILL.md', enabled: false }] } } });
    expect(codexSessionParams({ cwd: '/other', mode: 'full' })).not.toHaveProperty('config.skills');
  });
  it('enforces Claude writes across all admitted directories and read-only roots', async () => {
    const access = claudeAccess('write', false, '/main', '/main', [{ path: '/second', access: 'write' }, { path: '/reference', access: 'read' }]);
    expect(permissionOptions(access)).toMatchObject({ sandbox: { filesystem: { allowWrite: ['/second'], denyWrite: expect.arrayContaining(['/reference']) } } });
    const inodes = new Map<string, number>();
    const fs = { realpath: async (p: string) => p, stat: async (p: string) => {
      if (!inodes.has(p)) inodes.set(p, inodes.size + 1);
      return { dev: 1, ino: inodes.get(p)! };
    }, lstat: async () => ({}) };
    const write = (path: string) => decide(access, { toolName: 'Write', input: { file_path: path }, extra: {} }, 'hook', fs);
    expect(await write('/second/a')).toEqual({ kind: 'continue' });
    expect(await write('/reference/a')).toMatchObject({ kind: 'deny' });
    expect(await write('/outside/a')).toMatchObject({ kind: 'deny' });
  });
});

it('keeps group presentation and voice enablement independent from Bot preferences', async () => {
  const cfg: AppConfig = { accounts: { app: { id: 'bot', secret: 'fake', tenant: 'feishu' } }, preferences: { voice: { enabled: false }, showToolCalls: true } };
  const group = { presentation: { voiceEnabled: true, showToolCalls: false, completionMode: 'manual' as const, longTaskMinutes: 9, showModel: 'off' as const } };
  expect(presentationConfig(cfg, group).preferences).toMatchObject({ showToolCalls: true, showModel: 'running', voice: { enabled: true }, completionReminder: { mode: 'manual', longTaskMinutes: 9 } });
  expect(cfg.preferences).toMatchObject({ showToolCalls: true, voice: { enabled: false } });
  const feishu = { checkPermission: vi.fn(async () => {}), recognize: vi.fn(async () => 'voice text') };
  const voice = createVoiceService(cfg, async update => { cfg.preferences ??= {}; await update(cfg.preferences); return cfg.preferences; }, { feishu, decode: async () => Buffer.alloc(4) });
  expect(await voice.transcribe(Buffer.alloc(4), 10, true)).toMatchObject({ text: 'voice text' });
  expect(await voice.transcribe(Buffer.alloc(4), 10, false)).toMatchObject({ reason: '语音转文字未启用' });
  expect(cfg.preferences?.voice?.enabled).toBe(false);
});

it('delivers decision memory with its own budget even when personality is long', () => {
  const request = { variant: 'main' as const, botName: 'bot', group: { chatId: 'g', name: 'Group' }, persona: 'a'.repeat(2000), memory: 'INDEPENDENT_MEMORY', context: [], message: { at: 1, from: 'user' as const, name: 'user', text: 'question' } };
  expect(renderJudgeInput(request)).toContain('INDEPENDENT_MEMORY');
  expect(decisionBody(request, 'rules', 'model').state).toMatchObject({ background_memory: 'INDEPENDENT_MEMORY' });
});


it('delivers Claude native skill allowlist and all workspace roots to its actual SDK options', async () => {
  let options: Options | undefined;
  let end: (() => void) | undefined;
  const access = claudeAccess('write', false, '/main', '/main', [{ path: '/second', access: 'write' }]);
  const thread = new ClaudeAgentThread({ sessionId: 'test', resume: false, cwd: '/main', access,
    permission: permissionOptions(access), skills: ['plugin:b'], additionalDirectories: ['/second'],
    query: input => {
      options = input.options;
      return Object.assign((async function* (): AsyncGenerator<SDKMessage> { await new Promise<void>(resolve => { end = resolve; }); })(),
        { interrupt: async () => {}, close: () => end?.(), getContextUsage: async () => null }) as unknown as Query;
    },
  });
  expect(options).toMatchObject({ skills: ['plugin:b'], additionalDirectories: ['/second'], sandbox: { filesystem: { allowWrite: ['/second'] } } });
  await thread.close();
});

it('reads a stopped Bot local skill inventory without starting a provider or changing native config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-local-skills-'));
  try {
    const home = join(root, 'home'); const workspace = join(root, 'work');
    const skill = join(workspace, '.agents', 'skills', 'report', 'SKILL.md');
    await mkdir(join(workspace, '.agents', 'skills', 'report'), { recursive: true });
    await writeFile(skill, '---\nname: report\ndescription: >\n  Write reports\n---\nSkill body');
    await mkdir(join(home, '.codex'), { recursive: true });
    const config = `[[skills.config]]\npath = ${JSON.stringify(skill)}\nenabled = false\n`;
    await writeFile(join(home, '.codex', 'config.toml'), config);
    const found = await discoverLocalGroupSkills({ backendId: 'codex-appserver', cwd: workspace, home, env: {} });
    expect(found).toMatchObject([{ name: 'report', description: 'Write reports', source: 'workspace', enabled: false }]);
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe(config);
    await mkdir(join(workspace, '.claude', 'commands', 'reports'), { recursive: true });
    await writeFile(join(workspace, '.claude', 'commands', 'reports', 'weekly.md'), '---\ndescription: Weekly report\n---\nHelp with reports');
    expect(await discoverLocalGroupSkills({ backendId: 'claude-agent', cwd: workspace, home, env: {}, disabledPaths: ['claude:reports:weekly'] }))
      .toEqual([{ path: 'claude:reports:weekly', name: 'reports:weekly', description: 'Weekly report', source: 'workspace', enabled: false }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('classifies Claude native project and user skills without adding files the provider did not load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-claude-skill-sources-'));
  try {
    const home = join(root, 'home'), cwd = join(root, 'project');
    for (const [base, name] of [[join(home, '.claude'), 'global'], [join(cwd, '.claude'), 'project'], [join(cwd, '.claude'), 'unloaded']]) {
      const dir = join(base!, 'skills', name!); await mkdir(dir, {recursive: true});
      await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: actual ${name}\n---\n`);
    }
    const native: AgentBackend['listSkills'] = async () => ['global', 'project', 'plugin:one'].map(name => ({
      name, path: `claude:${name}`, description: name, enabled: true, source: 'provider',
    }));
    const found = await discoverGroupSkills({backend: {...backend, listSkills: native}, cwd, home, env: {}});
    expect(found.map(({name, source}) => ({name, source}))).toEqual([
      {name: 'global', source: 'user'}, {name: 'project', source: 'workspace'}, {name: 'plugin:one', source: 'provider'},
    ]);
    expect(found.some(skill => skill.name === 'unloaded')).toBe(false);
  } finally { await rm(root, {recursive: true, force: true}); }
});
