import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentThread } from '../src/agent/types';
import { createAgentEntries, type AgentPlace, type TurnFacts } from '../src/agent/entry/registry';
import type { AgentTool } from '../src/agent/entry/tools';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), fail: vi.fn() }));
vi.mock('../src/core/logger', () => ({ log: logs }));
function thread(releaseAfterRun?: boolean): AgentThread {
  return {
    sessionId: 'fixture', ...(releaseAfterRun === undefined ? {} : { releaseAfterRun }), isAlive: vi.fn(() => true), close: vi.fn(async () => {}),
    runStreamed: () => { throw Error('unused'); }, runGoal: () => { throw Error('unused'); },
    clearGoal: async () => {}, steer: async () => {}, abort: async () => {},
    compact: async () => ({ compacted: false, usage: null }),
  };
}
const member: TurnFacts = { requesterOpenId: 'ou_m', requesterKind: 'user', triggerMessageId: 'om_1', retry: false, initiative: false, wake: false, typed: true, triggerText: '记住 发版改到周四' };
const read: AgentTool = { name: 't_read', class: 'read', description: 'fixture read', input: z.object({}), run: async () => 'read' };
function memoryTool(run: AgentTool['run'] = async (_args, ctx) => ({ turn: ctx.turn, facts: ctx.memoryTurn?.() })): AgentTool {
  return { name: 't_mem', class: 'memory', description: 'fixture memory', input: z.object({}), run };
}
function setup(options: { place?: AgentPlace; facts?: TurnFacts; run?: AgentTool['run']; codex?: boolean; owner?: string; admin?: string[] } = {}) {
  const entries = createAgentEntries({ appId: 'fixture', isAdmin: id => (options.admin ?? ['ou_o']).includes(id), isOwner: id => id === (options.owner ?? 'ou_o'), tools: [read, memoryTool(options.run)] });
  const entry = entries.issue(options.place ?? { kind: 'group', chatId: 'oc_a' });
  const t = thread(options.codex ? false : undefined);
  entry.attach(t);
  const scope = entries.openTurn(t, options.facts ?? member);
  entry.noteToolUse('u1');
  return { entries, entry, t, scope, call: () => entry.call('t_mem', {}, { toolUseId: 'u1' }) };
}
afterEach(() => { vi.clearAllMocks(); });

describe('memory tools are authorized by class, not by role', () => {
  it('a group member turn may call them; the facts say who, where and what was typed', async () => {
    const f = setup();
    expect(await f.call()).toMatchObject({ ok: true, result: {
      turn: { role: 'member', requesterOpenId: 'ou_m', triggerMessageId: 'om_1' },
      facts: { kind: 'human', steered: false, role: 'member', openId: 'ou_m', place: 'group', chatId: 'oc_a', active: true, typed: true, triggerText: '记住 发版改到周四', botWrites: 0 },
    } });
  });
  it('knows the owner, an admin and a bot-woken turn', async () => {
    expect(await setup({ facts: { ...member, requesterOpenId: 'ou_o' } }).call()).toMatchObject({ result: { facts: { role: 'owner', kind: 'human' }, turn: { role: 'owner' } } });
    expect(await setup({ admin: ['ou_a'], facts: { ...member, requesterOpenId: 'ou_a' } }).call()).toMatchObject({ result: { facts: { role: 'admin' } } });
    expect(await setup({ facts: { ...member, requesterKind: 'bot', wake: true } }).call()).toMatchObject({ result: { facts: { role: 'bot', kind: 'wake' } } });
    expect(await setup({ facts: { ...member, initiative: true } }).call()).toMatchObject({ result: { facts: { kind: 'initiative' } } });
    expect(await setup({ facts: { ...member, retry: true } }).call()).toMatchObject({ result: { facts: { kind: 'retry' } } });
  });
  it('works in a private chat too', async () => {
    expect(await setup({ place: { kind: 'p2p', chatId: 'oc_dm' } }).call()).toMatchObject({ ok: true, result: { facts: { place: 'dm' } } });
  });
  it('is not given in a comment session: not listed, and a direct call is "unknown-tool"', async () => {
    const f = setup({ place: { kind: 'doc', docId: 'd1' } });
    expect(f.entry.tools().map(spec => spec.name)).toEqual(['t_read']);
    expect(await f.call()).toMatchObject({ ok: false, code: 'unknown-tool' });
    expect(setup().entry.tools().map(spec => spec.name)).toEqual(['t_read', 't_mem']);
  });
  it('refuses once the turn is over, and before any turn is known', async () => {
    const f = setup();
    f.scope.close();
    expect(await f.call()).toMatchObject({ ok: false, code: 'refused', reason: 'turn-ended' });
    const g = setup();
    expect(await g.entry.call('t_mem', {}, { toolUseId: 'never-seen' })).toMatchObject({ ok: false, reason: 'unknown-origin' });
  });
  it('a Codex call from an earlier turn is refused once a newer turn started (it uses the first turn)', async () => {
    const f = setup({ codex: true });
    f.entries.openTurn(f.t, { ...member, triggerMessageId: 'om_2' });
    expect(await f.call()).toMatchObject({ ok: false, reason: 'turn-ended' });
  });
});

