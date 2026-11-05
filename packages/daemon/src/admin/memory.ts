import { join } from 'node:path';
import { memoryReplySchema, type MemoryItemScope, type MemoryReply, type MemoryRequest, type MemoryScopeRef } from '@vonvon/protocol';
import type { MemoryLanding } from './ipc';
import { loadBots } from '../config/bots';
import { markSeen, marksFrom, readSeen, seenKey, type SeenPage } from './memory-seen';
import { botDir } from '../config/paths';
import { dmPersonList } from '../project/registry';
import { libraryLocation, readLibrary, type LibraryLocation } from '../project/library';
import { RpcError } from '../server/errors';
import {
  botMemoryLocation, dmMemoryLocation, MemoryStore, projectMemoryLocation, transferItem,
  type BranchResult, type ItemResult, type MemoryActor, type Refused,
} from '../bot/memory-store';

/**
 * 记忆的 `memory` RPC 在 host 一侧的实现（记忆设计 §2.5）。桌面端和 `vonvon memory` 都走它：条目库有 `'memory'`
 * 内核互斥，所以不必经 IPC 分流，bot 跑不跑都能直接写。来源由这里填：桌面端是 `ui`，命令行是 `cli`，都是主人本机、可信。
 */
export interface MemoryAdminDeps {
  library?: LibraryLocation;
  /** `bots/<appId>/` of a bot that exists; throws for one that does not */
  botDirectory?: (botId: string) => Promise<string>;
  origin?: 'ui' | 'cli';
  /**
   * devices-4b 4.5: a Bot session's write as its Bot process decided it with the memory tools' rules (memory-authority):
   * the memory it lands in (a member's `--bot` lands in its group's project), as whom, trusted or not.
   */
  landing?: MemoryLanding;
  now?: () => number;
}

const APP_ID = /^[A-Za-z0-9_.-]{1,200}$/;
async function defaultBotDirectory(botId: string): Promise<string> {
  if (!APP_ID.test(botId) || botId === '.' || botId === '..') throw new RpcError('invalid_request', 'bot id 无效');
  if (!(await loadBots()).bots.some(bot => bot.appId === botId)) throw new RpcError('invalid_request', '没有这个 Bot');
  return botDir(botId);
}

export async function memoryStoreFor(scope: MemoryScopeRef, deps: MemoryAdminDeps = {}): Promise<MemoryStore> {
  const options = deps.now ? { now: deps.now } : {};
  if (scope.kind === 'project') {
    const library = deps.library ?? libraryLocation();
    const project = (await readLibrary(library)).projects.find(candidate => candidate.id === scope.projectId);
    if (!project) throw new RpcError('invalid_request', '没有这个项目');
    const limit = (project as { memoryLimit?: unknown }).memoryLimit;
    return new MemoryStore(projectMemoryLocation(project.id, { library, ...(typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? { limit } : {}) }), options);
  }
  const directory = await (deps.botDirectory ?? defaultBotDirectory)(scope.botId);
  return new MemoryStore(scope.kind === 'bot' ? botMemoryLocation(directory) : dmMemoryLocation(directory, scope.openId), options);
}

type Result = ItemResult | BranchResult | Refused;
function replyOf(result: Result): MemoryReply {
  if (result.ok) {
    if ('item' in result) return { kind: 'item', item: result.item, branchApplied: result.branchApplied, ...(result.newBranch ? { newBranch: true } : {}) };
    return { kind: 'branches', branches: result.branches, moved: result.moved };
  }
  if (result.reason === 'conflict') return { kind: 'conflict', message: result.message, ...('current' in result && result.current ? { current: result.current } : {}) };
  return { kind: 'refused', reason: result.reason, message: result.message };
}

/** One page's list with the 新 marks against the time its owner last opened it (5.8). */
async function listWithMarks(store: MemoryStore, scope: MemoryScopeRef, deps: MemoryAdminDeps): Promise<MemoryReply> {
  const view = await store.read();
  const page: SeenPage | undefined = scope.kind === 'project' ? { kind: 'project', projectId: scope.projectId } : scope.kind === 'bot' ? { kind: 'bot', botId: scope.botId } : undefined;
  if (!page) return { kind: 'list', ...view };
  const library = deps.library ?? libraryLocation();
  const [seen, events] = await Promise.all([readSeen(library), store.events()]);
  const marks = marksFrom(events, view.items, seen[seenKey(page)] ?? 0);
  return { kind: 'list', ...view, newIds: [...marks.ids], newBranches: [...marks.branches], madeRoom: [...marks.madeRoom] };
}

/** 导航和列表上的数：每个项目、每个 Bot 上次打开以后新了几条。读不出来的那一份不算。 */
async function newCounts(deps: MemoryAdminDeps): Promise<MemoryReply> {
  const library = deps.library ?? libraryLocation();
  const seen = await readSeen(library);
  const count = async (scope: MemoryScopeRef): Promise<number> => {
    try {
      const store = await memoryStoreFor(scope, deps);
      const [view, events] = await Promise.all([store.read(), store.events()]);
      const key = scope.kind === 'project' ? seenKey({ kind: 'project', projectId: scope.projectId }) : scope.kind === 'bot' ? seenKey({ kind: 'bot', botId: scope.botId }) : '';
      return marksFrom(events, view.items, seen[key] ?? 0).ids.size;
    } catch { return 0; }
  };
  const projects: Record<string, number> = {};
  for (const project of (await readLibrary(library)).projects) { const n = await count({ kind: 'project', projectId: project.id }); if (n) projects[project.id] = n; }
  const bots: Record<string, number> = {};
  for (const bot of (await loadBots()).bots) { const n = await count({ kind: 'bot', botId: bot.appId }); if (n) bots[bot.appId] = n; }
  return { kind: 'newCounts', projects, bots };
}

