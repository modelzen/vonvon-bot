import { describe, expect, it, vi } from 'vitest';
import type { MemoryReply, MemoryRequest } from '@vonvon/protocol';
import {
  runMemoryAdd, runMemoryBranch, runMemoryEdit, runMemoryExport, runMemoryForget, runMemoryList, type MemoryContext,
} from '../src/cli/commands/memory';

const item = { id: 'p_prj_0a1b2c3d:abcdef', scope: { kind: 'project' as const, projectId: 'prj_0a1b2c3d' }, text: '周四发版', branch: '决定', state: 'active' as const, trust: 'trusted' as const,
  source: { via: 'cli' as const, botId: '', actorRole: 'cli' as const }, createdAt: 1, updatedAt: 1, revision: 1 };

function context(env: NodeJS.ProcessEnv = {}, reply: MemoryReply = { kind: 'item', item, branchApplied: '决定' }) {
  const out: string[] = [];
  const warned: string[] = [];
  const exit = vi.fn();
  const run = vi.fn(async (_request: MemoryRequest): Promise<MemoryReply> => reply);
  const ctx: MemoryContext = {
    io: { json: false, write: text => { out.push(text); } }, warn: text => { warned.push(text); }, exit, env,
    projects: async () => [{ id: 'prj_0a1b2c3d', name: '支付组' }, { id: 'prj_ffffffff', name: '别的' }], run,
  };
  return { ctx, out, warned, exit, run };
}

describe('vonvon memory in a Bot session', () => {
  for (const env of [{ VONVON_SESSION: 'abc' }, { FEISHU_CODEX_BRIDGE: '1' }]) {
    it(`refuses every write (${Object.keys(env)[0]}) before it reads or writes a file`, async () => {
      const calls = [
        (c: MemoryContext) => runMemoryAdd('周四发版', { project: '支付组' }, c),
        (c: MemoryContext) => runMemoryEdit('b:abc', { project: '支付组', revision: '1', text: 'x' }, c),
        (c: MemoryContext) => runMemoryForget('b:abc', { bot: 'cli_a', revision: '1' }, c),
        (c: MemoryContext) => runMemoryBranch('rename', '甲', '乙', { bot: 'cli_a' }, c),
        (c: MemoryContext) => runMemoryBranch('merge', '甲', '乙', { bot: 'cli_a' }, c),
      ];
      for (const call of calls) {
        const { ctx, warned, exit, run } = context(env);
        const projects = vi.spyOn(ctx, 'projects');
        await call(ctx);
        expect(run).not.toHaveBeenCalled();
        expect(projects).not.toHaveBeenCalled();
        expect(exit).toHaveBeenCalledWith(2);
        expect(warned.join()).toContain('不能在 Bot 的会话里用');
      }
    });
  }

  it('still lists and exports', async () => {
    const { ctx, run, exit } = context({ VONVON_SESSION: 'abc' }, { kind: 'list', items: [item], branches: [{ name: '决定', fixed: true, createdAt: 0, createdBy: 'system' }], limit: 100, used: 1, verified: true, problems: [] });
    await runMemoryList({ project: '支付组' }, ctx);
    expect(run).toHaveBeenCalledWith({ type: 'list', scope: { kind: 'project', projectId: 'prj_0a1b2c3d' } });
    expect(exit).not.toHaveBeenCalled();
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
      const { ctx, run, exit } = context();
      await runMemoryAdd('x', options, ctx);
      expect(run).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(2);
    }
    const missing = context();
    await runMemoryAdd('x', { project: '没有的' }, missing.ctx);
    expect(missing.run).not.toHaveBeenCalled();
    expect(missing.warned.join()).toContain('没有这个项目');
  });

  it('sends edit, forget and branch requests with the revision, and exits 1 on a conflict or refusal', async () => {
    const { ctx, run, exit } = context({}, { kind: 'conflict', message: '这条记忆已经被别处改过了' });
    await runMemoryEdit('b:abc', { bot: 'cli_a', revision: '3', text: '新', branch: '发版' }, ctx);
    expect(run).toHaveBeenLastCalledWith({ type: 'edit', scope: { kind: 'bot', botId: 'cli_a' }, itemId: 'b:abc', revision: 3, text: '新', branch: '发版' });
    expect(exit).toHaveBeenCalledWith(1);
    await runMemoryForget('b:abc', { bot: 'cli_a', revision: '3' }, ctx);
    expect(run).toHaveBeenLastCalledWith({ type: 'archive', scope: { kind: 'bot', botId: 'cli_a' }, itemId: 'b:abc', revision: 3 });
    await runMemoryBranch('rename', '甲', '乙', { bot: 'cli_a' }, ctx);
    expect(run).toHaveBeenLastCalledWith({ type: 'branchRename', scope: { kind: 'bot', botId: 'cli_a' }, from: '甲', to: '乙' });
    await runMemoryBranch('merge', '甲', '乙', { bot: 'cli_a' }, ctx);
    expect(run).toHaveBeenLastCalledWith({ type: 'branchMerge', scope: { kind: 'bot', botId: 'cli_a' }, from: '甲', into: '乙' });
    await runMemoryExport({ bot: 'cli_a' }, ctx);
    expect(run).toHaveBeenLastCalledWith({ type: 'export', scope: { kind: 'bot', botId: 'cli_a' } });
    const bad = context();
    await runMemoryEdit('b:abc', { bot: 'cli_a', revision: 'x' }, bad.ctx);
    expect(bad.run).not.toHaveBeenCalled();
    expect(bad.exit).toHaveBeenCalledWith(2);
  });
});
