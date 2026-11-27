import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/config/paths';
import { loadConfig, saveConfig } from '../src/config/store';
import { createAppPreferencesWriter } from '../src/admin/ops';
import { createSettingsOwner } from '../src/admin/settings';
import { parseSettingsEdit } from '../src/admin/settings-parse';
import type { AgentSettingsView, ProjectSettingsView, SessionSettingsView, SettingsEdit, SettingsOwnerDeps } from '../src/admin/settings';
import { addProject, getProjectByName, updateProject } from '../src/project/registry';
import { getSession, upsertSession } from '../src/bot/session-store';
import type { AppConfig } from '../src/config/schema';
import { VoiceActionRefused } from '../src/voice/types';
import type { AgentBackend } from '../src/agent/types';
import { defaultCardDisplay } from '@vonvon/protocol';

vi.mock('../src/config/paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-parity-'));
  return { botDir: (id: string) => join(root, 'bots', id), botPaths: (id: string) => ({ dir: join(root, 'bots', id) }), paths: { appDir: root, configFile: join(root, 'config.json'), projectsFile: join(root, 'projects.json'), sessionsFile: join(root, 'sessions.json'), commentInstructionsFile: join(root, 'instructions.md'), commentsRootDir: join(root, 'comments') } };
});

const botId = 'cli_fixture';
const agent = { kind: 'agent' as const, botId };
const project = { kind: 'project' as const, botId, projectName: 'demo' };
const session = { kind: 'session' as const, botId, threadId: 'omt_fixture' };
const backend = { id: 'codex-appserver', doctor: async () => ({ ok: true }), supportedModes: ['qa', 'write', 'full'], listModels: async () => [{ id: 'fixture-model', displayName: 'Fixture', description: '', defaultEffort: 'high', supportedEfforts: ['medium', 'high'], isDefault: true, hidden: false }] } as unknown as AgentBackend;
let cfg: AppConfig;

async function owner(overrides: Partial<SettingsOwnerDeps> = {}) {
  return createSettingsOwner({ cfg, writePreferences: createAppPreferencesWriter({ cfg }), backendFor: () => backend, evictLiveSessionsForChat: vi.fn(async () => {}), ...overrides });
}

beforeEach(async () => {
  await rm(paths.appDir, { recursive: true, force: true });
  await mkdir(paths.appDir, { recursive: true });
  cfg = JSON.parse(JSON.stringify({ accounts: { app: { id: botId, tenant: 'feishu', secret: { source: 'exec', id: 'fixture-secret' } } }, secrets: { providers: { sentinel: { source: 'env', allowlist: ['SECRET'] } } }, futureRoot: 17, preferences: { access: { ownerOpenId: 'ou_owner', admins: ['ou_owner', 'ou_admin'], future: 3 }, cliBridge: { enabled: false, presence: { future: 9 } }, comments: { future: 'retain' }, futurePreference: true } }));
  await saveConfig(cfg);
  await addProject({ name: 'demo', chatId: 'oc_demo', cwd: '/tmp/demo', createdAt: 1, blank: false });
  await addProject({ name: 'other', chatId: 'oc_other', cwd: '/tmp/other', createdAt: 2, blank: false, noMention: false, mode: 'qa', network: false });
  await upsertSession({ threadId: session.threadId, chatId: 'oc_demo', sessionId: 'native-one', backend: 'codex-appserver', cwd: '/tmp/demo', model: 'fixture-model', effort: 'high', createdAt: 1, updatedAt: 1, summary: '' });
});
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

