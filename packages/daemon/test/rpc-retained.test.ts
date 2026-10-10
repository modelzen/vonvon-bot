import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentIdSchema } from '@vonvon/protocol';
import { createBackend } from '../src/agent';
import { UsageError, type UsageErrorKind } from '../src/agent/types';
import { createAppPreferencesWriter } from '../src/admin/ops';
import { createSettingsOwner } from '../src/admin/settings';
import type { AppConfig } from '../src/config/schema';
import type { Project } from '../src/project/registry';
import { fakeService, socketClient, startFixture } from './server-fixture';

const botId = agentIdSchema.parse('cli_retained');
const agent = { kind: 'agent' as const, botId };
const project = { kind: 'project' as const, botId, projectName: 'demo' };
const privateText = 'Bearer secret at /private/auth.json';

async function settingsFixture() {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-settings-ws-'));
  const configFile = join(home, 'config.json');
  const projectFile = join(home, 'project.json');
  const cfg: AppConfig = {
    accounts: { app: { id: botId, tenant: 'feishu', secret: { source: 'exec', id: 'credential-original' } } },
    preferences: { access: { ownerOpenId: 'ou_owner', admins: [] } },
  };
  const initialProject: Project = { name: 'demo', chatId: 'oc_demo', cwd: home, blank: false, createdAt: 1, autoCompact: true };
  await writeFile(configFile, JSON.stringify(cfg));
  await writeFile(projectFile, JSON.stringify(initialProject));
  const readProject = async (name: string) => name === 'demo' ? JSON.parse(await readFile(projectFile, 'utf8')) as Project : undefined;
  const owner = createSettingsOwner({
    cfg,
    writePreferences: createAppPreferencesWriter({ cfg, persistConfig: async next => writeFile(configFile, JSON.stringify(next)) }),
    backendFor: createBackend,
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
    hooks: {
      inspect: async () => ({ claude: { agent: 'claude', status: 'installed', details: [] }, codex: { agent: 'codex', status: 'installed', details: [] } }),
      install: async () => {},
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
      const revision = readAgent.payload.view.sections.run.revision;
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
      if (readProject.type !== 'response' || readProject.method !== 'settings' || readProject.payload.kind !== 'view' || !('compact' in readProject.payload.view.sections)) throw new Error('project view missing');
      const compactRevision = readProject.payload.view.sections.compact.revision;
      const compact = await client.call({ type: 'request', id: 'save-project', method: 'settings', payload: { type: 'save', edit: { scope: project, section: 'compact', revision: compactRevision, patch: { autoCompact: false } } } });
      expect(compact).toMatchObject({ type: 'response', method: 'settings', payload: { kind: 'saved', result: { kind: 'saved', section: { scope: project, section: 'compact', value: { stored: { autoCompact: false } } } } } });
      if (compact.type !== 'response' || compact.method !== 'settings' || compact.payload.kind !== 'saved' || compact.payload.result.kind !== 'saved') throw new Error('project save missing');
      expect(compact.payload.result.section.value.revision).not.toBe(compactRevision);
      const rereadProject = await client.call({ type: 'request', id: 'reread-project', method: 'settings', payload: { type: 'read', scope: project } });
      expect(rereadProject).toMatchObject({ payload: { kind: 'view', view: { sections: { compact: { revision: compact.payload.result.section.value.revision, stored: { autoCompact: false } } } } } });
      expect(JSON.parse(await readFile(fixture.projectFile, 'utf8'))).toMatchObject({ autoCompact: false });
    } finally { await client.close(); await fixture.close(); }
  });

  it('rejects a stale token without a second write and rejects malformed patches before dispatch', async () => {
    const fixture = await settingsFixture();
    const client = await socketClient(fixture.api.api.port, fixture.api.credential);
    try {
      await client.ready();
      const read = await client.call({ type: 'request', id: 'read', method: 'settings', payload: { type: 'read', scope: agent } });
      if (read.type !== 'response' || read.method !== 'settings' || read.payload.kind !== 'view' || !('run' in read.payload.view.sections)) throw new Error('agent view missing');
      const edit = { scope: agent, section: 'run', revision: read.payload.view.sections.run.revision, patch: { maxConcurrentRuns: 3 } } as const;
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
      const foreign = await client.call({ type: 'request', id: 'foreign', method: 'settings', payload: { type: 'act', action: { kind: 'repairCliHooks', botId: agentIdSchema.parse('cli_other') } } });
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
