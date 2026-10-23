import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentIdSchema } from '@vonvon/protocol';
import { UsageError, type UsageErrorKind, type AgentBackend, type ModelInfo } from '../src/agent/types';
import { createAppPreferencesWriter } from '../src/admin/ops';
import { createSettingsOwner } from '../src/admin/settings';
import type { AppConfig } from '../src/config/schema';
import type { Project } from '../src/project/registry';
import { fakeService, socketClient, startFixture } from './server-fixture';

const botId = agentIdSchema.parse('cli_retained');
const agent = { kind: 'agent' as const, botId };
const project = { kind: 'project' as const, botId, projectName: 'demo' };
const privateText = 'Bearer secret at /private/auth.json';

// Settings reads now inspect the model catalog. Keep this real RPC/disk fixture offline.
const fixtureModels: ModelInfo[] = [{ id: 'gpt-6-luna', displayName: 'Fixture model', description: '', hidden: false, isDefault: true, supportedEfforts: ['low'], defaultEffort: 'low' }];
function fixtureBackend(id: string): AgentBackend {
  if (id !== 'codex-appserver' && id !== 'claude-agent') throw new Error('Unknown fixture backend');
  return { id, displayName: 'Fixture provider', isAvailable: async () => true, doctor: async () => ({ ok: true, version: 'fixture' }),
    listModels: async () => fixtureModels, peekModels: () => fixtureModels, listThreads: async () => [],
    readHistory: async () => { throw new Error('unused'); }, startThread: async () => { throw new Error('unused'); }, resumeThread: async () => { throw new Error('unused'); } };
}

async function settingsFixture() {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-settings-ws-'));
  const configFile = join(home, 'config.json');
  const projectFile = join(home, 'project.json');
  const cfg: AppConfig = {
    accounts: { app: { id: botId, tenant: 'feishu', secret: { source: 'exec', id: 'credential-original' } } },
    preferences: { access: { ownerOpenId: 'ou_owner', admins: [] } },
  };
  // An old row with auto-compaction turned off: since s12 nothing reads it.
  const initialProject = { name: 'demo', chatId: 'oc_demo', cwd: home, blank: false, createdAt: 1, autoCompact: false };
  await writeFile(configFile, JSON.stringify(cfg));
  await writeFile(projectFile, JSON.stringify(initialProject));
  const readProject = async (name: string) => name === 'demo' ? JSON.parse(await readFile(projectFile, 'utf8')) as Project : undefined;
  const owner = createSettingsOwner({
    cfg,
    writePreferences: createAppPreferencesWriter({ cfg, persistConfig: async next => writeFile(configFile, JSON.stringify(next)) }),
    backendFor: fixtureBackend,
    evictLiveSessionsForChat: async () => {},
    readProject,
    listProjects: async () => [JSON.parse(await readFile(projectFile, 'utf8')) as Project],
    mutateProject: async (name, mutate) => {
      const current = await readProject(name);
      if (!current) throw new Error('项目不存在');
      await mutate(current);
      await writeFile(projectFile, JSON.stringify(current));
      return current;
    },
    instructions: { read: async () => 'Retained test instructions', save: async () => {}, sync: async () => 0 },
  });
  const api = await startFixture(fakeService({ settings: owner }));
  return { api, configFile, projectFile, close: async () => { await api.close(); await rm(home, { recursive: true, force: true }); } };
}

