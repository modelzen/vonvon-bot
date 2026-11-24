import { describe, expect, it, vi } from 'vitest';
import { defaultCardDisplay } from '@vonvon/protocol';
import { measureCard, DEFAULT_CARD_BUDGET } from '../src/card/card-budget';
import { buildRunCard, type RunCardState } from '../src/card/run-card';
import { initialState, reduce, type Block, type RunState } from '../src/card/run-state';
import {
  advanceDisplayCursor,
  blockKey,
  EMPTY_DISPLAY_CURSOR,
  sliceRunState,
} from '../src/card/run-segment';
import {
  planLiveRollover,
  planTerminalCards,
  sendOverflowAttachment,
  applyResolvedAttachmentsToBlocks,
} from '../src/bot/run-card-continuation';

function makeCommands(count: number, padLen = 600, output = 'ok'): Block[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: 'tool',
    tool: {
      id: `cmd_${String(i)}`,
      kind: 'command',
      title: `printf 'CMD_${String(i)}_${'x'.repeat(padLen)}_END_${String(i)}'`,
      status: 'done',
      output,
      exitCode: 0,
    },
  }));
}

describe('DisplayCursor segmentation', () => {
  it('advances across whole blocks and partial text offsets without duplication', () => {
    let state: RunState = { ...initialState, startedAt: 1 };
    state = reduce(state, { type: 'tool_use', itemId: 't1', title: 'echo one', kind: 'command' });
    state = reduce(state, { type: 'tool_result', itemId: 't1', output: 'one', exitCode: 0 });
    state = reduce(state, { type: 'text_delta', itemId: 'a', delta: 'Para1.\n\nPara2.' });

    const c1 = advanceDisplayCursor(EMPTY_DISPLAY_CURSOR, state, {
      completedBlocks: [state.blocks[0]!],
      nextStartedAt: 2,
    });
    const seg1 = sliceRunState(state, c1);
    expect(seg1.blocks).toHaveLength(1);
    expect(seg1.blocks[0]).toMatchObject({ kind: 'text', content: 'Para1.\n\nPara2.' });

    const c2 = advanceDisplayCursor(c1, seg1, {
      partialBlock: { key: 'text:a', kind: 'text', consumedChars: 'Para1.\n\n'.length },
      nextStartedAt: 3,
    });
    state = reduce(state, { type: 'text_delta', itemId: 'a', delta: '\n\nPara3.' });
    const seg2 = sliceRunState(state, c2);
    expect(seg2.blocks).toHaveLength(1);
    expect(seg2.blocks[0]).toMatchObject({ kind: 'text', content: 'Para2.\n\nPara3.' });

    // Reconciled full text snapshot slices off the already committed prefix cleanly.
    state = reduce(state, { type: 'text', itemId: 'a', text: 'Para1.\n\nPara2.\n\nPara3.' });
    expect(sliceRunState(state, c2).blocks[0]).toMatchObject({ kind: 'text', content: 'Para2.\n\nPara3.' });
  });
});

