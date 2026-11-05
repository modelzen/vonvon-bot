import { buildAdminsCard, DM } from '../src/card/dm-cards';
import * as appRoles from '../src/config/app-roles';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { paths } from '../src/config/paths';
import { saveConfig, loadConfig } from '../src/config/store';
import { createAppPreferencesWriter, createAdminWriteExecutor } from '../src/admin/ops';
import { createSettingsOwner, type SettingsOwnerDeps } from '../src/admin/settings';
import { parseSettingsEdit, parseSettingsAction, parseModelQuery } from '../src/admin/settings-parse';
import type { AgentSettingsView, ProjectSettingsView, SessionSettingsView } from '../src/admin/settings-types';
import { addDmProject, addProject, dmChatId, dmProject, getProjectByName, updateProject } from '../src/project/registry';
import { getSession, RETIRED_KEY_TEXT, upsertSession } from '../src/bot/session-store';
import { createAdminIpcCaller, createAdminIpcResponder } from '../src/admin/ipc';
import type { AppConfig } from '../src/config/schema';
import type { AgentBackend } from '../src/agent/types';
import { offlineModelCatalog, rememberModelCatalog } from '../src/admin/model-catalog';
import { permissionTable, permissionTiers } from '../src/agent/permission';
import { FULL_ACCESS_WARNING } from '@vonvon/protocol';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'settings-owner-'));
  return { botDir: (id: string) => join(appDir, 'bots', id), botPaths: (id: string) => ({ dir: join(appDir, 'bots', id) }), paths: { appDir, configFile: join(appDir, 'config.json'), projectsFile: join(appDir, 'projects.json'), sessionsFile: join(appDir, 'sessions.json'), commentInstructionsFile: join(appDir, 'instructions.md'), commentsRootDir: join(appDir, 'comments') } };
});
const botId = 'cli_fixture';
const agent = { kind: 'agent' as const, botId };
const project = { kind: 'project' as const, botId, projectName: 'demo' };
const session = { kind: 'session' as const, botId, threadId: 'omt_fixture' };
const fixtureModels = [{ id: 'fixture-model', displayName: 'Fixture', description: '', defaultEffort: 'high', supportedEfforts: ['low', 'high'], isDefault: true, hidden: false, serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Fast' }, { id: 'ultrafast', name: 'Ultra fast', description: 'Ultra fast' }] }] as Awaited<ReturnType<AgentBackend['listModels']>>;
const backend = { id: 'codex-appserver', doctor: async () => ({ ok: true }), supportedModes: ['qa', 'write', 'full'], listModels: async () => fixtureModels, peekModels: () => fixtureModels } as unknown as AgentBackend;
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
  await owner.save({ scope: agent, section: 'titles', revision: fresh.sections.titles.revision, patch: { policy: { enabled: false } } });
  const disk = await loadConfig() as AppConfig & { futureRoot: number };
  expect(disk.accounts).toEqual(cfg.accounts); expect(disk.secrets).toEqual(cfg.secrets); expect(disk.futureRoot).toBe(17);
  expect(disk.preferences?.completionReminder).toMatchObject({ future: true, mode: 'always' });
  expect((disk.preferences as Record<string, unknown>).cliBridge).toEqual({ enabled: false, presence: { future: 8 } }); // 咖啡一下 left it, kept as is
  expect(disk.preferences?.sessionTitles?.byBackend?.['codex-appserver']).toMatchObject({ model: 'custom-title', future: 3, enabled: true });
  expect(disk.preferences?.sessionTitles?.policy).toEqual({ enabled: false });
  expect(JSON.stringify(fresh)).not.toMatch(/fixture-secret|SECRET|futurePreference|futureRoot/);
});
it('saves one title provider for the Bot, validates it and conflicts on stale edits', async () => {
  const { owner } = await fixture();
  const before = await owner.read(agent) as AgentSettingsView;
  const policy = { enabled: true as const, backend: 'claude-agent', model: 'vendor/title', effort: 'low' as const };
  const edit = { scope: agent, section: 'titles' as const, revision: before.sections.titles.revision, patch: { policy } };
  expect((await owner.save(edit)).kind).toBe('saved');
  const after = await owner.read(agent) as AgentSettingsView;
  expect(after.sections.titles.stored).toEqual({ policy });
  expect(after.sections.titles.effective).toEqual({ policy });
  expect((await owner.save(edit)).kind).toBe('conflict');
  for (const invalid of [{ ...policy, backend: 'unknown' }, { ...policy, effort: 'ultra' }]) {
    expect((await owner.save({ ...edit, revision: after.sections.titles.revision, patch: { policy: invalid as typeof policy } })).kind).toBe('rejected');
  }
  expect(() => parseSettingsEdit({ ...edit, patch: { policy: { enabled: false, backend: 'claude-agent' } } })).toThrow();
  expect((await owner.save({ ...edit, revision: after.sections.titles.revision, patch: { policy: { enabled: false } } })).kind).toBe('saved');
  expect((await owner.read(agent) as AgentSettingsView).sections.titles.effective).toEqual({ policy: { enabled: false } });
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
  expect((await owner.save({ scope: agent, section: 'titles', revision: a.sections.titles.revision, patch: { policy: { enabled: true, backend: 'codex-appserver', model: 'third-party-custom', effort: 'ultra' } } })).kind).toBe('saved');
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
it('refuses a session key retired in s15c, to read or to save, before touching the record', async () => {
  const retired = { kind: 'session' as const, botId, threadId: `${session.threadId}#admin` };
  await upsertSession({ ...(await getSession(session.threadId))!, threadId: retired.threadId });
  const mutateSession = vi.fn<NonNullable<SettingsOwnerDeps['mutateSession']>>();
  const { owner } = await fixture({ mutateSession });
  await expect(owner.read(retired)).rejects.toThrow(RETIRED_KEY_TEXT);
  expect(await owner.save({ scope: retired, section: 'model', revision: 'r', patch: { selection: { kind: 'default' } } }))
    .toEqual({ kind: 'rejected', fields: [{ field: 'settings', message: RETIRED_KEY_TEXT }] });
  expect(mutateSession).not.toHaveBeenCalled();
  expect((await owner.read(session)).scope).toEqual(session);
});
it('stale resume identity conflicts and cannot change the replacement session', async () => {
  const { owner } = await fixture(); const old = await owner.read(session) as SessionSettingsView;
  const rec = (await getSession(session.threadId))!; await upsertSession({ ...rec, sessionId: 'native-two' });
  expect((await owner.save({ scope: session, section: 'model', revision: old.sections.model.revision, patch: { selection: { kind: 'default' } } })).kind).toBe('conflict');
  expect((await getSession(session.threadId))?.model).toBe('fixture-model');
});
it('speed settings stay on each session, default standard, and reject stale writes', async () => {
  const { owner } = await fixture();
  const group = await owner.read(project) as ProjectSettingsView;
  expect(group.sections.speed?.stored.tier).toBe('inherit');
  expect((await owner.save({ scope: project, section: 'speed', revision: group.sections.speed!.revision, patch: { tier: 'fast' } })).kind).toBe('saved');
  const first = await owner.read(session) as SessionSettingsView;
  expect(first.sections.speed?.effective.tier).toBe('standard');
  expect((await owner.save({ scope: session, section: 'speed', revision: first.sections.speed!.revision, patch: { tier: 'ultrafast' } })).kind).toBe('saved');
  expect((await (await fixture()).owner.read(session) as SessionSettingsView).sections.speed?.stored.tier).toBe('ultrafast');
  expect((await owner.save({ scope: session, section: 'speed', revision: first.sections.speed!.revision, patch: { tier: 'standard' } })).kind).toBe('conflict');
  await upsertSession({ ...(await getSession(session.threadId))!, threadId: 'omt_second', sessionId: 'native-two', serviceTier: undefined });
  const secondScope = { kind: 'session' as const, botId, threadId: 'omt_second' };
  const second = await owner.read(secondScope) as SessionSettingsView;
  expect(second.sections.speed?.effective.tier).toBe('standard');
  const now = await owner.read(session) as SessionSettingsView;
  expect(now.sections.speed?.effective.tier).toBe('ultrafast');
  expect((await owner.save({ scope: session, section: 'speed', revision: now.sections.speed!.revision, patch: { tier: 'standard' } })).kind).toBe('saved');
  expect(await getSession(session.threadId)).not.toHaveProperty('serviceTier');
  expect((await owner.read(session) as SessionSettingsView).sections.speed?.effective.tier).toBe('standard');
  const currentGroup = await owner.read(project) as ProjectSettingsView;
  expect((await owner.save({ scope: project, section: 'speed', revision: currentGroup.sections.speed!.revision, patch: { tier: 'inherit' } })).kind).toBe('saved');
  expect(await getProjectByName('demo')).not.toHaveProperty('serviceTier');
  expect((await owner.read(session) as SessionSettingsView).sections.speed?.effective.tier).toBe('standard');
});
it('speed refuses unsupported metadata, custom models and non-Codex sessions', async () => {
  const { owner } = await fixture();
  const view = await owner.read(session) as SessionSettingsView;
  const bad = await fixture({ backendFor: () => ({ ...backend, peekModels: () => [{ ...fixtureModels[0]!, serviceTiers: [] }] }) });
  expect((await bad.owner.save({ scope: session, section: 'speed', revision: view.sections.speed!.revision, patch: { tier: 'fast' } })).kind).toBe('rejected');
  expect((await bad.owner.save({ scope: session, section: 'speed', revision: view.sections.speed!.revision, patch: { tier: 'standard' } })).kind).toBe('saved');
  await upsertSession({ ...(await getSession(session.threadId))!, threadId: 'omt_claude_speed', backend: 'claude-agent', sessionId: 'claude-one' });
  const claude = { kind: 'session' as const, botId, threadId: 'omt_claude_speed' };
  const claudeView = await owner.read(claude) as SessionSettingsView;
  expect((await owner.save({ scope: claude, section: 'speed', revision: claudeView.sections.speed!.revision, patch: { tier: 'standard' } })).kind).toBe('rejected');
  expect(() => parseSettingsEdit({ scope: session, section: 'speed', revision: 'r', patch: { tier: 'turbo' } })).toThrow();
});
it('model changes automatically reset an unsupported speed to standard', async () => {
  const { owner } = await fixture();
  const before = await owner.read(session) as SessionSettingsView;
  expect((await owner.save({ scope: session, section: 'speed', revision: before.sections.speed!.revision, patch: { tier: 'fast' } })).kind).toBe('saved');
  const current = await owner.read(session) as SessionSettingsView;
  expect((await owner.save({ scope: session, section: 'model', revision: current.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'custom-model', effort: 'high', custom: true } } })).kind).toBe('saved');
  expect((await getSession(session.threadId))?.model).toBe('custom-model');
  expect((await owner.read(session) as SessionSettingsView).sections.speed?.effective.tier).toBe('standard');
});
it('group speed does not cascade to sessions and session inherit is invalid', async () => {
  const otherModel = { ...fixtureModels[0]!, id: 'second-model', isDefault: false, serviceTiers: [] };
  const offered = [...fixtureModels, otherModel];
  const { owner } = await fixture({ backendFor: () => ({ ...backend, listModels: async () => offered, peekModels: () => offered }) });
  await upsertSession({ ...(await getSession(session.threadId))!, threadId: 'omt_speed_other', sessionId: 'native-other', model: 'second-model' });
  const other = { kind: 'session' as const, botId, threadId: 'omt_speed_other' };
  let group = await owner.read(project) as ProjectSettingsView;
  expect((await owner.save({ scope: project, section: 'speed', revision: group.sections.speed!.revision, patch: { tier: 'fast' } })).kind).toBe('saved');
  let topic = await owner.read(other) as SessionSettingsView;
  expect((await owner.save({ scope: other, section: 'speed', revision: topic.sections.speed!.revision, patch: { tier: 'standard' } })).kind).toBe('saved');
  topic = await owner.read(other) as SessionSettingsView;
  expect(topic.sections.speed?.effective.tier).toBe('standard');
  expect(() => parseSettingsEdit({ scope: other, section: 'speed', revision: topic.sections.speed!.revision, patch: { tier: 'inherit' } })).toThrow();
  expect(await getSession(other.threadId)).not.toHaveProperty('serviceTier');
});
it('settings read reports standard effective speed without erasing an unsupported saved preference', async () => {
  await upsertSession({ ...(await getSession(session.threadId))!, serviceTier: 'fast' });
  const unsupported = [{ ...fixtureModels[0]!, serviceTiers: [] }];
  const { owner } = await fixture({ backendFor: () => ({ ...backend, listModels: async () => unsupported, peekModels: () => unsupported }) });
  const view = await owner.read(session) as SessionSettingsView;
  expect(view.sections.speed?.stored.tier).toBe('fast');
  expect(view.sections.speed?.effective.tier).toBe('standard');
  expect((await getSession(session.threadId))?.serviceTier).toBe('fast');
});
it('an unconfirmed catalog uses standard effectively and preserves the stored preference', async () => {
  await upsertSession({ ...(await getSession(session.threadId))!, serviceTier: 'ultrafast' });
  const { owner } = await fixture({ backendFor: () => ({ ...backend, peekModels: () => undefined }) });
  expect((await owner.read(session) as SessionSettingsView).sections.speed?.effective.tier).toBe('standard');
  expect((await getSession(session.threadId))?.serviceTier).toBe('ultrafast');
});
it('session catalog and speed saves use the session cwd capability', async () => {
  const local = [{ ...fixtureModels[0]!, serviceTiers: [] }];
  const listModelsForCwd = vi.fn(async (_cwd: string) => local);
  const { owner } = await fixture({ backendFor: () => ({ ...backend, listModelsForCwd }) });
  const catalog = await owner.models({ botId, backend: 'codex-appserver', purpose: 'session', threadId: session.threadId });
  expect(listModelsForCwd).toHaveBeenCalledWith('/tmp/demo', { refresh: undefined });
  expect(catalog).toMatchObject({ state: 'ready', models: local });
  await owner.models({ botId, backend: 'codex-appserver', purpose: 'session', threadId: session.threadId, refresh: true });
  expect(listModelsForCwd).toHaveBeenLastCalledWith('/tmp/demo', { refresh: true });
  expect(() => parseModelQuery({ botId, backend: 'codex-appserver', purpose: 'project', threadId: session.threadId })).toThrow();
  const view = await owner.read(session) as SessionSettingsView;
  expect((await owner.save({ scope: session, section: 'speed', revision: view.sections.speed!.revision, patch: { tier: 'fast' } })).kind).toBe('rejected');
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
  const result = await owner.save({ scope: project, section: 'permission', revision: view.sections.permission.revision, patch: { mode: 'write' } });
  expect(result.kind).toBe('saved'); if (result.kind === 'saved') expect(result.effects.some(e => e.when === 'restart')).toBe(true);
  expect((await getProjectByName('demo'))?.network).toBe(true);
});
it('s31c: a full-only backend refuses unavailable tiers and custom, while unrelated edits retain a stored 只读', async () => {
  expect((await (await fixture()).owner.read(project) as ProjectSettingsView).identity).not.toHaveProperty('fullOnly');
  await updateProject('demo', { mode: 'qa' });
  const { owner } = await fixture({ backendFor: () => ({ ...backend, fullAccessOnly: () => 'only full here' }) });
  let view = await owner.read(project) as ProjectSettingsView;
  expect(view.identity.fullOnly).toBe('only full here');
  for (const patch of [{ mode: 'qa' }, { mode: 'write' }] as const) {
    const result = await owner.save({ scope: project, section: 'permission', revision: view.sections.permission.revision, patch });
    expect(result).toEqual({ kind: 'rejected', fields: [{ field: 'settings', message: 'only full here' }] });
  }
  expect((await owner.save({ scope: project, section: 'permission', revision: view.sections.permission.revision, patch: { custom: { sandbox: 'read-only', network: false } } }))).toEqual({ kind: 'rejected', fields: [{ field: 'settings', message: 'only full here' }] });
  expect(view.sections.permission.stored.options.tiers[0]?.unavailable).toBe('only full here');
  expect((await owner.save({ scope: project, section: 'presentation', revision: view.sections.presentation!.revision, patch: { showToolCalls: false } })).kind).toBe('saved');
  expect(await getProjectByName('demo')).toMatchObject({ mode: 'qa' });
  view = await owner.read(project) as ProjectSettingsView;
  expect((await owner.save({ scope: project, section: 'permission', revision: view.sections.permission.revision, patch: { mode: 'full' } })).kind).toBe('saved');
  expect((await getProjectByName('demo'))?.mode).toBe('full');
});
// main 必败: choosing 完全访问 for a group said nothing about group members (devices 第 15 节, devices-ui-2 4.10)
describe('the private-chat row (dm-agent 4.2)', () => {
  const dm = { kind: 'project' as const, botId, projectName: dmChatId(botId) };
  beforeEach(async () => {
    await addDmProject({ name: '私聊', chatId: dmChatId(botId), cwd: '/tmp/dm', blank: true, origin: 'created', kind: 'single', noMention: true, mode: 'full', network: true, createdAt: 1, backend: 'codex-appserver',
      modelAccess: { backend: 'codex-appserver', models: ['fixture-model'], efforts: ['high'] }, dm: { people: { oc_a: { openId: 'ou_a', at: 1 }, oc_b: { openId: 'ou_b', at: 2 } } } });
  });
  const save = async (owner: Awaited<ReturnType<typeof fixture>>['owner'], section: string, patch: unknown) => {
    const view = await owner.read(dm) as ProjectSettingsView;
    const current = view.sections[section as keyof ProjectSettingsView['sections']];
    return owner.save({ scope: dm, section, revision: current?.revision ?? 'x', patch } as never);
  };
  it('reads by oc_dm_<appId>, with no roster to ask Feishu for', async () => {
    const responseRoster = vi.fn(async () => { throw new Error('not a group'); });
    const { owner } = await fixture({ responseRoster, discoverSkills: async () => [] });
    const view = await owner.read(dm) as ProjectSettingsView;
    expect(view.identity.chatId).toBe(dmChatId(botId));
    expect(responseRoster).not.toHaveBeenCalled();
  });
  it('is not a group name: a name finds nothing', async () => {
    const { owner } = await fixture({ discoverSkills: async () => [] });
    await expect(owner.read({ ...dm, projectName: '私聊' })).rejects.toThrow('项目不存在');
  });
  it('saves skills and the allowset, and rebinds each person\'s chat', async () => {
    const evictLiveSessionsForChat = vi.fn(async (_chatId: string) => {});
    const { owner } = await fixture({ evictLiveSessionsForChat, discoverSkills: async () => [] });
    expect((await save(owner, 'skills', { disabledPaths: ['/x'] })).kind).toBe('saved');
    expect((await dmProject())?.skills?.disabledPaths).toEqual(['/x']);
    expect(evictLiveSessionsForChat.mock.calls.map(([chat]) => chat).sort()).toEqual(['oc_a', 'oc_b']);
    expect((await save(owner, 'modelAccess', { efforts: ['low', 'high'] })).kind).toBe('saved');
    const row = await dmProject();
    expect(row?.modelAccess?.efforts).toEqual(['low', 'high']);
    expect(row?.mode).toBe('full');
    expect(row?.chatId).toBe(dmChatId(botId));
    expect(row?.dm?.people.oc_a?.openId).toBe('ou_a');
  });
  it('saves the model and the speed', async () => {
    const { owner } = await fixture({ discoverSkills: async () => [] });
    expect((await save(owner, 'model', { selection: { kind: 'explicit', model: 'fixture-model', effort: 'high' } })).kind).toBe('saved');
    expect((await dmProject())?.defaultModel).toBe('fixture-model');
    expect((await save(owner, 'speed', { tier: 'fast' })).kind).toBe('saved');
    expect((await dmProject())?.serviceTier).toBe('fast');
  });
  it.each([['permission', { mode: 'qa' }], ['workspace', { primary: '/tmp/x' }], ['response', { noMention: false }], ['run', { pendingPolicy: 'queue' }], ['role', { supplement: 'x' }],
    ['smartRules', { respond: 'x' }], ['presentation', { voiceEnabled: false }], ['judge', { selection: { kind: 'default' } }]])('refuses %s', async (section, patch) => {
    const { owner } = await fixture({ discoverSkills: async () => [] });
    const before = await dmProject();
    expect(await save(owner, section, patch)).toMatchObject({ kind: 'rejected', fields: [{ message: '私聊只能改模型、速度、可选模型和技能' }] });
    expect(await dmProject()).toEqual(before);
  });
  it('member actions do not reach it', async () => {
    const { owner } = await fixture({ discoverSkills: async () => [] });
    expect(await owner.act({ kind: 'projectAudience', botId, projectName: dmChatId(botId), audience: 'all', revision: 'x' } as never)).toMatchObject({ kind: 'rejected' });
    expect((await dmProject())?.allowedUsers).toBeUndefined();
  });
});

