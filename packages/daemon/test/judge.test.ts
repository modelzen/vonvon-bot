import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JudgeCallError, type AgentBackend, type JudgeCall, type JudgeCallOutput, type ModelInfo } from '../src/agent/types';
import { createJudge, JUDGE_SETTLE_MS, MODEL_LIST_RETRY_MS, type JudgeDeps } from '../src/judge/judge';
import { SmartPromptError } from '../src/judge/smart-file';
import type { JudgeErrorKind, JudgeRequest, JudgeResult, JudgeVariant } from '../src/judge/types';

const fake = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));
vi.mock('../src/core/logger', () => ({ log: fake.log }));

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const ANSWER: JudgeCallOutput = { text: '{"decision":"topic","reason":"新的事"}', usage: { input: 10, cached: 2, output: 3 } };

function fakeBackend(extra: Partial<AgentBackend> = {}) {
  const calls: JudgeCall[] = [];
  let models: ModelInfo[] | undefined;
  let answer: (call: JudgeCall) => Promise<JudgeCallOutput> = async () => ANSWER;
  const backend = {
    id: 'codex-appserver',
    displayName: 'Codex',
    listModels: vi.fn(async () => [] as ModelInfo[]),
    peekModels: vi.fn(() => models),
    judge: vi.fn((call: JudgeCall) => { calls.push(call); return answer(call); }),
    ...extra,
  } as unknown as AgentBackend & { listModels: ReturnType<typeof vi.fn>; judge: ReturnType<typeof vi.fn> };
  return {
    backend, calls,
    setModels(next: ModelInfo[] | undefined) { models = next; },
    answer(fn: (call: JudgeCall) => Promise<JudgeCallOutput>) { answer = fn; },
  };
}

function make(backend: AgentBackend, deps: Partial<JudgeDeps> = {}) {
  return createJudge({
    backendFor: () => backend,
    readPrompt: async () => ({ source: 'bot', text: 'SMART', path: '/p' }),
    cwd: async () => '/judge',
    ...deps,
  });
}

const req = (variant: JudgeVariant = 'main', extra: Partial<JudgeRequest> = {}): JudgeRequest => ({
  variant, appId: 'cli_a', botName: '小P', group: { chatId: 'oc_g', name: '群', backend: 'codex-appserver' },
  context: [], message: { at: 0, from: 'user', name: '张三', text: '你好' }, ref: 'om_abcdef123456', ...extra,
});

