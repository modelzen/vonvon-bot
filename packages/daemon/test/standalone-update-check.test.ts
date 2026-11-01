import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { checkStandaloneUpdate, lastStandaloneCheck, scheduleStandaloneChecks, type StandaloneDeps } from '../src/service/standalone-update';
import { BASE, fakeCdn, manifestPayload, signManifest, testKeys } from './helpers/fake-cdn';

// main 必败: a standalone server had no update check (server-3 4.4, C4)
const root = mkdtempSync(join(tmpdir(), 'vonvon-standalone-check-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const keys = testKeys();
const MANIFEST = `${BASE}/stable/manifest.json`;
let count = 0;
function setup(current = '1.0.0') {
  const cdn = fakeCdn();
  const installRoot = join(root, `install-${++count}`);
  const deps: StandaloneDeps = { installRoot, currentVersion: current, config: () => keys.config, fetch: cdn.fetch, now: () => 42 };
  const publish = (version: string, publishedAt: number, key = keys.privateKey) => cdn.routes.set(MANIFEST, { body: signManifest(manifestPayload(version, publishedAt), key) });
  const state = async () => JSON.parse(await readFile(join(installRoot, 'update-state.json'), 'utf8')) as Record<string, unknown>;
  return { cdn, deps, publish, state, installRoot };
}

describe('checkStandaloneUpdate', () => {
  it('finds a newer signed version and remembers it as the highest seen', async () => {
    const { deps, publish, state, installRoot } = setup();
    await mkdir(installRoot, { recursive: true });
    publish('1.0.1', 2000);
    expect(await checkStandaloneUpdate(deps)).toEqual({ current: '1.0.0', latest: '1.0.1', hasUpdate: true, channel: 'stable' });
    expect(await state()).toEqual({ v: 1, highestSeen: '1.0.1', lastPublishedAt: 2000, lastCheckAt: 42 });
    expect(lastStandaloneCheck()).toMatchObject({ latest: '1.0.1' });
    // the same manifest again is fine
    expect(await checkStandaloneUpdate(deps)).toMatchObject({ latest: '1.0.1', hasUpdate: true });
  });
  it('refuses an older publish time or an older version than seen, and keeps its state', async () => {
    const { deps, publish, state, installRoot } = setup();
    await mkdir(installRoot, { recursive: true });
    publish('1.0.1', 2000);
    await checkStandaloneUpdate(deps);
    publish('1.0.2', 1999);
    expect(await checkStandaloneUpdate(deps)).toEqual({ current: '1.0.0', latest: null, hasUpdate: false, channel: 'stable', refused: 'rollback' });
    publish('1.0.0', 3000);
    expect(await checkStandaloneUpdate(deps)).toMatchObject({ latest: null, refused: 'rollback' });
    expect(await state()).toEqual({ v: 1, highestSeen: '1.0.1', lastPublishedAt: 2000, lastCheckAt: 42 });
  });
  it('says latest even when it is this version', async () => {
    const { deps, publish, installRoot } = setup('1.0.1');
    await mkdir(installRoot, { recursive: true });
    publish('1.0.1', 1);
    expect(await checkStandaloneUpdate(deps)).toMatchObject({ latest: '1.0.1', hasUpdate: false });
  });
  it('tells a missing key, a bad signature and no network apart', async () => {
    const { deps, publish, installRoot } = setup();
    await mkdir(installRoot, { recursive: true });
    expect(await checkStandaloneUpdate({ ...deps, config: () => null })).toMatchObject({ latest: null, refused: 'config' });
    publish('1.0.1', 1, testKeys().privateKey);
    expect(await checkStandaloneUpdate(deps)).toMatchObject({ latest: null, refused: 'signature' });
    expect(await checkStandaloneUpdate({ ...deps, fetch: async () => { throw new TypeError('fetch failed'); } })).toMatchObject({ latest: null, refused: 'network' });
  });
  it('starts over from this version when update-state.json is unreadable', async () => {
    const { deps, publish, installRoot, state } = setup('1.0.1');
    await mkdir(installRoot, { recursive: true });
    await writeFile(join(installRoot, 'update-state.json'), '{"v":2}');
    publish('1.0.0', 1);
    expect(await checkStandaloneUpdate(deps)).toMatchObject({ refused: 'rollback' });
    publish('1.0.1', 1);
    expect(await checkStandaloneUpdate(deps)).toMatchObject({ latest: '1.0.1' });
    expect(await state()).toMatchObject({ highestSeen: '1.0.1' });
    expect(await readFile(join(installRoot, 'update-state.json.invalid'), 'utf8')).toBe('{"v":2}');
  });
  // review F7, I3-SEC-2: every writer shared update-state.json.tmp, and the second rename failed with ENOENT
  it('takes checks at the same time one after another', async () => {
    const { deps, publish, installRoot, state } = setup();
    await mkdir(installRoot, { recursive: true });
    publish('1.0.1', 2000);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => checkStandaloneUpdate(deps)));
    expect(results.map(result => result.status)).toEqual(Array(8).fill('fulfilled'));
    expect(await state()).toMatchObject({ highestSeen: '1.0.1', lastPublishedAt: 2000 });
    expect((await readdir(installRoot)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it('accepts nothing when update-state.json is there but cannot be read', async () => {
    const { deps, publish, installRoot } = setup();
    await mkdir(join(installRoot, 'update-state.json'), { recursive: true });
    publish('1.0.1', 2000);
    expect(await checkStandaloneUpdate(deps)).toMatchObject({ latest: null, hasUpdate: false, refused: 'state' });
    expect((await stat(join(installRoot, 'update-state.json'))).isDirectory()).toBe(true);
  });
});

describe('scheduleStandaloneChecks', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('checks 60 s after start and then every 24 hours, never sooner', async () => {
    vi.useFakeTimers();
    const { deps, publish, cdn, installRoot } = setup();
    await mkdir(installRoot, { recursive: true });
    publish('1.0.1', 1);
    const stop = scheduleStandaloneChecks(deps);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(cdn.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cdn.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(23 * 3_600_000);
    expect(cdn.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(cdn.requests).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(48 * 3_600_000);
    expect(cdn.requests).toHaveLength(2);
  });
});
