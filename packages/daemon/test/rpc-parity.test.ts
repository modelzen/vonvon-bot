import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { requestSchema, responseSchema } from '@vonvon/protocol';
import type { AdminBot, AdminProject } from '../src/admin/service';
import type { HostSettingsView } from '../src/admin/settings-types';
import { readAdminState } from '../src/server/state';
import { fakeService, socketClient, startFixture } from './server-fixture';

const bot: AdminBot = { appId: 'cli_fixture', name: 'fixture', tenant: 'feishu', active: false, current: true, running: true, pid: 42, startedAt: 12, completionReminder: { mode: 'always', longTaskMinutes: 7 } };
const project: AdminProject = { name: 'project', chatId: 'oc_fixture', cwd: '/fixture', blank: false, kind: 'multi', origin: 'joined', noMention: false, autoCompact: true, mode: 'qa', guestMode: 'qa', network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 2, createdAt: 1 };
const host: HostSettingsView = { scope: { kind: 'host' }, sections: { execution: { stored: { codexBin: null }, effective: { codexBin: null }, revision: 'section-token', access: { kind: 'writable' }, apply: [] } }, runtime: { codexBin: null, fallbackCwd: '/fixture', platform: 'darwin' } };
const agentScope = { kind: 'agent', botId: bot.appId };
const projectScope = { kind: 'project', botId: bot.appId, projectName: project.name };
const sessionScope = { kind: 'session', botId: bot.appId, threadId: 'thread' };

function inventory(folderToken: string) {
  const membershipId = JSON.stringify([bot.appId, project.chatId]);
  return [
    ['GET /api/state', 'admin', { type: 'state' }],
    ['GET /api/project/:name/sessions', 'settings', { type: 'sessions', botId: bot.appId, projectName: project.name }],
    ...[agentScope, projectScope, sessionScope, { kind: 'host' }].map(scope => [`GET settings ${scope.kind}`, 'settings', { type: 'read', scope }]),
    ['PATCH agent settings / section', 'settings', { type: 'save', edit: { scope: agentScope, section: 'cards', revision: 'old', patch: { showToolCalls: true } } }],
    ['PATCH project settings', 'settings', { type: 'save', edit: { scope: projectScope, section: 'response', revision: 'old', patch: { noMention: true } } }],
    ['PATCH session settings', 'settings', { type: 'save', edit: { scope: sessionScope, section: 'model', revision: 'old', patch: { selection: { kind: 'default' } } } }],
    ['PATCH host settings', 'settings', { type: 'save', edit: { scope: { kind: 'host' }, section: 'execution', revision: 'old', patch: { codexBin: null } } }],
    ['POST agent settings/actions', 'settings', { type: 'act', action: { kind: 'voice', botId: bot.appId, action: { action: 'disable' } } }],
    ['POST host settings/actions', 'settings', { type: 'act', action: { kind: 'repairHostCliHooks', agents: ['codex'] } }],
    ['GET models', 'settings', { type: 'models', query: { botId: bot.appId, backend: 'codex-appserver', purpose: 'session' } }],
    ['GET voice', 'settings', { type: 'read', scope: agentScope }],
    ['POST voice', 'settings', { type: 'act', action: { kind: 'voice', botId: bot.appId, action: { action: 'disable' } } }],
    ['POST completion-reminder', 'settings', { type: 'save', edit: { scope: agentScope, section: 'completion', revision: 'old', patch: { mode: 'always' } } }],
    ['POST permission', 'command', { type: 'setPermission', membershipId, administrator: 'write', member: 'qa', network: true }],
    ['POST no-mention', 'command', { type: 'setResponse', membershipId, response: 'all' }],
    ['POST auto-compact', 'settings', { type: 'save', edit: { scope: projectScope, section: 'compact', revision: 'old', patch: { autoCompact: false } } }],
    ['POST backend', 'admin', { type: 'switchBackend', agentId: bot.appId, projectName: project.name, backend: 'claude-agent' }],
    ['PATCH bot', 'command', { type: 'setAgentEnabled', agentId: bot.appId, enabled: true }],
    ['DELETE bot', 'command', { type: 'deleteAgent', agentId: bot.appId }],
    ['POST collaboration', 'collaboration', { action: 'project', agentId: bot.appId, groupId: project.chatId, projectName: project.name }],
    ['GET account usage', 'collaboration', { action: 'usage', force: false }],
    ['GET pending-groups', 'command', { type: 'listPendingGroups', agentId: bot.appId }],
    ['GET joined-groups', 'command', { type: 'listJoinedGroups', agentId: bot.appId }],
    ['POST bind-group', 'command', { type: 'bindGroup', agentId: bot.appId, groupId: project.chatId, projectName: project.name, folderToken, tool: 'codex', conversation: 'threads' }],
    ['GET codex/setup', 'admin', { type: 'codexSetup' }],
    ['POST codex/install', 'command', { type: 'installCodex' }],
    ['POST codex/login', 'command', { type: 'startCodexLogin' }],
    ['GET codex/jobs/:id and register-qr status', 'snapshot', { type: 'get' }],
    ['DELETE codex/jobs/:id and register-qr', 'command', { type: 'cancelJob', jobId: 'fixture-job' }],
    ['GET register-qr/stream', 'command', { type: 'registerAgent' }],
    ['GET refresh-qr/stream', 'command', { type: 'refreshAgentCredentials', agentId: bot.appId }],
    ['GET setup-status', 'admin', { type: 'setupStatus', agentId: bot.appId }],
    ['GET diagnosis', 'admin', { type: 'diagnosis', agentId: bot.appId }],
    ['GET daemon', 'admin', { type: 'daemonStatus' }],
    ['POST daemon/restart', 'command', { type: 'restartHost' }],
    ['POST daemon/stop', 'machine', { type: 'stopHost' }],
    ['GET update/check', 'machine', { type: 'checkCoreUpdate' }],
    ['GET update/status', 'machine', { type: 'coreUpdateStatus' }],
    ['POST update', 'machine', { type: 'applyCoreUpdate' }],
    ['GET host-doctor', 'admin', { type: 'hostDoctor' }],
    ['GET logs', 'admin', { type: 'logs' }],
    ['GET logs/stream', 'admin', { type: 'followLogs', follow: true }],
    ['GET backends', 'environment', { type: 'backendCatalog' }],
    ['POST backend/install', 'environment', { type: 'backendInstall', id: 'claude-agent', update: false }],
    ['POST backend/update', 'environment', { type: 'backendInstall', id: 'claude-agent', update: true }],
    ['GET backend/version', 'environment', { type: 'backendVersion', id: 'claude-agent' }],
    ['DELETE backend', 'environment', { type: 'backendUninstall', id: 'claude-agent' }],
  ];
}