describe('retained settings behavior over real WebSocket', () => {
  it('saves agent and project sections with exact result, revision, and durable files', async () => {
    const fixture = await settingsFixture();
    const client = await socketClient(fixture.api.api.port, fixture.api.credential);
    try {
      await client.ready();
      const readAgent = await client.call({ type: 'request', id: 'read-agent', method: 'settings', payload: { type: 'read', scope: agent } });
      if (readAgent.type !== 'response' || readAgent.method !== 'settings' || readAgent.payload.kind !== 'view' || !('run' in readAgent.payload.view.sections)) throw new Error('agent view missing');
      const revision = readAgent.payload.view.sections.run!.revision;
      const edit = { scope: agent, section: 'run', revision, patch: { maxConcurrentRuns: 3 } } as const;
      const saved = await client.call({ type: 'request', id: 'save-agent', method: 'settings', payload: { type: 'save', edit } });
      expect(saved).toMatchObject({ type: 'response', method: 'settings', payload: { kind: 'saved', result: { kind: 'saved', section: { scope: agent, section: 'run', value: { stored: { maxConcurrentRuns: 3 } } } } } });
      if (saved.type !== 'response' || saved.method !== 'settings' || saved.payload.kind !== 'saved' || saved.payload.result.kind !== 'saved') throw new Error('agent save missing');
      expect(saved.payload.result.section.value.revision).toMatch(/^[a-f0-9]{64}$/);
      expect(saved.payload.result.section.value.revision).not.toBe(revision);
      const rereadAgent = await client.call({ type: 'request', id: 'reread-agent', method: 'settings', payload: { type: 'read', scope: agent } });
      expect(rereadAgent).toMatchObject({ payload: { kind: 'view', view: { sections: { run: { revision: saved.payload.result.section.value.revision, stored: { maxConcurrentRuns: 3 } } } } } });
      const disk = JSON.parse(await readFile(fixture.configFile, 'utf8')) as AppConfig;
      expect(disk.preferences?.maxConcurrentRuns).toBe(3);
      expect(disk.accounts.app.secret).toEqual({ source: 'exec', id: 'credential-original' });

      const readProject = await client.call({ type: 'request', id: 'read-project', method: 'settings', payload: { type: 'read', scope: project } });
      if (readProject.type !== 'response' || readProject.method !== 'settings' || readProject.payload.kind !== 'view' || !('response' in readProject.payload.view.sections)) throw new Error('project view missing');
      expect(Object.keys(readProject.payload.view.sections).sort()).toEqual(['judge', 'model', 'modelAccess', 'permission', 'presentation', 'profile', 'response', 'run', 'skills', 'smartRules', 'workspace']);
      const responseRevision = readProject.payload.view.sections.response.revision;
      const response = await client.call({ type: 'request', id: 'save-project', method: 'settings', payload: { type: 'save', edit: { scope: project, section: 'response', revision: responseRevision, patch: { noMention: false } } } });
      expect(response).toMatchObject({ type: 'response', method: 'settings', payload: { kind: 'saved', result: { kind: 'saved', section: { scope: project, section: 'response', value: { stored: { noMention: false } } } } } });
      if (response.type !== 'response' || response.method !== 'settings' || response.payload.kind !== 'saved' || response.payload.result.kind !== 'saved') throw new Error('project save missing');
      expect(response.payload.result.section.value.revision).not.toBe(responseRevision);
      const rereadProject = await client.call({ type: 'request', id: 'reread-project', method: 'settings', payload: { type: 'read', scope: project } });
      expect(rereadProject).toMatchObject({ payload: { kind: 'view', view: { sections: { response: { revision: response.payload.result.section.value.revision, stored: { noMention: false } } } } } });
      // The old key stays in the file untouched (no migration) and can no longer be written.
      const afterSave = await readFile(fixture.projectFile, 'utf8');
      expect(JSON.parse(afterSave)).toMatchObject({ noMention: false, autoCompact: false });
      client.socket.send(JSON.stringify({ type: 'request', id: 'compact', method: 'settings', payload: { type: 'save', edit: { scope: project, section: 'compact', revision: responseRevision, patch: { autoCompact: true } } } }));
      expect(await client.wait(frame => frame.type === 'error' && frame.id === 'compact')).toMatchObject({ code: 'invalid_request' });
      expect(await readFile(fixture.projectFile, 'utf8')).toBe(afterSave);
    } finally { await client.close(); await fixture.close(); }
  });

  it('judge (s23d): saves both kinds on both layers, reads them back, shows a kind from a newer vonvon as stored, lists models for judge', async () => {
    const fixture = await settingsFixture();
    const client = await socketClient(fixture.api.api.port, fixture.api.credential);
    const jev = { kind: 'decision', provider: 'typesafe', model: 'jev-latest' } as const;
    let reads = 0;
    const judgeOf = async (scope: typeof agent | typeof project) => {
      const read = await client.call({ type: 'request', id: `read-${++reads}`, method: 'settings', payload: { type: 'read', scope } });
      if (read.type !== 'response' || read.method !== 'settings' || read.payload.kind !== 'view' || !('judge' in read.payload.view.sections) || !read.payload.view.sections.judge) throw new Error('judge section missing');
      return read.payload.view.sections.judge;
    };
    try {
      await client.ready();
      const bot = await judgeOf(agent);
      expect(bot.stored).toEqual({ selection: { kind: 'default' } });
      const saved = await client.call({ type: 'request', id: 'save-bot', method: 'settings', payload: { type: 'save', edit: { scope: agent, section: 'judge', revision: bot.revision, patch: { selection: jev } } } });
      expect(saved).toMatchObject({ payload: { kind: 'saved', result: { kind: 'saved', section: { section: 'judge', value: { stored: { selection: jev }, effective: { selection: jev } } } } } });
      expect((JSON.parse(await readFile(fixture.configFile, 'utf8')) as AppConfig).preferences?.judge).toEqual(jev);

      const group = await judgeOf(project);
      const custom = { kind: 'llm', model: 'my-gw/qwen3-coder', effort: 'low', custom: true } as const;
      const savedGroup = await client.call({ type: 'request', id: 'save-group', method: 'settings', payload: { type: 'save', edit: { scope: project, section: 'judge', revision: group.revision, patch: { selection: custom } } } });
      expect(savedGroup).toMatchObject({ payload: { result: { kind: 'saved', section: { value: { stored: { selection: { ...custom, backend: 'codex-appserver' } } } } } } });
      expect(JSON.parse(await readFile(fixture.projectFile, 'utf8')).judge).toEqual({ ...custom, backend: 'codex-appserver' });

      const future = { kind: 'oracle', provider: 'x', model: 'y' };
      await writeFile(fixture.projectFile, JSON.stringify({ ...JSON.parse(await readFile(fixture.projectFile, 'utf8')), judge: future }));
      expect((await judgeOf(project)).stored).toEqual({ selection: future });

      const models = await client.call({ type: 'request', id: 'models', method: 'settings', payload: { type: 'models', query: { botId, backend: 'nope', purpose: 'judge' } } });
      expect(models).toMatchObject({ payload: { kind: 'models', catalog: { backend: 'nope', state: 'unavailable', models: [] } } });
    } finally { await client.close(); await fixture.close(); }
  });

  it('rejects a stale token without a second write and rejects malformed patches before dispatch', async () => {
    const fixture = await settingsFixture();
    const client = await socketClient(fixture.api.api.port, fixture.api.credential);
    try {
      await client.ready();
      const read = await client.call({ type: 'request', id: 'read', method: 'settings', payload: { type: 'read', scope: agent } });
      if (read.type !== 'response' || read.method !== 'settings' || read.payload.kind !== 'view' || !('run' in read.payload.view.sections)) throw new Error('agent view missing');
      const edit = { scope: agent, section: 'run', revision: read.payload.view.sections.run!.revision, patch: { maxConcurrentRuns: 3 } } as const;
      expect(await client.call({ type: 'request', id: 'first', method: 'settings', payload: { type: 'save', edit } })).toMatchObject({ payload: { result: { kind: 'saved' } } });
      const afterFirst = await readFile(fixture.configFile, 'utf8');
      const stale = await client.call({ type: 'request', id: 'stale', method: 'settings', payload: { type: 'save', edit } });
      expect(stale).toMatchObject({ type: 'response', method: 'settings', payload: { kind: 'saved', result: { kind: 'conflict', current: { section: 'run', value: { stored: { maxConcurrentRuns: 3 } } } } } });
      expect(await readFile(fixture.configFile, 'utf8')).toBe(afterFirst);
      client.socket.send(JSON.stringify({ type: 'request', id: 'malformed', method: 'settings', payload: { type: 'save', edit: { ...edit, patch: { maxConcurrentRuns: '5' } } } }));
      expect(await client.wait(frame => frame.type === 'error' && frame.id === 'malformed')).toMatchObject({ code: 'invalid_request' });
      expect(await readFile(fixture.configFile, 'utf8')).toBe(afterFirst);
    } finally { await client.close(); await fixture.close(); }
  });

  it('rejects cross-owner actions and absent sessions without modifying files', async () => {
    const fixture = await settingsFixture();
    const client = await socketClient(fixture.api.api.port, fixture.api.credential);
    try {
      await client.ready();
      const originalConfig = await readFile(fixture.configFile, 'utf8');
      const originalProject = await readFile(fixture.projectFile, 'utf8');
      const foreign = await client.call({ type: 'request', id: 'foreign', method: 'settings', payload: { type: 'act', action: { kind: 'voice', botId: agentIdSchema.parse('cli_other'), action: { action: 'disable' } } } });
      expect(foreign).toMatchObject({ type: 'error', code: 'invalid_request' });
      const absent = await client.call({ type: 'request', id: 'absent', method: 'settings', payload: { type: 'read', scope: { kind: 'session', botId, threadId: 'omt_missing' } } });
      expect(absent).toMatchObject({ type: 'error', code: 'invalid_request' });
      expect(await readFile(fixture.configFile, 'utf8')).toBe(originalConfig);
      expect(await readFile(fixture.projectFile, 'utf8')).toBe(originalProject);
    } finally { await client.close(); await fixture.close(); }
  });
});

