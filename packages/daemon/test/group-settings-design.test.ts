import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentViewSchema, projectViewSchema, DEFAULT_SMART_RULES, defaultCardDisplay } from '@vonvon/protocol';
import { DEFAULT_SMART_PROMPT, LEGACY_DEFAULT_SMART_PROMPT } from '../src/judge/prompt';
import { composeSmartRules } from '../src/judge/smart-file';
import { botPaths, paths } from '../src/config/paths';
import { saveConfig } from '../src/config/store';
import { createSettingsOwner, materializeGroupSettings, type SettingsOwnerDeps } from '../src/admin/settings';
import { createSettingsService } from '../src/admin/settings-service';
import { createAppPreferencesWriter } from '../src/admin/ops';
import { addProject, cardDisplayPresentationDefaults, getProjectByName, materializeCardDisplaySettings, mutateProject, type Project } from '../src/project/registry';
import { upsertSession } from '../src/bot/session-store';
import { projectModelAllowed, projectModelCatalog, projectSpeedAllowed, resolveModelPreference } from '../src/config/execution';
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

it('keeps the old profile sections read-only and conflicts on concurrent role edits', async () => {
  const owner = createSettingsOwner(deps());
  let a = await owner.read(agent) as AgentSettingsView;
  expect((await owner.save({ scope: agent, section: 'role', revision: a.sections.role!.revision, patch: { identity: '公共个性' } })).kind).toBe('saved');
  a = await owner.read(agent) as AgentSettingsView;
  agentViewSchema.parse(a);
  // the shared memory is the bot's memory entries now: nothing is written to the old section
  expect(await owner.save({ scope: agent, section: 'profile', revision: a.sections.profile!.revision, patch: { memory: '公共记忆' } })).toMatchObject({ kind: 'rejected', fields: [{ message: expect.stringContaining('Bot 记忆') }] });
  let p = await view(owner);
  expect(projectViewSchema.safeParse(p).success).toBe(true);
  expect(await owner.save({ scope, section: 'profile', revision: p.sections.profile!.revision, patch: { persona: '本群', memory: '本群记忆' } })).toMatchObject({ kind: 'rejected', fields: [{ message: expect.stringContaining('补充职责') }] });
  const replies = await Promise.all(['本群一', '本群二'].map(supplement => owner.save({ scope, section: 'role', revision: p.sections.role!.revision, patch: { supplement } })));
  expect(replies.map(x => x.kind).sort()).toEqual(['conflict', 'saved']);
  p = await view(owner);
  expect(p.sections.role!.stored.supplement).toBe(replies[0]!.kind === 'saved' ? '本群一' : '本群二');
  // the old section is only a record: it shows the row's own `profile`, never a file
  expect(p.sections.profile!.effective).toEqual(p.sections.profile!.stored);
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
  expect(p).toMatchObject({ future: 'preserve', defaultModel: 'old-gateway', pendingPolicy: 'queue', smartRules: { respond: oldSmart } });
  expect(p.presentation).toBeUndefined();
  // the materialization no longer writes `profile`: the role is the bot's file, the supplement and memory are the migration's
  expect(p.profile).toBeUndefined();
});

it('leaves the folders of a row bound to a library project alone: no default repositories, no folder-guard crash at start', async () => {
  cfg.preferences = { directories: { repositories: ['/fixture/repo'] } };
  await mutateProject('demo', p => { p.projectId = 'prj_0123abcd'; });
  const migration = await materializeGroupSettings({ ...deps(), readSessions: async () => [] });
  expect(migration.updated).toEqual(['demo']);
  expect((await getProjectByName('demo'))!.directories?.repositories).toBeUndefined();
});

it('edits only local sections while stopped, keeps live actions gated, and never steals its own process lock', async () => {
  const executeWrite = vi.fn();
  const service = createSettingsService({ executeWrite, liveStatus: async () => undefined });
  const p = await service.read(scope) as ProjectSettingsView;
  expect(p.sections.presentation!.access.kind).toBe('writable');
  expect((await service.save({ scope, section: 'presentation', revision: p.sections.presentation!.revision, patch: { voiceEnabled: false } })).kind).toBe('saved');
  expect(executeWrite).not.toHaveBeenCalled();
  await expect(readFile(botPaths(botId).processesFile)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await service.act({ kind: 'voice', botId, action: { action: 'enable' } })).kind).toBe('unavailable');
  const lock = JSON.stringify({ pid: process.pid, appId: botId, startedAt: Date.now() });
  await writeFile(botPaths(botId).processesFile, lock);
  expect((await service.save({ scope, section: 'presentation', revision: p.sections.presentation!.revision, patch: { voiceEnabled: true } })).kind).toBe('unavailable');
  expect(await readFile(botPaths(botId).processesFile, 'utf8')).toBe(lock);
});

