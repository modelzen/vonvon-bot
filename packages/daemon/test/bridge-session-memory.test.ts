import { rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from '@vonvon/protocol';
import type { AgentThread } from '../src/agent/types';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { listProjects } from '../src/project/registry';
import { decisionMessages } from '../src/bot/memory-authority';
import { authorize, type AuthzDeps } from '../src/server/authz';

/**
 * Codex review 239-1 / 241-1: a private chat's session writes the memory of a project its bot is bound to. Through the
 * bridge as `startBridge` wires it (its memory writer, its registry, the projects table on disk) and the host's check
 * in front: only Feishu, the orchestrator and the stores the bridge does not read for this are stand-ins.
 */
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'bridge-session-memory-'));
  return {
    paths: { appDir: dir, projectsFile: join(dir, 'projects.json'), sessionsFile: join(dir, 'sessions.json'), topicsDir: join(dir, 'topics') },
    botDir: (appId: string) => join(dir, 'bots', appId),
    botPaths: (appId: string) => ({ dir: join(dir, 'bots', appId), schedulesFile: join(dir, 'bots', appId, 'schedules.json') }),
  };
});
afterAll(() => rmSync(dirname(paths.projectsFile), { recursive: true, force: true }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} }, withTrace: async (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/bot/bridge-channel', () => ({ createBridgeChannel: () => ({ on() {}, connect: async () => {}, disconnect: async () => {} }) }));
vi.mock('../src/config/card-callback', () => ({ createCardCallbackRecorder: () => ({ received() {}, close: async () => {} }) }));
vi.mock('../src/config/app-roles', () => ({
  APP_ROLE_CACHE_MS: 60_000, APP_ROLE_RETRY_MS: 30_000, trustedFeishuAdmins: () => [], getAppRoleSnapshot: () => undefined,
  createAppRoleRefresher: () => ({ refresh: async () => {}, stop: async () => {} }),
}));
vi.mock('../src/admin/groups', () => ({ createGroupExecutor: () => async () => ({ groups: [] }) }));
vi.mock('../src/bot/topic-registry', () => ({ createTopicRegistry: () => ({}) }));
vi.mock('../src/bot/session-store', () => ({ adoptAdminSessions: async () => [] }));
vi.mock('../src/host/crash-guard', () => ({ onCrashSync: () => () => {} }));
vi.mock('../src/bot/handle-message', () => ({ createOrchestrator: () => ({
  initialize: async () => {}, dispatcher: { handle: async () => {} }, shutdown: async () => {},
  replyDropped() {}, saveDroppedSync() {}, settings: {}, scheduler: { start: async () => {}, stop() {}, drain: async () => {} },
}) }));

import { startBridge } from '../src/bot/bridge';

const APP = 'cli_fixture';
const OWNER = 'ou_owner';
const MEMBER = 'ou_member';
const DEV = 'prj_0000000a';
const OPS = 'prj_0000000b';
const cfg = { accounts: { app: { id: APP, secret: 'x', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: OWNER } } } as AppConfig;
const row = (name: string, chatId: string, projectId?: string) => ({ name, chatId, cwd: `/w/${name}`, blank: false, createdAt: 1, ...(projectId ? { projectId } : {}) });
const storeProjects = (projects: object[]) => writeFile(paths.projectsFile, JSON.stringify({ version: 1, projects }));
const thread = (): AgentThread => ({
  sessionId: 'fixture', isAlive: () => true, close: async () => {}, runStreamed: () => { throw new Error('unused'); }, runGoal: () => { throw new Error('unused'); },
  clearGoal: async () => {}, steer: async () => {}, abort: async () => {}, compact: async () => ({ compacted: false, usage: null }),
});
const request = (payload: object): Request => ({ type: 'request', id: '1', method: 'memory', payload } as Request);
const item = (projectId: string) => ({ scope: { kind: 'project' as const, projectId }, source: { via: 'tool' as const, botId: APP, actorRole: 'member' as const, actorOpenId: MEMBER } });

let handle: Awaited<ReturnType<typeof startBridge>> | undefined;
beforeEach(async () => { await mkdir(dirname(paths.projectsFile), { recursive: true }); });
afterEach(async () => { await handle?.shutdown(); handle = undefined; });
const bridge = async () => (handle = await startBridge({ identity: { appId: APP, tenant: 'feishu', createdAt: 1 }, cfg, appSecret: 'x', fallbackCwd: '/w' })).entries;

/** A private chat's session of the bridge with `who`'s turn going, and the host in front asking its Bot process as the supervisor does. */
function privateChat(entries: Awaited<ReturnType<typeof bridge>>, who: string, text: string) {
  const entry = entries.issue({ kind: 'p2p', chatId: 'oc_dm' });
  const made = thread();
  entry.attach(made);
  entries.openTurn(made, { requesterOpenId: who, requesterKind: 'user', triggerMessageId: 'om_1', retry: false, initiative: false, wake: false, typed: true, triggerText: text });
  // The host's half reads the same table (server/http.ts `groupsOf`); the item as stored is the host's to read.
  const deps: AuthzDeps = {
    groupsOf: async () => (await listProjects()).map(project => ({ name: project.name, chatId: project.chatId, ...(project.projectId ? { projectId: project.projectId } : {}) })),
    askBot: (_appId, sessionId, action) => entries.authorizeSessionCall(sessionId, action),
    memoryItem: async scope => scope.kind === 'project' ? item(scope.projectId) : undefined,
  };
  const peer = { principal: { kind: 'bot-session' as const, sessionId: entry.sessionId, appId: APP, place: 'dm' as const, chatId: 'oc_dm' }, protocolVersion: 2, negotiated: true, scope: { bot: APP } };
  return {
    ask: (payload: object) => authorize(peer, request(payload), deps),
    bot: (action: Parameters<typeof entries.authorizeSessionCall>[1]) => entries.authorizeSessionCall(entry.sessionId, action),
  };
}

describe('a private chat\'s session and its bot\'s projects, as the bridge wires them', () => {
  // main 必败: the bridge gave the memory writer no projects for a private chat, so each of these was refused
  it('adds, edits and archives the memory of a project its bot is bound to, on the owner\'s turn', async () => {
    await storeProjects([row('研发', 'oc_dev', DEV), row('运营', 'oc_ops', OPS)]);
    const chat = privateChat(await bridge(), OWNER, '记住 研发周四发版');
    const owner = { role: 'owner', openId: OWNER };
    expect(await chat.ask({ type: 'add', scope: { kind: 'project', projectId: DEV }, text: '周四发版' })).toMatchObject({ ok: true, grant: { ...owner,
      memory: { scope: { kind: 'project', projectId: DEV }, trust: 'trusted', actor: owner, source: { botId: APP, chatId: 'oc_dm', messageId: 'om_1' } } } });
    expect(await chat.ask({ type: 'edit', scope: { kind: 'project', projectId: OPS }, itemId: `p_${OPS}:000001`, revision: 1, text: '周五发版' }))
      .toMatchObject({ ok: true, grant: { memory: { scope: { kind: 'project', projectId: OPS }, actor: owner } } });
    expect(await chat.ask({ type: 'archive', scope: { kind: 'project', projectId: DEV }, itemId: `p_${DEV}:000001`, revision: 1 }))
      .toMatchObject({ ok: true, grant: { memory: { scope: { kind: 'project', projectId: DEV } } } });
  });

  it('counts each project once and reads the table every time: one no group binds stays out until one does', async () => {
    // two groups of one project, a row from before projects and one whose id is not a project's
    await storeProjects([row('研发', 'oc_dev', DEV), row('研发二群', 'oc_dev2', DEV), row('旧群', 'oc_old'), row('坏行', 'oc_bad', 'not-a-project')]);
    const entries = await bridge();
    // a member's --bot lands in the bot's one project, as memory_add does in a private chat (two would leave it nowhere)
    expect(await privateChat(entries, MEMBER, '你好').ask({ type: 'add', scope: { kind: 'bot', botId: APP }, text: '周四发版' }))
      .toMatchObject({ ok: true, grant: { memory: { scope: { kind: 'project', projectId: DEV }, trust: 'untrusted', source: { downgraded: 'member' } } } });
    // OPS is no group's of this bot: the host refuses it first, and its Bot process would too
    const owner = privateChat(entries, OWNER, '记住 运营');
    const add = { kind: 'memory', op: 'add', target: { kind: 'project', projectId: OPS }, text: 'x' } as const;
    expect(await owner.ask({ type: 'add', scope: { kind: 'project', projectId: OPS }, text: 'x' })).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(await owner.bot(add)).toEqual({ ok: false, reason: 'not-allowed-here', message: decisionMessages['not-allowed-here'] });
    await storeProjects([row('研发', 'oc_dev', DEV), row('运营', 'oc_ops', OPS)]);
    expect(await owner.ask({ type: 'add', scope: { kind: 'project', projectId: OPS }, text: 'x' })).toMatchObject({ ok: true, grant: { memory: { scope: { kind: 'project', projectId: OPS } } } });
  });
});