const agentCases = [
  { id: 'CARD-WELCOME-1', section: 'welcome', patch: { title: '研发项目群指南' }, field: 'welcomeCard.title', expected: '研发项目群指南' },
  { id: 'CARD-WELCOME-2', section: 'welcome', patch: { intro: '欢迎加入 **研发项目群**\n有问题直接 @ 我。' }, field: 'welcomeCard.intro', expected: '欢迎加入 **研发项目群**\n有问题直接 @ 我。' },
  { id: 'CARD-019', section: 'access', patch: { allowedChats: ['oc_demo'] }, field: 'access.allowedChats', expected: ['oc_demo'] },
  { id: 'CARD-022', section: 'run', patch: { maxConcurrentRuns: 50 }, field: 'maxConcurrentRuns', expected: 50 },
  { id: 'CARD-023', section: 'run', patch: { runIdleTimeoutSeconds: 3600 }, field: 'runIdleTimeoutSeconds', expected: 3600 },
  { id: 'CARD-024', section: 'run', patch: { pendingPolicy: 'queue' }, field: 'pendingPolicy', expected: 'queue' },
  { id: 'CARD-025', section: 'completion', patch: { mode: 'failures' }, field: 'completionReminder.mode', expected: 'failures' },
  { id: 'CARD-026', section: 'completion', patch: { longTaskMinutes: 1440 }, field: 'completionReminder.longTaskMinutes', expected: 1440 },
  { id: 'CARD-039', section: 'paths', patch: { projectsRootDir: '/tmp/parity-projects' }, field: 'projectsRootDir', expected: '/tmp/parity-projects' },
] as const;

function getField(record: unknown, field: string): unknown {
  return field.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], record);
}

describe('agent settings persist in config.json and preserve unrelated data', () => {
  it.each(agentCases)('$id $field', async ({ section, patch, field, expected }) => {
    const settings = await owner();
    const before = await settings.read(agent) as AgentSettingsView;
    const original = JSON.parse(await readFile(paths.configFile, 'utf8'));
    const result = await settings.save({ scope: agent, section, revision: before.sections[section].revision, patch } as SettingsEdit);
    expect(result.kind).toBe('saved');
    const disk = await loadConfig() as AppConfig & { futureRoot: number };
    expect(getField(disk.preferences, field)).toEqual(expected);
    expect(disk.accounts).toEqual(original.accounts);
    expect(disk.secrets).toEqual(original.secrets);
    expect(disk.futureRoot).toBe(17);
    expect((disk.preferences as Record<string, unknown>).futurePreference).toBe(true);
    expect((disk.preferences as Record<string, unknown>).cliBridge).toEqual({ enabled: false, presence: { future: 9 } }); // 咖啡一下 left it, kept as is
    const after = await settings.read(agent) as AgentSettingsView;
    expect(getField(after.sections[section].stored, field.includes('.') ? field.slice(field.indexOf('.') + 1) : field)).toEqual(expected);
  });
});

it('CARD-WELCOME clears custom copy and exposes the built-in effective copy', async () => {
  const settings = await owner();
  let before = await settings.read(agent) as AgentSettingsView;
  expect(before.sections.welcome.effective).toEqual({
    title: '🤖 本群使用说明',
    intro: '👋 **你的助手来了！~神奇田螺**',
  });
  expect((await settings.save({
    scope: agent,
    section: 'welcome',
    revision: before.sections.welcome.revision,
    patch: { title: '项目指南', intro: '欢迎加入。' },
  })).kind).toBe('saved');
  before = await settings.read(agent) as AgentSettingsView;
  expect((await settings.save({
    scope: agent,
    section: 'welcome',
    revision: before.sections.welcome.revision,
    patch: { title: '', intro: '' },
  })).kind).toBe('saved');
  expect((await loadConfig()).preferences?.welcomeCard).toBeUndefined();
  expect((await settings.read(agent) as AgentSettingsView).sections.welcome.effective).toEqual({
    title: '🤖 本群使用说明',
    intro: '👋 **你的助手来了！~神奇田螺**',
  });
});

it('CARD-WELCOME rejects over-limit copy before writing', async () => {
  const before = await readFile(paths.configFile, 'utf8');
  expect(() => parseSettingsEdit({scope: agent, section: 'welcome', revision: 'revision', patch: {title: 'a'.repeat(81)}})).toThrow();
  expect(() => parseSettingsEdit({scope: agent, section: 'welcome', revision: 'revision', patch: {intro: 'a'.repeat(2001)}})).toThrow();
  expect(await readFile(paths.configFile, 'utf8')).toBe(before);
});