it('materializes a stopped Bot legacy card into its existing group before reading settings', async () => {
  const display = defaultCardDisplay();
  cfg.preferences = { ...cfg.preferences, showToolCalls: false, showModel: 'off', cardDisplay: display };
  await saveConfig(cfg);
  const service = createSettingsService({ executeWrite: vi.fn(), liveStatus: async () => undefined });
  const first = await service.read(scope) as ProjectSettingsView;
  expect(first.sections.presentation!.stored.cardDisplay).toEqual(display);
  expect((await getProjectByName('demo'))?.presentation?.cardDisplay).toEqual(display);
  const revised = defaultCardDisplay();
  revised.blocks.find(block => block.kind === 'context')!.slot = 'bottom';
  cfg.preferences.cardDisplay = revised;
  await saveConfig(cfg);
  const second = await service.read(scope) as ProjectSettingsView;
  expect(second.sections.presentation!.effective.cardDisplay).toEqual(display);
});

it('keeps card-only presentation sparse and resolves current voice and completion defaults', async () => {
  cfg.preferences = { ...cfg.preferences, voice: { enabled: false }, completionReminder: { mode: 'manual', longTaskMinutes: 5 } };
  const owner = createSettingsOwner(deps());
  const first = await view(owner);
  const cardDisplay = defaultCardDisplay();
  expect((await owner.save({ scope, section: 'presentation', revision: first.sections.presentation!.revision, patch: { cardDisplay } })).kind).toBe('saved');
  expect((await getProjectByName('demo'))!.presentation).toEqual({ cardDisplay });
  cfg.preferences.voice = { enabled: true };
  cfg.preferences.completionReminder = { mode: 'long', longTaskMinutes: 12 };
  const current = await view(owner);
  expect(current.sections.presentation!.effective).toMatchObject({ voiceEnabled: true, completionMode: 'long', longTaskMinutes: 12 });
  expect((await owner.save({ scope, section: 'presentation', revision: current.sections.presentation!.revision, patch: { cardDisplay: null, completionMode: 'always', longTaskMinutes: 20 } })).kind).toBe('saved');
  expect((await owner.save({ scope, section: 'presentation', revision: current.sections.presentation!.revision, patch: { cardDisplay } })).kind).toBe('conflict');
  expect((await getProjectByName('demo'))!.presentation).toEqual({ cardDisplay: null, completionMode: 'always', longTaskMinutes: 20 });
  expect((await view(owner)).sections.presentation!.effective).toMatchObject({ voiceEnabled: true, cardDisplay: null, completionMode: 'always', longTaskMinutes: 20 });
});

it('saves a chat reminder template without freezing inherited policy and keeps Bot templates out of settings', async () => {
  cfg.preferences = {...cfg.preferences, completionReminder:{mode:'long',longTaskMinutes:7,template:'Bot template'}};
  const owner = createSettingsOwner(deps());
  const first = await view(owner);
  expect(first.sections.presentation!.effective.completionTemplate).toBeNull();
  expect((await owner.read(agent) as AgentSettingsView).sections.completion.stored).toEqual({mode:'long',longTaskMinutes:7});
  const completionTemplate = '{{icon}} {{task}}：{{status}}\n耗时 {{elapsed}}';
  expect((await owner.save({scope,section:'presentation',revision:first.sections.presentation!.revision,patch:{completionTemplate}})).kind).toBe('saved');
  expect((await getProjectByName('demo'))!.presentation).toEqual({completionTemplate});
  cfg.preferences.completionReminder = {mode:'always',longTaskMinutes:9};
  const current = await view(owner);
  expect(current.sections.presentation!.effective).toMatchObject({completionTemplate,completionMode:'always',longTaskMinutes:9});
  expect((await owner.save({scope,section:'presentation',revision:current.sections.presentation!.revision,patch:{completionTemplate:null}})).kind).toBe('saved');
  expect((await getProjectByName('demo'))!.presentation).toEqual({completionTemplate:null});
});

