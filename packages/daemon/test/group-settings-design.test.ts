import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentViewSchema, projectViewSchema, DEFAULT_SMART_RULES } from '@vonvon/protocol';
import { DEFAULT_SMART_PROMPT, LEGACY_DEFAULT_SMART_PROMPT } from '../src/judge/prompt';
import { composeSmartRules } from '../src/judge/smart-file';
import { botPaths, paths } from '../src/config/paths';
import { saveConfig } from '../src/config/store';
import { createSettingsOwner, materializeGroupSettings, type SettingsOwnerDeps } from '../src/admin/settings';
import { createSettingsService } from '../src/admin/settings-service';
import { createAppPreferencesWriter } from '../src/admin/ops';
import { addProject, getProjectByName, mutateProject, type Project } from '../src/project/registry';
import { upsertSession } from '../src/bot/session-store';
import { projectModelAllowed, projectModelCatalog } from '../src/config/execution';
import type { AppConfig } from '../src/config/schema';
import type { AgentBackend, ModelInfo } from '../src/agent/types';
import type { AgentSettingsView, ProjectSettingsView, SessionSettingsView } from '../src/admin/settings-types';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'group-settings-design-'));
  const dir = join(appDir, 'bots', 'cli_fixture');
  const files = { dir, configFile: join(dir, 'config.json'), projectsFile: join(dir, 'projects.json'), sessionsFile: join(dir, 'sessions.json'), processesFile: join(dir, 'processes.json'), commentInstructionsFile: join(dir, 'comment-instructions.md'), commentsRootDir: join(dir, 'comments') };
  return { botDir: () => dir, botPaths: () => files, paths: { ...files, appDir, projectsRootDir: join(appDir, 'projects'), botsFile: join(appDir, 'bots.json') } };
});
const botId = 'cli_fixture';
const scope = { kind: 'project' as const, botId, projectName: 'demo' };
const agent = { kind: 'agent' as const, botId };
const models: ModelInfo[] = [
  { id: 'a', displayName: 'A', description: '', supportedEfforts: ['low', 'high'], defaultEffort: 'low', isDefault: true, hidden: false },
  { id: 'b', displayName: 'B', description: '', supportedEfforts: ['high'], defaultEffort: 'high', isDefault: false, hidden: false },
  { id: 'flat', displayName: 'Flat', description: '', supportedEfforts: [], defaultEffort: 'medium', isDefault: false, hidden: false },
];
const backend = { id: 'codex-appserver', doctor: vi.fn(async () => ({ ok: true })), listModels: vi.fn(async () => models), peekModels: () => models, supportedModes: ['qa', 'write', 'full'] } as unknown as AgentBackend;
let cfg: AppConfig;
const oldSmart = '旧 SMART 全文\n保留响应条件、例外与格式说明';
const deps = (): SettingsOwnerDeps => ({ cfg, writePreferences: createAppPreferencesWriter({ cfg }), backendFor: () => backend, evictLiveSessionsForChat: vi.fn(async () => {}), readSmartPrompt: async () => ({ source: 'bot', path: '/fixture/SMART.md', text: oldSmart }), discoverSkills: async () => [], getSecret: async () => undefined });
const view = (owner: ReturnType<typeof createSettingsOwner>) => owner.read(scope) as Promise<ProjectSettingsView>;
beforeEach(async () => {
  await rm(paths.appDir, { recursive: true, force: true });
  await mkdir(botPaths(botId).dir, { recursive: true });
  vi.stubEnv('HOME', paths.appDir);
  vi.stubEnv('CODEX_HOME', join(paths.appDir, 'native-codex'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(paths.appDir, 'native-claude'));
  cfg = { accounts: { app: { id: botId, tenant: 'feishu', secret: { source: 'env', id: 'FIXTURE_SECRET' } } }, preferences: {} } as AppConfig;
  await saveConfig(cfg);
  await writeFile(paths.botsFile, JSON.stringify({ version: 1, bots: [{ appId: botId, name: 'fixture', tenant: 'feishu', createdAt: 1, active: false }] }));
  await addProject({ name: 'demo', chatId: 'oc_demo', cwd: '/fixture/work', createdAt: 1, blank: false });
});
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

it('stores independent profile fields, keeps inherited text live and conflicts on concurrent edits', async () => {
  const owner = createSettingsOwner(deps());
  let a = await owner.read(agent) as AgentSettingsView;
  expect((await owner.save({ scope: agent, section: 'role', revision: a.sections.role!.revision, patch: { identity: '公共个性' } })).kind).toBe('saved');
  a = await owner.read(agent) as AgentSettingsView;
  expect((await owner.save({ scope: agent, section: 'profile', revision: a.sections.profile!.revision, patch: { memory: '公共记忆' } })).kind).toBe('saved');
  let p = await view(owner);
  expect(projectViewSchema.safeParse(p).success).toBe(true);
  const replies = await Promise.all(['本群一', '本群二'].map(persona => owner.save({ scope, section: 'profile', revision: p.sections.profile!.revision, patch: { persona, memory: '本群记忆', inheritPersona: false, inheritMemory: true } })));
  expect(replies.map(x => x.kind).sort()).toEqual(['conflict', 'saved']);
  const winningPersona = replies[0]!.kind === 'saved' ? '本群一' : '本群二';
  p = await view(owner);
  expect(p.sections.profile!.effective).toMatchObject({ persona: winningPersona, memory: '公共记忆\n\n本群记忆' });
  a = await owner.read(agent) as AgentSettingsView;
  agentViewSchema.parse(a);
  await owner.save({ scope: agent, section: 'profile', revision: a.sections.profile!.revision, patch: { memory: '更新的公共记忆' } });
  p = await view(owner);
  expect(p.sections.profile!.stored.memory).toBe('本群记忆');
  expect(p.sections.profile!.effective.memory).toBe('更新的公共记忆\n\n本群记忆');
});

it('keeps models and efforts independent and prevents legacy project/session model writes bypassing removal', async () => {
  const owner = createSettingsOwner(deps());
  let p = await view(owner);
  expect((await owner.save({ scope, section: 'modelAccess', revision: p.sections.modelAccess!.revision, patch: { backend: 'codex-appserver', models: ['a', 'b'], efforts: ['low', 'high'] } })).kind).toBe('saved');
  p = await view(owner);
  await owner.save({ scope, section: 'modelAccess', revision: p.sections.modelAccess!.revision, patch: { models: ['a'], efforts: ['low'] } });
  p = await view(owner);
  expect((await owner.save({ scope, section: 'model', revision: p.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'b', effort: 'high' } } })).kind).toBe('rejected');
  await upsertSession({ threadId: 'om_thread', chatId: 'oc_demo', sessionId: 'native', cwd: '/fixture/work', backend: 'codex-appserver', model: 'b', effort: 'high', createdAt: 1, updatedAt: 1, summary: '' });
  const sessionScope = { kind: 'session' as const, botId, threadId: 'om_thread' };
  const session = await owner.read(sessionScope) as SessionSettingsView;
  expect((await owner.save({ scope: sessionScope, section: 'model', revision: session.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'b', effort: 'high', custom: true } } })).kind).toBe('rejected');
  const stored = (await getProjectByName('demo'))!;
  expect(projectModelAllowed(stored, 'codex-appserver', 'b', 'high', models)).toBe(false);
  expect(projectModelAllowed(stored, 'claude-agent', 'a', 'low', models)).toBe(false);
  expect(projectModelCatalog(stored, 'codex-appserver', models)).toMatchObject([{ id: 'a', supportedEfforts: ['low'] }]);
});

