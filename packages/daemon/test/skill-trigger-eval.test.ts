import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBackend } from '../src/agent/types';
import type { SessionProfile } from '../src/agent/session-profile';
import { runCase, verdictOf, type Case, type RolloutRead } from './manual/skill-trigger-eval';

/**
 * How test/manual/skill-trigger-eval.ts judges a case (Codex review 258-1). main 必败: a start that failed, a turn an
 * error ended and a rollout never found passed a case that should open no skill, as nothing was seen opened.
 */
const negative: Case = { id: 'n1', text: '解释一下这段代码', want: null };
const positive: Case = { id: 's1', text: '每天早上 9 点在群里发一下昨天的进度', want: 'vonvon-schedule' };
const profile = {} as SessionProfile;
const events = (...list: Array<Record<string, unknown>>) => ({ async *[Symbol.asyncIterator]() { for (const event of list) yield event; } });
/** A backend whose one thread streams `list`. */
const backend = (...list: Array<Record<string, unknown>>): AgentBackend => ({
  startThread: async () => ({ sessionId: 'thr_probe', runStreamed: () => ({ events: events(...list), turnId: () => undefined }), close: async () => {} }),
}) as unknown as AgentBackend;
const rollout = (read: Partial<RolloutRead> = {}) => async (): Promise<RolloutRead> => ({ found: true, opened: [], tools: [], ...read });
const noRollout = async (): Promise<RolloutRead> => ({ found: false, opened: [], tools: ['(no rollout)'] });

describe('the skill trigger eval', () => {
  it('counts a run it did not see through as invalid, never as a pass', async () => {
    const failed = { startThread: async () => { throw new Error('Provider temporarily unavailable'); } } as unknown as AgentBackend;
    expect(await runCase('codex', failed, profile, negative, {}, rollout())).toMatchObject({ ended: 'failed: Provider temporarily unavailable', verdict: 'invalid' });
    expect(await runCase('codex', backend({ type: 'error', willRetry: false, message: 'Connection closed' }), profile, negative, {}, rollout()))
      .toMatchObject({ ended: 'error: Connection closed', verdict: 'invalid' });
    // the turn ended, but where its calls are written could not be found or read
    expect(await runCase('codex', backend({ type: 'done' }), profile, negative, {}, noRollout)).toMatchObject({ ended: 'done', observed: false, verdict: 'invalid' });
    expect(await runCase('codex', backend({ type: 'done' }), profile, negative, {}, async () => { throw new Error('EACCES'); })).toMatchObject({ observed: false, verdict: 'invalid' });
    // Claude: no message of the SDK came through to look at
    expect(await runCase('claude', backend({ type: 'done' }), profile, negative, { messages: () => {} })).toMatchObject({ ended: 'done', observed: false, verdict: 'invalid' });
  });

  it('passes a negative case only when the run was seen through and opened nothing', async () => {
    expect(await runCase('codex', backend({ type: 'done' }), profile, negative, {}, rollout())).toMatchObject({ observed: true, verdict: 'ok' });
    expect(await runCase('codex', backend({ type: 'done' }), profile, negative, {}, rollout({ opened: ['vonvon-feishu'] }))).toMatchObject({ verdict: 'miss' });
    expect(await runCase('codex', backend({ type: 'done' }), profile, positive, {}, rollout({ opened: ['vonvon-schedule'] }))).toMatchObject({ verdict: 'ok' });
    expect(await runCase('codex', backend({ type: 'done' }), profile, positive, {}, rollout())).toMatchObject({ verdict: 'miss' });
    let handler: ((message: SDKMessage) => void) | undefined;
    const claude = backend({ type: 'done' });
    const start = claude.startThread.bind(claude);
    claude.startThread = async options => { handler?.({ type: 'system' } as SDKMessage); return start(options); };
    expect(await runCase('claude', claude, profile, negative, { messages: next => { handler = next; } })).toMatchObject({ observed: true, verdict: 'ok' });
  });

  it('judges from what it saw: a skill seen opened decides, nothing seen needs the whole run', () => {
    expect(verdictOf(null, [], 'done', true)).toBe('ok');
    expect(verdictOf(null, [], 'stopped-after-tools', true)).toBe('ok');
    for (const ended of ['failed: x', 'error: x', 'timeout']) expect(verdictOf(null, [], ended, true), ended).toBe('invalid');
    expect(verdictOf(null, [], 'done', false)).toBe('invalid');
    expect(verdictOf(null, ['vonvon-schedule'], 'error: x', false)).toBe('miss');
    expect(verdictOf('vonvon-schedule', ['vonvon-schedule'], 'timeout', false)).toBe('ok');
    expect(verdictOf('vonvon-schedule', [], 'timeout', true)).toBe('invalid');
    expect(verdictOf('vonvon-schedule', ['vonvon-feishu'], 'stopped-after-skill', true)).toBe('miss');
  });
});