it('validates the complete reminder and card patch before atomically saving any field', async () => {
  const owner = createSettingsOwner(deps());
  const first = await view(owner);
  const before = await readFile(paths.projectsFile,'utf8');
  for (const completionTemplate of ['{{unknown}}','{{task}','   ','x'.repeat(501)]) {
    await expect(owner.save({scope,section:'presentation',revision:first.sections.presentation!.revision,patch:{cardDisplay:defaultCardDisplay(),completionMode:'long',longTaskMinutes:11,completionTemplate}})).rejects.toThrow();
    expect(await readFile(paths.projectsFile,'utf8')).toBe(before);
  }
  for (const requestedTemplate of ['{{status.label}}','  ','x'.repeat(81),'一行\n两行']) {
    const cardDisplay=defaultCardDisplay();
    cardDisplay.blocks.find(block=>block.kind==='reminder')!.requestedTemplate=requestedTemplate;
    await expect(owner.save({scope,section:'presentation',revision:first.sections.presentation!.revision,patch:{cardDisplay,completionMode:'manual',completionTemplate:'已完成'}})).rejects.toThrow();
    expect(await readFile(paths.projectsFile,'utf8')).toBe(before);
  }
  const patch = {cardDisplay:defaultCardDisplay(),completionMode:'long' as const,longTaskMinutes:11,completionTemplate:'{{task}} {{status}} · {{elapsed}}'};
  patch.cardDisplay.blocks.find(block=>block.kind==='reminder')!.requestedTemplate='✅ 完成会喊你回来';
  expect((await owner.save({scope,section:'presentation',revision:first.sections.presentation!.revision,patch})).kind).toBe('saved');
  expect((await getProjectByName('demo'))!.presentation).toEqual(patch);
  const current = await view(owner);
  expect(current.sections.presentation!.effective).toMatchObject(patch);
  expect((await owner.save({scope,section:'presentation',revision:first.sections.presentation!.revision,patch:{completionTemplate:null}})).kind).toBe('conflict');
  expect((await getProjectByName('demo'))!.presentation).toEqual(patch);
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
  expect(p.skills).toEqual([
    expect.objectContaining({ name: 'vonvon-schedule', path: 'vonvon:vonvon-schedule', source: 'builtin', enabled: true, location: expect.stringContaining('vonvon-schedule') }),
    expect.objectContaining({ name: 'vonvon-feishu', path: 'vonvon:vonvon-feishu', source: 'builtin', enabled: true, location: expect.stringContaining('vonvon-feishu') }),
    expect.objectContaining({ name: 'local', source: 'workspace', enabled: true }),
  ]);
  expect(await readFile(p.skills![0]!.location!, 'utf8')).toContain('vonvon-schedule');
  expect(p.skillsError).toContain('Provider 插件');
  const catalog = await owner.models({ botId, backend: 'codex-appserver', purpose: 'session' });
  expect(catalog).toMatchObject({ state: 'fallback', models: [{ id: 'cached', supportedEfforts: ['high'] }] });
  expect(catalog.error).toContain('本机模型缓存');
  expect(offlineBackend.listModels).not.toHaveBeenCalled(); expect(offlineBackend.doctor).not.toHaveBeenCalled();
  expect((await owner.save({ scope, section: 'modelAccess', revision: p.sections.modelAccess!.revision, patch: { backend: 'codex-appserver', models: ['cached'], efforts: ['high'] } })).kind).toBe('rejected');
});

