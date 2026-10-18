import { describe, expect, it } from 'vitest';
import type { AdminBot, AdminProject } from '../src/admin/service';
import { readAdminState } from '../src/server/state';
import { projectState } from '../src/server/projection';
import { adminProjectSchema, desktopSnapshotSchema } from '@vonvon/protocol';

const bot: AdminBot = { appId: 'cli_test', name: 'test', tenant: 'feishu', active: true, current: true, running: true, pid: 123, startedAt: 100, completionReminder: { mode: 'failures', longTaskMinutes: 3 } };
const project: AdminProject = { name: 'project', chatId: 'oc_test', cwd: '/tmp/project', blank: false, branch: 'main', kind: 'multi', origin: 'joined', noMention: false, mode: 'write', guestMode: 'qa', network: true, backend: 'codex-appserver', allowedUsersCount: 2, sessionCount: 3, createdAt: 1 };
const empty = desktopSnapshotSchema.parse({ revision: 1, observedAt: 1, stale: false, host: { kind: 'connected', ownership: 'owned', version: '1' }, agents: [], memberships: [], groups: [], tools: [], jobs: [], application: { platform: 'macos', version: '1', loginItem: false, dataPath: '/tmp' } });

describe('lossless admin state and pinned projection', () => {
  it('retains every service field and ordered avatar budget without mutating service values', async () => {
    const first = { ...bot, avatarDataUrl: 'a'.repeat(1_500_000) };
    const second = { ...bot, appId: 'cli_second', avatarDataUrl: 'b'.repeat(300_000) };
    const row = { ...project, avatarDataUrl: 'c'.repeat(400_000) };
    const state = await readAdminState({ listBots: async () => [first, second], listProjects: async () => [row] });
    expect(state.bots[0]).toEqual({ ...first, projects: [row] });
    expect(state.bots[1]).toEqual({ ...bot, appId: 'cli_second', projects: [project] });
    expect(second.avatarDataUrl).toHaveLength(300_000);
    expect(row.avatarDataUrl).toHaveLength(400_000);
    expect(state.generatedAt).toBeTypeOf('number');
  });

  it('keeps projectsError and the previous stale membership on a corrupt project read', async () => {
    const good = await readAdminState({ listBots: async () => [bot], listProjects: async () => [project] });
    const previous = { ...empty, ...projectState(good, empty, new Set()) };
    const bad = await readAdminState({ listBots: async () => [bot], listProjects: async () => { throw new Error('invalid projects.json'); } });
    expect(bad.bots).toEqual([{ ...bot, projects: [], projectsError: 'invalid projects.json' }]);
    const projected = projectState(bad, previous, new Set());
    expect(projected.stale).toBe(true);
    expect(projected.memberships).toEqual(previous.memberships.map(member => ({ ...member, stale: true })));
    expect(projected.agents[0]?.readError).toBe('invalid projects.json');
  });

  it('s36c2d: carries a misplaced directory to the membership only when there is one', async () => {
    const state = await readAdminState({ listBots: async () => [bot], listProjects: async () => [{ ...project, directoryProblem: 'botRoot' }, { ...project, name: 'fine', chatId: 'oc_fine' }] });
    const projected = projectState(state, empty, new Set());
    expect(desktopSnapshotSchema.parse({ ...empty, ...projected }).memberships.map(member => member.directoryProblem)).toEqual(['botRoot', undefined]);
    expect(projected.memberships[1]).not.toHaveProperty('directoryProblem');
  });

  it('s25c: shows 智能 as smart on the wire, its response always mention', async () => {
    const smart: AdminProject = { ...project, kind: 'smart', noMention: false };
    expect(adminProjectSchema.parse(smart).kind).toBe('smart');
    const state = await readAdminState({ listBots: async () => [bot], listProjects: async () => [smart, { ...project, name: 'single', chatId: 'oc_single', kind: 'single', noMention: true }] });
    const memberships = desktopSnapshotSchema.parse({ ...empty, ...projectState(state, empty, new Set()) }).memberships;
    expect(memberships.map(member => [member.conversation, member.response])).toEqual([['smart', 'mention'], ['shared', 'all']]);
  });

  it('marks duplicate group bindings stale and preserves pinned activation semantics', async () => {
    const state = await readAdminState({ listBots: async () => [{ ...bot, running: false }], listProjects: async () => [project, project] });
    const projected = projectState(state, empty, new Set());
    expect(projected.memberships).toEqual([]);
    expect(projected.agents[0]?.activation).toBe('restartRequired');
    expect(projected.agents[0]?.connection).toBe('disconnected');
    expect(projected.stale).toBe(true);
  });
});
