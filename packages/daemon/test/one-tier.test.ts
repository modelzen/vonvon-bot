import { rmSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listProjects, listProjectsIn, splitTierChats, stricterTier, updateProject } from '../src/project/registry';
import { adoptAdminSessions, getSession, isRetiredKey, listSessions } from '../src/bot/session-store';
import { paths } from '../src/config/paths';
import { startBridge } from '../src/bot/bridge';
import type { AppConfig } from '../src/config/schema';

// s15c: one tier and one session per group. projects.json and sessions.json in a temp dir.
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'one-tier-test-'));
  return {
    paths: { appDir: dir, projectsFile: join(dir, 'projects.json'), sessionsFile: join(dir, 'sessions.json') },
    botDir: (appId: string) => join(dir, 'bots', appId),
    botPaths: (appId: string) => ({ schedulesFile: join(dir, 'bots', appId, 'schedules.json') }),
  };
});
afterAll(() => rmSync(dirname(paths.projectsFile), { recursive: true, force: true }));
const logged = vi.hoisted(() => ({ info: [] as unknown[][], fail: [] as unknown[][], adoptFails: false }));
vi.mock('../src/agent/codex-appserver/locate', () => ({
  refreshCodexResolution: () => null, resolveCodexBin: () => null, codexVersionAsync: async () => null, cachedCodexVersion: () => undefined,
}));
vi.mock('../src/core/logger', () => ({
  log: { info: (...args: unknown[]) => void logged.info.push(args), warn: () => undefined, fail: (...args: unknown[]) => void logged.fail.push(args) },
  withTrace: async (_ctx: unknown, fn: () => unknown) => fn(),
}));
// One start whose rename fails, as a full disk or an unreadable sessions.json would.
vi.mock('../src/bot/session-store', async (original) => {
  const store = await original<typeof import('../src/bot/session-store')>();
  return {
    ...store,
    adoptAdminSessions: (chats: Parameters<typeof store.adoptAdminSessions>[0]) => {
      if (!logged.adoptFails) return store.adoptAdminSessions(chats);
      logged.adoptFails = false;
      return Promise.reject(new Error('disk full'));
    },
  };
});
vi.mock('@larksuiteoapi/node-sdk', async (original) => ({
  ...await original<object>(),
  createLarkChannel: () => ({ rawClient: {}, on: () => undefined, connect: async () => undefined, disconnect: async () => undefined }),
}));

const row = (name: string, extra: object = {}) => ({ name, chatId: `oc_${name}`, cwd: `/w/${name}`, blank: false, createdAt: 1, ...extra });
const rec = (threadId: string, chatId: string, extra: object = {}) =>
  ({ threadId, chatId, cwd: '/w', sessionId: `s-${threadId}`, backend: 'codex-appserver', summary: '', createdAt: 1, updatedAt: 1, ...extra });
const storeProjects = (projects: object[]) => writeFile(paths.projectsFile, JSON.stringify({ version: 1, projects }));
const storeSessions = (sessions: object[]) => writeFile(paths.sessionsFile, JSON.stringify({ version: 3, sessions, titleJobs: [] }));
const rawProjects = async () => JSON.parse(await readFile(paths.projectsFile, 'utf8')).projects as Record<string, unknown>[];

beforeEach(async () => {
  await rm(paths.projectsFile, { force: true });
  await rm(paths.sessionsFile, { force: true });
});

describe('stricterTier', () => {
  it('takes the stricter of two tiers, a value that is not a tier counting as qa', () => {
    const tiers = ['qa', 'write', 'full'] as const;
    const table = tiers.map((a) => tiers.map((b) => stricterTier(a, b)));
    expect(table).toEqual([['qa', 'qa', 'qa'], ['qa', 'write', 'write'], ['qa', 'write', 'full']]);
    expect([stricterTier('full', 'bogus'), stricterTier(undefined, 'full'), stricterTier('write', null)]).toEqual(['qa', 'qa', 'qa']);
  });
});