it('allows a model without Effort but rejects missing model selections and unusable intersections', async () => {
  const owner = createSettingsOwner(deps()); const p = await view(owner);
  const save = (models: string[], efforts: ('low'|'high')[]) => owner.save({ scope, section: 'modelAccess', revision: p.sections.modelAccess!.revision, patch: { models, efforts } });
  await expect(save([], [])).rejects.toThrow('设置字段');
  expect((await save(['b'], ['low'])).kind).toBe('rejected');
  expect((await save(['flat'], [])).kind).toBe('saved');
  expect(projectModelAllowed((await getProjectByName('demo'))!, 'codex-appserver', 'flat', undefined, models)).toBe(true);
});

it('preserves the complete legacy SMART text and saves both prompt areas with CAS', async () => {
  const owner = createSettingsOwner(deps()); const p = await view(owner);
  expect(p.sections.smartRules!.stored).toEqual({ respond: oldSmart, newTopic: '' });
  const edit = { scope, section: 'smartRules' as const, revision: p.sections.smartRules!.revision, patch: { newTopic: '遇到独立问题才创建' } };
  expect((await owner.save(edit)).kind).toBe('saved');
  expect((await owner.save(edit)).kind).toBe('conflict');
  expect((await getProjectByName('demo'))!.smartRules).toEqual({ respond: oldSmart, newTopic: '遇到独立问题才创建' });
});

