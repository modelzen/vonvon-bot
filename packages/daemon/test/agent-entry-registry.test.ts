import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentThread } from '../src/agent/types';
import { createAgentEntries, type AgentPlace, type TurnFacts } from '../src/agent/entry/registry';
import type { AgentTool, ToolContext } from '../src/agent/entry/tools';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), fail: vi.fn() }));
vi.mock('../src/core/logger', () => ({ log: logs }));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function thread(releaseAfterRun?: boolean): AgentThread {
  return {
    sessionId: 'fixture', ...(releaseAfterRun === undefined ? {} : { releaseAfterRun }), isAlive: vi.fn(() => true), close: vi.fn(async () => {}),
    runStreamed: () => { throw Error('unused'); }, runGoal: () => { throw Error('unused'); },
    clearGoal: async () => {}, steer: async () => {}, abort: async () => {},
    compact: async () => ({ compacted: false, usage: null }),
  };
}
const person: TurnFacts = { requesterOpenId: 'admin', requesterKind: 'user', triggerMessageId: 'm1', retry: false, initiative: false, wake: false };
const read: AgentTool = { name: 't_read', class: 'read', description: 'fixture read', input: z.object({}), run: async () => 'read' };
function setting(run: AgentTool['run'] = async (_args, ctx) => ctx.turn): AgentTool {
  return { name: 't_set', class: 'settings', description: 'fixture settings', input: z.object({}), run };
}
function setup(options: { place?: AgentPlace; facts?: TurnFacts; run?: AgentTool['run']; attached?: boolean; open?: boolean; codex?: boolean } = {}) {
  const state = { admin: true, enabled: true };
  const entries = createAgentEntries({ appId: 'fixture', isAdmin: () => state.admin, isOwner: () => false,
    chatSettingsOn: () => state.enabled, tools: [read, setting(options.run)] });
  const entry = entries.issue(options.place ?? { kind: 'p2p' });
  const t = thread(options.codex ? false : undefined);
  if (options.attached !== false) entry.attach(t);
  const scope = options.open === false ? undefined : entries.openTurn(t, options.facts ?? person);
  entry.noteToolUse('u1');
  const call = () => entry.call('t_set', {}, { toolUseId: 'u1' });
  return { entries, entry, t, scope, state, call };
}
function refused(reason: string) { return { ok: false, code: 'refused', reason }; }
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('entry lifecycle and authorization', () => {
  it('isolates places and turns without returning private identifiers', async () => {
    const entries = createAgentEntries({ appId: 'fixture', isAdmin: () => true, isOwner: () => false });
    const a = entries.issue({ kind: 'group', chatId: 'private-chat' });
    const b = entries.issue({ kind: 'p2p', chatId: 'private-dm' });
    const ta = thread(); a.attach(ta); b.attach(thread()); entries.openTurn(ta, person);
    const aa = await a.call('session_info', {}), bb = await b.call('session_info', {});
    expect(aa).toMatchObject({ ok: true, result: { v: 1, place: 'group', turn: 'person', settings: { allowed: false, reason: 'not-dm' } } });
    expect(bb).toMatchObject({ ok: true, result: { place: 'p2p', turn: 'none' } });
    expect(JSON.stringify([aa, bb])).not.toMatch(/private-chat|private-dm|admin|m1/);
    entries.closeAll('shutdown');
  });
  it.each(['group', 'doc', 'p2p'] as const)('discovers settings writers only in DM, including pending %s entries', async kind => {
    const write = vi.fn(async () => 'changed');
    const f = setup({ place: { kind }, attached: false, open: false, run: write });
    const names = () => f.entry.tools().map(spec => spec.name);
    expect(names()).toEqual(kind === 'p2p' ? ['t_read', 't_set'] : ['t_read']);
    f.entry.attach(f.t);
    expect(await f.entry.call('t_read', {})).toEqual({ ok: true, result: 'read' });
    f.state.admin = false; f.state.enabled = false;
    expect(names()).toEqual(kind === 'p2p' ? ['t_read', 't_set'] : ['t_read']);
    if (kind !== 'p2p') expect(await f.call()).toMatchObject(refused('not-dm'));
    expect(write).not.toHaveBeenCalled();
    f.entry.revoke('closed');
    expect(() => names()).toThrow();
  });
  it('permits static discovery pending attach, but no calls', async () => {
    const run = vi.fn(async () => 'ok'); const f = setup({ attached: false, open: false, run });
    expect(f.entry.tools().map(tool => tool.name)).toContain('t_read');
    for (const spec of f.entry.tools()) expect(Object.keys(spec).sort()).toEqual(['description', 'input', 'name']);
    expect(await f.entry.call('t_set', {}, { toolUseId: 'u1' })).toMatchObject({ code: 'not-ready' });
    expect(run).not.toHaveBeenCalled();
    f.entry.attach(f.t); expect(await f.entry.call('t_read', {})).toEqual({ ok: true, result: 'read' });
    f.entry.revoke('start-failed'); expect(() => f.entry.tools()).toThrow();
    expect(await f.entry.call('t_read', {})).toMatchObject({ code: 'revoked' });
  });
  it('discovers session_info before attach without including place facts', async () => {
    const entries = createAgentEntries({ appId: 'fixture', isAdmin: () => true, isOwner: () => false });
    const a = entries.issue({ kind: 'group', chatId: 'hidden-a' });
    const b = entries.issue({ kind: 'p2p', chatId: 'hidden-b' });
    expect(a.tools().map(spec => spec.name)).toContain('session_info');
    expect(a.tools()).toEqual(b.tools());
    expect(JSON.stringify(a.tools())).not.toMatch(/hidden-a|hidden-b/);
    expect(await a.call('session_info', {})).toMatchObject({ code: 'not-ready' });
    a.attach(thread()); expect(await a.call('session_info', {})).toMatchObject({ ok: true, result: { place: 'group' } });
    b.revoke('start-failed'); expect(() => b.tools()).toThrow();
    expect(await b.call('session_info', {})).toMatchObject({ code: 'revoked' });
    entries.closeAll('shutdown');
  });
  it('makes revocation idempotent and permanent', async () => {
    const f = setup(); f.entry.revoke('closed'); f.entry.revoke('closed');
    expect(await f.call()).toMatchObject({ code: 'revoked' });
  });
  it('revokes a dead thread on call', async () => {
    const f = setup(); vi.mocked(f.t.isAlive).mockReturnValue(false);
    expect(await f.call()).toMatchObject({ code: 'revoked' });
    vi.mocked(f.t.isAlive).mockReturnValue(true);
    expect(await f.entry.call('t_read', {})).toMatchObject({ code: 'revoked' });
  });
  it('revokes all grants and stops issuance during shutdown', async () => {
    const f = setup(); const other = f.entries.issue({ kind: 'group' }); other.attach(thread());
    f.entries.closeAll('shutdown');
    expect(await f.call()).toMatchObject({ code: 'revoked' });
    expect(await other.call('t_read', {})).toMatchObject({ code: 'revoked' });
    expect(await f.entries.issue({ kind: 'p2p' }).call('t_read', {})).toMatchObject({ code: 'revoked' });
  });
  it.each([
    ['group', { place: { kind: 'group' } }, 'not-dm'],
    ['no turn', { open: false }, 'turn-ended'],
    ['bot', { facts: { ...person, requesterKind: 'bot' } }, 'not-human-turn'],
    ['unknown sender', { facts: { ...person, requesterKind: 'unknown' } }, 'not-human-turn'],
    ['no sender id', { facts: { ...person, requesterOpenId: undefined } }, 'not-human-turn'],
    ['no trigger message', { facts: { ...person, triggerMessageId: undefined } }, 'not-human-turn'],
    ['retry', { facts: { ...person, retry: true } }, 'not-human-turn'],
    ['initiative', { facts: { ...person, initiative: true } }, 'not-human-turn'],
    ['wake', { facts: { ...person, wake: true } }, 'not-human-turn'],
  ] satisfies [string, Parameters<typeof setup>[0], string][])('rejects %s before running settings', async (_name, options, reason) => {
    const run = vi.fn(async () => 'ok'); const f = setup({ ...options, run });
    expect(await f.call()).toMatchObject(refused(reason)); expect(run).not.toHaveBeenCalled();
  });
  it('checks current admin membership before the current switch', async () => {
    const f = setup(); f.state.admin = false; f.state.enabled = false;
    expect(await f.call()).toMatchObject(refused('not-admin'));
    f.state.admin = true; expect(await f.call()).toMatchObject(refused('switch-off'));
    f.state.enabled = true;
    expect(await f.call()).toMatchObject({ ok: true, result: { requesterOpenId: 'admin', role: 'admin', triggerMessageId: 'm1' } });
    f.state.admin = false; expect(await f.call()).toMatchObject(refused('not-admin'));
  });
  it('reports not-dm first for a group without a turn and with switch off', async () => {
    const f = setup({ place: { kind: 'group' }, open: false }); f.state.enabled = false;
    expect(await f.call()).toMatchObject(refused('not-dm'));
  });
  it('allows same-person steering and refuses another person', async () => {
    const f = setup(); f.entries.noteSteer(f.t, { openId: 'admin', kind: 'user' });
    expect(await f.call()).toMatchObject({ ok: true });
    f.entries.noteSteer(f.t, { openId: 'other', kind: 'user' });
    expect(await f.call()).toMatchObject(refused('not-human-turn'));
  });
  it('allows the next human turn after the previous one closes', async () => {
    const f = setup(); f.scope?.close(); expect(await f.call()).toMatchObject(refused('turn-ended'));
    f.entries.openTurn(f.t, { ...person, triggerMessageId: 'm2' }); f.entry.noteToolUse('u2');
    expect(await f.entry.call('t_set', {}, { toolUseId: 'u2' })).toMatchObject({ ok: true, result: { triggerMessageId: 'm2' } });
  });
  it('allows reads in groups with no turn and rejects unknown tools', async () => {
    const f = setup({ place: { kind: 'group' }, open: false });
    expect(await f.entry.call('t_read', {})).toEqual({ ok: true, result: 'read' });
    expect(await f.entry.call('missing', {})).toMatchObject({ code: 'unknown-tool' });
  });
  it('rejects oversized results without reflecting their contents', async () => {
    const f = setup({ run: async () => 'secret-result'.repeat(30_000) }); const reply = await f.call();
    expect(reply).toMatchObject({ code: 'failed' }); expect(JSON.stringify(reply)).not.toContain('secret-result');
  });
  it('does not reflect invalid argument values', async () => {
    const f = setup(); const reply = await f.entry.call('t_set', 'SECRET-XYZ', { toolUseId: 'u1' });
    expect(reply).toMatchObject({ code: 'bad-args' }); expect(JSON.stringify(reply)).not.toContain('SECRET-XYZ');
  });
  it('caps live grants and reclaims a dead thread before issue', async () => {
    const entries = createAgentEntries({ appId: 'fixture', isAdmin: () => true, isOwner: () => false, tools: [read] });
    const dead = thread(); const first = entries.issue({ kind: 'group' }); first.attach(dead);
    for (let index = 1; index < 1024; index++) entries.issue({ kind: 'group' });
    expect(await entries.issue({ kind: 'group' }).call('t_read', {})).toMatchObject({ code: 'not-ready' });
    expect(logs.warn.mock.calls.flat().concat(logs.info.mock.calls.flat())).toContain('entry-cap');
    vi.mocked(dead.isAlive).mockReturnValue(false);
    const replacement = entries.issue({ kind: 'group' }); replacement.attach(thread());
    expect(await replacement.call('t_read', {})).toMatchObject({ ok: true });
    expect(await first.call('t_read', {})).toMatchObject({ code: 'revoked' }); entries.closeAll('shutdown');
  });
});

