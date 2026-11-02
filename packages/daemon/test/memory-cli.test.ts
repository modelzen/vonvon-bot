import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryReply, MemoryRequest } from '@vonvon/protocol';
import {
  runMemoryAdd, runMemoryBranch, runMemoryBranchDelete, runMemoryEdit, runMemoryEvents, runMemoryExport, runMemoryItem, runMemoryList, runMemoryMove,
  runMemoryPromote, runMemoryPurge, runMemoryUndo, terminalMemoryContext, type MemoryContext, type MemoryKind, type MemoryTerminal,
} from '../src/cli/commands/memory';
import { connectLocalDaemon, withDaemon, type Io } from '../src/cli/daemon-client';

const item = { id: 'p_prj_0a1b2c3d:abcdef', scope: { kind: 'project' as const, projectId: 'prj_0a1b2c3d' }, text: '周四发版', branch: '决定', state: 'active' as const, trust: 'trusted' as const,
  source: { via: 'cli' as const, botId: '', actorRole: 'cli' as const }, createdAt: 1, updatedAt: 1, revision: 1 };
const PROJECTS = [{ id: 'prj_0a1b2c3d', name: '支付组', bots: ['cli_a'] }, { id: 'prj_ffffffff', name: '别的', bots: ['cli_a', 'cli_b'] }, { id: 'prj_00000000', name: '空的', bots: [] }];
const BOTS = [{ id: 'cli_a', name: '小研' }, { id: 'cli_b', name: '小测' }];

/** A terminal that reached the daemon (or the files), its requests kept; `kinds` records how each command opened it. */
function terminal(reply: MemoryReply | ((request: MemoryRequest) => MemoryReply) = { kind: 'item', item, branchApplied: '决定' }, json = false, source: 'daemon' | 'files' = 'daemon') {
  const out: string[] = [];
  const kinds: MemoryKind[] = [];
  const run = vi.fn(async (request: MemoryRequest): Promise<MemoryReply> => typeof reply === 'function' ? reply(request) : reply);
  const ctx: MemoryContext = { io: { json, write: text => { out.push(text); } }, source, projects: async () => PROJECTS, bots: async () => BOTS, run };
  const open: MemoryTerminal = { open: async (kind, fn) => { kinds.push(kind); return fn(ctx); } };
  return { open, ctx, out, run, kinds };
}
/** devices 8.1: what the entry point turns into the exit code and the --json failure. */
const failure = (kind: string, message: string, extra: object = {}) => expect.objectContaining({ kind, message: expect.stringContaining(message), ...extra });
const list = (items: object[], branches = [{ name: '决定', fixed: true, createdAt: 0, createdBy: 'system' }]): MemoryReply =>
  ({ kind: 'list', items, branches, limit: 100, used: 1, verified: true, problems: [] }) as MemoryReply;
const P1 = { kind: 'project', projectId: 'prj_0a1b2c3d' } as const;

describe('which memory a command means', () => {
  it('takes a project by name or id, and a bot by appId or name', async () => {
    const t = terminal();
    await runMemoryAdd('周四发版', { project: '支付组', branch: '决定' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'add', scope: P1, text: '周四发版', branch: '决定' });
    await runMemoryAdd('x', { project: 'prj_ffffffff' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: 'project', projectId: 'prj_ffffffff' } }));
    // main 必败: --bot took only an appId, and a name went to the daemon as one
    await runMemoryAdd('先写结论', { bot: '小研' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'add', scope: { kind: 'bot', botId: 'cli_a' }, text: '先写结论' });
    await runMemoryAdd('先写结论', { bot: 'cli_b' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: 'bot', botId: 'cli_b' } }));
  });

  // main 必败: there was no --dm
  it("takes a bot's private chat with --bot and --dm", async () => {
    const t = terminal();
    await runMemoryAdd('喜欢先看结论', { bot: '小研', dm: 'ou_1' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'add', scope: { kind: 'dm', botId: 'cli_a', openId: 'ou_1' }, text: '喜欢先看结论' });
  });

  it('wants exactly one memory, --dm with --bot, a project and a bot that exist, a bot name only one bot has', async () => {
    for (const [options, words] of [[{}, '要指定哪份记忆'], [{ project: '支付组', bot: 'cli_a' }, '要指定哪份记忆'], [{ dm: 'ou_1' }, '--dm 要和 --bot'],
      [{ project: '支付组', dm: 'ou_1' }, '--dm 要和 --bot'], [{ bot: 'cli_a', dm: 'ou 1' }, 'openId']] as const) {
      const t = terminal();
      await expect(runMemoryAdd('x', options, t.open)).rejects.toEqual(failure('bad-args', words));
      // before anything connects
      expect(t.kinds).toEqual([]);
    }
    const missing = terminal();
    await expect(runMemoryAdd('x', { project: '没有的' }, missing.open)).rejects.toEqual(failure('bad-args', '没有这个项目'));
    await expect(runMemoryAdd('x', { bot: '没有的' }, missing.open)).rejects.toEqual(failure('bad-args', '没有找到 Bot'));
    expect(missing.run).not.toHaveBeenCalled();
    const twins = terminal();
    twins.ctx.bots = async () => [{ id: 'cli_a', name: '小研' }, { id: 'cli_c', name: '小研' }];
    await expect(runMemoryAdd('x', { bot: '小研' }, twins.open)).rejects.toEqual(failure('bad-args', '有 2 个 Bot 都叫「小研」'));
    expect(twins.run).not.toHaveBeenCalled();
  });
});