describe('an interruption changes where a memory lands, not whether the call runs', () => {
  it('lets the call finish and reports the turn as steered', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = setup({ facts: { ...member, requesterOpenId: 'ou_o' }, run: async (_args, ctx) => { await gate; return ctx.memoryTurn?.(); } });
    const pending = f.call();
    await Promise.resolve();
    f.entries.noteSteer(f.t, { openId: 'ou_other', kind: 'user' });
    release();
    expect(await pending).toMatchObject({ ok: true, result: { steered: true, kind: 'human', active: true } });
  });
  it('the requester steering their own turn is not an interruption', async () => {
    const f = setup();
    f.entries.noteSteer(f.t, { openId: 'ou_m', kind: 'user' });
    expect(await f.call()).toMatchObject({ result: { facts: { steered: false } } });
  });
  it('a call still running when the turn ends is stopped with turn-ended', async () => {
    const f = setup({ run: (_args, ctx) => new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    const pending = f.call();
    await Promise.resolve();
    f.scope.close();
    expect(await pending).toMatchObject({ ok: false, reason: 'turn-ended' });
  });
});

describe('the one Bot write per turn', () => {
  it('is reserved once, released on failure, and counted in the turn facts', async () => {
    const f = setup({ run: async (_args, ctx) => {
      const first = ctx.reserveBotWrite?.(); const second = ctx.reserveBotWrite?.();
      const counted = ctx.memoryTurn?.()?.botWrites;
      ctx.releaseBotWrite?.();
      return { first, second, counted, after: ctx.memoryTurn?.()?.botWrites, again: ctx.reserveBotWrite?.() };
    } });
    expect(await f.call()).toMatchObject({ result: { first: true, second: false, counted: 1, after: 0, again: true } });
  });
  it('is shared by the calls of one turn and starts again on the next', async () => {
    const f = setup({ run: async (_args, ctx) => ctx.reserveBotWrite?.() });
    expect(await f.call()).toMatchObject({ result: true });
    expect(await f.call()).toMatchObject({ result: false });
    f.scope.close();
    f.entries.openTurn(f.t, { ...member, triggerMessageId: 'om_2' });
    f.entry.noteToolUse('u2');
    expect(await f.entry.call('t_mem', {}, { toolUseId: 'u2' })).toMatchObject({ result: true });
  });
});

describe('the commit contract for memory', () => {
  it('lets a write that never reached its commit point (full, duplicate) return normally', async () => {
    const f = setup({ run: async (_args, ctx) => ctx.commit!(async () => 'refused-before-commit') });
    expect(await f.call()).toMatchObject({ ok: true, result: 'refused-before-commit' });
    expect(logs.fail).not.toHaveBeenCalled();
  });
  it('refuses before writing when the turn ended, and the guard stops a write at the commit point', async () => {
    const f = setup({ run: async (_args, ctx) => ctx.commit!(async guard => { f.scope.close(); guard(); return 'wrote'; }) });
    expect(await f.call()).toMatchObject({ ok: false, reason: 'turn-ended' });
  });
  it('exposes the turn to the hidden-block parser as a live view bound to this turn', async () => {
    const f = setup();
    const view = f.entries.memoryTurn(f.t)!;
    expect(view).toMatchObject({ place: { kind: 'group', chatId: 'oc_a' }, triggerMessageId: 'om_1' });
    expect(view.turn()).toMatchObject({ active: true, role: 'member', kind: 'human' });
    f.scope.close();
    expect(view.turn()).toMatchObject({ active: false });
    expect(f.entries.memoryTurn(thread())).toBeUndefined();
  });
});