it('prefers persisted observed metadata, falls back honestly, and preserves group model-display on migration', async () => {
  const { rememberModelCatalog, offlineModelCatalog } = await import('../src/admin/model-catalog');
  const initial = await offlineModelCatalog('codex-appserver');
  expect(initial.models.length).toBeGreaterThan(0); expect(initial.message).toContain('未验证');
  await rememberModelCatalog('codex-appserver', models, '2026-10-22T01:00:00Z');
  expect(await offlineModelCatalog('codex-appserver')).toMatchObject({ models, observedAt: '2026-10-22T01:00:00Z' });
  const future = [{ ...models[0]!, supportedEfforts: ['future-adaptive'], defaultEffort: 'future-adaptive' }];
  await rememberModelCatalog('codex-appserver', future, '2026-10-22T02:00:00Z');
  expect((await offlineModelCatalog('codex-appserver')).models[0]).toMatchObject({ supportedEfforts: ['future-adaptive'], defaultEffort: 'future-adaptive' });
  await expect(rememberModelCatalog('codex-appserver', [{ ...future[0]!, defaultEffort: '' }], '2026-10-22T03:00:00Z')).rejects.toThrow();
  cfg.preferences = { showModel: 'always' };
  await materializeGroupSettings({ ...deps(), readSessions: async () => [] });
  await materializeCardDisplaySettings({ defaults: cardDisplayPresentationDefaults(cfg) });
  expect((await getProjectByName('demo'))!.presentation?.cardDisplay?.blocks.find(block => block.kind === 'model')?.mode).toBe('always');
  const owner = createSettingsOwner(deps()); const p = await view(owner);
  await expect(owner.save({ scope, section: 'presentation', revision: p.sections.presentation!.revision, patch: { showModel: 'off' } })).rejects.toThrow('旧工具和模型显示字段只供迁移');
  const display = defaultCardDisplay();
  display.blocks.find(block => block.kind === 'model')!.mode = 'off';
  expect((await owner.save({ scope, section: 'presentation', revision: p.sections.presentation!.revision, patch: { cardDisplay: display } })).kind).toBe('saved');
  expect((await view(owner)).sections.presentation!.effective.cardDisplay?.blocks.find(block => block.kind === 'model')?.mode).toBe('off');
  expect(cfg.preferences.showModel).toBe('always');
});

it('chooses an allowed Effort supported by the retained default model after a range edit', async () => {
  await mutateProject('demo', p => { p.defaultModel = 'a'; p.defaultEffort = 'low'; });
  const owner = createSettingsOwner(deps()); let p = await view(owner);
  expect((await owner.save({ scope, section: 'modelAccess', revision: p.sections.modelAccess!.revision, patch: { backend: 'codex-appserver', models: ['b'], efforts: ['low', 'high'] } })).kind).toBe('saved');
  expect((await getProjectByName('demo'))!).toMatchObject({ defaultModel: 'b', defaultEffort: 'high' });
});

it('persists disjoint per-model efforts and explicit new-topic defaults', async () => {
  const owner = createSettingsOwner(deps());
  const before = await view(owner);
  const patch = { backend: 'codex-appserver', models: ['a', 'b'], efforts: ['low', 'high'], modelEfforts: { a: ['low'], b: ['high'] }, defaultModel: 'b', defaultEffort: 'high' };
  expect((await owner.save({ scope, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch })).kind).toBe('saved');
  const stored = (await getProjectByName('demo'))!;
  expect(stored.modelAccess).toMatchObject(patch);
  expect(stored).toMatchObject({ defaultModel: 'b', defaultEffort: 'high' });
  expect(resolveModelPreference({ group: stored }, 'codex-appserver')).toMatchObject({ model: 'b', effort: 'high' });
  expect(projectModelAllowed(stored, 'codex-appserver', 'a', 'high', models)).toBe(false);
  expect(projectModelAllowed(stored, 'codex-appserver', 'b', 'high', models)).toBe(true);
  expect(projectModelCatalog(stored, 'codex-appserver', models).map(m => [m.id, m.supportedEfforts])).toEqual([['a', ['low']], ['b', ['high']]]);
});

it('keeps all acceleration off until explicitly allowed for each live model', async () => {
  const native: ModelInfo[] = models.slice(0, 2).map(m => ({ ...m, serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }] }));
  const owner = createSettingsOwner({ ...deps(), backendFor: () => ({ ...backend, peekModels: () => native, listModels: async () => native }) });
  const before = await view(owner);
  expect((await owner.save({ scope, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch: { models: ['a', 'b'], efforts: ['low', 'high'], defaultModel: 'a', defaultEffort: 'low', modelServiceTiers: { a: ['fast'] } } })).kind).toBe('saved');
  const stored = (await getProjectByName('demo'))!;
  expect(projectSpeedAllowed(stored, 'a', 'fast')).toBe(true);
  expect(projectSpeedAllowed(stored, 'b', 'fast')).toBe(false);
  expect(projectModelCatalog(stored, 'codex-appserver', native).find(m => m.id === 'b')?.serviceTiers).toEqual([]);
  const next = await view(owner);
  expect((await owner.save({ scope, section: 'modelAccess', revision: next.sections.modelAccess!.revision, patch: { modelServiceTiers: { b: ['ultrafast'] } } })).kind).toBe('rejected');
});