describe('the requests each command sends', () => {
  it('reads with list, export and events, and writes with the rest', async () => {
    const t = terminal(request => request.type === 'list' ? list([item]) : request.type === 'export' ? { kind: 'exported', files: [] } : request.type === 'events' ? { kind: 'events', events: [] } : { kind: 'item', item, branchApplied: '决定' });
    await runMemoryList({ project: '支付组' }, t.open);
    await runMemoryExport({ bot: 'cli_a' }, t.open);
    await runMemoryEvents('i1', { project: '支付组' }, t.open);
    await runMemoryAdd('x', { project: '支付组' }, t.open);
    await runMemoryEdit('i1', { project: '支付组', revision: '1', text: 'y' }, t.open);
    expect(t.kinds).toEqual(['read', 'read', 'read', 'write', 'write']);
  });

  // main 必败: none of these commands existed, and forget was the only name of archive
  it("sends the web page's buttons on one entry with its revision", async () => {
    const t = terminal();
    await runMemoryItem('archive', 'i1', { project: '支付组', revision: '3' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'archive', scope: P1, itemId: 'i1', revision: 3 });
    await runMemoryItem('restore', 'i1', { bot: '小研', revision: '4' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'restore', scope: { kind: 'bot', botId: 'cli_a' }, itemId: 'i1', revision: 4 });
    await runMemoryItem('confirm', 'i1', { project: '支付组', revision: '2' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'confirm', scope: P1, itemId: 'i1', revision: 2 });
    await runMemoryEvents('i1', { project: '支付组' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'events', scope: P1, itemId: 'i1' });
    await runMemoryUndo('p_prj_0a1b2c3d:e_1', { project: '支付组' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'undo', scope: P1, eventId: 'p_prj_0a1b2c3d:e_1' });
    await expect(runMemoryItem('archive', 'i1', { project: '支付组', revision: 'x' }, t.open)).rejects.toEqual(failure('bad-args', '--revision'));
  });

  // main 必败: no promote or move
  it('promotes a project entry to the one bot its project is bound to or the one --to names, and moves a bot entry back', async () => {
    const t = terminal();
    await runMemoryPromote('i1', { project: '支付组', revision: '1' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'promote', scope: P1, itemId: 'i1', revision: 1, botId: 'cli_a' });
    await runMemoryPromote('i1', { project: '别的', revision: '1', to: '小测', branch: '合作方式' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'promote', scope: { kind: 'project', projectId: 'prj_ffffffff' }, itemId: 'i1', revision: 1, botId: 'cli_b', branch: '合作方式' });
    await expect(runMemoryPromote('i1', { project: '别的', revision: '1' }, t.open)).rejects.toEqual(failure('bad-args', '小研（cli_a）、小测（cli_b）'));
    await expect(runMemoryPromote('i1', { project: '空的', revision: '1' }, t.open)).rejects.toEqual(failure('bad-args', '没有绑定 Bot'));
    await expect(runMemoryPromote('i1', { bot: 'cli_a', revision: '1' }, t.open)).rejects.toEqual(failure('bad-args', '只移项目记忆'));
    await runMemoryMove('i1', { bot: '小研', revision: '2', to: '别的' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'move', scope: { kind: 'bot', botId: 'cli_a' }, itemId: 'i1', revision: 2, to: { projectId: 'prj_ffffffff' } });
    await expect(runMemoryMove('i1', { project: '支付组', revision: '2', to: '别的' }, t.open)).rejects.toEqual(failure('bad-args', '只移 Bot 记忆'));
    await expect(runMemoryMove('i1', { bot: 'cli_a', revision: '2', to: '没有的' }, t.open)).rejects.toEqual(failure('bad-args', '没有这个项目'));
    expect(t.run).toHaveBeenCalledTimes(3);
  });

  // main 必败: no purge
  it('purges only with --yes, and says what it would delete without it', async () => {
    const archived = { ...item, id: 'i1', text: '旧的决定', state: 'archived' as const };
    const t = terminal(request => request.type === 'list' ? list([item, archived]) : { kind: 'purged' }, true);
    await expect(runMemoryPurge('i1', { project: '支付组' }, t.open)).rejects.toEqual(failure('bad-args', '确认后加 --yes', {
      reason: 'confirm_required', partial: { item: { id: 'i1', text: '旧的决定', branch: '决定', state: 'archived' } },
    }));
    expect(t.run.mock.calls.map(([request]) => request.type)).toEqual(['list']);
    await expect(runMemoryPurge('i9', { project: '支付组', yes: true }, t.open)).rejects.toEqual(failure('bad-args', '没有这条记忆'));
    expect(t.run.mock.calls.map(([request]) => request.type)).toEqual(['list', 'list']);
    await runMemoryPurge('i1', { project: '支付组', yes: true }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'purge', scope: P1, itemId: 'i1' });
    expect(t.kinds).toEqual(['write', 'write', 'write']);
    expect(JSON.parse(t.out.join(''))).toEqual({ ok: true, kind: 'purged', itemId: 'i1' });
  });

  // main 必败: no branch-delete
  it('deletes a branch in one request, with the count the caller saw', async () => {
    const t = terminal({ kind: 'branches', branches: [], moved: 2 });
    await runMemoryBranchDelete('发版', { project: '支付组', expected: '2' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'branchDelete', scope: P1, name: '发版', expected: 2 });
    expect(t.out.join('')).toContain('已归档「发版」分支的 2 条；要找回用 vonvon memory list --all 和 vonvon memory restore。');
    await runMemoryBranchDelete('发版', { project: '支付组' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'branchDelete', scope: P1, name: '发版' });
    await expect(runMemoryBranchDelete('发版', { project: '支付组', expected: '-1' }, t.open)).rejects.toEqual(failure('bad-args', '--expected'));
    const changed = terminal({ kind: 'conflict', message: '分支里的条目刚变过，重新看一次再删' });
    await expect(runMemoryBranchDelete('发版', { project: '支付组', expected: '3' }, changed.open)).rejects.toEqual(failure('conflict', '分支里的条目刚变过', { reason: 'conflict' }));
    const fixed = terminal({ kind: 'refused', reason: 'fixed-branch', message: '固定分支不能删' });
    await expect(runMemoryBranchDelete('决定', { project: '支付组' }, fixed.open)).rejects.toEqual(failure('refused', '固定分支不能删', { reason: 'fixed-branch' }));
  });

  it('sends edit and branch requests; a conflict exits 5 with the current entry, a refusal 4, its bad-args 2', async () => {
    const t = terminal({ kind: 'conflict', current: item, message: '这条记忆已经被别处改过了' });
    await expect(runMemoryEdit('b:abc', { bot: 'cli_a', revision: '3', text: '新', branch: '发版' }, t.open)).rejects.toEqual(failure('conflict', '没改：这条记忆已经被别处改过了', { current: item }));
    expect(t.run).toHaveBeenLastCalledWith({ type: 'edit', scope: { kind: 'bot', botId: 'cli_a' }, itemId: 'b:abc', revision: 3, text: '新', branch: '发版' });
    t.run.mockResolvedValue({ kind: 'branches', branches: [], moved: 0 });
    await runMemoryBranch('rename', '甲', '乙', { bot: 'cli_a' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'branchRename', scope: { kind: 'bot', botId: 'cli_a' }, from: '甲', to: '乙' });
    await runMemoryBranch('merge', '甲', '乙', { bot: 'cli_a' }, t.open);
    expect(t.run).toHaveBeenLastCalledWith({ type: 'branchMerge', scope: { kind: 'bot', botId: 'cli_a' }, from: '甲', into: '乙' });
    const full = terminal({ kind: 'refused', reason: 'memory-full', message: '记忆满了' });
    await expect(runMemoryAdd('x', { bot: 'cli_a' }, full.open)).rejects.toEqual(failure('refused', '没做：记忆满了', { reason: 'memory-full' }));
    const shape = terminal({ kind: 'refused', reason: 'bad-args', message: '太长了' });
    await expect(runMemoryAdd('x', { bot: 'cli_a' }, shape.open)).rejects.toEqual(failure('bad-args', '没做：太长了', { reason: 'bad-args' }));
    const undo = terminal({ kind: 'refused', reason: 'not-undoable', message: '彻底删除不能撤销' });
    await expect(runMemoryUndo('e', { bot: 'cli_a' }, undo.open)).rejects.toEqual(failure('refused', '彻底删除不能撤销', { reason: 'not-undoable' }));
  });
});

