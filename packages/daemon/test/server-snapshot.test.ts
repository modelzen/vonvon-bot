import { afterEach, describe, expect, it } from 'vitest';
import type { AdminBot } from '../src/admin/service';
import { createSnapshotStore, type SnapshotStore } from '../src/server/snapshot';

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
});