/** Settles the promise and reports when, in fake ms, it settled. */
function timed<T>(promise: Promise<T>): { value?: T; at?: number } {
  const out: { value?: T; at?: number } = {};
  void promise.then((value) => { out.value = value; out.at = Date.now(); });
  return out;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  for (const fn of Object.values(fake.log)) fn.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('judge', () => {
  it('returns the verdict with sources, model and ms, and calls onResult once', async () => {
    const f = fakeBackend();
    f.answer(async () => { await new Promise((r) => setTimeout(r, 300)); return ANSWER; });
    const onResult = vi.fn();
    const result = timed(make(f.backend, { onResult }).judge(req('main')));
    await vi.advanceTimersByTimeAsync(300);
    expect(result.value).toEqual({
      decision: 'topic', reason: '新的事', backend: 'codex-appserver', model: 'gpt-6-luna', effort: 'low',
      modelSource: 'default', promptSource: 'bot', ms: 300,
    });
    expect(onResult).toHaveBeenCalledTimes(1);
    const call = f.calls[0]!;
    expect(call).toMatchObject({ model: 'gpt-6-luna', effort: 'low', cwd: '/judge' });
    expect(call.system.startsWith('SMART\n\n——以下由 vonvon 附加')).toBe(true);
    expect(call.input).toContain('【要判断的消息】');
    const verdict = fake.log.info.mock.calls.find((c) => c[1] === 'verdict')![2];
    expect(verdict).toMatchObject({ ref: '123456', decision: 'topic', inputTokens: 10, cachedTokens: 2, outputTokens: 3 });
    // never the text, the reason or the prompt
    expect(JSON.stringify(fake.log.info.mock.calls)).not.toMatch(/新的事|你好|SMART/);
  });

  it('falls back by variant: a mention replies in main, the rest skip', async () => {
    const kinds: JudgeErrorKind[] = ['auth', 'quota', 'version', 'model', 'network', 'failed', 'unavailable'];
    for (const kind of kinds) {
      const f = fakeBackend();
      f.answer(async () => { throw new JudgeCallError(kind, `boom ${kind}\nsecond line`, true); });
      const judge = make(f.backend);
      for (const variant of ['main', 'mentioned', 'topic'] as const) {
        const result = await judge.judge(req(variant));
        expect(result.decision).toBe(variant === 'mentioned' ? 'main' : 'skip');
        expect(result.error).toEqual({ kind, detail: `boom ${kind}` });
        expect(result.reason).toBe('');
      }
    }
    const f = fakeBackend();
    f.answer(async () => ({ text: '我觉得该回' }));
    const result = await make(f.backend).judge(req('mentioned'));
    expect(result).toMatchObject({ decision: 'main', error: { kind: 'format', detail: '模型没按格式回答' } });
    f.answer(async () => ({ text: '{"decision":"skip","reason":"x"}' }));
    expect((await make(f.backend).judge(req('mentioned'))).error?.kind).toBe('format');
  });

  it('a prompt failure still reports backend and model', async () => {
    const f = fakeBackend();
    const judge = make(f.backend, { readPrompt: async () => { throw new SmartPromptError('SMART.md 是符号链接', '/b/SMART.md'); } });
    const result = await judge.judge(req('mentioned'));
    expect(result).toMatchObject({ decision: 'main', backend: 'codex-appserver', model: 'gpt-6-luna', error: { kind: 'prompt', detail: 'SMART.md 是符号链接：/b/SMART.md' } });
    expect(f.backend.judge).not.toHaveBeenCalled();
  });

  it('times out on a stuck backend, prompt read or model list, and aborts the signal', async () => {
    const f = fakeBackend();
    f.answer(() => new Promise(() => undefined));
    const stuck = timed(make(f.backend).judge(req('mentioned', { timeoutMs: 1_000 })));
    await vi.advanceTimersByTimeAsync(999);
    expect(stuck.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(stuck.value).toMatchObject({ decision: 'main', error: { kind: 'timeout' }, ms: 1_000 });
    expect(f.calls[0]!.signal.aborted).toBe(true);

    const prompt = timed(make(fakeBackend().backend, { readPrompt: () => new Promise(() => undefined) }).judge(req('main', { timeoutMs: 500 })));
    await vi.advanceTimersByTimeAsync(500);
    expect(prompt.value).toMatchObject({ decision: 'skip', error: { kind: 'timeout' } });

    // the default timeout for a mention is 10 s
    const def = timed(make(f.backend).judge(req('mentioned')));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(def.at).toBe(1_000_000 + 1_500 + 10_000);

    const list = fakeBackend({ listModels: vi.fn(() => new Promise<ModelInfo[]>(() => undefined)) });
    const result = await make(list.backend).judge(req());
    expect(result.decision).toBe('topic');
  });

  it('fetches the model list once in the background, and not again for 5 minutes', async () => {
    const f = fakeBackend();
    const list = deferred<ModelInfo[]>();
    (f.backend.listModels as ReturnType<typeof vi.fn>).mockImplementation(() => list.promise);
    const judge = make(f.backend);
    const results = await Promise.all(Array.from({ length: 10 }, () => judge.judge(req())));
    expect(results.every((r) => r.decision === 'topic' && r.effort === 'low')).toBe(true);
    expect(f.backend.listModels).toHaveBeenCalledTimes(1);
    list.resolve([]); // the static list: nothing cached
    await vi.advanceTimersByTimeAsync(0);
    (f.backend.listModels as ReturnType<typeof vi.fn>).mockImplementation(async () => []);
    await judge.judge(req());
    judge.warm('codex-appserver');
    expect(f.backend.listModels).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MODEL_LIST_RETRY_MS);
    await judge.judge(req());
    expect(f.backend.listModels).toHaveBeenCalledTimes(2);
    // once cached, the effort comes from the list
    f.setModels([{ id: 'gpt-6-luna', displayName: '', description: '', supportedEfforts: ['minimal', 'low'], defaultEffort: 'low', isDefault: true, hidden: false }]);
    expect((await judge.judge(req())).effort).toBe('minimal');
    expect(f.backend.listModels).toHaveBeenCalledTimes(2);
  });

  it('a cache read that throws after the list settles waits 5 minutes like an empty one', async () => {
    const f = fakeBackend();
    const list = deferred<ModelInfo[]>();
    (f.backend.listModels as ReturnType<typeof vi.fn>).mockImplementation(() => list.promise);
    const judge = make(f.backend);
    await judge.judge(req());
    expect(f.backend.listModels).toHaveBeenCalledTimes(1);
    (f.backend.peekModels as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('cache gone'); });
    list.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    (f.backend.listModels as ReturnType<typeof vi.fn>).mockImplementation(async () => []);
    (f.backend.peekModels as ReturnType<typeof vi.fn>).mockImplementation(() => undefined);
    await judge.judge(req());
    expect(f.backend.listModels).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MODEL_LIST_RETRY_MS);
    await judge.judge(req());
    expect(f.backend.listModels).toHaveBeenCalledTimes(2);
  });

  it('queues 16 behind 4 running, refuses the 21st as busy, and counts queue time in the timeout', async () => {
    const f = fakeBackend();
    f.answer(() => new Promise(() => undefined));
    const judge = make(f.backend);
    const running = Array.from({ length: 20 }, () => timed(judge.judge(req('main', { timeoutMs: 5_000 }))));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.backend.judge).toHaveBeenCalledTimes(4);
    const busy = await judge.judge(req('mentioned'));
    expect(busy).toMatchObject({ decision: 'main', error: { kind: 'busy' } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(running.every((r) => r.value?.error?.kind === 'timeout' && r.at === 1_000_000 + 5_000)).toBe(true);
    expect(f.backend.judge).toHaveBeenCalledTimes(4);
  });

  it('gives a slot back only when the backend call settles, or after 15 s', async () => {
    const f = fakeBackend();
    const pending: Deferred<JudgeCallOutput>[] = [];
    f.answer(() => { const d = deferred<JudgeCallOutput>(); pending.push(d); return d.promise; });
    const judge = make(f.backend);
    for (let i = 0; i < 4; i++) void judge.judge(req('main', { timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000); // all four timed out, their calls still running
    const fifth = timed(judge.judge(req('main', { timeoutMs: 30_000 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.backend.judge).toHaveBeenCalledTimes(4);
    pending[0]!.reject(new Error('aborted'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.backend.judge).toHaveBeenCalledTimes(5);
    pending[4]!.resolve(ANSWER);
    await vi.advanceTimersByTimeAsync(0);
    expect(fifth.value?.decision).toBe('topic');

    const sixth = timed(judge.judge(req('main', { timeoutMs: 30_000 })));
    const seventh = timed(judge.judge(req('main', { timeoutMs: 30_000 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.backend.judge).toHaveBeenCalledTimes(6); // three stuck calls plus the sixth
    expect(fake.log.warn.mock.calls.filter((c) => c[1] === 'slow-settle')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(JUDGE_SETTLE_MS - 1);
    expect(f.backend.judge).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1); // 15 s after the four were aborted
    expect(fake.log.warn.mock.calls.filter((c) => c[1] === 'slow-settle')).toHaveLength(3);
    expect(f.backend.judge).toHaveBeenCalledTimes(7);
    expect(sixth.value).toBeUndefined();
    expect(seventh.value).toBeUndefined();
  });

  it('a queued judgement aborted in the tick its slot is granted hands the slot on', async () => {
    const f = fakeBackend();
    const pending: Deferred<JudgeCallOutput>[] = [];
    f.answer(() => { const d = deferred<JudgeCallOutput>(); pending.push(d); return d.promise; });
    const judge = make(f.backend);
    for (let i = 0; i < 4; i++) void judge.judge(req('main', { timeoutMs: 30_000 }));
    const caller = new AbortController();
    const fifth = timed(judge.judge(req('main', { timeoutMs: 30_000, signal: caller.signal })));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.backend.judge).toHaveBeenCalledTimes(4);
    // The first call settling releases its slot to the fifth in a microtask; this reaction runs
    // right after that one, before the fifth's continuation sees the grant.
    void pending[0]!.promise.then(() => caller.abort());
    pending[0]!.resolve(ANSWER);
    await vi.advanceTimersByTimeAsync(0);
    expect(fifth.value).toMatchObject({ decision: 'skip', error: { kind: 'aborted' } });
    expect(f.backend.judge).toHaveBeenCalledTimes(4);
    const sixth = timed(judge.judge(req('main', { timeoutMs: 30_000 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.backend.judge).toHaveBeenCalledTimes(5);
    pending[4]!.resolve(ANSWER);
    await vi.advanceTimersByTimeAsync(0);
    expect(sixth.value?.decision).toBe('topic');
  });

  it('logs the caller giving up and shutdown as info, other failures as warn', async () => {
    const f = fakeBackend();
    f.answer(() => new Promise(() => undefined));
    const caller = new AbortController();
    caller.abort();
    const judge = make(f.backend);
    await judge.judge(req('main', { signal: caller.signal }));
    void judge.shutdown();
    await judge.judge(req('main'));
    const failedAt = (fn: typeof fake.log.info) => fn.mock.calls.filter((c) => c[1] === 'failed').map((c) => (c[2] as { kind: string }).kind);
    expect(failedAt(fake.log.info)).toEqual(['aborted', 'closed']);
    expect(failedAt(fake.log.warn)).toEqual([]);
    const g = fakeBackend();
    g.answer(async () => { throw new JudgeCallError('quota', 'q', true); });
    await make(g.backend).judge(req('main'));
    expect(failedAt(fake.log.warn)).toEqual(['quota']);
  });

  it('a backend with no judge method is unavailable', async () => {
    const f = fakeBackend({ judge: undefined });
    expect(await make(f.backend).judge(req('topic'))).toMatchObject({ decision: 'skip', error: { kind: 'unavailable' } });
  });

  it('the caller giving up is aborted, and skips even for a mention', async () => {
    const f = fakeBackend();
    f.answer(() => new Promise(() => undefined));
    const caller = new AbortController();
    const result = timed(make(f.backend).judge(req('mentioned', { signal: caller.signal })));
    await vi.advanceTimersByTimeAsync(100);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.value).toMatchObject({ decision: 'skip', error: { kind: 'aborted' }, ms: 100 });
    const gone = new AbortController();
    gone.abort();
    expect(await make(f.backend).judge(req('mentioned', { signal: gone.signal }))).toMatchObject({ decision: 'skip', error: { kind: 'aborted' } });
  });

  it('shutdown closes queued and running judgements, then waits for the backend calls', async () => {
    const f = fakeBackend();
    const pending: Deferred<JudgeCallOutput>[] = [];
    f.answer(() => { const d = deferred<JudgeCallOutput>(); pending.push(d); return d.promise; });
    const judge = make(f.backend);
    const results = Array.from({ length: 6 }, (_, i) => timed(judge.judge(req(i % 2 ? 'mentioned' : 'topic'))));
    await vi.advanceTimersByTimeAsync(0);
    let done = false;
    void judge.shutdown().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(results.map((r) => r.value?.error?.kind)).toEqual(Array(6).fill('closed'));
    expect(results.every((r) => r.value?.decision === 'skip')).toBe(true);
    expect(f.backend.judge).toHaveBeenCalledTimes(4);
    expect((await judge.judge(req('mentioned'))).error?.kind).toBe('closed');
    expect(done).toBe(false);
    for (const d of pending) d.reject(new Error('closed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    judge.warm('codex-appserver');
    expect(f.backend.listModels).toHaveBeenCalledTimes(1); // only the first judgement's
  });

  it('never rejects, even when backendFor throws', async () => {
    const judge = createJudge({ backendFor: () => { throw new Error('未知后端'); }, readPrompt: async () => ({ source: 'default', text: 'S', path: '/p' }) });
    const result: JudgeResult = await judge.judge(req('mentioned'));
    expect(result).toMatchObject({ decision: 'main', backend: 'codex-appserver', error: { kind: 'failed', detail: '未知后端' } });
  });
});
