import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentThread } from '../src/agent/types';
import { createAgentEntries, type AgentPlace, type TurnFacts } from '../src/agent/entry/registry';
import type { AgentTool } from '../src/agent/entry/tools';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), fail: vi.fn() }));
vi.mock('../src/core/logger', () => ({ log: logs }));
function thread(): AgentThread {
  return {
    sessionId: 'fixture', isAlive: vi.fn(() => true), close: vi.fn(async () => {}),
    runStreamed: () => { throw Error('unused'); }, runGoal: () => { throw Error('unused'); },
    clearGoal: async () => {}, steer: async () => {}, abort: async () => {},
    compact: async () => ({ compacted: false, usage: null }),
  };
}
/** Every field a person's turn has, so only `scheduled` tells the two apart. */
const person: TurnFacts = { requesterOpenId: 'ou_admin', requesterKind: 'user', triggerMessageId: 'om_1', retry: false, initiative: false, wake: false, typed: true, triggerText: '日报' };
const scheduled = { taskId: 'st_0123456789abcdef', runId: 'run-1' };
const setting: AgentTool = { name: 't_set', class: 'settings', description: 'fixture settings', input: z.object({}), run: async () => 'set' };
function setup(facts: TurnFacts, place: AgentPlace = { kind: 'group', chatId: 'oc_a' }) {
  const entries = createAgentEntries({ appId: 'fixture', isAdmin: id => id === 'ou_admin', tools: [setting] });
  const entry = entries.issue(place);
  const t = thread();
  entry.attach(t);
  const scope = entries.openTurn(t, facts);
  return { entries, entry, t, scope };
}

describe('turn presence', () => {
  it('a scheduled run is scheduled even with every field of a person\'s turn, and its memory turn is initiative', () => {
    const f = setup({ ...person, scheduled });
    expect(f.scope).toMatchObject({ presence: 'scheduled', scheduled: { taskId: 'st_0123456789abcdef', runId: 'run-1' } });
    expect(f.entries.memoryTurn(f.t)?.turn()).toMatchObject({ kind: 'initiative', active: true });
  });
  it('a person\'s turn is human', () => {
    const f = setup(person);
    expect(f.scope.presence).toBe('human');
    expect(f.scope).not.toHaveProperty('scheduled');
    expect(f.entries.memoryTurn(f.t)?.turn()).toMatchObject({ kind: 'human' });
  });
  it.each([
    ['bot', { ...person, requesterKind: 'bot' }, 'bot'],
    ['wake', { ...person, requesterKind: 'bot', wake: true }, 'wake'],
    ['initiative', { ...person, initiative: true }, 'initiative'],
    ['retry', { ...person, retry: true }, 'retry'],
  ] satisfies [string, TurnFacts, string][])('a %s turn has nobody present', (_name, facts, kind) => {
    const f = setup(facts);
    expect(f.scope.presence).toBe('none');
    expect(f.entries.memoryTurn(f.t)?.turn()).toMatchObject({ kind });
  });
  // dm-agent 8 (owner 2026-11-05): a private chat's task reads and changes settings, as the administrator who set it.
  it('a scheduled run in a private chat counts for settings as its administrator does', async () => {
    const f = setup({ ...person, scheduled }, { kind: 'p2p', chatId: 'oc_dm' });
    f.entry.noteToolUse('u1');
    expect(await f.entry.call('t_set', {}, { toolUseId: 'u1' })).toEqual({ ok: true, result: 'set' });
    const human = setup(person, { kind: 'p2p', chatId: 'oc_dm' });
    human.entry.noteToolUse('u1');
    expect(await human.entry.call('t_set', {}, { toolUseId: 'u1' })).toEqual({ ok: true, result: 'set' });
  });
});
