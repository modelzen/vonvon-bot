import type { MemoryActorRole, MemoryEvent, MemoryEventKind, MemoryReply, MemoryRequest, MemoryScopeRef } from '@vonvon/protocol';
import { paths } from '../../config/paths';
import { inBotSession } from '../../config/session-env';
import { badArgs, CommandError } from '../command-error';
import { localTime, pickBot, print, want, withDaemon, type Call, type Daemon, type Io } from '../daemon-client';

const SCOPE_REQUIRED = '要指定哪份记忆：--project <项目名或 prj_…>，或者 --bot <Bot 名字或 appId>（某个人和这个 Bot 的私聊记忆再加 --dm <openId>），二选一。';
const DM_NEEDS_BOT = '--dm 要和 --bot 一起给：私聊记忆是某个 Bot 和某个人的。';
const OPEN_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** devices 8.3: the daemon is the one writer; with none running only the reads fall back to the files. */
const WRITE_NEEDS_DAEMON = '改记忆要 daemon 在运行，命令行不再直接改记忆文件。';
const CHANGED_MAYBE = '可能已经改了，运行 vonvon memory list --all 查看。';
const PURGE_CONFIRM = '彻底删除后找不回来，记录里的原文也会换成占位。确认后加 --yes 再运行一次。';
/** What only reads the memory; every other request writes it. */
const READS = new Set<MemoryRequest['type']>(['list', 'export', 'events']);

/** A library project: `bots` are the bots bound to its groups (`promote` without `--to`). */
export interface MemoryProject { id: string; name: string; bots: readonly string[] }
/** One command's way to the memory, opened after its options are checked. */
export interface MemoryContext {
  io: Io;
  /** devices 8.3: the daemon answered, or with no daemon running the files did */
  source: 'daemon' | 'files';
  /** the library's projects, to turn a name into an id */
  projects(): Promise<MemoryProject[]>;
  /** the bots, to turn `--bot`'s name into an appId */
  bots(): Promise<{ id: string; name: string }[]>;
  run(request: MemoryRequest): Promise<MemoryReply>;
}
/** `read` may fall back to the files when no daemon runs; `write` never does. */
export type MemoryKind = 'read' | 'write';
export interface MemoryTerminal { open<T>(kind: MemoryKind, fn: (ctx: MemoryContext) => Promise<T>): Promise<T> }
export interface MemoryTerminalDeps {
  env?: NodeJS.ProcessEnv;
  /** whether a daemon runs on this data root: its pid lock */
  running?: () => Promise<boolean>;
  daemon?: Daemon;
  files?: (io: Io) => MemoryContext;
}

async function daemonRunning(): Promise<boolean> {
  const { readRunningPidLock } = await import('../../server/pid-lock');
  // A lock that cannot be read is not "no daemon": the connection says what is wrong.
  return readRunningPidLock(paths.appDir).then(lock => lock !== null, () => true);
}

function daemonContext(io: Io, call: Call): MemoryContext {
  return {
    io, source: 'daemon',
    projects: async () => want('读取项目', await call('读取项目', c => c.library({ type: 'list' })), 'list').projects
      .map(project => ({ id: project.id, name: project.name, bots: [...new Set(project.bindings.map(binding => binding.agentId))] })),
    bots: async () => (await call('读取快照', c => c.snapshot())).agents.map(agent => ({ id: agent.id, name: agent.name })),
    run: request => call('读写记忆', c => c.memory(request), READS.has(request.type) ? {} : { unknown: CHANGED_MAYBE }),
  };
}

/** No daemon, not a Bot session, a read: the files, as the owner's own terminal. Projects carry no bindings here (no write comes this way). */
function filesContext(io: Io): MemoryContext {
  return {
    io, source: 'files',
    projects: async () => (await (await import('../../project/library')).readLibrary()).projects.map(project => ({ id: project.id, name: project.name, bots: [] })),
    bots: async () => (await (await import('../../config/bots')).loadBots()).bots.map(bot => ({ id: bot.appId, name: bot.botName || bot.name })),
    run: async request => (await import('../../admin/memory')).memoryAction(request, { origin: 'cli' }),
  };
}

/**
 * devices 8.3 and 5.3: through the daemon, the web page's lock and records, `via: 'cli'`. In a Bot's session the
 * connection carries the session's token and `--scope`, and the daemon judges as it does the memory tools (D4a, D4b);
 * the files are never read there, which would go round what the daemon lets the session see.
 */