const edgeCases = [
  { id: 'CARD-022', section: 'run', patch: { maxConcurrentRuns: 1 }, field: 'maxConcurrentRuns', expected: 1 },
  { id: 'CARD-023', section: 'run', patch: { runIdleTimeoutSeconds: 0 }, field: 'runIdleTimeoutSeconds', expected: 0 },
  { id: 'CARD-023', section: 'run', patch: { runIdleTimeoutSeconds: 10 }, field: 'runIdleTimeoutSeconds', expected: 10 },
  { id: 'CARD-025', section: 'completion', patch: { mode: 'manual' }, field: 'completionReminder.mode', expected: 'manual' },
  { id: 'CARD-025', section: 'completion', patch: { mode: 'long' }, field: 'completionReminder.mode', expected: 'long' },
  { id: 'CARD-025', section: 'completion', patch: { mode: 'always' }, field: 'completionReminder.mode', expected: 'always' },
  { id: 'CARD-026', section: 'completion', patch: { longTaskMinutes: 1 }, field: 'completionReminder.longTaskMinutes', expected: 1 },
] as const;

it.each(edgeCases)('$id accepts $section boundary $field', async ({ section, patch, field, expected }) => {
  const settings = await owner();
  const before = await settings.read(agent) as AgentSettingsView;
  expect((await settings.save({ scope: agent, section, revision: before.sections[section].revision, patch } as SettingsEdit)).kind).toBe('saved');
  expect(getField((await loadConfig()).preferences, field)).toEqual(expected);
});

const projectCases = [
  { id: 'CARD-010', section: 'response', patch: { noMention: true }, field: 'noMention', expected: true },
  { id: 'CARD-012', section: 'permission', patch: { mode: 'write' }, field: 'mode', expected: 'write' },
  { id: 'CARD-014', section: 'permission', patch: { custom: { sandbox: 'read-only', network: true } }, field: 'network', expected: true },
] as const;

describe('project settings persist in projects.json and isolate group scope', () => {
  it.each(projectCases)('$id $field', async ({ section, patch, field, expected }) => {
    const evict = vi.fn(async () => {});
    const settings = await owner({ evictLiveSessionsForChat: evict });
    const before = await settings.read(project) as ProjectSettingsView;
    const other = await getProjectByName('other');
    const result = await settings.save({ scope: project, section, revision: before.sections[section].revision, patch } as SettingsEdit);
    expect(result.kind).toBe('saved');
    expect(getField(await getProjectByName('demo'), field)).toEqual(expected);
    if (section === 'permission') {
      expect(evict).toHaveBeenCalledOnce();
      expect(evict).toHaveBeenCalledWith('oc_demo');
    }
    else expect(evict).not.toHaveBeenCalled();
    expect(await getProjectByName('other')).toEqual(other);
  });
});

it.each(['qa', 'write', 'full'] as const)('CARD-012 accepts supported %s permission for the group', async mode => {
  const settings = await owner();
  const before = await settings.read(project) as ProjectSettingsView;
  expect((await settings.save({ scope: project, section: 'permission', revision: before.sections.permission.revision, patch: { mode } })).kind).toBe('saved');
  expect(await getProjectByName('demo')).toMatchObject({ mode });
});

it('CARD-013 s15c: 普通成员权限 is gone, a guestMode patch is refused and nothing is written', async () => {
  const settings = await owner();
  await updateProject('demo', { mode: 'write' });
  const before = await settings.read(project) as ProjectSettingsView;
  // Output only, for clients from before s15c: always the group's one tier.
  expect(before.sections.permission.stored).toMatchObject({ mode: 'write', guestMode: 'write', network: false });
  expect(before.sections.permission.effective).toMatchObject({ mode: 'write', guestMode: 'write', network: false });
  const file = await readFile(paths.projectsFile, 'utf8');
  await expect(settings.save({ scope: project, section: 'permission', revision: before.sections.permission.revision, patch: { guestMode: 'qa' } } as unknown as SettingsEdit)).rejects.toThrow('设置字段、类型或范围无效');
  expect(await readFile(paths.projectsFile, 'utf8')).toBe(file);
});

