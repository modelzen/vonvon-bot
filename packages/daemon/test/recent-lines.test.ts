import { describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { RECENT_CONTEXT, RecentLines, lineOfMessage, quotedLine, type RecentLine, type RecentPull } from '../src/bot/recent-lines';
import type { ContextMessage, ThreadPull } from '../src/bot/context-weave';

const line = (id: string, at: number, text = id): RecentLine => ({ id, at, from: 'user', name: '张三', text });
const pulled = (id: string, at: number): ContextMessage => ({ messageId: id, createTime: at, from: 'bot', senderName: '小P', text: `${id} 说` });
const pull = (messages: ContextMessage[], ok = true): ThreadPull => ({ messages, ok, complete: true });

function message(fields: Partial<NormalizedMessage> & { raw?: unknown } = {}): NormalizedMessage {
  return {
    messageId: 'om_1', chatId: 'oc_g', chatType: 'group', content: '你好', senderId: 'ou_a', mentionedBot: false, mentionAll: false,
    mentions: [], createTime: 1_000, rawContentType: 'text', resources: [], raw: { sender: { sender_type: 'user' } }, ...fields,
  } as NormalizedMessage;
}

describe('RecentLines', () => {
  it('keeps lines by time, each once, the newest 40 a place', () => {
    const r = new RecentLines(3);
    r.add('g', line('b', 2), line('a', 1));
    r.add('g', line('a', 1, 'again'), line('c', 3));
    expect(r.context('g', { id: 'x', at: 10 }).map((l) => l.text)).toEqual(['a', 'b', 'c']);
    r.add('g', line('d', 4));
    expect(r.context('g', { id: 'x', at: 10 }).map((l) => l.text)).toEqual(['b', 'c', 'd']);
    expect(r.get('a')).toBeUndefined(); // gone with its line
  });

  it("gives a judgement the place's last lines before its message, not the message itself", () => {
    const r = new RecentLines();
    for (let i = 0; i < 30; i++) r.add('g', line(`m${i}`, i));
    const context = r.context('g', { id: 'm25', at: 25 });
    expect(context).toHaveLength(RECENT_CONTEXT);
    expect(context.at(-1)!.text).toBe('m24');
    // Ids are what an anchor names (s25b), and `named` keeps a line out of the anchors; the sender's open_id is not
    // a judge line's.
    r.add('g', { ...line('om_x', 24.5), senderId: 'ou_secret', named: true });
    expect(r.context('g', { id: 'm25', at: 25 }).at(-1)).toEqual({ id: 'om_x', at: 24.5, from: 'user', name: '张三', text: 'om_x', named: true });
  });

  it('drops the place used longest ago past the cap', () => {
    const r = new RecentLines(40, 2);
    r.add('a', line('1', 1));
    r.add('b', line('2', 2));
    r.add('a', line('3', 3)); // a used last
    r.add('c', line('4', 4));
    expect(r.get('2')).toBeUndefined();
    expect(r.get('1')).toBeDefined();
  });

  it("adds this bot's own line only where its group is tracked, and a recall takes a line out", () => {
    const r = new RecentLines();
    r.addOwn('omt_t', 'oc_g', { id: 'card', at: 5, text: '答案' });
    expect(r.get('card')).toBeUndefined();
    r.add('oc_g', line('m', 1));
    r.addOwn('omt_t', 'oc_g', { id: 'card', at: 5, text: '答案' }); // a topic it just opened
    expect(r.get('card')).toMatchObject({ from: 'self', name: '你', text: '答案' });
    r.remove('m');
    expect(r.context('oc_g', { id: 'x', at: 10 })).toEqual([]);
  });

  it('pulls a cold place once, whatever came of it', async () => {
    const r = new RecentLines();
    const failed = vi.fn<RecentPull>(async () => undefined);
    await r.fill('g', 100, failed, false);
    await r.fill('g', 100, failed, false);
    expect(failed).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledWith({ enough: RECENT_CONTEXT });
    const warm = new RecentLines();
    for (let i = 0; i < 5; i++) warm.add('g', line(`m${i}`, i));
    const none = vi.fn<RecentPull>();
    await warm.fill('g', 100, none, false);
    expect(none).not.toHaveBeenCalled();
  });

  it("a judgement coming while its cold place pulls waits for that pull, and does not pull again", async () => {
    const r = new RecentLines();
    let release!: (got: ThreadPull) => void;
    const slow = vi.fn<RecentPull>(() => new Promise((resolve) => { release = resolve; }));
    const first = r.fill('g', 100, slow, false);
    const second = r.fill('g', 100, slow, false).then(() => r.context('g', { id: 'x', at: 100 }).length);
    await new Promise((resolve) => setImmediate(resolve));
    release(pull([pulled('o1', 50)]));
    await first;
    expect(await second).toBe(1);
    expect(slow).toHaveBeenCalledOnce();
  });

  it("with other bots, pulls what came since the last pull: they never reach this bot as events (M2)", async () => {
    const r = new RecentLines();
    const got = vi.fn<RecentPull>(async () => pull([pulled('o1', 50)]));
    await r.fill('g', 100, got, true);
    expect(got).toHaveBeenLastCalledWith({ enough: RECENT_CONTEXT });
    expect(r.get('o1')).toMatchObject({ from: 'bot', name: '小P' });
    got.mockImplementationOnce(async () => pull([pulled('o2', 150)]));
    await r.fill('g', 200, got, true);
    expect(got).toHaveBeenLastCalledWith({ stopAt: 100 });
    expect(r.context('g', { id: 'x', at: 300 }).map((l) => l.text)).toEqual(['o1 说', 'o2 说']);
    // A failed pull leaves where the last one read to.
    got.mockImplementationOnce(async () => pull([], false));
    await r.fill('g', 300, got, true);
    await r.fill('g', 400, got, true);
    expect(got).toHaveBeenLastCalledWith({ stopAt: 200 });
  });
});

describe('lineOfMessage', () => {
  it('writes the text as a record block does, names mentions, and cuts long text', () => {
    const msg = message({
      content: 'x',
      mentions: [{ key: '@_user_1', openId: 'ou_me', name: '小码', isBot: true }, { key: '@_user_2', openId: 'ou_b', name: '李四', isBot: false }],
      raw: { sender: { sender_type: 'user' }, message: { message_type: 'text', content: JSON.stringify({ text: '@_user_1 @_user_2 看下' }) } },
    });
    expect(lineOfMessage(msg, '张三')).toEqual({ id: 'om_1', at: 1_000, from: 'user', name: '张三', text: '@李四 看下', mentions: ['小码', '李四'], senderId: 'ou_a', named: true });
    // @所有人 is not among the mentions, but names everyone (s25b).
    expect(lineOfMessage(message({ mentionAll: true }), '张三').named).toBe(true);
    expect(lineOfMessage(message(), '张三')).not.toHaveProperty('named');
    const long = message({ content: 'a'.repeat(900) });
    expect([...lineOfMessage(long, '张三').text]).toHaveLength(401);
    expect([...lineOfMessage(long, '张三', undefined, 800).text]).toHaveLength(801);
  });

  it('carries the quoted line when it is in the ring, this bot as 你', () => {
    const r = new RecentLines();
    r.add('oc_g', line('om_q', 1));
    r.add('oc_g', { ...line('om_me', 2, '我的答案'), from: 'self', name: '你' });
    expect(lineOfMessage(message({ replyToMessageId: 'om_q' }), '李四', quotedLine(r, message({ replyToMessageId: 'om_q' }))).quote).toEqual({ name: '张三', text: 'om_q' });
    expect(lineOfMessage(message({ replyToMessageId: 'om_me' }), '李四', quotedLine(r, message({ replyToMessageId: 'om_me' }))).quote).toEqual({ name: '你', text: '我的答案' });
    expect(quotedLine(r, message({ replyToMessageId: 'om_gone' }))).toBeUndefined();
  });
});

it('exposes all-mentions as facts and reads rings without touching LRU', () => {
  expect(lineOfMessage(message({ mentionAll: true }), '人')).toMatchObject({ named: true, mentions: ['所有人'] });
  const r = new RecentLines(40, 2);
  expect(r.lines('missing')).toEqual([]);
  r.add('a', line('2', 2), line('1', 1));
  r.add('b', line('3', 3));
  expect(r.lines('a').map(l => l.id)).toEqual(['1', '2']);
  r.add('c', line('4', 4));
  expect(r.lines('a')).toEqual([]);
});