describe('what a command prints', () => {
  // main 必败: list said source files whatever answered
  it('says which answered: the daemon or the files', async () => {
    for (const source of ['daemon', 'files'] as const) {
      const t = terminal(list([item]), true, source);
      await runMemoryList({ project: '支付组' }, t.open);
      expect(JSON.parse(t.out.join(''))).toMatchObject({ ok: true, source, kind: 'list', items: [{ text: '周四发版' }] });
    }
  });

  it('lists only active entries unless --all, and with --all the archived ones whose branch is gone too', async () => {
    const archived = { ...item, id: 'p_prj_0a1b2c3d:000001', text: '旧的决定', state: 'archived' as const };
    const orphan = { ...item, id: 'p_prj_0a1b2c3d:000002', text: '删掉的分支里的', branch: '发版', state: 'archived' as const };
    const plain = terminal(list([item, archived, orphan]));
    await runMemoryList({ project: '支付组' }, plain.open);
    expect(plain.out.join('')).not.toContain('旧的决定');
    expect(plain.out.join('')).not.toContain('删掉的分支里的');
    const all = terminal(list([item, archived, orphan]));
    await runMemoryList({ project: '支付组', all: true }, all.open);
    expect(all.out.join('')).toContain('决定（1）\n  p_prj_0a1b2c3d:abcdef  r1  周四发版\n  p_prj_0a1b2c3d:000001  r1  已归档  旧的决定\n');
    expect(all.out.join('')).toContain('已归档（分支已不在）\n  p_prj_0a1b2c3d:000002  r1  [发版]  删掉的分支里的\n');
  });

  it("prints an entry's history with who did it and the id undo takes", async () => {
    const event = { eventId: 'p_prj_0a1b2c3d:e_1', at: Date.UTC(2026, 10, 2, 1, 0), kind: 'archive' as const, itemId: 'i1', actor: { role: 'cli' as const } };
    const t = terminal({ kind: 'events', events: [event, { ...event, eventId: 'p_prj_0a1b2c3d:e_2', kind: 'restore', actor: { role: 'desktop' }, reason: 'undo' }] });
    await runMemoryEvents('i1', { project: '支付组' }, t.open);
    const lines = t.out.join('').trim().split('\n');
    expect(lines[0]).toMatch(/ {2}归档 {2}命令行 {2}p_prj_0a1b2c3d:e_1$/);
    expect(lines[1]).toMatch(/ {2}恢复（撤销） {2}网页 {2}p_prj_0a1b2c3d:e_2$/);
    const json = terminal({ kind: 'events', events: [event] }, true);
    await runMemoryEvents('i1', { project: '支付组' }, json.open);
    expect(JSON.parse(json.out.join(''))).toEqual({ ok: true, source: 'daemon', kind: 'events', events: [event] });
  });
});