describe('完全访问 group warning', () => {
  it('only a group\'s full tier carries the warning', () => {
    expect(permissionTiers({ platform: 'linux', group: true }).map(tier => tier.warning)).toEqual([undefined, undefined, FULL_ACCESS_WARNING]);
    expect(permissionTiers({ platform: 'linux' }).some(tier => tier.warning)).toBe(false);
  });
  it('warns when a group turns 完全访问, not when it already was', async () => {
    await updateProject('demo', { mode: 'write', network: true });
    const { owner } = await fixture();
    let view = await owner.read(project) as ProjectSettingsView;
    expect(view.sections.permission.stored.options.tiers.find(tier => tier.tier === 'full')?.warning).toBe(FULL_ACCESS_WARNING);
    expect(await owner.save({ scope: project, section: 'permission', revision: view.sections.permission.revision, patch: { mode: 'full' } }))
      .toMatchObject({ kind: 'saved', warnings: [FULL_ACCESS_WARNING] });
    view = await owner.read(project) as ProjectSettingsView;
    const again = await owner.save({ scope: project, section: 'permission', revision: view.sections.permission.revision, patch: { mode: 'full' } });
    expect(again.kind).toBe('saved');
    expect(again).not.toHaveProperty('warnings');
    view = await owner.read(project) as ProjectSettingsView;
    expect(await owner.save({ scope: project, section: 'permission', revision: view.sections.permission.revision, patch: { mode: 'qa' } })).not.toHaveProperty('warnings');
  });
});

