import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type DesktopSnapshot } from '@vonvon/protocol';
import { filterSnapshot, sessionSnapshot } from '../src/server/snapshot-filter';
import type { AdminBot } from '../src/admin/service';
import { fakeService, socketClient, startFixture, type Frame } from './server-fixture';

/** devices-4a 4.7: a Bot session sees its own bot and the groups it reaches. main 必败: there was no filter. */
const principal = (place: 'dm' | 'group' | 'comment') => ({ kind: 'bot-session' as const, sessionId: 'ses_0123456789abcdef', appId: 'cli_x', place, ...(place === 'group' ? { chatId: 'oc_a' } : place === 'dm' ? { chatId: 'oc_dm' } : {}) });
const membership = (agentId: string, groupId: string) => ({ id: `${agentId}:${groupId}`, agentId, groupId, name: groupId });
const snapshot = {
  revision: 3, observedAt: 1, stale: false, host: { kind: 'running' }, tools: [{ tool: 'codex' }],
  agents: [{ id: 'cli_x', name: 'X', diagnostics: { secret: 1 } }, { id: 'cli_z', name: 'Z' }],
  groups: [{ id: 'oc_a' }, { id: 'oc_b' }, { id: 'oc_c' }],
  memberships: [membership('cli_x', 'oc_a'), membership('cli_x', 'oc_b'), membership('cli_z', 'oc_c'), membership('cli_z', 'oc_a')],
  projects: [
    { id: 'prj_0000000a', name: 'A', bindings: [{ agentId: 'cli_x', groupId: 'oc_a' }, { agentId: 'cli_z', groupId: 'oc_a' }] },
    { id: 'prj_0000000c', name: 'C', bindings: [{ agentId: 'cli_z', groupId: 'oc_c' }] },
  ],
  jobs: [{ id: 'j1', agentId: 'cli_x' }, { id: 'j2', agentId: 'cli_z' }, { id: 'j3' }],
  recentConversations: { items: [{ agentId: 'cli_x', groupId: 'oc_a' }, { agentId: 'cli_x', groupId: 'oc_b' }, { agentId: 'cli_z', groupId: 'oc_c' }], unavailableBots: 2 },
  application: { platform: 'linux', version: '0.9.0', loginItem: false, dataPath: '/data', crashes: { records: [{ appId: 'cli_z' }] } },
} as unknown as DesktopSnapshot;
const ids = (list: Array<{ id: string }>) => list.map(item => item.id);

describe('filterSnapshot', () => {
  it('leaves a reach of one group (the owner\'s --scope group=) one bot and its own group', () => {
    const shown = filterSnapshot(snapshot, principal('group'), { bot: 'cli_x', group: 'oc_a' });
    expect(ids(shown.agents)).toEqual(['cli_x']);
    expect(shown.agents[0]).not.toHaveProperty('diagnostics');
    expect(ids(shown.groups)).toEqual(['oc_a']);
    expect(shown.memberships.map(item => item.groupId)).toEqual(['oc_a']);
    expect(shown.projects?.map(project => [project.id, project.bindings])).toEqual([['prj_0000000a', [{ agentId: 'cli_x', groupId: 'oc_a' }]]]);
    expect(ids(shown.jobs)).toEqual(['j1']);
    expect(shown.recentConversations).toEqual({ items: [{ agentId: 'cli_x', groupId: 'oc_a' }], unavailableBots: 0 });
    expect(shown.application).toEqual({ platform: 'linux', version: '0.9.0', loginItem: false, dataPath: '/data' });
    expect([shown.host, shown.tools, shown.revision]).toEqual([snapshot.host, snapshot.tools, 3]);
  });

  it('leaves a private chat its bot\'s groups, narrowed by --scope group; a comment none', () => {
    expect(ids(filterSnapshot(snapshot, principal('dm'), { bot: 'cli_x' }).groups)).toEqual(['oc_a', 'oc_b']);
    expect(ids(filterSnapshot(snapshot, principal('dm'), { bot: 'cli_x', group: 'oc_b' }).groups)).toEqual(['oc_b']);
    const comment = filterSnapshot(snapshot, principal('comment'), { bot: 'cli_x' });
    expect([ids(comment.agents), comment.groups, comment.memberships, comment.projects]).toEqual([['cli_x'], [], [], []]);
  });
});