describe('a row stored with two tiers', () => {
  const stored = [
    row('a', { mode: 'full', guestMode: 'qa' }),
    row('b', { guestMode: 'write' }),
    row('c', { mode: 'qa', guestMode: 'full' }),
    row('d', { mode: 'write', guestMode: 'bogus' }),
    row('e', { mode: 'full', guestMode: null }),
    row('f', { mode: 'write', guestMode: 'write' }),
    row('g', { autoCompact: false }),
  ];

  it('reads as one tier, the stricter one, and the file keeps it until a write', async () => {
    await storeProjects(stored);
    const read = await listProjectsIn(paths.projectsFile);
    expect(read.map((p) => [p.name, p.mode])).toEqual([['a', 'qa'], ['b', 'write'], ['c', 'qa'], ['d', 'qa'], ['e', 'full'], ['f', 'write'], ['g', undefined]]);
    expect(read.filter((p) => Object.hasOwn(p, 'guestMode'))).toEqual([]);
    expect((await rawProjects()).filter((p) => Object.hasOwn(p, 'guestMode'))).toHaveLength(6);
  });

  it('loses guestMode on the next write of projects.json, whatever the write is for', async () => {
    await storeProjects(stored);
    await updateProject('g', { noMention: true });
    const raw = await rawProjects();
    expect(raw.filter((p) => Object.hasOwn(p, 'guestMode'))).toEqual([]);
    expect(raw.map((p) => p.mode)).toEqual(['qa', 'write', 'qa', 'qa', 'full', 'write', undefined]);
    expect(raw.at(-1)).toMatchObject({ autoCompact: false, noMention: true });
  });

  it('names exactly the groups whose stored tiers differ, with the tier they run at now', async () => {
    expect(await splitTierChats()).toEqual(new Map());
    await storeProjects(stored);
    expect(await splitTierChats()).toEqual(new Map([['oc_a', 'qa'], ['oc_b', 'write'], ['oc_c', 'qa'], ['oc_d', 'qa']]));
  });
});

describe('adoptAdminSessions', () => {
  const sessions = [
    rec('oc_a', 'oc_a'), // an older binding nothing read while the group was split
    rec('oc_a#admin', 'oc_a', { lastSeenAt: 9, seen: [{ id: 'om_x', at: 9 }] }),
    rec('oc_a#guest', 'oc_a'),
    rec('omt_t', 'oc_a', { detached: true }),
    rec('omt_t#admin', 'oc_a'),
    rec('omt_u#admin', 'oc_a', { detached: true }),
    rec('oc_b#admin', 'oc_b'),
  ];

  it("gives a split group's admin sessions their place's key and leaves the rest alone", async () => {
    await storeSessions(sessions);
    expect((await adoptAdminSessions(new Set(['oc_a']))).sort()).toEqual(['oc_a', 'omt_t']);
    const after = await listSessions();
    expect(after.map((s) => [s.threadId, s.sessionId, s.detached ?? false])).toEqual([
      ['oc_a', 's-oc_a#admin', false],
      ['oc_a#guest', 's-oc_a#guest', false],
      ['omt_t', 's-omt_t#admin', false],
      ['omt_u#admin', 's-omt_u#admin', true],
      ['oc_b#admin', 's-oc_b#admin', false],
    ]);
    expect(await getSession('oc_a')).toMatchObject({ lastSeenAt: 9, seen: [{ id: 'om_x', at: 9 }], updatedAt: 1 });
    expect(after.filter((s) => isRetiredKey(s.threadId)).map((s) => s.threadId)).toEqual(['oc_a#guest', 'omt_u#admin', 'oc_b#admin']);
  });

  it('writes nothing when nothing moves, so a second start is a no-op', async () => {
    await storeSessions(sessions);
    await adoptAdminSessions(new Set(['oc_a']));
    const before = await stat(paths.sessionsFile);
    expect(await adoptAdminSessions(new Set(['oc_a']))).toEqual([]);
    expect(await adoptAdminSessions(new Set())).toEqual([]);
    expect((await stat(paths.sessionsFile)).ino).toBe(before.ino);
  });

  it('runs on the stored rows before they lose guestMode; after the next write nothing is split', async () => {
    await storeProjects([row('a', { mode: 'full', guestMode: 'qa' }), row('b')]);
    await storeSessions([rec('oc_a#admin', 'oc_a'), rec('oc_a#guest', 'oc_a')]);
    expect(await adoptAdminSessions(await splitTierChats())).toEqual(['oc_a']);
    await updateProject('b', { noMention: false });
    expect(await splitTierChats()).toEqual(new Map());
    expect((await listProjects()).find((p) => p.name === 'a')?.mode).toBe('qa');
    expect(await adoptAdminSessions(await splitTierChats())).toEqual([]);
    expect((await listSessions()).map((s) => s.threadId)).toEqual(['oc_a', 'oc_a#guest']);
  });
});