it('CARD-015 CARD-016 validates model and effort before changing the new-session default', async () => {
  const settings = await owner();
  const before = await settings.read(project) as ProjectSettingsView;
  for (const invalid of [{ kind: 'explicit', model: 'missing', effort: 'high' }, { kind: 'explicit', model: 'fixture-model', effort: 'ultra' }]) {
    expect((await settings.save({ scope: project, section: 'model', revision: before.sections.model.revision, patch: { selection: invalid } } as SettingsEdit)).kind).toBe('rejected');
    expect((await getProjectByName('demo'))?.defaultModel).toBeUndefined();
  }
  expect((await settings.save({ scope: project, section: 'model', revision: before.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'fixture-model', effort: 'medium' } } })).kind).toBe('saved');
  expect(await getProjectByName('demo')).toMatchObject({ defaultModel: 'fixture-model', defaultEffort: 'medium' });
  expect((await getSession(session.threadId))?.effort).toBe('high');
});

it('CARD-017 CARD-018 handles members, audience and immutable owner with persisted revisions', async () => {
  const settings = await owner();
  let p = await settings.read(project) as ProjectSettingsView;
  expect((await settings.act({ kind: 'projectMember', botId, projectName: 'demo', openId: 'ou_member', membership: 'present', revision: p.members.revision })).kind).toBe('saved');
  p = await settings.read(project) as ProjectSettingsView;
  expect(p.members.openIds).toEqual(['ou_member']);
  expect((await settings.act({ kind: 'projectAudience', botId, projectName: 'demo', audience: 'all', revision: p.members.revision })).kind).toBe('saved');
  expect((await getProjectByName('demo'))?.allowedUsers).toEqual([]);
  let a = await settings.read(agent) as AgentSettingsView;
  expect((await settings.act({ kind: 'adminMember', botId, openId: 'ou_test', membership: 'present', revision: a.administrators.revision })).kind).toBe('saved');
  a = await settings.read(agent) as AgentSettingsView;
  expect(a.administrators.openIds).toContain('ou_test');
  expect((await loadConfig()).preferences?.access?.admins).toContain('ou_test');
  expect(a.ownerOpenId).toBe('ou_owner');
});

it('CARD-022 CARD-023 CARD-026 rejects out-of-range values without writing', async () => {
  const invalid = [
    ['run', { maxConcurrentRuns: 0 }], ['run', { maxConcurrentRuns: 51 }], ['run', { maxConcurrentRuns: 1.5 }],
    ['run', { runIdleTimeoutSeconds: 9 }], ['run', { runIdleTimeoutSeconds: 3601 }],
    ['completion', { longTaskMinutes: 0 }], ['completion', { longTaskMinutes: 1441 }],
  ] as const;
  const before = await readFile(paths.configFile, 'utf8');
  for (const [section, patch] of invalid) {
    expect(() => parseSettingsEdit({ scope: agent, section, revision: 'revision', patch })).toThrow();
  }
  expect(await readFile(paths.configFile, 'utf8')).toBe(before);
});

it('CARD-027 dispatches voice actions', async () => {
  const voiceAction = vi.fn(async () => {});
  const settings = await owner({ voiceAction });
  for (const action of ['enable', 'test', 'refreshPermission', 'disable'] as const) {
    expect((await settings.act({ kind: 'voice', botId, action: { action } })).kind).toBe('saved');
  }
  expect(voiceAction.mock.calls.map(call => (call as unknown as [{ action: string }])[0].action)).toEqual(['enable', 'test', 'refreshPermission', 'disable']);
});

// Linux 验收 296: 没开语音就点检测，页面只说"保存失败，请刷新设置后重试"，看不出要先开语音
it('CARD-027 shows a voice refusal as it is, and keeps the generic message for other failures', async () => {
  const refused = await owner({ voiceAction: vi.fn(async () => { throw new VoiceActionRefused('请先开启语音转文字，再测试'); }) });
  expect(await refused.act({ kind: 'voice', botId, action: { action: 'test' } })).toEqual({ kind: 'rejected', fields: [{ field: 'settings', message: '请先开启语音转文字，再测试' }] });
  const broken = await owner({ voiceAction: vi.fn(async () => { throw new Error('EACCES: config.json'); }) });
  const result = await broken.act({ kind: 'voice', botId, action: { action: 'enable' } });
  expect(result).toMatchObject({ kind: 'rejected', fields: [{ field: 'settings' }] });
  expect(JSON.stringify(result)).not.toContain('EACCES');
});