describe('s31c permission settings', () => {
  const custom = { backend: 'codex-appserver', settings: { sandbox: 'read-only', network: true } };
  it.each([
    [{ mode: 'write' }, 'write', true, undefined],
    [{ custom: { sandbox: 'workspace-write', network: true } }, 'write', true, undefined],
    [{ custom: custom.settings }, 'qa', true, custom],
    [{ mode: 'qa', custom: null }, 'qa', false, undefined],
    [{ mode: 'write', custom: null }, 'write', true, undefined],
  ] as const)('saves patch %j with canonical stored effects', async (patch, mode, network, expectedCustom) => {
    await updateProject('demo', { mode: 'qa', network: true, custom });
    const evict = vi.fn(async () => {});
    const { owner } = await fixture({ evictLiveSessionsForChat: evict });
    const before = await owner.read(project) as ProjectSettingsView;
    expect((await owner.save({ scope: project, section: 'permission', revision: before.sections.permission.revision, patch })).kind).toBe('saved');
    const saved = (await getProjectByName('demo'))!;
    expect(saved).toMatchObject({ mode, network });
    expect(saved.custom).toEqual(expectedCustom);
    if (!expectedCustom) expect(saved).not.toHaveProperty('custom');
    expect(evict).toHaveBeenCalledOnce();
  });
  it('rejects choosing a tier and non-null custom settings together', async () => {
    const { owner } = await fixture();
    const before = await owner.read(project) as ProjectSettingsView;
    const disk = await readFile(paths.projectsFile, 'utf8');
    expect(await owner.save({ scope: project, section: 'permission', revision: before.sections.permission.revision, patch: { mode: 'full', custom: custom.settings } })).toMatchObject({ kind: 'rejected', fields: [{ message: '选档和高级设置一次只改一个' }] });
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(disk);
  });
  it.each([
    [{ mode: 'write', network: false }, 'write', true],
    [{ mode: 'full', network: true, custom: { ...custom, settings: { bad: true } } }, 'qa', false],
    [{ mode: 'qa', network: true, custom }, 'qa', false],
  ] as const)('requires a tier when clearing custom state %j, then switches with the safe tier', async (initial, mode, network) => {
    await updateProject('demo', initial);
    const evict = vi.fn(async () => {});
    const { owner } = await fixture({ backendFor: id => ({ ...backend, id }), evictLiveSessionsForChat: evict });
    const before = await owner.read(project) as ProjectSettingsView;
    const disk = await readFile(paths.projectsFile, 'utf8');
    expect(await owner.save({ scope: project, section: 'permission', revision: before.sections.permission.revision, patch: { custom: null } })).toMatchObject({ kind: 'rejected', fields: [{ message: '清掉高级设置时要同时选一档，例如 permission.mode=qa。' }] });
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(disk);
    expect(evict).not.toHaveBeenCalled();
    expect((await owner.save({ scope: project, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch: { backend: 'claude-agent', models: ['fixture-model'], efforts: ['high'] } })).kind).toBe('saved');
    expect(await getProjectByName('demo')).toMatchObject({ mode, network, backend: 'claude-agent' });
    expect((await getProjectByName('demo'))!).not.toHaveProperty('custom');
  });
  it.each([{}, { mode: 'full', network: false }, { mode: 'qa', network: false }] as const)('clearing absent custom is a complete no-op for %j', async initial => {
    await updateProject('demo', initial);
    const evict = vi.fn(async () => {});
    const { owner } = await fixture({ backendFor: () => ({ ...backend, fullAccessOnly: () => 'only full here' }), evictLiveSessionsForChat: evict });
    const before = await owner.read(project) as ProjectSettingsView;
    const disk = await readFile(paths.projectsFile, 'utf8');
    let committed = false;
    expect(await owner.save({ scope: project, section: 'permission', revision: before.sections.permission.revision, patch: { custom: null } }, { beforeCommit: () => { committed = true; } })).toMatchObject({ kind: 'saved', effects: [] });
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(disk);
    expect(committed).toBe(false);
    expect(evict).not.toHaveBeenCalled();
  });
  it('rejects network patches explicitly, malformed custom and unsupported tiers', async () => {
    expect(() => parseSettingsEdit({ scope: project, section: 'permission', revision: 'r', patch: { network: true } })).toThrow('联网已经并进权限的档位');
    for (const value of [[], 'x', 3]) expect(() => parseSettingsEdit({ scope: project, section: 'permission', revision: 'r', patch: { custom: value } })).toThrow();
    const { owner } = await fixture({ backendFor: () => ({ ...backend, supportedModes: ['full'] }) });
    const before = await owner.read(project) as ProjectSettingsView;
    expect(await owner.save({ scope: project, section: 'permission', revision: before.sections.permission.revision, patch: { custom: { sandbox: 'unknown' } } })).toMatchObject({ kind: 'rejected', fields: [{ message: expect.stringContaining('Codex 高级设置') }] });
    expect(await owner.save({ scope: project, section: 'permission', revision: before.sections.permission.revision, patch: { mode: 'write' } })).toMatchObject({ kind: 'rejected', fields: [{ message: '这个 provider 没有这一档。' }] });
  });
  it('shows legacy/custom/invalid states and includes custom in conflict revisions', async () => {
    const { owner } = await fixture();
    await updateProject('demo', { mode: 'write', network: false });
    let view = await owner.read(project) as ProjectSettingsView;
    expect(view.sections.permission.stored).toMatchObject({ network: false, custom: { sandbox: 'workspace-write', network: false }, options: { legacy: true, customSummary: expect.stringContaining('网络：关') } });
    expect((await getProjectByName('demo'))!).not.toHaveProperty('custom');
    await updateProject('demo', { mode: 'qa', network: true, custom });
    view = await owner.read(project) as ProjectSettingsView;
    expect(view.sections.permission.stored.options.customSummary).toContain('只读（read-only）');
    expect(view.sections.permission.stored.options).not.toHaveProperty('legacy');
    await updateProject('demo', { custom: { ...custom, settings: { sandbox: 'read-only', network: false } } });
    const changed = await owner.read(project) as ProjectSettingsView;
    expect(changed.sections.permission.revision).not.toBe(view.sections.permission.revision);
    expect((await owner.save({ scope: project, section: 'permission', revision: view.sections.permission.revision, patch: { mode: 'write' } })).kind).toBe('conflict');
    await updateProject('demo', { mode: 'full', custom: { ...custom, settings: { bad: true } } });
    expect((await owner.read(project) as ProjectSettingsView).sections.permission.stored).toMatchObject({ mode: 'qa', custom: null, network: false, options: { invalid: true } });
  });
  it.each([true, false])('clears custom and legacy network only on a real provider switch (custom=%s)', async explicit => {
    await updateProject('demo', { mode: 'write', network: false, ...(explicit ? { custom } : {}) });
    const { owner } = await fixture({ backendFor: id => ({ ...backend, id }) });
    let view = await owner.read(project) as ProjectSettingsView;
    expect((await owner.save({ scope: project, section: 'modelAccess', revision: view.sections.modelAccess!.revision, patch: { backend: 'codex-appserver', models: ['fixture-model'], efforts: ['high'] } })).kind).toBe('saved');
    expect((await getProjectByName('demo'))?.network).toBe(false);
    if (explicit) expect((await getProjectByName('demo'))?.custom).toEqual(custom);
    view = await owner.read(project) as ProjectSettingsView;
    expect((await owner.save({ scope: project, section: 'modelAccess', revision: view.sections.modelAccess!.revision, patch: { backend: 'claude-agent', models: ['fixture-model'], efforts: ['high'] } })).kind).toBe('saved');
    expect(await getProjectByName('demo')).toMatchObject({ mode: 'write', network: true, backend: 'claude-agent' });
    expect((await getProjectByName('demo'))!).not.toHaveProperty('custom');
    view = await owner.read(project) as ProjectSettingsView;
    expect(view.sections.permission.stored.options.tiers[0]?.native).toContain('Claude：');
    expect((await owner.save({ scope: project, section: 'permission', revision: view.sections.permission.revision, patch: { custom: custom.settings } })).kind).toBe('rejected');
  });
  it('allows switching to a provider on which the stored tier is unavailable', async () => {
    await updateProject('demo', { backend: 'claude-agent', mode: 'qa', network: true });
    const { owner } = await fixture({ backendFor: id => ({ ...backend, id, fullAccessOnly: () => id === 'codex-appserver' ? 'only full here' : undefined }) });
    const before = await owner.read(project) as ProjectSettingsView;
    expect((await owner.save({ scope: project, section: 'modelAccess', revision: before.sections.modelAccess!.revision, patch: { backend: 'codex-appserver', models: ['fixture-model'], efforts: ['high'] } })).kind).toBe('saved');
    expect(await getProjectByName('demo')).toMatchObject({ mode: 'qa', network: false });
    const after = await owner.read(project) as ProjectSettingsView;
    expect(after.sections.permission.stored).toMatchObject({ mode: 'qa', options: { tiers: [expect.objectContaining({ tier: 'qa', unavailable: 'only full here' }), expect.anything(), expect.anything()] } });
  });
});
describe('s31d native permission settings', () => {
  const claude = permissionTable('claude-agent');
  it.each([
    [{ permissionMode: 'acceptEdits', sandbox: true, network: 'all' }, 'write', true, false],
    [{ permissionMode: 'plan' }, 'qa', false, true],
    [{ permissionMode: 'default', network: 'domains', domains: ['github.com'] }, 'qa', false, true],
    [{ permissionMode: 'bypassPermissions', sandbox: true }, 'write', true, true],
    [{ permissionMode: 'plan', network: 'domains', domains: ['github.com'] }, 'qa', false, true],
  ] as const)('saves %j using conservative downgrade fields and shows native effects', async (raw, mode, network, hasCustom) => {
    await updateProject('demo', { backend: 'claude-agent' });
    const { owner } = await fixture({ backendFor: id => ({ ...backend, id }) });
    const before = await owner.read(project) as ProjectSettingsView;
    expect((await owner.save({ scope: project, section: 'permission', revision: before.sections.permission.revision, patch: { custom: raw } })).kind).toBe('saved');
    const saved = (await getProjectByName('demo'))!;
    expect(saved).toMatchObject({ mode, network });
    expect(saved.custom).toEqual(hasCustom ? { backend: 'claude-agent', settings: claude.parseCustom(raw) } : undefined);
    const after = (await owner.read(project) as ProjectSettingsView).sections.permission.stored;
    expect(after.network).toBe(claude.effect(claude.parseCustom(raw)).network);
    expect(after.options.fields).toEqual(claude.fields({ platform: process.platform }));
    expect(after.options.expanded.write).toEqual(claude.expand('write'));
    expect(after.options.customSummary).toBe(hasCustom ? claude.describe(raw) : undefined);
  });
  it('checks the native effect tier even when downgrade fields are read-only', async () => {
    await updateProject('demo', { backend: 'claude-agent' });
    const { owner } = await fixture({ backendFor: () => ({ ...backend, supportedModes: ['qa'] }) });
    const before = await owner.read(project) as ProjectSettingsView;
    expect(await owner.save({ scope: project, section: 'permission', revision: before.sections.permission.revision, patch: { custom: { permissionMode: 'plan' } } })).toMatchObject({ kind: 'rejected', fields: [{ message: '这个 provider 没有这一档。' }] });
    expect((await getProjectByName('demo'))!).not.toHaveProperty('custom');
  });
});
it('s21: a group overrides 运行中来了消息, "default" goes back to the bot, Claude shows queue', async () => {
  const { owner } = await fixture();
  let view = await owner.read(project) as ProjectSettingsView;
  expect(view.sections.run.stored).toEqual({ pendingPolicy: 'default' });
  expect(view.sections.run.effective).toEqual({ pendingPolicy: 'steer' });
  expect(await owner.save({ scope: project, section: 'run', revision: view.sections.run.revision, patch: { pendingPolicy: 'queue' } })).toMatchObject({ kind: 'saved' });
  expect(await getProjectByName('demo')).toMatchObject({ pendingPolicy: 'queue' });
  view = await owner.read(project) as ProjectSettingsView;
  expect(view.sections.run).toMatchObject({ stored: { pendingPolicy: 'queue' }, effective: { pendingPolicy: 'queue' } });
  await owner.save({ scope: project, section: 'run', revision: view.sections.run.revision, patch: { pendingPolicy: 'default' } });
  expect(await getProjectByName('demo')).not.toHaveProperty('pendingPolicy');
  expect(() => parseSettingsEdit({ scope: project, section: 'run', revision: 'x', patch: { pendingPolicy: 'other' } })).toThrow();
  await updateProject('demo', { backend: 'claude-agent', pendingPolicy: 'steer' });
  view = await owner.read(project) as ProjectSettingsView;
  expect(view.sections.run).toMatchObject({ stored: { pendingPolicy: 'steer' }, effective: { pendingPolicy: 'queue' } });
  expect(view.sections.run.apply[0]?.detail).toContain('Claude 不支持插话');
});
it('s12: a stored autoCompact:false is ignored on read and the switch cannot be saved', async () => {
  // An old projects.json row with auto-compaction off; nothing migrates it.
  await updateProject('demo', JSON.parse('{"autoCompact":false}') as Parameters<typeof updateProject>[1]);
  const { owner } = await fixture();
  const view = await owner.read(project) as ProjectSettingsView;
  expect(Object.keys(view.sections).sort()).toEqual(['judge', 'model', 'modelAccess', 'permission', 'presentation', 'profile', 'response', 'role', 'run', 'skills', 'smartRules', 'speed', 'workspace']);
  expect(JSON.stringify(view)).not.toContain('autoCompact');
  expect(() => parseSettingsEdit({ scope: project, section: 'compact', revision: 'x', patch: { autoCompact: true } })).toThrow('设置字段、类型或范围无效');
  expect(JSON.parse(await readFile(paths.projectsFile, 'utf8')).projects[0]).toMatchObject({ autoCompact: false });
});
it('s02c1, s02c5: an old config.json with 咖啡一下 settings loads, reads without them and keeps them byte for byte', async () => {
  // What s02b left on disk: the switch on and every field the 咖啡一下 type had
  // before s02c5 removed it, so this list is the only record of the old shape.
  const old = { enabled: true, delivery: 'always', includeBridgeOwnedSessionsForDebugging: true, notifyScope: 'bound_projects', agents: { claude: true, codex: false }, keepAwake: { enabled: true }, approval: { enabled: true, timeoutSeconds: 600 }, taskCompletion: { enabled: true, replyEnabled: false, replyTimeoutSeconds: 300 }, allowCache: { enabled: true, scope: 'session' }, presence: { enabled: true, platform: 'macos', idleThresholdSeconds: 120 } };
  const stored = { ...cfg, preferences: { ...cfg.preferences, cliBridge: old } };
  await writeFile(paths.configFile, `${JSON.stringify(stored, null, 2)}\n`);
  cfg = await loadConfig() as AppConfig;
  const { owner } = await fixture();
  const view = await owner.read(agent) as AgentSettingsView;
  expect(Object.keys(view.sections)).toEqual(['profile', 'role', 'cards', 'run', 'completion', 'comments', 'titles', 'paths', 'access', 'judge']);
  expect(view).not.toHaveProperty('cliRuntime');
  expect(JSON.stringify(view)).not.toMatch(/cliBridge|notifyScope|keepAwake/);
  expect((await owner.save({ scope: agent, section: 'cards', revision: view.sections.cards.revision, patch: { showToolCalls: false } })).kind).toBe('saved');
  // The file is what was written plus the one saved field: the old section, its
  // key order and the other unknown keys are untouched.
  expect(await readFile(paths.configFile, 'utf8')).toBe(`${JSON.stringify({ ...stored, preferences: { ...stored.preferences, showToolCalls: false } }, null, 2)}\n`);
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
it('s36d2: comments and a group without a model show the bot default on its backend; saving a comment model leaves the backend inherited', async () => {
  const { owner, writer } = await fixture();
  await writer(p => { p.defaults = { model: { kind: 'catalog', id: 'fixture-model', effort: 'low' } }; });
  let a = await owner.read(agent) as AgentSettingsView;
  expect(a.sections.comments.stored.backend).toBe('codex-appserver');
  expect(a.sections.comments.effective).toEqual({ backend: 'codex-appserver', selection: { kind: 'explicit', model: 'fixture-model', effort: 'low' } });
  let p = await owner.read(project) as ProjectSettingsView;
  expect(p.sections.model.stored.selection).toEqual({ kind: 'default' });
  expect(p.sections.model.effective.selection).toEqual({ kind: 'explicit', model: 'fixture-model', effort: 'low' });
  expect(p.identity.backend).toBe('codex-appserver');

  // The bot's model is for Claude: the Codex group and the Codex comments start on the backend default.
  await writer(c => { c.defaults = { backend: 'claude-agent', model: { kind: 'catalog', id: 'fixture-model', effort: 'low' } }; });
  p = await owner.read(project) as ProjectSettingsView;
  expect(p.identity.backend).toBe('codex-appserver');
  expect(p.sections.model.effective.selection).toEqual({ kind: 'explicit', model: 'fixture-model', effort: 'high' });
  a = await owner.read(agent) as AgentSettingsView;
  expect(a.sections.comments.effective.backend).toBe('claude-agent');

  await writer(c => { c.defaults = {}; });
  a = await owner.read(agent) as AgentSettingsView;
  expect((await owner.save({ scope: agent, section: 'comments', revision: a.sections.comments.revision, patch: { selection: { kind: 'explicit', model: 'fixture-model', effort: 'high' } } })).kind).toBe('saved');
  expect((await loadConfig()).preferences?.comments).toEqual({ model: 'fixture-model', effort: 'high' });
  a = await owner.read(agent) as AgentSettingsView;
  expect((await owner.save({ scope: agent, section: 'comments', revision: a.sections.comments.revision, patch: { backend: 'codex-appserver' } })).kind).toBe('saved');
  expect((await loadConfig()).preferences?.comments).toEqual({ backend: 'codex-appserver', model: 'fixture-model', effort: 'high' });
});
it('s36d2: a group whose backend left the catalog runs Codex and shows the Codex model it saved', async () => {
  await updateProject('demo', { backend: 'claude-sdk' });
  const { owner } = await fixture();
  let p = await owner.read(project) as ProjectSettingsView;
  expect(p.identity.backend).toBe('codex-appserver');
  expect((await owner.save({ scope: project, section: 'model', revision: p.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'fixture-model', effort: 'low' } } })).kind).toBe('saved');
  p = await owner.read(project) as ProjectSettingsView;
  expect(p.sections.model.effective.selection).toEqual({ kind: 'explicit', model: 'fixture-model', effort: 'low' });
});