describe('original turn ownership', () => {
  it.each([
    ['close', (f: ReturnType<typeof setup>) => f.scope?.close(), 'turn-ended'],
    ['other person', (f: ReturnType<typeof setup>) => f.entries.noteSteer(f.t, { openId: 'other', kind: 'user' }), 'not-human-turn'],
    ['admin removed', (f: ReturnType<typeof setup>) => { f.state.admin = false; }, 'not-admin'],
    ['switch off', (f: ReturnType<typeof setup>) => { f.state.enabled = false; }, 'switch-off'],
    ['revoke', (f: ReturnType<typeof setup>) => f.entry.revoke('closed'), 'revoked'],
    ['thread died', (f: ReturnType<typeof setup>) => { vi.mocked(f.t.isAlive).mockReturnValue(false); }, 'revoked'],
    ['replacement', (f: ReturnType<typeof setup>) => { f.entries.openTurn(f.t, { ...person, triggerMessageId: 'm2' }); }, 'turn-ended'],
  ])('refuses commit after %s while the handler waits', async (_name, mutate, reason) => {
    const wait = deferred(), entered = deferred(); let commits = 0; let context: ToolContext | undefined;
    const f = setup({ run: async (_args, ctx) => { context = ctx; entered.resolve(); await wait.promise;
      if (!ctx.commit) throw Error('missing commit'); return ctx.commit(async guard => { guard(); commits++; }); } });
    const result = f.call(); await entered.promise; mutate(f); wait.resolve();
    expect(await result).toMatchObject(reason === 'revoked' ? { code: 'revoked' } : refused(reason));
    expect(commits).toBe(0);
    if (['revoked', 'turn-ended', 'not-human-turn'].includes(reason)) expect(context?.signal.aborted).toBe(true);
  });
  it('never attributes a late old tool-use to the new trigger message', async () => {
    const run = vi.fn(async (_args: unknown, ctx: ToolContext) => ctx.turn); const f = setup({ run });
    f.scope?.close(); f.entries.openTurn(f.t, { ...person, triggerMessageId: 'm2' });
    expect(await f.call()).toMatchObject(refused('turn-ended')); expect(run).not.toHaveBeenCalled();
    f.entry.noteToolUse('u2');
    expect(await f.entry.call('t_set', {}, { toolUseId: 'u2' })).toMatchObject({ ok: true, result: { triggerMessageId: 'm2' } });
  });
  it('rejects missing and unknown settings origins but permits reads', async () => {
    const f = setup();
    for (const origin of [undefined, { toolUseId: 'never-seen' }]) {
      expect(await f.entry.call('t_set', {}, origin)).toMatchObject(refused('unknown-origin'));
      expect(await f.entry.call('t_read', {}, origin)).toMatchObject({ ok: true });
    }
  });
  it('cannot borrow a human turn for an old bot tool-use', async () => {
    const f = setup({ facts: { ...person, requesterKind: 'bot' } }); f.scope?.close(); f.entries.openTurn(f.t, person);
    expect(await f.call()).toMatchObject(refused('turn-ended'));
  });
  it('keeps a Codex grant bound to its first turn', async () => {
    const f = setup({ codex: true }); expect(await f.entry.call('t_set', {})).toMatchObject({ ok: true });
    f.scope?.close(); f.entries.openTurn(f.t, { ...person, triggerMessageId: 'm2' });
    expect(await f.entry.call('t_set', {})).toMatchObject(refused('turn-ended'));
    expect(await f.entry.call('t_read', {})).toMatchObject({ ok: true });
  });
  it('does not undo a completed commit when the turn closes', async () => {
    let commits = 0; const f = setup({ run: async (_args, ctx) => {
      if (!ctx.commit) throw Error('missing commit'); await ctx.commit(async guard => { guard(); commits++; }); return 'saved'; } });
    expect(await f.call()).toEqual({ ok: true, result: 'saved' }); f.scope?.close();
    expect(commits).toBe(1); expect(await f.entry.call('t_read', {})).toMatchObject({ ok: true });
  });
});