it('shows the complete default rule document and preserves the wire fields on a partial save', async () => {
  const owner = createSettingsOwner({...deps(), readSmartPrompt: async () => ({source: 'default', path: '/fixture/SMART.md', text: DEFAULT_SMART_PROMPT})});
  const p = await view(owner);
  expect(p.sections.smartRules!.stored).toEqual(DEFAULT_SMART_RULES);
  expect(composeSmartRules(p.sections.smartRules!.stored)).toBe(p.smartPrompt!.text);
  const result = await owner.save({scope, section: 'smartRules', revision: p.sections.smartRules!.revision, patch: {respond: '仅响应测试请求'}});
  expect(result.kind).toBe('saved');
  expect((await getProjectByName('demo'))!.smartRules).toEqual({respond: '仅响应测试请求', newTopic: DEFAULT_SMART_RULES.newTopic});
});

it('saves and rereads a completely cleared rule document without restoring defaults or a legacy file', async () => {
  const owner = createSettingsOwner(deps());
  const p = await view(owner);
  expect((await owner.save({scope, section: 'smartRules', revision: p.sections.smartRules!.revision, patch: {respond: '', newTopic: ''}})).kind).toBe('saved');
  expect((await getProjectByName('demo'))!.smartRules).toEqual({respond: '', newTopic: ''});
  const reloaded = await view(owner);
  expect(reloaded.sections.smartRules!.stored).toEqual({respond: '', newTopic: ''});
  expect(reloaded.smartPrompt!.text).toBe('');
});

it('updates exact materialized defaults consistently in the view and runtime, preserving custom edits', async () => {
  await mutateProject('demo', p => { p.smartRules = {respond: LEGACY_DEFAULT_SMART_PROMPT, newTopic: ''}; });
  const owner = createSettingsOwner(deps());
  const p = await view(owner);
  expect(p.sections.smartRules!.stored).toEqual(DEFAULT_SMART_RULES);
  expect(p.smartPrompt!.text).toBe(DEFAULT_SMART_PROMPT);
  expect(composeSmartRules((await getProjectByName('demo'))!.smartRules!)).toBe(DEFAULT_SMART_PROMPT);
  const custom = {respond: `${LEGACY_DEFAULT_SMART_PROMPT}\n只在工作时间回复`, newTopic: ''};
  await mutateProject('demo', p => { p.smartRules = custom; });
  expect((await view(owner)).sections.smartRules!.stored).toEqual(custom);
  expect(composeSmartRules(custom)).toContain(custom.respond);
});

it('canonicalizes a selected workspace and rejects a duplicate or a primary outside its directory list', async () => {
  const dir = join(paths.appDir, 'projects', 'fixture'); const second = join(paths.appDir, 'projects', 'second');
  await mkdir(dir, { recursive: true }); await mkdir(second, { recursive: true });
  const link = join(paths.appDir, 'projects', 'link'); await symlink(dir, link);
  const owner = createSettingsOwner(deps()); let p = await view(owner);
  expect((await owner.save({ scope, section: 'workspace', revision: p.sections.workspace!.revision, patch: { primary: link, directories: [link, second], repositories: [] } })).kind).toBe('saved');
  p = await view(owner);
  expect(p.sections.workspace!.stored).toEqual({ primary: await realpath(dir), directories: [await realpath(dir), await realpath(second)], repositories: [] });
  expect((await owner.save({ scope, section: 'workspace', revision: p.sections.workspace!.revision, patch: { directories: [second] } })).kind).toBe('rejected');
  expect((await owner.save({ scope, section: 'workspace', revision: p.sections.workspace!.revision, patch: { directories: [dir, link] } })).kind).toBe('rejected');
});

it('freezes inherited legacy choices without dropping old session model IDs or unknown data', async () => {
  cfg.preferences = { defaults: { backend: 'codex-appserver', model: { kind: 'custom', id: 'old-gateway', effort: 'high' } }, showToolCalls: false, pendingPolicy: 'queue' };
  await mutateProject('demo', p => { (p as Project & { future: string }).future = 'preserve'; });
  const migration = await materializeGroupSettings({ ...deps(), readSessions: async () => [{ threadId: 'om_x', chatId: 'oc_demo', sessionId: 'native', backend: 'codex-appserver', model: 'old-topic', effort: 'high', cwd: '/fixture/work', summary: '', createdAt: 1, updatedAt: 1 }] });
  expect(migration.updated).toEqual(['demo']);
  const p = (await getProjectByName('demo'))!;
  expect(p.modelAccess!.models).toEqual(expect.arrayContaining(['a', 'old-gateway', 'old-topic']));
  expect(p).toMatchObject({ future: 'preserve', defaultModel: 'old-gateway', pendingPolicy: 'queue', presentation: { showToolCalls: false }, smartRules: { respond: oldSmart } });
});