it('clears the old effort when a serialized edit makes a no-effort model the default', async () => {
  const owner = createSettingsOwner(deps());
  let before = await view(owner);
  expect((await owner.save({ scope, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch: { models: ['a', 'flat'], efforts: ['low'], defaultModel: 'a', defaultEffort: 'low' } })).kind).toBe('saved');
  before = await view(owner);
  const patch = JSON.parse(JSON.stringify({ defaultModel: 'flat', defaultEffort: undefined })) as { defaultModel: string };
  expect((await owner.save({ scope, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch })).kind).toBe('saved');
  const stored = (await getProjectByName('demo'))!;
  expect(stored.defaultModel).toBe('flat');
  expect(stored.defaultEffort).toBeUndefined();
  expect(stored.modelAccess?.defaultEffort).toBeUndefined();
});

it('rejects a stale session speed choice after the group revokes it', async () => {
  const native: ModelInfo[] = [{ ...models[0]!, serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }] }];
  await mutateProject('demo', p => { p.modelAccess = { backend: 'codex-appserver', models: ['a'], efforts: ['low'], modelServiceTiers: {} }; p.defaultModel = 'a'; p.defaultEffort = 'low'; });
  await upsertSession({ threadId: 'omt_speed', chatId: 'oc_demo', sessionId: 'native-speed', backend: 'codex-appserver', cwd: '/fixture/work', model: 'a', effort: 'low', serviceTier: 'fast', createdAt: 1, updatedAt: 1, summary: '' });
  const owner = createSettingsOwner({ ...deps(), backendFor: () => ({ ...backend, peekModels: () => native, listModels: async () => native }) });
  const session = { kind: 'session' as const, botId, threadId: 'omt_speed' };
  const current = await owner.read(session) as SessionSettingsView;
  expect(current.sections.speed!.effective.tier).toBe('standard');
  expect((await owner.save({ scope: session, section: 'speed', revision: current.sections.speed!.revision, patch: { tier: 'fast' } })).kind).toBe('rejected');
});

