import { describe, expect, it, vi } from 'vitest';
import { guardCardJson, installAtGuard, keepAts, neutraliseAts, type ChatBots } from '../src/card/at-guard';
import { sendManagedCard, updateManagedCard } from '../src/card/managed';

// s27a0, all new on main: a bot's `<at>` never leaves in a card or markdown post.
const BOTS = new Map([['ou_b', { name: '小审' }], ['ou_nameless', {}]]);

/** A chat list that is known (`ids`) or not yet; `load` resolves to `later` when given. */
function chatBots(ids?: Map<string, { name?: string }>, later?: Map<string, { name?: string }>): ChatBots & { load: ReturnType<typeof vi.fn> } {
  let now = ids;
  return { peek: () => now, load: vi.fn(async () => { await Promise.resolve(); if (later) now = later; }) };
}

describe('neutraliseAts', () => {
  it.each([
    ['<at id="ou_b">小审</at> 请看', '@小审 请看'],
    ["<at user_id='ou_b'>小审</at>", '@小审'],
    ['<at open_id=ou_b>小审</at>', '@小审'],
    ['<AT ID = "ou_b">小审</AT>', '@小审'],
    ['<at id="ou_b"></at>', '@小审'], // the list's name when the tag has none
    ['<at id=ou_nameless></at>', '@另一个 bot'],
    ['写完 <at id="ou_b">小', '写完 @小'], // a frame cut mid-name: unclosed
    ['写完 <at id="ou_b', '写完 @'], // cut inside the tag
    ['```\n<at id="ou_b">小审</at>\n```', '```\n@小审\n```'], // in code too
    ['`<at id=ou_b>小审</at>`', '`@小审`'],
    ['<at id=all></at>', '@所有人'],
  ])('a bot, `all` or a cut tag: %s', (text, out) => {
    expect(neutraliseAts(text, BOTS)).toBe(out);
  });

  it('keeps a person once the list is known, and the program\'s own ids before it is', () => {
    const person = '<at id="ou_h">张三</at> 和 <at email="z@x.cn"></at>';
    expect(neutraliseAts(person, BOTS)).toBe(person);
    expect(neutraliseAts(person, undefined)).toBe('@张三 和 @某人');
    expect(neutraliseAts('<at id="ou_h">张三</at><at id="ou_b">小审</at>', undefined, new Set(['ou_h']))).toBe('<at id="ou_h">张三</at>@小审');
    expect(neutraliseAts('<at id="ou_b">小审</at>', BOTS, new Set(['ou_b']))).toBe('@小审'); // a bot never stays
    expect(neutraliseAts('说 <at 这种写法\n下一行 >', undefined)).toBe('说 <at 这种写法\n下一行 >'); // a tag never spans lines
  });
});

describe('guardCardJson', () => {
  const client = {};
  it('settles every string of the card, whatever the field', async () => {
    installAtGuard({ rawClient: client } as never, chatBots(BOTS));
    const card = { header: { title: { content: '<at id=ou_b>小审</at>' } }, body: { elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '<at id="ou_b">小审</at>' } },
      { tag: 'table', rows: [{ c: '<at user_id=ou_b>小审</at>' }] },
      { tag: 'markdown', content: '<at id="ou_h">张三</at>' },
    ] } };
    const out = await guardCardJson(client, JSON.stringify(card), 'oc_1');
    expect(out).not.toContain('ou_b');
    expect(out.match(/@小审/g)).toHaveLength(3);
    expect(JSON.parse(out).body.elements[2].content).toBe('<at id="ou_h">张三</at>');
  });

  it('waits for an unknown list, except for a streamed frame, which only starts the read', async () => {
    const c1 = {}; const list = chatBots(undefined, BOTS);
    installAtGuard({ rawClient: c1 } as never, list);
    const raw = JSON.stringify({ c: '<at id="ou_h">张三</at><at id="ou_b">小审</at>' });
    expect(await guardCardJson(c1, raw, 'oc_1', undefined, false)).toBe(JSON.stringify({ c: '@张三@小审' }));
    expect(list.load).toHaveBeenCalledWith('oc_1');
    const c2 = {};
    installAtGuard({ rawClient: c2 } as never, chatBots(undefined, BOTS));
    expect(await guardCardJson(c2, raw, 'oc_1')).toBe(JSON.stringify({ c: '<at id="ou_h">张三</at>@小审' }));
  });

  it('a failed read leaves only the program\'s own @ real; no list or chat is the same', async () => {
    const c = {};
    installAtGuard({ rawClient: c } as never, chatBots());
    const card = keepAts({ a: '可回答：<at id="ou_owner">主人</at>', q: '问 <at id="ou_h">张三</at>' }, ['ou_owner']);
    const keep = new Set(['ou_owner']);
    for (const [client, chat] of [[c, 'oc_1'], [{}, 'oc_1'], [c, undefined]] as const) {
      expect(JSON.parse(await guardCardJson(client, JSON.stringify(card), chat, keep))).toEqual({ a: card.a, q: '问 @张三' });
    }
  });
});

describe('channel.send', () => {
  it('settles markdown and passes everything else through unchanged', async () => {
    const send = vi.fn(async (..._args: unknown[]) => ({ messageId: 'om_1' }));
    const channel = { rawClient: {}, send };
    installAtGuard(channel as never, chatBots(BOTS));
    installAtGuard(channel as never, chatBots(BOTS)); // wrapped once
    await channel.send('oc_1', { markdown: '目标：<at id="ou_b">小审</at>' }, { replyTo: 'om_0' });
    await channel.send('oc_1', { markdown: '没有 at' });
    await channel.send('oc_1', { text: '<at user_id="ou_b">小审</at>' } as never); // a text @ is listed: s27b uses it
    expect(send.mock.calls).toEqual([
      ['oc_1', { markdown: '目标：@小审' }, { replyTo: 'om_0' }],
      ['oc_1', { markdown: '没有 at' }],
      ['oc_1', { text: '<at user_id="ou_b">小审</at>' }],
    ]);
  });
});

describe('managed cards', () => {
  it('go through the guard and remember their chat, so an update keeps a person real', async () => {
    const create = vi.fn(async (_r: unknown) => ({ data: { card_id: 'c1' } }));
    const update = vi.fn(async (_r: unknown) => ({}));
    const message = { create: vi.fn(async () => ({ data: { message_id: 'om_1' } })) };
    const channel = { rawClient: { cardkit: { v1: { card: { create, update } } }, im: { v1: { message } } } };
    installAtGuard(channel as never, chatBots(BOTS));
    const at = (content: string) => ({ body: { elements: [{ tag: 'markdown', content }] } });
    await sendManagedCard(channel as never, 'oc_1', at('<at id="ou_b">小审</at><at id="ou_h">张三</at>'));
    expect(await updateManagedCard(channel as never, 'om_1', at('<at id="ou_h">张三</at><at id="ou_b">小审</at>'))).toBe(true);
    const content = (r: any): string => JSON.parse(r.data.data ?? r.data.card.data).body.elements[0].content;
    expect(content(create.mock.calls[0]![0])).toBe('@小审<at id="ou_h">张三</at>');
    expect(content(update.mock.calls[0]![0])).toBe('<at id="ou_h">张三</at>@小审');
  });
});