it('s28c: a partial or unavailable roster never replaces saved response members or changes their revision', async () => {
  await updateProject('demo', () => ({ allowedUsers: ['ou_saved'] }));
  const responseRoster = vi.fn().mockResolvedValue({ state: 'partial', entries: [{ openId: 'ou_bot', name: 'Bot', kind: 'bot' }], otherBots: true });
  const { owner } = await fixture({ responseRoster });
  const before = await owner.read(project) as ProjectSettingsView;
  expect(before.members.openIds).toEqual(['ou_saved']);
  expect(before.members.roster?.entries[0]?.openId).toBe('ou_bot');
  responseRoster.mockResolvedValue({ state: 'unavailable', entries: [], otherBots: false });
  const after = await owner.read(project) as ProjectSettingsView;
  expect(after.members.openIds).toEqual(['ou_saved']);
  expect(after.members.revision).toBe(before.members.revision);
  expect((await getProjectByName('demo'))?.allowedUsers).toEqual(['ou_saved']);
});

it('shows Feishu administrator sources and prevents their local removal', async () => {
  const roles = vi.spyOn(appRoles, 'getAppRoleSnapshot').mockReturnValue({
    appId: botId, tenant: 'feishu', fetchedAt: Date.now(), ownerOpenId: 'ou_feishu_owner', admins: ['ou_feishu_admin'],
  });
  try {
    cfg.preferences ??= {};
    cfg.preferences.access ??= {};
    cfg.preferences.access.admins = [...(cfg.preferences.access.admins ?? []), 'ou_feishu_admin'];
    await saveConfig(cfg);
    const { owner } = await fixture();
    const view = await owner.read(agent);
    if (view.scope.kind !== 'agent' || !('administrators' in view)) throw new Error('Expected agent settings');
    expect(view.administrators.feishu).toEqual({ ownerOpenId: 'ou_feishu_owner', adminOpenIds: ['ou_feishu_admin'] });
    expect(view.administrators.scannerOpenId).toBe('ou_owner');
    const card = JSON.stringify(buildAdminsCard(cfg, new Map(), { editable: true }));
    expect(card).toContain('飞书应用拥有者');
    expect(card).toContain('飞书应用管理员');
    expect(card).toContain('扫码注册者');
    expect(card).toContain('本地管理员');
    expect(card).not.toContain('\"u\":\"ou_feishu_admin\"');
    expect(card).toContain('\"u\":\"ou_admin\"');
    // audit 252-1: an admin who is not the owner sees the same list, read-only
    const readOnly = JSON.stringify(buildAdminsCard(cfg, new Map(), { editable: false }));
    expect(readOnly).toContain('本地管理员');
    expect(readOnly).toContain('本机管理员名单只有飞书应用的拥有者能改。');
    for (const action of ['rmAdmin', 'addAdminForm']) expect(readOnly).not.toContain(`"a":"${DM[action as keyof typeof DM]}"`);
    for (const openId of ['ou_feishu_owner', 'ou_feishu_admin', 'ou_owner']) {
      expect((await owner.act({ kind: 'adminMember', botId, openId, membership: 'absent', revision: view.administrators.revision })).kind).toBe('rejected');
    }
    expect((await owner.act({ kind: 'adminMember', botId, openId: 'ou_admin', membership: 'absent', revision: view.administrators.revision })).kind).toBe('saved');
    expect(cfg.preferences?.access?.admins).toContain('ou_feishu_admin');
  } finally { roles.mockRestore(); }
});