it('keeps an empty per-model effort override while other models still use the aggregate', async () => {
  const native: ModelInfo[] = [{ ...models[0]!, supportedEfforts: [], defaultEffort: 'medium' }, models[1]!];
  await mutateProject('demo', p => { p.modelAccess = { backend: 'codex-appserver', models: ['a', 'b'], efforts: ['high'], defaultModel: 'a', defaultEffort: 'high' }; p.defaultModel = 'a'; p.defaultEffort = 'high'; });
  const owner = createSettingsOwner({ ...deps(), backendFor: () => ({ ...backend, peekModels: () => native, listModels: async () => native }) });
  const before = await view(owner);
  const patch = JSON.parse(JSON.stringify({ modelEfforts: { a: [], b: ['high'] }, defaultEffort: undefined }));
  expect((await owner.save({ scope, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch })).kind).toBe('saved');
  const stored = (await getProjectByName('demo'))!;
  expect(stored.modelAccess?.modelEfforts).toEqual({ a: [], b: ['high'] });
  expect(stored.defaultEffort).toBeUndefined();
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

it('writes a group supplement to the row only, and shows a row the migration has not reached by its old persona', async () => {
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
  expect(row.profile).toMatchObject({ persona: '旧本群个性' });
  p = await view(owner);
  expect(await owner.save({ scope, section: 'role', revision: p.sections.role!.revision, patch: { supplement: '字'.repeat(5001) } })).toMatchObject({ kind: 'rejected', fields: [{ message: expect.stringContaining('5000') }] });
  // a row the migration has handled does not fall back to its old persona
  await mutateProject('demo', async current => { delete current.supplement; current.migration = { memory: 1 }; });
  expect((await view(owner)).sections.role!.stored).toEqual({ supplement: '' });
});

it.each([false, true])('rejects new models, efforts and provider switches from fallback catalogs while allowing existing subsets (offline=%s)', async offline => {
  await mutateProject('demo', p => { p.modelAccess = { backend: 'codex-appserver', models: ['a', 'b'], efforts: ['high'] }; });
  const owner = createSettingsOwner({ ...deps(), offline, backendFor: id => ({ ...backend, id, peekModels: () => offline ? models : undefined }) });
  const before = await view(owner);
  const disk = await readFile(paths.projectsFile, 'utf8');
  for (const patch of [
    { models: ['a', 'b', 'flat'], efforts: ['high'] },
    { models: ['a'], efforts: ['low', 'high'] },
    { backend: 'claude-agent', models: ['a'], efforts: ['high'] },
  ] satisfies Array<Partial<NonNullable<Project['modelAccess']>>>) {
    expect((await owner.save({ scope, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch })).kind).toBe('rejected');
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(disk);
  }
  expect((await owner.save({ scope, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch: { models: ['a'], efforts: ['high'] } })).kind).toBe('saved');
  expect((await getProjectByName('demo'))?.modelAccess).toMatchObject({ backend: 'codex-appserver', models: ['a'], efforts: ['high'], defaultModel: 'a', defaultEffort: 'high' });
});

it('accepts and persists a newly discovered native model when saving model access', async () => {
  await mutateProject('demo', p => { p.modelAccess = { backend: 'codex-appserver', models: ['a'], efforts: ['high'] }; });
  let native: ModelInfo[] | undefined;
  const owner = createSettingsOwner({ ...deps(), backendFor: () => ({ ...backend, peekModels: () => native, listModels: async () => { native = models; return models; } }) });
  const before = await view(owner);
  expect((await owner.save({ scope, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch: { models: ['a', 'b'], efforts: ['high'] } })).kind).toBe('saved');
  expect((await getProjectByName('demo'))?.modelAccess).toMatchObject({ backend: 'codex-appserver', models: ['a', 'b'], efforts: ['high'], defaultModel: 'a', defaultEffort: 'high' });
});

it('rejects new choices from a populated native cache after the provider becomes unavailable', async () => {
  await mutateProject('demo', p => { p.modelAccess = { backend: 'codex-appserver', models: ['a'], efforts: ['high'] }; });
  const listModels = vi.fn(async () => models);
  const owner = createSettingsOwner({ ...deps(), backendFor: id => ({ ...backend, id, doctor: async () => ({ ok: false, version: null }), listModels }) });
  const before = await view(owner);
  const disk = await readFile(paths.projectsFile, 'utf8');
  for (const patch of [
    { models: ['a', 'b'], efforts: ['high'] },
    { backend: 'claude-agent', models: ['a'], efforts: ['high'] },
  ] satisfies Array<Partial<NonNullable<Project['modelAccess']>>>) {
    expect((await owner.save({ scope, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch })).kind).toBe('rejected');
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(disk);
  }
  expect(listModels).not.toHaveBeenCalled();
});

it('prunes explicit removed-model policies on save without discarding retained restrictions', async () => {
  const catalog: ModelInfo[] = models.map(m => ({ ...m, serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }] }));
  const owner = createSettingsOwner({ ...deps(), backendFor: () => ({ ...backend, peekModels: () => catalog, listModels: async () => catalog }) });
  await mutateProject('demo', p => { p.modelAccess = { backend: 'codex-appserver', models: ['a', 'b'], efforts: ['low', 'high'], modelEfforts: { a: ['low'], b: ['high'] }, modelServiceTiers: { b: ['fast'] }, defaultModel: 'b', defaultEffort: 'high' }; });
  const before = await view(owner);
  expect((await owner.save({ scope, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch: {
    models: ['a'], modelEfforts: { a: ['low'], b: ['high'] }, modelServiceTiers: { a: ['fast'], b: ['fast'] },
  } })).kind).toBe('saved');
  const stored = (await getProjectByName('demo'))!;
  expect(stored.modelAccess).toMatchObject({ models: ['a'], modelEfforts: { a: ['low'] }, modelServiceTiers: { a: ['fast'] }, defaultModel: 'a', defaultEffort: 'low' });
  expect(Object.keys(stored.modelAccess!.modelEfforts!)).toEqual(['a']);
  expect(Object.keys(stored.modelAccess!.modelServiceTiers!)).toEqual(['a']);
  expect(projectModelAllowed(stored, 'codex-appserver', 'a', 'high', catalog)).toBe(false);
  expect(projectModelAllowed(stored, 'codex-appserver', 'b', 'high', catalog)).toBe(false);
  const next = await view(owner);
  const disk = await readFile(paths.projectsFile, 'utf8');
  for (const patch of [
    { modelEfforts: { a: ['xhigh'], b: ['high'] } },
    { modelServiceTiers: { a: ['ultrafast'], b: ['fast'] } },
  ] satisfies Array<Partial<NonNullable<Project['modelAccess']>>>) {
    expect((await owner.save({ scope, section: 'modelAccess', revision: next.sections.modelAccess!.revision, patch })).kind).toBe('rejected');
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(disk);
  }
});

