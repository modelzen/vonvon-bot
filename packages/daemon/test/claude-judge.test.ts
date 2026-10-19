import { describe, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { BackendNotInstalledError } from '../src/agent/backend-loader';
import { JudgeCallError, type JudgeCall } from '../src/agent/types';
import { parseVerdict } from '../src/judge/prompt';

const SCHEMA = { type: 'object', properties: { decision: { type: 'string' } } };

/** A query yielding `messages`; `hold` keeps it open until the abort controller fires. */
function fakeQuery(messages: SDKMessage[], options: Options | undefined, hold = false) {
  const events: string[] = [];
  const generator = (async function* () {
    for (const message of messages) yield message;
    if (hold) {
      await new Promise<void>((resolve) => options?.abortController?.signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('aborted by the caller');
    }
  })() as unknown as Query & { close: ReturnType<typeof vi.fn> };
  generator.close = vi.fn(() => { events.push('close'); });
  return { query: generator, events };
}

function backendWith(messages: SDKMessage[], hold = false) {
  const made: ReturnType<typeof fakeQuery>[] = [];
  const query = vi.fn(({ options }: { prompt: string; options?: Options }) => {
    const q = fakeQuery(messages, options, hold);
    made.push(q);
    return q.query;
  });
  const sdk = { query } as unknown as ClaudeSdkFacade;
  return { backend: new ClaudeAgentBackend(async () => sdk, () => undefined), query, made };
}

const call = (extra: Partial<JudgeCall> = {}): JudgeCall => ({
  system: 'SMART\n\n格式行', input: '【群】g', model: 'haiku', schema: SCHEMA, cwd: '/data/judge', signal: new AbortController().signal, ...extra,
});

const USAGE = { input_tokens: 2, cache_creation_input_tokens: 510, cache_read_input_tokens: 1411, output_tokens: 293 };
const success = (extra: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', result: '{"decision":"main","reason":"文本"}',
  structured_output: { decision: 'topic', reason: '结构化' }, usage: USAGE, ...extra,
}) as unknown as SDKMessage;

const failure = (errors: string[]) => ({ type: 'result', subtype: 'error_during_execution', errors }) as unknown as SDKMessage;
const assistantError = (error: string) => ({ type: 'assistant', error, message: { content: [] } }) as unknown as SDKMessage;

describe('Claude judge (design 3.3)', () => {
  it('runs one tool-less turn with the string system prompt, thinking off, and the schema', async () => {
    const { backend, query } = backendWith([success()]);
    const out = await backend.judge!(call());
    expect(out).toEqual({
      text: '{"decision":"main","reason":"文本"}', structured: { decision: 'topic', reason: '结构化' },
      usage: { input: 1923, cached: 1411, output: 293, reasoning: 0 },
    });
    const { prompt, options } = query.mock.calls[0]![0];
    expect(prompt).toBe('【群】g');
    expect(options).toMatchObject({
      cwd: '/data/judge', systemPrompt: 'SMART\n\n格式行', title: 'vonvon judge', model: 'haiku', tools: [], skills: [], mcpServers: {}, strictMcpConfig: true,
      persistSession: false, maxTurns: 1, settingSources: ['user'], thinking: { type: 'disabled' },
      outputFormat: { type: 'json_schema', schema: SCHEMA },
      settings: { autoMemoryEnabled: false, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, disableAllHooks: true, claudeMdExcludes: expect.arrayContaining(['**/.claude/CLAUDE.md']) },
    });
    expect(options).not.toHaveProperty('effort');
    expect(options?.env).toMatchObject({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    expect(options?.settings).not.toHaveProperty('autoCompactEnabled');
    expect(options?.settings).not.toHaveProperty('env.DISABLE_AUTO_COMPACT');
  });

  it('tokens come from modelUsage, every model of the query, thinking included; usage only without it', async () => {
    const modelUsage = {
      'claude-haiku-5-5': { inputTokens: 2, cacheCreationInputTokens: 1258, cacheReadInputTokens: 1035, outputTokens: 300, thinkingTokens: 190 },
      'claude-other': { inputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 10, outputTokens: 20, thinkingTokens: 0 },
    };
    const withModels = backendWith([success({ modelUsage })]);
    expect((await withModels.backend.judge!(call())).usage).toEqual({ input: 2310, cached: 1045, output: 320, reasoning: 190 });
    const usageOnly = backendWith([success({ usage: { ...USAGE, output_tokens_details: { thinking_tokens: 7 } } })]);
    expect((await usageOnly.backend.judge!(call())).usage).toEqual({ input: 1923, cached: 1411, output: 293, reasoning: 7 });
  });

  // e12: 13 of 137 judgements had haiku answer in text, without the StructuredOutput tool
  const assistantText = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text }] } }) as unknown as SDKMessage;
  const maxTurns = { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (1)'], usage: USAGE } as unknown as SDKMessage;

  it.each([
    ['main', '```json\n{"decision":"skip","reason":"张三是@王五约时间，与小码无关，不需要插话"}\n```', 'skip'],
    ['topic', '{"decision":"reply","reason":"张三在问迁移期间缓存抖动的降级方案，属于小码可协助的技术问题，群里暂无人答。"}', 'reply'],
    ['mentioned', '{"decision":"topic","reason":"点名要查线上500日志，需要排查和多轮来回，开新话题更合适"}', 'topic'],
  ] as const)('error_max_turns with a %s answer in text: the last text goes to parseVerdict', async (variant, text, decision) => {
    const { backend } = backendWith([assistantText('先想一下'), { type: 'user', message: { content: [] } } as unknown as SDKMessage, assistantText(text), maxTurns]);
    const out = await backend.judge!(call());
    expect(out).toEqual({ text, usage: { input: 1923, cached: 1411, output: 293, reasoning: 0 } });
    expect(parseVerdict(variant, out)).toMatchObject({ decision });
  });

  it('error_max_turns without any text, or with an assistant error code, still fails', async () => {
    const bare = backendWith([{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '…' }] } } as unknown as SDKMessage, maxTurns]);
    await expect(bare.backend.judge!(call())).rejects.toMatchObject({ kind: 'failed', message: 'Reached maximum number of turns (1)' });
    const coded = backendWith([assistantError('rate_limit'), assistantText('{"decision":"skip","reason":"x"}'), maxTurns]);
    await expect(coded.backend.judge!(call())).rejects.toMatchObject({ kind: 'quota', structured: true });
  });

  it('a chosen effort is passed and thinking is left to it', async () => {
    const { backend, query } = backendWith([success()]);
    await backend.judge!(call({ effort: 'low' }));
    const { options } = query.mock.calls[0]![0];
    expect(options).toMatchObject({ effort: 'low' });
    expect(options).not.toHaveProperty('thinking');
  });

  it('classifies failures: assistant error codes are structured, text alone is not', async () => {
    const cases: Array<[SDKMessage[], string, boolean]> = [
      [[assistantError('rate_limit'), failure(['API Error: 429'])], 'quota', true],
      [[assistantError('authentication_failed'), failure(['Invalid API key'])], 'auth', true],
      [[assistantError('model_not_found'), failure(['model: nope'])], 'model', true],
      [[failure(['invalid credential from gateway'])], 'auth', false],
      [[failure(['something odd'])], 'failed', false],
      [[], 'failed', false],
    ];
    for (const [messages, kind, structured] of cases) {
      const { backend, made } = backendWith(messages);
      const error = await backend.judge!(call()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JudgeCallError);
      expect(error).toMatchObject({ kind, structured });
      expect(made[0]!.query.close).toHaveBeenCalledTimes(1);
    }
  });

  it('a success result with is_error is an API error: the assistant code is structured, the text alone is not', async () => {
    const apiError = (text: string) => success({ is_error: true, result: text, structured_output: undefined });
    const cases: Array<[SDKMessage[], string, boolean]> = [
      [[assistantError('rate_limit'), apiError("You've hit your limit")], 'quota', true],
      [[assistantError('authentication_failed'), apiError('Invalid API key · Please run /login')], 'auth', true],
      [[apiError("You've hit your usage limit")], 'quota', false],
      [[apiError('Invalid API key · Please run /login')], 'auth', false],
      [[apiError('')], 'failed', false],
    ];
    for (const [messages, kind, structured] of cases) {
      const { backend } = backendWith(messages);
      const error = await backend.judge!(call()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JudgeCallError);
      expect(error).toMatchObject({ kind, structured });
    }
  });

  it('account, verification, request and unknown codes fall back to the text and never cool', async () => {
    // claudeJudgeError: only codes that stop the whole machine or model are structured
    const cases: Array<[string, string, string]> = [
      ['account_on_hold', 'Your account is on hold', 'failed'],
      ['verification_required', 'Please verify your account', 'failed'],
      ['invalid_request', 'prompt is too long', 'failed'],
      ['unknown', 'something odd', 'failed'],
      ['account_on_hold', 'Please login again', 'auth'],
    ];
    for (const [code, text, kind] of cases) {
      const { backend } = backendWith([assistantError(code), failure([text])]);
      const error = await backend.judge!(call()).catch((e: unknown) => e);
      expect(error).toMatchObject({ kind, structured: false });
    }
  });

  it('on abort: the SDK controller aborts, close() is called, and the promise settles after it', async () => {
    const { backend, query, made } = backendWith([], true);
    const ctl = new AbortController();
    let settledAfter: string[] | undefined;
    const pending = backend.judge!(call({ signal: ctl.signal })).catch((e: unknown) => {
      settledAfter = [...made[0]!.events];
      return e;
    });
    await vi.waitFor(() => expect(query).toHaveBeenCalled());
    const sdkSignal = query.mock.calls[0]![0].options!.abortController!.signal;
    expect(sdkSignal.aborted).toBe(false);
    ctl.abort(new Error('timeout'));
    expect(sdkSignal.aborted).toBe(true);
    expect(await pending).toBeInstanceOf(JudgeCallError);
    expect(settledAfter).toEqual(['close']);
  });

  it('a call aborted before the query starts no CLI', async () => {
    const { backend, query } = backendWith([], true);
    const ctl = new AbortController();
    ctl.abort();
    await expect(backend.judge!(call({ signal: ctl.signal }))).rejects.toMatchObject({ kind: 'aborted' });
    expect(query).not.toHaveBeenCalled();
  });

  it('without the SDK the judgement is unavailable', async () => {
    const backend = new ClaudeAgentBackend(async () => { throw new BackendNotInstalledError('@anthropic-ai/claude-agent-sdk'); }, () => undefined);
    await expect(backend.judge!(call())).rejects.toMatchObject({ kind: 'unavailable', structured: false });
  });
});
