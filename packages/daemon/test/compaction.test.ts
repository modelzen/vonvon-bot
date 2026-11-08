import { claudeAccess } from '../src/agent/claude-agent/permission';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mapNotification } from '../src/agent/codex-appserver/event-map';
import type { ServerNotification } from '../src/agent/codex-appserver/protocol';
import { AUTO_COMPACT_SETTINGS, ClaudeAgentThread } from '../src/agent/claude-agent/thread';
import type { AgentEvent } from '../src/agent/types';
import { buildRunCard } from '../src/card/run-card';
import { RunRender } from '../src/card/run-render';
import { buildProcessBody } from '../src/card/run-process';
import { runSegment } from '../src/card/run-segment';
import { initialState, reduce, type Block, type RunState } from '../src/card/run-state';

// s12: both backends compact on their own; the run card opens with the context
// meter and shows one process line per compaction.

const W = 200_000;
const usage = (used: number, window: number | null = W): AgentEvent => ({ type: 'context_usage', usedTokens: used, contextWindow: window });
const run = (events: AgentEvent[], from: RunState = initialState): RunState => events.reduce(reduce, from);
const markers = (s: RunState) => s.blocks.filter((b): b is Extract<Block, { kind: 'compaction' }> => b.kind === 'compaction').map(b => b.compaction);
const elements = (s: RunState) => (buildRunCard({ rs: s }).body as { elements: Array<Record<string, unknown>> }).elements;
const meterText = (s: RunState) => (elements(s)[0] as { text: { content: string } }).text.content;
const cardJson = (s: RunState) => JSON.stringify(buildRunCard({ rs: s }));

/** Codex app-server notifications, mapped exactly as the backend does. */
const codex = (method: string, params: unknown): AgentEvent => mapNotification({ method, params } as ServerNotification)!;
const codexUsage = (last: number) => codex('thread/tokenUsage/updated', { threadId: 'th', turnId: 't', tokenUsage: { total: { totalTokens: 9e6 }, last: { totalTokens: last }, modelContextWindow: W } });
const item = { type: 'contextCompaction', id: 'cc-1' };
const codexStart = () => codex('item/started', { threadId: 'th', turnId: 't', item });
const codexEnd = () => codex('item/completed', { threadId: 'th', turnId: 't', item });
const codexLegacy = () => codex('thread/compacted', { threadId: 'th', turnId: 't' });

describe('the context meter heads every run card', () => {
  it('shows a placeholder before any reading, then the latest reading, running and terminal', () => {
    expect(meterText(initialState)).toBe('上下文 —');
    const live = run([usage(86_000)]);
    expect(meterText(live)).toBe('上下文 43% · 86k/200k');
    expect(meterText(run([{ type: 'text', itemId: 'a', text: 'ANSWER' }, { type: 'done', turnId: 't' }], live))).toBe('上下文 43% · 86k/200k');
  });

  it('starts from the session\'s last reading, and the turn\'s own reading replaces it', () => {
    const render = new RunRender();
    render.seedUsage({ used: 120_000, window: W });
    render.seedUsage({ used: 1, window: W }); // only the first seed counts
    expect(meterText(render.snapshot())).toBe('上下文 60% · 120k/200k');
    render.apply(usage(150_000));
    expect(meterText(render.snapshot())).toBe('🟡 上下文 75% · 150k/200k');
  });
});

