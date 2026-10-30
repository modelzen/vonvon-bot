import type { ContextPreviewReply, ContextPreviewRequest } from '@vonvon/protocol';
import { decisionProvider } from '../judge/decision';
import { judgeBackendId, resolveJudgeModel } from '../judge/model';
import { groupBackendId } from '../config/execution';
import { loadBots } from '../config/bots';
import { botPaths } from '../config/paths';
import { assemble, judgeContext, loadContextSources, type Assembled, type ContextSources, type Section } from '../bot/context-assembly';
import { isRetiredKey, listSessionsIn, type MemoryDelivered, type SessionRecord } from '../bot/session-store';
import { listProjectsIn, type Project } from '../project/registry';
import type { LibraryLocation } from '../project/library';
import { RpcError } from '../server/errors';

/**
 * 记忆设计 5.5 的 `contextPreview`，host 一侧。只算 vonvon 自己交给模型的东西（D6）：角色设定、补充职责、两份记忆、
 * 身份行、vonvon 的工具，和智能判断会发给决策模型的。和开场、更新块用同一个 `assemble`（context-assembly.ts），所以面板和
 * 实际注入不会各算各的。不读项目目录，不读 `AGENTS.md`、`CLAUDE.md` 或个人指令文件，结果里也没有它们的路径。
 */
export interface ContextPreviewDeps {
  /** The bot process is up: only then is there a live session to show. */
  running: boolean;
  botName?: string;
  /** Tests. */
  library?: LibraryLocation;
  botDirectory?: string;
  projectsFile?: string;
  sessionsFile?: string;
}

/** What vonvon's tools are called to the model (the memory tools of 3.3); the workspace's own skills and MCP are not listed. */
export const VONVON_TOOL_NAMES = ['memory_add', 'memory_update', 'memory_forget', 'memory_list'] as const;

const SECTIONS: readonly Section[] = ['identity', 'role', 'supplement', 'botMemory', 'projectMemory'];
const USED_TEXT_CHARS = 200;
const chars = (value: string): number => Array.from(value).length;

function nextSections(src: ContextSources, a: Assembled): ContextPreviewReply['next']['sections'] {
  const size: Record<Section, number> = {
    identity: chars(a.identity), role: chars(src.soul.trim()), supplement: chars(src.supplement.trim()),
    botMemory: chars(a.botMemory), projectMemory: chars(a.projectTrusted) + chars(a.projectUntrusted),
  };
  return SECTIONS.map(key => {
    const memory = key === 'botMemory' ? a.cur.bot : key === 'projectMemory' ? a.cur.project : undefined;
    return { key, version: a.versions[key], chars: size[key], ...(memory ? { items: memory.items.length, branches: memory.branches.length } : {}) };
  });
}

function itemsOf(memory: Record<string, MemoryDelivered | undefined> | undefined): { bot: number; trusted: number; untrusted: number } {
  const project = Object.values(memory?.project?.items ?? {});
  return {
    bot: Object.keys(memory?.bot?.items ?? {}).length,
    trusted: project.filter(entry => entry[2] === 1).length,
    untrusted: project.filter(entry => entry[2] === 0).length,
  };
}

