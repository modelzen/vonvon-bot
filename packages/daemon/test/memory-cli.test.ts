import { describe, expect, it, vi } from 'vitest';
import type { MemoryReply, MemoryRequest } from '@vonvon/protocol';
import {
  runMemoryAdd, runMemoryBranch, runMemoryEdit, runMemoryExport, runMemoryForget, runMemoryList, type MemoryContext,
} from '../src/cli/commands/memory';

const item = { id: 'p_prj_0a1b2c3d:abcdef', scope: { kind: 'project' as const, projectId: 'prj_0a1b2c3d' }, text: '周四发版', branch: '决定', state: 'active' as const, trust: 'trusted' as const,
  source: { via: 'cli' as const, botId: '', actorRole: 'cli' as const }, createdAt: 1, updatedAt: 1, revision: 1 };

function context(env: NodeJS.ProcessEnv = {}, reply: MemoryReply = { kind: 'item', item, branchApplied: '决定' }, json = false) {
  const out: string[] = [];
  const run = vi.fn(async (_request: MemoryRequest): Promise<MemoryReply> => reply);
  const ctx: MemoryContext = {
    io: { json, write: text => { out.push(text); } }, env,
    projects: async () => [{ id: 'prj_0a1b2c3d', name: '支付组' }, { id: 'prj_ffffffff', name: '别的' }], run,
  };
  return { ctx, out, run };
}
/** devices 8.1: what the entry point turns into the exit code and the --json failure. */
const failure = (kind: string, message: string, extra: object = {}) => expect.objectContaining({ kind, message: expect.stringContaining(message), ...extra });
const list = (items: object[]): MemoryReply => ({ kind: 'list', items, branches: [{ name: '决定', fixed: true, createdAt: 0, createdBy: 'system' }], limit: 100, used: 1, verified: true, problems: [] }) as MemoryReply;

describe('vonvon memory in a Bot session', () => {
  for (const env of [{ VONVON_SESSION: 'abc' }, { FEISHU_CODEX_BRIDGE: '1' }]) {
    // main 必败: refused with exit 2 and no reason, through ctx.exit
    it(`refuses every write (${Object.keys(env)[0]}) before it reads or writes a file, exit 4 not_in_session`, async () => {
      const calls = [
        (c: MemoryContext) => runMemoryAdd('周四发版', { project: '支付组' }, c),
        (c: MemoryContext) => runMemoryEdit('b:abc', { project: '支付组', revision: '1', text: 'x' }, c),
        (c: MemoryContext) => runMemoryForget('b:abc', { bot: 'cli_a', revision: '1' }, c),
        (c: MemoryContext) => runMemoryBranch('rename', '甲', '乙', { bot: 'cli_a' }, c),
        (c: MemoryContext) => runMemoryBranch('merge', '甲', '乙', { bot: 'cli_a' }, c),
      ];
      for (const call of calls) {
        const { ctx, run } = context(env);
        const projects = vi.spyOn(ctx, 'projects');
        await expect(call(ctx)).rejects.toEqual(failure('refused', '不能在 Bot 的会话里用', { reason: 'not_in_session' }));
        expect(run).not.toHaveBeenCalled();
        expect(projects).not.toHaveBeenCalled();
      }
    });
  }

  it('still lists and exports', async () => {
    const { ctx, run } = context({ VONVON_SESSION: 'abc' }, list([item]));
    await runMemoryList({ project: '支付组' }, ctx);
    expect(run).toHaveBeenCalledWith({ type: 'list', scope: { kind: 'project', projectId: 'prj_0a1b2c3d' } });
  });
});