// s1b: a group's session reads the least its command line resolves names with. main 必败: it read its group's folder,
// tier, backend, jobs, recent conversations, tools and the data path.
describe('sessionSnapshot', () => {
  const full = {
    ...snapshot,
    host: { kind: 'blocked', message: '另一个 vonvon 在 /data 运行' },
    agents: [{ id: 'cli_x', name: 'X', avatarDataUrl: 'data:x', enabled: true, running: true, connection: '已连接 · ws', activation: 'active', diagnostics: { secret: 1 }, lockHeld: { pid: 1 } }, { id: 'cli_z', name: 'Z' }],
    groups: [{ id: 'oc_a', name: '研发群', avatarDataUrl: 'data:a' }, { id: 'oc_b', name: 'B' }],
    memberships: [{ ...membership('cli_x', 'oc_a'), directory: '/w/secret', backend: 'claude-agent', permission: { administrator: 'full', member: 'full', network: true } }, membership('cli_x', 'oc_b')],
    projects: [{ id: 'prj_0000000a', name: 'A', revision: 2, directory: '/w/secret', bindings: [{ agentId: 'cli_x', groupId: 'oc_a' }, { agentId: 'cli_z', groupId: 'oc_a' }] },
      { id: 'prj_0000000b', name: 'B', revision: 1, directory: '/w/b', bindings: [{ agentId: 'cli_x', groupId: 'oc_b' }] }],
    application: { platform: 'linux', version: '0.9.0', loginItem: true, dataPath: '/data', service: { state: 'running', skipped: false }, crashes: { records: [] } },
  } as unknown as DesktopSnapshot;
  it('gives a group its bot\'s and its group\'s names, its project\'s id and name, and blanks for the rest', () => {
    const shown = sessionSnapshot(full, principal('group'));
    expect(shown).toEqual({
      revision: 3, observedAt: 1, stale: false, host: { kind: 'blocked', message: '' },
      agents: [{ id: 'cli_x', name: 'X', enabled: true, running: true, connection: '', activation: 'active' }],
      groups: [{ id: 'oc_a', name: '研发群' }], memberships: [],
      projects: [{ id: 'prj_0000000a', name: 'A', revision: 2, directory: '', bindings: [{ agentId: 'cli_x', groupId: 'oc_a' }] }],
      tools: [], jobs: [], application: { platform: 'linux', version: '0.9.0', loginItem: false, dataPath: '' },
    });
    expect(JSON.stringify(shown)).not.toMatch(/\/w\/|\/data|full|claude-agent|oc_b|cli_z|data:/);
  });
  it('gives a comment its bot alone', () => {
    const comment = sessionSnapshot(full, principal('comment'));
    expect([comment.agents.map(agent => agent.id), comment.groups, comment.memberships, comment.projects]).toEqual([['cli_x'], [], [], []]);
  });
});

describe('snapshot events', () => {
  const bot = (appId: string, running: boolean): AdminBot => ({ appId, name: appId, tenant: 'feishu', active: true, current: appId === 'cli_x', running, completionReminder: { mode: 'failures', longTaskMinutes: 3 } });
  it('goes to the owner whole, to a negotiated Bot session filtered, and not to a connection of another protocol', async () => {
    let running = true;
    const service = fakeService({
      listBots: async () => [bot('cli_x', true), bot('cli_z', running)],
      listProjects: async appId => [{ name: appId === 'cli_x' ? 'A' : 'C', chatId: appId === 'cli_x' ? 'oc_a' : 'oc_c', cwd: '/w', blank: false, kind: 'multi', origin: 'joined',
        noMention: false, mode: 'qa', guestMode: 'qa', network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1 }],
    });
    const fixture = await startFixture(service);
    try {
      const owner = await socketClient(fixture.api.port, fixture.credential); await owner.ready();
      const old = await socketClient(fixture.api.port, fixture.credential, PROTOCOL_VERSION + 1); await old.ready();
      const token = fixture.sessionTokens.issue({ appId: 'cli_x', place: 'group', chatId: 'oc_a', sessionId: 'ses_0123456789abcdef' });
      const early = await socketClient(fixture.api.port, token); await early.ready();
      const session = await socketClient(fixture.api.port, token); await session.ready();
      await session.call({ type: 'request', id: 'n', method: 'admin', payload: { type: 'negotiate', capabilities: ['cli'], scope: { bot: 'cli_x', group: 'oc_a' } } });
      const got = await session.call({ type: 'request', id: 'g', method: 'snapshot', payload: { type: 'get' } });
      expect(got.type === 'response' && got.method === 'snapshot' && got.payload.agents.map(agent => agent.id)).toEqual(['cli_x']);
      running = false;
      await owner.call({ type: 'request', id: 'r', method: 'command', payload: { type: 'refresh' } });
      const isSnapshot = (frame: Frame) => frame.type === 'event' && frame.event === 'snapshot';
      const whole = await owner.wait(isSnapshot);
      const filtered = await session.wait(isSnapshot);
      expect(whole.type === 'event' && whole.event === 'snapshot' && whole.payload.agents.map(agent => agent.id).sort()).toEqual(['cli_x', 'cli_z']);
      expect(filtered.type === 'event' && filtered.event === 'snapshot' && [filtered.payload.agents.map(agent => agent.id), filtered.payload.groups.map(group => group.id)]).toEqual([['cli_x'], ['oc_a']]);
      // a round trip after the publish: anything sent before it has arrived
      await old.call({ type: 'request', id: 's', method: 'admin', payload: { type: 'daemonStatus' } });
      await early.call({ type: 'request', id: 's', method: 'admin', payload: { type: 'daemonStatus' } });
      expect(old.frames.filter(isSnapshot)).toEqual([]);
      expect(early.frames.filter(isSnapshot)).toEqual([]);
      for (const client of [owner, old, early, session]) await client.close();
    } finally { await fixture.close(); }
  });
});