function pickSession(records: SessionRecord[], chatId: string, threadId: string | undefined): SessionRecord | undefined {
  if (threadId) {
    const found = records.find(record => record.threadId === threadId);
    return found && found.chatId === chatId && !isRetiredKey(found.threadId) ? found : undefined;
  }
  return records
    .filter(record => record.chatId === chatId && !record.detached && !isRetiredKey(record.threadId) && !record.threadId.startsWith('pending:'))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function sessionOf(record: SessionRecord, src: ContextSources, a: Assembled): NonNullable<ContextPreviewReply['session']> {
  const context = record.context;
  const base = { threadId: record.threadId, updatedAt: record.updatedAt, backend: record.backend };
  if (!context) return { ...base, legacy: true, redeliverDue: false, sections: [] };
  const sections = SECTIONS.map(key => {
    const delivered = context.memory?.[key === 'botMemory' ? 'bot' : 'project'];
    const memory = key === 'botMemory' || key === 'projectMemory' ? delivered : undefined;
    return { key, version: context.versions[key] ?? '', stale: (context.versions[key] ?? '') !== a.versions[key],
      ...(memory ? { items: Object.keys(memory.items).length, branches: memory.branches.length } : {}) };
  });
  const current = new Map([...(a.cur.bot?.items ?? []), ...(a.cur.project?.items ?? [])].map(item => [item.id, item.text] as const));
  const turn = context.lastTurn;
  return {
    ...base, legacy: false, redeliverDue: context.fullRedeliverDue === true, sections,
    ...(turn ? { lastTurn: { at: turn.at, injected: turn.injected, items: itemsOf(context.memory),
      ...(turn.missed?.length ? { missed: turn.missed } : {}),
      used: turn.used.map(id => { const text = current.get(id); return { id, ...(text === undefined ? {} : { text: Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, USED_TEXT_CHARS).join('') }) }; }) } } : {}),
  };
}

function judgeOf(src: ContextSources, row: Pick<Project, 'judge' | 'backend'> | undefined): ContextPreviewReply['judge'] {
  const judged = judgeContext(src);
  let selection = row?.judge;
  if (selection?.kind === 'default') {
    const backend = judgeBackendId(groupBackendId(row!), selection);
    const resolved = resolveJudgeModel(backend, { group: selection }, undefined);
    selection = resolved.provider ? { kind:'decision', provider:resolved.provider, model:resolved.model } : { kind:'llm', backend, model:resolved.model };
  }
  const thirdParty = selection?.kind === 'decision' || (selection?.kind === 'provider' && !!decisionProvider(selection.provider));
  const label = !selection ? undefined : selection.kind === 'llm' ? `${selection.backend} ${selection.model}` : selection.kind === 'decision' ? `${selection.provider} ${selection.model}` : selection.provider;
  return { via: thirdParty ? 'third-party' : 'local', ...(label ? { label } : {}), roleChars: chars(judged.role), memoryItems: judged.memory ? judged.memory.split('\n').length : 0, memoryChars: chars(judged.memory) };
}

export async function contextPreview(request: ContextPreviewRequest, deps: ContextPreviewDeps): Promise<ContextPreviewReply> {
  const appId = request.agentId;
  const bot = (await loadBots()).bots.find(entry => entry.appId === appId);
  if (!bot) throw new RpcError('invalid_request', '没有这个 Bot');
  const files = botPaths(appId);
  const projects = await listProjectsIn(deps.projectsFile ?? files.projectsFile);
  const group = request.place.kind === 'group' ? request.place.groupId : undefined;
  const row = group ? projects.find(project => project.chatId === group) : undefined;
  if (group && !row) throw new RpcError('invalid_request', '没有这个群');
  const src = await loadContextSources({
    appId, botName: deps.botName, place: row ? { kind: 'group', chatId: row.chatId, chatName: row.name } : { kind: 'comment' },
    ...(row ? { row } : {}), chatNames: async () => new Map(projects.map(project => [project.chatId, project.name] as const)),
    ...(deps.library ? { library: deps.library } : {}), ...(deps.botDirectory ? { botDirectory: deps.botDirectory } : {}),
  });
  const a = assemble(src, row ? 'work' : 'comment');
  const record = group && deps.running ? pickSession(await listSessionsIn(deps.sessionsFile ?? files.sessionsFile), group, request.threadId) : undefined;
  const project = a.cur.project;
  return {
    kind: 'preview', running: deps.running,
    next: {
      sections: nextSections(src, a),
      items: { bot: a.cur.bot?.items.length ?? 0, trusted: project?.items.filter(item => item.trust === 'trusted').length ?? 0, untrusted: project?.items.filter(item => item.trust === 'untrusted').length ?? 0 },
      // Only Claude has the memory tools; every other backend leaves hidden blocks instead.
      tools: row && groupBackendId(row) !== 'claude-agent' ? [] : [...VONVON_TOOL_NAMES],
    },
    ...(record ? { session: sessionOf(record, src, a) } : {}),
    judge: judgeOf(src, row),
  };
}