it('edits only local sections while stopped, keeps live actions gated, and never steals its own process lock', async () => {
  const executeWrite = vi.fn();
  const service = createSettingsService({ executeWrite, liveStatus: async () => undefined });
  const p = await service.read(scope) as ProjectSettingsView;
  expect(p.sections.presentation!.access.kind).toBe('writable');
  expect((await service.save({ scope, section: 'presentation', revision: p.sections.presentation!.revision, patch: { showToolCalls: false } })).kind).toBe('saved');
  expect(executeWrite).not.toHaveBeenCalled();
  await expect(readFile(botPaths(botId).processesFile)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await service.act({ kind: 'voice', botId, action: { action: 'enable' } })).kind).toBe('unavailable');
  const lock = JSON.stringify({ pid: process.pid, appId: botId, startedAt: Date.now() });
  await writeFile(botPaths(botId).processesFile, lock);
  expect((await service.save({ scope, section: 'presentation', revision: p.sections.presentation!.revision, patch: { showToolCalls: true } })).kind).toBe('unavailable');
  expect(await readFile(botPaths(botId).processesFile, 'utf8')).toBe(lock);
});

it('reads stopped-Bot local skills and model metadata without probing or starting a Provider', async () => {
  const cwd = join(paths.appDir, 'workspace');
  await mkdir(join(cwd, '.agents', 'skills', 'local'), { recursive: true });
  await writeFile(join(cwd, '.agents', 'skills', 'local', 'SKILL.md'), '---\nname: local\ndescription: local test skill\n---\nBody');
  await mutateProject('demo', p => { p.cwd = cwd; });
  const nativeDir = process.env.CODEX_HOME!; await mkdir(nativeDir, { recursive: true });
  await writeFile(join(nativeDir, 'models_cache.json'), JSON.stringify({ fetched_at: '2026-10-22T00:00:00Z', models: [{ slug: 'cached', display_name: 'Cached', supported_reasoning_levels: [{ effort: 'high' }], default_reasoning_level: 'high' }] }));
  const offlineBackend = { ...backend, peekModels: () => [], listModels: vi.fn(), doctor: vi.fn() } as unknown as AgentBackend;
  const owner = createSettingsOwner({ ...deps(), offline: true, localEditing: true, backendFor: () => offlineBackend });
  const p = await view(owner);
  expect(p.skills).toEqual([expect.objectContaining({ name: 'local', source: 'workspace', enabled: true })]);
  expect(p.skillsError).toContain('Provider 插件');
  const catalog = await owner.models({ botId, backend: 'codex-appserver', purpose: 'session' });
  expect(catalog).toMatchObject({ state: 'fallback', models: [{ id: 'cached', supportedEfforts: ['high'] }] });
  expect(catalog.error).toContain('本机模型缓存');
  expect(offlineBackend.listModels).not.toHaveBeenCalled(); expect(offlineBackend.doctor).not.toHaveBeenCalled();
  expect((await owner.save({ scope, section: 'modelAccess', revision: p.sections.modelAccess!.revision, patch: { backend: 'codex-appserver', models: ['cached'], efforts: ['high'] } })).kind).toBe('saved');
});

it('prefers persisted observed metadata, falls back honestly, and preserves group model-display on migration', async () => {
  const { rememberModelCatalog, offlineModelCatalog } = await import('../src/admin/model-catalog');
  const initial = await offlineModelCatalog('codex-appserver');
  expect(initial.models.length).toBeGreaterThan(0); expect(initial.message).toContain('未验证');
  await rememberModelCatalog('codex-appserver', models, '2026-10-22T01:00:00Z');
  expect(await offlineModelCatalog('codex-appserver')).toMatchObject({ models, observedAt: '2026-10-22T01:00:00Z' });
  cfg.preferences = { showModel: 'always' };
  await materializeGroupSettings({ ...deps(), readSessions: async () => [] });
  expect((await getProjectByName('demo'))!.presentation?.showModel).toBe('always');
  const owner = createSettingsOwner(deps()); const p = await view(owner);
  expect((await owner.save({ scope, section: 'presentation', revision: p.sections.presentation!.revision, patch: { showModel: 'off' } })).kind).toBe('saved');
  expect((await view(owner)).sections.presentation!.effective.showModel).toBe('off');
  expect(cfg.preferences.showModel).toBe('always');
});