describe('the terminal: the daemon, or the files for a read when none runs', () => {
  const homes: string[] = [];
  afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
  const io = (): Io & { out: string[] } => { const out: string[] = []; return { json: true, write: text => { out.push(text); }, out }; };
  const filesCtx = (run = vi.fn(async (): Promise<MemoryReply> => list([item]))) => ({ run, files: (at: Io): MemoryContext => ({ io: at, source: 'files', projects: async () => PROJECTS, bots: async () => BOTS, run }) });
  /** The real connection to a data root with no daemon in it, the environment given (not this process's). */
  const noDaemon = async (env: NodeJS.ProcessEnv) => {
    const home = await mkdtemp(join(tmpdir(), 'vonvon-memory-cli-'));
    homes.push(home);
    return { daemon: <T>(fn: Parameters<typeof withDaemon<T>>[0]) => withDaemon(fn, () => connectLocalDaemon(home, '/cli.mjs', env)) };
  };

  it('asks the daemon when one runs, a read too', async () => {
    const { run, files } = filesCtx();
    const memory = vi.fn(async (): Promise<MemoryReply> => list([item]));
    const library = vi.fn(async () => ({ kind: 'list' as const, projects: [{ id: 'prj_0a1b2c3d', name: '支付组', revision: 1, workspace: { primary: '/w', additional: [] }, bindings: [] }], unlinked: 0 }));
    const daemon = <T>(fn: Parameters<typeof withDaemon<T>>[0]) => withDaemon(fn, async () => ({ memory, library, close: async () => {} }) as never);
    const out = io();
    // main 必败: memory read and wrote the files itself, daemon or not
    await runMemoryList({ project: '支付组' }, terminalMemoryContext(out, { env: {}, running: async () => true, daemon, files }));
    expect(memory).toHaveBeenCalledWith({ type: 'list', scope: P1 });
    expect(run).not.toHaveBeenCalled();
    expect(JSON.parse(out.out.join(''))).toMatchObject({ ok: true, source: 'daemon' });
    await runMemoryAdd('记一下', { project: '支付组' }, terminalMemoryContext(out, { env: {}, running: async () => false, daemon, files }));
    expect(memory).toHaveBeenLastCalledWith({ type: 'add', scope: P1, text: '记一下' });
    expect(run).not.toHaveBeenCalled();
  });

  it('reads the files when no daemon runs, and says so', async () => {
    const { run, files } = filesCtx();
    const out = io();
    const daemon = vi.fn();
    await runMemoryList({ project: '支付组' }, terminalMemoryContext(out, { env: {}, running: async () => false, daemon, files }));
    expect(run).toHaveBeenCalledWith({ type: 'list', scope: P1 });
    expect(daemon).not.toHaveBeenCalled();
    expect(JSON.parse(out.out.join(''))).toMatchObject({ ok: true, source: 'files' });
  });

  // main 必败: a write went to the files, daemon or not
  it('never writes the files: with no daemon a write exits 3 and says to start it', async () => {
    const { run, files } = filesCtx();
    const { daemon } = await noDaemon({});
    await expect(runMemoryAdd('记一下', { project: '支付组' }, terminalMemoryContext(io(), { env: {}, running: async () => false, daemon, files })))
      .rejects.toEqual(failure('connection', 'vonvon daemon start'));
    await expect(runMemoryItem('archive', 'i1', { project: '支付组', revision: '1' }, terminalMemoryContext(io(), { env: {}, running: async () => false, daemon, files })))
      .rejects.toEqual(failure('connection', '改记忆要 daemon 在运行'));
    expect(run).not.toHaveBeenCalled();
  });

  // main 必败: a session's list read the files
  it('in a Bot session reads through the daemon only: no token is refused, no daemon is not the files', async () => {
    const { run, files } = filesCtx();
    const session = { VONVON_SESSION: '1' };
    const { daemon } = await noDaemon(session);
    await expect(runMemoryList({ project: '支付组' }, terminalMemoryContext(io(), { env: session, running: async () => false, daemon, files })))
      .rejects.toEqual(failure('refused', '没有有效的会话令牌', { reason: 'session_token_missing' }));
    const token = { VONVON_SESSION: `vs1.ses_0123456789abcdef.${'a'.repeat(43)}` };
    const withToken = await noDaemon(token);
    await expect(runMemoryList({ project: '支付组' }, terminalMemoryContext(io(), { env: token, running: async () => false, daemon: withToken.daemon, files })))
      .rejects.toEqual(failure('connection', 'daemon 没有运行'));
    expect(run).not.toHaveBeenCalled();
  });
});