it.each([false, true])('clears provider-specific omitted policies and prunes explicit orphan maps on a provider switch (explicit=%s)', async explicit => {
  await mutateProject('demo', p => { p.modelAccess = { backend: 'codex-appserver', models: ['a', 'b'], efforts: ['high'], modelEfforts: { a: ['high'], b: ['high'] }, modelServiceTiers: { a: ['fast'], b: ['fast'] }, defaultModel: 'b', defaultEffort: 'high' }; });
  const targetModels: ModelInfo[] = models.map(m => ({ ...m, supportedEfforts: ['low'] }));
  const listModels = vi.fn(async () => targetModels);
  const owner = createSettingsOwner({ ...deps(), backendFor: id => id === 'claude-agent'
    ? { ...backend, id, peekModels: () => targetModels, listModels }
    : backend });
  const before = await view(owner);
  expect((await owner.save({ scope, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch: {
    backend: 'claude-agent', models: ['a'], efforts: ['low'],
    ...(explicit ? { modelEfforts: { a: ['low'], b: ['high'] }, modelServiceTiers: { b: ['fast'] } } : {}),
  } })).kind).toBe('saved');
  expect(listModels).toHaveBeenCalled();
  const stored = (await getProjectByName('demo'))!;
  expect(stored.modelAccess).toMatchObject({ backend: 'claude-agent', models: ['a'], defaultModel: 'a', defaultEffort: 'low' });
  expect(stored.modelAccess?.modelEfforts).toEqual(explicit ? { a: ['low'] } : undefined);
  expect(stored.modelAccess?.modelServiceTiers).toEqual(explicit ? {} : undefined);
  expect(projectModelAllowed(stored, 'claude-agent', 'a', 'high', targetModels)).toBe(false);
  expect(projectModelAllowed(stored, 'codex-appserver', 'a', 'low', models)).toBe(false);
});

it.each([
  ['models', { models: ['a', 'a'] }],
  ['models', { models: ['unknown'] }],
  ['efforts', { models: ['b'], efforts: ['low'] }],
  ['efforts', { efforts: ['low', 'low'] }],
  ['modelEfforts', { modelEfforts: { a: ['xhigh'] } }],
  ['modelEfforts', { modelEfforts: { a: ['low', 'low'] } }],
  ['modelServiceTiers', { modelServiceTiers: { a: ['ultrafast'] } }],
  ['modelServiceTiers', { modelServiceTiers: { a: ['fast', 'fast'] } }],
  ['defaultModel', { defaultModel: 'b' }],
  ['defaultEffort', { defaultEffort: 'xhigh' }],
] satisfies Array<[string, Partial<NonNullable<Project['modelAccess']>>]>)('reports %s for invalid selected model policies (%j)', async (field, patch) => {
  await mutateProject('demo', p => { p.modelAccess = { backend: 'codex-appserver', models: ['a'], efforts: ['low'], defaultModel: 'a', defaultEffort: 'low' }; });
  const owner = createSettingsOwner(deps());
  const before = await view(owner);
  const disk = await readFile(paths.projectsFile, 'utf8');
  expect(await owner.save({ scope, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch })).toMatchObject({ kind: 'rejected', fields: [{ field, message: expect.any(String) }] });
  expect(await readFile(paths.projectsFile, 'utf8')).toBe(disk);
});

it('keeps an unavailable model catalog as a general settings error', async () => {
  await mutateProject('demo', p => { p.modelAccess = { backend: 'codex-appserver', models: ['a'], efforts: ['high'] }; });
  const owner = createSettingsOwner({ ...deps(), backendFor: () => ({ ...backend, doctor: async () => ({ ok: false, version: null }) }) });
  const before = await view(owner);
  expect(await owner.save({ scope, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch: { models: ['a', 'b'] } })).toMatchObject({ kind: 'rejected', fields: [{ field: 'settings', message: expect.stringContaining('目录暂不可用') }] });
});
