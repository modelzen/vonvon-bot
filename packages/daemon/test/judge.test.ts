import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderProcessCleanupError } from '../src/agent/owned-process';
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

const ANSWER: JudgeCallOutput = { text: '{"decision":"topic","reason":"新的事"}', usage: { input: 10, cached: 2, output: 3, reasoning: 1 } };

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
  it('gives the anchor as the message id of the line it numbers; m0 or a number past the lines shown names nothing (s25b)', async () => {
    const f = fakeBackend();
    let anchor = 'm1';
    f.answer(async () => ({ text: '', structured: { decision: 'topic', anchor, reason: '' } }));
    const judge = make(f.backend);
    const context = [{ id: 'om_old', at: 0, from: 'user' as const, name: '张三', text: '导出接口 500 有人看吗' }, { id: 'om_new', at: 1, from: 'user' as const, name: '李四', text: '我也遇到了' }];
    const ask = () => judge.judge(req('main', { context, message: { id: 'om_msg', at: 2, from: 'user', name: '张三', text: '是生产环境' } }));
    const first = await ask();
    expect(first).toMatchObject({ decision: 'topic', anchor: 'om_new', reason: '' });
    expect(first.error).toBeUndefined();
    expect(fake.log.info.mock.calls.find((c) => c[1] === 'verdict')![2]).toMatchObject({ anchor: 'om_new'.slice(-6) });
    anchor = 'm2';
    expect((await ask()).anchor).toBe('om_old');
    for (const none of ['m0', 'm3']) {
      anchor = none;
      const result = await ask();
      expect(result).toMatchObject({ decision: 'topic' });
      expect(result).not.toHaveProperty('anchor');
    }
    expect(fake.log.info.mock.calls.filter((c) => c[1] === 'anchor-invalid')).toHaveLength(1);
    expect(f.calls[0]!.schema).toHaveProperty('properties.anchor');
  });

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
    expect(verdict).toMatchObject({ ref: '123456', decision: 'topic', inputTokens: 10, cachedTokens: 2, outputTokens: 3, reasoningTokens: 1 });
    // never the text, the reason or the prompt
    expect(JSON.stringify(fake.log.info.mock.calls)).not.toMatch(/新的事|你好|SMART/);
  });

  it('falls back by variant: a mention replies in main, the rest skip', async () => {
    const kinds: JudgeErrorKind[] = ['auth', 'quota', 'version', 'model', 'network', 'failed', 'unavailable'];
    for (const kind of kinds) {
      const f = fakeBackend();
      // not structured, so no cooldown repeats the first failure (judge-cooldown.test.ts)
      f.answer(async () => { throw new JudgeCallError(kind, `boom ${kind}\nsecond line`, false); });
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

    // the default timeout for a mention is 12 s (e12)
    const def = timed(make(f.backend).judge(req('mentioned')));
    await vi.advanceTimersByTimeAsync(11_999);
    expect(def.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(def.at).toBe(1_000_000 + 1_500 + 12_000);

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

  it('logs a cleanup failure of a call it already gave up on, which the result could not report', async () => {
    const f = fakeBackend();
    const failure = new ProviderProcessCleanupError('Claude 子进程树已退出，但清理失败', { cause: new AggregateError([new Error('Claude process group required SIGKILL')]) });
    const after = (error: unknown) => (call: JudgeCall) => new Promise<JudgeCallOutput>((_, reject) => {
      call.signal.addEventListener('abort', () => setTimeout(() => reject(error), 100), { once: true });
    });
    const judge = make(f.backend);
    f.answer(after(failure));
    const timedOut = timed(judge.judge(req('main', { timeoutMs: 1_000 })));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(timedOut.value).toMatchObject({ error: { kind: 'timeout' } });
    expect(fake.log.fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.log.fail.mock.calls).toEqual([['judge', failure, { phase: 'abandoned-call', backend: 'codex-appserver' }]]);

    // what an abandoned call usually throws is not a fault
    fake.log.fail.mockClear();
    f.answer(after(new Error('The operation was aborted')));
    void judge.judge(req('main', { timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(fake.log.fail).not.toHaveBeenCalled();

    // before the judgement gave up, the failure is its result, logged once as a failed judgement
    f.answer(async () => { throw failure; });
    expect(await judge.judge(req('main'))).toMatchObject({ error: { kind: 'failed', detail: 'Claude 子进程树已退出，但清理失败' } });
    expect(fake.log.fail).not.toHaveBeenCalled();
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

  it('a stored effort the backend does not take counts as unset and is logged once as setting-ignored', async () => {
    const f = fakeBackend({ id: 'claude-agent', displayName: 'Claude' });
    const judge = make(f.backend);
    const bad = { kind: 'llm', backend: 'claude-agent', model: 'sonnet', effort: 'minimal' } as const;
    const ask = () => judge.judge(req('main', { group: { chatId: 'oc_g', name: '群', backend: 'claude-agent', judge: bad as never } }));
    expect(await ask()).toMatchObject({ modelSource: 'default' });
    expect(await ask()).toMatchObject({ modelSource: 'default' });
    expect(f.calls[0]).not.toHaveProperty('effort');
    expect(f.calls[0]!.model).not.toBe('sonnet');
    const ignored = fake.log.warn.mock.calls.filter((c) => c[1] === 'setting-ignored');
    expect(ignored).toEqual([['judge', 'setting-ignored', { layer: 'oc_g', why: '推理强度这个后端不收' }]]);
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

  it("judges with the group's backend, Codex for one not in the catalog (s25)", async () => {
    const f = fakeBackend();
    const backendFor = vi.fn(() => f.backend);
    const result = make(f.backend, { backendFor }).judge(req('main', { group: { chatId: 'oc_g', name: '群', backend: 'gone-backend' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(backendFor).toHaveBeenCalledWith('codex-appserver');
    expect(await result).toMatchObject({ backend: 'codex-appserver' });
  });

  it('never rejects, even when backendFor throws', async () => {
    const judge = createJudge({ backendFor: () => { throw new Error('未知后端'); }, readPrompt: async () => ({ source: 'default', text: 'S', path: '/p' }) });
    const result: JudgeResult = await judge.judge(req('mentioned'));
    expect(result).toMatchObject({ decision: 'main', backend: 'codex-appserver', error: { kind: 'failed', detail: '未知后端' } });
  });
});

describe('decision models (s23f)', () => {
  const KEY = 'ts_TESTKEY0000';
  const JEV = { kind: 'decision', provider: 'typesafe', model: 'jev-latest' } as const;
  /** Jev's answer to a request: `best` at 0.7 (its first option by default), the rest sharing 0.3. */
  const answerTo = (init: RequestInit, best?: string, extra: Record<string, unknown> = {}): Response => {
    const options = Object.keys(JSON.parse(init.body as string).questions.decision.criteria as object);
    const top = best ?? options[0]!;
    const probabilities = Object.fromEntries(options.map((o) => [o, o === top ? 0.7 : 0.3 / (options.length - 1)]));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { decision: { type: 'choice', choice: top, probabilities }, ...extra }, usage: { input_tokens: 1200, output_tokens: 30 } }),
      { status: 200, headers: { 'x-typesafe-request-id': 'req_1' } });
  };
  function jev(key: () => Promise<string | undefined> = async () => KEY) {
    const f = fakeBackend();
    const sent: RequestInit[] = [];
    let respond: (init: RequestInit) => Promise<Response> | Response = (init) => answerTo(init);
    const fetchFn = vi.fn(async (_: unknown, init?: RequestInit) => { sent.push(init!); return respond(init!); });
    const getSecret = vi.fn(key);
    const judge = make(f.backend, { getSecret, fetch: fetchFn as unknown as typeof fetch });
    return { judge, backend: f.backend, sent, fetchFn, getSecret, respond(fn: typeof respond) { respond = fn; } };
  }
  const jreq = (variant: JudgeVariant = 'main', extra: Partial<JudgeRequest> = {}) => req(variant, { botJudge: JEV, ...extra });
  const logged = () => JSON.stringify([fake.log.info.mock.calls, fake.log.warn.mock.calls, fake.log.fail.mock.calls]);
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

  it('judges with the provider, not the backend: the reason and confidence from the probabilities, the version and tokens logged', async () => {
    const j = jev();
    j.respond((init) => answerTo(init, 'reply'));
    const result = await j.judge.judge(jreq('topic', { topicTitle: '发版' }));
    expect(result).toEqual({
      decision: 'reply', reason: 'Jev：不回 0.30、回 0.70（把握度 0.40）', confidence: 0.4, backend: 'codex-appserver', model: 'jev-latest', provider: 'typesafe',
      modelSource: 'bot', promptSource: 'bot', ms: 0,
    });
    expect(j.backend.judge).not.toHaveBeenCalled();
    expect(j.backend.listModels).not.toHaveBeenCalled();
    expect(j.getSecret).toHaveBeenCalledWith('typesafe-api-key');
    expect(j.fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(j.sent[0]!.body as string)).toMatchObject({ model: 'jev-latest', state: { topic_title: '发版', new_message: { text: '你好' } }, questions: { decision: { instructions: { rules: 'SMART' } } } });
    expect(fake.log.info.mock.calls.find((c) => c[1] === 'verdict')![2]).toMatchObject({
      provider: 'typesafe', model: 'jev-latest', decision: 'reply', confidence: 0.4, providerModel: 'jev-1.13.0', requestId: 'req_1', inputTokens: 1200, outputTokens: 30,
    });
    expect(logged()).not.toMatch(/TESTKEY|你好|SMART|Jev：/);
  });

  it('opens a topic under the anchor Jev picks, as the message id of its m-number', async () => {
    const j = jev();
    j.respond((init) => answerTo(init, 'topic', { anchor: { type: 'choice', choice: 'm2' } }));
    const context = [{ id: 'om_old', at: 0, from: 'user' as const, name: '张三', text: '导出接口 500 有人看吗' }, { id: 'om_new', at: 1, from: 'bot' as const, name: '小码', text: '我看下' }];
    expect(await j.judge.judge(jreq('main', { context }))).toMatchObject({ decision: 'topic', anchor: 'om_old' });
  });

  it('without a key sends nothing and falls back by variant, each time, logged as info; a key that is no key likewise', async () => {
    const j = jev(async () => undefined);
    expect(await j.judge.judge(jreq('main'))).toMatchObject({ decision: 'skip', provider: 'typesafe', error: { kind: 'key', detail: '没填 TypeSafe 的 key' } });
    expect(await j.judge.judge(jreq('mentioned'))).toMatchObject({ decision: 'main', error: { kind: 'key' } });
    expect(fake.log.info.mock.calls.filter((c) => c[1] === 'failed')).toHaveLength(2);
    expect(fake.log.warn).not.toHaveBeenCalled();
    const bad = jev(async () => `${KEY}\n`);
    expect(await bad.judge.judge(jreq('topic'))).toMatchObject({ decision: 'skip', error: { kind: 'key', detail: 'TypeSafe 的 key 不是一串可见字符，重新填一次' } });
    expect(j.fetchFn).not.toHaveBeenCalled();
    expect(bad.fetchFn).not.toHaveBeenCalled();
    expect(logged()).not.toContain('TESTKEY');
  });

  it('a keystore it cannot read fails with a fixed detail, none of its own words', async () => {
    const j = jev(async () => { throw Object.assign(new Error('Master key must be owned by the current user: /home/u/master.key'), { code: 'EACCES' }); });
    expect(await j.judge.judge(jreq('mentioned'))).toMatchObject({ decision: 'main', error: { kind: 'failed', detail: '密钥库读不了' } });
    expect(fake.log.warn.mock.calls.find((c) => c[1] === 'keystore-unreadable')![2]).toMatchObject({ provider: 'typesafe', code: 'EACCES' });
    expect(logged()).not.toMatch(/Master key|master\.key/);
    expect(j.fetchFn).not.toHaveBeenCalled();
  });

  it('a provider this version does not know is unavailable: no quiet switch to the small model', async () => {
    const j = jev();
    expect(await j.judge.judge(jreq('mentioned', { botJudge: { ...JEV, provider: 'openai' } }))).toMatchObject({
      decision: 'main', provider: 'openai', error: { kind: 'unavailable', detail: '这个版本不认识决策模型 openai' },
    });
    expect(j.fetchFn).not.toHaveBeenCalled();
    expect(j.backend.judge).not.toHaveBeenCalled();
  });

  it('logs a failure by status and error type only, and an answer out of format by why', async () => {
    const j = jev();
    j.respond(() => json(401, { detail: { error_type: 'authentication_error', message: 'Cannot authenticate 群消息' } }, { 'x-typesafe-request-id': 'req_2' }));
    expect(await j.judge.judge(jreq('main'))).toMatchObject({ decision: 'skip', error: { kind: 'auth', detail: 'TypeSafe 不认这个 key' } });
    expect(fake.log.warn.mock.calls.find((c) => c[1] === 'decision-error')![2]).toEqual({
      chatId: 'oc_g', ref: '123456', variant: 'main', provider: 'typesafe', model: 'jev-latest', kind: 'auth', status: 401, errorType: 'authentication_error', requestId: 'req_2', coolMs: 300_000, ms: 0,
    });
    const html = jev();
    html.respond(() => new Response('<html>群消息</html>', { status: 200 }));
    expect(await html.judge.judge(jreq('main'))).toMatchObject({ error: { kind: 'format', detail: '决策模型没按格式回答' } });
    const shape = jev();
    shape.respond(() => json(200, { answers: { decision: { choice: 'skip' } } }));
    expect(await shape.judge.judge(jreq('main'))).toMatchObject({ error: { kind: 'format', detail: '决策模型没按格式回答' } });
    expect(fake.log.info.mock.calls.find((c) => c[1] === 'decision-bad-answer')![2]).toMatchObject({ provider: 'typesafe', why: 'no-probabilities' });
    expect(logged()).not.toMatch(/群消息|Cannot authenticate|你好/);
  });

  it('runs 8 at a time with 32 queued per provider, refuses the 41st as busy, and gives each slot on as a call settles', async () => {
    const j = jev();
    const pending: Array<() => void> = [];
    j.respond((init) => new Promise((resolve) => pending.push(() => resolve(answerTo(init)))));
    const results = Array.from({ length: 40 }, () => j.judge.judge(jreq('main')));
    await vi.waitFor(() => expect(pending).toHaveLength(8));
    expect(await j.judge.judge(jreq('mentioned'))).toMatchObject({ decision: 'main', error: { kind: 'busy', detail: '判断排队满了' } });
    for (let round = 0; round < 5; round++) {
      await vi.waitFor(() => expect(pending).toHaveLength(8));
      for (const release of pending.splice(0)) release();
    }
    expect((await Promise.all(results)).every((r) => !r.error && r.decision === 'skip')).toBe(true);
    expect(j.fetchFn).toHaveBeenCalledTimes(40);
  });

  it('its own 5 s is network; the judgement\'s timeout, queueing included, is timeout and sends no queued request', async () => {
    const j = jev();
    j.respond(() => new Promise(() => undefined));
    const one = timed(j.judge.judge(jreq('mentioned')));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(one.value).toMatchObject({ decision: 'main', error: { kind: 'network', detail: 'TypeSafe 5 秒没回' } });
    const running = Array.from({ length: 8 }, () => timed(j.judge.judge(jreq('main', { timeoutMs: 4_000 }))));
    const queued = timed(j.judge.judge(jreq('main', { timeoutMs: 2_000 })));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(queued.value).toMatchObject({ decision: 'skip', error: { kind: 'timeout' } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(running.map((r) => r.value?.error?.kind)).toEqual(Array(8).fill('timeout'));
    expect(j.fetchFn).toHaveBeenCalledTimes(1 + 8);
    expect(fake.log.warn.mock.calls.filter((c) => c[1] === 'decision-error')).toHaveLength(1);
  });

  it('a 429 cools the whole provider for its retry-after; a model it does not have cools only that model', async () => {
    const j = jev();
    j.respond(() => json(429, {}, { 'retry-after': '90' }));
    expect(await j.judge.judge(jreq('main'))).toMatchObject({ decision: 'skip', error: { kind: 'busy', detail: 'TypeSafe 限流了' } });
    j.respond((init) => answerTo(init));
    const other = { group: { chatId: 'oc_g', name: '群', backend: 'codex-appserver', judge: { ...JEV, model: 'jev-preview' } } };
    expect(await j.judge.judge(jreq('mentioned', other))).toMatchObject({ decision: 'main', error: { kind: 'busy', detail: '不到 1 分钟前刚失败过，2 分钟内不再调' } });
    expect(j.fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect((await j.judge.judge(jreq('main'))).error).toBeUndefined();

    j.respond(() => json(400, { detail: { error_type: 'api_usage_error', message: 'Unknown model: jev-preview' } }));
    expect((await j.judge.judge(jreq('main', other))).error).toMatchObject({ kind: 'model', detail: 'TypeSafe 没有这个模型' });
    j.respond((init) => answerTo(init));
    expect((await j.judge.judge(jreq('main', other))).error?.kind).toBe('model');
    expect((await j.judge.judge(jreq('main'))).error).toBeUndefined();
    expect(j.fetchFn).toHaveBeenCalledTimes(4);
  });

  it('a key it refused cools 5 minutes, but a key changed meanwhile is tried at once', async () => {
    let key = KEY;
    const j = jev(async () => key);
    j.respond(() => json(401, { detail: { error_type: 'authentication_error' } }));
    expect((await j.judge.judge(jreq('main'))).error?.kind).toBe('auth');
    j.respond((init) => answerTo(init));
    expect((await j.judge.judge(jreq('main'))).error).toMatchObject({ kind: 'auth', detail: '不到 1 分钟前刚失败过，5 分钟内不再调' });
    expect(j.fetchFn).toHaveBeenCalledTimes(1);
    key = 'ts_NEWKEY0000';
    expect((await j.judge.judge(jreq('main'))).error).toBeUndefined();
    expect(j.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('shutdown aborts the requests in flight and resolves once they settle', async () => {
    const j = jev();
    const signals: AbortSignal[] = [];
    j.respond((init) => new Promise((_, reject) => {
      signals.push(init.signal!);
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const results = [timed(j.judge.judge(jreq('main'))), timed(j.judge.judge(jreq('mentioned')))];
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    let done = false;
    void j.judge.shutdown().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(results.map((r) => [r.value?.decision, r.value?.error?.kind])).toEqual([['skip', 'closed'], ['skip', 'closed']]);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(done).toBe(true);
    expect(fake.log.warn.mock.calls.filter((c) => c[1] === 'decision-error')).toHaveLength(0);
  });
});