describe('vonvon memory outside a session', () => {
  it('adds to the project named on the command line, or to a bot, and prints the entry', async () => {
    const { ctx, run, out } = context();
    await runMemoryAdd('周四发版', { project: '支付组', branch: '决定' }, ctx);
    expect(run).toHaveBeenCalledWith({ type: 'add', scope: { kind: 'project', projectId: 'prj_0a1b2c3d' }, text: '周四发版', branch: '决定' });
    expect(out.join()).toContain('周四发版');
    await runMemoryAdd('先写结论', { bot: 'cli_a' }, ctx);
    expect(run).toHaveBeenLastCalledWith({ type: 'add', scope: { kind: 'bot', botId: 'cli_a' }, text: '先写结论' });
    await runMemoryAdd('x', { project: 'prj_ffffffff' }, ctx);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: 'project', projectId: 'prj_ffffffff' } }));
  });

  it('wants exactly one memory and a project that exists', async () => {
    for (const options of [{}, { project: '支付组', bot: 'cli_a' }]) {
      const { ctx, run } = context();
      await expect(runMemoryAdd('x', options, ctx)).rejects.toEqual(failure('bad-args', '要指定哪份记忆'));
      expect(run).not.toHaveBeenCalled();
    }
    const missing = context();
    await expect(runMemoryAdd('x', { project: '没有的' }, missing.ctx)).rejects.toEqual(failure('bad-args', '没有这个项目'));
    expect(missing.run).not.toHaveBeenCalled();
  });

  // main 必败: a conflict and a refusal both exited 1 after printing, with nothing to tell them apart
  it('sends edit, forget and branch requests with the revision; a conflict exits 5 with the current entry, a refusal 4', async () => {
    const { ctx, run } = context({}, { kind: 'conflict', current: item, message: '这条记忆已经被别处改过了' });
    await expect(runMemoryEdit('b:abc', { bot: 'cli_a', revision: '3', text: '新', branch: '发版' }, ctx)).rejects.toEqual(failure('conflict', '没改：这条记忆已经被别处改过了', { current: item }));
    expect(run).toHaveBeenLastCalledWith({ type: 'edit', scope: { kind: 'bot', botId: 'cli_a' }, itemId: 'b:abc', revision: 3, text: '新', branch: '发版' });
    run.mockResolvedValue({ kind: 'item', item });
    await runMemoryForget('b:abc', { bot: 'cli_a', revision: '3' }, ctx);
    expect(run).toHaveBeenLastCalledWith({ type: 'archive', scope: { kind: 'bot', botId: 'cli_a' }, itemId: 'b:abc', revision: 3 });
    await runMemoryBranch('rename', '甲', '乙', { bot: 'cli_a' }, ctx);
    expect(run).toHaveBeenLastCalledWith({ type: 'branchRename', scope: { kind: 'bot', botId: 'cli_a' }, from: '甲', to: '乙' });
    await runMemoryBranch('merge', '甲', '乙', { bot: 'cli_a' }, ctx);
    expect(run).toHaveBeenLastCalledWith({ type: 'branchMerge', scope: { kind: 'bot', botId: 'cli_a' }, from: '甲', into: '乙' });
    await runMemoryExport({ bot: 'cli_a' }, ctx);
    expect(run).toHaveBeenLastCalledWith({ type: 'export', scope: { kind: 'bot', botId: 'cli_a' } });
    const bad = context();
    await expect(runMemoryEdit('b:abc', { bot: 'cli_a', revision: 'x' }, bad.ctx)).rejects.toEqual(failure('bad-args', '--revision'));
    expect(bad.run).not.toHaveBeenCalled();
    const full = context({}, { kind: 'refused', reason: 'memory-full', message: '记忆满了' });
    await expect(runMemoryAdd('x', { bot: 'cli_a' }, full.ctx)).rejects.toEqual(failure('refused', '没做：记忆满了', { reason: 'memory-full' }));
    const shape = context({}, { kind: 'refused', reason: 'bad-args', message: '太长了' });
    await expect(runMemoryAdd('x', { bot: 'cli_a' }, shape.ctx)).rejects.toEqual(failure('bad-args', '没做：太长了', { reason: 'bad-args' }));
  });

  // main 必败: archived entries were only in --json, and the JSON had no source
  it('list shows only active entries unless --all, and its JSON says it read the files', async () => {
    const archived = { ...item, id: 'p_prj_0a1b2c3d:000001', text: '旧的决定', state: 'archived' as const };
    const plain = context({}, list([item, archived]));
    await runMemoryList({ project: '支付组' }, plain.ctx);
    expect(plain.out.join('')).not.toContain('旧的决定');
    const all = context({}, list([item, archived]));
    await runMemoryList({ project: '支付组', all: true }, all.ctx);
    expect(all.out.join('')).toContain('决定（1）\n  p_prj_0a1b2c3d:abcdef  r1  周四发版\n  p_prj_0a1b2c3d:000001  r1  已归档  旧的决定\n');
    const json = context({}, list([item, archived]), true);
    await runMemoryList({ project: '支付组' }, json.ctx);
    expect(JSON.parse(json.out.join(''))).toMatchObject({ ok: true, source: 'files', kind: 'list', items: [{ text: '周四发版' }, { text: '旧的决定' }] });
  });
});