describe('planLiveRollover', () => {
  it('moves an overflowing command whole onto the continuation card', () => {
    const blocks = makeCommands(30, 800, 'result line');
    const rc: RunCardState = {
      rs: { ...initialState, startedAt: 1, blocks },
      unboundedProcess: true,
    };
    const plan = planLiveRollover(rc, DEFAULT_CARD_BUDGET);
    expect(plan.action).toBe('rollover_process');
    if (plan.action === 'rollover_process') {
      expect(plan.frozenBlocks.length).toBeGreaterThan(0);
      expect(plan.frozenBlocks.length).toBeLessThan(blocks.length);
      // Every frozen block fits cleanly when built as a frozen process card.
      const frozenCard = buildRunCard({
        ...rc,
        rs: { ...rc.rs, blocks: [...plan.frozenBlocks], terminal: 'done', footer: null },
        processOnly: true,
        continued: 'capacity',
        unboundedProcess: true,
      });
      const metrics = measureCard(frozenCard);
      expect(metrics.bytes).toBeLessThanOrEqual(DEFAULT_CARD_BUDGET.maxBytes);
      expect(metrics.components).toBeLessThanOrEqual(DEFAULT_CARD_BUDGET.maxComponents);
      expect(JSON.stringify(frozenCard)).not.toContain('项过程已省略');
      // Next command starts intact after frozenBlocks.
      const nextBlock = blocks[plan.frozenBlocks.length]!;
      expect(nextBlock.kind).toBe('tool');
      expect(JSON.stringify(frozenCard)).not.toContain(`CMD_${String(plan.frozenBlocks.length)}_`);
    }
  });

  it('freezes before an in-flight tool when settled blocks precede it', () => {
    const settled = makeCommands(15, 1_100, 'ok');
    const runningTool: Block = {
      kind: 'tool',
      tool: { id: 'live_tool', kind: 'command', title: `echo ${'y'.repeat(1_500)}`, status: 'running' },
    };
    const overflowTool: Block = {
      kind: 'tool',
      tool: { id: 'next_tool', kind: 'command', title: `echo ${'z'.repeat(8_000)}`, status: 'running' },
    };
    const rc: RunCardState = {
      rs: { ...initialState, startedAt: 1, blocks: [...settled, runningTool, overflowTool] },
      unboundedProcess: true,
    };
    const plan = planLiveRollover(rc, DEFAULT_CARD_BUDGET);
    expect(plan.action).toBe('rollover_process');
    if (plan.action === 'rollover_process') {
      expect(plan.frozenBlocks.every(b => b.kind !== 'tool' || b.tool.status !== 'running')).toBe(true);
      expect(plan.frozenBlocks.some(b => b.kind === 'tool' && b.tool.id === 'live_tool')).toBe(false);
    }
  });

  it('freezes process only and moves the whole streaming answer to a new card when process + answer overflows', () => {
    const processBlocks = makeCommands(12, 1_000, 'ok');
    const answerText = `最终答复开头。\n\n${'这是一段完整的回答正文。'.repeat(220)}`;
    const answerBlock: Block = { kind: 'text', id: 'final', content: answerText, streaming: true };
    const rc: RunCardState = {
      rs: { ...initialState, startedAt: 1, blocks: [...processBlocks, answerBlock] },
      unboundedProcess: true,
    };
    const plan = planLiveRollover(rc, DEFAULT_CARD_BUDGET);
    expect(plan.action).toBe('rollover_process');
    if (plan.action === 'rollover_process') {
      expect(plan.frozenBlocks).toEqual(processBlocks);
      expect(plan.completedBlocks).toEqual(processBlocks);
    }
  });

  it('marks an oversized running tool as streaming preview and uploads once finished', () => {
    const hugeCmd = `python3 -c "${'a'.repeat(28_000)}"`;
    const runningTool: Block = {
      kind: 'tool',
      tool: { id: 'big', kind: 'command', title: hugeCmd, status: 'running' },
    };
    const livePlan = planLiveRollover({
      rs: { ...initialState, startedAt: 1, blocks: [runningTool] },
      unboundedProcess: true,
    });
    expect(livePlan.action).toBe('mark_streaming_oversized');

    const doneTool: Block = {
      kind: 'tool',
      tool: { id: 'big', kind: 'command', title: hugeCmd, status: 'done', exitCode: 0 },
    };
    const donePlan = planLiveRollover({
      rs: { ...initialState, startedAt: 1, blocks: [doneTool] },
      unboundedProcess: true,
    });
    expect(donePlan.action).toBe('upload_oversized_inplace');
    if (donePlan.action === 'upload_oversized_inplace') {
      expect(donePlan.uploads).toHaveLength(1);
      expect(donePlan.uploads[0]!.key).toBe(blockKey(doneTool));
      expect(donePlan.uploads[0]!.raw).toContain(hugeCmd);
    }
  });
});