describe('at bot start', () => {
  const cfg = { accounts: { app: { id: 'cli_fixture', secret: 'x', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner', admins: ['ou_owner'] } } } as AppConfig;
  const start = async () => (await startBridge({ identity: { appId: cfg.accounts.app.id, tenant: cfg.accounts.app.tenant, createdAt: 1 }, cfg, appSecret: 'x', fallbackCwd: '/w' })).shutdown();
  const rawStore = async () => JSON.parse(await readFile(paths.projectsFile, 'utf8')) as Record<string, unknown>;
  beforeEach(() => { logged.info.length = 0; logged.fail.length = 0; logged.adoptFails = false; });

  it('renames before the bot reads the stores, and says which groups now run at which tier', async () => {
    await storeProjects([row('a', { mode: 'full', guestMode: 'qa' }), row('b')]);
    await storeSessions([rec('oc_a', 'oc_a'), rec('oc_a#admin', 'oc_a')]);
    await start();
    expect((await listSessions()).map((s) => [s.threadId, s.sessionId])).toEqual([['oc_a', 's-oc_a#admin']]);
    expect(logged.info).toContainEqual(['run', 'tier-merge', { chats: ['oc_a→qa'], sessions: 1, places: ['oc_a'] }]);
    expect(await rawStore()).not.toHaveProperty('tierMergePending');
    // Startup materializes group settings after the tier migration, folding guestMode.
    // A second start neither rewrites the files nor repeats the completed migration.
    expect((await rawProjects()).filter(p => Object.hasOwn(p, 'guestMode'))).toEqual([]);
    expect((await rawProjects()).map(p => [p.name, p.pendingPolicy])).toEqual([['a', 'steer'], ['b', 'steer']]);
    logged.info.length = 0;
    const files = async () => [(await stat(paths.projectsFile)).ino, (await stat(paths.sessionsFile)).ino];
    const before = await files();
    await start();
    expect(await files()).toEqual(before);
    expect(logged.info.filter(([, what]) => what === 'tier-merge')).toEqual([]);
  });

  it('retries after a failed start, even when a write in between dropped guestMode', async () => {
    await storeProjects([row('a', { mode: 'full', guestMode: 'qa' }), row('b')]);
    await storeSessions([rec('oc_a#admin', 'oc_a'), rec('oc_a#guest', 'oc_a')]);
    logged.adoptFails = true;
    await start();
    expect(logged.fail).toContainEqual(['run', new Error('disk full'), { phase: 'tier-merge' }]);
    expect((await listSessions()).map((s) => s.threadId)).toEqual(['oc_a#admin', 'oc_a#guest']);
    expect(await rawStore()).toMatchObject({ tierMergePending: ['oc_a'] });
    // Any write folds the rows; the chats it left stay.
    await updateProject('b', { noMention: true });
    expect((await rawProjects()).filter((p) => Object.hasOwn(p, 'guestMode'))).toEqual([]);
    expect(await rawStore()).toMatchObject({ tierMergePending: ['oc_a'] });
    await start();
    expect((await listSessions()).map((s) => [s.threadId, s.sessionId])).toEqual([['oc_a', 's-oc_a#admin'], ['oc_a#guest', 's-oc_a#guest']]);
    expect(logged.info).toContainEqual(['run', 'tier-merge', { chats: ['oc_a→qa'], sessions: 1, places: ['oc_a'] }]);
    expect(await rawStore()).not.toHaveProperty('tierMergePending');
    expect((await listProjects()).map((p) => [p.name, p.mode, p.noMention])).toEqual([['a', 'qa', undefined], ['b', undefined, true]]);
    // Nothing is left: a third start writes neither file.
    logged.info.length = 0;
    const before = [(await stat(paths.projectsFile)).ino, (await stat(paths.sessionsFile)).ino];
    await start();
    expect([(await stat(paths.projectsFile)).ino, (await stat(paths.sessionsFile)).ino]).toEqual(before);
    expect(logged.info.filter(([, what]) => what === 'tier-merge')).toEqual([]);
  });
});
