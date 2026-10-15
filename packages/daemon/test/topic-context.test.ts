import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../src/core/logger';
import type { ContextMessage } from '../src/bot/context-weave';
import { createNameBook } from '../src/bot/names';
import { createTopicContext, personOf, topicQuotes, topicRows, type QuoteWindow } from '../src/bot/topic-context';
import { createTopicRegistry, type TopicView } from '../src/bot/topic-registry';

const names = createNameBook({} as LarkChannel);
names.remember('ou_li', '李四');
const view = (topicId: string, openedAt: number, extra: Partial<TopicView> = {}): TopicView =>
  ({ topicId, openedAt, lastAt: openedAt, sessions: [], openedBy: { kind: 'user', openId: 'ou_li' }, ...extra });
const session = (key: string) => ({ key, sessionId: `s-${key}`, backend: 'codex' });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('topicQuotes', () => {
  it('takes the topics opened in the window, up to the trigger', () => {
    const ts = [view('omt_a', 5), view('omt_b', 6), view('omt_c', 10), view('omt_d', 11)];
    const ids = (w: QuoteWindow) => topicQuotes(ts, w, names).quotes.map((q) => q.topicId);
    expect(ids({ after: 5, to: 10 })).toEqual(['omt_b', 'omt_c']);
    expect(ids({ from: 5, to: 10 })).toEqual(['omt_a', 'omt_b', 'omt_c']);
    expect(ids({ from: 0, to: 10, exclude: 'omt_b', skip: (t) => t.topicId === 'omt_a' })).toEqual(['omt_c']);
  });

  it('keeps the newest 10, oldest first, and counts the rest', () => {
    const { quotes, more } = topicQuotes(Array.from({ length: 13 }, (_, i) => view(`omt_${i}`, 100 - i)), { from: 0, to: 1000 }, names);
    expect(more).toBe(3);
    expect(quotes.map((q) => q.at)).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
  });

  it("names a session only from the same tier's binding", () => {
    const t = view('omt_a', 5, { sessions: [session('omt_a'), session('omt_a#admin'), session('omt_a#guest')] });
    const sid = (tier?: 'admin' | 'guest') => topicQuotes([t], { from: 0, to: 9, tier }, names).quotes[0]!.sessionId;
    expect([sid(), sid('admin'), sid('guest')]).toEqual(['s-omt_a', 's-omt_a#admin', 's-omt_a#guest']);
    const adminOnly = view('omt_b', 5, { sessions: [session('omt_b#admin')] });
    expect(topicQuotes([adminOnly], { from: 0, to: 9, tier: 'guest' }, names).quotes[0]).not.toHaveProperty('sessionId');
    expect(topicQuotes([adminOnly], { from: 0, to: 9 }, names).quotes[0]).not.toHaveProperty('sessionId');
  });

  it('names who opened it and the message it hangs under', () => {
    const t = view('omt_a', 5, { title: '订单', firstId: 'om_r', firstAt: 3, firstFrom: { kind: 'self' }, lastAt: 8 });
    expect(topicQuotes([t], { from: 0, to: 9 }, names).quotes).toEqual([
      { topicId: 'omt_a', title: '订单', at: 5, who: { kind: 'user', name: '李四' }, root: { id: 'om_r', at: 3, who: { kind: 'self' } } },
    ]);
    expect(topicRows([t], undefined, names)[0]).toMatchObject({ topicId: 'omt_a', lastAt: 8 });
    expect([personOf({ kind: 'user', openId: 'ou_abcd9999' }, names), personOf({ kind: 'bot', openId: 'ou_p' }, names), personOf(undefined, names)])
      .toEqual([{ kind: 'user', name: '用户9999' }, { kind: 'bot', name: undefined }, undefined]);
  });
});

