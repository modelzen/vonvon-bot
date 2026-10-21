import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentEntries } from '../src/agent/entry/registry';
import { createCommandTools } from '../src/agent/entry/command-tools';
import type { AgentThread, AgentBackend } from '../src/agent/types';
import { createSettingsOwner } from '../src/admin/settings';
import { createAppPreferencesWriter } from '../src/admin/ops';
import type { AppConfig } from '../src/config/schema';
import { mutateSession, getSession, upsertSession } from '../src/bot/session-store';
import { saveConfig } from '../src/config/store';
import { addProject, listProjects, mutateProject, updateProject } from '../src/project/registry';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config/paths', async original => ({ ...await original<object>(), paths: {
  get appDir() { return state.root; }, get configFile() { return join(state.root, 'config.json'); },
  get projectsFile() { return join(state.root, 'projects.json'); }, get sessionsFile() { return join(state.root, 'sessions.json'); },
  get projectsRootDir() { return join(state.root, 'projects'); },
  get commentInstructionsFile() { return join(state.root, 'comment-instructions.md'); },
} }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} } }));
const botId = 'cli_fixture';
const agentScope = { kind: 'agent', botId } satisfies Parameters<ReturnType<typeof createSettingsOwner>['read']>[0];
const projectScope = { kind: 'project', botId, projectName: 'fixture' } satisfies Parameters<ReturnType<typeof createSettingsOwner>['read']>[0];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
let cfg: AppConfig;
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 's47-writers-'));
  cfg = { accounts: { app: { id: botId, tenant: 'feishu', secret: { source: 'exec', id: 'synthetic' } } }, preferences: {} };
  await saveConfig(cfg);
  await addProject({ name: 'fixture', chatId: 'fixture-chat', cwd: '/fixture', blank: true, createdAt: 1, noMention: false });
});
afterEach(async () => { vi.useRealTimers(); await rm(state.root, { recursive: true, force: true }); });
const backend: AgentBackend = { id: 'codex-appserver', displayName: 'fixture', isAvailable: async () => true, doctor: async () => ({ ok: true, version: 'fixture' }), listModels: async () => [], listThreads: async () => [], readHistory: async () => { throw Error('unused'); }, startThread: async () => { throw Error('unused'); }, resumeThread: async () => { throw Error('unused'); } };
function fixture() {
  const writer = createAppPreferencesWriter({ cfg });
  const settings = createSettingsOwner({ cfg, writePreferences: writer, backendFor: () => backend, evictLiveSessionsForChat: async () => {} });
  const flags = { admin: true, enabled: true };
  const thread: AgentThread = { sessionId: 'synthetic', isAlive: () => true, close: async () => {},
    runStreamed: () => { throw Error('unused'); }, runGoal: () => { throw Error('unused'); },
    clearGoal: async () => {}, abort: async () => {}, steer: async () => {}, compact: async () => ({ compacted: false, usage: null }) };
  const entries = createAgentEntries({ appId: botId, isAdmin: () => flags.admin, isOwner: () => true,
    chatSettingsOn: () => flags.enabled, tools: createCommandTools({ appId: botId, settings, projects: listProjects,
      groups: async () => ({ groups: [] }), members: async () => ({ members: [] }) }) });
  const entry = entries.issue({ kind: 'p2p' }); entry.attach(thread);
  const scope = entries.openTurn(thread, { requesterOpenId: 'synthetic-owner', requesterKind: 'user', triggerMessageId: 'synthetic-message', retry: false, wake: false, initiative: false });
  entry.noteToolUse('synthetic-use');
  return { writer, settings, flags, entry, scope, call: (edit: unknown) => entry.call('settings_set', { edit, reason: 'requested change' }, { toolUseId: 'synthetic-use' }) };
}
const interruptions = ['revoke administrator', 'close turn', 'switch off', 'revoke entry', 'deadline'] as const;
async function interrupt(f: ReturnType<typeof fixture>, kind: typeof interruptions[number]) {
  if (kind === 'revoke administrator') f.flags.admin = false;
  if (kind === 'close turn') f.scope.close();
  if (kind === 'switch off') f.flags.enabled = false;
  if (kind === 'revoke entry') f.entry.revoke('closed');
  if (kind === 'deadline') await vi.advanceTimersByTimeAsync(71_000);
}
describe('s47 real settings writers behind agent authorization', () => {
  it.each(interruptions)('project wait followed by %s never changes requested bytes', async kind => {
    if (kind === 'deadline') vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const f = fixture(), view = await f.settings.read(projectScope);
    if (!('response' in view.sections)) throw Error('wrong view');
    const revision = view.sections.response.revision;
    const held = deferred(), release = deferred();
    const holding = mutateProject('fixture', async row => { held.resolve(); await release.promise; row.network = true; });
    await held.promise;
    const pending = f.call({ scope: projectScope, section: 'response', revision, patch: { noMention: true } });
    await new Promise<void>(resolve => setImmediate(resolve));
    await interrupt(f, kind); release.resolve(); await holding;
    expect(await pending).toMatchObject({ ok: false });
    await updateProject('fixture', {});
    expect(await listProjects()).toMatchObject([{ noMention: false, network: true }]);
    expect((await readdir(state.root)).filter(name => name.includes('.tmp-'))).toEqual([]);
  });
  it.each(interruptions)('preferences wait followed by %s leaves disk and live state unchanged', async kind => {
    if (kind === 'deadline') vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const f = fixture(), view = await f.settings.read(agentScope);
    if (!('cards' in view.sections)) throw Error('wrong view');
    const revision = view.sections.cards.revision;
    const held = deferred(), release = deferred();
    const holding = f.writer(async () => { held.resolve(); await release.promise; });
    await held.promise;
    const before = await readFile(join(state.root, 'config.json'));
    const pending = f.call({ scope: agentScope, section: 'cards', revision, patch: { showToolCalls: false } });
    await new Promise<void>(resolve => setImmediate(resolve));
    await interrupt(f, kind); release.resolve(); await holding;
    expect(await pending).toMatchObject({ ok: false });
    await f.writer(() => {});
    expect(await readFile(join(state.root, 'config.json'))).toEqual(before);
    expect(cfg.preferences?.showToolCalls).toBeUndefined();
    expect((await readdir(state.root)).filter(name => name.includes('.tmp-'))).toEqual([]);
  });
  it('requires the caller revision and returns conflict instead of silently replacing a newer value', async () => {
    const f = fixture(), first = await f.settings.read(projectScope);
    if (!('response' in first.sections)) throw Error('wrong view');
    const revision = first.sections.response.revision;
    const edit = { scope: projectScope, section: 'response', revision, patch: { noMention: true } };
    expect(await f.call({ ...edit, revision: undefined })).toMatchObject({ ok: false });
    expect(await f.call(edit)).toMatchObject({ ok: true });
    const stale = await f.call({ ...edit, patch: { noMention: false } });
    expect(JSON.stringify(stale)).toContain('conflict');
    expect(await listProjects()).toMatchObject([{ noMention: true }]);
  });
  it.each(interruptions)('session wait followed by %s keeps its model unchanged', async kind => {
    if (kind === 'deadline') vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await upsertSession({ threadId: 'session-fixture', chatId: 'fixture-chat', sessionId: 'native-fixture', backend: 'codex-appserver', cwd: '/fixture', model: 'held-model', effort: 'high', createdAt: 1, updatedAt: 1, summary: '' });
    const f = fixture(), sessionScope = { kind: 'session', botId, threadId: 'session-fixture' } satisfies Parameters<typeof f.settings.read>[0];
    const view = await f.settings.read(sessionScope);
    if (!('model' in view.sections)) throw Error('wrong view');
    const revision = view.sections.model.revision;
    const held = deferred(), release = deferred();
    const holding = mutateSession('session-fixture', async () => { held.resolve(); await release.promise; });
    await held.promise;
    const before = await getSession('session-fixture');
    const pending = f.call({ scope: sessionScope, section: 'model', revision, patch: { selection: { kind: 'default' } } });
    await new Promise<void>(resolve => setImmediate(resolve));
    await interrupt(f, kind); release.resolve(); await holding;
    expect(await pending).toMatchObject({ ok: false });
    await mutateSession('session-fixture', () => {});
    const after = await getSession('session-fixture');
    expect(after).toEqual({ ...before, updatedAt: after?.updatedAt });
    expect(await getSession('session-fixture')).toMatchObject({ model: 'held-model' });
    expect((await readdir(state.root)).filter(name => name.includes('.tmp-'))).toEqual([]);
  });
  it('rejects expired absolute deadlines in the real owner without a disk write', async () => {
    const f = fixture(), view = await f.settings.read(projectScope);
    if (!('response' in view.sections)) throw Error('wrong view');
    const before = await readFile(join(state.root, 'projects.json'));
    await expect(f.settings.save({ scope: projectScope, section: 'response', revision: view.sections.response.revision, patch: { noMention: true } }, { notAfter: Date.now() - 1 })).rejects.toThrow('已过期');
    expect(await readFile(join(state.root, 'projects.json'))).toEqual(before);
    expect((await readdir(state.root)).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

});
