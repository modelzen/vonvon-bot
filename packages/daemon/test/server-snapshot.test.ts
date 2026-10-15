import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminBot } from '../src/admin/service';
import { createSnapshotStore, type SnapshotStore } from '../src/server/snapshot';

vi.mock('../src/agent', () => ({ createBackend: () => ({ doctor: async () => ({ ok: false, version: null, depState: 'not-installed' }) }) }));

const stores: SnapshotStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
const bot: AdminBot = { appId: 'cli_test', name: 'test', tenant: 'feishu', active: false, current: true, running: false, completionReminder: { mode: 'failures', longTaskMinutes: 3 } };

describe('snapshot commit queue', () => {
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

  it('marks an installed Codex that is too old so the checklist can say so', async () => {
    const setup = { installation: 'installed' as const, authentication: 'signedIn' as const, version: 'codex-cli 0.120.0', executable: '/bin/codex' };
    const store = await createSnapshotStore({ service: { listBots: async () => [], listProjects: async () => [], codexSetup: async () => setup }, jobs: () => [], publish: () => {} });
    stores.push(store);
    expect(store.current().tools[0]).toMatchObject({ tool: 'codex', version: 'codex-cli 0.120.0', compatibility: { status: 'tooOld', minimum: '0.139.0' } });
    expect(store.current().tools[1]).toMatchObject({ tool: 'claude', installation: 'missing' });
  });

  it('reads tools once more when asked during a read, so a fresh login is not lost', async () => {
    let reads = 0;
    let release: (() => void) | undefined;
    const store = await createSnapshotStore({ service: { listBots: async () => [], listProjects: async () => [] }, jobs: () => [], publish: () => {}, readTools: async () => {
      reads++;
      const version = String(reads);
      if (reads === 2) await new Promise<void>(resolve => { release = resolve; });
      return [{ tool: 'claude', installation: 'installed', authentication: reads >= 3 ? 'signedIn' : 'unknown', version }];
    } });
    stores.push(store);
    const inFlight = store.refreshTools();
    const afterLogin = store.refreshTools();
    const another = store.refreshTools();
    expect(afterLogin).toBe(another);
    release?.();
    await Promise.all([inFlight, afterLogin]);
    expect(reads).toBe(3);
    expect(store.current().tools[0]).toMatchObject({ authentication: 'signedIn', version: '3' });
  });
});