describe('createTopicContext', () => {
  const ctxOn = (im: object, topics?: ReturnType<typeof createTopicRegistry>) =>
    createTopicContext({ rawClient: { im: { v1: im } } } as unknown as LarkChannel, topics, names, { stopping: () => false, track: (p) => p });

  it('reads a topic group from chat_mode or group_message_type, and keeps the answer', async () => {
    const data: Record<string, object> = { oc_t: { chat_mode: 'topic' }, oc_m: { chat_mode: 'group', group_message_type: 'thread' }, oc_n: { chat_mode: 'group', group_message_type: 'chat' } };
    const get = vi.fn(async ({ path }: { path: { chat_id: string } }) => ({ code: 0, data: data[path.chat_id] }));
    const ctx = ctxOn({ chat: { get } });
    expect([await ctx.noMainArea('oc_t'), await ctx.noMainArea('oc_m'), await ctx.noMainArea('oc_n'), await ctx.noMainArea('oc_t')]).toEqual([true, true, false, true]);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('takes a group it cannot read as a normal one, and asks again after 10 minutes', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const denied = { code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:chat:readonly]' };
    const get = vi.fn(async () => { throw Object.assign(new Error('Request failed'), { response: { status: 400, data: denied } }); });
    const ctx = ctxOn({ chat: { get } });
    expect([await ctx.noMainArea('oc_123456789'), await ctx.noMainArea('oc_123456789')]).toEqual([false, false]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('intake', 'chat-mode-unknown', { chatId: '456789', reason: 'missing-scope', scope: 'im:chat:readonly' });
    vi.advanceTimersByTime(10 * 60_000 + 1);
    await ctx.noMainArea('oc_123456789');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('records a topic another bot opened under a main-area line, looking each up once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'topics-'));
    try {
      const topics = createTopicRegistry({ dir, sessions: async () => [] });
      const items = [{ message_id: 'om_p', create_time: '7000', sender: { id: 'cli_p', id_type: 'app_id', sender_type: 'app', sender_name: '小P', open_bot_id: 'ou_p' } }];
      const list = vi.fn(async () => ({ code: 0, data: { items } }));
      const ctx = ctxOn({ message: { list } }, topics);
      const root: ContextMessage = { messageId: 'om_root', senderName: '张三', senderId: 'ou_z', text: '订单接口一直报 500', from: 'user', createTime: 5000, threadId: 'omt_a' };
      const plain: ContextMessage = { ...root, messageId: 'om_x', threadId: undefined };
      const found = await ctx.discover('chat', [plain, root, { ...root, messageId: 'om_k', threadId: 'omt_known' }], new Set(['omt_known']));
      expect(found).toEqual([expect.objectContaining({
        topicId: 'omt_a', openedBy: { kind: 'bot', openId: 'ou_p' }, openedAt: 7000,
        firstId: 'om_root', firstFrom: { kind: 'user', openId: 'ou_z' }, firstAt: 5000, title: '订单接口一直报 500', sessions: [],
      })]);
      expect(await topics.get('chat', 'omt_a')).toMatchObject({ openedBy: { kind: 'bot', openId: 'ou_p' } });
      expect(names.peek('ou_p')).toBe('小P');
      // Asked again with a list read before it was recorded: the same topic, no second request.
      expect(await ctx.discover('chat', [root], new Set())).toEqual(found);
      expect(list).toHaveBeenCalledTimes(1);
      // A failed lookup records nothing and is not tried again.
      list.mockRejectedValueOnce(new Error('down'));
      const other = { ...root, messageId: 'om_b', threadId: 'omt_b' };
      expect(await ctx.discover('chat', [other], new Set())).toEqual([]);
      expect(await ctx.discover('chat', [other], new Set())).toEqual([]);
      expect(list).toHaveBeenCalledTimes(2);
      expect(await topics.get('chat', 'omt_b')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shares a lookup still running with a turn that reaches the same topic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'topics-'));
    try {
      const topics = createTopicRegistry({ dir, sessions: async () => [] });
      const items = [{ message_id: 'om_p', create_time: '7000', sender: { id: 'cli_p', id_type: 'app_id', sender_type: 'app', sender_name: '小P', open_bot_id: 'ou_p' } }];
      let answer!: () => void;
      const held = new Promise<void>((r) => { answer = r; });
      const list = vi.fn(async () => { await held; return { code: 0, data: { items } }; });
      const ctx = ctxOn({ message: { list } }, topics);
      const root: ContextMessage = { messageId: 'om_root', senderName: '张三', senderId: 'ou_z', text: '订单', from: 'user', createTime: 5000, threadId: 'omt_a' };
      const first = ctx.discover('chat', [root], new Set());
      const second = ctx.discover('chat', [root], new Set());
      answer();
      const ids = (await Promise.all([first, second])).map((f) => f.map((t) => t.topicId));
      expect(ids).toEqual([['omt_a'], ['omt_a']]);
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('looks up at most 5 topics a turn, the newest', async () => {
    const list = vi.fn(async () => ({ code: 0, data: { items: [] } }));
    const ctx = ctxOn({ message: { list } }, createTopicRegistry({ dir: '/nonexistent', sessions: async () => [] }));
    const roots = Array.from({ length: 7 }, (_, i): ContextMessage =>
      ({ messageId: `om_${i}`, senderName: '张三', text: 'x', from: 'user', createTime: i, threadId: `omt_${i}` }));
    await ctx.discover('chat', roots, new Set());
    expect(list.mock.calls.map((c) => (c as unknown as [{ params: { container_id: string } }])[0].params.container_id))
      .toEqual(['omt_2', 'omt_3', 'omt_4', 'omt_5', 'omt_6']);
    // The next turn looks up the 2 left; the 5 already looked up take no slot.
    await ctx.discover('chat', roots, new Set());
    expect(list).toHaveBeenCalledTimes(7);
  });
});