export function terminalMemoryContext(io: Io, deps: MemoryTerminalDeps = {}): MemoryTerminal {
  const env = deps.env ?? process.env;
  const daemon: Daemon = deps.daemon ?? withDaemon;
  return {
    async open(kind, fn) {
      if (kind === 'read' && !inBotSession(env) && !(await (deps.running ?? daemonRunning)())) return fn((deps.files ?? filesContext)(io));
      let reached = false;
      try {
        return await daemon(async call => { reached = true; return fn(daemonContext(io, call)); });
      } catch (error) {
        if (!reached && kind === 'write' && error instanceof CommandError && error.kind === 'connection') throw new CommandError('connection', `${error.message}\n${WRITE_NEEDS_DAEMON}`, error);
        throw error;
      }
    },
  };
}

export interface MemoryScopeOptions { project?: string; bot?: string; dm?: string }
/** --all: the human list also shows the archived entries, which --json always has (devices 8.1). */
type ListOptions = MemoryScopeOptions & { all?: boolean };
type Revised = MemoryScopeOptions & { revision: string };

/** Before anything connects: exactly one memory, and a private chat's only with its bot. */
function checkScope(options: MemoryScopeOptions): void {
  if (options.dm !== undefined && !options.bot) throw badArgs(DM_NEEDS_BOT);
  if (Boolean(options.project) === Boolean(options.bot)) throw badArgs(SCOPE_REQUIRED);
  if (options.dm !== undefined && !OPEN_ID.test(options.dm)) throw badArgs('--dm 要写对方的 openId（ou_…）。');
}

async function findProject(ctx: MemoryContext, wanted: string): Promise<MemoryProject> {
  const projects = await ctx.projects();
  const found = projects.find(project => project.id === wanted) ?? projects.find(project => project.name === wanted);
  if (!found) throw badArgs('没有这个项目。vonvon project list 列出全部项目。');
  return found;
}

/** The memory the options mean; `--bot` takes an appId or a name (devices 8.1). */
async function scopeOf(options: MemoryScopeOptions, ctx: MemoryContext): Promise<MemoryScopeRef> {
  if (options.bot) {
    const bot = pickBot(await ctx.bots(), options.bot);
    return options.dm === undefined ? { kind: 'bot', botId: bot.id } : { kind: 'dm', botId: bot.id, openId: options.dm };
  }
  return { kind: 'project', projectId: (await findProject(ctx, options.project!)).id };
}

function revisionOf(text: string): number {
  const revision = Number(text);
  if (!Number.isInteger(revision) || revision < 1) throw badArgs('--revision 要是条目的版本号（vonvon memory list 里的 r 数字）。');
  return revision;
}

const EVENT: Record<MemoryEventKind, string> = {
  add: '新增', edit: '修改', archive: '归档', restore: '恢复', promote: '移到 Bot 记忆', move: '移回项目', confirm: '点成可信', purge: '彻底删除',
  branch_rename: '分支改名', branch_merge: '分支合并', branch_unmerge: '撤销合并',
};
const ACTOR: Record<MemoryActorRole, string> = { owner: '主人', admin: '管理员', member: '成员', bot: 'Bot', desktop: '网页', cli: '命令行', import: '导入' };
/** One line an event: when, what, by whom, and the id `memory undo` takes. */
const eventLine = (event: MemoryEvent): string =>
  `${localTime(event.at)}  ${EVENT[event.kind]}${event.reason === 'undo' ? '（撤销）' : ''}  ${ACTOR[event.actor.role]}  ${event.eventId}`;

function show(ctx: MemoryContext, reply: MemoryReply, all = false): void {
  switch (reply.kind) {
    case 'item': print(ctx.io, [`${reply.item.id}  [${reply.branchApplied ?? reply.item.branch}${reply.newBranch ? '，新开' : ''}]  ${reply.item.state === 'archived' ? '已归档  ' : ''}${reply.item.text}`], reply); return;
    case 'conflict': throw new CommandError('conflict', `没改：${reply.message}`, { reason: 'conflict', ...(reply.current ? { current: reply.current } : {}) });
    // the file-level refusals (memory-full, duplicate, not-found…) are the memory's answer, not a permission
    case 'refused': throw new CommandError(reply.reason === 'bad-args' ? 'bad-args' : 'refused', `没做：${reply.message}`, { reason: reply.reason });
    case 'branches': print(ctx.io, [`分支：${reply.branches.map(branch => branch.name).join('、')}${reply.moved ? `（挪了 ${reply.moved} 条）` : ''}`], reply); return;
    case 'sealed': print(ctx.io, ['已确认，可信条目恢复注入'], reply); return;
    case 'purged': print(ctx.io, ['已彻底删除'], reply); return;
    case 'list': {
      const human = [`${reply.used} / ${reply.limit}${reply.verified ? '' : '  （memory.json 不是 daemon 上次写的，可信条目这一轮不注入）'}`];
      for (const branch of reply.branches) {
        const items = reply.items.filter(item => item.branch === branch.name && (all || item.state === 'active'));
        human.push(`${branch.name}（${items.filter(item => item.state === 'active').length}）`, ...items.map(item => `  ${item.id}  r${item.revision}${item.state === 'archived' ? '  已归档' : ''}${item.trust === 'untrusted' ? '  待确认' : ''}  ${item.text}`));
      }
      // an archived entry whose branch is gone is listed under its own name, as the web page's 已归档 has it
      const gone = all ? reply.items.filter(item => !reply.branches.some(branch => branch.name === item.branch)) : [];
      if (gone.length) human.push('已归档（分支已不在）', ...gone.map(item => `  ${item.id}  r${item.revision}  [${item.branch}]  ${item.text}`));
      print(ctx.io, human, { source: ctx.source, ...reply });
      return;
    }
    case 'exported': print(ctx.io, reply.files.flatMap(file => [file.markdown]), { source: ctx.source, ...reply }); return;
    case 'events': print(ctx.io, reply.events.length ? reply.events.map(eventLine) : ['没有修改记录。'], { source: ctx.source, ...reply }); return;
  }
}

