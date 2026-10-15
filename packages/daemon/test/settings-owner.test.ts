import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { paths } from '../src/config/paths';
import { saveConfig, loadConfig } from '../src/config/store';
import { createAppPreferencesWriter, createAdminWriteExecutor } from '../src/admin/ops';
import { createSettingsOwner, type SettingsOwnerDeps } from '../src/admin/settings';
import { parseSettingsEdit, parseSettingsAction } from '../src/admin/settings-parse';
import type { AgentSettingsView, ProjectSettingsView, SessionSettingsView } from '../src/admin/settings-types';
import { addProject, getProjectByName, updateProject } from '../src/project/registry';
import { getSession, upsertSession } from '../src/bot/session-store';
import { createAdminIpcCaller, createAdminIpcResponder } from '../src/admin/ipc';
import type { AppConfig } from '../src/config/schema';
import type { AgentBackend } from '../src/agent/types';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'settings-owner-'));
  return { paths: { appDir, configFile: join(appDir, 'config.json'), projectsFile: join(appDir, 'projects.json'), sessionsFile: join(appDir, 'sessions.json'), commentInstructionsFile: join(appDir, 'instructions.md'), commentsRootDir: join(appDir, 'comments') } };
});
const botId = 'cli_fixture';
const agent = { kind: 'agent' as const, botId };
const project = { kind: 'project' as const, botId, projectName: 'demo' };
const session = { kind: 'session' as const, botId, threadId: 'omt_fixture' };
const backend = { id: 'codex-appserver', doctor: async () => ({ ok: true }), supportedModes: ['qa', 'write', 'full'], listModels: async () => [{ id: 'fixture-model', displayName: 'Fixture', description: '', defaultEffort: 'high', supportedEfforts: ['low', 'high'], isDefault: true, hidden: false }] } as unknown as AgentBackend;
let cfg: AppConfig;
async function fixture(overrides: Partial<SettingsOwnerDeps> = {}) {
  const writer = createAppPreferencesWriter({ cfg });
  return { writer, owner: createSettingsOwner({ cfg, writePreferences: writer, backendFor: () => backend, evictLiveSessionsForChat: vi.fn(async () => {}), ...overrides }) };
}
beforeEach(async () => {
  await rm(paths.appDir, { recursive: true, force: true }); await mkdir(paths.appDir, { recursive: true });
  cfg = JSON.parse(JSON.stringify({ accounts: { app: { id: botId, tenant: 'feishu', secret: { source: 'exec', id: 'fixture-secret' } } }, secrets: { providers: { sentinel: { source: 'env', allowlist: ['SECRET'] } } }, futureRoot: 17, preferences: { access: { ownerOpenId: 'ou_owner', admins: ['ou_admin'], unknownAccess: 'preserve' }, completionReminder: { mode: 'long', longTaskMinutes: 3, future: true }, cliBridge: { enabled: false, presence: { future: 8 } }, sessionTitles: { future: 'keep', byBackend: { 'codex-appserver': { enabled: true, model: 'custom-title', effort: 'high', future: 3 } } }, futurePreference: true } }));
  await saveConfig(cfg);
  await addProject({ name: 'demo', chatId: 'oc_demo', cwd: '/tmp/demo', createdAt: 1, blank: false });
  await upsertSession({ threadId: session.threadId, chatId: 'oc_demo', sessionId: 'native-one', backend: 'codex-appserver', cwd: '/tmp/demo', model: 'fixture-model', effort: 'high', createdAt: 1, updatedAt: 1, summary: '' });
});
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));
describe('strict boundaries', () => {
  it.each([{ maxConcurrentRuns: '2' }, { runIdleTimeoutSeconds: 1 }, { runIdleTimeoutSeconds: 3601 }, { pendingPolicy: 'other' }, { ownerOpenId: 'ou_steal' }])('rejects malformed run edits %j', patch => expect(() => parseSettingsEdit({ scope: agent, section: 'run', revision: 'x', patch })).toThrow());
  it('rejects wrong action values and arbitrary fields', () => {
    expect(() => parseSettingsAction({ kind: 'adminMember', botId, openId: 'bad', membership: 'present', revision: 'x' })).toThrow();
    expect(() => parseSettingsEdit({ scope: agent, section: 'cards', revision: 'x', patch: { debug: true } })).toThrow();
  });
});
it('serializes card and HTTP preference edits, preserves unknown nested keys and secrets, reports running concurrency', async () => {
  const { owner, writer } = await fixture(); const view = await owner.read(agent) as AgentSettingsView;
  const [save] = await Promise.all([owner.save({ scope: agent, section: 'run', revision: view.sections.run.revision, patch: { maxConcurrentRuns: 7 } }), writer(p => { p.showToolCalls = false; })]);
  expect(save.kind).toBe('saved');
  const fresh = await owner.read(agent) as AgentSettingsView;
  expect(fresh.sections.run.stored.maxConcurrentRuns).toBe(7); expect(fresh.sections.run.effective.maxConcurrentRuns).toBe(10);
  expect(fresh.sections.cards.effective.showToolCalls).toBe(false);
  await owner.save({ scope: agent, section: 'completion', revision: fresh.sections.completion.revision, patch: { mode: 'always' } });
  await owner.save({ scope: agent, section: 'titles', revision: fresh.sections.titles.revision, patch: { byBackend: { 'codex-appserver': { enabled: false } } } });
  const disk = await loadConfig() as AppConfig & { futureRoot: number };
  expect(disk.accounts).toEqual(cfg.accounts); expect(disk.secrets).toEqual(cfg.secrets); expect(disk.futureRoot).toBe(17);
  expect(disk.preferences?.completionReminder).toMatchObject({ future: true, mode: 'always' });
  expect((disk.preferences as Record<string, unknown>).cliBridge).toEqual({ enabled: false, presence: { future: 8 } }); // 咖啡一下 left it, kept as is
  expect(disk.preferences?.sessionTitles?.byBackend?.['codex-appserver']).toMatchObject({ model: 'custom-title', future: 3, enabled: false });
  expect(JSON.stringify(fresh)).not.toMatch(/fixture-secret|SECRET|futurePreference|futureRoot/);
});
it('checks same-section revision inside owner queue', async () => {
  const { owner } = await fixture(); const view = await owner.read(agent) as AgentSettingsView;
  const results = await Promise.all([5, 6].map(maxConcurrentRuns => owner.save({ scope: agent, section: 'run', revision: view.sections.run.revision, patch: { maxConcurrentRuns } })));
  expect(results.map(r => r.kind)).toEqual(['saved', 'conflict']);
});
it('rejects external file changes and leaves LIVE untouched', async () => {
  const { owner } = await fixture(); const view = await owner.read(agent) as AgentSettingsView;
  await saveConfig({ ...cfg, preferences: { ...cfg.preferences, showToolCalls: false } });
  const result = await owner.save({ scope: agent, section: 'run', revision: view.sections.run.revision, patch: { maxConcurrentRuns: 5 } });
  expect(result.kind).toBe('rejected'); expect(cfg.preferences?.maxConcurrentRuns).toBeUndefined(); expect((await loadConfig()).preferences?.showToolCalls).toBe(false);
});
it('failed persistence cannot mutate nested live preferences', async () => {
  const write = createAppPreferencesWriter({ cfg, persistConfig: async () => { throw new Error('disk'); } });
  await expect(write(p => { p.sessionTitles!.byBackend!['codex-appserver'] = { enabled: false }; })).rejects.toThrow();
  expect(cfg.preferences?.sessionTitles?.byBackend?.['codex-appserver']).toMatchObject({ enabled: true, model: 'custom-title' });
});
it('validates models, allows custom title ids, resets actual project and session overrides', async () => {
  const { owner } = await fixture(); let p = await owner.read(project) as ProjectSettingsView;
  expect((await owner.save({ scope: project, section: 'model', revision: p.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'missing', effort: 'high' } } })).kind).toBe('rejected');
  expect((await owner.save({ scope: project, section: 'model', revision: p.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'fixture-model', effort: 'high' } } })).kind).toBe('saved');
  p = await owner.read(project) as ProjectSettingsView;
  await owner.save({ scope: project, section: 'model', revision: p.sections.model.revision, patch: { selection: { kind: 'default' } } });
  expect((await getProjectByName('demo'))?.defaultModel).toBeUndefined();
  const s = await owner.read(session) as SessionSettingsView;
  await owner.save({ scope: session, section: 'model', revision: s.sections.model.revision, patch: { selection: { kind: 'default' } } });
  expect(await getSession(session.threadId)).not.toHaveProperty('model'); expect(await getSession(session.threadId)).not.toHaveProperty('effort');
  const a = await owner.read(agent) as AgentSettingsView;
  expect((await owner.save({ scope: agent, section: 'titles', revision: a.sections.titles.revision, patch: { byBackend: { 'codex-appserver': { enabled: true, model: 'third-party-custom', effort: 'ultra' } } } })).kind).toBe('saved');
});
it('accepts hand-typed model ids for the project default and a topic, never for comments (3.11)', async () => {
  const { owner } = await fixture(); let p = await owner.read(project) as ProjectSettingsView;
  const custom = { kind: 'explicit' as const, model: ' kimi-k2 ', effort: 'xhigh' as const, custom: true };
  const stored = { kind: 'explicit', model: 'kimi-k2', effort: 'xhigh', custom: true };
  expect((await owner.save({ scope: project, section: 'model', revision: p.sections.model.revision, patch: { selection: custom } })).kind).toBe('saved');
  expect(await getProjectByName('demo')).toMatchObject({ defaultModel: 'kimi-k2', defaultEffort: 'xhigh', defaultModelCustom: true });
  p = await owner.read(project) as ProjectSettingsView;
  expect(p.sections.model.stored.selection).toEqual(stored);
  expect(p.sections.model.effective.selection).toEqual(stored); // not replaced by the catalog default
  expect((await owner.save({ scope: project, section: 'model', revision: p.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'fixture-model', effort: 'low' } } })).kind).toBe('saved');
  expect((await getProjectByName('demo'))?.defaultModelCustom).toBe(false);
  p = await owner.read(project) as ProjectSettingsView;
  expect((await owner.save({ scope: project, section: 'model', revision: p.sections.model.revision, patch: { selection: { ...custom, model: 'two words' } } })).kind).toBe('rejected');

  let s = await owner.read(session) as SessionSettingsView;
  expect((await owner.save({ scope: session, section: 'model', revision: s.sections.model.revision, patch: { selection: { ...custom, model: 'deepseek-chat' } } })).kind).toBe('saved');
  expect(await getSession(session.threadId)).toMatchObject({ model: 'deepseek-chat', effort: 'xhigh', modelCustom: true });
  s = await owner.read(session) as SessionSettingsView;
  expect(s.sections.model.stored.selection).toMatchObject({ model: 'deepseek-chat', custom: true });
  await owner.save({ scope: session, section: 'model', revision: s.sections.model.revision, patch: { selection: { kind: 'default' } } });
  expect(await getSession(session.threadId)).not.toHaveProperty('modelCustom');

  // A Claude topic only takes efforts the Claude protocol has.
  await upsertSession({ threadId: 'omt_claude', chatId: 'oc_demo', sessionId: 'native-claude', backend: 'claude-agent', cwd: '/tmp/demo', createdAt: 1, updatedAt: 1, summary: '' });
  const claudeTopic = { kind: 'session' as const, botId, threadId: 'omt_claude' };
  const c = await owner.read(claudeTopic) as SessionSettingsView;
  expect((await owner.save({ scope: claudeTopic, section: 'model', revision: c.sections.model.revision, patch: { selection: { ...custom, effort: 'ultra' } } })).kind).toBe('rejected');

  const a = await owner.read(agent) as AgentSettingsView;
  expect((await owner.save({ scope: agent, section: 'comments', revision: a.sections.comments.revision, patch: { selection: custom } })).kind).toBe('rejected');
});
it('stale resume identity conflicts and cannot change the replacement session', async () => {
  const { owner } = await fixture(); const old = await owner.read(session) as SessionSettingsView;
  const rec = (await getSession(session.threadId))!; await upsertSession({ ...rec, sessionId: 'native-two' });
  expect((await owner.save({ scope: session, section: 'model', revision: old.sections.model.revision, patch: { selection: { kind: 'default' } } })).kind).toBe('conflict');
  expect((await getSession(session.threadId))?.model).toBe('fixture-model');
});
it('membership operations retain owner and preserve concurrent project edits', async () => {
  const { owner } = await fixture(); const a = await owner.read(agent) as AgentSettingsView;
  expect((await owner.act({ kind: 'adminMember', botId, openId: 'ou_owner', membership: 'absent', revision: a.administrators.revision })).kind).toBe('rejected');
  const p = await owner.read(project) as ProjectSettingsView;
  await updateProject('demo', { noMention: false });
  expect((await owner.act({ kind: 'projectMember', botId, projectName: 'demo', openId: 'ou_member', membership: 'present', revision: p.members.revision })).kind).toBe('saved');
  const now = await owner.read(project) as ProjectSettingsView;
  await owner.act({ kind: 'projectMember', botId, projectName: 'demo', openId: 'ou_member', membership: 'absent', revision: now.members.revision });
  expect(await getProjectByName('demo')).toMatchObject({ noMention: false, allowedUsers: [] });
});
it('comment partial propagation reports saved master and retryable warning', async () => {
  let text = 'original';
  const { owner } = await fixture({ instructions: { read: async () => text, save: async next => { text = next; }, sync: async () => { throw new Error('partial'); } } });
  const view = await owner.read(agent) as AgentSettingsView;
  const result = await owner.act({ kind: 'commentInstructions', botId, revision: view.commentInstructions.revision, content: { kind: 'custom', text: 'Updated {fileToken}' } });
  expect(result.kind).toBe('saved'); if (result.kind === 'saved') expect(result.warnings).toHaveLength(1); expect(text).toBe('Updated {fileToken}');
});
it('returns the exact settings result through executor and real IPC responder', async () => {
  const { owner } = await fixture(); const executor = createAdminWriteExecutor({ settings: owner, backendFor: () => backend, evictLiveSessionsForChat: async () => {} });
  const caller = createAdminIpcCaller(request => responder(request));
  const responder = createAdminIpcResponder(op => op.kind === 'settingsRead' ? owner.read(op.scope) : executor(op as Parameters<typeof executor>[0]), response => caller.onMessage(response));
  const view = await caller.call({ kind: 'settingsRead', scope: agent }) as AgentSettingsView;
  const result = await caller.call({ kind: 'settingsPatch', edit: { scope: agent, section: 'cards', revision: view.sections.cards.revision, patch: { showToolCalls: false } } });
  expect(result).toMatchObject({ kind: 'saved', section: { section: 'cards', value: { stored: { showToolCalls: false } } } });
});
it('readonly owner never permits writes; failed catalogs do not disable unrelated settings', async () => {
  const { owner: readonly } = await fixture({ access: { kind: 'readonly', reason: 'owner-offline', message: 'Stopped' } });
  const view = await readonly.read(agent) as AgentSettingsView;
  expect((await readonly.save({ scope: agent, section: 'cards', revision: view.sections.cards.revision, patch: { showToolCalls: false } })).kind).toBe('unavailable');
  const { owner } = await fixture({ backendFor: () => ({ ...backend, listModels: async () => { throw new Error('private diagnostics'); } }) });
  const p = await owner.read(project) as ProjectSettingsView;
  expect((await owner.save({ scope: project, section: 'model', revision: p.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'fixture-model', effort: 'high' } } })).kind).toBe('rejected');
  expect((await owner.save({ scope: agent, section: 'cards', revision: view.sections.cards.revision, patch: { showToolCalls: false } })).kind).toBe('saved');
  expect(JSON.stringify(await owner.models({ botId, backend: 'codex-appserver', purpose: 'project' }))).not.toContain('private diagnostics');
});
it('project persistence survives failed runtime eviction with an explicit restart effect', async () => {
  const { owner } = await fixture({ evictLiveSessionsForChat: async () => { throw new Error('busy'); } });
  const view = await owner.read(project) as ProjectSettingsView;
  const result = await owner.save({ scope: project, section: 'permission', revision: view.sections.permission.revision, patch: { network: true } });
  expect(result.kind).toBe('saved'); if (result.kind === 'saved') expect(result.effects.some(e => e.when === 'restart')).toBe(true);
  expect((await getProjectByName('demo'))?.network).toBe(true);
});
it('s12: a stored autoCompact:false is ignored on read and the switch cannot be saved', async () => {
  // An old projects.json row with auto-compaction off; nothing migrates it.
  await updateProject('demo', JSON.parse('{"autoCompact":false}') as Parameters<typeof updateProject>[1]);
  const { owner } = await fixture();
  const view = await owner.read(project) as ProjectSettingsView;
  expect(Object.keys(view.sections).sort()).toEqual(['model', 'permission', 'response']);
  expect(JSON.stringify(view)).not.toContain('autoCompact');
  expect(() => parseSettingsEdit({ scope: project, section: 'compact', revision: 'x', patch: { autoCompact: true } })).toThrow('设置字段、类型或范围无效');
  expect(JSON.parse(await readFile(paths.projectsFile, 'utf8')).projects[0]).toMatchObject({ autoCompact: false });
});
it('s02c1, s02c5: an old config.json with 咖啡一下 settings loads, reads without them and keeps them byte for byte', async () => {
  // What s02b left on disk: the switch on and every field the 咖啡一下 type had
  // before s02c5 removed it, so this list is the only record of the old shape.
  const old = { enabled: true, delivery: 'always', includeBridgeOwnedSessionsForDebugging: true, notifyScope: 'bound_projects', agents: { claude: true, codex: false }, keepAwake: { enabled: true }, approval: { enabled: true, timeoutSeconds: 600 }, taskCompletion: { enabled: true, replyEnabled: false, replyTimeoutSeconds: 300 }, allowCache: { enabled: true, scope: 'session' }, presence: { enabled: true, platform: 'macos', idleThresholdSeconds: 120 } };
  await writeFile(paths.configFile, `${JSON.stringify({ ...cfg, preferences: { ...cfg.preferences, cliBridge: old } }, null, 2)}\n`);
  cfg = await loadConfig() as AppConfig;
  const before = JSON.parse(await readFile(paths.configFile, 'utf8'));
  const { owner } = await fixture();
  const view = await owner.read(agent) as AgentSettingsView;
  expect(Object.keys(view.sections)).toEqual(['cards', 'run', 'completion', 'comments', 'titles', 'paths', 'access']);
  expect(view).not.toHaveProperty('cliRuntime');
  expect(JSON.stringify(view)).not.toMatch(/cliBridge|notifyScope|keepAwake/);
  expect((await owner.save({ scope: agent, section: 'cards', revision: view.sections.cards.revision, patch: { showToolCalls: false } })).kind).toBe('saved');
  // The file is what the daemon wrote before plus the one saved field: the old
  // section, its key order and the other unknown keys are untouched.
  expect(await readFile(paths.configFile, 'utf8')).toBe(`${JSON.stringify({ ...before, preferences: { ...before.preferences, showToolCalls: false } }, null, 2)}\n`);
  expect(JSON.stringify(JSON.parse(await readFile(paths.configFile, 'utf8')).preferences.cliBridge)).toBe(JSON.stringify(old));
  expect(() => parseSettingsEdit({ scope: agent, section: 'cliBridge', revision: 'x', patch: { notifyScope: 'all' } })).toThrow('设置字段、类型或范围无效');
  for (const action of [{ kind: 'setCliBridgeEnabled', botId, enabled: false, revision: 'x' }, { kind: 'repairCliHooks', botId }, { kind: 'setHostCliRoute', botId: null, revision: 'x' }, { kind: 'repairHostCliHooks', agents: ['codex'] }])
    expect(() => parseSettingsAction(action)).toThrow('设置操作参数无效');
});
it('real instruction propagation retains saved master and reports partial filesystem failure', async () => {
  const { join } = await import('node:path');
  const healthy = join(paths.commentsRootDir, 'comment-docx-healthy');
  const broken = join(paths.commentsRootDir, 'comment-docx-broken');
  await mkdir(healthy, { recursive: true }); await mkdir(join(broken, 'AGENTS.md'), { recursive: true });
  const { owner } = await fixture(); const view = await owner.read(agent) as AgentSettingsView;
  const result = await owner.act({ kind: 'commentInstructions', botId, revision: view.commentInstructions.revision, content: { kind: 'custom', text: 'Use {fileToken} safely' } });
  expect(result.kind).toBe('saved'); if (result.kind === 'saved') expect(result.warnings).toHaveLength(1);
  expect(await readFile(paths.commentInstructionsFile, 'utf8')).toBe('Use {fileToken} safely');
  expect(await readFile(join(healthy, 'AGENTS.md'), 'utf8')).toBe('Use healthy safely');
});