describe('planTerminalCards', () => {
  it('keeps small trailing process + final answer together on one combined card', () => {
    const blocks: Block[] = [
      ...makeCommands(2, 100, 'ok'),
      { kind: 'text', id: 'ans', content: '这是完整的最终答复。', streaming: false },
    ];
    const rc: RunCardState = {
      rs: { ...initialState, startedAt: 1, completedAt: 2000, terminal: 'done', footer: null, blocks },
      unboundedProcess: true,
    };
    const planned = planTerminalCards(rc);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.role).toBe('combined');
    expect(planned[0]!.answerText).toBe('这是完整的最终答复。');
  });

  it('places the full final answer intact on one new card when process + answer overflows but answer fits an empty card', () => {
    const processBlocks = makeCommands(14, 900, 'ok');
    // ~15 KB UTF-8 final answer: fits easily in a 26 KB empty card, but overflows with 14 commands.
    const answerText = Array.from({ length: 12 }, (_, i) => `第 ${String(i + 1)} 节结论：${'内容详述'.repeat(90)}。`).join('\n\n');
    const blocks: Block[] = [
      ...processBlocks,
      { kind: 'text', id: 'ans', content: answerText, streaming: false },
    ];
    const rc: RunCardState = {
      rs: { ...initialState, startedAt: 1, completedAt: 5000, terminal: 'done', footer: null, blocks },
      unboundedProcess: true,
    };
    const planned = planTerminalCards(rc);
    const processCards = planned.filter(c => c.role === 'process');
    const answerCards = planned.filter(c => c.role === 'answer');
    expect(processCards.length).toBeGreaterThanOrEqual(1);
    expect(processCards.at(-1)!.continued).toBe('answer');
    expect(answerCards).toHaveLength(1);
    expect(answerCards[0]!.answerText).toBe(answerText);
    expect(answerCards[0]!.answerOnly).toBe(true);
    expect(answerCards[0]!.continued).toBeUndefined();
  });

  it('splits a final answer exceeding one empty card at paragraph boundaries while keeping code blocks intact', () => {
    const p1 = `第一部分分析。\n\n${'甲乙丙丁。'.repeat(800)}`;
    const code = `\`\`\`ts\n${'export const value = 42;\n'.repeat(120)}\`\`\``;
    const p2 = `最后总结。\n\n${'戊己庚辛。'.repeat(800)}`;
    const answerText = [p1, code, p2].join('\n\n');
    const rc: RunCardState = {
      rs: {
        ...initialState,
        startedAt: 1,
        completedAt: 5000,
        terminal: 'done',
        footer: null,
        blocks: [{ kind: 'text', id: 'ans', content: answerText, streaming: false }],
      },
      unboundedProcess: true,
    };
    const planned = planTerminalCards(rc);
    expect(planned.length).toBeGreaterThanOrEqual(2);
    expect(planned.every(c => c.role === 'answer')).toBe(true);
    // The fenced code block must appear intact in exactly one card.
    const cardsWithCode = planned.filter(c => c.answerText.includes(code));
    expect(cardsWithCode).toHaveLength(1);
    // Every built card fits within budget.
    for (const item of planned) {
      const cardObj = buildRunCard({
        ...rc,
        rs: { ...rc.rs, blocks: [...item.blocks] },
        continued: item.continued,
        answerOnly: item.answerOnly,
        processOnly: item.processOnly,
        unboundedProcess: true,
      });
      const metrics = measureCard(cardObj);
      expect(metrics.bytes).toBeLessThanOrEqual(DEFAULT_CARD_BUDGET.maxBytes);
      expect(metrics.components).toBeLessThanOrEqual(DEFAULT_CARD_BUDGET.maxComponents);
    }
  });

  it('splits a final answer with >5 markdown tables so every card respects Feishu 5-table limit', () => {
    const tables = Array.from({ length: 7 }, (_, i) => [
      `## 表 ${String(i + 1)}`,
      '',
      '| 列1 | 列2 |',
      '| --- | --- |',
      `| A${String(i)} | B${String(i)} |`,
    ].join('\n')).join('\n\n');
    const rc: RunCardState = {
      rs: {
        ...initialState,
        startedAt: 1,
        completedAt: 3000,
        terminal: 'done',
        footer: null,
        blocks: [{ kind: 'text', id: 'ans', content: tables, streaming: false }],
      },
      unboundedProcess: true,
    };
    const planned = planTerminalCards(rc, DEFAULT_CARD_BUDGET);
    expect(planned).toHaveLength(2);
    let totalTables = 0;
    for (const item of planned) {
      const built = buildRunCard({
        ...rc,
        rs: { ...rc.rs, blocks: [...item.blocks] },
        continued: item.continued,
        answerOnly: item.answerOnly,
        unboundedProcess: true,
      });
      const count = measureCard(built).tables;
      expect(count).toBeLessThanOrEqual(5);
      totalTables += count;
    }
    expect(totalTables).toBe(7);
  });

  it('flags an oversized single code block in the final answer for attachment upload and keeps surrounding text', () => {
    const hugeCode = `\`\`\`json\n${'{"key":"value","nested":[1,2,3]}\n'.repeat(1_000)}\`\`\``;
    const answerText = `说明开头。\n\n${hugeCode}\n\n结尾补充。`;
    const rc: RunCardState = {
      rs: {
        ...initialState,
        startedAt: 1,
        completedAt: 3000,
        terminal: 'done',
        footer: null,
        blocks: [{ kind: 'text', id: 'ans', content: answerText, streaming: false }],
      },
      unboundedProcess: true,
    };
    const planned = planTerminalCards(rc);
    const uploads = planned.flatMap(c => c.oversized);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ kind: 'code_block', language: 'json', raw: hugeCode });

    // Resolving placeholders produces valid cards within budget.
    const settled = new Map([[uploads[0]!.key, {
      status: 'sent' as const,
      label: uploads[0]!.label,
      preview: uploads[0]!.preview,
      bytes: Buffer.byteLength(hugeCode, 'utf8'),
      fileName: 'code-1.json',
    }]]);
    const resolvedAll = planned
      .map(c => JSON.stringify(buildRunCard({
        ...rc,
        rs: { ...rc.rs, blocks: applyResolvedAttachmentsToBlocks(c.blocks, settled) },
        continued: c.continued,
        answerOnly: c.answerOnly,
        unboundedProcess: true,
      })))
      .join('\n');
    expect(resolvedAll).toContain('说明开头。');
    expect(resolvedAll).toContain('code-1.json');
    expect(resolvedAll).toContain('结尾补充。');
  });

  it('never leaks an intermediate progress text out of a processOnly frozen card', () => {
    const blocks: Block[] = [
      { kind: 'tool', tool: { id: 't1', kind: 'command', title: 'ls', status: 'done', output: 'a.ts' } },
      { kind: 'text', id: 'p1', content: '中间排查进展说明', streaming: false },
      { kind: 'tool', tool: { id: 't2', kind: 'command', title: 'pwd', status: 'done', output: '/repo' } },
    ];
    const cardObj = buildRunCard({
      rs: { ...initialState, startedAt: 1, completedAt: 2000, terminal: 'done', footer: null, blocks },
      processOnly: true,
      continued: 'capacity',
      unboundedProcess: true,
    });
    const body = (cardObj.body as { elements: Array<Record<string, unknown>> }).elements;
    // Process panel holds all three items; body outside the panel has only meter + panel + grey continuation note.
    const nonPanelTexts = body
      .filter(el => el.tag === 'markdown')
      .map(el => String(el.content ?? ''));
    expect(nonPanelTexts.join('\n')).not.toContain('中间排查进展说明');
    expect(nonPanelTexts.join('\n')).toContain('已达单卡容量，后续内容见下一张卡片');
  });

  it('respects cardDisplay hiding tools on done without emitting an empty process card', () => {
    const cardDisplay = {
      ...defaultCardDisplay(),
      blocks: defaultCardDisplay().blocks.map(b => (b.kind === 'tools' ? { ...b, mode: 'running' as const } : b)),
    };
    const blocks: Block[] = [
      ...makeCommands(30, 800, 'ok'),
      { kind: 'text', id: 'ans', content: '简洁最终答复。', streaming: false },
    ];
    const rc: RunCardState = {
      rs: { ...initialState, startedAt: 1, completedAt: 2000, terminal: 'done', footer: null, blocks },
      cardDisplay,
      unboundedProcess: true,
    };
    const planned = planTerminalCards(rc);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.role).toBe('combined');
  });
});