export async function runMemoryList(options: ListOptions, terminal: MemoryTerminal): Promise<void> {
  checkScope(options);
  await terminal.open('read', async ctx => show(ctx, await ctx.run({ type: 'list', scope: await scopeOf(options, ctx) }), Boolean(options.all)));
}
export async function runMemoryExport(options: MemoryScopeOptions, terminal: MemoryTerminal): Promise<void> {
  checkScope(options);
  await terminal.open('read', async ctx => show(ctx, await ctx.run({ type: 'export', scope: await scopeOf(options, ctx) })));
}
/** The entry's history, oldest first: what `memory undo` takes is each line's last word. */
export async function runMemoryEvents(itemId: string, options: MemoryScopeOptions, terminal: MemoryTerminal): Promise<void> {
  checkScope(options);
  await terminal.open('read', async ctx => show(ctx, await ctx.run({ type: 'events', scope: await scopeOf(options, ctx), itemId })));
}
export async function runMemoryAdd(text: string, options: MemoryScopeOptions & { branch?: string }, terminal: MemoryTerminal): Promise<void> {
  checkScope(options);
  await terminal.open('write', async ctx => show(ctx, await ctx.run({ type: 'add', scope: await scopeOf(options, ctx), text, ...(options.branch ? { branch: options.branch } : {}) })));
}
export async function runMemoryEdit(itemId: string, options: Revised & { text?: string; branch?: string }, terminal: MemoryTerminal): Promise<void> {
  checkScope(options);
  const revision = revisionOf(options.revision);
  await terminal.open('write', async ctx => show(ctx, await ctx.run({
    type: 'edit', scope: await scopeOf(options, ctx), itemId, revision, ...(options.text ? { text: options.text } : {}), ...(options.branch ? { branch: options.branch } : {}),
  })));
}
/**
 * The web page's buttons on one entry, by the revision `memory list` shows: archive (its 删除, `forget` before C5),
 * restore an archived one, confirm an untrusted one (点成可信).
 */
