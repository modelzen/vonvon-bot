import type { MemoryReply, MemoryRequest, MemoryScopeRef } from '@vonvon/protocol';
import { inBotSession } from '../../config/session-env';
import { print, type Io } from '../daemon-client';

const SESSION_REFUSED = '记忆的写入命令不能在 Bot 的会话里用：Bot 要记东西，用 memory_add 工具；改和删由主人在网页端做，或者在自己的终端里运行。';
const SCOPE_REQUIRED = '要指定哪份记忆：--project <项目名或 prj_…> 或者 --bot <appId>，二选一。';

export interface MemoryContext {
  io: Io;
  /** stderr: the refusals */
  warn(text: string): void;
  exit(code: number): void;
  env: NodeJS.ProcessEnv;
  /** the library's projects, to turn a name into an id */
  projects(): Promise<{ id: string; name: string }[]>;
  /** the request on the files, as the owner's own terminal (`via: 'cli'`) */
  run(request: MemoryRequest): Promise<MemoryReply>;
}

export function terminalMemoryContext(io: Io): MemoryContext {
  return {
    io, env: process.env,
    warn: text => { process.stderr.write(text); },
    exit: code => { process.exitCode = code; },
    projects: async () => (await import('../../project/library')).readLibrary().then(library => library.projects),
    run: async request => (await import('../../admin/memory')).memoryAction(request, { origin: 'cli' }),
  };
}

export interface MemoryScopeOptions { project?: string; bot?: string }

/** The memory a command means. Refuses (and says why) when it is not exactly one. */
async function scopeOf(options: MemoryScopeOptions, ctx: MemoryContext): Promise<MemoryScopeRef | undefined> {
  if (Boolean(options.project) === Boolean(options.bot)) { ctx.warn(`${SCOPE_REQUIRED}\n`); ctx.exit(2); return undefined; }
  if (options.bot) return { kind: 'bot', botId: options.bot };
  const projects = await ctx.projects();
  const found = projects.find(project => project.id === options.project) ?? projects.find(project => project.name === options.project);
  if (!found) { ctx.warn('没有这个项目。vonvon project list 列出全部项目。\n'); ctx.exit(2); return undefined; }
  return { kind: 'project', projectId: found.id };
}

/** Writes only. Before anything is read or written, and before any lease (cli/index.ts takes none for `memory`). */
function refusedInSession(ctx: MemoryContext): boolean {
  if (!inBotSession(ctx.env)) return false;
  ctx.warn(`${SESSION_REFUSED}\n`);
  ctx.exit(2);
  return true;
}

function show(ctx: MemoryContext, reply: MemoryReply): void {
  switch (reply.kind) {
    case 'item': print(ctx.io, [`${reply.item.id}  [${reply.branchApplied ?? reply.item.branch}${reply.newBranch ? '，新开' : ''}]  ${reply.item.text}`], reply); return;
    case 'conflict': print(ctx.io, [`没改：${reply.message}`], reply); ctx.exit(1); return;
    case 'refused': print(ctx.io, [`没做：${reply.message}`], reply); ctx.exit(1); return;
    case 'branches': print(ctx.io, [`分支：${reply.branches.map(branch => branch.name).join('、')}${reply.moved ? `（挪了 ${reply.moved} 条）` : ''}`], reply); return;
    case 'sealed': print(ctx.io, ['已确认，可信条目恢复注入'], reply); return;
    case 'purged': print(ctx.io, ['已彻底删除'], reply); return;
    case 'list': {
      const human = [`${reply.used} / ${reply.limit}${reply.verified ? '' : '  （memory.json 不是 daemon 上次写的，可信条目这一轮不注入）'}`];
      for (const branch of reply.branches) {
        const items = reply.items.filter(item => item.state === 'active' && item.branch === branch.name);
        human.push(`${branch.name}（${items.length}）`, ...items.map(item => `  ${item.id}  r${item.revision}${item.trust === 'untrusted' ? '  待确认' : ''}  ${item.text}`));
      }
      print(ctx.io, human, reply);
      return;
    }
    case 'exported': print(ctx.io, reply.files.flatMap(file => [file.markdown]), reply); return;
    case 'events': print(ctx.io, reply.events.map(event => `${new Date(event.at).toISOString()}  ${event.kind}  ${event.itemId ?? ''}`), reply); return;
  }
}

export async function runMemoryList(options: MemoryScopeOptions, ctx: MemoryContext): Promise<void> {
  const scope = await scopeOf(options, ctx);
  if (scope) show(ctx, await ctx.run({ type: 'list', scope }));
}
export async function runMemoryExport(options: MemoryScopeOptions, ctx: MemoryContext): Promise<void> {
  const scope = await scopeOf(options, ctx);
  if (scope) show(ctx, await ctx.run({ type: 'export', scope }));
}
export async function runMemoryAdd(text: string, options: MemoryScopeOptions & { branch?: string }, ctx: MemoryContext): Promise<void> {
  if (refusedInSession(ctx)) return;
  const scope = await scopeOf(options, ctx);
  if (scope) show(ctx, await ctx.run({ type: 'add', scope, text, ...(options.branch ? { branch: options.branch } : {}) }));
}
export async function runMemoryEdit(itemId: string, options: MemoryScopeOptions & { revision: string; text?: string; branch?: string }, ctx: MemoryContext): Promise<void> {
  if (refusedInSession(ctx)) return;
  const scope = await scopeOf(options, ctx);
  const revision = Number(options.revision);
  if (!Number.isInteger(revision) || revision < 1) { ctx.warn('--revision 要是条目的版本号（vonvon memory list 里的 r 数字）。\n'); ctx.exit(2); return; }
  if (scope) show(ctx, await ctx.run({ type: 'edit', scope, itemId, revision, ...(options.text ? { text: options.text } : {}), ...(options.branch ? { branch: options.branch } : {}) }));
}
/** "Forget" archives; purging an entry for good is the web page's job. */
export async function runMemoryForget(itemId: string, options: MemoryScopeOptions & { revision: string }, ctx: MemoryContext): Promise<void> {
  if (refusedInSession(ctx)) return;
  const scope = await scopeOf(options, ctx);
  const revision = Number(options.revision);
  if (!Number.isInteger(revision) || revision < 1) { ctx.warn('--revision 要是条目的版本号（vonvon memory list 里的 r 数字）。\n'); ctx.exit(2); return; }
  if (scope) show(ctx, await ctx.run({ type: 'archive', scope, itemId, revision }));
}
/** The owner has looked at what changed outside the daemon and accepts it: trusted entries are injected again. */
export async function runMemoryReseal(options: MemoryScopeOptions, ctx: MemoryContext): Promise<void> {
  if (refusedInSession(ctx)) return;
  const scope = await scopeOf(options, ctx);
  if (scope) show(ctx, await ctx.run({ type: 'reseal', scope }));
}
export async function runMemoryBranch(kind: 'rename' | 'merge', from: string, to: string, options: MemoryScopeOptions, ctx: MemoryContext): Promise<void> {
  if (refusedInSession(ctx)) return;
  const scope = await scopeOf(options, ctx);
  if (!scope) return;
  show(ctx, await ctx.run(kind === 'rename' ? { type: 'branchRename', scope, from, to } : { type: 'branchMerge', scope, from, into: to }));
}
