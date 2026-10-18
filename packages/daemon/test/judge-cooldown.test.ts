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

  it('a structured auth failure cools the whole backend, whatever the model', async () => {
    const s = setup();
    s.fail('auth', true);
    expect((await s.judge.judge(req('a'))).error?.kind).toBe('auth');
    s.succeed();
    expect((await s.judge.judge(req('a'))).error).toMatchObject({ kind: 'auth', detail: '不到 1 分钟前刚失败过，5 分钟内不再调' });
    expect((await s.judge.judge(req('b'))).error?.kind).toBe('auth');
    expect(s.calls).toHaveBeenCalledTimes(1);
  });

  it('a structured version failure cools only that model of the backend', async () => {
    const s = setup();
    s.fail('version', true);
    expect((await s.judge.judge(req('new-model'))).error?.kind).toBe('version');
    s.succeed();
    expect((await s.judge.judge(req('new-model'))).error).toMatchObject({ kind: 'version', detail: '不到 1 分钟前刚失败过，5 分钟内不再调' });
    expect(s.calls).toHaveBeenCalledTimes(1);
    expect((await s.judge.judge(req('old-model'))).error).toBeUndefined();
    expect(s.calls).toHaveBeenCalledTimes(2);
  });

  it('a judgement queued while another starts a cooldown does not call the backend once granted', async () => {
    const s = setup();
    const pending: Array<{ resolve(v: JudgeCallOutput): void; reject(e: unknown): void }> = [];
    s.calls.mockImplementation(() => new Promise<JudgeCallOutput>((resolve, reject) => { pending.push({ resolve, reject }); }));
    // Codex runs 4 at a time: the fifth queues
    const running = [1, 2, 3, 4].map(() => s.judge.judge(req()));
    const queued = s.judge.judge(req());
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    pending[0]!.reject(new JudgeCallError('quota', 'boom quota', true));
    expect((await running[0])!.error?.kind).toBe('quota');
    expect(await queued).toMatchObject({ decision: 'main', error: { kind: 'quota', detail: '不到 1 分钟前刚失败过，5 分钟内不再调' } });
    expect(s.calls).toHaveBeenCalledTimes(4);
    for (const p of pending.slice(1)) p.resolve({ text: '{"decision":"main","reason":""}' });
    for (const r of running.slice(1)) expect((await r).error).toBeUndefined();
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