describe('model catalog availability', () => {
  const query = { botId, backend: 'codex-appserver', purpose: 'project' as const };

  it('marks successful native discovery ready and saves its actual catalog for offline use', async () => {
    const native = await backend.listModels();
    let discovered: typeof native | undefined;
    const { owner } = await fixture({ backendFor: () => ({
      ...backend,
      listModels: async () => { discovered = native; return native; },
      peekModels: () => discovered,
    }) });
    const catalog = await owner.models(query);
    expect(catalog).toMatchObject({ state: 'ready', models: native });
    const offline = await offlineModelCatalog(query.backend);
    expect(offline).toMatchObject({ models: native.map(({ serviceTiers: _tiers, ...model }) => model), observedAt: catalog.observedAt });
    expect(offline.models.every(model => !model.serviceTiers?.length)).toBe(true);
    // Cached backend instances retain confirmed native metadata between reads.
    expect((await owner.models(query)).state).toBe('ready');
  });

  it.each([undefined, () => undefined, () => []])('keeps unconfirmed lists fallback without replacing a confirmed disk snapshot (%s)', async peekModels => {
    const native = await backend.listModels();
    await rememberModelCatalog(query.backend, native, '2026-10-01T00:00:00.000Z');
    const fallback = [{ ...native[0]!, id: 'offline-fallback' }];
    const { owner } = await fixture({ backendFor: () => ({ ...backend, listModels: async () => fallback, peekModels }) });
    expect(await owner.models(query)).toMatchObject({ state: 'fallback', models: fallback });
    expect(await offlineModelCatalog(query.backend)).toMatchObject({ models: native.map(({ serviceTiers: _tiers, ...model }) => model), observedAt: '2026-10-01T00:00:00.000Z' });
  });

  it('keeps explicit offline reads fallback even with a populated native cache and never probes', async () => {
    const native = await backend.listModels();
    await rememberModelCatalog(query.backend, native, '2026-10-01T00:00:00.000Z');
    const doctor = vi.fn();
    const listModels = vi.fn();
    const refreshPermissions = vi.fn();
    const { owner } = await fixture({ offline: true, backendFor: () => ({ ...backend, doctor, listModels, refreshPermissions, peekModels: () => native }) });
    expect(await owner.models(query)).toMatchObject({ state: 'fallback', models: native });
    expect(doctor).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    await owner.read(project);
    expect(refreshPermissions).not.toHaveBeenCalled();
  });

  it('does not treat an old native cache as ready when the backend probe fails', async () => {
    const native = await backend.listModels();
    const listModels = vi.fn(async () => native);
    const { owner } = await fixture({ backendFor: () => ({ ...backend, doctor: async () => ({ ok: false, version: null }), listModels, peekModels: () => native }) });
    expect(await owner.models(query)).toMatchObject({ state: 'unavailable', models: [] });
    expect(listModels).not.toHaveBeenCalled();
  });
});