describe('settings queues and absolute deadlines', () => {
  it('serializes settings and caps the waiting queue at eight', async () => {
    const gate = deferred(), entered = deferred(); const order: number[] = []; let index = 0;
    const f = setup({ run: async () => { const current = ++index; order.push(current); entered.resolve(); if (current === 1) await gate.promise; return current; } });
    const first = f.call(); await entered.promise; const queued = Array.from({ length: 8 }, () => f.call());
    expect(await f.call()).toMatchObject({ code: 'busy' }); expect(order).toEqual([1]);
    gate.resolve(); expect(await first).toMatchObject({ ok: true });
    expect((await Promise.all(queued)).every(reply => reply.ok)).toBe(true); expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it('never starts queued settings after their turn is replaced', async () => {
    const gate = deferred(), entered = deferred(); const run = vi.fn(async () => { entered.resolve(); await gate.promise; return 'done'; });
    const f = setup({ run }); const first = f.call(); await entered.promise; const second = f.call();
    f.entries.openTurn(f.t, { ...person, triggerMessageId: 'm2' }); gate.resolve();
    expect(await second).toMatchObject(refused('turn-ended')); await first; expect(run).toHaveBeenCalledTimes(1);
    f.entry.noteToolUse('u2'); expect(await f.entry.call('t_set', {}, { toolUseId: 'u2' })).toMatchObject({ ok: true });
  });
  it('never starts a queued handler after the turn closes', async () => {
    const gate = deferred(), entered = deferred(); const run = vi.fn(async () => { entered.resolve(); await gate.promise; return 'done'; });
    const f = setup({ run }); const first = f.call(); await entered.promise; const second = f.call();
    f.scope?.close(); gate.resolve();
    expect(await second).toMatchObject(refused('turn-ended')); await first; expect(run).toHaveBeenCalledTimes(1);
  });
  it('limits concurrently running reads to four without affecting other grants', async () => {
    const gate = deferred(); let started = 0;
    const entries = createAgentEntries({ appId: 'fixture', isAdmin: () => true, isOwner: () => false,
      tools: [{ ...read, run: async () => { started++; await gate.promise; return 'read'; } }] });
    const entry = entries.issue({ kind: 'group' }); entry.attach(thread());
    const pending = Array.from({ length: 4 }, () => entry.call('t_read', {}));
    expect(started).toBe(4); expect(await entry.call('t_read', {})).toMatchObject({ code: 'busy' });
    const other = entries.issue({ kind: 'group' }); other.attach(thread()); const separate = other.call('t_read', {});
    expect(started).toBe(5); gate.resolve();
    for (const reply of await Promise.all([...pending, separate])) expect(reply).toMatchObject({ ok: true });
    entries.closeAll('shutdown');
  });
  it('aborts a running handler immediately on revoke', async () => {
    const gate = deferred(), entered = deferred(); let signal: AbortSignal | undefined;
    const f = setup({ run: async (_args, ctx) => { signal = ctx.signal; entered.resolve(); await gate.promise; return 'done'; } });
    const result = f.call(); await entered.promise; f.entry.revoke('closed');
    expect(signal?.aborted).toBe(true); expect(await result).toMatchObject({ code: 'revoked' }); gate.resolve();
  });
  it('aborts a running call at seventy seconds', async () => {
    vi.useFakeTimers(); const gate = deferred(), entered = deferred(); let signal: AbortSignal | undefined;
    const f = setup({ run: async (_args, ctx) => { signal = ctx.signal; entered.resolve(); await gate.promise; return 'done'; } });
    const result = f.call(); await entered.promise; await vi.advanceTimersByTimeAsync(70_000);
    expect(await result).toMatchObject({ code: 'timeout' }); expect(signal?.aborted).toBe(true); gate.resolve();
  });
  it('includes sixty-nine seconds of queue time in the second budget', async () => {
    vi.useFakeTimers(); const firstGate = deferred(), secondGate = deferred(), entered = deferred(); let calls = 0, commits = 0; let signal: AbortSignal | undefined;
    const f = setup({ run: async (_args, ctx) => { calls++; entered.resolve();
      if (calls === 1) await firstGate.promise;
      else { signal = ctx.signal; await secondGate.promise; if (!ctx.commit) throw Error('missing commit'); await ctx.commit(async guard => { guard(); commits++; }); }
      return 'done'; } });
    const a = f.call(); await entered.promise; const b = f.call();
    await vi.advanceTimersByTimeAsync(69_000); firstGate.resolve(); await a;
    expect(calls).toBe(2); await vi.advanceTimersByTimeAsync(1_000);
    expect(await b).toMatchObject({ code: 'timeout' }); expect(signal?.aborted).toBe(true);
    secondGate.resolve(); await vi.advanceTimersByTimeAsync(0); expect(commits).toBe(0);
  });
  it('expires waiting items without starting them and releases queue capacity', async () => {
    vi.useFakeTimers(); const gate = deferred(), entered = deferred(); let commits = 0;
    const run = vi.fn(async (_args: unknown, ctx: ToolContext) => { entered.resolve(); await gate.promise;
      if (!ctx.commit) throw Error('missing commit'); await ctx.commit(async guard => { guard(); commits++; }); return 'done'; });
    const f = setup({ run }); const a = f.call(); await entered.promise;
    const queued = Array.from({ length: 8 }, () => f.call()); expect(await f.call()).toMatchObject({ code: 'busy' });
    await vi.advanceTimersByTimeAsync(70_000); expect(await a).toMatchObject({ code: 'timeout' });
    for (const reply of await Promise.all(queued)) expect(reply).toMatchObject({ code: 'timeout' });
    expect(run).toHaveBeenCalledTimes(1);
    const replacement = f.call(); gate.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(await replacement).toMatchObject({ ok: true }); expect(commits).toBe(1);
  });
});


it.each([255, 256])('does not reassign an old origin after %i other IDs', async count => {
  let commits = 0;
  const f = setup({ run: async (_args, ctx) => {
    if (!ctx.commit) throw Error('missing commit');
    return ctx.commit(async guard => { guard(); commits++; return ctx.turn?.triggerMessageId; });
  } });
  for (let i = 0; i < count; i++) f.entry.noteToolUse(`other-${i}`);
  f.scope?.close(); f.entries.openTurn(f.t, { ...person, triggerMessageId: 'm2' });
  f.entry.noteToolUse('u1');
  const reply = await f.call();
  expect.soft(commits).toBe(0);
  expect(reply).toMatchObject(refused('turn-ended'));
});

it('keeps the last provable new origin at capacity and the last ended turn\'s origins, and frees older ones for the next turn', async () => {
  let commits = 0;
  const f = setup({ run: async (_args, ctx) => {
    if (!ctx.commit) throw Error('missing commit');
    return ctx.commit(async guard => { guard(); commits++; return ctx.turn?.triggerMessageId; });
  } });
  for (let i = 0; i < 254; i++) f.entry.noteToolUse(`other-${i}`);
  f.scope?.close(); const second = f.entries.openTurn(f.t, { ...person, triggerMessageId: 'm2' });
  f.entry.noteToolUse('last-proof');
  expect(await f.entry.call('t_set', {}, { toolUseId: 'last-proof' })).toEqual({ ok: true, result: 'm2' });
  // Full, and the only ended turn is the one just before: its ids stay, so neither a new id nor a late copy of an old one is noted.
  f.entry.noteToolUse('overflow'); f.entry.noteToolUse('u1');
  expect(await f.entry.call('t_set', {}, { toolUseId: 'overflow' })).toMatchObject(refused('turn-ended'));
  expect(await f.entry.call('t_set', {}, { toolUseId: 'u1' })).toMatchObject(refused('turn-ended'));
  second.close(); f.entries.openTurn(f.t, { ...person, triggerMessageId: 'm3' });
  // The first turn's 255 ids go now; the second turn's stay. The id refused when full is not noted under this turn either.
  f.entry.noteToolUse('overflow'); f.entry.noteToolUse('fresh'); f.entry.noteToolUse('last-proof');
  expect(await f.entry.call('t_set', {}, { toolUseId: 'overflow' })).toMatchObject(refused('turn-ended'));
  expect(await f.entry.call('t_set', {}, { toolUseId: 'fresh' })).toEqual({ ok: true, result: 'm3' });
  expect(await f.entry.call('t_set', {}, { toolUseId: 'last-proof' })).toMatchObject(refused('turn-ended'));
  expect(await f.entry.call('t_set', {}, { toolUseId: 'other-0' })).toMatchObject(refused('turn-ended'));
  expect(await f.entry.call('t_read', {})).toEqual({ ok: true, result: 'read' });
  expect(commits).toBe(2);
});

it('does not note a late copy of an id pruned two turns back under the turn of the moment', async () => {
  let commits = 0;
  const f = setup({ run: async (_args, ctx) => {
    if (!ctx.commit) throw Error('missing commit');
    return ctx.commit(async guard => { guard(); commits++; return ctx.turn?.triggerMessageId; });
  } });
  // The first turn holds u1 and 200 more; the second calls nothing; the third's 56th id prunes the first turn's.
  for (let i = 0; i < 200; i++) f.entry.noteToolUse(`first-${i}`);
  f.scope?.close(); f.entries.openTurn(f.t, { ...person, triggerMessageId: 'm2' }).close();
  f.entries.openTurn(f.t, { ...person, triggerMessageId: 'm3' });
  for (let i = 0; i < 56; i++) f.entry.noteToolUse(`third-${i}`);
  f.entry.noteToolUse('u1');
  expect(await f.entry.call('t_set', {}, { toolUseId: 'u1' })).toMatchObject(refused('turn-ended'));
  expect(commits).toBe(0);
  expect(await f.entry.call('t_set', {}, { toolUseId: 'third-55' })).toEqual({ ok: true, result: 'm3' });
});

it('remembers at most 1024 pruned ids, the oldest going first', async () => {
  const f = setup();
  // 100 ids a turn; from the third turn on, each prunes the one two back: after 13 turns, 1100 ids of turns 1 to 11.
  for (let turn = 1; turn <= 13; turn++) {
    if (turn > 1) f.entries.openTurn(f.t, { ...person, triggerMessageId: `m${turn}` });
    for (let i = turn === 1 ? 1 : 0; i < 100; i++) f.entry.noteToolUse(`t${turn}-${i}`);
  }
  for (const id of ['u1', 't1-75']) expect(await f.entry.call('t_set', {}, { toolUseId: id })).toMatchObject(refused('unknown-origin'));
  for (const id of ['t1-76', 't11-99']) expect(await f.entry.call('t_set', {}, { toolUseId: id })).toMatchObject(refused('turn-ended'));
});

it('gives room again one turn later when a single turn filled the map, but not to an id refused while it was full', async () => {
  const f = setup();
  for (let i = 0; i < 255; i++) f.entry.noteToolUse(`other-${i}`);
  f.scope?.close(); const second = f.entries.openTurn(f.t, { ...person, triggerMessageId: 'm2' });
  f.entry.noteToolUse('u2');
  expect(await f.entry.call('t_set', {}, { toolUseId: 'u2' })).toMatchObject(refused('turn-ended'));
  second.close(); f.entries.openTurn(f.t, { ...person, triggerMessageId: 'm3' });
  // A late copy of u2 (streamed, then in the full message) would otherwise be noted under this turn.
  f.entry.noteToolUse('u2'); f.entry.noteToolUse('u3');
  expect(await f.entry.call('t_set', {}, { toolUseId: 'u2' })).toMatchObject(refused('turn-ended'));
  expect(await f.entry.call('t_set', {}, { toolUseId: 'u3' })).toMatchObject({ ok: true, result: { triggerMessageId: 'm3' } });
});