describe('Codex compaction line', () => {
  it('writes before → after from the readings around the contextCompaction item', () => {
    // Before: the request that crossed the limit. During: the summarization
    // request (old history, higher) then the recomputed estimate (lower).
    const s = run([codexUsage(170_000), codexStart(), codexUsage(172_000), codexUsage(40_000), codexEnd(), codexLegacy()]);
    expect(markers(s)).toHaveLength(1); // thread/compacted repeats the item's end
    expect(cardJson(s)).toContain('已压缩 85% → 20%');
    expect(meterText(s)).toBe('上下文 20% · 40k/200k');
  });

  it('shows the compaction while it runs', () => {
    expect(cardJson(run([codexUsage(170_000), codexStart()]))).toContain('正在压缩上下文…');
  });

  it('a compaction whose item never completes reads as unfinished on the terminal card', () => {
    // codex-rs completes the item only after installing the compacted history;
    // its failure paths return before item/completed.
    for (const end of [{ type: 'error', message: '上游错误', willRetry: false }, { type: 'done', turnId: 't' }] as AgentEvent[]) {
      const json = cardJson(run([codexUsage(170_000), codexStart(), end]));
      expect(json).toContain('上下文压缩没有完成');
      expect(json).not.toContain('已压缩');
    }
  });

  it('without a recomputed reading, takes the first reading after the end', () => {
    const s = run([codexUsage(170_000), codexStart(), codexUsage(172_000), codexEnd()]);
    expect(cardJson(s)).toContain('已压缩，压缩前 85%');
    expect(cardJson(run([codexUsage(50_000), codexUsage(60_000)], s))).toContain('已压缩 85% → 25%');
  });

  it('never shows an after that is not lower than before', () => {
    const s = run([codexUsage(170_000), codexStart(), codexUsage(172_000), codexEnd(), codexUsage(180_000), codexUsage(20_000)]);
    expect(cardJson(s)).toContain('已压缩，压缩前 85%');
    expect(cardJson(s)).not.toContain('→');
  });

  it('takes before from the first reading during it when the run had none yet', () => {
    expect(cardJson(run([codexStart(), codexUsage(170_000), codexUsage(40_000), codexEnd()]))).toContain('已压缩 85% → 20%');
  });

  it('a thread/compacted with no item makes its own line, one per compaction', () => {
    const s = run([codexUsage(170_000), codexLegacy(), codexUsage(40_000), codexUsage(150_000), codexLegacy()]);
    expect(markers(s)).toHaveLength(2);
    expect(cardJson(s)).toContain('已压缩，现在 20%');
  });

  it('keeps the line in the collapsed process panel at terminal, and the meter on top', () => {
    const s = run([codexUsage(170_000), codexStart(), codexUsage(40_000), codexEnd(), { type: 'text', itemId: 'a', text: 'ANSWER' }, { type: 'done', turnId: 't' }]);
    const els = elements(s);
    expect(JSON.stringify(els[0])).toContain('上下文 20%');
    expect(els[1]).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(JSON.stringify(els[1])).toContain('已压缩 85% → 20%');
  });

  it('the line is never dropped when the process is over the card budget', () => {
    const big = (i: number): Block => ({ kind: 'text', id: `t${i}`, content: `STEP_${i}：${'中'.repeat(4000)}`, streaming: false });
    const blocks: Block[] = [big(0), ...run([codexUsage(170_000), codexStart(), codexUsage(40_000), codexEnd()]).blocks, ...Array.from({ length: 60 }, (_, i) => big(i + 1))];
    blocks.push({ kind: 'compaction', compaction: { id: 'late', status: 'done', before: { used: 180_000, window: W }, after: { used: 30_000, window: W } } });
    const json = JSON.stringify(buildProcessBody(blocks));
    expect(json).toContain('项过程已省略');
    expect(json).toContain('已压缩 85% → 20%');
    expect(json).toContain('已压缩 90% → 15%');
  });

  it('an unfinished compaction carries across a steer split', () => {
    const boundary = run([codexUsage(170_000), codexStart()]);
    const next = runSegment(run([codexUsage(40_000), codexEnd()], boundary), boundary, 1);
    expect(markers(next)).toMatchObject([{ status: 'done' }]);
    expect(cardJson(next)).toContain('已压缩 85% → 20%');
    const done = run([codexUsage(40_000), codexEnd()], boundary);
    expect(runSegment(run([{ type: 'text', itemId: 'a', text: 'more' }], done), done).blocks.map(b => b.kind)).toEqual(['text']);
  });
});