describe('sendOverflowAttachment', () => {
  it('uploads raw UTF-8 text and replies with a file message in thread', async () => {
    const fileCreate = vi.fn(async () => ({ file_key: 'fk_123' }));
    const msgReply = vi.fn(async () => ({ code: 0, data: { message_id: 'om_file', message_position: '42', chat_id: 'oc_1' } }));
    const channel = { rawClient: { im: { v1: { file: { create: fileCreate }, message: { reply: msgReply } } } } };

    const view = await sendOverflowAttachment(
      channel as never,
      { key: 'k1', kind: 'code_block', language: 'ts', raw: 'const a = 1;\n', label: 'ts 代码块', preview: '```ts\nconst a = 1;\n```' },
      { chatId: 'oc_1', replyTo: 'om_card', replyInThread: true, seq: 1 },
    );
    expect(view.status).toBe('sent');
    expect(view.fileName).toBe('code-1.ts');
    expect(view.messageLink).toContain('position=42');
    expect(fileCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ file_type: 'stream', file_name: 'code-1.ts' }),
    });
    expect(msgReply).toHaveBeenCalledWith({
      path: { message_id: 'om_card' },
      data: expect.objectContaining({
        msg_type: 'file',
        content: JSON.stringify({ file_key: 'fk_123' }),
        reply_in_thread: true,
      }),
    });
  });

  it('degrades gracefully when file upload fails', async () => {
    const fileCreate = vi.fn(async () => { throw new Error('missing im:resource'); });
    const msgReply = vi.fn();
    const channel = { rawClient: { im: { v1: { file: { create: fileCreate }, message: { reply: msgReply } } } } };

    const view = await sendOverflowAttachment(
      channel as never,
      { key: 'k2', kind: 'tool', raw: 'huge command', label: '该条命令', preview: 'preview' },
      { chatId: 'oc_1', replyTo: 'om_card', replyInThread: true, seq: 2 },
    );
    expect(view.status).toBe('failed');
    expect(view.error).toContain('missing im:resource');
    expect(msgReply).not.toHaveBeenCalled();
  });
});
