import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JudgeCallError, type AgentBackend, type JudgeCall, type JudgeCallOutput } from '../src/agent/types';
import { JUDGE_COOLDOWN_MS } from '../src/judge/cooldown';
import { createJudge } from '../src/judge/judge';
import type { JudgeErrorKind, JudgeRequest } from '../src/judge/types';

const fake = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));
vi.mock('../src/core/logger', () => ({ log: fake.log }));

function setup() {
  let next: (call: JudgeCall) => Promise<JudgeCallOutput> = async () => ({ text: '{"decision":"main","reason":""}' });
  const judgeFn = vi.fn((call: JudgeCall) => next(call));
  const backend = { id: 'codex-appserver', displayName: 'Codex', listModels: async () => [], judge: judgeFn } as unknown as AgentBackend;
  const judge = createJudge({ backendFor: () => backend, readPrompt: async () => ({ source: 'default', text: 'S', path: '' }), cwd: async () => '/j' });
  return {
    judge, calls: judgeFn,
    fail(kind: JudgeErrorKind, structured: boolean) { next = async () => { throw new JudgeCallError(kind, `boom ${kind}`, structured); }; },
    succeed() { next = async () => ({ text: '{"decision":"main","reason":""}' }); },
  };
}

const req = (model?: string): JudgeRequest => ({
  variant: 'mentioned', appId: 'cli_a', botName: 'P',
  group: { chatId: 'oc_g', name: 'g', backend: 'codex-appserver', ...(model ? { judge: { kind: 'llm', backend: 'codex-appserver', model } } : {}) },
  context: [], message: { at: 0, from: 'user', name: 'u', text: 't' },
});

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  fake.log.info.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('judge cooldown (design 第 4 节)', () => {
  it('a structured quota failure skips the backend for 5 minutes, then calls it again', async () => {
    const s = setup();
    s.fail('quota', true);
    expect((await s.judge.judge(req())).error?.kind).toBe('quota');
    expect(s.calls).toHaveBeenCalledTimes(1);
    expect(fake.log.info.mock.calls.find((c) => c[1] === 'cooldown')?.[2]).toMatchObject({ backend: 'codex-appserver', kind: 'quota', until: 1_000_000 + JUDGE_COOLDOWN_MS });
    s.succeed();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const cooled = await s.judge.judge(req());
    expect(cooled).toMatchObject({ decision: 'main', error: { kind: 'quota', detail: '2 分钟前刚失败过，5 分钟内不再调' } });
    // auth and quota cool the whole backend, whatever the model
    expect((await s.judge.judge(req('other'))).error?.kind).toBe('quota');
    expect(s.calls).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect((await s.judge.judge(req())).error).toBeUndefined();
    expect(s.calls).toHaveBeenCalledTimes(2);
  });

  it('a model cooldown leaves other models of the backend alone', async () => {
    const s = setup();
    s.fail('model', true);
    expect((await s.judge.judge(req('bad-id'))).error?.kind).toBe('model');
    s.succeed();
    expect((await s.judge.judge(req('bad-id'))).error?.kind).toBe('model');
    expect(s.calls).toHaveBeenCalledTimes(1);
    expect((await s.judge.judge(req('good-id'))).error).toBeUndefined();
    expect((await s.judge.judge(req())).error).toBeUndefined();
    expect(s.calls).toHaveBeenCalledTimes(3);
  });

  it('a kind only read from the text does not cool: the next judgement calls the backend', async () => {
    const s = setup();
    for (const kind of ['auth', 'quota', 'model'] as const) {
      s.fail(kind, false);
      expect((await s.judge.judge(req())).error?.kind).toBe(kind);
    }
    s.fail('network', true);
    expect((await s.judge.judge(req())).error?.kind).toBe('network');
    s.succeed();
    expect((await s.judge.judge(req())).error).toBeUndefined();
    expect(s.calls).toHaveBeenCalledTimes(5);
    expect(fake.log.info.mock.calls.some((c) => c[1] === 'cooldown')).toBe(false);
  });
});