export async function runMemoryItem(type: 'archive' | 'restore' | 'confirm', itemId: string, options: Revised, terminal: MemoryTerminal): Promise<void> {
  checkScope(options);
  const revision = revisionOf(options.revision);
  await terminal.open('write', async ctx => show(ctx, await ctx.run({ type, scope: await scopeOf(options, ctx), itemId, revision })));
}
/** 移到 Bot 记忆: a project's entry into a bot's memory, by default the one bot its groups are bound to. */
export async function runMemoryPromote(itemId: string, options: Revised & { to?: string; branch?: string }, terminal: MemoryTerminal): Promise<void> {
  checkScope(options);
  if (!options.project) throw badArgs('promote 只移项目记忆里的条目：用 --project 指定它在哪个项目。');
  const revision = revisionOf(options.revision);
  await terminal.open('write', async ctx => {
    const project = await findProject(ctx, options.project!);
    let botId: string;
    if (options.to !== undefined) botId = pickBot(await ctx.bots(), options.to).id;
    else if (project.bots.length === 1) botId = project.bots[0]!;
    else if (!project.bots.length) throw badArgs(`项目「${project.name}」没有绑定 Bot，用 --to 指定移到哪个 Bot 的记忆。`);
    else {
      const names = new Map((await ctx.bots()).map(bot => [bot.id, bot.name]));
      throw badArgs(`项目「${project.name}」绑了 ${project.bots.length} 个 Bot，用 --to 指定移到哪个：${project.bots.map(id => `${names.get(id) ?? id}（${id}）`).join('、')}`);
    }
    show(ctx, await ctx.run({ type: 'promote', scope: { kind: 'project', projectId: project.id }, itemId, revision, botId, ...(options.branch ? { branch: options.branch } : {}) }));
  });
}
/** 移回项目: a bot's entry back into a project's memory. */
export async function runMemoryMove(itemId: string, options: Revised & { to: string; branch?: string }, terminal: MemoryTerminal): Promise<void> {
  checkScope(options);
  if (!options.bot || options.dm !== undefined) throw badArgs('move 只移 Bot 记忆里的条目（网页上的"移回项目"）：用 --bot 指定它在哪个 Bot 的记忆里。');
  const revision = revisionOf(options.revision);
  await terminal.open('write', async ctx => {
    const scope = await scopeOf(options, ctx);
    const project = await findProject(ctx, options.to);
    show(ctx, await ctx.run({ type: 'move', scope, itemId, revision, to: { projectId: project.id }, ...(options.branch ? { branch: options.branch } : {}) }));
  });
}
/** For good: the entry goes and its text in the records becomes a placeholder. Asks for --yes; no revision, as on the web page. */
export async function runMemoryPurge(itemId: string, options: MemoryScopeOptions & { yes?: boolean }, terminal: MemoryTerminal): Promise<void> {
  checkScope(options);
  await terminal.open('write', async ctx => {
    const scope = await scopeOf(options, ctx);
    const listed = await ctx.run({ type: 'list', scope });
    if (listed.kind !== 'list') return show(ctx, listed);
    const item = listed.items.find(candidate => candidate.id === itemId);
    if (!item) throw badArgs('没有这条记忆。vonvon memory list --all 列出全部条目，已归档的也在。');
    if (!options.yes) {
      throw new CommandError('bad-args', `${PURGE_CONFIRM}\n要删的是：${item.id}  [${item.branch}]${item.state === 'archived' ? '  已归档' : ''}  ${item.text}`, {
        reason: 'confirm_required', partial: { item: { id: item.id, text: item.text, branch: item.branch, state: item.state } },
      });
    }
    const reply = await ctx.run({ type: 'purge', scope, itemId });
    if (reply.kind !== 'purged') return show(ctx, reply);
    print(ctx.io, [`已彻底删除 ${itemId}。`], { ...reply, itemId });
  });
}
/** Undoes one event of `memory events`: its last word. */
export async function runMemoryUndo(eventId: string, options: MemoryScopeOptions, terminal: MemoryTerminal): Promise<void> {
  checkScope(options);
  await terminal.open('write', async ctx => show(ctx, await ctx.run({ type: 'undo', scope: await scopeOf(options, ctx), eventId })));
}
/** The owner has looked at what changed outside the daemon and accepts it: trusted entries are injected again. */
export async function runMemoryReseal(options: MemoryScopeOptions, terminal: MemoryTerminal): Promise<void> {
  checkScope(options);
  await terminal.open('write', async ctx => show(ctx, await ctx.run({ type: 'reseal', scope: await scopeOf(options, ctx) })));
}
export async function runMemoryBranch(kind: 'rename' | 'merge', from: string, to: string, options: MemoryScopeOptions, terminal: MemoryTerminal): Promise<void> {
  checkScope(options);
  await terminal.open('write', async ctx => {
    const scope = await scopeOf(options, ctx);
    show(ctx, await ctx.run(kind === 'rename' ? { type: 'branchRename', scope, from, to } : { type: 'branchMerge', scope, from, into: to }));
  });
}
/**
 * 删除分支: every active entry of the branch archived in one go (the daemon's branchDelete), each undone on its own.
 * `--expected`: the count the caller saw; a branch that changed since is left as it is (exit 5).
 */
export async function runMemoryBranchDelete(name: string, options: MemoryScopeOptions & { expected?: string }, terminal: MemoryTerminal): Promise<void> {
  checkScope(options);
  const expected = options.expected === undefined ? undefined : Number(options.expected);
  if (expected !== undefined && (!Number.isInteger(expected) || expected < 0)) throw badArgs('--expected 要是分支里的条数（vonvon memory list 里分支名后的数字）。');
  await terminal.open('write', async ctx => {
    const reply = await ctx.run({ type: 'branchDelete', scope: await scopeOf(options, ctx), name, ...(expected === undefined ? {} : { expected }) });
    if (reply.kind !== 'branches') return show(ctx, reply);
    print(ctx.io, [`已归档「${name}」分支的 ${reply.moved} 条；要找回用 vonvon memory list --all 和 vonvon memory restore。`], reply);
  });
}