describe('retained Codex usage behavior over real WebSocket', () => {
  it('works with zero bots, forwards both force values, and retains the full bundle', async () => {
    const forces: boolean[] = [];
    const bundle = { profile: { displayName: 'Local account', topInvocations: [{ name: 'plugin-a', count: 2, kind: 'plugin' as const }], dailyBuckets: [{ date: '2026-10-10', tokens: 42 }] }, usage: { planType: 'plus', main: { name: 'main', primary: { usedPercent: 25, windowSeconds: 18000, resetAt: 12345 } }, extras: [{ name: 'secondary', secondary: { usedPercent: 50 } }], fetchedAt: 67890 } };
    const fixture = await startFixture(fakeService({ listBots: async () => [], accountUsage: async force => { forces.push(force); return bundle; } }));
    const client = await socketClient(fixture.api.port, fixture.credential);
    try {
      await client.ready();
      for (const [id, force] of [['normal', false], ['refresh', true]] as const) {
        const frame = await client.call({ type: 'request', id, method: 'collaboration', payload: { action: 'usage', force } });
        expect(frame).toMatchObject({ type: 'response', method: 'collaboration', payload: { kind: 'usage', data: bundle } });
        if (frame.type !== 'response' || frame.method !== 'collaboration' || frame.payload.kind !== 'usage') throw new Error('usage result missing');
        expect(frame.payload.data).toEqual(bundle);
      }
      expect(forces).toEqual([false, true]);
    } finally { await client.close(); await fixture.close(); }
  });

  it.each<[UsageErrorKind, string]>([
    ['no-auth', '请先登录 Codex，再查看用量。'],
    ['api-key-mode', '当前 Codex 使用 API Key 登录，无法读取 ChatGPT 账号用量。'],
    ['need-relogin', 'Codex 登录已失效，请重新登录。'],
    ['transient', '暂时无法读取 Codex 用量，请稍后重试。'],
  ])('redacts %s usage failures', async (kind, message) => {
    const fixture = await startFixture(fakeService({ accountUsage: async () => { throw new UsageError(kind, privateText); } }));
    const client = await socketClient(fixture.api.port, fixture.credential);
    try {
      await client.ready();
      const frame = await client.call({ type: 'request', id: `usage-${kind}`, method: 'collaboration', payload: { action: 'usage', force: false } });
      expect(frame).toMatchObject({ type: 'error', code: 'usage_unavailable' });
      if (frame.type !== 'error') throw new Error('usage error missing');
      expect(frame.message).toBe(message);
      expect(frame.message).not.toMatch(/secret|Bearer|\/private\/auth\.json/i);
    } finally { await client.close(); await fixture.close(); }
  });

  it('redacts unexpected usage failures', async () => {
    const fixture = await startFixture(fakeService({ accountUsage: async () => { throw new Error(privateText); } }));
    const client = await socketClient(fixture.api.port, fixture.credential);
    try {
      await client.ready();
      const frame = await client.call({ type: 'request', id: 'usage-unexpected', method: 'collaboration', payload: { action: 'usage', force: false } });
      expect(frame).toMatchObject({ type: 'error', code: 'operation_failed', message: '读取 Codex 用量失败' });
      expect(JSON.stringify(frame)).not.toMatch(/secret|Bearer|\/private\/auth\.json/i);
    } finally { await client.close(); await fixture.close(); }
  });
});