describe('route inventory parity', () => {
  it('calls every replacement route through real WebSocket and parses its reply schema', async () => {
    let active = false;
    const service = fakeService({ listBots: async () => [{ ...bot, active }], listProjects: async () => [project], setBotEnabled: async (_id, enabled) => { active = enabled; return { ok: true, activation: 'applied', message: '' }; },
      pendingGroups: async () => ({ groups: [] }), joinedGroups: async () => ({ groups: [] }), bindGroup: async () => project,
      collaboration: async () => ({ kind: 'project', project: { name: project.name, chatId: project.chatId, cwd: project.cwd, kind: project.kind, backend: project.backend, enabled: true, revision: 'project-token' } }),
      startCodexJob: () => ({ id: 'fixture-job' }), codexJob: () => ({ id: 'fixture-job', type: 'install', state: 'succeeded' }),
      settings: { read: async () => host, save: async () => ({ kind: 'saved', section: { scope: { kind: 'host' }, section: 'execution', value: host.sections.execution }, effects: [] }), act: async () => ({ kind: 'saved', view: host, effects: [], warnings: [] }), models: async query => ({ backend: query.backend, models: [], state: 'unavailable', source: 'backend-provided', observedAt: new Date().toISOString(), titleEfforts: [] }) },
    });
    const fixture = await startFixture(service);
    try {
      const client = await socketClient(fixture.api.port, fixture.credential); await client.ready();
      const chosen = await client.call({ type: 'request', id: 'folder', method: 'directory', payload: { type: 'choose', path: homedir() } });
      if (chosen.type !== 'response' || chosen.method !== 'directory' || chosen.payload.kind !== 'folderChosen') throw new Error('folder missing');
      for (const [route, method, payload] of inventory(chosen.payload.folder.token)) {
        const request = requestSchema.parse({ type: 'request', id: String(route), method, payload });
        const frame = await client.call(request);
        expect(frame.type, String(route)).toBe('response');
        expect(responseSchema.safeParse(frame).success, String(route)).toBe(true);
        if (frame.type === 'response' && frame.method === 'settings' && frame.payload.kind === 'saved' && frame.payload.result.kind === 'saved') expect(frame.payload.result.section.value.revision).toBe('section-token');
        if (route === 'PATCH bot') {
          const snapshotIndex = client.frames.findIndex(frame => frame.type === 'event' && frame.event === 'snapshot' && frame.payload.agents[0]?.enabled);
          expect(snapshotIndex).toBeGreaterThanOrEqual(0);
          expect(snapshotIndex).toBeLessThan(client.frames.indexOf(frame));
          expect(frame).toMatchObject({ payload: { kind: 'applied', revision: client.frames[snapshotIndex]?.type === 'event' && client.frames[snapshotIndex]?.event === 'snapshot' ? client.frames[snapshotIndex].payload.revision : -1 } });
        }
      }
      expect(fixture.control.requestRestart).toHaveBeenCalledWith(fixture.api.port);
      expect(fixture.control.requestStop).toHaveBeenCalledOnce();
      await client.close();
    } finally { await fixture.close(); }
  });

  it('returns exactly the moved state output when projects.json is corrupt', async () => {
    const service = fakeService({ listBots: async () => [bot], listProjects: async () => { throw new Error('corrupt projects.json'); } });
    const fixture = await startFixture(service);
    try {
      const expected = await readAdminState(service);
      const client = await socketClient(fixture.api.port, fixture.credential); await client.ready();
      const reply = await client.call({ type: 'request', id: 'state', method: 'admin', payload: { type: 'state' } });
      if (reply.type !== 'response' || reply.method !== 'admin' || reply.payload.kind !== 'state') throw new Error('state missing');
      expect({ ...reply.payload.state, generatedAt: 0 }).toEqual({ ...expected, generatedAt: 0 });
      await client.close();
    } finally { await fixture.close(); }
  });
  it('refuses UI-local and shell-owned actions without closing the connection', async () => {
    const fixture = await startFixture();
    try {
      const client = await socketClient(fixture.api.port, fixture.credential); await client.ready();
      const requests = [
        { method: 'settings', payload: { type: 'chooseExecutable' } },
        { method: 'collaboration', payload: { action: 'openGroup', agentId: bot.appId, groupId: project.chatId, projectName: project.name } },
      ];
      for (const [index, value] of requests.entries()) {
        const frame = await client.call(requestSchema.parse({ type: 'request', id: `unsupported-${index}`, ...value }));
        expect(frame).toMatchObject({ type: 'error', code: 'unsupported' });
      }
      expect(await client.call({ type: 'request', id: 'still-open', method: 'snapshot', payload: { type: 'get' } })).toMatchObject({ type: 'response' });
      await client.close();
    } finally { await fixture.close(); }
  });

});
