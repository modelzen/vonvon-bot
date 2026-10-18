import { describe, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { BackendNotInstalledError } from '../src/agent/backend-loader';
import { JudgeCallError, type JudgeCall } from '../src/agent/types';

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

const success = (extra: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', result: '{"decision":"main","reason":"文本"}',
  structured_output: { decision: 'topic', reason: '结构化' },
  usage: { input_tokens: 2, cache_creation_input_tokens: 510, cache_read_input_tokens: 1411, output_tokens: 293 }, ...extra,
}) as unknown as SDKMessage;

const failure = (errors: string[]) => ({ type: 'result', subtype: 'error_during_execution', errors }) as unknown as SDKMessage;
const assistantError = (error: string) => ({ type: 'assistant', error, message: { content: [] } }) as unknown as SDKMessage;

describe('Claude judge (design 3.3)', () => {
  it('runs one tool-less turn with the string system prompt, thinking off, and the schema', async () => {
    const { backend, query } = backendWith([success()]);
    const out = await backend.judge!(call());
    expect(out).toEqual({
      text: '{"decision":"main","reason":"文本"}', structured: { decision: 'topic', reason: '结构化' },
      usage: { input: 1923, cached: 1411, output: 293 },
    });
    const { prompt, options } = query.mock.calls[0]![0];
    expect(prompt).toBe('【群】g');
    expect(options).toMatchObject({
      cwd: '/data/judge', systemPrompt: 'SMART\n\n格式行', model: 'haiku', tools: [], skills: [], mcpServers: {}, strictMcpConfig: true,
      persistSession: false, maxTurns: 1, settingSources: ['user'], thinking: { type: 'disabled' },
      outputFormat: { type: 'json_schema', schema: SCHEMA },
      settings: { disableAllHooks: true, claudeMdExcludes: expect.arrayContaining(['**/.claude/CLAUDE.md']) },
    });
    expect(options).not.toHaveProperty('effort');
    expect(options?.env).toMatchObject({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
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
