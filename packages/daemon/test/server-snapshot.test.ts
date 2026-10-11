import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminBot } from '../src/admin/service';
import { createSnapshotStore, type SnapshotStore } from '../src/server/snapshot';

const stores: SnapshotStore[] = [];
const probes = vi.hoisted(() => new Map<string, () => Promise<unknown>>());
vi.mock('../src/agent', async original => ({
  ...await original<typeof import('../src/agent')>(),
  createBackend: (id: string) => {
    const doctor = probes.get(id);
    if (!doctor) throw new Error('Missing test probe');
    return { doctor };
  },
}));
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); probes.clear(); });
const bot: AdminBot = { appId: 'cli_test', name: 'test', tenant: 'feishu', active: false, current: true, running: false, completionReminder: { mode: 'failures', longTaskMinutes: 3 } };

describe('snapshot commit queue', () => {
  it.each([
    ['claude-agent', 'claude'],
    ['copilot-acp', 'copilot'],
    ['opencode-server', 'opencode'],
    ['pi-rpc', 'pi'],
    ['custom-acp', 'acp'],
    ['codex-setup', 'codex'],
  ])('isolates a synchronous %s failure and preserves every other tool', async (failedProbe, failedTool) => {
    for (const id of ['claude-agent', 'copilot-acp', 'opencode-server', 'pi-rpc', 'custom-acp']) {
      if (id !== failedProbe) probes.set(id, async () => ({ ok: true, version: '1', depState: 'installed' }));
    }
    const store = await createSnapshotStore({
      service: {
        listBots: async () => [],
        listProjects: async () => [],
        codexSetup: () => {
          if (failedProbe === 'codex-setup') throw new Error('Codex setup failed');
          return Promise.resolve({ installation: 'installed', authentication: 'signedIn', version: '1', executable: '/bin/codex' });
        },
      },
      jobs: () => [],
      publish: () => {},
    });
    stores.push(store);
    expect(store.current().tools.map(tool => tool.tool)).toEqual(['codex', 'claude', 'copilot', 'opencode', 'pi', 'acp']);
    for (const tool of store.current().tools) {
      expect(tool).toEqual(tool.tool === failedTool
        ? { tool: failedTool, installation: 'unknown', authentication: 'unknown', version: null }
        : { tool: tool.tool, installation: 'installed', authentication: tool.tool === 'codex' ? 'signedIn' : 'notRequired', version: '1' });
    }
  });
  it('keeps other tool states when a constructor throws and shows an invalid ACP as unknown', async () => {
    probes.set('claude-agent', async () => ({ ok: true, version: '1', depState: 'installed' }));
    probes.set('opencode-server', async () => ({ ok: true, version: '2', depState: 'installed' }));
    probes.set('pi-rpc', async () => ({ ok: false, version: null, depState: 'external-missing', hint: 'Pi absent' }));
    probes.set('custom-acp', async () => ({ ok: false, version: null, hint: '自定义 ACP 命令文件无效：/fixture/custom-acp.json（命令文件内容无效）' }));
    const store = await createSnapshotStore({ service: { listBots: async () => [], listProjects: async () => [], codexSetup: async () => ({ installation: 'installed', authentication: 'signedIn', version: '1', executable: '/bin/codex' }) }, jobs: () => [], publish: () => {} });
    stores.push(store);
    expect(store.current().tools.map(tool => tool.tool)).toEqual(['codex', 'claude', 'copilot', 'opencode', 'pi', 'acp']);
    expect(store.current().tools.find(tool => tool.tool === 'copilot')).toMatchObject({ installation: 'unknown' });
    expect(store.current().tools.find(tool => tool.tool === 'opencode')).toMatchObject({ installation: 'installed' });
    expect(store.current().tools.find(tool => tool.tool === 'acp')).toMatchObject({ installation: 'unknown', message: expect.stringContaining('/fixture/custom-acp.json') });
  });
  it('starts at one without an event and publishes before a matching writer reply', async () => {
    let enabled = false;
    let probes = 0;
    const frames: string[] = [];
    const store = await createSnapshotStore({ service: { listBots: async () => [{ ...bot, active: enabled }], listProjects: async () => [] }, jobs: () => [], readTools: async () => { probes++; return []; }, publish: state => frames.push(`event:${state.revision}`) });
    stores.push(store);
    expect(store.current().revision).toBe(1);
    expect(frames).toEqual([]);
    await store.rebuild(state => frames.push(`reply:${state.revision}`));
    enabled = true;
    await Promise.all([store.rebuild(state => frames.push(`reply:${state.revision}`)), store.rebuild(state => frames.push(`reply:${state.revision}`))]);
    expect(frames).toEqual(['reply:1', 'event:2', 'reply:2', 'reply:2']);
    expect(probes).toBe(1);
    store.current();
    expect(probes).toBe(1);
  });

  it('recovers from a failed build without publishing or consuming a revision', async () => {
    let fail = false;
    let enabled = false;
    const revisions: number[] = [];
    const store = await createSnapshotStore({ service: { listBots: async () => { if (fail) throw new Error('read failed'); return [{ ...bot, active: enabled }]; }, listProjects: async () => [] }, jobs: () => [], readTools: async () => [], publish: state => revisions.push(state.revision) });
    stores.push(store);
    fail = true;
    await expect(store.rebuild()).rejects.toThrow('read failed');
    expect(store.current().revision).toBe(1);
    fail = false;
    enabled = true;
    await store.rebuild();
    expect(revisions).toEqual([2]);
  });
});