/** dm-agent 5: who the private-chat memory page lists, from the bot's `dm.people`, with what each has. Not who is an admin now. */
async function dmPeople(botId: string, deps: MemoryAdminDeps): Promise<MemoryReply> {
  const directory = await (deps.botDirectory ?? defaultBotDirectory)(botId);
  const people = await Promise.all((await dmPersonList(join(directory, 'projects.json'))).map(async person => {
    const used = await memoryStoreFor({ kind: 'dm', botId, openId: person.openId }, deps).then(store => store.read()).then(view => view.used, () => 0);
    return { ...person, used };
  }));
  return { kind: 'dmPeople', people };
}

/** The memory a decision names, as a request names it: the bot's own for its memory and its private chats. */
const landedRef = (scope: MemoryItemScope, botId: string): MemoryScopeRef =>
  scope.kind === 'project' ? scope : scope.kind === 'bot' ? { kind: 'bot', botId } : { kind: 'dm', botId, openId: scope.openId };

export async function memoryAction(request: MemoryRequest, deps: MemoryAdminDeps = {}): Promise<MemoryReply> {
  const origin = deps.origin ?? 'ui';
  if (request.type === 'newCounts') return memoryReplySchema.parse(await newCounts(deps));
  if (request.type === 'dmPeople') return memoryReplySchema.parse(await dmPeople(request.botId, deps));
  if (request.type === 'seen') {
    const at = (deps.now ?? Date.now)();
    await markSeen(deps.library ?? libraryLocation(), request.page, at);
    return { kind: 'seen', at };
  }
  const landing = deps.landing;
  const actor: MemoryActor = landing?.actor ?? { role: origin === 'cli' ? 'cli' : 'desktop' };
  // The owner at the desktop or the terminal is trusted; a session's turn as its Bot process decided.
  const trust = landing?.trust ?? 'trusted';
  const botIdOf = (scope: MemoryScopeRef): string => scope.kind === 'project' ? '' : scope.botId;
  const scope = landing ? landedRef(landing.scope, landing.source.botId) : request.scope;
  const store = await memoryStoreFor(scope, deps);
  const checked = (reply: MemoryReply): MemoryReply => memoryReplySchema.parse(reply);
  switch (request.type) {
    case 'list': return checked(await listWithMarks(store, request.scope, deps));
    case 'add': return checked(replyOf(await store.add({
      text: request.text, ...(request.branch === undefined ? {} : { branch: request.branch }), trust, actor,
      source: { via: origin, botId: botIdOf(scope), ...landing?.source, actorRole: actor.role, ...(actor.openId ? { actorOpenId: actor.openId } : {}) },
    })));
    case 'edit': return checked(replyOf(await store.edit({
      itemId: request.itemId, revision: request.revision, actor,
      ...(request.text === undefined ? {} : { text: request.text }), ...(request.branch === undefined ? {} : { branch: request.branch }),
    })));
    case 'archive': return checked(replyOf(await store.archive({ itemId: request.itemId, revision: request.revision, actor })));
    case 'restore': return checked(replyOf(await store.restore({ itemId: request.itemId, revision: request.revision, actor })));
    case 'confirm': return checked(replyOf(await store.confirm({ itemId: request.itemId, revision: request.revision, actor })));
    case 'purge': {
      const result = await store.purge({ itemId: request.itemId, actor });
      return checked(result.ok ? { kind: 'purged' } : replyOf(result));
    }
    case 'undo': return checked(replyOf(await store.undo({ eventId: request.eventId, actor })));
    case 'branchRename': return checked(replyOf(await store.branchRename({ from: request.from, to: request.to, actor })));
    case 'branchMerge': return checked(replyOf(await store.branchMerge({ from: request.from, into: request.into, actor })));
    case 'branchDelete': return checked(replyOf(await store.branchDelete({ name: request.name, ...(request.expected === undefined ? {} : { expected: request.expected }), actor })));
    case 'export': return checked({ kind: 'exported', files: await store.exportBranches() });
    case 'reseal': { await store.reseal(); return checked({ kind: 'sealed' }); }
    case 'events': return checked({ kind: 'events', events: await store.events(request.itemId) });
    case 'promote': {
      if (request.scope.kind !== 'project') throw new RpcError('invalid_request', '只能把项目记忆移到 Bot 记忆');
      const to = await memoryStoreFor({ kind: 'bot', botId: request.botId }, deps);
      return checked(replyOf(await transferItem({ from: store, to, itemId: request.itemId, revision: request.revision, via: 'promoted', actor, ...(request.branch === undefined ? {} : { branch: request.branch }) })));
    }
    case 'move': {
      if (request.scope.kind !== 'bot') throw new RpcError('invalid_request', '只能把 Bot 记忆移回项目');
      const to = await memoryStoreFor({ kind: 'project', projectId: request.to.projectId }, deps);
      return checked(replyOf(await transferItem({ from: store, to, itemId: request.itemId, revision: request.revision, via: 'moved', actor, ...(request.branch === undefined ? {} : { branch: request.branch }) })));
    }
  }
}