describe('Claude compaction line and meter, through the real thread and mapper', () => {
  const threads: ClaudeAgentThread[] = [];
  afterEach(async () => { await Promise.all(threads.splice(0).map(t => t.close())); });
  const m = (value: unknown) => value as SDKMessage;
  const assistant = (id: string, inputTokens: number) => m({
    type: 'assistant', parent_tool_use_id: null, session_id: 's',
    message: { id, role: 'assistant', usage: { input_tokens: 10, cache_read_input_tokens: inputTokens - 10, cache_creation_input_tokens: 0, output_tokens: 3 }, content: [{ type: 'tool_use', id: `tool-${id}`, name: 'Bash', input: { command: 'ls' } }] },
  });
  const turn = [
    m({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-4-5' }),
    assistant('msg-1', 170_000),
    m({ type: 'system', subtype: 'status', status: 'compacting', session_id: 's' }),
    m({ type: 'system', subtype: 'compact_boundary', session_id: 's', compact_metadata: { trigger: 'auto', pre_tokens: 170_000, post_tokens: 40_000 } }),
    m({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: 's' }),
    assistant('msg-2', 44_000),
    m({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }),
  ];

  it('forces auto-compaction on, and shows the line and a moving meter', async () => {
    let options: Options | undefined;
    const thread = new ClaudeAgentThread({
      sessionId: 's', resume: false, cwd: process.cwd(), access: claudeAccess(undefined, undefined, process.cwd(), process.cwd()), permission: {}, settingSources: [],
      query: ({ prompt, options: given }) => {
        options = given;
        return Object.assign((async function* () { for await (const _ of prompt) yield* turn; })(), {
          getContextUsage: async () => ({ totalTokens: 46_000, maxTokens: W }),
          interrupt: async () => {}, close: () => {},
        }) as unknown as Query;
      },
    });
    threads.push(thread);
    expect(options?.settings).toEqual(AUTO_COMPACT_SETTINGS);
    expect(AUTO_COMPACT_SETTINGS).toEqual({ autoCompactEnabled: true, autoMemoryEnabled: false,
      env: { DISABLE_AUTO_COMPACT: '', DISABLE_COMPACT: '', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CRON: '1' }, skillOverrides: { loop: 'off', schedule: 'off' } });

    const render = new RunRender();
    const meters: string[] = [];
    for await (const ev of thread.runStreamed({ text: 'go' }).events) {
      render.apply(ev);
      if (ev.type === 'context_usage' || ev.type === 'compaction') meters.push(meterText(render.snapshot()));
    }
    const s = render.snapshot();
    expect(markers(s)).toMatchObject([{ status: 'done' }]);
    expect(cardJson(s)).toContain('已压缩 85% → 20%');
    // mid-turn reading, the drop at the boundary, the next request, getContextUsage()
    expect(meters).toEqual(['🟠 上下文 85% · 170k/200k', '🟠 上下文 85% · 170k/200k', '上下文 20% · 40k/200k', '上下文 22% · 44k/200k', '上下文 23% · 46k/200k']);
  });

  it('on a thread\'s first turn, the compaction line uses the window getContextUsage() reports, not a guess', async () => {
    // A model id once read as 200k here while the real window was 1M; the first
    // reading now asks Claude Code instead.
    const firstTurn = [
      m({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-4-7' }),
      assistant('msg-1', 600_000),
      m({ type: 'system', subtype: 'status', status: 'compacting', session_id: 's' }),
      m({ type: 'system', subtype: 'compact_boundary', session_id: 's', compact_metadata: { trigger: 'auto', pre_tokens: 600_000, post_tokens: 150_000 } }),
      assistant('msg-2', 155_000),
      m({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }),
    ];
    const thread = new ClaudeAgentThread({
      sessionId: 's', resume: false, cwd: process.cwd(), access: claudeAccess(undefined, undefined, process.cwd(), process.cwd()), permission: {}, settingSources: [],
      query: ({ prompt }) => Object.assign((async function* () { for await (const _ of prompt) yield* firstTurn; })(), {
        getContextUsage: async () => ({ totalTokens: 160_000, maxTokens: 1_000_000 }),
        interrupt: async () => {}, close: () => {},
      }) as unknown as Query,
    });
    threads.push(thread);
    const render = new RunRender();
    let midTurn = '';
    for await (const ev of thread.runStreamed({ text: 'go' }).events) {
      render.apply(ev);
      if (ev.type === 'compaction' && ev.phase === 'end') midTurn = cardJson(render.snapshot());
    }
    expect(midTurn).toContain('已压缩 60% → 15%');
    const s = render.snapshot();
    expect(meterText(s)).toBe('上下文 16% · 160k/1000k');
    expect(cardJson(s)).toContain('已压缩 60% → 15%');
  });

  // One turn of two requests, no compaction; the fake answers getContextUsage() with `read`.
  const plainTurn = (model: string) => [
    m({ type: 'system', subtype: 'init', session_id: 's', model }),
    assistant('msg-1', 100_000),
    assistant('msg-2', 120_000),
    m({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }),
  ];
  const meteredThread = (turn: SDKMessage[], read: () => Promise<unknown>, extra: Record<string, unknown> = {}) => {
    const thread = new ClaudeAgentThread({
      sessionId: 's', resume: false, cwd: process.cwd(), access: claudeAccess(undefined, undefined, process.cwd(), process.cwd()), permission: {}, settingSources: [],
      model: 'opus',
      query: ({ prompt }) => Object.assign((async function* () { for await (const _ of prompt) yield* turn; })(), {
        getContextUsage: read, interrupt: async () => {}, close: () => {}, ...extra,
      }) as unknown as Query,
    });
    threads.push(thread);
    return thread;
  };
  const meters = async (thread: ClaudeAgentThread, turn?: { model: string }) => {
    const render = new RunRender();
    const out: string[] = [];
    for await (const ev of thread.runStreamed({ text: 'go' }, turn).events) {
      render.apply(ev);
      if (ev.type === 'context_usage') out.push(meterText(render.snapshot()));
    }
    return out;
  };

  it('the first reading of a thread already shows the window Claude Code reports, read once', async () => {
    // 0.10.0: claude-opus-5-5 showed 200k until the turn ended, on a host whose
    // settings set autoCompactWindow 400k (the model's own window is 1M).
    const read = vi.fn(async () => ({ totalTokens: 125_000, maxTokens: 400_000 }));
    const thread = meteredThread(plainTurn('claude-opus-5-5'), read);
    expect(await meters(thread)).toEqual(['上下文 25% · 100k/400k', '上下文 30% · 120k/400k', '上下文 31% · 125k/400k']);
    expect(read).toHaveBeenCalledTimes(2); // the first reading's, and the turn end's
  });

  it('when the read fails the readings show tokens only, without retrying each one', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('control request failed'))
      .mockResolvedValue({ totalTokens: 125_000, maxTokens: 400_000 });
    const thread = meteredThread(plainTurn('claude-opus-5-5'), read);
    expect(await meters(thread)).toEqual(['上下文 已用 100k', '上下文 已用 120k', '上下文 31% · 125k/400k']);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a read that never answers lets the turn go on after the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const read = vi.fn()
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValue({ totalTokens: 125_000, maxTokens: 400_000 });
      const thread = meteredThread(plainTurn('claude-opus-5-5'), read);
      const done = meters(thread);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await done).toEqual(['上下文 已用 100k', '上下文 已用 120k', '上下文 31% · 125k/400k']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a turn on another model reads its window again', async () => {
    let model = 'opus';
    const windows: Record<string, number> = { opus: 400_000, haiku: 200_000 };
    const read = vi.fn(async () => ({ totalTokens: 125_000, maxTokens: windows[model]! }));
    const thread = meteredThread(plainTurn('claude-opus-5-5'), read, { setModel: async (next: string) => { model = next; } });
    expect((await meters(thread))[0]).toBe('上下文 25% · 100k/400k');
    expect((await meters(thread, { model: 'haiku' }))[0]).toBe('上下文 50% · 100k/200k');
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('a later reading moves the run\'s compaction lines onto its window; one with no window leaves them', () => {
    const s = run([usage(170_000), { type: 'compaction', phase: 'start' }, { type: 'compaction', phase: 'end', preTokens: 170_000, postTokens: 40_000, contextWindow: W }]);
    expect(cardJson(s)).toContain('已压缩 85% → 20%');
    expect(cardJson(run([usage(50_000, 400_000)], s))).toContain('已压缩 43% → 10%');
    expect(cardJson(run([usage(50_000, null)], s))).toContain('已压缩 85% → 20%');
  });

  it('a failed compaction says so', () => {
    expect(cardJson(run([usage(170_000), { type: 'compaction', phase: 'start' }, { type: 'compaction', phase: 'end', failed: true }]))).toContain('上下文压缩失败');
  });
});
