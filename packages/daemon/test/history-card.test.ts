import { describe, expect, it } from 'vitest';
import { buildHistoryCard } from '../src/card/history-card';
import type { ThreadHistory, HistoryTurn } from '../src/agent/types';
import { weaveQuote, weaveRecordBlock, weaveSender } from '../src/bot/context-weave';

function turn(p: Partial<HistoryTurn>): HistoryTurn {
  return { userText: '', assistantText: '', reasoning: '', tools: [], ...p };
}

function findByTag(node: unknown, tag: string, acc: any[] = []): any[] {
  if (Array.isArray(node)) node.forEach((n) => findByTag(n, tag, acc));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.tag === tag) acc.push(o);
    for (const k of Object.keys(o)) findByTag(o[k], tag, acc);
  }
  return acc;
}

describe('buildHistoryCard', () => {
  it('renders nested per-turn panels + truncation note + budget guard', () => {
    const turns: HistoryTurn[] = [
      turn({ userText: '帮我加一个登录接口', assistantText: '已加 /login，支持密码登录。', reasoning: '先看现有路由结构…', tools: [{ title: 'rg "router"', exitCode: 0 }, { title: '编辑文件' }] }),
      turn({ userText: '给它写单测', assistantText: '加了 5 个用例，全绿。', tools: [{ title: 'npm test', failed: true, exitCode: 1 }] }),
      turn({ userText: '部署到 staging '.repeat(10), assistantText: 'X'.repeat(5000), reasoning: 'Y'.repeat(5000) }),
    ];
    const history: ThreadHistory = { turns, totalTurns: 12, name: 'login feature', preview: '帮我加登录接口', updatedAt: Math.floor(Date.now() / 1000) - 7200 };
    const card = buildHistoryCard({ cwd: '/home/user/projects/larkme', projectName: 'larkme', backendName: 'Codex', history });

    const json = JSON.stringify(card);
    // valid schema 2.0 shell
    expect((card as any).schema).toBe('2.0');
    // 3 top-level turn panels (nested detail panels live inside them)
    const elements = (card as any).body.elements as any[];
    const topPanels = elements.filter((e) => e.tag === 'collapsible_panel');
    expect(topPanels.length).toBe(3);
    // each is collapsed by default ("收拢状态")
    expect(topPanels.every((p) => p.expanded === false)).toBe(true);
    // NO "第 N 轮" round numbering anywhere
    expect(json).not.toMatch(/第\s*\d+\s*轮/);
    // collapsed title = the question only, one line (answer is revealed on expand)
    const firstTitle = topPanels[0].header.title.content as string;
    expect(firstTitle).toContain('👤');
    expect(firstTitle).not.toContain('🤖');
    expect(firstTitle.split('\n').length).toBe(1);
    // a long question is truncated with a trailing … in the collapsed title
    const bigTitle = topPanels[2].header.title.content as string;
    expect(bigTitle).toContain('…');
    // the answer still appears in the expanded body
    expect(json).toContain('🤖 Codex');
    // truncation note for the 9 dropped turns
    expect(json).toContain('更早的 9 轮');
    // "上次停在" shows the TAIL of the last reply, prefixed with … (more before)
    const leftOff = elements.find((e) => e.tag === 'markdown' && String(e.content).includes('上次停在'));
    expect(leftOff.content).toContain('：…');
    expect(json).toContain('会话已恢复');
    // nested detail panels exist (🔎 思考/工具)
    const allPanels = findByTag(card, 'collapsible_panel');
    expect(allPanels.length).toBeGreaterThan(3);
    expect(json).toContain('🔎');
    // failed tool marker
    expect(json).toContain('✗');
    // big turn truncated → whole card stays well under Feishu's ~30KB
    expect(json.length).toBeLessThan(30_000);
  });

  it('stays under Feishu ~30KB and degrades oldest turns when history is large', () => {
    const turns: HistoryTurn[] = Array.from({ length: 10 }, (_, i) =>
      turn({ userText: `第${i}个问题 `.repeat(40), assistantText: 'A'.repeat(2000), reasoning: 'R'.repeat(2000) }),
    );
    const card = buildHistoryCard({ cwd: '/x', backendName: 'Codex', history: { turns, totalTurns: 10 } });
    const json = JSON.stringify(card);
    expect(json.length).toBeLessThan(30_000); // hard Feishu limit
    expect(json).toContain('内容已省略'); // oldest turns degraded to title-only
    // newest turn must still be full (its assistant text present, not stubbed)
    const elements = (card as any).body.elements as any[];
    const lastPanel = elements.filter((e) => e.tag === 'collapsible_panel').at(-1);
    expect(JSON.stringify(lastPanel)).toContain('🤖 Codex');
  });

  it('handles empty history', () => {
    const card = buildHistoryCard({ cwd: '/x', backendName: 'Codex', history: { turns: [], totalTurns: 0 } });
    const json = JSON.stringify(card);
    expect(json).toContain('会话已恢复');
    expect(json).toContain('还没有可显示的历史');
  });

  it("names the group's own backend: a Claude group never reads Codex", () => {
    const turns = [turn({ userText: '记住暗号', assistantText: '记住了。' })];
    const card = buildHistoryCard({ cwd: '/x', backendName: 'Claude', history: { turns, totalTurns: 4 } });
    const json = JSON.stringify(card);
    expect(json).toContain('**🤖 Claude**');
    expect(json).toContain('更早的 3 轮 Claude 仍保留在上下文中');
    expect(json).not.toContain('Codex');
  });

  // M3 第 4 步：用户那一行露出了 weaveSender 的发信人标注，还多了一行只有标注的 👤。
  describe('the woven prompt shows only what the person typed', () => {
    const sender = { senderId: 'ou_secret_id', senderName: '张三' };
    const record = (text: string): string =>
      weaveRecordBlock(text, {
        place: { group: '验收群', me: 'Vonvon Bot 6' },
        entries: [{ messageId: 'om_old', senderName: '李四', text: '昨天的上文', createTime: 1, from: 'user' }],
        now: 2,
      });
    const quoted = { messageId: 'om_q', senderName: '王五', text: '被引用的话', createTime: 1, from: 'user' as const };
    const woven = record(weaveSender(weaveQuote('暗号是多少', quoted), sender, 5 * 60_000));
    const onlyEnvelope = record(weaveSender('', sender));
    const leaks = /open_id|ou_secret_id|本条消息的发信人|\[飞书 ·|\[\/飞书\]|昨天的上文|用户引用了|被引用的话|bot 断线重连/;

    function panels(history: ThreadHistory): any[] {
      const card = buildHistoryCard({ cwd: '/x', backendName: 'Claude', history });
      return ((card as any).body.elements as any[]).filter((e) => e.tag === 'collapsible_panel');
    }

    it('strips the record block, sender, late note and quote from the row and the title', () => {
      expect(woven).toMatch(leaks); // the fixture really carries every envelope
      const [panel] = panels({ turns: [turn({ userText: woven, assistantText: '是 42。' })], totalTurns: 1 });
      expect(panel.header.title.content).toBe('👤 暗号是多少');
      const json = JSON.stringify(panel);
      expect(json).toContain('**👤 你**\\n暗号是多少');
      expect(json).not.toMatch(leaks);
    });

    it('drops a row that was only the envelope, and its title is never a bare 👤', () => {
      const ps = panels({
        turns: [
          turn({ userText: onlyEnvelope, assistantText: '收到，看了上文。' }),
          turn({ userText: weaveSender('', sender) }),
        ],
        totalTurns: 2,
      });
      for (const p of ps) {
        const title = p.header.title.content as string;
        expect(title.replace(/👤/g, '').trim()).not.toBe('');
        expect(title).not.toMatch(leaks);
        expect(JSON.stringify(p)).not.toContain('👤 你');
        expect(p.elements.length).toBeGreaterThan(0); // no empty panel either
      }
      expect(ps[0].header.title.content).toBe('👤 （没有文字）');
      expect(JSON.stringify(ps[0])).toContain('收到，看了上文。');
    });

    it('上次停在 never falls back to the envelope', () => {
      const card = buildHistoryCard({
        cwd: '/x',
        backendName: 'Claude',
        history: { turns: [turn({ userText: onlyEnvelope })], totalTurns: 1 },
      });
      const json = JSON.stringify(card);
      expect(json).not.toMatch(leaks);
      expect(json).not.toContain('上次停在');

      const asked = buildHistoryCard({
        cwd: '/x',
        backendName: 'Claude',
        history: { turns: [turn({ userText: woven })], totalTurns: 1 },
      });
      const leftOff = ((asked as any).body.elements as any[]).find((e) => String(e.content ?? '').includes('上次停在'));
      expect(leftOff.content).toContain('暗号是多少');
      expect(JSON.stringify(asked)).not.toMatch(leaks);
    });
  });
});
