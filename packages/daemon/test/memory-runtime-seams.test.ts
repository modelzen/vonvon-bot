import { describe, expect, it, vi } from 'vitest';
import { assemble, contextOf, planTurnUpdate, type ContextSources } from '../src/bot/context-assembly';
import { MEMORY_FULL_NOTICE, extractHiddenBlocks, noteMissedBlocks, takeMemoryNotices } from '../src/bot/hidden-blocks';
import { parseRole } from '../src/bot/role-files';
import type { SessionContext } from '../src/bot/session-store';
import { settleTurn } from '../src/bot/turn-usage';

vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));

const sources = (): ContextSources => ({
  place: { kind: 'group', chatId: 'chat', chatName: '测试群' }, botName: '小测', soul: '## 身份与职责\n测试助手', role: parseRole('## 身份与职责\n测试助手'),
  supplement: '', failed: {},
});

describe('seams between the context assembly and the hidden blocks', () => {
  it('the transition block of a session without memory tools carries the hidden-block instructions under the new mark', async () => {
    const src = sources();
    const update = await planTurnUpdate(src, assemble(src), undefined, 1, { hiddenBlocks: true });
    const nonce = /标记 ([0-9a-f]+) ·/.exec(update.text!)![1]!;
    expect(update.context.nonce).toBe(nonce);
    expect(update.text).toContain(`n="${nonce}"`);
    expect(update.text).toContain('claim="asked"');
    const claude = await planTurnUpdate(src, assemble(src), undefined, 1);
    expect(claude.text).not.toContain('claim="asked"');
    // a redelivery after a compaction rotates the mark and says it again under the new one
    const again = await planTurnUpdate(src, assemble(src), { ...update.context, fullRedeliverDue: true }, 2, { hiddenBlocks: true });
    expect(again.context.nonce).not.toBe(nonce);
    expect(again.text).toContain(`n="${again.context.nonce}"`);
    expect(again.text).not.toContain(`n="${nonce}"`);
  });

  it('puts the notices of the last turn into the next update, once, even when nothing else changed', async () => {
    const src = sources();
    const delivered = contextOf(assemble(src), 'abc123', 1);
    noteMissedBlocks('s1', ['memory-full', 'bad-nonce']);
    const update = await planTurnUpdate(src, assemble(src), delivered, 2, { notices: takeMemoryNotices('s1') });
    expect(update.text).toContain('标记 abc123');
    expect(update.text).toContain(MEMORY_FULL_NOTICE);
    expect(update.text).toContain('标记不对');
    expect(takeMemoryNotices('s1')).toEqual([]);
    expect((await planTurnUpdate(src, assemble(src), delivered, 2, { notices: takeMemoryNotices('s1') })).text).toBeUndefined();
  });
});

describe('usage markers the stream filter took out', () => {
  it('settles from found.mem when the final text no longer has the marker', () => {
    const context: SessionContext = { versions: {}, nonce: 'abc123', memory: { project: { storeId: 'p', branches: [], items: { e1: ['h', '决定', 1] } } } };
    const { text, found } = extractHiddenBlocks('周四。\n<vonvon-mem n="abc123" used="e1,e2"/>');
    expect(text).toBe('周四。');
    const settled = settleTurn(context, text, 5, found.mem);
    expect(settled.used).toEqual(['e1']);
    expect(settled.context.lastTurn).toEqual({ at: 5, injected: 1, used: ['e1'] });
    expect(settleTurn(context, text, 5, extractHiddenBlocks('<vonvon-mem n="forged" used="e1"/>').found.mem).used).toEqual([]);
  });
});
