import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentThread } from '../src/agent/types';
import { createAgentEntries } from '../src/agent/entry/registry';
import { ToolRefusal, type AgentTool, type ToolContext } from '../src/agent/entry/tools';
import { addProject, listProjectsIn, mutateProject, updateProject } from '../src/project/registry';

const state = vi.hoisted(() => ({ root: '', info: vi.fn(), warn: vi.fn(), fail: vi.fn() }));
vi.mock('../src/core/logger', () => ({ log: state }));
vi.mock('../src/config/paths', async original => ({ ...await original<object>(), paths: {
  get appDir() { return state.root; }, get projectsFile() { return join(state.root, 'projects.json'); },
  get projectsRootDir() { return join(state.root, 'projects'); },
} }));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(run: AgentTool['run']) {
  const flags = { admin: true, enabled: true };
  const thread: AgentThread = { sessionId: 'fixture', isAlive: vi.fn(() => true), close: async () => {},
    runStreamed: () => { throw Error('unused'); }, runGoal: () => { throw Error('unused'); },
    clearGoal: async () => {}, abort: async () => {}, steer: async () => {}, compact: async () => ({ compacted: false, usage: null }) };
  const entries = createAgentEntries({ appId: 'fixture', isAdmin: () => flags.admin,
    chatSettingsOn: () => flags.enabled, tools: [{ name: 't_set', description: 'fixture', class: 'settings', input: z.object({}), run }] });
  const entry = entries.issue({ kind: 'p2p' }); entry.attach(thread);
  const scope = entries.openTurn(thread, { requesterOpenId: 'admin', requesterKind: 'user', triggerMessageId: 'm1', retry: false, wake: false, initiative: false });
  entry.noteToolUse('u1');
  return { flags, entries, entry, scope, thread, call: () => entry.call('t_set', {}, { toolUseId: 'u1' }) };
}
afterEach(async () => { vi.useRealTimers(); vi.clearAllMocks(); if (state.root) { await rm(state.root, { recursive: true, force: true }); state.root = ''; } });

const changes: [string, (f: ReturnType<typeof fixture>) => void, string][] = [
  ['turn close', f => f.scope.close(), 'turn-ended'],
  ['another person steers', f => f.entries.noteSteer(f.thread, { openId: 'other', kind: 'user' }), 'not-human-turn'],
  ['administrator removed', f => { f.flags.admin = false; }, 'not-admin'],
  ['switch off', f => { f.flags.enabled = false; }, 'switch-off'],
  ['grant revoked', f => f.entry.revoke('closed'), 'revoked'],
  ['thread died', f => { vi.mocked(f.thread.isAlive).mockReturnValue(false); }, 'revoked'],
  ['turn replaced', f => { f.entries.openTurn(f.thread, { requesterOpenId: 'admin', requesterKind: 'user', triggerMessageId: 'm2', retry: false, wake: false, initiative: false }); }, 'turn-ended'],
];
describe('settings commit guard at the actual write point', () => {
  it.each(changes)('prevents a write after %s while commit is preparing', async (_label, change, reason) => {
    const entered = deferred(), gate = deferred(); let commits = 0; let signal: AbortSignal | undefined;
    const f = fixture(async (_args, ctx) => { signal = ctx.signal; if (!ctx.commit) throw Error('missing commit');
      return ctx.commit(async guard => { entered.resolve(); await gate.promise; guard(); commits++; }); });
    const pending = f.call(); await entered.promise; change(f); gate.resolve();
    expect(await pending).toMatchObject(reason === 'revoked' ? { code: 'revoked' } : { code: 'refused', reason });
    expect(commits).toBe(0);
    if (['revoked', 'turn-ended', 'not-human-turn'].includes(reason)) expect(signal?.aborted).toBe(true);
  });
  it.each(['turn close', 'administrator removed', 'grant revoked', 'deadline'])('returns success after a guarded write despite %s', async change => {
    vi.useFakeTimers(); const entered = deferred(), gate = deferred(); let commits = 0; let signal: AbortSignal | undefined;
    const f = fixture(async (_args, ctx) => { signal = ctx.signal; if (!ctx.commit) throw Error('missing commit');
      return ctx.commit(async guard => { guard(); commits++; entered.resolve(); await gate.promise; return 'saved'; }); });
    const pending = f.call(); await entered.promise;
    if (change === 'turn close') f.scope.close();
    if (change === 'administrator removed') f.flags.admin = false;
    if (change === 'grant revoked') f.entry.revoke('closed');
    if (change === 'deadline') await vi.advanceTimersByTimeAsync(71_000);
    expect(signal?.aborted).toBe(false); gate.resolve();
    expect(await pending).toEqual({ ok: true, result: 'saved' }); expect(commits).toBe(1);
    if (change === 'deadline') expect(state.info.mock.calls.flat().concat(state.warn.mock.calls.flat())).toContain('late-commit');
  });
  it('keeps the settings queue serialized until a committed write finishes', async () => {
    const entered = deferred(), release = deferred(); const order: string[] = []; let calls = 0;
    const f = fixture(async (_args, ctx) => { if (!ctx.commit) throw Error('missing commit');
      const call = ++calls;
      return ctx.commit(async guard => {
        guard(); order.push(`commit-${call}`);
        if (call === 1) { entered.resolve(); await release.promise; }
        order.push(`finish-${call}`); return 'saved';
      }); });
    const first = f.call(); await entered.promise; const second = f.call();
    expect(order).toEqual(['commit-1']); expect(calls).toBe(1);
    release.resolve(); expect(await first).toMatchObject({ ok: true }); expect(await second).toMatchObject({ ok: true });
    expect(order).toEqual(['commit-1', 'finish-1', 'commit-2', 'finish-2']);
  });
  it.each([[67_500, false], [66_000, true]] satisfies [number, boolean][])('reserves three seconds at guard time %i', async (elapsed, allowed) => {
    vi.useFakeTimers(); const entered = deferred(), gate = deferred(); let commits = 0;
    const f = fixture(async (_args, ctx) => { if (!ctx.commit) throw Error('missing commit');
      return ctx.commit(async guard => { entered.resolve(); await gate.promise; guard(); commits++; return 'saved'; }); });
    const pending = f.call(); await entered.promise; await vi.advanceTimersByTimeAsync(elapsed); gate.resolve();
    expect(await pending).toMatchObject(allowed ? { ok: true } : { code: 'timeout' }); expect(commits).toBe(allowed ? 1 : 0);
  });
  it('reports a callback which completes without calling its guard', async () => {
    const f = fixture(async (_args, ctx) => { if (!ctx.commit) throw Error('missing commit'); return ctx.commit(async () => 'unguarded'); });
    expect(await f.call()).toMatchObject({ code: 'failed' });
    expect(JSON.stringify(state.fail.mock.calls)).toContain('commit-unguarded');
  });
  it('rejects a guard called twice', async () => {
    let commits = 0;
    const f = fixture(async (_args, ctx) => { if (!ctx.commit) throw Error('missing commit'); return ctx.commit(async guard => { guard(); commits++; guard(); commits++; }); });
    expect(await f.call()).toMatchObject({ code: 'failed' }); expect(commits).toBe(1);
  });
  it('warns that settings may have changed when guarded work throws', async () => {
    const f = fixture(async (_args, ctx) => { if (!ctx.commit) throw Error('missing commit'); return ctx.commit(async guard => { guard(); throw Error('fixture failure'); }); });
    expect(await f.call()).toMatchObject({ code: 'failed', message: expect.stringContaining('设置可能已经改了') });
  });
  it('preserves an explicit no-write refusal after guarding', async () => {
    const f = fixture(async (_args, ctx) => { if (!ctx.commit) throw Error('missing commit'); return ctx.commit(async guard => {
      guard(); throw new ToolRefusal({ ok: false, code: 'timeout', message: 'expired before remote write' }); }); });
    expect(await f.call()).toMatchObject({ code: 'timeout' });
  });
});