it('chooses an allowed Effort supported by the retained default model after a range edit', async () => {
  await mutateProject('demo', p => { p.defaultModel = 'a'; p.defaultEffort = 'low'; });
  const owner = createSettingsOwner(deps()); let p = await view(owner);
  expect((await owner.save({ scope, section: 'modelAccess', revision: p.sections.modelAccess!.revision, patch: { backend: 'codex-appserver', models: ['b'], efforts: ['low', 'high'] } })).kind).toBe('saved');
  expect((await getProjectByName('demo'))!).toMatchObject({ defaultModel: 'b', defaultEffort: 'high' });
});

it('rejects malformed explicit group settings without broadening access or rewriting the registry', async () => {
  const before = await readFile(paths.projectsFile, 'utf8');
  const invalid = JSON.parse(before); invalid.projects[0].modelAccess = { backend: 'codex-appserver', models: [], efforts: [] };
  const content = JSON.stringify(invalid); await writeFile(paths.projectsFile, content);
  await expect(view(createSettingsOwner(deps()))).rejects.toThrow('modelAccess');
  await expect(mutateProject('demo', p => { p.enabled = true; })).rejects.toThrow('modelAccess');
  expect(await readFile(paths.projectsFile, 'utf8')).toBe(content);
});

it('edits the role as two sections of SOUL.md and keeps the editor to those two (draft from the app name, no AGENTS.md)', async () => {
  const owner = createSettingsOwner({ ...deps(), botName: '小支' });
  await writeFile(join(botPaths(botId).dir, 'SOUL.md'), '旧 SOUL 全文');
  let a = await owner.read(agent) as AgentSettingsView;
  agentViewSchema.parse(a);
  expect(a.sections.role!.stored).toEqual({ identity: '', notes: '旧 SOUL 全文' });
  expect(a.roleInfo).toMatchObject({ headed: false, oversized: false, mergedNotice: false, draft: '我是「小支」，团队里的 AI 助手。我负责：' });
  expect(await readFile(join(botPaths(botId).dir, 'SOUL.md'), 'utf8')).toBe('旧 SOUL 全文');
  const stale = a.sections.role!.revision;
  expect((await owner.save({ scope: agent, section: 'role', revision: stale, patch: { identity: '发布助手' } })).kind).toBe('saved');
  expect(await readFile(join(botPaths(botId).dir, 'SOUL.md'), 'utf8')).toBe('## 身份与职责\n发布助手\n\n## 其他说明\n旧 SOUL 全文\n');
  expect((await owner.save({ scope: agent, section: 'role', revision: stale, patch: { notes: 'x' } })).kind).toBe('conflict');
  a = await owner.read(agent) as AgentSettingsView;
  expect(a.roleInfo?.draft).toBeUndefined();
  expect(await owner.save({ scope: agent, section: 'role', revision: a.sections.role!.revision, patch: { identity: '字'.repeat(501) } })).toMatchObject({ kind: 'rejected', fields: [{ message: expect.stringContaining('500') }] });
  // the whole-file view keeps its persona for old readers but cannot rewrite the role
  expect(await owner.save({ scope: agent, section: 'profile', revision: a.sections.profile!.revision, patch: { persona: '直接改' } })).toMatchObject({ kind: 'rejected', fields: [{ message: expect.stringContaining('角色设定') }] });
});

it('writes a group supplement to the row and to profile.persona until P4a, and shows a row without one by its persona', async () => {
  const owner = createSettingsOwner(deps());
  let p = await view(owner);
  projectViewSchema.parse(p);
  expect(p.sections.role!.stored).toEqual({ supplement: '' });
  await mutateProject('demo', async row => { row.profile = { persona: '旧本群个性', memory: '', inheritPersona: true, inheritMemory: true }; });
  p = await view(owner);
  expect(p.sections.role!.stored).toEqual({ supplement: '旧本群个性' });
  expect((await owner.save({ scope, section: 'role', revision: p.sections.role!.revision, patch: { supplement: '少说话' } })).kind).toBe('saved');
  const row = (await getProjectByName('demo'))!;
  expect(row.supplement).toBe('少说话');
  expect(row.profile).toMatchObject({ persona: '少说话', inheritPersona: true });
  p = await view(owner);
  expect(await owner.save({ scope, section: 'role', revision: p.sections.role!.revision, patch: { supplement: '字'.repeat(5001) } })).toMatchObject({ kind: 'rejected', fields: [{ message: expect.stringContaining('5000') }] });
  // a persona saved through the old section is the supplement too
  expect((await owner.save({ scope, section: 'profile', revision: p.sections.profile!.revision, patch: { persona: '老入口' } })).kind).toBe('saved');
  expect((await getProjectByName('demo'))!.supplement).toBe('老入口');
});