it('CARD-036 CARD-038 CARD-040 keeps comment, title and current-session model choices separate', async () => {
  const settings = await owner();
  let a = await settings.read(agent) as AgentSettingsView;
  expect((await settings.save({ scope: agent, section: 'comments', revision: a.sections.comments.revision, patch: { backend: 'codex-appserver', selection: { kind: 'explicit', model: 'fixture-model', effort: 'medium' } } })).kind).toBe('saved');
  a = await settings.read(agent) as AgentSettingsView;
  expect((await settings.save({ scope: agent, section: 'titles', revision: a.sections.titles.revision, patch: { byBackend: { 'codex-appserver': { enabled: true, model: 'title-custom', effort: 'medium' } } } })).kind).toBe('saved');
  let s = await settings.read(session) as SessionSettingsView;
  expect((await settings.save({ scope: session, section: 'model', revision: s.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'fixture-model', effort: 'medium' } } })).kind).toBe('saved');
  s = await settings.read(session) as SessionSettingsView;
  expect(s.sections.model.stored.selection).toEqual({ kind: 'explicit', model: 'fixture-model', effort: 'medium' });
  expect(await getSession(session.threadId)).toMatchObject({ model: 'fixture-model', effort: 'medium' });
  const disk = await loadConfig();
  expect(disk.preferences?.comments).toMatchObject({ backend: 'codex-appserver', model: 'fixture-model', effort: 'medium', future: 'retain' });
  expect(disk.preferences?.sessionTitles?.policy).toMatchObject({ enabled: true, model: 'title-custom', effort: 'medium' });
  expect((await getProjectByName('demo'))?.defaultModel).toBeUndefined();
});

it('CARD-037 persists comment instructions, syncs directory and resets the default', async () => {
  const directory = join(paths.commentsRootDir, 'comment-docx-healthy');
  await mkdir(directory, { recursive: true });
  const settings = await owner();
  let a = await settings.read(agent) as AgentSettingsView;
  expect((await settings.act({ kind: 'commentInstructions', botId, revision: a.commentInstructions.revision, content: { kind: 'custom', text: 'Review {fileToken}' } })).kind).toBe('saved');
  expect(await readFile(paths.commentInstructionsFile, 'utf8')).toBe('Review {fileToken}');
  expect(await readFile(join(directory, 'AGENTS.md'), 'utf8')).toBe('Review healthy');
  a = await settings.read(agent) as AgentSettingsView;
  expect((await settings.act({ kind: 'commentInstructions', botId, revision: a.commentInstructions.revision, content: { kind: 'default' } })).kind).toBe('saved');
  expect((await settings.read(agent) as AgentSettingsView).commentInstructions.content.kind).toBe('default');
});

it('CARD-057 detects stale per-chat card edits; CARD-058 rejects stopped edits', async () => {
  const settings = await owner();
  const p = await settings.read(project) as ProjectSettingsView;
  const display = defaultCardDisplay();
  expect((await settings.save({ scope: project, section: 'presentation', revision: p.sections.presentation!.revision, patch: { cardDisplay: display } })).kind).toBe('saved');
  expect((await settings.save({ scope: project, section: 'presentation', revision: p.sections.presentation!.revision, patch: { cardDisplay: null } })).kind).toBe('conflict');
  const stopped = await owner({ access: { kind: 'readonly', reason: 'owner-offline', message: 'stopped' } });
  const snapshot = await stopped.read(project) as ProjectSettingsView;
  expect(snapshot.sections.presentation!.access.kind).toBe('readonly');
  expect((await stopped.save({ scope: project, section: 'presentation', revision: snapshot.sections.presentation!.revision, patch: { cardDisplay: null } })).kind).toBe('unavailable');
  expect((await getProjectByName('demo'))?.presentation?.cardDisplay).toEqual(display);
});