async function project() {
  state.root = await mkdtemp(join(tmpdir(), 'agent-commit-'));
  await addProject({ name: 'fixture', chatId: 'fixture-chat', cwd: '/fixture', blank: true, createdAt: 1, noMention: false });
  return join(state.root, 'projects.json');
}
describe('real project writer commit points', () => {
  it.each(['update', 'mutate'])('%s leaves bytes unchanged, cleans temporary files and releases its lock when guard rejects', async kind => {
    const file = await project(), before = await readFile(file); let guards = 0;
    const beforeCommit = () => { guards++; throw Error('not permitted'); };
    const write = () => kind === 'update' ? updateProject('fixture', { noMention: true }, { beforeCommit })
      : mutateProject('fixture', row => { row.noMention = true; }, { beforeCommit });
    await expect(write()).rejects.toThrow('not permitted'); expect(guards).toBe(1);
    expect(await readFile(file)).toEqual(before);
    expect((await readdir(state.root)).filter(name => name.startsWith('projects.json.tmp-'))).toEqual([]);
    const guard = vi.fn();
    if (kind === 'update') await updateProject('fixture', { noMention: true }, { beforeCommit: guard });
    else await mutateProject('fixture', row => { row.noMention = true; }, { beforeCommit: guard });
    expect(guard).toHaveBeenCalledTimes(1); expect(await listProjectsIn(file)).toMatchObject([{ noMention: true }]);
  });
  it('checks after waiting for the writer lock and after writing a temporary file', async () => {
    const file = await project(), held = deferred(), release = deferred(); let allowed = true, temporarySeen = false;
    const first = mutateProject('fixture', async row => { held.resolve(); await release.promise; row.network = true; });
    await held.promise;
    // The callback is synchronous; readdirSync observes the real temporary file at the commit point.
    const second = updateProject('fixture', { noMention: true }, { beforeCommit: () => {
      temporarySeen = readdirSync(state.root).some(name => name.startsWith('projects.json.tmp-'));
      if (!allowed) throw Error('permission changed while queued');
    } });
    allowed = false; release.resolve(); await first;
    await expect(second).rejects.toThrow('permission changed while queued'); expect(temporarySeen).toBe(true);
    expect(await listProjectsIn(file)).toMatchObject([{ network: true, noMention: false }]);
  });
  it.each([true, false])('registry guard observes turn closure=%s after waiting for the real writer', async closeTurn => {
    const file = await project(), held = deferred(), release = deferred(), commitEntered = deferred();
    const first = mutateProject('fixture', async row => { held.resolve(); await release.promise; row.network = true; }); await held.promise;
    const f = fixture(async (_args, ctx: ToolContext) => { if (!ctx.commit) throw Error('missing commit');
      await ctx.commit(guard => { commitEntered.resolve(); return updateProject('fixture', { noMention: true }, { beforeCommit: guard }); }); return 'saved'; });
    const pending = f.call(); await commitEntered.promise; if (closeTurn) f.scope.close(); release.resolve(); await first;
    expect(await pending).toMatchObject(closeTurn ? { code: 'refused', reason: 'turn-ended' } : { ok: true });
    // A refused invocation may settle before its pending writer has released its lock.
    await updateProject('fixture', {});
    expect(await listProjectsIn(file)).toMatchObject([{ network: true, noMention: !closeTurn }]);
  });
});
