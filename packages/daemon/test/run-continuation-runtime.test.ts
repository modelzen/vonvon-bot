import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultCardDisplay } from '@vonvon/protocol';
import { fake, human, setup, thread, until, cardOpts } from './helpers/scheduled-run';
import { measureCard, DEFAULT_CARD_BUDGET } from '../src/card/card-budget';
import type { CardObject } from '../src/card/cards';

const json = (value: unknown): string => JSON.stringify(value);

function createdCards(): Array<{ id: string; replyTo?: string; replyInThread?: boolean; finalCard: CardObject }> {
  return fake.createCard.mock.calls.map((call, index) => {
    const id = `card-${String(index + 1)}`;
    const opts = call[3] as { replyTo?: string; replyInThread?: boolean } | undefined;
    const finalCard = (fake.finalizedByCard.get(id) ?? call[2]) as CardObject;
    return { id, replyTo: opts?.replyTo, replyInThread: opts?.replyInThread, finalCard };
  });
}

describe('runtime capacity-driven card continuation (#798)', () => {
  let current: Awaited<ReturnType<typeof setup>> | undefined;
  afterEach(async () => {
    await current?.orchestrator.shutdown();
    current = undefined;
  });

  it('rolls over long process across continuation cards in the same topic and keeps final answer whole on one card', async () => {
    current = await setup('multi');
    let cardSeq = 0;
    fake.createCard.mockImplementation(async () => `card-${String(++cardSeq)}`);

    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.backend.startThread.mockResolvedValue(run.t);

    await current.orchestrator.onMessage(human('执行长任务', 'topic-old'));
    await until(() => expect(run.consumed).toHaveLength(1));

    const totalCommands = 45;
    for (let i = 0; i < totalCommands; i += 1) {
      const cmd = `printf 'OP_${String(i)}_${'a'.repeat(700)}_END_${String(i)}'`;
      run.emit({ type: 'tool_use', itemId: `t_${String(i)}`, kind: 'command', title: cmd });
      run.emit({ type: 'tool_result', itemId: `t_${String(i)}`, output: `OUT_${String(i)}_OK`, exitCode: 0 });
    }

    // ~15 KB final answer: fits in an empty card, but won't fit alongside a full process card.
    const finalAnswer = Array.from(
      { length: 10 },
      (_, i) => `第 ${String(i + 1)} 项总结：${'完整报告段落内容'.repeat(60)}。`,
    ).join('\n\n');
    run.emit({ type: 'text_delta', itemId: 'final_answer', delta: finalAnswer });
    run.turns[0]!.resolve();

    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

    const cards = createdCards();
    expect(cards.length).toBeGreaterThanOrEqual(3);

    // Every continuation card stays in the same topic and chains off the previous card.
    for (let i = 1; i < cards.length; i += 1) {
      expect(cards[i]!.replyInThread).toBe(true);
      expect(cards[i]!.replyTo).toBe(cards[i - 1]!.id);
    }

    const allCardJsons = cards.map(c => json(c.finalCard));
    const combined = allCardJsons.join('\n');

    // No process omission anywhere, and every card respects Feishu size & component limits.
    expect(combined).not.toContain('项过程已省略');
    for (const c of cards) {
      const metrics = measureCard(c.finalCard);
      expect(metrics.bytes).toBeLessThanOrEqual(DEFAULT_CARD_BUDGET.maxBytes + 2_000);
      expect(metrics.components).toBeLessThanOrEqual(200);
    }

    // Every command and its result appear intact, exactly once, in original order.
    let lastPos = -1;
    for (let i = 0; i < totalCommands; i += 1) {
      const marker = `OP_${String(i)}_${'a'.repeat(700)}_END_${String(i)}`;
      expect(combined.split(marker)).toHaveLength(2);
      const pos = combined.indexOf(marker);
      expect(pos).toBeGreaterThan(lastPos);
      lastPos = pos;
      expect(combined).toContain(`OUT_${String(i)}_OK`);
    }

    // Final answer appears COMPLETELY in ONE card (the last card), never split!
    const cardsContainingFinalStart = allCardJsons.filter(s => s.includes('第 1 项总结：'));
    const cardsContainingFinalEnd = allCardJsons.filter(s => s.includes('第 10 项总结：'));
    expect(cardsContainingFinalStart).toHaveLength(1);
    expect(cardsContainingFinalEnd).toHaveLength(1);
    expect(allCardJsons.at(-1)).toContain('第 1 项总结：');
    expect(allCardJsons.at(-1)).toContain('第 10 项总结：');
  });

  it('acceptance example: moves a complete command to the continuation card when remaining space cannot hold it', async () => {
    current = await setup('multi');
    let cardSeq = 0;
    fake.createCard.mockImplementation(async () => `card-${String(++cardSeq)}`);

    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);

    await current.orchestrator.onMessage(human('跑一系列命令', 'topic-old'));
    await until(() => expect(run.consumed).toHaveLength(1));

    // Fill card 1 to near capacity (~21 KB of commands).
    for (let i = 0; i < 14; i += 1) {
      run.emit({ type: 'tool_use', itemId: `fill_${String(i)}`, kind: 'command', title: `echo FILL_${String(i)}_${'x'.repeat(1_000)}` });
      run.emit({ type: 'tool_result', itemId: `fill_${String(i)}`, output: 'done', exitCode: 0 });
    }
    // Emit one large complete command (~5 KB) that does not fit in card 1's remaining space.
    const specialCmd = `python3 -c 'print("SPECIAL_START_${'q'.repeat(4_800)}_SPECIAL_END")'`;
    run.emit({ type: 'tool_use', itemId: 'special', kind: 'command', title: specialCmd });
    run.emit({ type: 'tool_result', itemId: 'special', output: 'SPECIAL_OUT', exitCode: 0 });
    run.say('任务完成。');
    run.turns[0]!.resolve();

    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

    const cards = createdCards();
    expect(cards).toHaveLength(2);
    const card1 = json(cards[0]!.finalCard);
    const card2 = json(cards[1]!.finalCard);
    // Card 1 has no fragment of the special command; Card 2 has it whole + its output + the final reply (default #1).
    expect(card1).not.toContain('SPECIAL_START_');
    expect(card1).not.toContain('SPECIAL_END');
    expect(card2).toContain('SPECIAL_START_');
    expect(card2).toContain('_SPECIAL_END');
    expect(card2).toContain('SPECIAL_OUT');
    expect(card2).toContain('任务完成。');
  });

  it('splits a >30KB final answer at paragraph boundaries while keeping fenced code blocks intact', async () => {
    current = await setup('multi');
    let cardSeq = 0;
    fake.createCard.mockImplementation(async () => `card-${String(++cardSeq)}`);

    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);

    await current.orchestrator.onMessage(human('写长报告', 'topic-old'));
    await until(() => expect(run.consumed).toHaveLength(1));

    const p1 = `第一段：${'一二三四五六七八九十。'.repeat(600)}`;
    const code = `\`\`\`ts\n${'const sampleLine = "keep_code_block_intact";\n'.repeat(80)}\`\`\``;
    const p2 = `第二段：${'甲乙丙丁戊己庚辛壬癸。'.repeat(600)}`;
    const hugeReply = [p1, code, p2].join('\n\n');

    run.say(hugeReply);
    run.turns[0]!.resolve();

    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

    const cards = createdCards();
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const jsons = cards.map(c => json(c.finalCard));
    // Every card fits under Feishu's 30 KB limit.
    for (const c of cards) {
      expect(measureCard(c.finalCard).bytes).toBeLessThanOrEqual(28_000);
      expect(measureCard(c.finalCard).components).toBeLessThanOrEqual(200);
    }
    // Code block appears whole in one card (never split across two cards).
    const codeMatches = jsons.filter(s => s.includes('```ts') && s.includes('keep_code_block_intact'));
    expect(codeMatches).toHaveLength(1);
    expect(jsons.join('\n')).toContain('第一段：');
    expect(jsons.join('\n')).toContain('第二段：');
  });

  it('uploads an oversized single code block once as a Feishu attachment without duplicate uploads while streaming', async () => {
    current = await setup('multi');
    let cardSeq = 0;
    fake.createCard.mockImplementation(async () => `card-${String(++cardSeq)}`);

    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);

    await current.orchestrator.onMessage(human('生成超大代码', 'topic-old'));
    await until(() => expect(run.consumed).toHaveLength(1));

    const bodyLine = 'export const payload = "0123456789abcdef0123456789abcdef";\n';
    run.emit({ type: 'text_delta', itemId: 'ans', delta: '```ts\n' });
    // Stream in 4 chunks totaling >32 KB while still unclosed!
    for (let c = 0; c < 4; c += 1) {
      run.emit({ type: 'text_delta', itemId: 'ans', delta: bodyLine.repeat(160) });
    }
    // Close fence + trailing summary.
    run.emit({ type: 'text_delta', itemId: 'ans', delta: '```\n\n以上代码已生成。' });
    run.turns[0]!.resolve();

    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

    // Uploaded ONCE (not once per streaming delta!).
    expect(fake.fileCreate).toHaveBeenCalledTimes(1);
    expect(fake.fileCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ file_type: 'stream', file_name: 'code-1.ts' }),
    });
    const fileReplies = fake.reply.mock.calls.filter(c => (c[0] as { data?: { msg_type?: string } })?.data?.msg_type === 'file');
    expect(fileReplies).toHaveLength(1);
    expect((fileReplies[0]![0] as { data: { reply_in_thread: boolean } }).data.reply_in_thread).toBe(true);

    const cards = createdCards();
    const combined = cards.map(c => json(c.finalCard)).join('\n');
    expect(combined).toContain('code-1.ts');
    expect(combined).toContain('以上代码已生成。');
    for (const c of cards) {
      expect(measureCard(c.finalCard).bytes).toBeLessThanOrEqual(28_000);
    }
  });

  it('degrades gracefully when oversized attachment upload fails', async () => {
    current = await setup('multi');
    let cardSeq = 0;
    fake.createCard.mockImplementation(async () => `card-${String(++cardSeq)}`);
    fake.fileCreate.mockRejectedValue(new Error('permission denied'));

    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);

    await current.orchestrator.onMessage(human('超大命令', 'topic-old'));
    await until(() => expect(run.consumed).toHaveLength(1));

    const hugeCmd = `python3 -c "${'z'.repeat(28_000)}"`;
    run.emit({ type: 'tool_use', itemId: 'big', kind: 'command', title: hugeCmd });
    run.emit({ type: 'tool_result', itemId: 'big', output: 'ok', exitCode: 0 });
    run.say('处理完毕。');
    run.turns[0]!.resolve();

    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

    const cards = createdCards();
    const combined = cards.map(c => json(c.finalCard)).join('\n');
    expect(combined).toContain('附件发送失败');
    expect(combined).toContain('处理完毕。');
    for (const c of cards) {
      expect(measureCard(c.finalCard).bytes).toBeLessThanOrEqual(28_000);
    }
  });

  it('paginates long process and keeps final answer whole in completionOnly mode', async () => {
    const completionOnlyDisplay = { ...defaultCardDisplay(), reply: { streamText: false, collapseAfterRun: true } };
    current = await setup('multi', { preferences: { cardDisplay: completionOnlyDisplay } });
    fake.project!.presentation = { cardDisplay: completionOnlyDisplay };
    let cardSeq = 0;
    fake.createCard.mockImplementation(async () => `card-${String(++cardSeq)}`);

    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);

    await current.orchestrator.onMessage(human('非流式长任务', 'topic-old'));
    await until(() => expect(run.consumed).toHaveLength(1));

    for (let i = 0; i < 30; i += 1) {
      run.emit({ type: 'tool_use', itemId: `c_${String(i)}`, kind: 'command', title: `echo STEP_${String(i)}_${'b'.repeat(700)}` });
      run.emit({ type: 'tool_result', itemId: `c_${String(i)}`, output: 'ok', exitCode: 0 });
    }
    const answer = Array.from({ length: 8 }, (_, i) => `完成项 ${String(i + 1)}：${'结论正文'.repeat(80)}。`).join('\n\n');
    run.say(answer);
    // Still zero cards before completion!
    expect(fake.createCard).not.toHaveBeenCalled();

    run.turns[0]!.resolve();
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

    const cards = createdCards();
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const jsons = cards.map(c => json(c.finalCard));
    expect(jsons.join('\n')).not.toContain('项过程已省略');
    expect(jsons.at(-1)).toContain('完成项 1：');
    expect(jsons.at(-1)).toContain('完成项 8：');
  });

  it('composes capacity rollover with mid-run steer cleanly', async () => {
    current = await setup('multi');
    let cardSeq = 0;
    fake.createCard.mockImplementation(async () => `card-${String(++cardSeq)}`);

    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);

    await current.orchestrator.onMessage(human('先跑一批命令', 'topic-old'));
    await until(() => expect(run.consumed).toHaveLength(1));

    for (let i = 0; i < 20; i += 1) {
      run.emit({ type: 'tool_use', itemId: `s_${String(i)}`, kind: 'command', title: `echo PRE_${String(i)}_${'m'.repeat(900)}` });
      run.emit({ type: 'tool_result', itemId: `s_${String(i)}`, output: 'ok', exitCode: 0 });
    }
    await until(() => expect(fake.createCard.mock.calls.length).toBeGreaterThanOrEqual(2));

    const steer = human('改一下要求', 'topic-old');
    await current.orchestrator.onMessage(steer);
    await until(() => expect(run.t.steer).toHaveBeenCalled());
    await until(() => expect(fake.createCard.mock.calls.some(c => (c[3] as { replyTo?: string })?.replyTo === steer.messageId)).toBe(true));

    run.say('按补充要求完成。');
    run.turns[0]!.resolve();
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

    const cards = createdCards();
    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect(json(cards.at(-1)!.finalCard)).toContain('按补充要求完成。');
    expect(cardOpts(cards.length - 1)?.replyTo).toBe(steer.messageId);
  });

  it('auto-continues a long goal turn and chains the goal summary card after the last card', async () => {
    current = await setup('multi');
    let cardSeq = 0;
    fake.createCard.mockImplementation(async () => `card-${String(++cardSeq)}`);

    const run = thread();
    Object.assign(run.t, {
      runGoal: () => run.t.runStreamed({ text: 'goal' }),
      clearGoal: vi.fn(async () => undefined),
    });
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.backend.startThread.mockResolvedValue(run.t);

    await current.orchestrator.onMessage(human('/goal 执行长目标', 'topic-old'));
    await until(() => expect(run.consumed).toHaveLength(1));

    for (let i = 0; i < 26; i += 1) {
      run.emit({ type: 'tool_use', itemId: `g_${String(i)}`, kind: 'command', title: `echo GOAL_${String(i)}_${'g'.repeat(800)}` });
      run.emit({ type: 'tool_result', itemId: `g_${String(i)}`, output: 'ok', exitCode: 0 });
    }
    run.say('目标本轮完成。');
    run.turns[0]!.resolve();

    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'goal-final', expect.anything()));

    const cards = createdCards();
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const combined = cards.map(c => json(c.finalCard)).join('\n');
    expect(combined).not.toContain('项过程已省略');
    expect(combined).toContain('GOAL_0_');
    expect(combined).toContain('GOAL_25_');
    expect(combined).toContain('目标本轮完成。');
  });

  it('survives a transient continuation card creation failure and still delivers remaining content at terminal', async () => {
    current = await setup('multi');
    let cardSeq = 0;
    let failOnce = true;
    fake.createCard.mockImplementation(async () => {
      if (cardSeq === 1 && failOnce) {
        failOnce = false;
        throw new Error('transient 429');
      }
      return `card-${String(++cardSeq)}`;
    });

    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);

    await current.orchestrator.onMessage(human('测试瞬断恢复', 'topic-old'));
    await until(() => expect(run.consumed).toHaveLength(1));

    for (let i = 0; i < 24; i += 1) {
      run.emit({ type: 'tool_use', itemId: `r_${String(i)}`, kind: 'command', title: `echo RECOVER_${String(i)}_${'r'.repeat(850)}` });
      run.emit({ type: 'tool_result', itemId: `r_${String(i)}`, output: 'ok', exitCode: 0 });
    }
    run.say('恢复后的最终回复。');
    run.turns[0]!.resolve();

    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

    // At terminal, continuation card creation succeeds and delivers all items without losing the final reply.
    const finalizedJsons = [...fake.finalizedByCard.values()].map(c => json(c));
    expect(finalizedJsons.length).toBeGreaterThanOrEqual(2);
    const combined = finalizedJsons.join('\n');
    expect(combined).toContain('RECOVER_0_');
    expect(combined).toContain('RECOVER_23_');
    expect(combined).toContain('恢复后的最终回复。');
  });

  it('rolls over by component budget when many tiny commands exceed 180 tags even at small byte size', async () => {
    current = await setup('multi');
    let cardSeq = 0;
    fake.createCard.mockImplementation(async () => `card-${String(++cardSeq)}`);

    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);

    await current.orchestrator.onMessage(human('跑 55 个短命令', 'topic-old'));
    await until(() => expect(run.consumed).toHaveLength(1));

    for (let i = 0; i < 55; i += 1) {
      run.emit({ type: 'tool_use', itemId: `tiny_${String(i)}`, kind: 'command', title: `echo TINY_${String(i)}_END` });
      run.emit({ type: 'tool_result', itemId: `tiny_${String(i)}`, output: 'ok', exitCode: 0 });
    }
    run.say('全部短命令完成。');
    run.turns[0]!.resolve();

    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

    const cards = createdCards();
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const combined = cards.map(c => json(c.finalCard)).join('\n');
    expect(combined).not.toContain('项过程已省略');
    for (const c of cards) {
      expect(measureCard(c.finalCard).components).toBeLessThanOrEqual(200);
    }
    for (let i = 0; i < 55; i += 1) {
      expect(combined.split(`echo TINY_${String(i)}_END`)).toHaveLength(2);
    }
    expect(json(cards.at(-1)!.finalCard)).toContain('全部短命令完成。');
  });

  it('splits a >30KB single-paragraph final answer at complete sentence boundaries without breaking mid-sentence', async () => {
    current = await setup('multi');
    let cardSeq = 0;
    fake.createCard.mockImplementation(async () => `card-${String(++cardSeq)}`);

    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);

    await current.orchestrator.onMessage(human('输出单段超长正文', 'topic-old'));
    await until(() => expect(run.consumed).toHaveLength(1));

    const sentences = Array.from({ length: 320 }, (_, i) => `这是第${String(i + 1)}条完整结论说明，包含足够多的汉字以触发按完整句子换卡。`);
    // Stream in realistic chunks to test live sentence rollover too.
    for (let i = 0; i < sentences.length; i += 20) {
      run.emit({ type: 'text_delta', itemId: 'long_para', delta: sentences.slice(i, i + 20).join('') });
    }
    run.turns[0]!.resolve();

    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

    const cards = createdCards();
    expect(cards.length).toBeGreaterThanOrEqual(2);
    for (const c of cards) {
      expect(measureCard(c.finalCard).bytes).toBeLessThanOrEqual(28_000);
      expect(measureCard(c.finalCard).components).toBeLessThanOrEqual(200);
    }
    const combined = cards.map(c => json(c.finalCard)).join('\n');
    expect(combined).toContain('这是第1条完整结论说明');
    expect(combined).toContain('这是第320条完整结论说明');
    // Every single sentence must appear intact once (never torn mid-sentence across two cards).
    for (const sentence of sentences) {
      expect(combined.split(sentence)).toHaveLength(2);
    }
  });

  it('updates parallel in-flight tools on an earlier frozen card when their results arrive later', async () => {
    current = await setup('multi');
    let cardSeq = 0;
    fake.createCard.mockImplementation(async () => `card-${String(++cardSeq)}`);

    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);

    await current.orchestrator.onMessage(human('并发执行工具', 'topic-old'));
    await until(() => expect(run.consumed).toHaveLength(1));

    // Launch 26 parallel commands before any tool_result arrives, forcing card 1 to freeze in-flight tools.
    for (let i = 0; i < 26; i += 1) {
      run.emit({ type: 'tool_use', itemId: `par_${String(i)}`, kind: 'command', title: `echo PAR_${String(i)}_${'p'.repeat(850)}` });
    }
    await until(() => expect(fake.createCard.mock.calls.length).toBeGreaterThanOrEqual(2));

    // Now finish all 26 tools, including par_0 on frozen card 1.
    for (let i = 0; i < 26; i += 1) {
      run.emit({ type: 'tool_result', itemId: `par_${String(i)}`, output: `PAR_RES_${String(i)}`, exitCode: 0 });
    }
    run.say('并发全部完成。');
    run.turns[0]!.resolve();

    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

    const cards = createdCards();
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const combined = cards.map(c => json(c.finalCard)).join('\n');
    // par_0's command appears ONCE (not duplicated onto card 2) AND its result landed on card 1!
    expect(combined.split(`echo PAR_0_${'p'.repeat(850)}`)).toHaveLength(2);
    expect(json(cards[0]!.finalCard)).toContain('PAR_RES_0');
    expect(combined).toContain('PAR_RES_25');
    expect(combined).toContain('并发全部完成。');
  });
});
